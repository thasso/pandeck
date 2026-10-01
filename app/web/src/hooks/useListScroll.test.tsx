// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from "react";
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
import { useListScroll } from "./useListScroll.ts";
import { listScrollMemory } from "../lib/listScroll.ts";

/**
 * jsdom does no layout, so the list's geometry is modelled here: fixed-height
 * rows in a fixed-height viewport, with the container clamping `scrollTop` the
 * way a browser does when the content under it shrinks. That clamp is not a
 * detail — it is half of what made a section switch lose the position.
 *
 * The stubs live on the PROTOTYPE rather than on each element, because a
 * container has to measure correctly from the moment React attaches the ref:
 * the hook's layout effect is the first thing to read it. For the same reason
 * the surfaces below take the hook's ref OBJECT directly, exactly as the
 * sidebar does — a callback ref would be detached and re-attached on every
 * render, which quietly hides anything a cleanup does with the container.
 */
const ROW_HEIGHT = 40;
const VIEWPORT = 300;
/** Mirrors the hook's retry cadence; the tests only ever need a step of it. */
const RETRY_STEP = 100;

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

const scrollOffsets = new WeakMap<Element, number>();
const isList = (el: Element) => el.hasAttribute("data-list-container");
const rowsOf = (el: Element) =>
  Array.from(el.querySelectorAll("[data-list-row-id]"));
const maxOffset = (el: Element) =>
  Math.max(0, rowsOf(el).length * ROW_HEIGHT - VIEWPORT);

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
  Object.defineProperty(Element.prototype, "clientHeight", {
    configurable: true,
    get(this: Element) {
      if (isList(this)) return VIEWPORT;
      return nativeClientHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (isList(this)) return rowsOf(this).length * ROW_HEIGHT;
      return nativeScrollHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      if (!isList(this)) return nativeScrollTop?.get?.call(this) ?? 0;
      // Read through the clamp: that is what a browser does once the content
      // under a scrolled container shrinks.
      return Math.min(scrollOffsets.get(this) ?? 0, maxOffset(this));
    },
    set(this: Element, value: number) {
      if (!isList(this)) {
        nativeScrollTop?.set?.call(this, value);
        return;
      }
      scrollOffsets.set(this, Math.max(0, Math.min(value, maxOffset(this))));
    },
  });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (isList(this)) return rect(0, VIEWPORT);
    const id = this.getAttribute?.("data-list-row-id");
    const container = this.closest<HTMLElement>("[data-list-container]");
    if (id === null || !container) return rect(0, 0);
    const index = rowsOf(container).indexOf(this);
    return rect(index * ROW_HEIGHT - container.scrollTop, ROW_HEIGHT);
  };
}

function restoreGeometry() {
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

function ListSurface({
  listKey,
  rowIds,
}: {
  listKey: string | null;
  rowIds: string[];
}) {
  const containerRef = useListScroll({ listKey });
  return (
    <div data-list-container ref={containerRef}>
      <div>
        {rowIds.map((id) => (
          <div key={id} data-list-row-id={id}>
            {id}
          </div>
        ))}
      </div>
    </div>
  );
}

function rows(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, i) => `row-${i + from}`);
}

let host: HTMLDivElement;
let root: Root;

/** The app mounts under StrictMode, so the double-invoked effects are in scope. */
function render(node: ReactNode) {
  act(() => root.render(<StrictMode>{node}</StrictMode>));
}

function container(): HTMLElement {
  const el = host.querySelector<HTMLElement>("[data-list-container]");
  if (!el) throw new Error("no container rendered");
  return el;
}

/** Move the view the way a reader would: the browser scrolls, then reports it. */
function readerScrollsTo(offset: number) {
  act(() => {
    container().scrollTop = offset;
    container().dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  // React 19 only runs `act` synchronously when the environment says so; without
  // it a commit can be deferred and a test silently observes the wrong phase.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  installGeometry();
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
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

describe("useListScroll", () => {
  it("restores the reading position after the list is unmounted and comes back", () => {
    render(<ListSurface listKey="test:unmount" rowIds={rows(50)} />);
    readerScrollsTo(400);

    render(<></>);
    render(<ListSurface listKey="test:unmount" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(400);
  });

  it("keeps a position out of the memory once the reader is back at the top", () => {
    render(<ListSurface listKey="test:top" rowIds={rows(50)} />);
    readerScrollsTo(400);
    readerScrollsTo(0);

    render(<></>);
    expect(listScrollMemory().read("test:top")).toBeUndefined();
  });

  it("captures the OUTGOING list when the container is handed to another one", () => {
    // The regression this exists for: React mutates a fiber's host children
    // BEFORE it runs that fiber's layout destroy, so a cleanup here measures the
    // INCOMING list — and a shorter one clamps scrollTop to 0, which reads as
    // "the reader is at the top" and forgets a perfectly good position.
    render(<ListSurface listKey="test:long" rowIds={rows(50)} />);
    readerScrollsTo(400);

    render(<ListSurface listKey="test:short" rowIds={rows(3)} />);
    expect(container().scrollTop).toBe(0);
    expect(listScrollMemory().read("test:long")).toMatchObject({
      scrollTop: 400,
      anchor: { rowId: "row-10", offset: 0 },
    });

    // Back and away again: the second switch is the one that used to wipe the
    // memory, because the list being left now carries a restore of its own.
    render(<ListSurface listKey="test:long" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(400);
    act(() => {
      vi.advanceTimersByTime(RETRY_STEP * 3);
    }); // the restore settles
    render(<ListSurface listKey="test:short" rowIds={rows(3)} />);
    expect(listScrollMemory().read("test:long")).toMatchObject({
      scrollTop: 400,
    });

    render(<ListSurface listKey="test:long" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(400);
  });

  it("records a section switch that happens inside the debounce window", () => {
    render(<ListSurface listKey="test:quickA" rowIds={rows(50)} />);
    act(() => {
      container().scrollTop = 320;
      container().dispatchEvent(new Event("scroll"));
      // No time passes: the reader taps another section immediately.
    });
    render(<ListSurface listKey="test:quickB" rowIds={rows(50)} />);
    render(<ListSurface listKey="test:quickA" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(320);
  });

  it("anchors on the row rather than the offset when the list moved underneath", () => {
    render(<ListSurface listKey="test:anchor" rowIds={rows(50)} />);
    readerScrollsTo(400); // row-10 sits at the top edge
    render(<></>);

    // Five rows were removed above the reader while they were away, so the
    // remembered offset now points 200px past their row.
    render(<ListSurface listKey="test:anchor" rowIds={rows(45, 5)} />);
    expect(container().scrollTop).toBe(200);
  });

  it("waits for a list that arrives long after its container", () => {
    render(<ListSurface listKey="test:late" rowIds={rows(50)} />);
    readerScrollsTo(400);
    render(<></>);

    render(<ListSurface listKey="test:late" rowIds={[]} />);
    expect(container().scrollTop).toBe(0);
    // Well past the settling budget: an empty list has not started settling.
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    render(<ListSurface listKey="test:late" rowIds={rows(50)} />);
    act(() => {
      vi.advanceTimersByTime(RETRY_STEP);
    });
    expect(container().scrollTop).toBe(400);
  });

  it("gives up on a list that never arrives", () => {
    render(<ListSurface listKey="test:never" rowIds={rows(50)} />);
    readerScrollsTo(400);
    render(<></>);

    render(<ListSurface listKey="test:never" rowIds={[]} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    render(<ListSurface listKey="test:never" rowIds={rows(50)} />);
    act(() => {
      vi.advanceTimersByTime(RETRY_STEP);
    });
    // The restore expired while waiting, so a list this late opens at its top
    // rather than jumping under the reader.
    expect(container().scrollTop).toBe(0);
  });

  it("hands the position back the moment the reader scrolls", () => {
    render(<ListSurface listKey="test:cancel" rowIds={rows(50)} />);
    readerScrollsTo(400);
    render(<></>);

    render(<ListSurface listKey="test:cancel" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(400);
    readerScrollsTo(120);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container().scrollTop).toBe(120);
  });

  it("opens a list it remembers nothing about at the top", () => {
    render(<ListSurface listKey="test:sectionA" rowIds={rows(50)} />);
    readerScrollsTo(400);
    render(<ListSurface listKey="test:sectionB" rowIds={rows(50)} />);
    expect(container().scrollTop).toBe(0);
  });

  it("suspends the browser's own scroll anchoring only while restoring", () => {
    render(<ListSurface listKey="test:overflow" rowIds={rows(50)} />);
    readerScrollsTo(400);
    render(<></>);

    render(<ListSurface listKey="test:overflow" rowIds={rows(50)} />);
    expect(container().style.overflowAnchor).toBe("none");
    act(() => {
      vi.advanceTimersByTime(RETRY_STEP * 3);
    });
    expect(container().style.overflowAnchor).toBe("");
  });
});
