// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwipeRow } from "./SwipeRow.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom answers every media query `false`; this is the seam for the other one. */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

stubMatchMedia(false);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  stubMatchMedia(false);
});

/**
 * jsdom lays nothing out, so every box measures 0 and a height assertion would
 * pass in every phase. This is the row's real height, the one the exit measures.
 */
function stubHeight(host: HTMLElement, height: number) {
  Object.defineProperty(host, "offsetHeight", {
    configurable: true,
    value: height,
  });
}

/**
 * jsdom ships no `PointerEvent`, and React reads the fields off the native
 * event — so a plain bubbling Event carrying them is what the component sees.
 */
function pointer(
  type: string,
  init: { x: number; y: number; pointerType?: string; after?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: init.pointerType ?? "touch",
    clientX: init.x,
    clientY: init.y,
  });
  // jsdom stamps every event 0, which reads as an infinitely fast flick. Time
  // advances a frame per event unless a test asks for a longer gap.
  Object.defineProperty(event, "timeStamp", { value: advance(init.after) });
  return event;
}

const FRAME_MS = 16;
let clock = 0;
function advance(by = FRAME_MS): number {
  clock += by;
  return clock;
}

/**
 * The compatibility touch event the browser sends alongside each pointer move.
 * Only this one is cancelable, so it is where the row stops the list scrolling
 * — and it carries its own coordinates, which is what the veto reads rather
 * than assuming the pointer move ran first.
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

/**
 * A row whose LEFTWARD action is the one under test, which is what most of
 * these are about. `right` adds the other side, so a test can tell the two
 * apart; without it the row has one action, which is also a case the component
 * has to handle (it must not claim touches toward the empty side).
 */
function renderRow(
  onCommit: () => boolean | void,
  onRowClick = () => {},
  disabled = false,
  onExited?: () => void,
  right?: { label?: string; run: () => boolean | void; tone?: "danger" },
) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <SwipeRow
        left={{
          label: "Archive",
          icon: <span data-testid="icon" />,
          run: onCommit,
        }}
        right={
          right
            ? {
                label: right.label ?? "Delete",
                run: right.run,
                ...(right.tone !== undefined ? { tone: right.tone } : {}),
              }
            : undefined
        }
        onExited={onExited}
        disabled={disabled}
      >
        <button type="button" onClick={onRowClick}>
          Row
        </button>
      </SwipeRow>,
    );
  });
  return container.firstElementChild as HTMLElement;
}

function swipe(
  host: HTMLElement,
  { to, from = 300, y = 40, pointerType = "touch" }: SwipeArgs,
) {
  act(() => {
    host.dispatchEvent(pointer("pointerdown", { x: from, y, pointerType }));
    // A deliberate pull, a frame at a time. One long jump is a FLICK, which
    // commits on speed alone — the distance these tests are about would then
    // decide nothing.
    const step = to < from ? -DRAG_STEP_PX : DRAG_STEP_PX;
    for (let x = from + step; step < 0 ? x > to : x < to; x += step)
      host.dispatchEvent(pointer("pointermove", { x, y, pointerType }));
    host.dispatchEvent(pointer("pointermove", { x: to, y, pointerType }));
    host.dispatchEvent(pointer("pointerup", { x: to, y, pointerType }));
  });
}

/** px per frame: half the flick threshold, so it is a pull and not a throw. */
const DRAG_STEP_PX = 8;

interface SwipeArgs {
  to: number;
  from?: number;
  y?: number;
  pointerType?: string;
}

/** The action panel revealed behind the row, while a gesture is in flight. */
function panel(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-swipe-state]");
}

/** The action's icon inside that panel, which the armed state enlarges. */
function panelIcon(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>("[data-swipe-icon]");
}

/** The row body: the layer that travels under the finger. */
function body(host: HTMLElement): HTMLElement {
  return host.lastElementChild as HTMLElement;
}

describe("SwipeRow", () => {
  it("runs the action when a touch swipe passes the threshold", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { to: 300 - 140 });
    expect(commits).toBe(1);
  });

  it("springs back from a short swipe", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { to: 300 - 40 });
    expect(commits).toBe(0);
  });

  it("claims the touch from the list before the row engages", () => {
    // The browser decides whether a touch pans within its first few px, so the
    // veto has to be said while the moves are still cancelable — well short of
    // the travel that makes the row follow the finger.
    const host = renderRow(() => {});
    const claimed = touchMove(292, 40);
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(claimed);
    });
    expect(claimed.defaultPrevented).toBe(true);
    // Not yet engaged: the claim is about the scroller, not about the row.
    expect(panel(host)).toBeNull();
  });

  it("leaves a scrolling touch to the list", () => {
    const host = renderRow(() => {});
    const scrolling = touchMove(298, 70);
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(scrolling);
    });
    expect(scrolling.defaultPrevented).toBe(false);
  });

  it("does not claim a touch it never started tracking", () => {
    // A mouse gesture, a disabled row, a row on its way out: no start, no veto,
    // or the row would hold the page still for a finger it is ignoring.
    const host = renderRow(() => {});
    const stray = touchMove(292, 40);
    act(() => {
      host.dispatchEvent(stray);
    });
    expect(stray.defaultPrevented).toBe(false);
  });

  it("keeps following a claimed pull however far the thumb arcs", () => {
    // Once the scroller is cut out there is nothing left to yield to, and a
    // vertical wander that would otherwise abandon must not strand the finger.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(touchMove(292, 40));
      host.dispatchEvent(pointer("pointermove", { x: 292, y: 40 }));
      // Plainly outside the yield cone: unclaimed, this went to the scroller.
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 140 }));
    });
    expect(panel(host)).not.toBeNull();

    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 180 }));
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 180 }));
    });
    expect(commits).toBe(1);
  });

  it("still gives an unclaimed vertical drag to the list", () => {
    // The yield cone is for the touch that has not been taken yet; it has to
    // keep working, or a scroll started on a row would do nothing at all.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 296, y: 140 }));
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 180 }));
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 180 }));
    });
    expect(commits).toBe(0);
    expect(panel(host)).toBeNull();
  });

  it("runs the action on the side the finger actually went", () => {
    let archived = 0;
    let deleted = 0;
    const host = renderRow(
      () => {
        archived++;
      },
      undefined,
      false,
      undefined,
      {
        run: () => {
          deleted++;
        },
      },
    );
    swipe(host, { to: 300 + 140 });
    expect(deleted).toBe(1);
    expect(archived).toBe(0);

    swipe(host, { to: 300 - 140 });
    expect(archived).toBe(1);
    expect(deleted).toBe(1);
  });

  it("reveals each action on the edge the row uncovers", () => {
    // The panel is parked past the edge the row uncovers and slides in from
    // that side with the row.
    const host = renderRow(() => {}, undefined, false, undefined, {
      run: () => {},
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeSide).toBe("left");
    expect(panel(host)?.className).toContain("left-full");
    expect(panel(host)?.style.transform).toBe("translateX(-40px)");

    act(() => {
      host.dispatchEvent(pointer("pointerup", { x: 260, y: 40, after: 200 }));
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 340, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeSide).toBe("right");
    expect(panel(host)?.className).toContain("right-full");
    expect(panel(host)?.style.transform).toBe("translateX(40px)");
  });

  it("ignores a pull toward a side with no action on it", () => {
    // And, crucially, does not CLAIM it: killing the scroll for a side that
    // reveals nothing costs the touch and gives nothing back.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    const rightward = touchMove(308, 40);
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(rightward);
    });
    expect(rightward.defaultPrevented).toBe(false);

    swipe(host, { to: 300 + 140 });
    expect(commits).toBe(0);
    expect(panel(host)).toBeNull();
  });

  it("does not open the other action when a finger drags back through zero", () => {
    // One gesture means one thing. These two sides are archive and delete, so a
    // thumb that overshoots its way home must not find the opposite panel — and
    // the throw that carries it there must not commit anything either.
    let archived = 0;
    let deleted = 0;
    const host = renderRow(
      () => {
        archived++;
      },
      undefined,
      false,
      undefined,
      {
        run: () => {
          deleted++;
        },
      },
    );
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 340, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 420, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 420, y: 40 }));
    });
    expect(deleted).toBe(0);
    expect(archived).toBe(0);
  });

  it("paints a destructive action in danger from the first px", () => {
    // Not at the threshold: with an action on each side, the colour is how a
    // thumb knows WHICH one it is opening, and it has to know while there is
    // still time to pull back.
    const host = renderRow(() => {}, undefined, false, undefined, {
      run: () => {},
      tone: "danger",
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 320, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeState).toBe("pending");
    expect(panel(host)?.dataset.swipeTone).toBe("danger");
    expect(panel(host)?.className).toContain("bg-danger");
  });

  it("commits a flick that never travelled far enough to arm", () => {
    // The gesture that used to spring back: a thumb that says which way it
    // meant and leaves the glass before the row has the distance.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
    });
    // 40 px in a frame: fast, but nowhere near the visible threshold.
    expect(panel(host)?.dataset.swipeState).toBe("pending");

    act(() => {
      host.dispatchEvent(pointer("pointerup", { x: 260, y: 40 }));
    });
    expect(commits).toBe(1);
    // The panel confirms the action it is running, exactly as a pulled row does
    // — a neutral panel springing home would read as a refusal.
    expect(panel(host)?.dataset.swipeState).toBe("armed");
  });

  it("takes a fast rightward throw back as taking the swipe back", () => {
    // Armed, and then thrown the other way: the panel's promise is not a
    // ratchet, and archiving on the gesture a hand makes to say no is worse
    // than any swipe that fails to land.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      for (let x = 292; x >= 100; x -= 8)
        host.dispatchEvent(pointer("pointermove", { x, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeState).toBe("armed");

    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 200, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 200, y: 40 }));
    });
    // Still past the distance threshold when it was released.
    expect(commits).toBe(0);
  });

  it("judges a finger that stopped by where it is, not how it arrived", () => {
    // Flicked open, then held: the speed it got there at is not a flick the
    // hand is still making, and the row is short of the threshold.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 260, y: 40, after: 200 }));
    });
    expect(commits).toBe(0);
  });

  it("arms the panel only once the DISTANCE alone would commit", () => {
    // Arming is the promise a reader can see, so it tracks travel and nothing
    // else: a flick commits below this line without ever painting it.
    const host = renderRow(() => {});
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeState).toBe("pending");
    expect(panelIcon(host)?.className).not.toContain("scale-125");

    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeState).toBe("armed");
    // The state is legible without colour: the icon grows with the arming.
    expect(panelIcon(host)?.className).toContain("scale-125");

    // Pulling back below the threshold takes the promise away again.
    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 270, y: 40 }));
    });
    expect(panel(host)?.dataset.swipeState).toBe("pending");
    expect(panelIcon(host)?.className).not.toContain("scale-125");
  });

  it("names the action with one word for the whole gesture", () => {
    // A label that rewrites itself at the threshold makes the reader re-read
    // the panel to learn that the action has not changed.
    const host = renderRow(() => {});
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 260, y: 40 }));
    });
    expect(panel(host)?.textContent).toBe("Archive");
    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 40 }));
    });
    expect(panel(host)?.textContent).toBe("Archive");
    act(() => {
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 40 }));
    });
    expect(panel(host)?.textContent).toBe("Archive");
  });

  it("keeps the armed panel while the committed row springs home", () => {
    // Repainting the panel neutral the instant the finger lifts would read as a
    // refusal of the archive that is in fact running.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { to: 300 - 140 });
    expect(commits).toBe(1);
    const settlingPanel = panel(host);
    expect(settlingPanel).not.toBeNull();
    expect(settlingPanel!.dataset.swipeState).toBe("armed");
  });

  it("keeps the panel through a touch that lands inside the spring-back", () => {
    // The row body is still sliding home on its own transition; unmounting the
    // panel under it would animate the row over bare background.
    const host = renderRow(() => {});
    swipe(host, { to: 300 - 140 });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
    });
    expect(panel(host)).not.toBeNull();
  });

  it("carries a removed row out and closes the gap behind it", () => {
    vi.useFakeTimers();
    let exited = 0;
    // The action took the row: it leaves in the swipe direction rather than
    // springing home to be deleted out from under the finger.
    const host = renderRow(
      () => true,
      () => {},
      false,
      () => {
        exited++;
      },
    );
    stubHeight(host, 36);
    swipe(host, { to: 300 - 140 });
    expect(host.dataset.swipeExit).toBe("sliding");
    expect(body(host).style.transform).toBe("translateX(-100%)");
    // The row still holds the height it was measured at while it slides: the
    // gap closes AFTER the row is out of it, not under it.
    expect(host.style.height).toBe("36px");
    // …and it is out of reach while it goes, though it is still mounted.
    expect(host.hasAttribute("inert")).toBe(true);
    // The panel travels with the row into the width it is giving up, so nothing
    // animates over bare background, still naming the action it is carrying the
    // row out for.
    expect(panel(host)?.style.transform).toBe("translateX(-100%)");
    expect(panel(host)?.dataset.swipeState).toBe("armed");
    expect(panel(host)?.textContent).toBe("Archive");

    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(host.dataset.swipeExit).toBe("closing");
    // Zero, from a real height rather than from `auto`, which cannot animate.
    expect(host.style.height).toBe("0px");
    expect(exited).toBe(0);

    // Only once the gap has closed is the list told to drop the row for real.
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(host.dataset.swipeExit).toBe("gone");
    expect(exited).toBe(1);
  });

  it("springs back when the action did not take the row", () => {
    vi.useFakeTimers();
    // An action that cannot say the row is gone keeps the old ending: a row
    // that leaves on a write the server may still refuse is a lie.
    const host = renderRow(() => {});
    swipe(host, { to: 300 - 140 });
    expect(host.dataset.swipeExit).toBeUndefined();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(host.dataset.swipeExit).toBeUndefined();
    expect(host.style.height).toBe("");
  });

  it("removes the row without moving it under reduced motion", () => {
    vi.useFakeTimers();
    stubMatchMedia(true);
    let exited = 0;
    // The row still GOES — the platform asked for no motion, not for a Task
    // that stays put — it just does not travel to say so.
    const host = renderRow(
      () => true,
      () => {},
      false,
      () => {
        exited++;
      },
    );
    stubHeight(host, 36);
    swipe(host, { to: 300 - 140 });
    expect(host.dataset.swipeExit).toBe("gone");
    expect(host.style.height).toBe("0px");
    expect(host.style.transition).toBe("");
    expect(exited).toBe(1);
  });

  it("comes back when nothing ever removed the row", () => {
    vi.useFakeTimers();
    // The list should unmount a row that has left. One still here long after is
    // a row the archive did not remove — a hole in the list is worse.
    const host = renderRow(() => true);
    stubHeight(host, 36);
    swipe(host, { to: 300 - 140 });
    // One `act` per leg: each phase schedules its own timer as it renders.
    act(() => {
      vi.advanceTimersByTime(160);
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(host.dataset.swipeExit).toBe("gone");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(host.dataset.swipeExit).toBeUndefined();
    expect(host.hasAttribute("inert")).toBe(false);
    expect(host.style.height).toBe("");
    expect(panel(host)).toBeNull();
  });

  it("takes no second swipe on a row that is already leaving", () => {
    vi.useFakeTimers();
    let commits = 0;
    const host = renderRow(() => {
      commits++;
      return true;
    });
    swipe(host, { to: 300 - 140 });
    swipe(host, { to: 300 - 140 });
    expect(commits).toBe(1);
  });

  it("ignores a mouse drag — the row keeps its click and its drag", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { to: 300 - 200, pointerType: "mouse" });
    expect(commits).toBe(0);
  });

  it("ignores a rightward drag", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { to: 300 + 200 });
    expect(commits).toBe(0);
  });

  it("runs the action on a diagonal one-handed pull", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      // The thumb arcs down as it pulls left, and it still meant the archive.
      host.dispatchEvent(pointer("pointermove", { x: 280, y: 55 }));
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 90 }));
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 90 }));
    });
    expect(commits).toBe(1);
  });

  it("survives vertical wobble before the swipe gets going", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      // Barely horizontal yet: this is the finger settling, not a scroll.
      host.dispatchEvent(pointer("pointermove", { x: 297, y: 54 }));
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 60 }));
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 60 }));
    });
    expect(commits).toBe(1);
  });

  it("leaves nothing behind when the pointer is taken away mid-gesture", () => {
    // Not the scroller taking it: a leaning touch is claimed, and the veto is
    // what keeps the pan from ever starting under it. A `pointercancel` still
    // arrives for endings the row does not control — the UA claiming the touch
    // for a system gesture, a second finger, a drag sensor taking over, or a
    // drag whose pan began before the lean qualified. Whatever the cause, it
    // has to leave nothing behind: no commit, no armed panel, and no release
    // afterwards that still lands.
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 280, y: 55 }));
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 120 }));
    });
    // Past the threshold: this is a gesture the release would have committed.
    expect(panel(host)?.dataset.swipeState).toBe("armed");

    act(() => {
      host.dispatchEvent(pointer("pointercancel", { x: 160, y: 120 }));
    });
    expect(commits).toBe(0);
    expect(panel(host)?.dataset.swipeState).toBe("pending");
    expect(body(host).style.transform).toBe("");

    act(() => {
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 120 }));
    });
    expect(commits).toBe(0);
  });

  it("gives a mostly-vertical drag back to the scroller", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 280, y: 100 }));
      host.dispatchEvent(pointer("pointermove", { x: 120, y: 140 }));
      host.dispatchEvent(pointer("pointerup", { x: 120, y: 140 }));
    });
    expect(commits).toBe(0);
  });

  it("leaves a touch that started on a screen edge to the browser", () => {
    let commits = 0;
    const host = renderRow(() => {
      commits++;
    });
    swipe(host, { from: 4, to: -200 });
    expect(commits).toBe(0);
  });

  it("abandons a gesture the host takes over mid-swipe", () => {
    // The drag-to-reorder sensor activating on a long press: the same finger is
    // now driving a drag, and the swipe must not also land on release.
    let commits = 0;
    const onCommit = () => {
      commits++;
    };
    const host = renderRow(onCommit);
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 280, y: 40 }));
    });
    renderRow(onCommit, () => {}, true);
    act(() => {
      host.dispatchEvent(pointer("pointermove", { x: 120, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 120, y: 40 }));
    });
    expect(commits).toBe(0);
    // …and the panel never claims otherwise on the way home.
    const abandonedPanel = panel(host);
    expect(abandonedPanel).not.toBeNull();
    expect(abandonedPanel!.dataset.swipeState).toBe("pending");
  });

  it("swallows the click that ends a swipe", () => {
    let clicks = 0;
    const host = renderRow(
      () => {},
      () => {
        clicks++;
      },
    );
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointermove", { x: 160, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 160, y: 40 }));
    });
    const rowButton = host.querySelector("button")!;
    act(() => {
      rowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicks).toBe(0);
  });

  it("leaves an ordinary tap alone", () => {
    let clicks = 0;
    const host = renderRow(
      () => {},
      () => {
        clicks++;
      },
    );
    act(() => {
      host.dispatchEvent(pointer("pointerdown", { x: 300, y: 40 }));
      host.dispatchEvent(pointer("pointerup", { x: 301, y: 40 }));
    });
    const rowButton = host.querySelector("button")!;
    act(() => {
      rowButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(clicks).toBe(1);
  });
});
