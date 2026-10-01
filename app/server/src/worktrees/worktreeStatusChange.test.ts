/**
 * `changedAt` must answer "when did something happen here", not "when did we
 * last look". Every scan stamps `updatedAt` — including the routine rescan
 * after a fetch that found nothing — so a surface ordering or ageing by that
 * treats a quiet worktree as freshly active every few minutes.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorktreeGitStatus } from "@assistant/shared";
import {
  clearWorktreeStatusMemoryForTests,
  resolveChangedAtForTests,
  worktreeStatusSignature,
} from "./worktreeStatus.ts";

function status(partial: Partial<WorktreeGitStatus> = {}): WorktreeGitStatus {
  return {
    worktreeId: "wt",
    branch: "feature",
    head: "abc1234",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: 1,
    ...partial,
  };
}

test("a re-scan that found nothing has the same signature", () => {
  // Only the scan timestamps differ, which is exactly the no-op rescan case.
  assert.equal(
    worktreeStatusSignature(status({ updatedAt: 1, fetchedAt: 1 })),
    worktreeStatusSignature(status({ updatedAt: 999_999, fetchedAt: 999_999 })),
  );
});

test("changing the own upstream name is meaningful activity", () => {
  assert.notEqual(
    worktreeStatusSignature(
      status({ upstream: { ahead: 0, behind: 0, name: "origin/feature" } }),
    ),
    worktreeStatusSignature(
      status({ upstream: { ahead: 0, behind: 0, name: "fork/feature" } }),
    ),
  );
});

test("repo-wide base-upstream drift does not become per-worktree activity", () => {
  assert.equal(
    worktreeStatusSignature(status()),
    worktreeStatusSignature(status({ baseUpstream: { ahead: 0, behind: 12 } })),
  );
});

test("every meaningful field moves the signature", () => {
  const base = worktreeStatusSignature(status());
  const moved: Array<Partial<WorktreeGitStatus>> = [
    { head: "def5678" },
    { branch: "other" },
    { dirty: true },
    { filesChanged: 1 },
    { untracked: 1 },
    { additions: 1 },
    { deletions: 1 },
    { ahead: 1 },
    { behind: 1 },
    { upstream: { ahead: 1, behind: 0 } },
    { merged: true },
  ];
  for (const patch of moved) {
    assert.notEqual(
      worktreeStatusSignature(status(patch)),
      base,
      `expected ${JSON.stringify(patch)} to count as a change`,
    );
  }
});

/**
 * Change detection is in-memory, so every restart and deploy re-observes every
 * worktree. Stamping the first observation would mark every quiet worktree
 * freshly active on a schedule — the same false recency the field exists to
 * remove. `resolveChangedAtForTests` is the rule; these are its three moments.
 */
test("a first observation records a baseline and claims no transition", () => {
  clearWorktreeStatusMemoryForTests();
  assert.equal(resolveChangedAtForTests("wt", status(), 1_000), undefined);
});

test("a restart does not invent activity for a worktree that did not move", () => {
  clearWorktreeStatusMemoryForTests();
  const before = status({ head: "abc1234" });
  resolveChangedAtForTests("wt", before, 1_000);
  // The process restarts: the memory is gone and the same state is re-observed.
  clearWorktreeStatusMemoryForTests();
  assert.equal(resolveChangedAtForTests("wt", before, 9_000_000), undefined);
  // And a second scan after that restart still claims nothing.
  assert.equal(resolveChangedAtForTests("wt", before, 9_100_000), undefined);
});

test("the first REAL change after a baseline is dated", () => {
  clearWorktreeStatusMemoryForTests();
  resolveChangedAtForTests("wt", status({ head: "abc1234" }), 1_000);
  assert.equal(
    resolveChangedAtForTests("wt", status({ head: "def5678" }), 2_000),
    2_000,
  );
  // …and holds while nothing moves again.
  assert.equal(
    resolveChangedAtForTests("wt", status({ head: "def5678" }), 3_000),
    2_000,
  );
});
