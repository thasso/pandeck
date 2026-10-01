import { describe, expect, it } from "vitest";
import {
  SWIPE_CLAIM_PX,
  SWIPE_COMMIT_PX,
  SWIPE_EDGE_GUARD_PX,
  SWIPE_ENGAGE_PX,
  SWIPE_RUBBER_BAND_PX,
  SWIPE_VERTICAL_YIELD_PX,
  classifySwipeMove,
  swipeArms,
  swipeClaimsTouch,
  swipeCommitThreshold,
  swipeCommits,
  swipeStartAllowed,
  swipeTravel,
} from "./swipeGesture.ts";
// The one cross-module invariant this gesture now depends on: the two are
// deliberately separate modules, so only a test can hold them together.
import { EDGE_SWIPE_ZONE_PX } from "../components/shell/edgeSwipe.ts";

/** A row carrying an action on each side, which the Backlog's rows do. */
const BOTH = { left: true, right: true };

describe("swipeStartAllowed", () => {
  it("leaves both screen edges to the browser", () => {
    expect(swipeStartAllowed(2, 390)).toBe(false);
    expect(swipeStartAllowed(390 - 2, 390)).toBe(false);
    expect(swipeStartAllowed(SWIPE_EDGE_GUARD_PX, 390)).toBe(true);
    expect(swipeStartAllowed(195, 390)).toBe(true);
  });

  it("keeps clear of the strip the shell's back gesture owns", () => {
    // The row's rightward swipe IS the edge gesture's direction, so this is no
    // longer a courtesy: an overlap would let one finger arm both. Nothing else
    // would notice if the edge strip grew, hence the assertion rather than a
    // comment in one of the two files.
    expect(SWIPE_EDGE_GUARD_PX).toBeGreaterThan(EDGE_SWIPE_ZONE_PX);
    expect(swipeStartAllowed(EDGE_SWIPE_ZONE_PX, 390)).toBe(false);
    expect(swipeStartAllowed(390 - EDGE_SWIPE_ZONE_PX, 390)).toBe(false);
  });
});

describe("swipeClaimsTouch", () => {
  it("claims a lean well before the row engages", () => {
    // The whole point: the browser has decided about the touch long before it
    // has travelled SWIPE_ENGAGE_PX.
    expect(SWIPE_CLAIM_PX).toBeLessThan(SWIPE_ENGAGE_PX);
    expect(swipeClaimsTouch(-SWIPE_CLAIM_PX, 0, BOTH)).toBe(true);
    expect(swipeClaimsTouch(SWIPE_CLAIM_PX, 0, BOTH)).toBe(true);
    expect(swipeClaimsTouch(-SWIPE_CLAIM_PX + 1, 0, BOTH)).toBe(false);
  });

  it("takes a diagonal pull either way, up to a tie", () => {
    expect(swipeClaimsTouch(-10, 10, BOTH)).toBe(true);
    expect(swipeClaimsTouch(10, -10, BOTH)).toBe(true);
    expect(swipeClaimsTouch(-10, 11, BOTH)).toBe(false);
    expect(swipeClaimsTouch(10, 11, BOTH)).toBe(false);
  });

  it("leaves a scroll to the list", () => {
    // How a list scroll begins: vertical first, whatever the thumb's arc adds.
    expect(swipeClaimsTouch(-2, 30, BOTH)).toBe(false);
    expect(swipeClaimsTouch(0, -40, BOTH)).toBe(false);
  });

  it("never claims toward a side with no action on it", () => {
    // Killing a scroll costs the touch entirely, so a row must not pay that for
    // a direction that would reveal nothing.
    expect(swipeClaimsTouch(30, 0, { left: true, right: false })).toBe(false);
    expect(swipeClaimsTouch(-30, 0, { left: false, right: true })).toBe(false);
    expect(swipeClaimsTouch(-30, 0, { left: true, right: false })).toBe(true);
  });
});

describe("classifySwipeMove", () => {
  it("waits while the movement is too small to mean anything", () => {
    expect(classifySwipeMove(-4, 2, BOTH)).toBe("pending");
  });

  it("names the side the finger is reaching for", () => {
    expect(classifySwipeMove(-SWIPE_ENGAGE_PX, 3, BOTH)).toBe("left");
    expect(classifySwipeMove(SWIPE_ENGAGE_PX, 3, BOTH)).toBe("right");
  });

  it("takes a diagonal one-handed pull as the swipe it is", () => {
    // A thumb arcs; a tie is a swipe with drift in it, not a scroll.
    expect(classifySwipeMove(-20, 20, BOTH)).toBe("left");
    expect(classifySwipeMove(-60, 50, BOTH)).toBe("left");
    expect(classifySwipeMove(40, -30, BOTH)).toBe("right");
  });

  it("keeps waiting through vertical wobble at the start of a swipe", () => {
    // Small vertical noise used to kill the gesture before the horizontal had
    // travelled far enough to speak for itself.
    expect(classifySwipeMove(-3, 14, BOTH)).toBe("pending");
    expect(classifySwipeMove(-2, -20, BOTH)).toBe("pending");
  });

  it("gives a mostly-vertical drag to the scroller", () => {
    expect(classifySwipeMove(-14, 30, BOTH)).toBe("abandoned");
    expect(classifySwipeMove(0, SWIPE_VERTICAL_YIELD_PX, BOTH)).toBe(
      "abandoned",
    );
    expect(classifySwipeMove(-30, 90, BOTH)).toBe("abandoned");
  });

  it("needs real vertical travel before the scroller can win", () => {
    // Dominance alone is not enough: at this size the ratio is mostly noise.
    expect(classifySwipeMove(-2, SWIPE_VERTICAL_YIELD_PX - 1, BOTH)).toBe(
      "pending",
    );
  });

  it("abandons a pull toward a side with no action on it", () => {
    expect(classifySwipeMove(30, 2, { left: true, right: false })).toBe(
      "abandoned",
    );
    expect(classifySwipeMove(-30, 2, { left: false, right: true })).toBe(
      "abandoned",
    );
  });

  it("stops judging the vertical once the touch is claimed", () => {
    // The scroller has been cut out by then: there is nothing left to yield to,
    // and a thumb still pulling must not be stranded.
    expect(classifySwipeMove(-14, 30, BOTH, true)).toBe("left");
    expect(classifySwipeMove(30, 90, BOTH, true)).toBe("right");
    expect(classifySwipeMove(-4, 60, BOTH, true)).toBe("pending");
  });

  it("still refuses a claimed pull toward a side with nothing on it", () => {
    expect(classifySwipeMove(30, 2, { left: true, right: false }, true)).toBe(
      "abandoned",
    );
  });
});

describe("swipeTravel", () => {
  it("follows the finger 1:1 up to the rubber-band point, either way", () => {
    expect(swipeTravel(-40, "left")).toBe(-40);
    expect(swipeTravel(40, "right")).toBe(40);
    expect(swipeTravel(-SWIPE_RUBBER_BAND_PX, "left")).toBe(
      -SWIPE_RUBBER_BAND_PX,
    );
  });

  it("resists past it", () => {
    const left = swipeTravel(-(SWIPE_RUBBER_BAND_PX + 100), "left");
    expect(Math.abs(left)).toBeGreaterThan(SWIPE_RUBBER_BAND_PX);
    expect(Math.abs(left)).toBeLessThan(SWIPE_RUBBER_BAND_PX + 100);
    const right = swipeTravel(SWIPE_RUBBER_BAND_PX + 100, "right");
    expect(right).toBe(-left);
  });

  it("does not open the other action when the finger drags back past zero", () => {
    // One gesture means one thing, and on these rows the two sides are archive
    // and delete: crossing the start point springs the row home, it does not
    // reveal the opposite panel.
    expect(swipeTravel(60, "left")).toBe(0);
    expect(swipeTravel(-60, "right")).toBe(0);
  });
});

describe("swipeArms", () => {
  it("uses the fixed distance on a wide row", () => {
    expect(swipeCommitThreshold(800)).toBe(SWIPE_COMMIT_PX);
    expect(swipeArms(SWIPE_COMMIT_PX, 800)).toBe(true);
    expect(swipeArms(SWIPE_COMMIT_PX - 1, 800)).toBe(false);
  });

  it("measures the pull, not its direction", () => {
    expect(swipeArms(-SWIPE_COMMIT_PX, 800)).toBe(true);
    expect(swipeArms(-(SWIPE_COMMIT_PX - 1), 800)).toBe(false);
  });

  it("scales down for a narrow row", () => {
    // A sidebar row must not need a swipe wider than most of itself.
    expect(swipeCommitThreshold(240)).toBeLessThan(SWIPE_COMMIT_PX);
    expect(swipeArms(90, 240)).toBe(true);
  });

  it("keeps a floor so a tiny row cannot arm by accident", () => {
    expect(swipeCommitThreshold(60)).toBe(48);
    expect(swipeArms(30, 60)).toBe(false);
  });
});

describe("swipeCommits", () => {
  const rowWidth = 800;

  it("runs everything the armed panel promised", () => {
    for (const direction of ["left", "right"] as const) {
      const travel = direction === "left" ? -SWIPE_COMMIT_PX : SWIPE_COMMIT_PX;
      expect(swipeCommits({ travel, rowWidth, velocity: 0, direction })).toBe(
        true,
      );
      expect(
        swipeCommits({
          travel: travel - Math.sign(travel),
          rowWidth,
          velocity: 0,
          direction,
        }),
      ).toBe(false);
    }
  });

  it("commits a short flick on its speed alone, whichever way it went", () => {
    // The gesture that used to spring back: gone before it had the distance.
    expect(
      swipeCommits({
        travel: -30,
        rowWidth,
        velocity: -1.4,
        direction: "left",
      }),
    ).toBe(true);
    expect(
      swipeCommits({ travel: 30, rowWidth, velocity: 1.4, direction: "right" }),
    ).toBe(true);
  });

  it("reads a fast throw BACK as taking the swipe back", () => {
    // Past the threshold and armed, but the finger is leaving the way it came.
    // Judged against the gesture's own direction, because on these rows the
    // opposite one is a different and unrecoverable action.
    expect(
      swipeCommits({
        travel: -300,
        rowWidth,
        velocity: 1.4,
        direction: "left",
      }),
    ).toBe(false);
    expect(
      swipeCommits({
        travel: 300,
        rowWidth,
        velocity: -1.4,
        direction: "right",
      }),
    ).toBe(false);
  });

  it("leaves an ordinary pull to the distance", () => {
    expect(
      swipeCommits({
        travel: -30,
        rowWidth,
        velocity: -0.4,
        direction: "left",
      }),
    ).toBe(false);
    expect(
      swipeCommits({
        travel: -120,
        rowWidth,
        velocity: -0.4,
        direction: "left",
      }),
    ).toBe(true);
  });
});
