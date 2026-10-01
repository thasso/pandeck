// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell, type ShellPanel } from "./AppShell.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom answers every media query `false`; reduced motion is the one that matters. */
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

/**
 * jsdom ships no `PointerEvent`, and React reads the fields off the native
 * event — so a plain bubbling Event carrying them is what the shell sees.
 */
function pointer(
  type: string,
  init: { x: number; y: number; pointerType?: string },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: init.pointerType ?? "touch",
    clientX: init.x,
    clientY: init.y,
  });
  // Steady 16ms frames: the release velocity is judged from these, and jsdom
  // stamps every event 0, which would read as an infinitely fast flick.
  Object.defineProperty(event, "timeStamp", { value: frame() });
  return event;
}

let clock = 0;
function frame(): number {
  clock += FRAME_MS;
  return clock;
}

const FRAME_MS = 16;
/** px per frame: a deliberate pull, well under the flick threshold. */
const DRAG_STEP_PX = 8;

const leftPanel = (): ShellPanel => ({
  open: false,
  width: 280,
  minWidth: 200,
  onResize: () => {},
  mobilePresentation: "screen",
  label: "sidebar",
  content: <div data-testid="browser">Browser</div>,
});

function renderShell(
  edgeBack: { enabled: boolean; onBack: () => void },
  stacked?: ReactNode,
) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <AppShell mobile left={leftPanel()} edgeBack={edgeBack}>
        <main data-testid="screen">Object screen</main>
        {stacked}
      </AppShell>,
    );
  });
}

/**
 * A modal the way this app builds one: portaled to `document.body`, so it is
 * outside the shell's DOM but INSIDE its React tree — the arrangement whose
 * synthetic events used to reach the gesture.
 */
function PortaledModal() {
  return createPortal(
    <div
      data-testid="modal"
      role="dialog"
      aria-modal="true"
      style={{ position: "fixed", inset: 0 }}
    >
      <button type="button">Confirm</button>
    </div>,
    document.body,
  );
}

/** The other kind: a fixed layer rendered in place, inside the shell's DOM. */
function InlineModal() {
  return (
    <div data-testid="modal" style={{ position: "fixed", inset: 0 }}>
      <button type="button">Confirm</button>
    </div>
  );
}

function modalTarget(): HTMLElement {
  return document.body.querySelector<HTMLElement>("[data-testid='modal']")!;
}

/** The shell frame: the layer that travels under the finger. */
function shellFrame(): HTMLElement {
  return document.body.querySelector<HTMLElement>("[data-testid='screen']")!
    .parentElement!.parentElement!.parentElement!;
}

/**
 * The compatibility touch event the browser sends alongside each pointer move.
 * Only this one is cancelable, so it is where the gesture stops the page
 * scrolling — and it carries its own coordinates, which is what the gesture
 * reads rather than assuming the pointer move ran first.
 */
function touchMove(x: number, y: number): Event {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  const touch = { clientX: x, clientY: y };
  Object.assign(event, {
    touches: {
      length: 1,
      item: (index: number) => (index === 0 ? touch : null),
    },
  });
  return event;
}

/** A finger pulled across the screen a frame at a time, then lifted. */
function drag(to: number, { from = 6, y = 400, on = shellFrame } = {}) {
  const path: Array<[number, number]> = [];
  for (let x = from + DRAG_STEP_PX; x < to; x += DRAG_STEP_PX)
    path.push([x, y]);
  path.push([to, y]);
  return dragPath(path, { from, y, on });
}

/**
 * The same drag, spelled out point by point: the shape of the pull is what
 * decides whether the scroller or the gesture gets the touch, so the tests that
 * are about that shape write it down. Returns whether each move's touch event
 * was prevented — the page scrolling, or not, under the finger.
 */
function dragPath(
  path: Array<[number, number]>,
  { from = 6, y = 400, on = shellFrame } = {},
) {
  const host = on();
  const prevented: boolean[] = [];
  act(() => {
    host.dispatchEvent(pointer("pointerdown", { x: from, y }));
    for (const [x, moveY] of path) {
      host.dispatchEvent(pointer("pointermove", { x, y: moveY }));
      const touch = touchMove(x, moveY);
      host.dispatchEvent(touch);
      prevented.push(touch.defaultPrevented);
    }
    const [lastX, lastY] = path.at(-1) ?? [from, y];
    host.dispatchEvent(pointer("pointerup", { x: lastX, y: lastY }));
  });
  return { prevented };
}

/** The destination mounted under the leaving screen, if the gesture is up. */
function destination(): HTMLElement | null {
  return document.body
    .querySelectorAll<HTMLElement>("[data-testid='browser']")
    .item(0);
}

describe("AppShell edge-swipe back", () => {
  it("navigates once the screen has finished leaving, not before", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    drag(500);
    // The gesture committed, but the screen is still running out: navigating
    // here would swap the route under a slide the eye is still following.
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toContain("1024px");
    expect(destination()).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(1);
    // The transform is gone in the same batch as the navigation, so the
    // destination is never painted at an offset.
    expect(shellFrame().style.transform).toBe("");
  });

  it("holds the screen off-canvas until async history navigation lands", async () => {
    let finishNavigation!: () => void;
    const navigation = new Promise<void>((resolve) => {
      finishNavigation = resolve;
    });
    const asyncBack = (() => navigation) as () => void;
    renderShell({ enabled: true, onBack: asyncBack });

    drag(500);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(shellFrame().style.transform).toContain("1024px");

    await act(async () => {
      finishNavigation();
      await navigation;
    });
    expect(shellFrame().style.transform).toBe("");
  });

  it("springs home without navigating when the pull is short", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    drag(120);
    expect(shellFrame().style.transform).toContain("0px");

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("keeps a pull that arcs downward, and stops the page scrolling under it", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    // Rightward first, then a thumb's arc down the screen: past the vertical
    // yield, and far past it by the end. Once the first move has claimed the
    // touch none of that decides anything.
    const { prevented } = dragPath([
      [14, 402],
      [20, 440],
      [300, 520],
      [500, 560],
    ]);
    expect(prevented).toEqual([true, true, true, true]);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(1);
  });

  it("leaves a scroll from the edge to the scroller", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    // A touch in the strip that goes straight down is a scroll, and the page
    // has to keep it: nothing here is ever prevented.
    const { prevented } = dragPath([
      [8, 420],
      [10, 480],
      [10, 560],
    ]);
    expect(prevented).toEqual([false, false, false]);

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("mounts the destination only while a gesture is in flight", () => {
    renderShell({ enabled: true, onBack: () => {} });
    expect(destination()).toBeNull();
    drag(120);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(destination()).toBeNull();
  });

  it("ignores a pull that starts away from the edge", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    drag(700, { from: 200 });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("stays asleep where the host does not own the edge", () => {
    let backs = 0;
    renderShell({ enabled: false, onBack: () => (backs += 1) });

    drag(500);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("does not navigate out from under a portaled modal", () => {
    let backs = 0;
    renderShell(
      { enabled: true, onBack: () => (backs += 1) },
      <PortaledModal />,
    );

    // The touch lands on the modal, which is a body portal: outside the shell's
    // DOM, though its React parent is inside it.
    drag(500, { on: modalTarget });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("does not navigate out from under an in-tree fixed layer", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) }, <InlineModal />);

    // This one IS in the shell's DOM, so the listeners see it: what refuses the
    // gesture is the layer being fixed over the screen rather than part of it.
    drag(500, { on: modalTarget });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
    expect(shellFrame().style.transform).toBe("");
  });

  it("still runs for a touch on ordinary screen content", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) }, <InlineModal />);

    // The guard is about what the finger LANDED on, not about a layer existing
    // somewhere: content under no fixed layer still drags.
    drag(500, {
      on: () =>
        document.body.querySelector<HTMLElement>("[data-testid='screen']")!,
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(1);
  });

  it("ignores a mouse drag: this is a touch gesture", () => {
    let backs = 0;
    renderShell({ enabled: true, onBack: () => (backs += 1) });

    const host = shellFrame();
    act(() => {
      host.dispatchEvent(
        pointer("pointerdown", { x: 6, y: 400, pointerType: "mouse" }),
      );
      host.dispatchEvent(
        pointer("pointermove", { x: 500, y: 400, pointerType: "mouse" }),
      );
      host.dispatchEvent(
        pointer("pointerup", { x: 500, y: 400, pointerType: "mouse" }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(backs).toBe(0);
  });
});
