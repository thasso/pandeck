// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";

interface Pending {
  resolve: (value: WorktreeChangesResponse) => void;
  reject: (error: unknown) => void;
}
const requests: Pending[] = [];
vi.mock("../lib/worktrees.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWorktreeChanges: () =>
    new Promise<WorktreeChangesResponse>((resolve, reject) => {
      requests.push({ resolve, reject });
    }),
}));

const { useWorktreeChangeSets } = await import("./WorktreeSections.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const worktree: WorktreeRecord = {
  id: "wt-1",
  projectId: "p1",
  mainRepoRoot: "/repo",
  path: "/repo-wt",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "base",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};
const wanted = [{ worktree, kind: "uncommitted" as const }];

function status(updatedAt: number): Record<string, WorktreeGitStatus> {
  return {
    "wt-1": {
      worktreeId: "wt-1",
      branch: "feature",
      head: "head",
      dirty: true,
      filesChanged: 1,
      untracked: 0,
      additions: 1,
      deletions: 0,
      ahead: 0,
      behind: 0,
      merged: false,
      updatedAt,
    },
  };
}

function changes(path: string): WorktreeChangesResponse {
  return {
    worktreeId: "wt-1",
    branch: "feature",
    head: "head",
    scope: { kind: "workingTree" },
    files: [
      { path, status: "modified", additions: 1, deletions: 0, binary: false },
    ],
    totals: { files: 1, additions: 1, deletions: 0 },
    updatedAt: 1,
  };
}

it("keeps the newer change list when an older request answers last", async () => {
  let sets: ReturnType<typeof useWorktreeChangeSets> = {};
  function Probe({
    statuses,
  }: {
    statuses: Record<string, WorktreeGitStatus>;
  }) {
    sets = useWorktreeChangeSets(wanted, statuses);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe statuses={status(1)} />));
  await act(async () => root.render(<Probe statuses={status(2)} />));
  expect(requests).toHaveLength(2);

  await act(async () => requests[1]!.resolve(changes("new.ts")));
  await act(async () => requests[0]!.resolve(changes("old.ts")));
  const entry = sets["wt-1:uncommitted"];
  expect(
    entry && "response" in entry ? entry.response.files[0]?.path : null,
  ).toBe("new.ts");

  // A late failure of a superseded, still-pending request does not replace
  // the newer answer either.
  await act(async () => root.render(<Probe statuses={status(3)} />));
  await act(async () => root.render(<Probe statuses={status(4)} />));
  expect(requests).toHaveLength(4);
  await act(async () => requests[3]!.resolve(changes("newest.ts")));
  await act(async () => requests[2]!.reject(new Error("stale")));
  const after = sets["wt-1:uncommitted"];
  expect(
    after && "response" in after ? after.response.files[0]?.path : null,
  ).toBe("newest.ts");
  act(() => root.unmount());
});
