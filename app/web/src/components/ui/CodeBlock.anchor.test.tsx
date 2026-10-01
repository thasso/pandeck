// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeBlock } from "./CodeBlock.tsx";
import { DocumentAnchorRegion } from "../DocumentAnchorRegion.tsx";
import { clearHighlightCache } from "./highlighter.ts";

/**
 * What a `#L…` range MARKS, as opposed to what the block happens to show. The
 * address is never rewritten, so a block has to decide for itself where the
 * region ends: at `MAX_DOCUMENT_ANCHOR_LINES` from the first addressed line, or
 * at the last line of the source, whichever comes first
 * (`docs/document-presentation.md`). Getting it wrong is silent — an open bottom
 * edge, or a mark that keeps growing every time the reader reveals another
 * chunk.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** `CodeBlock` defers a cache-missing highlight to idle time; the test runs it. */
let idleTasks: Array<() => void> = [];

beforeEach(() => {
  idleTasks = [];
  vi.stubGlobal("requestIdleCallback", (task: () => void) => {
    idleTasks.push(task);
    return idleTasks.length;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
  clearHighlightCache();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const FILE = Array.from({ length: 4_000 }, (_, i) => `line ${i + 1}`).join(
  "\n",
);

/** The marked region, as the plaintext shell renders it: one span. */
function region(): { start: number; end: number; classes: string[] } | null {
  const node = container.querySelector(".cb-anchored");
  if (!node) return null;
  return {
    start: Number(node.getAttribute("data-source-line-start")),
    end: Number(node.getAttribute("data-source-line-end")),
    classes: node.className.split(/\s+/),
  };
}

function press(label: string): void {
  const control = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes(label),
  );
  act(() => control!.click());
}

it("closes the region at the anchor cap, however the reveal window is split", () => {
  act(() =>
    root.render(
      <CodeBlock
        code={FILE}
        collapsedLines={10}
        chunkLines={100}
        lineAnchor={{ start: 2_000, end: 500_000 }}
      />,
    ),
  );
  // The window holds the head of the region only, so its bottom edge stays open.
  expect(region()).toMatchObject({ start: 2_000, end: 2_009 });
  expect(region()!.classes).toContain("cb-anchored-start");
  expect(region()!.classes).not.toContain("cb-anchored-end");

  // Revealing past the cap does not extend the mark with the window: the region
  // ends at line 2499 and is closed there, in whichever chunk that lands.
  press("100 more lines");
  expect(region()).toMatchObject({ start: 2_000, end: 2_109 });
  press("Show all");
  expect(region()).toMatchObject({ start: 2_000, end: 2_499 });
  expect(region()!.classes).toContain("cb-anchored-end");
  expect(container.textContent).toContain("line 2500");
});

it("closes the region on the last line when the range runs past the source", () => {
  act(() =>
    root.render(
      <CodeBlock
        code={FILE}
        collapsedLines={4_000}
        lineAnchor={{ start: 3_990, end: 4_200 }}
      />,
    ),
  );
  expect(region()).toMatchObject({ start: 3_990, end: 4_000 });
  expect(region()!.classes).toEqual(
    expect.arrayContaining(["cb-anchored-start", "cb-anchored-end"]),
  );
});

it("keeps a single addressed line closed at both ends", () => {
  act(() =>
    root.render(
      <CodeBlock
        code={FILE}
        collapsedLines={4_000}
        lineAnchor={{ start: 7 }}
      />,
    ),
  );
  expect(region()).toMatchObject({ start: 7, end: 7 });
  expect(region()!.classes).toEqual(
    expect.arrayContaining(["cb-anchored-start", "cb-anchored-end"]),
  );
});

it("stays one band when a document anchor region wraps the block", async () => {
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const code = Array.from({ length: 6 }, (_, i) => `{"n": ${i + 1}}`).join(
    "\n",
  );
  await act(async () => {
    root.render(
      <DocumentAnchorRegion anchor={{ start: 2, end: 4 }}>
        <CodeBlock
          code={code}
          language="json"
          collapsedLines={6}
          lineAnchor={{ start: 2, end: 4 }}
        />
      </DocumentAnchorRegion>,
    );
    await Promise.resolve();
  });
  // The deferred highlight is what gives every addressed line a row of its own —
  // the shape a second marking pass would ring one by one.
  await act(async () => {
    for (const task of idleTasks.splice(0)) task();
    await Promise.resolve();
  });

  const lines = [...container.querySelectorAll<HTMLElement>(".cb-anchored")];
  expect(lines.map((node) => node.dataset.sourceLineStart)).toEqual([
    "2",
    "3",
    "4",
  ]);
  // The region scrolled to and claimed the rows, and left their look to the
  // block: a ring here would draw a box around each line of the band.
  for (const node of lines) {
    expect(node.dataset.documentAnchor).toBe("true");
    expect(node.className).not.toContain("ring-");
    expect(node.className).not.toContain("bg-accent-soft");
    expect(node.className).not.toContain("rounded-sm");
  }
  expect(container.querySelectorAll(".cb-anchored-start")).toHaveLength(1);
  expect(container.querySelectorAll(".cb-anchored-end")).toHaveLength(1);
  expect(scrollIntoView).toHaveBeenCalled();
});
