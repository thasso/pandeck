/**
 * AC4: the CLI's two refresh locks, taken, waited on, kept alive and
 * released as CLI 2.1.316 does, in a temp config dir.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { withClaudeRefreshLock } from "./refreshLock.ts";

afterEach(() => {
  vi.useRealTimers();
});

async function configDir(): Promise<{
  dir: string;
  primary: string;
  legacy: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "refresh-lock-"));
  const dir = join(root, "claude");
  await mkdir(dir);
  return {
    dir,
    primary: join(dir, ".oauth_refresh.lock"),
    legacy: `${dir}.lock`,
  };
}

test("AC4: a held primary lock is retried five times, then lock_busy without work", async () => {
  const { dir, primary } = await configDir();
  await mkdir(primary);
  const sleeps: number[] = [];
  let worked = false;
  const result = await withClaudeRefreshLock(
    dir,
    async () => {
      worked = true;
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  );
  assert.deepEqual(result, { ok: false, code: "lock_busy" });
  assert.equal(worked, false);
  assert.deepEqual(sleeps, [1500, 1500, 1500, 1500, 1500]);
  assert.ok(existsSync(primary), "another holder's lock is never removed");
});

test("AC4: a primary lock 61 s old is stale and taken over", async () => {
  const { dir, primary, legacy } = await configDir();
  await mkdir(primary);
  const old = new Date(Date.now() - 61_000);
  await utimes(primary, old, old);
  const seen: boolean[] = [];
  const result = await withClaudeRefreshLock(dir, async () => {
    seen.push(existsSync(primary), existsSync(legacy));
    return "done";
  });
  assert.deepEqual(result, { ok: true, value: "done" });
  assert.deepEqual(seen, [true, true]);
  assert.equal(existsSync(primary), false);
  assert.equal(existsSync(legacy), false);
});

test("AC4: a held legacy lock releases the primary, and the next attempt takes both", async () => {
  const { dir, primary, legacy } = await configDir();
  await mkdir(legacy);
  const duringSleep: boolean[] = [];
  const result = await withClaudeRefreshLock(dir, async () => "done", {
    sleep: async () => {
      duringSleep.push(existsSync(primary));
      await rm(legacy, { recursive: true });
    },
    random: () => 0,
  });
  assert.deepEqual(result, { ok: true, value: "done" });
  assert.deepEqual(duringSleep, [false]);
  assert.equal(existsSync(primary), false);
  assert.equal(existsSync(legacy), false);
});

test("AC4: the heartbeat advances both mtimes, and release removes both", async () => {
  const { dir, primary, legacy } = await configDir();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const later = Date.now() + 120_000;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = withClaudeRefreshLock(dir, () => held, { now: () => later });
  await vi.waitFor(() => assert.ok(existsSync(legacy)));
  const before = (await stat(primary)).mtimeMs;
  assert.ok(before < later - 60_000);
  vi.advanceTimersByTime(5_000);
  for (const path of [primary, legacy])
    assert.equal(
      Math.round((await stat(path)).mtimeMs / 1000),
      Math.round(later / 1000),
    );
  release();
  assert.deepEqual(await running, { ok: true, value: undefined });
  assert.equal(existsSync(primary), false);
  assert.equal(existsSync(legacy), false);
});

test("AC4: a profile dir removed while held: release succeeds and nothing is recreated", async () => {
  const { dir, legacy } = await configDir();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const result = await withClaudeRefreshLock(dir, async () => {
    await rm(dir, { recursive: true });
    await rm(legacy, { recursive: true });
    vi.advanceTimersByTime(5_000);
    return "done";
  });
  assert.deepEqual(result, { ok: true, value: "done" });
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(legacy), false);
});

test("AC4: a missing config dir is gone, and nothing is created", async () => {
  const { dir, legacy } = await configDir();
  await rm(dir, { recursive: true });
  const result = await withClaudeRefreshLock(dir, async () => "never");
  assert.deepEqual(result, { ok: false, code: "gone" });
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(legacy), false);
});

test("AC4: an error in the work propagates after both locks are released", async () => {
  const { dir, primary, legacy } = await configDir();
  await assert.rejects(
    withClaudeRefreshLock(dir, async () => {
      throw new Error("work failed");
    }),
    /work failed/,
  );
  assert.equal(existsSync(primary), false);
  assert.equal(existsSync(legacy), false);
});
