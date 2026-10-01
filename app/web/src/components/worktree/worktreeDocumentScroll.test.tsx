// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeFileDiffResponse,
  WorktreeFileResponse,
  WorktreeRecord,
  WorktreeTreeEntry,
} from "@assistant/shared";
import type { Prefs } from "../../hooks/usePrefs.ts";
import {
  initHistoryNav,
  resetHistoryNavForTests,
} from "../../lib/historyNav.ts";
import {
  useDocumentNavigationRegistration,
  type DocumentNavigationRegistration,
} from "../DocumentNavigationShell.tsx";

/**
 * A worktree file or diff is a document, so its history entry owns the outer
 * viewer's scroll offset like every other one — but this page registers through
 * `DocumentNavigationMarker` and lays out its own panes, so the behaviour has to
 * be attached to ITS scrollers rather than inherited from a shell it never
 * mounts. Back/Forward land where the reader left, a line anchor still wins, and
 * a nested code scroller never overwrites the entry.
 */

interface Pending<T> {
  key: string;
  resolve: (value: T) => void;
}

const changesRequests: Array<Pending<WorktreeChangesResponse>> = [];
const fileRequests: Array<Pending<WorktreeFileResponse>> = [];
const diffRequests: Array<Pending<WorktreeFileDiffResponse>> = [];

function pending<T>(list: Array<Pending<T>>, key: string): Promise<T> {
  return new Promise<T>((resolve) => {
    list.push({ key, resolve });
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
  fetchWorktreeTree: () => new Promise<WorktreeTreeEntry[]>(() => {}),
  fetchWorktreeLog: () => new Promise<never>(() => {}),
  hashContent: (value: string) => `hash:${value.length}`,
  worktreeFileRawUrl: (id: string, path: string) => `raw:${id}/${path}`,
}));

vi.mock("../diff/DiffWorkerProvider.tsx", () => ({
  DiffWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useDiffWorkerCompletionVersion: () => 0,
}));

vi.mock("../diff/DiffSurface.tsx", () => ({
  DiffSurface: ({ patch }: { patch?: string }) => (
    <div>
      {patch}
      <pre data-nested-scroll />
    </div>
  ),
}));

vi.mock("../diff/FileSurface.tsx", () => ({
  FileSurface: ({ contents }: { contents: string }) => (
    <div>
      {contents}
      <pre data-nested-scroll />
    </div>
  ),
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
let registration: DocumentNavigationRegistration | null = null;

function NavigationProbe() {
  registration = useDocumentNavigationRegistration();
  return null;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  changesRequests.length = 0;
  fileRequests.length = 0;
  diffRequests.length = 0;
  registration = null;
  resetHistoryNavForTests();
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

/** Land on a worktree document entry that remembers where the reader was. */
function enterWith(href: string, scroll?: { top: number; left: number }): void {
  window.history.replaceState(
    { navIndex: 0, ...(scroll ? { documentScroll: scroll } : {}) },
    "",
    href,
  );
  initHistoryNav();
}

async function show(props: {
  view: "changes" | "files";
  filePath: string;
  anchor?: { start: number; end?: number };
}): Promise<void> {
  await act(async () => {
    root!.render(
      <>
        <NavigationProbe />
        <WorktreeDetailPage
          worktree={worktree}
          narrow={false}
          view={props.view}
          filePath={props.filePath}
          {...(props.anchor ? { anchor: props.anchor } : {})}
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
        />
      </>,
    );
  });
}

async function answer<T>(list: Array<Pending<T>>, value: T): Promise<void> {
  const request = list.at(-1);
  expect(request, "expected a pending request").toBeDefined();
  await act(async () => {
    request!.resolve(value);
  });
}

function scroller(id: string): HTMLElement {
  const element = container!.querySelector<HTMLElement>(
    `[data-document-scroll="${CSS.escape(id)}"]`,
  );
  expect(element, `expected the ${id} scroller`).not.toBeNull();
  return element!;
}

function withExtent(element: HTMLElement): HTMLElement {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 900 },
  });
  return element;
}

it("restores the diff view's scroll for its own history entry", async () => {
  enterWith("/worktrees/wt-1/changes?path=alpha.ts", { top: 240, left: 0 });
  await show({ view: "changes", filePath: "alpha.ts" });
  await answer(changesRequests, changes(["alpha.ts"]));
  const outer = withExtent(
    scroller("/worktrees/wt-1/changes?path=alpha.ts&view=diff"),
  );

  await act(async () => {
    outer.append(document.createElement("p"));
    await Promise.resolve();
  });
  expect(outer.scrollTop).toBe(240);
});

it("restores the file view's own entry and saves only its outer scroll", async () => {
  enterWith("/worktrees/wt-1/files?path=alpha.ts", { top: 180, left: 0 });
  await show({ view: "files", filePath: "alpha.ts" });
  await answer(fileRequests, fileContent("alpha.ts", "source"));
  const outer = withExtent(scroller("/worktrees/wt-1/files?path=alpha.ts"));

  await act(async () => {
    outer.append(document.createElement("p"));
    await Promise.resolve();
  });
  expect(outer.scrollTop).toBe(180);

  // A nested code scroller belongs to its own renderer: it may not overwrite
  // the entry the outer viewer owns.
  const replace = vi.spyOn(window.history, "replaceState");
  const nested = container!.querySelector<HTMLElement>("[data-nested-scroll]")!;
  nested.scrollTop = 800;
  nested.dispatchEvent(new Event("scroll", { bubbles: true }));
  expect(replace).not.toHaveBeenCalled();

  outer.scrollTop = 320;
  outer.dispatchEvent(new Event("scroll"));
  act(() => root!.unmount());
  root = createRoot(container!);
  expect(window.history.state).toMatchObject({
    documentScroll: { top: 320, left: 0 },
  });
});

it.each(["diagram.svg", "page.html"])(
  "follows the active source, preview, and diff renderer for %s zoom",
  async (path) => {
    enterWith(`/worktrees/wt-1/files?path=${path}`);
    await show({ view: "files", filePath: path });
    await answer(fileRequests, fileContent(path, "source"));
    expect(registration?.zoom?.mode).toBe("text");

    act(() => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Preview"]')!
        .click();
    });
    expect(registration?.zoom?.mode).toBe("visual");

    act(() => {
      container!
        .querySelector<HTMLButtonElement>('[aria-label="Changes vs base"]')!
        .click();
    });
    expect(registration?.zoom?.mode).toBe("text");
  },
);

it("lets a line anchor win over the saved offset", async () => {
  enterWith("/worktrees/wt-1/files?path=alpha.ts#L12", { top: 240, left: 0 });
  await show({ view: "files", filePath: "alpha.ts", anchor: { start: 12 } });
  const outer = withExtent(scroller("/worktrees/wt-1/files?path=alpha.ts#L12"));

  await act(async () => {
    outer.append(document.createElement("p"));
    await Promise.resolve();
  });
  expect(outer.scrollTop).toBe(0);
});
