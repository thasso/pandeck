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
// The Markdown preview is a lazy chunk; loading it up front lets a pivot click
// render it within the click's own act() instead of a later module load.
import "../MarkdownFile.tsx";

/**
 * Zoom follows the renderer that is on screen, through the pivots. A rendered
 * Markdown Preview is TEXT — it reflows through the same typography variables
 * the source pane uses — while an SVG or HTML preview is a picture and scales.
 * The mode also decides the bounds, so a 3× SVG preview cannot survive a switch
 * to Markdown, whose ceiling is 2×.
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
  fetchWorktreeHosting: () => new Promise<never>(() => {}),
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
    language: "markdown",
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

function Probe() {
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
  window.history.replaceState(null, "", "/worktrees/wt-1/files?path=notes.md");
  initHistoryNav();
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
  filePath: string;
  narrow?: boolean;
  browseAsDocuments?: boolean;
}): Promise<void> {
  await act(async () => {
    root!.render(
      <>
        <Probe />
        <WorktreeDetailPage
          worktree={worktree}
          narrow={props.narrow ?? false}
          browseAsDocuments={props.browseAsDocuments ?? false}
          view={props.view}
          filePath={props.filePath}
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

async function clickPivot(label: string): Promise<void> {
  const button = container!.querySelector<HTMLButtonElement>(
    `[aria-label="${label}"]`,
  );
  expect(button, `expected the ${label} pivot`).not.toBeNull();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

/** Opens a header's `…` and returns its rows. */
async function openMenu(label: string): Promise<HTMLElement[]> {
  const more = container!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(more, `expected the ${label} menu`).not.toBeNull();
  // A checkbox row keeps its menu open; pressing the trigger then would close it.
  if (!document.querySelector('[role="menu"]'))
    await act(async () => {
      more!.click();
      await Promise.resolve();
    });
  return [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
}

/** Flips the `…`'s Preview: the open file rendered, or its source. */
async function togglePreview(menu = "Worktree actions"): Promise<void> {
  const preview = (await openMenu(menu)).find(
    (item) => item.textContent === "Preview",
  );
  expect(preview, "expected the Preview toggle").toBeDefined();
  await act(async () => {
    preview!.click();
    await Promise.resolve();
  });
}

/** The zoom the open document's scroller is actually wired for. */
function scrollerMode(): string | null {
  const scroller = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  );
  return scroller?.dataset.documentZoomMode ?? null;
}

function zoom(): NonNullable<DocumentNavigationRegistration["zoom"]> {
  const current = registration?.zoom;
  expect(current, "expected a zoom registration").toBeDefined();
  return current!;
}

it("keeps Markdown in text mode across its source, Preview and Changes", async () => {
  await show({ view: "files", filePath: "notes.md" });
  await answer(fileRequests, fileContent("notes.md", "# Title\n\nBody text."));
  expect(scrollerMode()).toBe("text");
  expect(zoom().mode).toBe("text");

  // Preview renders the document, which is still text: same variables, same
  // bounds — the controls have to move type, not a transform.
  await togglePreview();
  expect(container!.textContent).toContain("Title");
  expect(scrollerMode()).toBe("text");
  expect(zoom().mode).toBe("text");

  act(() => root!.unmount());
  root = createRoot(container!);
  await show({ view: "changes", filePath: "notes.md" });
  await answer(changesRequests, changes(["notes.md"]));
  expect(scrollerMode()).toBe("text");
  expect(zoom().mode).toBe("text");
});

it("previews an SVG and an HTML document as pictures", async () => {
  await show({ view: "files", filePath: "logo.svg" });
  await answer(fileRequests, fileContent("logo.svg", "<svg />"));
  expect(scrollerMode()).toBe("text");
  await togglePreview();
  expect(scrollerMode()).toBe("visual");
  expect(zoom().mode).toBe("visual");

  act(() => root!.unmount());
  root = createRoot(container!);
  await show({ view: "files", filePath: "page.html" });
  await answer(fileRequests, fileContent("page.html", "<p>hi</p>"));
  await togglePreview();
  expect(scrollerMode()).toBe("visual");
});

it("clamps a scaled SVG preview when the same file returns to its source", async () => {
  await show({ view: "files", filePath: "logo.svg" });
  await answer(fileRequests, fileContent("logo.svg", "<svg />"));
  await togglePreview();
  await act(async () => {
    zoom().setScale(3);
  });
  // Visual allows 3×…
  expect(zoom().scale).toBe(3);
  expect(
    container!
      .querySelector<HTMLElement>("[data-document-scroll]")
      ?.style.getPropertyValue("--document-zoom"),
  ).toBe("3");

  // …text does not. The SAME document changes renderer, so the scale it
  // inherited is clamped to the text ceiling rather than left unreachable.
  await togglePreview();
  expect(zoom().mode).toBe("text");
  expect(zoom().scale).toBe(2);
  expect(
    container!
      .querySelector<HTMLElement>("[data-document-scroll]")
      ?.style.getPropertyValue("--document-zoom"),
  ).toBe("2");
});

it("moves the same text variables the source pane uses", async () => {
  await show({ view: "files", filePath: "notes.md" });
  await answer(fileRequests, fileContent("notes.md", "# Title"));
  await togglePreview();
  await act(async () => {
    zoom().setScale(1.5);
  });
  const scroller = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  )!;
  expect(scroller.dataset.documentZoomMode).toBe("text");
  expect(scroller.style.getPropertyValue("--document-zoom")).toBe("1.5");
});

it("scales an image as itself, with no Preview to turn on", async () => {
  await show({ view: "files", filePath: "shot.png" });

  // No Preview exists for an image: the file already renders the picture,
  // inside the element the visual zoom rule scales.
  expect(
    (await openMenu("Worktree actions")).map((item) => item.textContent),
  ).not.toContain("Preview");
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  const picture = container!.querySelector(".document-visual-content");
  expect(picture?.querySelector("img")?.getAttribute("src")).toBe(
    "raw:wt-1/shot.png",
  );
  expect(scrollerMode()).toBe("visual");
  expect(zoom().mode).toBe("visual");

  await act(async () => {
    zoom().setScale(2.5);
  });
  const scroller = container!.querySelector<HTMLElement>(
    "[data-document-scroll]",
  )!;
  expect(scroller.dataset.documentZoomMode).toBe("visual");
  expect(scroller.style.getPropertyValue("--document-zoom")).toBe("2.5");
  expect(scroller.contains(picture!)).toBe(true);
});

it("clamps an image's visual scale when its diff pivot takes over", async () => {
  await show({ view: "files", filePath: "shot.png" });
  await act(async () => {
    zoom().setScale(3);
  });
  expect(zoom().scale).toBe(3);

  // The same document, a pierre surface instead of the picture: text bounds.
  await clickPivot("Changes vs base");
  expect(zoom().mode).toBe("text");
  expect(zoom().scale).toBe(2);
});

it("puts a phone's document pivots behind the header's one `…`", async () => {
  await show({
    view: "files",
    filePath: "notes.md",
    narrow: true,
    browseAsDocuments: true,
  });
  await answer(fileRequests, fileContent("notes.md", "# Title\n\nBody text."));

  // One header row: no pivot toolbar under it, and no bar repeating the name.
  expect(container!.querySelector('[aria-label="File view"]')).toBeNull();
  expect(
    [...container!.querySelectorAll("span, h2")].filter(
      (node) => node.textContent === "notes.md",
    ),
  ).toHaveLength(1);
  const rows = await openMenu("Document actions");
  expect(rows.map((item) => item.textContent)).toEqual([
    "Changes vs base",
    "History",
    "Preview",
  ]);
  expect(
    rows.every((item) => item.getAttribute("aria-checked") === "false"),
  ).toBe(true);

  await act(async () => {
    rows[2]!.click();
    await Promise.resolve();
  });
  expect(container!.querySelector("h1")?.textContent).toBe("Title");
});
