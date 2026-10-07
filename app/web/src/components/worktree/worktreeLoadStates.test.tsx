// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeFileDiffResponse,
  WorktreeFileResponse,
  WorktreeGitStatus,
  WorktreeRecord,
  WorktreeTreeEntry,
} from "@assistant/shared";
import type { Prefs } from "../../hooks/usePrefs.ts";

/**
 * How the worktree detail surfaces draw the five states
 * (`app/web/docs/loading-states.md`, Task-361 Phase 3c).
 *
 * The rule this file exists for is R3 on FILE selection: a diff or a source
 * pane addresses one path, so opening another one must show ITS placeholder —
 * the previous file's content under a new path is the failure mode, and it is
 * the one a reader cannot detect. The rest is R2 (a refresh of the same path
 * keeps what is readable) and the tone of a failure: an inline `ErrorNote`
 * (`role="alert"`) with a retry, not a muted note that reads like a fact.
 *
 * The pierre surfaces are mocked to their rendered content: this is about which
 * state the pane is in, not about diff rendering.
 */

interface Pending<T> {
  key: string;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const changesRequests: Array<Pending<WorktreeChangesResponse>> = [];
const fileRequests: Array<Pending<WorktreeFileResponse>> = [];
const diffRequests: Array<Pending<WorktreeFileDiffResponse>> = [];
const treeRequests: Array<Pending<WorktreeTreeEntry[]>> = [];

function pending<T>(list: Array<Pending<T>>, key: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    list.push({ key, resolve, reject });
  });
}

vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeStatus: () => new Promise<never>(() => {}),
  fetchWorktreeChanges: (id: string) =>
    pending(changesRequests, `changes:${id}`),
  fetchWorktreeFile: (id: string, path: string) =>
    pending(fileRequests, `file:${id}:${path}`),
  fetchWorktreeFileDiff: (id: string, path: string) =>
    pending(diffRequests, `diff:${id}:${path}`),
  fetchWorktreeTree: (id: string, dir: string, includeIgnored = false) =>
    pending(
      treeRequests,
      `tree:${id}:${dir}${includeIgnored ? ":ignored" : ""}`,
    ),
  fetchWorktreeLog: () => new Promise<never>(() => {}),
  hashContent: (value: string) => `hash:${value.length}`,
  worktreeFileRawUrl: (id: string, path: string) => `raw:${id}/${path}`,
}));

vi.mock("../diff/DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
}));

vi.mock("../diff/DiffSurface.tsx", () => ({
  DiffSurface: ({ patch }: { patch?: string }) => <div>{patch}</div>,
}));

vi.mock("../diff/FileSurface.tsx", () => ({
  FileSurface: ({ contents }: { contents: string }) => <div>{contents}</div>,
}));

const WorktreeDetailPage = (await import("./WorktreeDetailPage.tsx")).default;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no `matchMedia`, and the toolbar asks the breakpoint whether it is
// on a phone (a bottom sheet) or anywhere else (an anchored popover).
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
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const prefs = {
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "list",
  worktreeReviewMode: "by-file",
  diffStyle: "unified",
  theme: "dark",
} as Prefs;

function status(updatedAt: number): WorktreeGitStatus {
  return {
    worktreeId: worktree.id,
    branch: "feature",
    head: "head-oid",
    dirty: true,
    filesChanged: 2,
    untracked: 0,
    additions: 3,
    deletions: 1,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt,
  };
}

function changes(paths: string[]): WorktreeChangesResponse {
  return {
    worktreeId: worktree.id,
    branch: "feature",
    head: "head-oid",
    scope: { kind: "workingTree" },
    files: paths.map((path) => ({
      path,
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    })),
    totals: { files: paths.length, additions: paths.length, deletions: 0 },
    updatedAt: 1,
  };
}

function fileDiff(path: string, patch: string): WorktreeFileDiffResponse {
  return {
    worktreeId: worktree.id,
    path,
    status: "modified",
    language: "typescript",
    binary: false,
    truncated: false,
    diff: patch,
    oldContent: "old",
    newContent: "new",
    updatedAt: 1,
  };
}

function fileContent(path: string, content: string): WorktreeFileResponse {
  return {
    worktreeId: worktree.id,
    path,
    language: "typescript",
    mimeType: "text/plain",
    binary: false,
    truncated: false,
    content,
    updatedAt: 1,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  changesRequests.length = 0;
  fileRequests.length = 0;
  diffRequests.length = 0;
  treeRequests.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function show(props: {
  view: "changes" | "files";
  filePath?: string;
  statusUpdatedAt?: number;
}): Promise<void> {
  await act(async () => {
    root!.render(
      <WorktreeDetailPage
        worktree={worktree}
        narrow={false}
        view={props.view}
        {...(props.filePath ? { filePath: props.filePath } : {})}
        {...(props.statusUpdatedAt === undefined
          ? {}
          : { status: status(props.statusUpdatedAt) })}
        navigate={() => {}}
        prefs={prefs}
        onUpdatePrefs={() => {}}
        comments={[]}
        onLoadComments={() => {}}
        onUnloadComments={() => {}}
        onSubmitReview={() => {}}
        commentActions={{
          onAddComment: () => {},
          onResolveComment: () => {},
          onDeleteComment: () => {},
        }}
      />,
    );
  });
}

function text(): string {
  return container!.textContent ?? "";
}

function alerts(): string[] {
  return [...container!.querySelectorAll("[role='alert']")].map(
    (element) => element.textContent ?? "",
  );
}

/** Answer the newest request of a kind. */
async function answer<T>(list: Array<Pending<T>>, value: T): Promise<void> {
  const request = list.at(-1);
  expect(request, "expected a pending request").toBeDefined();
  await act(async () => {
    request!.resolve(value);
  });
}

/** Answer the newest request made for one key (a refresh fans out over dirs). */
async function answerKey<T>(
  list: Array<Pending<T>>,
  key: string,
  value: T,
): Promise<void> {
  const request = [...list].reverse().find((item) => item.key === key);
  expect(request, `expected a pending ${key} request`).toBeDefined();
  await act(async () => {
    request!.resolve(value);
  });
}

function click(selector: string): Promise<void> {
  const element = container!.querySelector<HTMLElement>(selector);
  expect(element, `expected ${selector}`).not.toBeNull();
  return act(async () => {
    element!.click();
  });
}

it("shows the newly selected file's placeholder, not the previous diff", async () => {
  await show({ view: "changes", filePath: "alpha.ts" });
  expect(text()).toContain("Loading changes…");

  await answer(changesRequests, changes(["alpha.ts", "beta.ts"]));
  expect(text()).toContain("Loading diff…");
  await answer(diffRequests, fileDiff("alpha.ts", "alpha patch"));
  expect(text()).toContain("alpha patch");

  // R3: beta.ts is a different object, so alpha's patch may not survive a frame
  // under the new path.
  await show({ view: "changes", filePath: "beta.ts" });
  expect(text()).not.toContain("alpha patch");
  expect(text()).toContain("Loading diff…");

  await answer(diffRequests, fileDiff("beta.ts", "beta patch"));
  expect(text()).toContain("beta patch");
  expect(diffRequests.map((request) => request.key)).toEqual([
    "diff:wt-1:alpha.ts",
    "diff:wt-1:beta.ts",
  ]);
});

it("keeps the diff on screen while a watcher push refreshes the same file", async () => {
  await show({ view: "changes", filePath: "alpha.ts", statusUpdatedAt: 1 });
  await answer(changesRequests, changes(["alpha.ts"]));
  await answer(diffRequests, fileDiff("alpha.ts", "alpha patch"));

  // A bumped status is an invalidation of the SAME path (R2): it refetches
  // without blanking, and a failure adds a note over the readable diff.
  await show({ view: "changes", filePath: "alpha.ts", statusUpdatedAt: 2 });
  expect(text()).toContain("alpha patch");
  expect(diffRequests).toHaveLength(2);

  await act(async () => {
    diffRequests.at(-1)!.reject(new Error("git exploded"));
  });
  expect(text()).toContain("alpha patch");
  expect(alerts().join(" ")).toContain("git exploded");
});

it("reports a failed changes load in the danger tone, with a retry", async () => {
  await show({ view: "changes" });
  await act(async () => {
    changesRequests.at(-1)!.reject(new Error("not a git repository"));
  });
  const note = container!.querySelector("[role='alert']");
  expect(note?.textContent).toContain("not a git repository");
  expect(note?.className).toContain("destructive");

  await act(async () => {
    note!.querySelector<HTMLButtonElement>("button")!.click();
  });
  expect(changesRequests).toHaveLength(2);
  await answer(changesRequests, changes(["alpha.ts"]));
  expect(alerts()).toEqual([]);
});

it("keeps a file's diff out of the next file's source pane", async () => {
  await show({ view: "files", filePath: "alpha.ts" });
  await answer(treeRequests, [
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
    { name: "beta.ts", path: "beta.ts", kind: "file" },
  ]);
  expect(text()).toContain("Loading file…");

  await answer(fileRequests, fileContent("alpha.ts", "alpha source"));
  expect(text()).toContain("alpha source");

  // R3 again, on the Files view: the source pane is keyed by path.
  await show({ view: "files", filePath: "beta.ts" });
  expect(text()).not.toContain("alpha source");
  expect(text()).toContain("Loading file…");

  await answer(fileRequests, fileContent("beta.ts", "beta source"));
  expect(text()).toContain("beta source");
});

it("offers a retry when a file cannot be read, and keeps a read one", async () => {
  await show({ view: "files", filePath: "alpha.ts", statusUpdatedAt: 1 });
  await answer(treeRequests, [
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);
  await act(async () => {
    fileRequests.at(-1)!.reject(new Error("no such file"));
  });
  expect(alerts().join(" ")).toContain("no such file");

  await act(async () => {
    container!
      .querySelector<HTMLButtonElement>("[role='alert'] button")!
      .click();
  });
  await answer(fileRequests, fileContent("alpha.ts", "alpha source"));
  expect(alerts()).toEqual([]);

  // R2: once the source is on screen, a failed refresh keeps it readable.
  await show({ view: "files", filePath: "alpha.ts", statusUpdatedAt: 2 });
  await act(async () => {
    fileRequests.at(-1)!.reject(new Error("no such file"));
  });
  expect(text()).toContain("alpha source");
  expect(alerts().join(" ")).toContain("no such file");
});

it("waits for the tree's answer before claiming a worktree has no files", async () => {
  await show({ view: "files" });
  // R1: the root directory has not answered yet, so the rail is loading — it
  // must not say "No files." about a worktree it has not read.
  expect(text()).not.toContain("No files.");
  expect(
    container!.querySelector("[role='status'][aria-label='Loading files']"),
  ).not.toBeNull();

  await answer(treeRequests, []);
  expect(text()).toContain("No files.");
});

it("reloads every expanded directory in place when ignored files are shown", async () => {
  await show({ view: "files" });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "sub", path: "sub", kind: "dir" },
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);
  await click("[title='sub']");
  await answerKey(treeRequests, "tree:wt-1:sub", [
    { name: "beta.ts", path: "sub/beta.ts", kind: "file" },
  ]);

  await click("[title='Show ignored and hidden files']");
  expect(
    treeRequests
      .slice(-2)
      .map((request) => request.key)
      .sort(),
  ).toEqual(["tree:wt-1::ignored", "tree:wt-1:sub:ignored"]);
  // Refreshing visibility does not blank the tree or strand the expanded
  // directory on its loading placeholder.
  expect(text()).toContain("alpha.ts");
  expect(text()).toContain("beta.ts");
  expect(text()).not.toContain("Loading…");

  await answerKey(treeRequests, "tree:wt-1::ignored", [
    { name: "agent-output", path: "agent-output", kind: "dir" },
    { name: "sub", path: "sub", kind: "dir" },
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);
  await answerKey(treeRequests, "tree:wt-1:sub:ignored", [
    { name: "beta.ts", path: "sub/beta.ts", kind: "file" },
    { name: "hidden.ts", path: "sub/hidden.ts", kind: "file" },
  ]);
  expect(text()).toContain("agent-output");
  expect(text()).toContain("hidden.ts");
});

it("restarts an expanded directory whose first listing is in flight", async () => {
  await show({ view: "files" });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "pending", path: "pending", kind: "dir" },
  ]);
  await click("[title='pending']");
  expect(treeRequests.at(-1)?.key).toBe("tree:wt-1:pending");

  await click("[title='Show ignored and hidden files']");
  expect(treeRequests.map((request) => request.key)).toContain(
    "tree:wt-1:pending:ignored",
  );

  // The old-mode answer is stale and must not settle the replacement request.
  await answerKey(treeRequests, "tree:wt-1:pending", [
    { name: "old.ts", path: "pending/old.ts", kind: "file" },
  ]);
  expect(text()).not.toContain("old.ts");
  await answerKey(treeRequests, "tree:wt-1:pending:ignored", [
    { name: "new.ts", path: "pending/new.ts", kind: "file" },
  ]);
  expect(text()).toContain("new.ts");
  expect(text()).not.toContain("Loading…");
});

it("refreshes the file tree in place instead of blanking the rail", async () => {
  await show({ view: "files", statusUpdatedAt: 1 });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "sub", path: "sub", kind: "dir" },
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);

  // Expand the folder. Its loaded children and expansion are state a refresh
  // must not move.
  await click("[title='sub']");
  await answerKey(treeRequests, "tree:wt-1:sub", [
    { name: "beta.ts", path: "sub/beta.ts", kind: "file" },
  ]);
  expect(text()).toContain("beta.ts");
  expect(text()).toContain("alpha.ts");

  // R2: the token bump refetches every loaded directory and swaps each in when
  // it answers. The rail keeps its rows and expanded folder, with no skeletons.
  // This used to clear the cache and blank the rail shortly after every open.
  await show({ view: "files", statusUpdatedAt: 2 });
  expect(
    treeRequests.filter((request) => request.key === "tree:wt-1:").length,
  ).toBe(2);
  expect(
    treeRequests.filter((request) => request.key === "tree:wt-1:sub").length,
  ).toBe(2);
  expect(text()).toContain("beta.ts");
  expect(
    container!.querySelector("[role='status'][aria-label='Loading files']"),
  ).toBeNull();

  await answerKey(treeRequests, "tree:wt-1:sub", [
    { name: "beta.ts", path: "sub/beta.ts", kind: "file" },
    { name: "gamma.ts", path: "sub/gamma.ts", kind: "file" },
  ]);
  expect(text()).toContain("gamma.ts");
});

it("drops a directory's children once its parent stops listing it", async () => {
  await show({ view: "files", statusUpdatedAt: 1 });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "sub", path: "sub", kind: "dir" },
  ]);
  await click("[title='sub']");
  await answerKey(treeRequests, "tree:wt-1:sub", [
    { name: "beta.ts", path: "sub/beta.ts", kind: "file" },
  ]);
  expect(text()).toContain("beta.ts");

  // The folder was deleted upstream: refreshing in place must not leave its
  // cached children hanging under a parent that no longer has it.
  await show({ view: "files", statusUpdatedAt: 2 });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);
  expect(text()).not.toContain("beta.ts");
});

it("marks a same-key diff refetch, including the one a retry starts", async () => {
  await show({ view: "changes", filePath: "alpha.ts", statusUpdatedAt: 1 });
  await answer(changesRequests, changes(["alpha.ts"]));
  await answer(diffRequests, fileDiff("alpha.ts", "alpha patch"));
  expect(text()).not.toContain("Refreshing this diff");

  // A watcher push: the diff stays and says a fetch is running (R2).
  await show({ view: "changes", filePath: "alpha.ts", statusUpdatedAt: 2 });
  expect(text()).toContain("Refreshing this diff");
  await act(async () => {
    diffRequests.at(-1)!.reject(new Error("git exploded"));
  });
  expect(text()).not.toContain("Refreshing this diff");

  // The retry is the case that had no marker at all: the note vanished and
  // nothing showed until the diff swapped.
  await click("[role='alert'] button");
  expect(text()).toContain("Refreshing this diff");
  expect(alerts()).toEqual([]);
  await answer(diffRequests, fileDiff("alpha.ts", "alpha patch v2"));
  expect(text()).toContain("alpha patch v2");
  expect(text()).not.toContain("Refreshing this diff");
});

it("marks a refetch of the Files view's vs-base pivot", async () => {
  await show({ view: "files", filePath: "alpha.ts", statusUpdatedAt: 1 });
  await answerKey(treeRequests, "tree:wt-1:", [
    { name: "alpha.ts", path: "alpha.ts", kind: "file" },
  ]);
  await answer(fileRequests, fileContent("alpha.ts", "alpha source"));

  await click("[aria-label='Changes vs base']");
  await answer(diffRequests, fileDiff("alpha.ts", "alpha base patch"));
  expect(text()).toContain("alpha base patch");
  expect(text()).not.toContain("Refreshing");

  // The pivot pane is what is on screen, so it is the request that gets marked
  // — not the file source behind it.
  await show({ view: "files", filePath: "alpha.ts", statusUpdatedAt: 2 });
  expect(text()).toContain("Refreshing this diff");
  expect(text()).not.toContain("Refreshing this file");
  expect(text()).toContain("alpha base patch");

  await answer(diffRequests, fileDiff("alpha.ts", "alpha base patch v2"));
  expect(text()).toContain("alpha base patch v2");
});
