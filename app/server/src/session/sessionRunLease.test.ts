/**
 * The lease is the only thing standing between "start a run in this session"
 * and "delete this session's checkout", so its two directions and its release
 * discipline are the contract. The last test drives the REAL prompt facade to
 * prove the check is where every prompt path actually passes.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  assertSessionRunnable,
  beginPromptRun,
  reserveWorktreeForMutation,
  reserveWorktreeForRemoval,
  resetSessionRunLeasesForTests,
  setSessionWorktreeResolverForTests,
} from "./sessionRunLease.ts";
import {
  promptRuntimeSessionWithRuntime,
  type RuntimePromptDriver,
} from "./runtimePrompt.ts";
import type { SessionRuntime } from "./runtime/runtime.ts";

/** Where each session lives, as the graph store would answer. */
function sessionsIn(links: Record<string, string | undefined>): void {
  setSessionWorktreeResolverForTests((sessionId) => links[sessionId]);
}

afterEach(() => {
  resetSessionRunLeasesForTests();
});

test("a removal hold refuses every run on that worktree until released", () => {
  sessionsIn({ s1: "wt-1", s2: "wt-2" });
  const release = reserveWorktreeForRemoval(
    "wt-1",
    "the worktree is being removed.",
  );
  assert.ok(release);
  assert.throws(() => beginPromptRun("s1"), /being removed/);
  // A session in ANOTHER worktree is unaffected — the hold is per worktree.
  beginPromptRun("s2")();

  release!();
  beginPromptRun("s1")();
});

// The resource is the WORKTREE, so a session that did not exist when the hold
// was taken — a fork, a review handoff — is refused by the same hold. A
// snapshot of "the sessions on this worktree" could never cover it.
test("a session linked after the hold is refused by it too", () => {
  sessionsIn({ s1: "wt-1" });
  const release = reserveWorktreeForRemoval("wt-1", "cleanup is running.");
  assert.ok(release);

  // A new session appears on the same worktree.
  sessionsIn({ s1: "wt-1", "s-new": "wt-1" });
  assert.throws(() => beginPromptRun("s-new"), /cleanup is running/);

  release!();
  beginPromptRun("s-new")();
});

test("a run in flight refuses a removal of its worktree, which must then stop", () => {
  sessionsIn({ s1: "wt-1" });
  const releaseRun = beginPromptRun("s1");
  assert.equal(
    reserveWorktreeForRemoval("wt-1", "cleanup"),
    undefined,
    "a worktree with a run in flight may not be reserved",
  );

  releaseRun();
  const release = reserveWorktreeForRemoval("wt-1", "cleanup");
  assert.ok(release, "released again once the run finished");
  release!();
});

test("a caller may reserve its own running worktree but no peer may write or start", () => {
  sessionsIn({ caller: "wt-1", peer: "wt-1" });
  const releaseCallerRun = beginPromptRun("caller");
  const releaseMutation = reserveWorktreeForMutation(
    "wt-1",
    "caller",
    "a checked commit is running.",
  );
  assert.ok(releaseMutation);
  assert.equal(
    reserveWorktreeForMutation("wt-1", "peer", "another write"),
    undefined,
  );
  assert.throws(() => beginPromptRun("peer"), /checked commit/);

  releaseMutation!();
  const releasePeerRun = beginPromptRun("peer");
  releasePeerRun();
  releaseCallerRun();
});

test("a second start for the caller also makes its target busy", () => {
  sessionsIn({ caller: "wt-1" });
  const releaseFirst = beginPromptRun("caller");
  const releaseSecond = beginPromptRun("caller");
  assert.equal(
    reserveWorktreeForMutation("wt-1", "caller", "commit"),
    undefined,
  );
  releaseSecond();
  const releaseMutation = reserveWorktreeForMutation(
    "wt-1",
    "caller",
    "commit",
  );
  assert.ok(releaseMutation);
  releaseMutation!();
  releaseFirst();
});

test("a caller on another worktree may reserve only an idle target", () => {
  sessionsIn({ caller: "wt-other", writer: "wt-target" });
  const release = reserveWorktreeForMutation(
    "wt-target",
    "caller",
    "cross-worktree commit",
  );
  assert.ok(release, "an idle target is available across worktrees");
  assert.throws(() => beginPromptRun("writer"), /cross-worktree commit/);
  release!();

  const releaseWriter = beginPromptRun("writer");
  assert.equal(
    reserveWorktreeForMutation("wt-target", "caller", "too late"),
    undefined,
  );
  releaseWriter();
});

test("two removals cannot hold the same worktree at once", () => {
  const first = reserveWorktreeForRemoval("wt-1", "cleanup");
  assert.ok(first);
  assert.equal(reserveWorktreeForRemoval("wt-1", "another cleanup"), undefined);
  first!();
  const second = reserveWorktreeForRemoval("wt-1", "another cleanup");
  assert.ok(second);
  second!();
});

// A session with no worktree at all runs in the app checkout; nothing holds it.
test("a session outside any worktree is never held", () => {
  sessionsIn({ s1: undefined });
  reserveWorktreeForRemoval("wt-1", "cleanup");
  assert.doesNotThrow(() => assertSessionRunnable("s1"));
  beginPromptRun("s1")();
});

// Releasing twice must not drop someone else's hold — a `finally` can run after
// an early release on an error path.
test("releases are idempotent", () => {
  sessionsIn({ s1: "wt-1" });
  const releaseRun = beginPromptRun("s1");
  releaseRun();
  releaseRun();
  const release = reserveWorktreeForRemoval("wt-1", "cleanup");
  assert.ok(release);
  release!();
  release!();
  assert.doesNotThrow(() => assertSessionRunnable("s1"));
});

// The facade is where the app contractually starts every prompt, so the refusal
// has to be observable THERE — not only in this module's own functions.
test("the prompt facade itself refuses a held session before anything is appended", async () => {
  sessionsIn({ s1: "wt-1" });
  const release = reserveWorktreeForRemoval(
    "wt-1",
    "The worktree of this session is being cleaned up.",
  );
  const runtime = {
    get() {
      throw new Error("the runtime must not be touched for a refused prompt");
    },
    createSession() {
      throw new Error("the runtime must not be touched for a refused prompt");
    },
  } as unknown as SessionRuntime;
  const driver = {
    id: "s1",
    sessionId: "s1",
    key: "s1",
    harness: "pi",
    agentType: "workshop",
    sessionFile: undefined,
    isRunning: false,
    canSteer: false,
  } as unknown as RuntimePromptDriver;

  await assert.rejects(
    promptRuntimeSessionWithRuntime(runtime, driver, "resolve the conflict"),
    /being cleaned up/,
  );
  release!();
});
