/**
 * The per-account Claude model snapshot cache against a fake reader and a fake
 * clock: what publishes, what a failure keeps, the retry floor, the bounded
 * wait, and generation ordering across logins and deletions. No gateway, no
 * credential.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createClaudeAccountModelCache,
  type ClaudeAccountModelCache,
  type ClaudeAccountModelsDeps,
} from "./claudeAccountModels.ts";

const ALL = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
];
const NO_HAIKU = ALL.filter((id) => id !== "claude-haiku-5-5");

interface Deferred {
  resolve: (ids: string[] | undefined) => void;
  reject: (err: Error) => void;
}

/** A reader whose every call waits until the test settles it. */
function harness(overrides: Partial<ClaudeAccountModelsDeps> = {}): {
  cache: ClaudeAccountModelCache;
  calls: Deferred[];
  clock: { now: number };
  changes: string[];
} {
  const calls: Deferred[] = [];
  const clock = { now: 1_000_000 };
  const cache = createClaudeAccountModelCache({
    read: () =>
      new Promise<string[] | undefined>((resolve, reject) =>
        calls.push({ resolve, reject }),
      ),
    readable: () => true,
    now: () => clock.now,
    ensureBoundMs: 10_000,
    retryFloorMs: 60_000,
    ...overrides,
  });
  const changes: string[] = [];
  cache.subscribe((id) => changes.push(id));
  return { cache, calls, clock, changes };
}

/** Let settled promises' continuations run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a successful read publishes once; an identical later read is no change", async () => {
  const { cache, calls, changes } = harness();
  assert.equal(cache.ids("c1"), undefined, "unknown before any read");
  const first = cache.refresh({ profileIds: ["c1"], force: false });
  calls[0]!.resolve(NO_HAIKU);
  await first;
  assert.deepEqual([...cache.ids("c1")!], NO_HAIKU);
  assert.deepEqual(changes, ["c1"]);

  const again = cache.refresh({ profileIds: ["c1"], force: false });
  calls[1]!.resolve([...NO_HAIKU].reverse());
  await again;
  assert.deepEqual(changes, ["c1"], "same set, no listener");

  const changed = cache.refresh({ profileIds: ["c1"], force: true });
  calls[2]!.resolve(ALL);
  await changed;
  assert.deepEqual(changes, ["c1", "c1"]);
  assert.ok(cache.ids("c1")!.has("claude-haiku-5-5"));
});

test("a failed or implausible read keeps the last success; a first failure stays unknown", async () => {
  const { cache, calls, changes } = harness();
  const failed = cache.refresh({ profileIds: ["c1"], force: false });
  calls[0]!.reject(new Error("Claude model listing failed (HTTP 500)."));
  await failed;
  assert.equal(cache.ids("c1"), undefined);

  const ok = cache.refresh({ profileIds: ["c1"], force: true });
  calls[1]!.resolve(ALL);
  await ok;
  for (const outcome of [
    () => calls[2]!.reject(new Error("Claude model listing timed out.")),
    () => calls[3]!.resolve(["claude-something-else"]),
    () => calls[4]!.resolve([]),
  ]) {
    const next = cache.refresh({ profileIds: ["c1"], force: true });
    outcome();
    await next;
    assert.deepEqual([...cache.ids("c1")!], ALL, "never narrowed by a failure");
  }
  assert.deepEqual(changes, ["c1"]);
});

test("no gateway: nothing is read and no attempt counts against the floor", async () => {
  let reads = 0;
  const { cache } = harness({
    read: async () => {
      reads += 1;
      return undefined;
    },
  });
  await cache.ensure("c1");
  await cache.ensure("c1");
  assert.equal(reads, 2, "each wait asks again; nothing is held as a failure");
  assert.equal(cache.ids("c1"), undefined);
});

test("ensure: a known account never reads; callers join one read; a failure waits out the floor", async () => {
  const { cache, calls, clock } = harness();
  const a = cache.ensure("c1");
  const b = cache.ensure("c1");
  assert.equal(calls.length, 1, "concurrent waits share one read");
  calls[0]!.reject(new Error("Claude model listing failed (HTTP 502)."));
  await Promise.all([a, b]);

  // Inside the floor: no new read, and the wait resolves at once.
  await cache.ensure("c1");
  assert.equal(calls.length, 1);
  clock.now += 60_000;
  const c = cache.ensure("c1");
  assert.equal(calls.length, 2, "after the floor a pick may read again");
  calls[1]!.resolve(ALL);
  await c;
  await cache.ensure("c1");
  assert.equal(calls.length, 2, "known: no read per pick");
});

test("readable only: a disabled or non-Claude account is never read", async () => {
  const { cache, calls } = harness({ readable: (id) => id === "c1" });
  await cache.ensure("o1");
  await cache.refresh({ profileIds: ["o1"], force: true });
  cache.credentialChanged("o1");
  assert.equal(calls.length, 0);
});

test("(a) a login during a lazy read discards the older read; the post-login read publishes", async () => {
  const { cache, calls, changes } = harness();
  const lazy = cache.ensure("c1");
  assert.equal(calls.length, 1);
  cache.credentialChanged("c1");
  assert.equal(calls.length, 2, "a forced read never joins the pre-login one");
  calls[0]!.resolve(ALL);
  await flush();
  assert.equal(
    cache.ids("c1"),
    undefined,
    "the pre-login read never publishes",
  );
  calls[1]!.resolve(NO_HAIKU);
  await lazy;
  await flush();
  assert.deepEqual([...cache.ids("c1")!], NO_HAIKU);
  assert.deepEqual(changes, ["c1"]);
});

test("(b) a deletion during a read leaves no entry, and a late completion never recreates it", async () => {
  const { cache, calls, changes } = harness();
  const known = cache.refresh({ profileIds: ["c1"], force: false });
  calls[0]!.resolve(ALL);
  await known;
  const pending = cache.refresh({ profileIds: ["c1"], force: true });
  cache.forget("c1");
  assert.equal(cache.ids("c1"), undefined);
  calls[1]!.resolve(NO_HAIKU);
  await pending;
  assert.equal(cache.ids("c1"), undefined);
  assert.deepEqual(changes, ["c1", "c1"], "the deletion itself is a change");
});

test("(c) reversed completion of overlapping reads publishes only the newest generation", async () => {
  const { cache, calls } = harness();
  const older = cache.refresh({ profileIds: ["c1"], force: true });
  const newer = cache.refresh({ profileIds: ["c1"], force: true });
  calls[1]!.resolve(NO_HAIKU);
  await newer;
  calls[0]!.resolve(ALL);
  await older;
  assert.deepEqual([...cache.ids("c1")!], NO_HAIKU);
});

test("(d) a rejecting read clears its in-flight state; the next call reads again after the floor", async () => {
  const { cache, calls, clock } = harness();
  const first = cache.ensure("c1");
  calls[0]!.reject(new Error("Claude model listing failed (HTTP 500)."));
  await first;
  await cache.ensure("c1");
  assert.equal(calls.length, 1, "no read inside the floor");
  clock.now += 60_001;
  const second = cache.ensure("c1");
  assert.equal(calls.length, 2, "the failed read is not joined again");
  calls[1]!.resolve(ALL);
  await second;
  assert.ok(cache.ids("c1"));
});

test("(e) a never-settling lease and fetch: ensure resolves at the bound and the account stays unknown", async () => {
  const { cache, calls } = harness({ ensureBoundMs: 30 });
  const started = Date.now();
  await cache.ensure("c1");
  assert.ok(Date.now() - started < 5_000, "bounded");
  assert.equal(cache.ids("c1"), undefined);
  assert.equal(calls.length, 1);

  // The stalled read is not waited on again by every pick.
  const again = Date.now();
  await cache.ensure("c1");
  assert.ok(Date.now() - again < 25, "no second full wait inside the floor");
  assert.equal(calls.length, 1, "and no second read");

  // A credential change still starts a fresh read at once.
  cache.credentialChanged("c1");
  assert.equal(calls.length, 2);
  calls[1]!.resolve(ALL);
  await flush();
  assert.ok(cache.ids("c1"));
});
