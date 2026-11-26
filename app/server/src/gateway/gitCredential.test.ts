/**
 * The edge's `git.credential` (Task-1446 plan v03 §3, V2) over a recording
 * stub vault: request validation before any vault call, the outcome table,
 * a fresh answer object, and the per-client in-flight gate. Every value is
 * fake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import { GIT_CREDENTIAL_FAILURES } from "./clientMethods.ts";
import { createGitCredentialGate, gitCredentialFor } from "./gitCredential.ts";
import type { GithubToken, GithubTokenRequest } from "./vaultPort.ts";

function recordingVault(answer: () => Promise<GithubToken>) {
  const calls: { userId: string; request: GithubTokenRequest }[] = [];
  /** Each call's options, kept apart so `calls` compares by value. */
  const options: unknown[] = [];
  return {
    calls,
    options,
    port: {
      githubToken: (
        userId: string,
        request: GithubTokenRequest,
        ...rest: unknown[]
      ) => {
        calls.push({ userId, request });
        options.push(rest[0]);
        return answer();
      },
    },
  };
}

const OK: GithubToken = {
  ok: true,
  token: "fake-install-token",
  expiresAt: 4_102_444_800_000,
};
const REQUEST = {
  host: "github.com",
  path: "fake-owner/fake-repo",
  access: "read",
};

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    assert.ok(err instanceof WorkerMethodError, String(err));
    return err.code;
  }
  throw new Error("no refusal");
}

test("owner/repo and owner/repo.git ask the vault once for the given user; the host is case-insensitive", async () => {
  const vault = recordingVault(() => Promise.resolve(OK));
  for (const [host, path] of [
    ["github.com", "fake-owner/fake-repo"],
    ["github.com", "fake-owner/fake-repo.git"],
    ["GitHub.com", "fake-owner/fake-repo"],
  ])
    await gitCredentialFor(vault.port, "u1", {
      ...REQUEST,
      host: host!,
      path: path!,
    });
  assert.deepEqual(
    vault.calls,
    Array.from({ length: 3 }, () => ({
      userId: "u1",
      request: { owner: "fake-owner", repo: "fake-repo" },
    })),
  );
  // The vault call gets no options, so no abort (F006): it runs until it
  // answers or the edge's vault timeout fires.
  assert.deepEqual(vault.options, [undefined, undefined, undefined]);
});

test("a bad host, path or access is invalid_params with no vault call", async () => {
  const vault = recordingVault(() => Promise.resolve(OK));
  const bad = [
    ...[
      "github.com.evil",
      "api.github.com",
      "github.com:443",
      "gitlab.com",
      "",
    ].map((host) => ({ ...REQUEST, host })),
    ...[
      "fake-owner",
      "/fake-owner/x",
      "fake-owner/x/",
      "fake-owner/x/info/refs",
      "fake-owner/..",
      "fake-owner/.git",
      "fake-owner/.git.git",
      "%2e%2e/x",
      `${"o".repeat(40)}/x`,
    ].map((path) => ({ ...REQUEST, path })),
    ...["write", "push", "READ", ""].map((access) => ({ ...REQUEST, access })),
  ];
  for (const request of bad)
    assert.equal(
      await codeOf(gitCredentialFor(vault.port, "u1", request)),
      "invalid_params",
      JSON.stringify(request),
    );
  assert.equal(vault.calls.length, 0);
});

test("each vault outcome answers its code and fixed text; ok is a fresh {token, expiresAt}", async () => {
  const table: [GithubToken, string][] = [
    [{ ok: false, absent: true }, "git_not_connected"],
    [{ ok: false, rejected: true }, "git_reconnect"],
    [{ ok: false, denied: true }, "git_denied"],
    [{ ok: false, invalid: true }, "invalid_params"],
    [{ ok: false, locked: true }, "vault_locked"],
    [{ ok: false, unavailable: true }, "vault_unavailable"],
  ];
  for (const [answer, code] of table) {
    const vault = recordingVault(() => Promise.resolve(answer));
    try {
      await gitCredentialFor(vault.port, "u1", REQUEST);
      assert.fail(code);
    } catch (err) {
      assert.ok(err instanceof WorkerMethodError);
      assert.equal(err.code, code);
      if (code !== "invalid_params")
        assert.equal(
          err.message,
          GIT_CREDENTIAL_FAILURES[code as keyof typeof GIT_CREDENTIAL_FAILURES],
        );
    }
  }
  const answer = { ...OK, extra: "x" } as GithubToken;
  const vault = recordingVault(() => Promise.resolve(answer));
  const payload = await gitCredentialFor(vault.port, "u1", REQUEST);
  assert.deepEqual(Object.keys(payload.json as object).sort(), [
    "expiresAt",
    "token",
  ]);
  assert.notEqual(payload.json, answer);
  assert.equal(payload.text, undefined);
  assert.equal(payload.bytes, undefined);
  const rejecting = recordingVault(() => Promise.reject(new Error("boom")));
  assert.equal(
    await codeOf(gitCredentialFor(rejecting.port, "u1", REQUEST)),
    "vault_unavailable",
  );
});

test("the gate: 8 calls in flight per client, the 9th busy before the vault; another client passes; slots and entries are released", async () => {
  const gate = createGitCredentialGate(8);
  const releases: (() => void)[] = [];
  const vault = recordingVault(
    () =>
      new Promise<GithubToken>((resolve) => releases.push(() => resolve(OK))),
  );
  const ask = (clientId: string) =>
    gate.run(clientId, () => gitCredentialFor(vault.port, "u1", REQUEST));
  const a = Array.from({ length: 8 }, () => ask("A"));
  await Promise.resolve();
  assert.equal(vault.calls.length, 8);
  assert.equal(await codeOf(ask("A")), "git_busy");
  assert.equal(vault.calls.length, 8, "no vault call for the busy one");
  const b = ask("B");
  assert.equal(vault.calls.length, 9, "another client still gets through");

  releases.shift()!();
  await a[0];
  const next = ask("A");
  assert.equal(vault.calls.length, 10, "a released slot lets one more through");

  // The gate comes first: with A full again, even a malformed call answers
  // git_busy. Its repository check runs only inside a slot, so it never
  // reaches the vault either way.
  assert.equal(
    await codeOf(
      gate.run("A", () =>
        gitCredentialFor(vault.port, "u1", { ...REQUEST, access: "write" }),
      ),
    ),
    "git_busy",
    "A is full again",
  );
  for (const release of releases.splice(0)) release();
  await Promise.all([...a, b, next]);
  assert.equal(gate.size, 0, "no entry left once every call finished");

  assert.equal(
    await codeOf(
      gate.run("C", () =>
        gitCredentialFor(vault.port, "u1", { ...REQUEST, access: "write" }),
      ),
    ),
    "invalid_params",
  );
  assert.equal(gate.size, 0, "a refused call leaves no entry");
});

test("the gate: work that fails releases its slot", async () => {
  const gate = createGitCredentialGate(1);
  const controller = new AbortController();
  const held = gate.run(
    "A",
    () =>
      new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      ),
  );
  assert.equal(
    await codeOf(gate.run("A", () => Promise.resolve(1))),
    "git_busy",
  );
  controller.abort();
  await held.catch(() => {});
  assert.equal(gate.size, 0);
  assert.equal(await gate.run("A", () => Promise.resolve(1)), 1);
});
