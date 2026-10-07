// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeComment,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import type { Prefs } from "../../hooks/usePrefs.ts";
import type { CommentActions } from "../diff/comments.tsx";

/**
 * The right panel's Worktree tab: the open session's worktree, read beside the
 * chat that is writing it. It is the SAME detail page the `/worktrees/:id`
 * route draws, so what is pinned here is the panel's own boundary — navigation
 * that stays inside the panel, the one destination that leaves it, the
 * refcounted comment hold, and the three answers it gives when there is no
 * worktree to draw.
 */

const changes: WorktreeChangesResponse = {
  worktreeId: "wt-1",
  branch: "feature",
  head: "head-oid",
  updatedAt: 1,
  scope: { kind: "workingTree" },
  files: [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      binary: false,
    },
  ],
  totals: { files: 1, additions: 2, deletions: 1 },
};

vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeStatus: () => new Promise<never>(() => {}),
  fetchWorktreeChanges: () => Promise.resolve(changes),
  fetchWorktreeFile: () => new Promise<never>(() => {}),
  fetchWorktreeFileDiff: () => new Promise<never>(() => {}),
  fetchWorktreeTree: () => Promise.resolve([]),
  fetchWorktreeLog: () => new Promise<never>(() => {}),
  hashContent: (value: string) => `hash:${value.length}`,
  worktreeFileRawUrl: (id: string, path: string) => `raw:${id}/${path}`,
}));

// The pierre stack renders nothing here: this is about which worktree the panel
// is on and where its links go, not about diff rendering.
vi.mock("../diff/DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
}));
vi.mock("../diff/DiffSurface.tsx", () => ({
  DiffSurface: () => <div>diff surface</div>,
}));
vi.mock("../diff/FileSurface.tsx", () => ({
  FileSurface: () => <div>file surface</div>,
}));

const { WorktreePanel } = await import("./WorktreePanel.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no `matchMedia`, and the toolbar now asks the breakpoint whether it
// is on a phone (a bottom sheet) or anywhere else (an anchored popover).
window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const worktree: WorktreeRecord = {
  id: "wt-1",
  projectId: "proj",
  mainRepoRoot: "/repo",
  path: "/repo-wt",
  branch: "feature",
  baseBranch: "main",
  baseCommit: "base-oid",
  status: "active",
  sessionIds: ["s-1"],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const status: WorktreeGitStatus = {
  worktreeId: "wt-1",
  branch: "feature",
  head: "head-oid",
  dirty: true,
  filesChanged: 1,
  untracked: 0,
  additions: 2,
  deletions: 1,
  ahead: 0,
  behind: 0,
  merged: false,
  updatedAt: 1,
};

const prefs = {
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  worktreeReviewMode: "changeset",
  diffStyle: "unified",
  theme: "dark",
} as Prefs;

const commentActions = {} as CommentActions;

/** One open comment nobody has handed to an agent: a review, pending. */
const pendingComment: WorktreeComment = {
  id: "c-1",
  worktreeId: "wt-1",
  author: { kind: "user" },
  body: "This needs a second look.",
  current: { path: "src/app.ts", line: 3 },
  createdAt: 0,
  updatedAt: 0,
};

let container: HTMLDivElement;
let root: Root;
let navigated: string[];
let held: string[];
let submitted: Array<{ worktreeId: string; commentIds: string[] }>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  navigated = [];
  held = [];
  submitted = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function show(
  props: Partial<Parameters<typeof WorktreePanel>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <WorktreePanel
        worktree={worktree}
        worktreeId={worktree.id}
        worktreesLoaded
        status={status}
        prefs={prefs}
        onUpdatePrefs={() => {}}
        commentsByWorktreeId={{}}
        commentWatch={{
          list: (id) => held.push(`list:${id}`),
          unwatch: (id) => held.push(`unwatch:${id}`),
        }}
        commentActionsFor={() => commentActions}
        onSubmitReview={(worktreeId, commentIds) =>
          submitted.push({ worktreeId, commentIds })
        }
        onNavigate={(path) => navigated.push(path)}
        {...props}
      />,
    );
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  );
}

function tab(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
}

it("draws the session's worktree and holds its comments while it is up", async () => {
  await show();
  expect(container.textContent).toContain("feature");
  expect(held).toEqual(["list:wt-1"]);

  await act(async () => root.unmount());
  expect(held).toEqual(["list:wt-1", "unwatch:wt-1"]);
});

it("keeps its own navigation inside the panel", async () => {
  await show();
  await act(async () => tab("Files")!.click());
  // The view moved in the panel, and nothing was handed to the main pane.
  expect(navigated).toEqual([]);
  expect(tab("Files")!.className).toContain("bg-muted");
});

it("hands the worktree to the main pane with the view it is on", async () => {
  await show();
  await act(async () => tab("Files")!.click());
  await act(async () => button("Open in Worktrees")!.click());
  expect(navigated).toEqual(["/worktrees/wt-1/files"]);
});

it("says what is missing rather than drawing an empty page", async () => {
  // A session that runs nowhere: a fact, not a loading state.
  await show({ worktree: undefined, worktreeId: undefined });
  expect(container.textContent).toContain("does not run in a worktree");
  expect(held).toEqual([]);

  // The id is there but the registry has not answered yet (R1: not empty).
  await show({ worktree: undefined, worktreesLoaded: false });
  expect(container.textContent).toContain("Opening worktree…");

  // It answered, and the worktree is gone.
  await show({ worktree: undefined });
  expect(container.textContent).toContain("no longer exists");
});

it("names the worktree it is submitting a review on", async () => {
  // The host's submit sheet cannot read the target off the address bar: the
  // panel follows the SESSION, so beside a session there is no worktree route
  // at all, and beside another worktree's page the route names the wrong one.
  await show({ commentsByWorktreeId: { "wt-1": [pendingComment] } });
  await act(async () => button("Submit review (1 pending)")!.click());
  expect(submitted).toEqual([{ worktreeId: "wt-1", commentIds: ["c-1"] }]);
});
