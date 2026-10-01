// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiffCommentBarProvider, useDiffTextSelection } from "./comments.tsx";
import { CommentActuationProvider } from "../review/CommentActuation.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { dismissToastKey, getToasts } from "../../lib/toast.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  dismissToastKey("diff-comment-side");
  vi.restoreAllMocks();
  vi.useRealTimers();
  await act(async () => reactRoot.unmount());
  container.remove();
});

function Harness({
  onActivate = vi.fn(),
}: {
  onActivate?: (() => void) | undefined;
}) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const source = useRef<object>({}).current;
  useDiffTextSelection({
    root: surface,
    contents: "before\ntarget line\nafter",
    source,
    enabled: true,
    onActivate,
  });
  return <div data-surface ref={setSurface} />;
}

function selectionFor(
  range: Range,
  collapsed = false,
  legacySignature = false,
): Selection {
  return {
    isCollapsed: collapsed,
    rangeCount: collapsed ? 0 : 1,
    getComposedRanges: (...args: unknown[]) => {
      if (legacySignature && !(args[0] instanceof ShadowRoot))
        throw new TypeError("Expected variadic shadow roots");
      return collapsed ? [] : [range];
    },
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection;
}

function pierreLine(deletion = false): { line: HTMLElement; range: Range } {
  const surface = container.querySelector<HTMLElement>("[data-surface]")!;
  const host = document.createElement("div");
  host.className = "app-diff-host";
  const shadow = host.attachShadow({ mode: "open" });
  const side = document.createElement("div");
  side.toggleAttribute(deletion ? "data-deletions" : "data-additions", true);
  const line = document.createElement("div");
  line.dataset.line = "2";
  if (deletion) line.dataset.lineType = "change-deletion";
  line.textContent = "target line";
  side.append(line);
  shadow.append(side);
  surface.append(host);
  const range = document.createRange();
  range.setStart(line.firstChild!, 0);
  range.setEnd(line.firstChild!, 6);
  return { line, range };
}

async function evaluateSelection(selection: Selection) {
  vi.spyOn(window, "getSelection").mockReturnValue(selection);
  await act(async () => {
    document.dispatchEvent(new Event("selectionchange"));
    vi.advanceTimersByTime(151);
  });
}

async function renderHarness(onActivate?: () => void) {
  await act(async () =>
    reactRoot.render(
      <CommentActuationProvider>
        <DiffCommentBarProvider pendingCount={0} onSubmitReview={vi.fn()}>
          <Harness onActivate={onActivate} />
          <PageHeader title="Diff" />
        </DiffCommentBarProvider>
      </CommentActuationProvider>,
    ),
  );
}

it("clears a captured diff target when the native selection collapses", async () => {
  await renderHarness();
  const { range } = pierreLine();
  await evaluateSelection(selectionFor(range));
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(false);

  vi.restoreAllMocks();
  await evaluateSelection(selectionFor(range, true));
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(true);
});

it("supports Safari's legacy variadic composed-range signature", async () => {
  await renderHarness();
  const { range } = pierreLine();
  await evaluateSelection(selectionFor(range, false, true));
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(false);
});

it("activates a captured target when the real header control is pressed", async () => {
  const onActivate = vi.fn();
  await renderHarness(onActivate);
  const { range } = pierreLine();
  await evaluateSelection(selectionFor(range));
  const addComment = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Add comment"]',
  )!;
  expect(addComment.disabled).toBe(false);

  const pointerDown = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    addComment.dispatchEvent(pointerDown);
    addComment.click();
  });

  expect(pointerDown.defaultPrevented).toBe(true);
  expect(onActivate).toHaveBeenCalledOnce();
});

it("clears the target and explains a deletion-side native selection", async () => {
  await renderHarness();
  const addition = pierreLine();
  await evaluateSelection(selectionFor(addition.range));
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(false);

  vi.restoreAllMocks();
  const deletion = pierreLine(true);
  await evaluateSelection(selectionFor(deletion.range));
  expect(
    container.querySelector<HTMLButtonElement>("[data-comment-actuation]")!
      .disabled,
  ).toBe(true);
  expect(
    getToasts().some(
      (toast) =>
        toast.key === "diff-comment-side" &&
        toast.message === "Comments attach to the new side of a diff.",
    ),
  ).toBe(true);
});
