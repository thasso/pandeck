/**
 * The Slack user operations behind "Sign in with Slack" (Task-1453): the
 * status maps every vault get outcome and decodes the access view only
 * through the edge's tools; a connect maps every vault outcome to a fixed
 * code; Slack's writer slot is the user's own per integration, so a running
 * Slack connect refuses a second Slack write but not an Atlassian clear.
 * Over a stub vault and stub tools; every value is fake.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { EdgeTools } from "./edgeTools.ts";
import {
  createUserOperations,
  UserOperationRefusal,
  type UserOperations,
} from "./userOperations.ts";
import type {
  IntegrationConnect,
  IntegrationRecord,
  IntegrationWrite,
  VaultPort,
} from "./vaultPort.ts";

const CONNECT = {
  code: "FAKE-T1453-CODE",
  redirectUri: "https://gateway.test/auth/slack/callback",
};
const VIEW = JSON.stringify({ kind: "slack-oauth", fake: true });

/** A vault answering as told; a connect can be held until released. */
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
      teamId: "TFAKE0001",
    } as IntegrationConnect<"slack">,
    clearAnswer: { ok: true } as IntegrationWrite,
    held: false,
  };
  const vault: UserOpsVault = {
    login: () => undefined,
    newTokenFile: () => "",
    discardCredential: () => {},
    integrationPut: () => Promise.resolve({ ok: true }),
    integrationGet: (userId, integration) => {
      calls.push(`get ${integration} ${userId}`);
      return Promise.resolve(stub.getAnswer);
    },
    integrationClear: (userId, integration) => {
      calls.push(`clear ${integration} ${userId}`);
      return Promise.resolve(stub.clearAnswer);
    },
    integrationConnect: async (userId, integration, request) => {
      calls.push(`connect ${integration} ${userId}`);
      requests.push(request);
      if (stub.held)
        await new Promise<void>((resolve) => releases.push(resolve));
      return stub.connectAnswer as never;
    },
  };
  return { stub, vault };
}

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

/** Tools whose Slack `describe` answers as told and records what it got. */
function stubTools(
  describe: (credential: string) => { teamName?: string } | undefined,
) {
  const described: string[] = [];
  const tools: EdgeTools["integrations"] = {
    atlassian: {
      parse: () => ({ ok: false }),
      check: () => Promise.resolve({ ok: true }),
      describe: () => undefined,
    },
    slack: {
      describe: (credential) => {
        described.push(credential);
        return describe(credential);
      },
    },
  };
  return { tools, described };
}

const open: UserOperations[] = [];

function operations(
  vault: UserOpsVault,
  tools: EdgeTools["integrations"] | undefined,
): UserOperations {
  const ops = createUserOperations({
    vault,
    atlassianSignIn: false,
    integrations: () => tools,
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
    log: (line) => assert.fail(`no gateway log line expected: ${line}`),
  });
  open.push(ops);
  return ops;
}

const refused =
  (code: string) =>
  (err: unknown): boolean =>
    err instanceof UserOperationRefusal && err.code === code;

afterEach(() => {
  while (open.length) open.pop()!.close();
});

test("slackStatus maps every get outcome; only an ok record reaches the tools' describe", async () => {
  const { stub, vault } = stubVault();
  const { tools, described } = stubTools(() => ({
    teamName: "Fake Workspace",
  }));
  const ops = operations(vault, tools);
  const cases: [IntegrationRecord, unknown][] = [
    [{ ok: false, absent: true }, { connected: false }],
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
      { ok: true, credential: VIEW },
      { connected: true, teamName: "Fake Workspace" },
    ],
  ];
  for (const [answer, status] of cases) {
    stub.getAnswer = answer;
    assert.deepEqual(
      await ops.slackStatus("u1"),
      status,
      JSON.stringify(answer),
    );
  }
  assert.deepEqual(described, [VIEW]);
  assert.ok(stub.calls.every((call) => call === "get slack u1"));
});

test("slackStatus: a view the tools cannot decode is invalid, one without a name is connected without one", async () => {
  const { stub, vault } = stubVault();
  stub.getAnswer = { ok: true, credential: VIEW };
  assert.deepEqual(
    await operations(vault, stubTools(() => undefined).tools).slackStatus("u1"),
    {
      connected: false,
      problem: "invalid",
    },
  );
  assert.deepEqual(
    await operations(vault, stubTools(() => ({})).tools).slackStatus("u1"),
    {
      connected: true,
    },
  );
});

test("connectSlack hands code, redirect URI and team to the vault only and maps every outcome to its fixed code", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault, stubTools(() => undefined).tools);
  stub.connectAnswer = {
    ok: true,
    teamId: "TFAKE0001",
    teamName: "Fake Workspace",
  };
  assert.deepEqual(
    await ops.connectSlack("u1", { ...CONNECT, team: "TFAKE0001" }),
    {
      connected: true,
      teamName: "Fake Workspace",
    },
  );
  await ops.connectSlack("u1", CONNECT);
  assert.deepEqual(stub.requests, [{ ...CONNECT, team: "TFAKE0001" }, CONNECT]);
  assert.deepEqual(stub.calls, ["connect slack u1", "connect slack u1"]);

  const cases: [IntegrationConnect<"slack">, string][] = [
    [{ ok: false, rejected: true }, "integration_rejected"],
    [{ ok: false, unreachable: true }, "integration_unreachable"],
    [{ ok: false, team: "mismatch" }, "integration_team_mismatch"],
    [{ ok: false, notConfigured: true }, "integration_not_configured"],
    [{ ok: false, locked: true }, "vault_locked"],
    [{ ok: false, unavailable: true }, "vault_unavailable"],
  ];
  for (const [answer, code] of cases) {
    stub.connectAnswer = answer;
    await assert.rejects(ops.connectSlack("u1", CONNECT), refused(code), code);
  }
});

test("clearSlack clears the Slack record only; a vault refusal is its fixed code", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault, stubTools(() => undefined).tools);
  await ops.clearSlack("u1");
  assert.deepEqual(stub.calls, ["clear slack u1"]);
  stub.clearAnswer = { ok: false, locked: true };
  await assert.rejects(ops.clearSlack("u1"), refused("vault_locked"));
  stub.clearAnswer = { ok: false, unavailable: true };
  await assert.rejects(ops.clearSlack("u1"), refused("vault_unavailable"));
});

test("a running Slack connect makes the user's Slack connect and clear busy, not an Atlassian clear or another user's", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault, stubTools(() => undefined).tools);
  stub.held = true;
  const connecting = ops.connectSlack("u1", CONNECT);
  await vi.waitFor(() => assert.equal(stub.releases.length, 1));
  await assert.rejects(
    ops.connectSlack("u1", CONNECT),
    refused("integration_busy"),
  );
  await assert.rejects(ops.clearSlack("u1"), refused("integration_busy"));
  stub.held = false;
  await ops.clearAtlassian("u1");
  await ops.clearSlack("u2");
  // Reads are never refused.
  assert.deepEqual(await ops.slackStatus("u1"), { connected: false });
  stub.releases[0]!();
  assert.deepEqual(await connecting, { connected: true });
  assert.deepEqual(stub.calls, [
    "connect slack u1",
    "clear atlassian u1",
    "clear slack u2",
    "get slack u1",
  ]);
  // Free again once it settled.
  await ops.clearSlack("u1");
});

test("without tools every Slack operation refuses tools_unavailable before the vault", async () => {
  const { stub, vault } = stubVault();
  const ops = operations(vault, undefined);
  for (const run of [
    () => ops.slackStatus("u1"),
    () => ops.connectSlack("u1", CONNECT),
    () => ops.clearSlack("u1"),
  ])
    await assert.rejects(run(), refused("tools_unavailable"));
  assert.deepEqual(stub.calls, []);
});
