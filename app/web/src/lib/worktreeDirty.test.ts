import { describe, expect, it } from "vitest";
import type { WorktreeGitStatus } from "@assistant/shared";
import { dirtyWorktreeIds, dirtyWorktreeKey } from "./worktreeDirty.ts";

/**
 * What a Backlog row's dirty marker is allowed to cost. The slice exists to
 * keep a memoized list from repainting, so what is asserted is WHEN its key
 * moves — never how it is spelled. Its scope comes from `taskActivity.ts`'s
 * `taskWorktreeIds` (tested there).
 */

const NOW = 1_800_000_000_000;

function gitStatus(
  worktreeId: string,
  dirty: boolean,
  patch: Partial<WorktreeGitStatus> = {},
): WorktreeGitStatus {
  return {
    worktreeId,
    branch: worktreeId,
    head: "abc1234",
    dirty,
    filesChanged: dirty ? 2 : 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: NOW,
    ...patch,
  };
}

const statuses = (list: WorktreeGitStatus[]) =>
  Object.fromEntries(list.map((status) => [status.worktreeId, status]));

const key = (list: WorktreeGitStatus[], scope: string[]) =>
  dirtyWorktreeKey(dirtyWorktreeIds(statuses(list), scope));

describe("dirtyWorktreeIds", () => {
  it("answers on content, not on the order statuses arrived in", () => {
    const a = gitStatus("wt-a", true);
    const b = gitStatus("wt-b", false);
    const c = gitStatus("wt-c", true);
    const scope = ["wt-a", "wt-b", "wt-c"];
    expect(key([a, b, c], scope)).toBe(key([c, b, a], scope));
    // A rescan that found more files in an already-dirty tree says nothing new.
    expect(
      key([{ ...a, filesChanged: 40, updatedAt: NOW + 1 }, b, c], scope),
    ).toBe(key([a, b, c], scope));
    // Committing that tree does.
    expect(key([{ ...a, dirty: false }, b, c], scope)).not.toBe(
      key([a, b, c], scope),
    );
  });

  it("ignores a worktree outside the Backlog's own scope", () => {
    // The worktree behind the conversation you have open is watched and goes
    // dirty as you work in it. No Task row can show it, so it must not move
    // the key that repaints ~226 of them.
    const scope = ["wt-a"];
    const clean = [gitStatus("wt-a", false), gitStatus("wt-other", false)];
    const elsewhere = [gitStatus("wt-a", false), gitStatus("wt-other", true)];
    expect(key(elsewhere, scope)).toBe(key(clean, scope));
    expect(key([gitStatus("wt-a", true)], scope)).not.toBe(key(clean, scope));
  });

  it("treats a scoped worktree with no status as unknown, not clean", () => {
    // It simply does not appear — which is the same answer a clean tree gives,
    // and deliberately so: the row states nothing either way.
    expect(dirtyWorktreeIds({}, ["wt-a"])).toEqual([]);
  });
});
