// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePointerReorder } from "./usePointerReorder.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
  container?.remove();
  root = null;
  container = null;
});

const ROW_HEIGHT = 20;
const ROW_PITCH = 30; // A 10px gap between rows, as the real list has.

/**
 * jsdom lays nothing out, so every row measures zero and every hit test would
 * land on the first row. These are the boxes a browser would have measured —
 * read from the row's CURRENT position, since a reorder moves the same nodes
 * and a box pinned at render time would describe a list that no longer exists.
 */
function stubRows(list: HTMLUListElement) {
  for (const row of Array.from(list.children))
    row.getBoundingClientRect = function (this: Element) {
      const index = Array.from(this.parentElement!.children).indexOf(this);
      return {
        top: index * ROW_PITCH,
        bottom: index * ROW_PITCH + ROW_HEIGHT,
      } as DOMRect;
    };
}

/**
 * jsdom ships no `PointerEvent`, and both React and the window listeners read
 * the fields off the native event — a bubbling event carrying them is what the
 * hook sees.
 */
function pointer(
  type: string,
  init: { y?: number; pointerType?: string; button?: number } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: init.pointerType ?? "mouse",
    button: init.button ?? 0,
    buttons: 1,
    isPrimary: true,
    clientX: 0,
    clientY: init.y ?? 0,
  });
  return event;
}

type Commit = (next: string[], moved: string) => void;

/** Replaces the list from outside the gesture, as a settings echo would. */
let replaceItems: (next: string[]) => void = () => {};
/** Every arrangement the gesture handed out, in order. */
let emitted: string[][] = [];

function List({ onCommit }: { onCommit: Commit }) {
  const [items, setItems] = useState(["a", "b", "c"]);
  replaceItems = (next) => setItems(next);
  const { listRef, draggingKey, handleProps } = usePointerReorder({
    items,
    keyOf: (item) => item,
    onReorder: (next) => {
      emitted.push(next);
      setItems(next);
    },
    onCommit,
  });
  return (
    <ul ref={listRef} data-testid="list">
      {items.map((item, index) => (
        <li key={item} data-key={item} data-dragging={draggingKey === item}>
          <button
            type="button"
            data-testid={`handle-${item}`}
            {...handleProps(index)}
          >
            grip
          </button>
        </li>
      ))}
    </ul>
  );
}

function render(onCommit: Commit = () => {}) {
  emitted = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(<List onCommit={onCommit} />);
  });
  const list = container.querySelector("ul")!;
  stubRows(list);
  return {
    list,
    order: () =>
      Array.from(list.children).map((row) => row.getAttribute("data-key")),
    handle: (key: string) =>
      container!.querySelector<HTMLButtonElement>(
        `[data-testid="handle-${key}"]`,
      )!,
  };
}

/**
 * Wraps the list in a scrolling box with the geometry jsdom never computes: a
 * 60px viewport over 300px of content, so the edge band is reachable and the
 * scroll has somewhere to go.
 */
function stubScroller(list: HTMLUListElement): HTMLElement {
  const scroller = list.parentElement!;
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: 300 });
  Object.defineProperty(scroller, "clientHeight", { value: 60 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 60 }) as DOMRect;
  return scroller;
}

function drag(handle: HTMLElement, moves: number[], end = "pointerup") {
  act(() => {
    handle.dispatchEvent(pointer("pointerdown"));
  });
  for (const y of moves)
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y }));
    });
  act(() => {
    window.dispatchEvent(pointer(end));
  });
}

describe("usePointerReorder", () => {
  it("moves a row to the row under the pointer and saves once on release", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    const handle = view.handle("a");

    act(() => {
      handle.dispatchEvent(pointer("pointerdown"));
    });
    expect(view.list.children[0]!.getAttribute("data-dragging")).toBe("true");

    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
    });
    expect(view.order()).toEqual(["b", "c", "a"]);
    // Live only: nothing is persisted until the gesture ends.
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(pointer("pointerup"));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toEqual(["b", "c", "a"]);
    expect(view.list.children[0]!.getAttribute("data-dragging")).toBe("false");
  });

  /**
   * The whole point of leaving HTML5 drag-and-drop behind: a touch never emits
   * `dragstart`, so this path is the only one a phone has.
   */
  it("reorders from a touch pointer", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view
        .handle("c")
        .dispatchEvent(pointer("pointerdown", { pointerType: "touch" }));
    });
    act(() => {
      window.dispatchEvent(
        pointer("pointermove", { y: 10, pointerType: "touch" }),
      );
    });
    act(() => {
      window.dispatchEvent(pointer("pointerup", { pointerType: "touch" }));
    });
    expect(view.order()).toEqual(["c", "a", "b"]);
    expect(onCommit.mock.calls[0]![0]).toEqual(["c", "a", "b"]);
  });

  it("follows the pointer across several rows and saves the final order", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    drag(view.handle("a"), [40, 70]);
    expect(view.order()).toEqual(["b", "c", "a"]);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("clamps a pointer dragged past either end onto the end row", () => {
    const view = render();
    act(() => {
      view.handle("c").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: -200 }));
    });
    expect(view.order()).toEqual(["c", "a", "b"]);
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 1000 }));
    });
    expect(view.order()).toEqual(["a", "b", "c"]);
    act(() => {
      window.dispatchEvent(pointer("pointerup"));
    });
  });

  /** A pointer in the gap between two rows has not reached either of them. */
  it("holds the arrangement while the pointer sits between rows", () => {
    const view = render();
    drag(view.handle("a"), [25]);
    expect(view.order()).toEqual(["a", "b", "c"]);
  });

  it("presses without moving, and saves nothing", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    drag(view.handle("b"), []);
    expect(view.order()).toEqual(["a", "b", "c"]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("puts the list back when the gesture is cancelled", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    drag(view.handle("a"), [70], "pointercancel");
    expect(view.order()).toEqual(["a", "b", "c"]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("reorders by one row per arrow key, saving each step", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    const key = (target: HTMLElement, name: string) =>
      act(() => {
        const event = new KeyboardEvent("keydown", {
          key: name,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
      });

    key(view.handle("a"), "ArrowDown");
    expect(view.order()).toEqual(["b", "a", "c"]);
    expect(onCommit.mock.calls[0]![0]).toEqual(["b", "a", "c"]);

    key(view.handle("a"), "ArrowUp");
    expect(view.order()).toEqual(["a", "b", "c"]);

    // The top row has nowhere to go, and no save to make.
    key(view.handle("a"), "ArrowUp");
    expect(view.order()).toEqual(["a", "b", "c"]);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
  /**
   * Pointer moves are delivered faster than React commits, so a burst arrives
   * against a list the last render has not caught up with. Reading the items
   * from the last RENDER there drops every move after the first, and a release
   * in the same burst saves the order the drag started from.
   */
  it("keeps up with a burst of moves that React has not rendered yet", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 40 }));
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
      window.dispatchEvent(pointer("pointerup", { y: 70 }));
    });
    expect(view.order()).toEqual(["b", "c", "a"]);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toEqual(["b", "c", "a"]);
  });

  it("names the row that moved, for the announcement", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    drag(view.handle("a"), [70]);
    expect(onCommit.mock.calls[0]![1]).toBe("a");
  });

  /**
   * A settings echo, a refresh, or a row hidden on another surface replaces the
   * list under the gesture. That list is authoritative: saving the arrangement
   * the finger was building would write back an order about a list that is
   * gone.
   */
  it("retires the gesture when the list is replaced from outside", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
    });
    expect(view.order()).toEqual(["b", "c", "a"]);

    act(() => {
      replaceItems(["c", "b", "a", "d"]);
    });
    stubRows(view.list);
    expect(view.list.children[2]!.getAttribute("data-dragging")).toBe("false");

    // The release belongs to a gesture that no longer exists: it saves nothing
    // and moves nothing.
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 10 }));
      window.dispatchEvent(pointer("pointerup", { y: 10 }));
    });
    expect(view.order()).toEqual(["c", "b", "a", "d"]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  /** A second finger must not take the drag over and strand the first. */
  it("ignores a second pointer while one is already dragging", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      const second = pointer("pointerdown");
      Object.assign(second, { pointerId: 2 });
      view.handle("c").dispatchEvent(second);
    });
    // Still the first row's gesture: the second pointer's moves do nothing.
    act(() => {
      const move = pointer("pointermove", { y: 10 });
      Object.assign(move, { pointerId: 2 });
      window.dispatchEvent(move);
    });
    expect(view.order()).toEqual(["a", "b", "c"]);
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
      window.dispatchEvent(pointer("pointerup", { y: 70 }));
    });
    expect(view.order()).toEqual(["b", "c", "a"]);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  /**
   * A mouse released outside the window sends no `pointerup`; the row would
   * follow an unpressed cursor forever.
   */
  it("ends the drag when the mouse comes back with no button down", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
    });
    act(() => {
      const released = pointer("pointermove", { y: 70 });
      Object.assign(released, { buttons: 0 });
      window.dispatchEvent(released);
    });
    expect(view.list.children[2]!.getAttribute("data-dragging")).toBe("false");
    expect(onCommit).toHaveBeenCalledTimes(1);
    // A later move is no longer part of any gesture.
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 10 }));
    });
    expect(view.order()).toEqual(["b", "c", "a"]);
  });

  it("puts the list back when the window loses focus mid-drag", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(view.order()).toEqual(["a", "b", "c"]);
    expect(onCommit).not.toHaveBeenCalled();
  });
  /**
   * A grip that happens to sit in the scroller's edge band must not turn a
   * resting finger into a drag: the list would scroll, the row would follow,
   * and the release would save a reorder nobody asked for.
   */
  it("does not autoscroll under a press that has not moved", () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    const view = render(onCommit);
    const scroller = stubScroller(view.list);

    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown", { y: 5 }));
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(scroller.scrollTop).toBe(0);
    expect(view.order()).toEqual(["a", "b", "c"]);

    act(() => {
      window.dispatchEvent(pointer("pointerup", { y: 5 }));
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("autoscrolls once the pointer has travelled to the edge", () => {
    vi.useFakeTimers();
    const view = render();
    const scroller = stubScroller(view.list);

    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown", { y: 5 }));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 30 }));
    });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scroller.scrollTop).toBeGreaterThan(0);
    act(() => {
      window.dispatchEvent(pointer("pointerup", { y: 30 }));
    });
  });

  /**
   * React may render with an arrangement the gesture handed out earlier while a
   * newer one is still in flight. That is ordinary React, not an outside edit,
   * and a gesture retired on it would drop mid-drag — so provenance is judged
   * against every array the gesture emitted, not just the newest.
   */
  it("survives a render carrying an earlier arrangement of its own", () => {
    const onCommit = vi.fn();
    const view = render(onCommit);
    act(() => {
      view.handle("a").dispatchEvent(pointer("pointerdown"));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 40 }));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", { y: 70 }));
    });
    expect(emitted).toHaveLength(2);

    act(() => {
      replaceItems(emitted[0]!);
    });
    stubRows(view.list);
    expect(
      Array.from(view.list.children).some(
        (row) => row.getAttribute("data-dragging") === "true",
      ),
    ).toBe(true);

    act(() => {
      window.dispatchEvent(pointer("pointerup", { y: 70 }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
