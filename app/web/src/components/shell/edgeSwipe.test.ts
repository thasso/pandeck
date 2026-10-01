import { describe, expect, it } from "vitest";
import {
  classifyEdgeSwipeMove,
  edgeSwipeClaimsTouch,
  edgeSwipeCommits,
  edgeSwipeParallax,
  edgeSwipeStartAllowed,
  edgeSwipeTravel,
  EDGE_SWIPE_ZONE_PX,
} from "./edgeSwipe.ts";

describe("edgeSwipeStartAllowed", () => {
  it("takes touches in the leading strip and nothing further in", () => {
    expect(edgeSwipeStartAllowed(0)).toBe(true);
    expect(edgeSwipeStartAllowed(EDGE_SWIPE_ZONE_PX)).toBe(true);
    expect(edgeSwipeStartAllowed(EDGE_SWIPE_ZONE_PX + 1)).toBe(false);
    // The middle of the screen belongs to the content, and the trailing edge
    // has no gesture at all: back is one direction.
    expect(edgeSwipeStartAllowed(200)).toBe(false);
  });
});

describe("edgeSwipeClaimsTouch", () => {
  it("takes the touch as soon as it leans rightward, well before it engages", () => {
    expect(edgeSwipeClaimsTouch(6, 4)).toBe(true);
    // A tie is a swipe with drift in it, not a scroll.
    expect(edgeSwipeClaimsTouch(10, 10)).toBe(true);
    // Too small to have said anything: the scroller keeps the touch.
    expect(edgeSwipeClaimsTouch(4, 0)).toBe(false);
  });

  it("leaves a vertical or leftward drag to whatever is under it", () => {
    expect(edgeSwipeClaimsTouch(8, 20)).toBe(false);
    expect(edgeSwipeClaimsTouch(-20, 2)).toBe(false);
  });
});

describe("classifyEdgeSwipeMove", () => {
  it("waits while the drag is too small to mean anything", () => {
    expect(classifyEdgeSwipeMove(4, 2)).toBe("pending");
    expect(classifyEdgeSwipeMove(0, 0)).toBe("pending");
  });

  it("engages on a rightward pull and refuses a leftward one", () => {
    expect(classifyEdgeSwipeMove(20, 4)).toBe("engaged");
    expect(classifyEdgeSwipeMove(-20, 4)).toBe("abandoned");
  });

  it("yields to a drag that is unmistakably vertical", () => {
    expect(classifyEdgeSwipeMove(6, 40)).toBe("abandoned");
    // A thumb arcs: vertical drift that has not out-run the horizontal is still
    // the gesture, not a scroll.
    expect(classifyEdgeSwipeMove(30, 30)).toBe("engaged");
    // Vertical below the yield floor decides nothing on its own.
    expect(classifyEdgeSwipeMove(4, 20)).toBe("pending");
  });

  it("stops yielding once the touch is claimed", () => {
    // The same drags as above, after the scroller has been cut out: there is no
    // scroll left for the vertical to become, so the pull keeps its finger.
    expect(classifyEdgeSwipeMove(6, 40, true)).toBe("pending");
    expect(classifyEdgeSwipeMove(20, 200, true)).toBe("engaged");
    // A finger that reverses past its own start is still not this gesture.
    expect(classifyEdgeSwipeMove(-20, 40, true)).toBe("abandoned");
  });
});

describe("edgeSwipeTravel", () => {
  const width = 400;

  it("follows the finger 1:1 and never goes negative", () => {
    expect(edgeSwipeTravel(120, width)).toBe(120);
    expect(edgeSwipeTravel(-40, width)).toBe(0);
  });

  it("resists past the far edge instead of sliding clean off", () => {
    const limit = width * 0.9;
    expect(edgeSwipeTravel(limit + 100, width)).toBeCloseTo(limit + 25);
    expect(edgeSwipeTravel(limit + 100, width)).toBeLessThan(limit + 100);
  });
});

describe("edgeSwipeCommits", () => {
  const viewportWidth = 400;

  it("commits from a third of the way across", () => {
    expect(edgeSwipeCommits({ travel: 100, viewportWidth, velocity: 0 })).toBe(
      false,
    );
    expect(edgeSwipeCommits({ travel: 140, viewportWidth, velocity: 0 })).toBe(
      true,
    );
  });

  it("lets a flick decide by direction wherever the screen is", () => {
    expect(edgeSwipeCommits({ travel: 30, viewportWidth, velocity: 1.4 })).toBe(
      true,
    );
    // Thrown back at the destination it came from: the screen stays.
    expect(
      edgeSwipeCommits({ travel: 300, viewportWidth, velocity: -1.4 }),
    ).toBe(false);
  });
});

describe("edgeSwipeParallax", () => {
  it("brings the destination home exactly as the screen leaves", () => {
    const width = 400;
    expect(edgeSwipeParallax(0, width)).toBeCloseTo(120);
    expect(edgeSwipeParallax(200, width)).toBeCloseTo(60);
    expect(edgeSwipeParallax(width, width)).toBeCloseTo(0);
    // Past the end (rubber band) it does not push through to the other side.
    expect(edgeSwipeParallax(width + 200, width)).toBeCloseTo(0);
  });
});
