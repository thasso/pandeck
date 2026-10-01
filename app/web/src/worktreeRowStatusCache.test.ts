// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import type { WorktreeGitStatus, WorktreeRecord } from "@assistant/shared";
import { createInitialState } from "./hooks/useAssistant.ts";
import { rowWorktreeStatus } from "./lib/worktreeRowStatuses.ts";

beforeEach(() => window.localStorage.clear());

const worktree: WorktreeRecord = {
  id: "one",
  projectId: "project",
  mainRepoRoot: "/repo",
  path: "/repo/worktrees/one",
  branch: "one",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 1,
  updatedAt: 1,
};

const status: WorktreeGitStatus = {
  worktreeId: worktree.id,
  branch: "one",
  head: "abc",
  dirty: true,
  filesChanged: 2,
  untracked: 0,
  additions: 12,
  deletions: 3,
  ahead: 1,
  behind: 0,
  upstream: { ahead: 1, behind: 0, name: "origin/one" },
  merged: false,
  updatedAt: 2,
  fetchedAt: 2,
};

function writeCache(worktreeStatuses: unknown): void {
  const defaults = createInitialState();
  window.localStorage.setItem(
    "assistant.appShellCache.v1",
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: defaults.settings,
      slashCommands: [],
      taskList: null,
      projectList: null,
      worktrees: [worktree],
      worktreeStatuses,
    }),
  );
}

it("paints a cold worktree row from the last known status", () => {
  writeCache({ [worktree.id]: status });
  const hydrated = createInitialState();
  // The live record is untouched: what this socket episode has observed is
  // still nothing, which is what every decision on a status keeps reading.
  expect(hydrated.worktreeStatuses).toEqual({});
  expect(hydrated.cachedWorktreeStatuses[worktree.id]).toEqual(status);
  expect(
    rowWorktreeStatus(
      hydrated.worktreeStatuses,
      hydrated.cachedWorktreeStatuses,
      worktree.id,
    )?.ahead,
  ).toBe(1);
});

it("hydrates a cache written before statuses were remembered", () => {
  writeCache(undefined);
  const hydrated = createInitialState();
  expect(hydrated.cachedWorktreeStatuses).toEqual({});
  expect(hydrated.worktrees).toEqual([worktree]);
});

// Every one of these parses as JSON and would reach JSX: a branch that is an
// object throws on render, and a missing count draws `undefined`. One bad
// entry drops the whole record, so the rows fall back to their one-line form
// rather than to a half-read status.
const malformed: Array<[string, unknown]> = [
  ["a status that is not an object", "dirty"],
  ["a branch that is an object", { ...status, branch: {} }],
  ["a head that is neither string nor null", { ...status, head: 7 }],
  ["a missing count", { ...status, filesChanged: undefined }],
  ["a negative count", { ...status, additions: -1 }],
  ["a non-finite count", { ...status, ahead: Number.NaN }],
  ["a malformed upstream", { ...status, upstream: { ahead: 1 } }],
  ["a malformed base upstream", { ...status, baseUpstream: { name: "x" } }],
  ["a non-boolean baseUnresolved", { ...status, baseUnresolved: "yes" }],
  ["a non-numeric fetch stamp", { ...status, fetchedAt: "2026-09-08" }],
];

for (const [label, entry] of malformed) {
  it(`drops the remembered record for ${label}`, () => {
    writeCache({ [worktree.id]: entry });
    const hydrated = createInitialState();
    expect(hydrated.cachedWorktreeStatuses).toEqual({});
    // The rest of the shell still hydrates; only the row heights are lost.
    expect(hydrated.worktrees).toEqual([worktree]);
  });
}

it("drops a record whose key disagrees with the status it holds", () => {
  // Everything downstream looks a status up by worktree id, so a status filed
  // under another id would render one worktree's state on another's row.
  writeCache({ other: status });
  expect(createInitialState().cachedWorktreeStatuses).toEqual({});
});

it("keeps every status of a record whose entries are all whole", () => {
  writeCache({ [worktree.id]: status, two: { ...status, worktreeId: "two" } });
  expect(
    Object.keys(createInitialState().cachedWorktreeStatuses).sort(),
  ).toEqual(["one", "two"]);
});
