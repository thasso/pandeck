import { describe, expect, it } from "vitest";
import { clampDockDragOffset, resolveDockDrag } from "./dockDrag.ts";

describe("resolveDockDrag", () => {
  const travel = 600;

  it("opens from the upper half of the travel and falls back from the lower half", () => {
    expect(resolveDockDrag({ offset: 100, travel, velocity: 0 })).toBe(
      "expanded",
    );
    expect(resolveDockDrag({ offset: 300, travel, velocity: 0 })).toBe(
      "expanded",
    );
    expect(resolveDockDrag({ offset: 320, travel, velocity: 0 })).toBe("peek");
  });

  it("lets a flick decide by direction wherever the card is", () => {
    // A flick leaves the glass early; requiring half the travel would make the
    // gesture feel broken exactly when the user was most decisive.
    expect(resolveDockDrag({ offset: 560, travel, velocity: -1.2 })).toBe(
      "expanded",
    );
    expect(resolveDockDrag({ offset: 20, travel, velocity: 1.2 })).toBe("peek");
  });

  it("treats a card with nowhere to travel as open", () => {
    // Nothing below the header has been measured yet, so there is no peek
    // position to fall back to.
    expect(resolveDockDrag({ offset: 0, travel: 0, velocity: 5 })).toBe(
      "expanded",
    );
  });
});

describe("clampDockDragOffset", () => {
  it("follows the finger 1:1 between the two rest positions", () => {
    expect(clampDockDragOffset(0, 400)).toBe(0);
    expect(clampDockDragOffset(180, 400)).toBe(180);
    expect(clampDockDragOffset(400, 400)).toBe(400);
  });

  it("damps a pull past either end", () => {
    expect(clampDockDragOffset(-100, 400)).toBeCloseTo(-12);
    expect(clampDockDragOffset(500, 400)).toBeCloseTo(412);
  });
});
