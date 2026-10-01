// @vitest-environment jsdom
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useSelectionAnchor,
  type CapturedSelection,
} from "./useSelectionAnchor.ts";

let container: HTMLDivElement;
let root: Root;
let highlightSet: ReturnType<typeof vi.fn>;
const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
const originalHighlight = Object.getOwnPropertyDescriptor(
  globalThis,
  "Highlight",
);

beforeEach(() => {
  vi.useFakeTimers();
  highlightSet = vi.fn();
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: { highlights: { set: highlightSet, delete: vi.fn() } },
  });
  Object.defineProperty(globalThis, "Highlight", {
    configurable: true,
    value: class MockHighlight {},
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.getSelection()?.removeAllRanges();
  if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
  else Reflect.deleteProperty(globalThis, "CSS");
  if (originalHighlight)
    Object.defineProperty(globalThis, "Highlight", originalHighlight);
  else Reflect.deleteProperty(globalThis, "Highlight");
  vi.useRealTimers();
});

function CommentBar({
  selection,
  pendingCount,
  onComment,
  onSubmitReview,
}: {
  selection: CapturedSelection | null;
  pendingCount: number;
  onComment: () => void;
  onSubmitReview: () => void;
}) {
  return (
    <div data-comment-bar>
      {selection ? (
        <button
          onPointerDown={(event) => event.preventDefault()}
          onClick={onComment}
        >
          Comment on “{selection.quote}”
        </button>
      ) : (
        <>
          <span>{pendingCount} comments not sent</span>
          <button onClick={onSubmitReview}>Submit review</button>
        </>
      )}
    </div>
  );
}

function Harness({
  onComment,
  onHold,
}: {
  onComment: (value: CapturedSelection) => void;
  onHold?: (hold: () => void) => void;
}) {
  const articleRef = useRef<HTMLElement | null>(null);
  const { selection, hold, release } = useSelectionAnchor(articleRef);
  useEffect(() => onHold?.(hold), [hold, onHold]);
  return (
    <>
      <article ref={articleRef}>Before selected words after.</article>
      <button type="button" data-hold onClick={hold}>
        Hold
      </button>
      <button type="button" data-release onClick={release}>
        Release
      </button>
      <CommentBar
        selection={selection}
        pendingCount={2}
        onComment={() => selection && onComment(selection)}
        onSubmitReview={() => {}}
      />
    </>
  );
}

it("uses the captured anchor after the native selection has collapsed", async () => {
  const captured = vi.fn<(value: CapturedSelection) => void>();
  await act(async () => root.render(<Harness onComment={captured} />));
  const text = container.querySelector("article")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, 7);
  range.setEnd(text, 21);
  const nativeSelection = window.getSelection()!;
  nativeSelection.addRange(range);

  document.dispatchEvent(new Event("selectionchange"));
  await act(async () => vi.advanceTimersByTime(150));
  const action = container.querySelector<HTMLButtonElement>(
    "[data-comment-bar] button",
  )!;
  expect(action.textContent).toContain("selected words");

  nativeSelection.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
  action.click();

  expect(captured).toHaveBeenCalledOnce();
  expect(captured.mock.calls[0]![0].quote).toBe("selected words");
  expect(captured.mock.calls[0]![0].bundle.position).toEqual({
    start: 7,
    end: 21,
  });
});

it("shows a selection instead of a pending review", async () => {
  await act(async () => root.render(<Harness onComment={() => {}} />));
  expect(container.textContent).toContain("2 comments not sent");

  await captureSelection(7, 15);

  expect(container.textContent).toContain("Comment on “selected”");
  expect(container.textContent).not.toContain("2 comments not sent");
});

it("clears the selection action on document Escape", async () => {
  await act(async () => root.render(<Harness onComment={() => {}} />));
  await captureSelection(7, 15);

  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );

  expect(container.textContent).not.toContain("Comment on “selected”");
  expect(container.textContent).toContain("2 comments not sent");
  expect(window.getSelection()!.isCollapsed).toBe(true);
});

it("clears the selection action on an outside pointer", async () => {
  await act(async () => root.render(<Harness onComment={() => {}} />));
  await captureSelection(7, 15);
  const outside = document.createElement("button");
  document.body.append(outside);

  await act(async () =>
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );

  expect(container.textContent).not.toContain("Comment on “selected”");
  expect(container.textContent).toContain("2 comments not sent");
  outside.remove();
});

it("keeps a captured selection for shell comment actuation", async () => {
  await act(async () => root.render(<Harness onComment={() => {}} />));
  await captureSelection(7, 15);
  const actuation = document.createElement("button");
  actuation.toggleAttribute("data-comment-actuation", true);
  document.body.append(actuation);

  await act(async () =>
    actuation.dispatchEvent(new Event("pointerdown", { bubbles: true })),
  );

  expect(container.textContent).toContain("Comment on “selected”");
  actuation.remove();
});

it("keeps hold stable while the captured selection changes", async () => {
  const onHold = vi.fn<(hold: () => void) => void>();
  await act(async () =>
    root.render(<Harness onComment={() => {}} onHold={onHold} />),
  );
  expect(onHold).toHaveBeenCalledOnce();

  await captureSelection(7, 15);
  expect(onHold).toHaveBeenCalledOnce();

  await act(async () =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
  );
  expect(onHold).toHaveBeenCalledOnce();
});

it("paints only after a composer holds the captured anchor", async () => {
  await act(async () => root.render(<Harness onComment={() => {}} />));
  await captureSelection(7, 15);
  expect(highlightSet).not.toHaveBeenCalled();
  window.getSelection()!.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));

  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-hold]")!.click(),
  );
  await act(async () => vi.advanceTimersByTime(150));
  expect(container.textContent).toContain("2 comments not sent");
  expect(highlightSet).toHaveBeenCalledOnce();
  // Painted under THIS surface's own anchor name (see the two-surface case
  // at the end of this file).
  expect(String(highlightSet.mock.calls[0]![0])).toMatch(/^comment-anchor-/);

  await act(async () =>
    container.querySelector<HTMLButtonElement>("[data-release]")!.click(),
  );
  await captureSelection(7, 15);
  expect(container.textContent).toContain("Comment on “selected”");
});

async function captureSelection(start: number, end: number): Promise<void> {
  const text = container.querySelector("article")!.firstChild!;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const nativeSelection = window.getSelection()!;
  nativeSelection.removeAllRanges();
  nativeSelection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await act(async () => vi.advanceTimersByTime(150));
}

/**
 * Two commentable surfaces can be open at once — the Knowledge route beside the
 * Knowledge side panel, a transcript beside the Personal Assistant panel — and
 * a HELD anchor outlives the selection that made it, so both can own one. Under
 * a single document-global highlight name the second `hold` replaced the first
 * surface's paint and either surface's `clear` deleted the other's.
 */
it("keeps each surface's held anchor when the other one lets go", async () => {
  const registry = new Map<string, unknown>();
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      highlights: {
        set: (name: string, value: unknown) => registry.set(name, value),
        delete: (name: string) => registry.delete(name),
      },
    },
  });

  const holds: Record<string, () => void> = {};
  const releases: Record<string, () => void> = {};
  function TwoSurfaces() {
    return (
      <>
        <Surface name="route" />
        <Surface name="panel" />
      </>
    );
  }
  function Surface({ name }: { name: string }) {
    const articleRef = useRef<HTMLElement | null>(null);
    const { hold, release } = useSelectionAnchor(articleRef);
    // Published from an effect, never during render.
    useEffect(() => {
      holds[name] = hold;
      releases[name] = release;
    }, [name, hold, release]);
    return <article ref={articleRef}>Before selected words after.</article>;
  }

  await act(async () => root.render(<TwoSurfaces />));
  const articles = container.querySelectorAll("article");

  const holdIn = async (index: number, name: string) => {
    const text = articles[index]!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 21);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    await act(async () => vi.advanceTimersByTime(150));
    await act(async () => holds[name]!());
  };

  await holdIn(0, "route");
  await holdIn(1, "panel");
  // Two anchors held at once means two registered paints, not one.
  expect(registry.size).toBe(2);

  const [routeName, panelName] = [...registry.keys()];
  await act(async () => releases.route!());
  expect([...registry.keys()]).toEqual([panelName]);
  expect(routeName).not.toBe(panelName);

  await act(async () => releases.panel!());
  expect(registry.size).toBe(0);
});
