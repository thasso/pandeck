/**
 * The GitHub user operations behind "Connect GitHub" and the page's
 * repository check (Task-1445): the status maps every vault get outcome and
 * keeps only a GitHub login from the access view; a connect maps every vault
 * outcome to a fixed code, one at a time with clear; the check maps all seven
 * `githubToken` outcomes, answers a freshly built `{expiresAt}` only, runs one
 * at a time per user and is never refused busy by, nor refuses, the user's
 * GitHub clear. Over a stub vault; every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  createGithubCheck,
  createUserOperations,
  UserOperationRefusal,
  type UserOperations,
} from "./userOperations.ts";
import type {
  ConnectFailure,
  GithubToken,
  IntegrationConnect,
  IntegrationRecord,
  IntegrationWrite,
  VaultPort,
} from "./vaultPort.ts";

const CONNECT = {
  code: "FAKE-T1445-CODE",
  redirectUri: "https://gateway.test/auth/github/callback",
};
const INSTALL_SENTINEL = "fake-t1445-install-sentinel";
const VIEW_SENTINEL = "fake-t1445-view-sentinel";
const EXPIRES_AT = 1_900_000_000_000;
const REPO = { owner: "fake-owner", repo: "fake-repo" };

const view = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    kind: "github-oauth",
    login: "fake-user",
    accessToken: VIEW_SENTINEL,
    expiresAt: EXPIRES_AT,
    ...fields,
  });

type UserOpsVault = Pick<
  VaultPort,
  | "login"
  | "newTokenFile"
  | "discardCredential"
  | "integrationPut"
  | "integrationGet"
  | "integrationClear"
  | "integrationConnect"
>;

/** A vault answering as told; a connect or a token can be held. */
function stubVault() {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const releases: (() => void)[] = [];
  const stub = {
    calls,
    requests,
    releases,
    getAnswer: { ok: false, absent: true } as IntegrationRecord,
    connectAnswer: {
      ok: true,
      login: "fake-user",
    } as IntegrationConnect<"github">,
    clearAnswer: { ok: true } as IntegrationWrite,
    tokenAnswer: {
      ok: true,
      token: INSTALL_SENTINEL,
      expiresAt: EXPIRES_AT,
    } as GithubToken,
    held: false,
  };
  const hold = async () => {
    if (stub.held) await new Promise<void>((resolve) => releases.push(resolve));
  };
  const vault: UserOpsVault & Pick<VaultPort, "githubToken"> = {
    login: () => undefined,
    newTokenFile: () => "",
    discardCredential: () => {},
    integrationPut: () => Promise.resolve({ ok: true }),
    integrationGet: (userId, integration, options) => {
      calls.push(`get ${integration} ${userId}`);
      requests.push(options);
      return Promise.resolve(stub.getAnswer);
    },
    integrationClear: (userId, integration) => {
      calls.push(`clear ${integration} ${userId}`);
      return Promise.resolve(stub.clearAnswer);
    },
    integrationConnect: async (userId, integration, request) => {
      calls.push(`connect ${integration} ${userId}`);
      requests.push(request);
      await hold();
      return stub.connectAnswer as never;
    },
    githubToken: async (userId, request) => {
      calls.push(`token ${userId}`);
      requests.push(request);
      await hold();
      return stub.tokenAnswer;
    },
  };
  return { stub, vault };
}

const open: UserOperations[] = [];
const lines: string[] = [];

function operations(vault: UserOpsVault): UserOperations {
  const ops = createUserOperations({
    vault,
    atlassianSignIn: false,
    // GitHub's operations need no edge tools.
    integrations: () => undefined,
    checkSignal: () => new AbortController().signal,
    registry: {
      clients: () => [],
      createCode: () => "",
      revoke: () => {},
      setMcpToken: () => {},
      clearMcpToken: () => {},
      enrollmentRequest: () => undefined,
      decide: () => undefined,
    } as never,
    clientRevoked: () => {},
    profiles: { get: () => undefined },
    ownerOf: () => undefined,
    accountsOf: () => [],
    needsLogin: () => [],
    putAccount: () => {},
    removeAccount: () => {},
    send: () => {},
    log: (line) => lines.push(line),
  });
  open.push(ops);
  return ops;
}

const refused =
  (code: string) =>
  (err: unknown): boolean =>
    err instanceof UserOperationRefusal && err.code === code;

/** Lets held calls reach the stub. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  while (open.length) open.pop()!.close();
  // No operation here logs, and none could log a token.
  assert.deepEqual(lines, []);
  lines.length = 0;
});

test("githubStatus maps every get outcome and keeps only the login", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault);

  assert.deepEqual(await ops.githubStatus("u1"), { connected: false });
  assert.deepEqual(stub.calls, ["get github u1"]);
  // A plain get: no check, no other option.
  assert.deepEqual(stub.requests, [{}]);

  const cases: [IntegrationRecord, unknown][] = [
    [
      { ok: false, rejected: true },
      { connected: false, problem: "rejected" },
    ],
    [
      { ok: false, locked: true },
      { connected: false, problem: "vault_locked" },
    ],
    [
      { ok: false, unavailable: true },
      { connected: false, problem: "vault_unavailable" },
    ],
    [
      { ok: true, credential: view({ kind: "slack-oauth" }) },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: "not json" },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: JSON.stringify([view({})]) },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: "null" },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: view({ login: "a".repeat(40) }) },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: view({ login: "fake\u0007user" }) },
      { connected: false, problem: "invalid" },
    ],
    [
      { ok: true, credential: view({ login: 7 }) },
      { connected: false, problem: "invalid" },
    ],
  ];
  for (const [answer, expected] of cases) {
    stub.getAnswer = answer;
    assert.deepEqual(
      await ops.githubStatus("u1"),
      expected,
      JSON.stringify(answer),
    );
  }

  stub.getAnswer = { ok: true, credential: view({}) };
  const status = await ops.githubStatus("u1");
  assert.deepEqual(status, { connected: true, login: "fake-user" });
  assert.deepEqual(Object.keys(status).sort(), ["connected", "login"]);
  assert.ok(!JSON.stringify(status).includes(VIEW_SENTINEL));
});

test("connectGithub hands the code to the vault and maps every failure to a fixed code", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault);

  assert.deepEqual(await ops.connectGithub("u1", CONNECT), {
    connected: true,
    login: "fake-user",
  });
  assert.deepEqual(stub.calls, ["connect github u1"]);
  // Exactly the code and the redirect URI; nothing else reaches the vault.
  assert.deepEqual(stub.requests, [CONNECT]);

  const failures: [ConnectFailure, string][] = [
    [{ ok: false, rejected: true }, "integration_rejected"],
    [{ ok: false, unreachable: true }, "integration_unreachable"],
    [{ ok: false, notConfigured: true }, "integration_not_configured"],
    [{ ok: false, locked: true }, "vault_locked"],
    [{ ok: false, unavailable: true }, "vault_unavailable"],
  ];
  for (const [answer, code] of failures) {
    stub.connectAnswer = answer;
    await assert.rejects(ops.connectGithub("u1", CONNECT), refused(code));
  }
});

test("clearGithub deletes the record and maps a failed write", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault);
  await ops.clearGithub("u1");
  assert.deepEqual(stub.calls, ["clear github u1"]);
  stub.clearAnswer = { ok: false, locked: true };
  await assert.rejects(ops.clearGithub("u1"), refused("vault_locked"));
  stub.clearAnswer = { ok: false, unavailable: true };
  await assert.rejects(ops.clearGithub("u1"), refused("vault_unavailable"));
});

test("a second GitHub connect or clear during a connect is refused busy; another user and Slack are not", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault);
  stub.held = true;
  const first = ops.connectGithub("u1", CONNECT);
  await settle();
  await assert.rejects(
    ops.connectGithub("u1", CONNECT),
    refused("integration_busy"),
  );
  await assert.rejects(ops.clearGithub("u1"), refused("integration_busy"));
  stub.held = false;
  // Another user's slot, and the user's Slack record, are their own.
  await ops.clearGithub("u2");
  await assert.rejects(ops.clearSlack("u1"), refused("tools_unavailable"));
  stub.releases.shift()!();
  await first;
  await ops.clearGithub("u1");
  assert.deepEqual(stub.calls, [
    "connect github u1",
    "clear github u2",
    "clear github u1",
  ]);
});

test("checkGithub maps all seven githubToken outcomes; ok answers only a fresh expiresAt", async () => {
  const { stub, vault } = stubVault();
  const check = createGithubCheck({ vault });

  const answer = await check.checkGithub("u1", REPO);
  assert.deepEqual(Object.keys(answer), ["expiresAt"]);
  assert.equal(answer.expiresAt, EXPIRES_AT);
  assert.ok(!JSON.stringify(answer).includes(INSTALL_SENTINEL));
  // The answer is not the vault's object with members taken away.
  assert.notEqual(answer, stub.tokenAnswer);
  assert.deepEqual(stub.calls, ["token u1"]);
  // Exactly owner and repo reach the vault.
  assert.deepEqual(stub.requests, [REPO]);

  const outcomes: [GithubToken, string][] = [
    [{ ok: false, absent: true }, "integration_sign_in_required"],
    [{ ok: false, denied: true }, "integration_denied"],
    [{ ok: false, rejected: true }, "integration_rejected"],
    [{ ok: false, invalid: true }, "integration_invalid"],
    [{ ok: false, locked: true }, "vault_locked"],
    [{ ok: false, unavailable: true }, "vault_unavailable"],
  ];
  for (const [outcome, code] of outcomes) {
    stub.tokenAnswer = outcome;
    await assert.rejects(check.checkGithub("u1", REPO), (err: unknown) => {
      assert.ok(refused(code)(err), `${JSON.stringify(outcome)} → ${code}`);
      assert.ok(!String((err as Error).message).includes(INSTALL_SENTINEL));
      return true;
    });
  }
});

test("a second check while one is held is busy; a clear and a connect during it are not, nor does it refuse them", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault);
  const check = createGithubCheck({ vault });
  stub.held = true;
  const first = check.checkGithub("u1", REPO);
  await settle();
  await assert.rejects(
    check.checkGithub("u1", REPO),
    refused("integration_busy"),
  );
  stub.held = false;
  // Another user's check runs.
  await check.checkGithub("u2", REPO);
  // The disconnect reaches the vault while the check is held.
  await ops.clearGithub("u1");
  await ops.connectGithub("u1", CONNECT);
  stub.releases.shift()!();
  assert.deepEqual(await first, { expiresAt: EXPIRES_AT });
  // The slot is free again after the held check ends.
  await check.checkGithub("u1", REPO);
  assert.deepEqual(stub.calls, [
    "token u1",
    "token u2",
    "clear github u1",
    "connect github u1",
    "token u1",
  ]);
});

test("a check whose vault call throws frees its slot", async () => {
  const { vault } = stubVault();
  let calls = 0;
  const check = createGithubCheck({
    vault: {
      githubToken: (...args) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error(INSTALL_SENTINEL));
        return vault.githubToken(...args);
      },
    },
  });
  await assert.rejects(check.checkGithub("u1", REPO));
  assert.deepEqual(await check.checkGithub("u1", REPO), {
    expiresAt: EXPIRES_AT,
  });
});
