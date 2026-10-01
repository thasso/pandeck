// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeFileViewer } from "./KnowledgeFileViewer.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";
import { clearHighlightCache } from "./ui/highlighter.ts";

/**
 * A `#L12` / `#L12-L20` link into a Knowledge text file. The file view keeps its
 * syntax-highlighted `CodeBlock` and its bounded reveal — a whole file arrives
 * in one response, so it may not turn every line into an element up front — and
 * the addressed lines still have to be rendered, marked and scrolled to,
 * including after the deferred highlight replaces the first plaintext paint.
 * The window itself is `DocumentTextBody`'s, shared by every viewer and pinned
 * in `documentTextBody.bounds.test.tsx`.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let pending: ((text: string) => void) | null = null;

vi.mock("../lib/knowledgeBaseApi.ts", () => ({
  fetchKnowledgeEntry: () => new Promise(() => {}),
  fetchKnowledgeEntryByPath: () => new Promise(() => {}),
  fetchKnowledgeFileText: () =>
    new Promise<string>((resolve) => {
      pending = resolve;
    }),
  knowledgeAssetUrl: (entryId: string, path: string) =>
    `asset:${entryId}/${path}`,
  knowledgeFileUrl: (path: string) => `file:${path}`,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let scrollIntoView =
  vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
/** `CodeBlock` defers a cache-missing highlight to idle time; the test runs it. */
let idleTasks: Array<() => void> = [];

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  scrollIntoView = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  idleTasks = [];
  vi.stubGlobal("requestIdleCallback", (task: () => void) => {
    idleTasks.push(task);
    return idleTasks.length;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
  clearHighlightCache();
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/knowledge/~file/notes/data.json");
  initHistoryNav();
  pending = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function json(lines: number): string {
  return Array.from(
    { length: lines },
    (_, index) => `{"n": ${index + 1}}`,
  ).join("\n");
}

function render(anchor?: { start: number; end?: number }): void {
  act(() =>
    root!.render(
      <KnowledgeFileViewer
        path="notes/data.json"
        {...(anchor ? { anchor } : {})}
      />,
    ),
  );
}

/** Answer the file request, leaving the highlight still deferred. */
async function answer(text: string): Promise<void> {
  await act(async () => {
    pending!(text);
    await Promise.resolve();
  });
}

/** Run the deferred syntax highlight, which replaces the plaintext shell. */
async function landHighlight(): Promise<void> {
  const tasks = idleTasks;
  idleTasks = [];
  await act(async () => {
    for (const task of tasks) task();
    await Promise.resolve();
  });
}

async function load(text: string): Promise<void> {
  await answer(text);
  await landHighlight();
}

/** The file lines carrying one of the anchor region's classes. */
function linesWithClass(name: string): number[] {
  return [...container!.querySelectorAll(`.${name}`)].map((node) =>
    Number(node.getAttribute("data-source-line-start")),
  );
}

function markedLines(): number[] {
  return [...container!.querySelectorAll("[data-source-line-start]")].flatMap(
    (node) => {
      const start = Number(node.getAttribute("data-source-line-start"));
      const end = Number(node.getAttribute("data-source-line-end") ?? start);
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    },
  );
}

it("marks and scrolls to a single addressed line only once the file arrives", async () => {
  render({ start: 3 });
  // Nothing is addressable while the request is in flight, and the anchor must
  // not scroll to the loading placeholder.
  expect(container!.querySelector("[data-source-line-start]")).toBeNull();
  expect(scrollIntoView).not.toHaveBeenCalled();

  await load(json(6));

  expect(markedLines()).toEqual([3]);
  const line = container!.querySelector('[data-source-line-start="3"]')!;
  expect(line.className).toContain("cb-anchored");
  // Both ends of the region are this one line, so it keeps its rounded box.
  expect(line.className).toContain("cb-anchored-start");
  expect(line.className).toContain("cb-anchored-end");
  expect(line.getAttribute("data-document-anchor")).toBe("true");
  expect(line.textContent).toContain('{"n": 3}');
  expect(scrollIntoView).toHaveBeenCalled();
});

it("marks every line of an inclusive range, before and after the highlight lands", async () => {
  render({ start: 2, end: 4 });
  // The first paint is the plaintext shell: it splits around the range rather
  // than giving each line its own element.
  await answer(json(6));
  expect(markedLines()).toEqual([2, 3, 4]);
  expect(container!.querySelectorAll("[data-source-line-start]")).toHaveLength(
    1,
  );

  // The highlight replaces that shell; the mark survives on Shiki's own rows.
  await landHighlight();
  expect(markedLines()).toEqual([2, 3, 4]);
  expect(container!.querySelectorAll("[data-source-line-start]")).toHaveLength(
    3,
  );
  for (const node of container!.querySelectorAll("[data-source-line-start]"))
    expect(node.className).toContain("cb-anchored");
  expect(container!.querySelector('[data-source-line-start="5"]')).toBeNull();

  // The range is one region: only its ends are rounded, so the rows between
  // them do not read as three separate boxes.
  expect(linesWithClass("cb-anchored-start")).toEqual([2]);
  expect(linesWithClass("cb-anchored-end")).toEqual([4]);
});

it("keeps the syntax-highlighted presentation of the file", async () => {
  render();
  await load(json(4));

  const block = container!.querySelector("pre.shiki")!;
  expect(block).not.toBeNull();
  // Real tokens, not just the Shiki-styled plaintext shell.
  expect(block.querySelectorAll("span.line")).toHaveLength(4);
  expect(
    [...block.querySelectorAll("span")].some((span) =>
      (span.getAttribute("style") ?? "").includes("--shiki-light"),
    ),
  ).toBe(true);
  // The gutter is CSS counters on those rows.
  expect(container!.querySelector(".cb-numbered")).not.toBeNull();
});
