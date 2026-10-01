// @vitest-environment jsdom
import {
  act,
  Fragment,
  StrictMode,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { transcriptScrollMemory } from "../lib/transcriptScroll.ts";
import { useTranscriptScroll } from "./useTranscriptScroll.ts";

/**
 * jsdom does no layout, so the transcript's geometry is modelled here, and the
 * model includes the one thing these tests exist for: rows the browser has
 * never laid out contribute `--transcript-row-estimate` instead of their real
 * height, so the controller's own CSS write RESIZES them all at once. The rows
 * marked `data-skipped` read the container's published estimate on every
 * measurement, which mirrors the forced relayout a real engine performs on the
 * rect read that follows the write.
 *
 * The stubs live on the PROTOTYPE for the same reason as in
 * `useListScroll.test.tsx`: the container must measure correctly from the
 * moment React attaches the ref, because the hook's layout effect is the first
 * thing to read it.
 */
const VIEWPORT = 800;
const DEFAULT_ESTIMATE = 240;
/** Mirrors the hook's `RECORD_IDLE_MS`: a record runs this long after a scroll. */
const RECORD_IDLE_MS = 150;
/** Mirrors the hook's `READER_INPUT_MS`: how long an input owns the scrolls. */
const READER_INPUT_MS = 1200;
/** Mirrors the hook's `RESTORE_DEADLINE_MS`: how long a hold keeps correcting. */
const RESTORE_DEADLINE_MS = 2000;
/** Mirrors the hook's warm-up pacing: rows per batch, and the gap between them. */
const WARM_BATCH_ROWS = 2;
const WARM_IDLE_MS = 100;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * Two fictions of the HIT TEST alone: the rects and `totalHeight` below keep the
 * rows contiguous, and neither of these has any geometry.
 *
 * `gapAtTopEdgePx` makes a point that close to the container's top edge answer
 * with the content column instead of a row, which is what a real margin between
 * rows does (20px at a turn boundary, 12px between assistant rows).
 * `blockAtTopEdge` makes it answer with the `data-turn-end` block the surface
 * renders between two rows — the separator, the "load earlier" button and the
 * standalone Thinking indicator are all siblings of the rows, and a hit in one
 * has to resolve to the row below it.
 */
let gapAtTopEdgePx = 0;
let blockAtTopEdge = false;

const scrollOffsets = new WeakMap<Element, number>();
const isTranscript = (el: Element) =>
  el.hasAttribute("data-transcript-container");
const rowsOf = (el: Element) =>
  Array.from(el.querySelectorAll<HTMLElement>("[data-message-id]"));

function publishedEstimate(container: Element): number {
  const raw = (container as HTMLElement).style.getPropertyValue(
    "--transcript-row-estimate",
  );
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_ESTIMATE;
}

/**
 * A skipped row is worth the published estimate until something RENDERS it, and
 * from then on its real height — the browser's last remembered size, which is
 * what makes a warm-up worth doing. A skipped row with no `data-real` is one
 * whose estimate is exactly right, so the tests that predate warming see no
 * change from it.
 *
 * The remembering happens on the measurement, deliberately: a real engine
 * records the size at the end of a rendering update the row took part in, and
 * every measurement of a rendered row in these tests is taken from inside one.
 */
function rowHeight(row: HTMLElement, container: Element): number {
  if (!row.hasAttribute("data-skipped"))
    return Number(row.getAttribute("data-h") ?? "0");
  const real = row.getAttribute("data-real");
  if (real === null) return publishedEstimate(container);
  if (row.style.contentVisibility === "visible") row.dataset.remembered = "";
  return row.dataset.remembered === undefined
    ? publishedEstimate(container)
    : Number(real);
}

function totalHeight(container: Element): number {
  return rowsOf(container).reduce(
    (sum, row) => sum + rowHeight(row, container),
    0,
  );
}

const maxOffset = (el: Element) => Math.max(0, totalHeight(el) - VIEWPORT);

/**
 * Hit testing, from the same geometry. jsdom has no `elementFromPoint` at all,
 * and the controller's mid-gesture hold is built on one: the row under the
 * container's top edge, per scroll event, without walking the rows.
 */
function elementFromPointStub(y: number): Element | null {
  const container = document.querySelector("[data-transcript-container]");
  if (!container) return null;
  const content = container.firstElementChild;
  if (y < gapAtTopEdgePx) return content;
  if (blockAtTopEdge) return container.querySelector("[data-turn-end]");
  let top = -container.scrollTop;
  for (const row of rowsOf(container)) {
    const height = rowHeight(row, container);
    if (y >= top && y < top + height) return row;
    top += height;
  }
  return content;
}

const nativeRect = Element.prototype.getBoundingClientRect;
const nativeScrollTop = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollTop",
);
const nativeClientHeight = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "clientHeight",
);
const nativeScrollHeight = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollHeight",
);

function installGeometry() {
  document.elementFromPoint = (_x, y) => elementFromPointStub(y);
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      if (isTranscript(this)) return VIEWPORT;
      return nativeClientHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (isTranscript(this)) return totalHeight(this);
      return nativeScrollHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      if (!isTranscript(this)) return nativeScrollTop?.get?.call(this) ?? 0;
      // Read through the clamp, as a browser does when content shrinks.
      return Math.min(scrollOffsets.get(this) ?? 0, maxOffset(this));
    },
    set(this: Element, value: number) {
      if (!isTranscript(this)) {
        nativeScrollTop?.set?.call(this, value);
        return;
      }
      scrollOffsets.set(this, Math.max(0, Math.min(value, maxOffset(this))));
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isTranscript(this)) return rect(0, VIEWPORT);
    if (!(this instanceof HTMLElement) || !this.hasAttribute("data-message-id"))
      return rect(0, 0);
    const container = this.closest<HTMLElement>("[data-transcript-container]");
    if (!container) return rect(0, 0);
    let top = -container.scrollTop;
    for (const row of rowsOf(container)) {
      const height = rowHeight(row, container);
      if (row === this) return rect(top, height);
      top += height;
    }
    return rect(0, 0);
  };
}

function restoreGeometry() {
  // Back to jsdom's own absence of hit testing, which is not a deletable
  // property on its prototype but an assignment this file made.
  Reflect.deleteProperty(document, "elementFromPoint");
  if (nativeClientHeight)
    Object.defineProperty(
      Element.prototype,
      "clientHeight",
      nativeClientHeight,
    );
  if (nativeScrollHeight)
    Object.defineProperty(
      Element.prototype,
      "scrollHeight",
      nativeScrollHeight,
    );
  if (nativeScrollTop)
    Object.defineProperty(Element.prototype, "scrollTop", nativeScrollTop);
  Element.prototype.getBoundingClientRect = nativeRect;
}

interface RowSpec {
  id: string;
  /** Real, laid-out height — or `null` for a skipped row on the estimate. */
  h: number | null;
  /** What a skipped row measures once something renders it. */
  real?: number;
}

function TranscriptSurface({
  sessionId,
  layout,
  separatorAfter,
  onRequireRows = () => {},
  onRegisterViewHold,
  tailKey,
  restoreReady,
}: {
  sessionId: string;
  layout: RowSpec[];
  /** Render a turn-end block after this row, as `MessageList.tsx` does. */
  separatorAfter?: string;
  onRequireRows?: (count: number) => void;
  /** Takes the controller's view-change hold, as `MessageList.tsx` does. */
  onRegisterViewHold?: (hold: (() => void) | null) => void;
  tailKey?: string;
  restoreReady?: boolean;
}) {
  const {
    containerRef,
    contentRef,
    syncAfterRender,
    holdViewChange,
    commitViewChange,
  } = useTranscriptScroll({
    sessionId,
    onRequireRows,
    ...(tailKey === undefined ? {} : { tailKey }),
    ...(restoreReady === undefined ? {} : { restoreReady }),
  });
  // What `MessageList.tsx` runs after a committed render, including how it tells
  // the commit that carries a display change from every other one.
  const committed = useRef(layout);
  useLayoutEffect(() => {
    if (committed.current !== layout) {
      committed.current = layout;
      commitViewChange();
      return;
    }
    syncAfterRender();
  }, [layout, syncAfterRender, commitViewChange]);
  useLayoutEffect(() => {
    onRegisterViewHold?.(holdViewChange);
    return () => onRegisterViewHold?.(null);
  }, [holdViewChange, onRegisterViewHold]);
  return (
    <div data-transcript-container ref={containerRef}>
      <div ref={contentRef}>
        {layout.map((row) => (
          <Fragment key={row.id}>
            <div
              data-message-id={row.id}
              {...(row.h === null
                ? {
                    "data-skipped": "",
                    ...(row.real === undefined
                      ? {}
                      : { "data-real": String(row.real) }),
                  }
                : { "data-h": String(row.h) })}
            />
            {separatorAfter === row.id ? <div data-turn-end /> : null}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function skippedRows(count: number, real?: number): RowSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `skipped-${i}`,
    h: null,
    ...(real === undefined ? {} : { real }),
  }));
}

function realRows(count: number, height: number, prefix: string): RowSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    h: height,
  }));
}

let host: HTMLDivElement;
let root: Root;
const resizeCallbacks: ResizeObserverCallback[] = [];

/** The app mounts under StrictMode, so the double-invoked effects are in scope. */
function render(node: ReactNode) {
  act(() => root.render(<StrictMode>{node}</StrictMode>));
}

function container(): HTMLElement {
  const el = host.querySelector<HTMLElement>("[data-transcript-container]");
  if (!el) throw new Error("no container rendered");
  return el;
}

/**
 * A transcript whose SHAPE a menu can change, in the order the app produces:
 * `toggle()` is the click that flips the preference — the hold runs there, from
 * the layout still on screen — and the render that reshapes the rows follows it.
 * `rerender` alone is that render WITHOUT the click, which is what any
 * render-phase capture would have to be doing instead.
 */
function renderToggle(layout: RowSpec[], sessionId: string) {
  let hold: (() => void) | null = null;
  const requiredRows: number[] = [];
  const surface = (rows: RowSpec[]) => (
    <TranscriptSurface
      sessionId={`test:${sessionId}`}
      layout={rows}
      onRequireRows={(count) => requiredRows.push(count)}
      onRegisterViewHold={(next) => {
        hold = next;
      }}
    />
  );
  render(surface(layout));
  const rerender = (nextLayout: RowSpec[]) => render(surface(nextLayout));
  // The click that flips the preference, on its own: React renders the change
  // whenever it gets to it, which is not necessarily soon.
  const click = () =>
    act(() => {
      if (!hold) throw new Error("no view hold registered");
      hold();
    });
  return {
    rerender,
    requiredRows,
    click,
    toggle: (nextLayout: RowSpec[]) => {
      click();
      rerender(nextLayout);
    },
  };
}

/** The row the container's top edge falls in, by the same rule the hook uses. */
function rowIdAtTopEdge(): string {
  const hit = document
    .elementFromPoint(0, 1)
    ?.closest<HTMLElement>("[data-message-id]");
  const id = hit?.dataset.messageId;
  if (!id) throw new Error("no row at the top edge");
  return id;
}

/**
 * A fling's tail: scroll events with no further input behind them, which iOS
 * keeps producing for a second or more after the finger leaves the glass.
 * Returns where it ended.
 */
function flingTail(from: number, steps: number): number {
  let top = from;
  for (let step = 0; step < steps; step += 1) {
    top -= 100;
    act(() => {
      vi.advanceTimersByTime(100);
      container().scrollTop = top;
      container().dispatchEvent(new Event("scroll"));
    });
  }
  return top;
}

function offsetOf(rowId: string): number {
  const row = rowsOf(container()).find((el) => el.dataset.messageId === rowId);
  if (!row) throw new Error(`row ${rowId} not rendered`);
  return row.getBoundingClientRect().top;
}

/** Scroll the way a reader does: input first, then the scroll it produces. */
function readerScrollsTo(offset: number) {
  act(() => {
    container().dispatchEvent(new Event("wheel"));
    container().scrollTop = offset;
    container().dispatchEvent(new Event("scroll"));
  });
}

/** Let the reading pause elapse, which runs `record()` and any publish. */
function pauseSettles() {
  act(() => {
    vi.advanceTimersByTime(RECORD_IDLE_MS + 10);
  });
}

/**
 * A row above the reader entering view for the first time: the browser replaces
 * its `contain-intrinsic-size` estimate with its real height, which moves
 * everything below it — the shift WebKit has no `overflow-anchor` to absorb.
 */
function skippedRowResolves(rowId: string, height: number) {
  const row = rowsOf(container()).find((el) => el.dataset.messageId === rowId);
  if (!row) throw new Error(`row ${rowId} not rendered`);
  act(() => {
    row.removeAttribute("data-skipped");
    row.setAttribute("data-h", String(height));
  });
  fireResize();
}

function fireResize() {
  act(() => {
    for (const cb of resizeCallbacks)
      cb([], undefined as unknown as ResizeObserver);
  });
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  gapAtTopEdgePx = 0;
  blockAtTopEdge = false;
  installGeometry();
  resizeCallbacks.length = 0;
  class CapturingResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", CapturingResizeObserver);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(restoreGeometry);

describe("useTranscriptScroll row-estimate publish", () => {
  it("keeps the anchor row at its offset when a publish inflates the skipped rows", () => {
    // 50 skipped rows on the 240px estimate, then a run of 600px prose rows.
    render(
      <TranscriptSurface
        sessionId="test:publish-grow"
        layout={[...skippedRows(50), ...realRows(6, 600, "prose")]}
      />,
    );

    // The reader stops with the first prose row 200px above the top edge:
    // 50 × 240px of estimate fiction sits above them.
    readerScrollsTo(50 * 240 + 200);
    expect(offsetOf("prose-0")).toBe(-200);

    // The pause runs record(): the 600px rows on screen move the estimate to
    // 240×0.6 + 600×0.4 = 384px and the write resizes all 50 skipped rows —
    // +7,200px of content above the reader.
    pauseSettles();
    expect(
      container().style.getPropertyValue("--transcript-row-estimate"),
    ).toBe("384px");
    // The controller corrected its own shift: same row, same offset.
    expect(offsetOf("prose-0")).toBe(-200);
    expect(container().scrollTop).toBe(50 * 384 + 200);
  });

  it("keeps the anchor row at its offset when a publish shrinks the skipped rows", () => {
    // The estimate also moves DOWN — a screenful of short tool rows drags it
    // under the published value, and the skipped rows above all shrink.
    render(
      <TranscriptSurface
        sessionId="test:publish-shrink"
        layout={[...skippedRows(50), ...realRows(20, 100, "tool")]}
      />,
    );

    readerScrollsTo(50 * 240 + 50);
    expect(offsetOf("tool-0")).toBe(-50);

    // Sample 100px → estimate 240×0.6 + 100×0.4 = 184px: −2,800px above.
    pauseSettles();
    expect(
      container().style.getPropertyValue("--transcript-row-estimate"),
    ).toBe("184px");
    expect(offsetOf("tool-0")).toBe(-50);
    expect(container().scrollTop).toBe(50 * 184 + 50);
  });

  it("treats the correction as its own scroll: the sticky hold survives it", () => {
    render(
      <TranscriptSurface
        sessionId="test:publish-ours"
        layout={[...skippedRows(50), ...realRows(6, 600, "prose")]}
      />,
    );
    readerScrollsTo(50 * 240 + 200);
    pauseSettles();
    expect(offsetOf("prose-0")).toBe(-200);

    // The browser reports the correction back as a scroll event. If the
    // controller misread it as the reader's, the sticky row would be gone and
    // the next layout shift would move the reader.
    act(() => {
      container().dispatchEvent(new Event("scroll"));
    });

    // Past the reader-input window, a skipped row above resolves to its real
    // height (+500px) — the free-mode sticky hold must absorb it.
    act(() => {
      vi.advanceTimersByTime(READER_INPUT_MS + 100);
    });
    const resolving = rowsOf(container()).find(
      (el) => el.dataset.messageId === "skipped-10",
    )!;
    act(() => {
      resolving.removeAttribute("data-skipped");
      resolving.setAttribute("data-h", "884");
    });
    fireResize();
    expect(offsetOf("prose-0")).toBe(-200);
  });
});

/**
 * WebKit has no `overflow-anchor` (unsupported in every iOS browser as of Safari
 * 26.2), so mid-gesture nothing but this controller holds the content still while
 * the rows above the reader resolve their estimates under their finger.
 */
describe("useTranscriptScroll mid-gesture hold", () => {
  const midTranscript = () => [
    ...skippedRows(50),
    ...realRows(6, 600, "prose"),
  ];

  it("puts the reader's row back when a row above resolves mid-gesture", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-hold"
        layout={midTranscript()}
      />,
    );

    // Scrolling up, still inside the reader-input window: no pause, no record.
    readerScrollsTo(50 * 240 + 200);
    expect(offsetOf("prose-0")).toBe(-200);

    // A skipped row above resolves 1,000px taller than its estimate.
    skippedRowResolves("skipped-10", 1240);

    expect(offsetOf("prose-0")).toBe(-200);
    expect(container().scrollTop).toBe(50 * 240 + 200 + 1000);
  });

  it("leaves a drift under the threshold to the reader's momentum", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-small"
        layout={midTranscript()}
      />,
    );
    readerScrollsTo(50 * 240 + 200);

    // 40px is under `GESTURE_DRIFT_PX`: correcting it would cost the fling a
    // `scrollTop` write stops on iOS, and buy back a fraction of a screen.
    skippedRowResolves("skipped-10", 280);

    expect(container().scrollTop).toBe(50 * 240 + 200);
    expect(offsetOf("prose-0")).toBe(-160);
  });

  it("keeps tracking a fling that outlives the reader-input window", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-fling"
        layout={midTranscript()}
      />,
    );
    readerScrollsTo(50 * 240 + 200);

    const top = flingTail(50 * 240 + 200, 20);

    // Nothing resized, so there is nothing to correct — whatever distance the
    // fling covered after the input window closed. Writing it back would throw
    // the reader down the transcript AND stop the fling on iOS.
    fireResize();
    expect(container().scrollTop).toBe(top);
  });

  it("still holds a row resolving late in a long fling", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-fling-hold"
        layout={midTranscript()}
      />,
    );
    readerScrollsTo(50 * 240 + 200);

    // 2s of tail, then a row above resolves 1,000px taller: the hold is the
    // reader's for the whole fling, not for the first 1.2s of it.
    const top = flingTail(50 * 240 + 200, 20);
    const row = rowIdAtTopEdge();
    const offset = offsetOf(row);

    skippedRowResolves("skipped-10", 1240);

    expect(offsetOf(row)).toBe(offset);
    expect(container().scrollTop).toBe(top + 1000);
  });

  it("holds the row the reader is on NOW, not the stop they left", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-fresh"
        layout={midTranscript()}
      />,
    );

    // A stop, which records prose-0 as the reading position and publishes the
    // 384px estimate the 600px rows on screen sample.
    readerScrollsTo(50 * 240 + 200);
    pauseSettles();
    expect(container().scrollTop).toBe(50 * 384 + 200);

    // The reader keeps going: 600px further up, where a skipped row is at the
    // top edge (row 48 of 50 × 384px).
    readerScrollsTo(50 * 384 + 200 - 600);
    expect(offsetOf("skipped-48")).toBe(-368);

    skippedRowResolves("skipped-10", 1384);

    // Their current row, not prose-0 — putting the recorded stop back would undo
    // the 600px they just scrolled.
    expect(offsetOf("skipped-48")).toBe(-368);
    expect(container().scrollTop).toBe(50 * 384 + 200 - 600 + 1000);
  });

  it("resolves a hit on a turn-end block to the row below it", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-block"
        layout={midTranscript()}
        separatorAfter="skipped-49"
      />,
    );
    // The top edge crosses the turn-end block between skipped-49 and prose-0,
    // which carries no message id. Dropping the row for those frames would leave
    // the hold off at turn boundaries, which recur constantly.
    blockAtTopEdge = true;
    readerScrollsTo(50 * 240 + 200);

    skippedRowResolves("skipped-10", 1240);

    expect(offsetOf("prose-0")).toBe(-200);
  });

  it("finds the row when the top edge sits in the margin between rows", () => {
    render(
      <TranscriptSurface
        sessionId="test:gesture-gap"
        layout={midTranscript()}
      />,
    );
    // The 20px margin rows are spaced with: the first probe hits the content
    // column, which is no row, and only the second one lands in prose-0.
    gapAtTopEdgePx = 20;
    readerScrollsTo(50 * 240 + 200);

    skippedRowResolves("skipped-10", 1240);

    expect(offsetOf("prose-0")).toBe(-200);
  });
});

/**
 * A display preference reshapes the whole transcript at once, and no input of
 * the reader's says so: the menu is portaled out of the container, and by the
 * time an effect could look, the rows have already grown, moved or gone. So the
 * hold is taken in the EVENT that flips the flag, and these tests are ordered
 * the way the app is — `toggle()` is click-then-render, `rerender()` alone is
 * the render with no click behind it.
 */
describe("useTranscriptScroll view toggle", () => {
  // The same conversation with tool calls shown and hidden: four rows only the
  // first has at all, and every row taller for the blocks inside it.
  const withTools = [
    ...realRows(10, 600, "before"),
    ...realRows(4, 600, "tool"),
    ...realRows(10, 600, "after"),
  ];
  const withoutTools = [
    ...realRows(10, 300, "before"),
    ...realRows(10, 300, "after"),
  ];

  it("holds the reader's row when the rows above it shrink", () => {
    const { toggle, requiredRows } = renderToggle(withTools, "toggle-shrink");
    // The reader stops with `after-0` 100px above the top edge: 14 × 600px of
    // rows they are not looking at sit above it.
    readerScrollsTo(14 * 600 + 100);
    pauseSettles();
    expect(offsetOf("after-0")).toBe(-100);

    // "Show tool calls" off: four rows gone, the rest half their height —
    // 5,400px out from above the reader.
    toggle(withoutTools);

    expect(offsetOf("after-0")).toBe(-100);
    expect(container().scrollTop).toBe(10 * 300 + 100);
    // The click asked the window for the rows its hold needs; the render alone
    // never does (see "takes nothing from a render that was not asked for").
    expect(requiredRows.length).toBeGreaterThan(0);
  });

  it("holds the reader's row when the rows above it grow", () => {
    const { toggle } = renderToggle(withoutTools, "toggle-grow");
    readerScrollsTo(10 * 300 + 100);
    pauseSettles();
    expect(offsetOf("after-0")).toBe(-100);

    toggle(withTools);

    expect(offsetOf("after-0")).toBe(-100);
    expect(container().scrollTop).toBe(14 * 600 + 100);
  });

  it("falls back to the next row on screen when the reader's row goes away", () => {
    // The reader is ON a tool row — the toggle takes the very row the hold was
    // captured from out of the transcript, and the first one still there below
    // it is the answer.
    const { toggle } = renderToggle(withTools, "toggle-gone");
    readerScrollsTo(10 * 600 + 300);
    pauseSettles();
    expect(offsetOf("tool-0")).toBe(-300);
    expect(offsetOf("after-0")).toBe(4 * 600 - 300);

    toggle(withoutTools);

    expect(offsetOf("after-0")).toBe(4 * 600 - 300);
  });

  it("keeps following the end when the reader is at the bottom", () => {
    const { toggle } = renderToggle(withoutTools, "toggle-bottom");
    // Opened at the end and never scrolled away: the END is the reading
    // position, and a hold on a row would leave the transcript in `free` — a
    // running turn would stop being followed because someone opened the menu.
    expect(container().scrollTop).toBe(20 * 300 - VIEWPORT);

    toggle(withTools);

    expect(container().scrollTop).toBe(24 * 600 - VIEWPORT);
  });

  it("still holds a change React took its time rendering", () => {
    // `updateTranscriptView` schedules the flip as a TRANSITION, which React may
    // defer or restart for as long as urgent work keeps arriving — a streaming
    // turn is enough. The hold therefore cannot be timed from the click: its
    // deadline belongs to the commit that reshapes the rows, or it settles
    // before there is anything to hold and the reader is dropped.
    const { click, rerender } = renderToggle(withTools, "toggle-slow");
    readerScrollsTo(10 * 600 + 300);
    pauseSettles();
    expect(offsetOf("tool-0")).toBe(-300);

    click();
    act(() => {
      vi.advanceTimersByTime(RESTORE_DEADLINE_MS + 500);
    });
    rerender(withoutTools);

    // The reader was on a tool row, so this is the case the fallbacks exist for:
    // an expired hold would have taken them with it.
    expect(offsetOf("after-0")).toBe(4 * 600 - 300);
  });

  it("takes nothing from a render that was not asked for", () => {
    // The same reshaped render with NO click behind it: the rows change under
    // the reader and the controller does nothing about it. Nothing may capture
    // a position from a render — React may render work it then abandons, and a
    // capture there would arm a hold, widen the window and take the mode for a
    // preference that was never committed.
    const { rerender, requiredRows } = renderToggle(withTools, "toggle-render");
    readerScrollsTo(14 * 600 + 100);
    pauseSettles();
    const asked = requiredRows.length;

    rerender(withoutTools);

    // A restore always asks for the rows it needs, so an unchanged count is a
    // hold that was never armed; only the browser's own clamp moved the view.
    expect(requiredRows.length).toBe(asked);
    expect(container().scrollTop).toBe(20 * 300 - VIEWPORT);
  });

  it("leaves the view alone when nothing about the transcript changed", () => {
    const { rerender } = renderToggle(withTools, "toggle-same");
    readerScrollsTo(14 * 600 + 100);
    pauseSettles();

    // A re-render with the same rows is not a toggle: nothing to hold, nothing
    // to correct, and the reader still owns the position (`free`).
    rerender(withTools);

    expect(offsetOf("after-0")).toBe(-100);
    expect(container().scrollTop).toBe(14 * 600 + 100);
  });
});

describe("useTranscriptScroll persisted restoration", () => {
  const layout = realRows(20, 100, "row");
  const remember = (sessionId: string, tailKey?: string) => {
    const memory = transcriptScrollMemory();
    memory.save(sessionId, {
      atBottom: false,
      anchor: { messageId: "row-5", offset: 0, rowsFromEnd: 15 },
      ...(tailKey ? { tailKey } : {}),
    });
    expect(memory.read(sessionId)).toEqual({
      atBottom: false,
      anchor: { messageId: "row-5", offset: 0, rowsFromEnd: 15 },
      ...(tailKey ? { tailKey } : {}),
    });
  };

  it("does not replay a reading position after the transcript tail changed", () => {
    remember("test:tail-changed", "old-1\0old-2");
    render(
      <TranscriptSurface
        sessionId="test:tail-changed"
        tailKey={"new-1\0new-2"}
        layout={layout}
      />,
    );

    expect(container().scrollTop).toBe(20 * 100 - VIEWPORT);
  });

  it("restores a reading position when the transcript tail still matches", () => {
    remember("test:tail-same", "tail-1\0tail-2");
    render(
      <TranscriptSurface
        sessionId="test:tail-same"
        tailKey={"tail-1\0tail-2"}
        layout={layout}
      />,
    );

    expect(container().scrollTop).toBe(5 * 100);
  });

  it("keeps a reading position current when turns finish below it", () => {
    const sessionId = "test:tail-refresh";
    const surface = (tailKey: string, rows = layout) => (
      <TranscriptSurface
        sessionId={sessionId}
        tailKey={tailKey}
        layout={rows}
      />
    );
    render(surface("old-user\0old-assistant"));
    readerScrollsTo(5 * 100);
    pauseSettles();
    expect(transcriptScrollMemory().read(sessionId)?.tailKey).toBe(
      "old-user\0old-assistant",
    );

    // A turn starts and settles below the reader without another scroll stop.
    // Each committed tail is stamped onto the still-valid visible anchor.
    render(surface("new-user\0live", realRows(21, 100, "row")));
    expect(transcriptScrollMemory().read(sessionId)?.tailKey).toBe(
      "new-user\0live",
    );
    render(surface("new-user\0new-assistant", realRows(22, 100, "row")));
    expect(transcriptScrollMemory().read(sessionId)?.tailKey).toBe(
      "new-user\0new-assistant",
    );

    // Closing after the turn and reopening still restores the reading position.
    render(null);
    render(surface("new-user\0new-assistant", realRows(22, 100, "row")));
    expect(container().scrollTop).toBe(5 * 100);
  });

  it("waits for an authoritative transcript instead of restoring a preview", () => {
    remember("test:preview-wait", "tail-1\0tail-2");
    const surface = (restoreReady: boolean) => (
      <TranscriptSurface
        sessionId="test:preview-wait"
        tailKey={"tail-1\0tail-2"}
        restoreReady={restoreReady}
        layout={layout}
      />
    );
    render(surface(false));
    expect(container().scrollTop).toBe(20 * 100 - VIEWPORT);

    render(surface(true));
    expect(container().scrollTop).toBe(5 * 100);
  });

  it("does not restore over a position the reader took in the preview", () => {
    remember("test:preview-reader", "tail-1\0tail-2");
    const surface = (restoreReady: boolean) => (
      <TranscriptSurface
        sessionId="test:preview-reader"
        tailKey={"tail-1\0tail-2"}
        restoreReady={restoreReady}
        layout={layout}
      />
    );
    render(surface(false));
    readerScrollsTo(900);

    render(surface(true));
    expect(container().scrollTop).toBe(900);
  });
});

/**
 * A row the browser has never laid out is worth one estimate for the whole
 * transcript, and corrects itself by thousands of px the moment the reader
 * scrolls into it. Rendering it while they are STOPPED moves that correction off
 * the scroll path, where it is priced at `GESTURE_DRIFT_PX` and costs the fling
 * it interrupts.
 */
describe("useTranscriptScroll warm-up", () => {
  /** 20 rows the estimate says are 240px and the layout says are 900px. */
  const coldTranscript = () => [
    ...skippedRows(20, 900),
    ...realRows(4, 600, "prose"),
  ];
  const stillOnEstimate = () =>
    rowsOf(container()).filter(
      (row) =>
        row.hasAttribute("data-skipped") &&
        row.dataset.remembered === undefined,
    ).length;
  /** Rows a batch has flipped and not handed back: the cost being bounded. */
  const renderedRows = () =>
    rowsOf(container()).filter(
      (row) => row.style.contentVisibility === "visible",
    ).length;

  it("renders the skipped rows once the reader stops, without moving them", () => {
    render(
      <TranscriptSurface sessionId="test:warm" layout={coldTranscript()} />,
    );
    readerScrollsTo(20 * 240 + 200);
    expect(offsetOf("prose-0")).toBe(-200);
    expect(stillOnEstimate()).toBe(20);

    // Batches run while the reader is stopped, past the window in which their
    // input still owns the scrolls.
    act(() => {
      vi.advanceTimersByTime(READER_INPUT_MS + 2000);
    });

    expect(stillOnEstimate()).toBe(0);
    // 20 rows × (900 − 240) of fiction taken out from above the reader, and the
    // row they are on has not moved a pixel.
    expect(offsetOf("prose-0")).toBe(-200);
    expect(container().scrollTop).toBe(20 * 900 + 200);
  });

  it("waits while the reader is scrolling", () => {
    render(
      <TranscriptSurface
        sessionId="test:warm-gesture"
        layout={coldTranscript()}
      />,
    );
    readerScrollsTo(20 * 240 + 200);

    // Inside the reader-input window a batch would relayout rows above them for
    // a frame, at the moment a correction is least affordable.
    act(() => {
      vi.advanceTimersByTime(RECORD_IDLE_MS + 200);
    });
    expect(stillOnEstimate()).toBe(20);

    act(() => {
      vi.advanceTimersByTime(READER_INPUT_MS + 2000);
    });
    expect(stillOnEstimate()).toBe(0);
    expect(offsetOf("prose-0")).toBe(-200);
  });

  it("keeps one batch rendered while frames are held back", () => {
    // Timers and frames come apart: a background tab keeps firing throttled
    // timers with no frame to hand a batch back, and so does a long task in the
    // foreground. A batch per timer would leave the whole window rendered at
    // once — the hitch this feature exists to avoid, paid on the way back.
    const heldFrames: FrameRequestCallback[] = [];
    const realRequestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      heldFrames.push(callback)) as typeof window.requestAnimationFrame;
    try {
      render(
        <TranscriptSurface
          sessionId="test:warm-frames"
          layout={coldTranscript()}
        />,
      );
      readerScrollsTo(20 * 240 + 200);

      act(() => {
        vi.advanceTimersByTime(READER_INPUT_MS + 5000);
      });
      expect(renderedRows()).toBe(WARM_BATCH_ROWS);

      // Frames resume: the batch is handed back and the next one follows it.
      act(() => {
        while (heldFrames.length) heldFrames.shift()?.(0);
      });
      expect(renderedRows()).toBe(0);
      // Timers and frames alternating, the way a browser runs them: the warm-up
      // gets through the window a batch at a time, never more than one at once.
      act(() => {
        for (let cycle = 0; cycle < 20; cycle += 1) {
          vi.advanceTimersByTime(WARM_IDLE_MS + 10);
          expect(renderedRows()).toBeLessThanOrEqual(WARM_BATCH_ROWS);
          while (heldFrames.length) heldFrames.shift()?.(0);
        }
      });
      expect(renderedRows()).toBe(0);
      expect(stillOnEstimate()).toBe(0);
    } finally {
      window.requestAnimationFrame = realRequestFrame;
    }
  });

  it("hands a batch back when the transcript is replaced under it", () => {
    const heldFrames: FrameRequestCallback[] = [];
    const realRequestFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      heldFrames.push(callback)) as typeof window.requestAnimationFrame;
    const layout = coldTranscript();
    try {
      render(
        <TranscriptSurface sessionId="test:warm-teardown" layout={layout} />,
      );
      readerScrollsTo(20 * 240 + 200);
      act(() => {
        vi.advanceTimersByTime(READER_INPUT_MS + 500);
      });
      expect(renderedRows()).toBe(WARM_BATCH_ROWS);

      // Another session arrives while a batch is still rendered: its frame is
      // cancelled, so nothing may be left carrying an inline
      // `content-visibility` that only that frame would have removed — and no
      // stale callback may correct THIS transcript against the last one's row.
      render(
        <TranscriptSurface
          sessionId="test:warm-teardown-next"
          layout={layout}
        />,
      );
      expect(renderedRows()).toBe(0);
      act(() => {
        while (heldFrames.length) heldFrames.shift()?.(0);
      });
      expect(renderedRows()).toBe(0);
    } finally {
      window.requestAnimationFrame = realRequestFrame;
    }
  });
});
