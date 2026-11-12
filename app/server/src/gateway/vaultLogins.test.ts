/**
 * The vault's side of a login (`vaultLogins.ts`, Task-1402 B2) over a fake
 * driver and fake writer lanes: a cancel abandons an ingest still waiting for
 * its lane turn, so a busy lane never keeps a withdrawn run from settling; an
 * ingest already in its turn finishes; and a discard waits for it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, test } from "vitest";
import { createVaultLogins } from "./vaultLogins.ts";
import type { LoginDrivers } from "./vaultPort.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A Claude driver that leaves a credential and finishes when told. */
function finishingDriver() {
  const finish: (() => void)[] = [];
  const driver: NonNullable<LoginDrivers["claude"]> = (dir) => {
    let resolve!: () => void;
    const done = new Promise<void>((res) => (resolve = res));
    finish.push(() => {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "fake-access",
            expiresAt: Date.now() + 3_600_000,
          },
        }),
      );
      resolve();
    });
    return { input() {}, cancel() {}, done };
  };
  return { driver, finish };
}

function setup(lane: Parameters<typeof createVaultLogins>[1]) {
  const stateDir = mkdtempSync(join(tmpdir(), "vault-logins-"));
  roots.push(stateDir);
  const { driver, finish } = finishingDriver();
  const logins = createVaultLogins(
    { stateDir, drivers: { claude: driver } },
    lane,
    () => {},
  );
  return { logins, finish, stateDir };
}

const events = { output() {}, url() {}, code() {} };

test("a cancel abandons an ingest stuck behind a busy writer lane", async () => {
  // A lane whose earlier item never ends.
  const { logins, finish } = setup({ run: () => new Promise(() => {}) });
  const tokenFile = logins.newTokenFile("claude", "claude-a");
  let commits = 0;
  const run = logins.login(
    {
      kind: "claude",
      accountId: "claude-a",
      tokenFile,
      commit: () => {
        commits++;
        return true;
      },
    },
    events,
  )!;
  finish[0]!();
  await delay(50);
  const began = Date.now();
  run.cancel();
  await assert.rejects(run.done, /cancelled/);
  assert.ok(Date.now() - began < 1_000);
  assert.equal(commits, 0);
  assert.equal(existsSync(tokenFile), false);
});

test("an ingest already in its lane turn finishes its granted commit despite a cancel", async () => {
  const { logins, finish } = setup({ run: (_id, work) => work() });
  const tokenFile = logins.newTokenFile("claude", "claude-a");
  let grant!: (ok: boolean) => void;
  const run = logins.login(
    {
      kind: "claude",
      accountId: "claude-a",
      tokenFile,
      commit: () => new Promise<boolean>((resolve) => (grant = resolve)),
    },
    events,
  )!;
  finish[0]!();
  await delay(50);
  run.cancel();
  grant(true);
  await run.done;
  assert.equal(existsSync(tokenFile), true);
});

test("a discard waits for an ingest already in the account's lane", async () => {
  // One lane, run in order per account.
  const tails = new Map<string, Promise<unknown>>();
  const lane = {
    run<T>(id: string, work: () => Promise<T>): Promise<T> {
      const turn = (tails.get(id) ?? Promise.resolve()).then(work);
      tails.set(
        id,
        turn.catch(() => {}),
      );
      return turn;
    },
  };
  const { logins, finish } = setup(lane);
  const tokenFile = logins.newTokenFile("claude", "claude-a");
  let grant!: (ok: boolean) => void;
  const run = logins.login(
    {
      kind: "claude",
      accountId: "claude-a",
      tokenFile,
      commit: () => new Promise<boolean>((resolve) => (grant = resolve)),
    },
    events,
  )!;
  finish[0]!();
  await delay(50);
  // The removal arrives while the granted commit is completing.
  const discarded = Promise.resolve(logins.discardCredential("claude-a"));
  grant(true);
  await run.done;
  await discarded;
  assert.equal(existsSync(tokenFile), false);
});
