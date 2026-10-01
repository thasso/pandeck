// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_DOCUMENT_ANCHOR_LINES } from "@assistant/shared/documentTargets";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { anchorSelection } from "./anchorSelection.ts";
import { FileSurface } from "./FileSurface.tsx";
import { DiffSurface } from "./DiffSurface.tsx";

/**
 * The real worktree surfaces, not stand-ins: what pierre is asked to SELECT for
 * a `#L…` address, and what the reader is told when the address asked for more
 * than that. Only the worker transport is replaced — jsdom has no `Worker`, and
 * pierre's rows are built inside a custom element it never defines there — so
 * the assertions stay on the two things this app owns: the bounded selection
 * and its own chrome.
 */

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {}
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const prefs = { diffStyle: "unified", theme: "dark" } as Prefs;

const CONTENTS = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
  "\n",
);
const PATCH = [
  "@@ -1,3 +1,4 @@",
  " line 1",
  "+line 2",
  " line 3",
  " line 4",
].join("\n");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView =
    vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function show(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root!.render(node);
    await Promise.resolve();
  });
}

it("hands pierre the bounded range, whatever the address asked for", () => {
  expect(anchorSelection(undefined)).toBeNull();
  expect(anchorSelection({ start: 4, end: 9 })).toEqual({ start: 4, end: 9 });
  expect(anchorSelection({ start: 4 })).toEqual({ start: 4, end: 4 });
  expect(anchorSelection({ start: 4, end: 9 }, "additions")).toEqual({
    start: 4,
    end: 9,
    side: "additions",
  });
  // The cap is counted from the first addressed line, on both sides of the
  // diff/file split, so neither surface can answer this address differently.
  const huge = { start: 1, end: 500_000 };
  expect(anchorSelection(huge)).toEqual({
    start: 1,
    end: MAX_DOCUMENT_ANCHOR_LINES,
  });
  expect(anchorSelection(huge, "additions")).toEqual({
    start: 1,
    end: MAX_DOCUMENT_ANCHOR_LINES,
    side: "additions",
  });
});

it("marks a normal inclusive range in the file view without a notice", async () => {
  await show(
    <FileSurface
      prefs={prefs}
      name="a.ts"
      contents={CONTENTS}
      lineAnchor={{ start: 4, end: 9 }}
    />,
  );
  // Pierre slots the app's anchor marker at the first addressed line.
  expect(
    container!.querySelector(
      '[slot="annotation-4"] [data-document-line-anchor]',
    ),
  ).not.toBeNull();
  expect(container!.textContent).not.toContain("are shown");
});

it("says how much of a huge range the file view draws", async () => {
  await show(
    <FileSurface
      prefs={prefs}
      name="a.ts"
      contents={CONTENTS}
      lineAnchor={{ start: 1, end: 500_000 }}
    />,
  );
  expect(container!.textContent).toContain(
    "only lines 1–500 of the requested L1–L500000 are shown",
  );
  expect(
    container!.querySelector(
      '[slot="annotation-1"] [data-document-line-anchor]',
    ),
  ).not.toBeNull();
});

it("applies the same bound and the same sentence to the diff view", async () => {
  await show(
    <DiffSurface
      prefs={prefs}
      patch={PATCH}
      oldFile={{ name: "a.ts", contents: "line 1\nline 3\nline 4" }}
      newFile={{ name: "a.ts", contents: CONTENTS }}
      lineAnchor={{ start: 2, end: 3 }}
    />,
  );
  expect(container!.textContent).not.toContain("are shown");

  act(() => root!.unmount());
  root = createRoot(container!);
  await show(
    <DiffSurface
      prefs={prefs}
      patch={PATCH}
      oldFile={{ name: "a.ts", contents: "line 1\nline 3\nline 4" }}
      newFile={{ name: "a.ts", contents: CONTENTS }}
      lineAnchor={{ start: 9_000, end: 9_000_000 }}
    />,
  );
  expect(container!.textContent).toContain(
    "only lines 9000–9499 of the requested L9000–L9000000 are shown",
  );
});
