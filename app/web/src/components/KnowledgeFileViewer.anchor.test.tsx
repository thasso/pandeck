// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KnowledgeFileViewer } from "./KnowledgeFileViewer.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";
import { clearHighlightCache } from "./ui/highlighter.ts";

// The 100k-line renders take ~2.5s on their own and have blown vitest's 5s
// default when the server and web suites share the CI container's CPU.
const HEAVY_RENDER_TIMEOUT = 20_000;

/**
 * A `#L12` / `#L12-L20` link into a Knowledge text file. The file view keeps its
 * syntax-highlighted `CodeBlock` and its bounded reveal — a whole file arrives
 * in one response, so it may not turn every line into an element up front — and
 * the addressed lines still have to be rendered, marked and scrolled to,
 * including after the deferred highlight replaces the first plaintext paint.
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

/** Press a reveal control and let the deferred highlight land on the new rows. */
async function reveal(label: string): Promise<void> {
  const control = [...container!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
  await act(async () => control!.click());
  await landHighlight();
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

/** The file lines the rendered rows cover, read off the gutter offset. */
function renderedWindow(): { first: number; rows: number } {
  const rows = container!.querySelectorAll("span.line").length;
  const numbered = container!.querySelector<HTMLElement>(".cb-numbered");
  const offset = Number(
    numbered?.style.getPropertyValue("--cb-line-start") || "0",
  );
  return { first: offset + 1, rows };
}

/*
 * One mount per case: each of these renders and highlights a 2,000-line file,
 * and four of them in one test ran into the suite's per-test budget under load.
 */
it("opens a large file on a bounded window with no anchor", async () => {
  render();
  await load(json(2_000));

  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(container!.textContent).toContain("500 of 2000 lines");
  expect(markedLines()).toEqual([]);
});

it("keeps the head of the file for a near anchor", async () => {
  // The window does not slide off the top to centre line 3.
  render({ start: 3 });
  await load(json(2_000));
  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(markedLines()).toEqual([3]);
});

it("costs the same window for a far anchor, centred on it", async () => {
  // Not one row per line before it.
  render({ start: 1_200 });
  await load(json(2_000));
  const far = renderedWindow();
  expect(far.rows).toBe(500);
  expect(far.first).toBeGreaterThan(700);
  expect(far.first).toBeLessThanOrEqual(1_200);
  expect(markedLines()).toEqual([1_200]);
  expect(container!.textContent).toContain(`lines ${far.first}–`);
  expect(container!.textContent).toContain("earlier lines");
  expect(
    container!.querySelector('[data-source-line-start="1200"]')?.textContent,
  ).toContain('{"n": 1200}');
  expect(scrollIntoView).toHaveBeenCalled();
});

it("marks an inclusive far range in full inside that bounded window", async () => {
  render({ start: 1_198, end: 1_202 });
  await load(json(2_000));
  expect(renderedWindow().rows).toBe(500);
  expect(markedLines()).toEqual([1_198, 1_199, 1_200, 1_201, 1_202]);
  for (const node of container!.querySelectorAll("[data-source-line-start]"))
    expect(node.className).toContain("cb-anchored");
});

it(
  "bounds the window even for an anchor far past any reasonable file",
  async () => {
    render({ start: 90_000 });
    // 100k lines stands in for the 50 MB case: the cost must follow the window,
    // not the anchor's distance from the top of the file.
    await load(json(100_000));

    const { first, rows } = renderedWindow();
    expect(rows).toBe(500);
    expect(first).toBeGreaterThan(89_000);
    expect(markedLines()).toEqual([90_000]);
    expect(
      container!.querySelectorAll("[data-source-line-start]"),
    ).toHaveLength(1);
  },
  HEAVY_RENDER_TIMEOUT,
);

it(
  "draws a bounded part of a range far longer than the window, and says so",
  async () => {
    // A legitimate address — the URL keeps `#L1-L500000` — but the file view may
    // not answer it with a row and a mark per addressed line.
    render({ start: 1, end: 500_000 });
    await load(json(100_000));

    expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
    expect(markedLines()).toHaveLength(500);
    expect(markedLines().at(0)).toBe(1);
    expect(markedLines().at(-1)).toBe(500);
    expect(container!.textContent).toContain(
      "only lines 1–500 of the requested L1–L500000 are shown",
    );
    // The drawn part is a CLOSED region: the cap is where it ends, not an open
    // bottom edge that suggests the mark continues below the fold.
    expect(linesWithClass("cb-anchored-start")).toEqual([1]);
    expect(linesWithClass("cb-anchored-end")).toEqual([500]);
    // The rest is still reachable, and nothing expanded it on its own.
    expect(container!.textContent).toContain("500 more lines");
    expect(container!.textContent).toContain("500 of 100000 lines");

    // Revealing the next chunk shows more of the FILE, not more of the mark: the
    // address is bounded to 500 lines wherever the reveal window ends up.
    await reveal("500 more lines");
    expect(renderedWindow().rows).toBe(1_000);
    expect(markedLines()).toHaveLength(500);
    expect(markedLines().at(-1)).toBe(500);
    expect(linesWithClass("cb-anchored-end")).toEqual([500]);
  },
  HEAVY_RENDER_TIMEOUT,
);

it("closes the region on the last line of a range that runs past the file", async () => {
  render({ start: 15, end: 500_000 });
  await load(json(20));

  expect(markedLines()).toEqual([15, 16, 17, 18, 19, 20]);
  expect(linesWithClass("cb-anchored-start")).toEqual([15]);
  expect(linesWithClass("cb-anchored-end")).toEqual([20]);
});

it(
  "opens a huge range at its first line when that line is deep in the file",
  async () => {
    render({ start: 90_000, end: 900_000 });
    await load(json(100_000));

    const { first, rows } = renderedWindow();
    expect({ first, rows }).toEqual({ first: 90_000, rows: 500 });
    expect(markedLines()).toHaveLength(500);
    expect(markedLines().at(0)).toBe(90_000);
    expect(container!.textContent).toContain(
      "only lines 90000–90499 of the requested L90000–L900000 are shown",
    );
    expect(scrollIntoView).toHaveBeenCalled();
  },
  HEAVY_RENDER_TIMEOUT,
);

it("says nothing about truncation when the range is longer than the file", async () => {
  // A range longer than the FILE is not a truncated range: everything the
  // address names that exists is shown.
  render({ start: 1, end: 500_000 });
  await load(json(20));
  expect(container!.textContent).not.toContain("are shown");
  expect(markedLines()).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});

it("says nothing about truncation for an ordinary small range", async () => {
  render({ start: 2, end: 4 });
  await load(json(2_000));
  expect(container!.textContent).not.toContain("are shown");
  expect(markedLines()).toEqual([2, 3, 4]);
});
