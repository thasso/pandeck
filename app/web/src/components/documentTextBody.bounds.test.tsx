// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectFileMeta, DirectFileText } from "../lib/directFiles.ts";
import { DocumentTextBody } from "./DocumentTextBody.tsx";
import { FileViewerPage } from "./FileViewerPage.tsx";
import { SessionArtifactViewer } from "./SessionArtifactViewer.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";
import { clearHighlightCache } from "./common/highlighter.ts";

/**
 * The host and artifact viewers draw the SAME bounded body as Knowledge does.
 * What this file exists for: neither a huge file without an anchor nor a huge
 * `#L…` range may put a row per line in the DOM, the numbers in the gutter stay
 * the file's own, and a reader who asked for more than is drawn is told so. The
 * whole text stays available as data — copy takes all of it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Each case mounts a viewer over a 20 000-line document: about a second on an
// idle machine, but past the 5 s default on a CI runner that is also linting
// and building. What is asserted is the drawn window, never a duration.
vi.setConfig({ testTimeout: 20_000 });

const meta: DirectFileMeta = {
  path: "/tmp/example/data.json",
  name: "data.json",
  sizeBytes: 1_000,
  modifiedMs: 0,
  disposition: "text",
  contentType: "text/plain",
};

let hostText: DirectFileText = { text: "", truncated: false };

vi.mock("../lib/directFiles.ts", () => ({
  fetchDirectFileMeta: () => Promise.resolve(meta),
  fetchDirectFileText: () => Promise.resolve(hostText),
  mintFileGrantUrl: () => new Promise(() => {}),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let scrollIntoView =
  vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
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
  window.history.replaceState(null, "", "/files/tmp/example/data.json");
  initHistoryNav();
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
  return Array.from({ length: lines }, (_, i) => `{"n": ${i + 1}}`).join("\n");
}

/** Let the fetch settle and run the idle-deferred syntax highlight. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const tasks = idleTasks;
  idleTasks = [];
  await act(async () => {
    for (const task of tasks) task();
    await Promise.resolve();
  });
}

function renderedWindow(): { first: number; rows: number } {
  const rows = container!.querySelectorAll("span.line").length;
  const numbered = container!.querySelector<HTMLElement>(".cb-numbered");
  const offset = Number(
    numbered?.style.getPropertyValue("--cb-line-start") || "0",
  );
  return { first: offset + 1, rows };
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

/** The file lines carrying one of the anchor region's classes. */
function linesWithClass(name: string): number[] {
  return [...container!.querySelectorAll(`.${name}`)].map((node) =>
    Number(node.getAttribute("data-source-line-start")),
  );
}

async function showHost(
  text: string,
  anchor?: { start: number; end?: number },
): Promise<void> {
  hostText = { text, truncated: false };
  act(() =>
    root!.render(
      <FileViewerPage
        path="/tmp/example/data.json"
        {...(anchor ? { anchor } : {})}
      />,
    ),
  );
  await settle();
}

async function showArtifact(
  text: string,
  anchor?: { start: number; end?: number },
): Promise<void> {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(text, { status: 200 })),
  );
  act(() =>
    root!.render(
      <SessionArtifactViewer
        sessionId="s1"
        path="tool-output/data.json"
        {...(anchor ? { anchor } : {})}
      />,
    ),
  );
  await settle();
}

it("bounds a large host file with no anchor at all", async () => {
  await showHost(json(20_000));
  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(container!.textContent).toContain("500 of 20000 lines");
  expect(markedLines()).toEqual([]);
  // Not one span per line of the file, which is what the old body did.
  expect(container!.querySelectorAll("span.line").length).toBeLessThan(600);
});

it("opens a host file at a far anchor and marks only the bounded range", async () => {
  await showHost(json(20_000), { start: 12_000, end: 900_000 });
  const { first, rows } = renderedWindow();
  expect(rows).toBe(500);
  expect(first).toBe(12_000);
  expect(markedLines()).toHaveLength(500);
  expect(markedLines().at(0)).toBe(12_000);
  expect(container!.textContent).toContain(
    "only lines 12000–12499 of the requested L12000–L900000 are shown",
  );
  // Real file line numbers, and the reveal is still two-directional.
  expect(container!.textContent).toContain("lines 12000–12499 of 20000");
  expect(container!.textContent).toContain("earlier lines");
});

it("shows a small host range whole, with no notice", async () => {
  await showHost(json(400), { start: 3, end: 5 });
  expect(markedLines()).toEqual([3, 4, 5]);
  expect(container!.textContent).not.toContain("are shown");
  expect(renderedWindow()).toEqual({ first: 1, rows: 400 });
});

/* One mount per case: each renders and highlights a 20,000-line body. */
it("bounds a large artifact body with no anchor", async () => {
  await showArtifact(json(20_000));
  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(markedLines()).toEqual([]);
});

it("bounds a huge artifact range and says how much it drew", async () => {
  await showArtifact(json(20_000), { start: 1, end: 500_000 });
  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(markedLines()).toHaveLength(500);
  expect(container!.textContent).toContain(
    "only lines 1–500 of the requested L1–L500000 are shown",
  );
});

it("opens an artifact at a far anchor for the same cost", async () => {
  await showArtifact(json(20_000), { start: 9_000 });
  const far = renderedWindow();
  expect(far.rows).toBe(500);
  expect(far.first).toBeGreaterThan(8_000);
  expect(markedLines()).toEqual([9_000]);
});

it("keeps the whole source as the copy value, not the window", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "isSecureContext", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  const text = json(20_000);
  await showHost(text, { start: 12_000 });

  const copy = container!.querySelector<HTMLButtonElement>(
    'button[aria-label^="Copy"]',
  );
  expect(copy).not.toBeNull();
  await act(async () => {
    copy!.click();
  });
  expect(writeText).toHaveBeenCalledWith(text);
});

it("bounds what a huge range marks in rendered Markdown, and says so", async () => {
  // Markdown is addressed by SOURCE line but rendered as blocks: paragraph i
  // starts at line 2i-1, so the bounded range covers the first 250 of them.
  const markdown = Array.from(
    { length: 600 },
    (_, index) => `paragraph ${index + 1}`,
  ).join("\n\n");
  vi.stubGlobal("fetch", () =>
    Promise.resolve(new Response(markdown, { status: 200 })),
  );
  act(() =>
    root!.render(
      <SessionArtifactViewer
        sessionId="s1"
        path="tool-output/notes.md"
        anchor={{ start: 1, end: 500_000 }}
      />,
    ),
  );
  await settle();

  expect(container!.textContent).toContain(
    "only lines 1–500 of the requested L1–L500000 are shown",
  );
  const marked = [...container!.querySelectorAll("[data-document-anchor]")].map(
    (node) => Number(node.getAttribute("data-source-line-start")),
  );
  expect(marked.length).toBeGreaterThan(0);
  expect(Math.max(...marked)).toBeLessThanOrEqual(500);
  // The document itself still renders whole — blocks, not a line window.
  expect(container!.textContent).toContain("paragraph 600");
});

/*
 * Window semantics at the edges, against the body itself: the viewers above
 * only fetch and frame it.
 */
async function showBody(
  text: string,
  anchor: { start: number; end?: number },
): Promise<void> {
  act(() =>
    root!.render(
      <DocumentTextBody text={text} name="data.json" anchor={anchor} />,
    ),
  );
  await settle();
}

it("keeps the head of the file for a near anchor", async () => {
  // The window does not slide off the top to centre line 3.
  await showBody(json(2_000), { start: 3 });
  expect(renderedWindow()).toEqual({ first: 1, rows: 500 });
  expect(markedLines()).toEqual([3]);
});

it("bounds the window even for an anchor far past any reasonable file", async () => {
  // 100k lines stands in for the 50 MB case: the cost must follow the window,
  // not the anchor's distance from the top of the file.
  await showBody(json(100_000), { start: 90_000 });
  const { first, rows } = renderedWindow();
  expect(rows).toBe(500);
  expect(first).toBeGreaterThan(89_000);
  expect(markedLines()).toEqual([90_000]);
  expect(container!.querySelectorAll("[data-source-line-start]")).toHaveLength(
    1,
  );
});

it("opens a huge range at its first line when that line is deep in the file", async () => {
  await showBody(json(100_000), { start: 90_000, end: 900_000 });
  expect(renderedWindow()).toEqual({ first: 90_000, rows: 500 });
  expect(markedLines()).toHaveLength(500);
  expect(markedLines().at(0)).toBe(90_000);
  expect(container!.textContent).toContain(
    "only lines 90000–90499 of the requested L90000–L900000 are shown",
  );
  expect(scrollIntoView).toHaveBeenCalled();
});

it("reveals more of the file, not more of the mark, past a capped range", async () => {
  await showBody(json(2_000), { start: 1, end: 500_000 });
  // The drawn part is a CLOSED region: the cap is where it ends, not an open
  // bottom edge that suggests the mark continues below the fold.
  expect(linesWithClass("cb-anchored-start")).toEqual([1]);
  expect(linesWithClass("cb-anchored-end")).toEqual([500]);

  const more = [...container!.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("500 more lines"),
  );
  act(() => more!.click());
  await settle();

  // The rehighlighted window keeps the address bounded to its 500 lines.
  expect(renderedWindow().rows).toBe(1_000);
  expect(markedLines()).toHaveLength(500);
  expect(markedLines().at(-1)).toBe(500);
  expect(linesWithClass("cb-anchored-end")).toEqual([500]);
});

it("closes the region on the last line of a range that runs past the file", async () => {
  await showBody(json(20), { start: 15, end: 500_000 });
  expect(markedLines()).toEqual([15, 16, 17, 18, 19, 20]);
  expect(linesWithClass("cb-anchored-start")).toEqual([15]);
  expect(linesWithClass("cb-anchored-end")).toEqual([20]);
});

it("says nothing about truncation when the range is longer than the file", async () => {
  // A range longer than the FILE is not a truncated range: everything the
  // address names that exists is shown.
  await showBody(json(20), { start: 1, end: 500_000 });
  expect(container!.textContent).not.toContain("are shown");
  expect(markedLines()).toEqual(
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
});
