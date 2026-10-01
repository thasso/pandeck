import { describe, expect, it } from "vitest";
import { dockMode } from "./dockState.ts";

const base = {
  mobile: true,
  browserScreen: false,
  expanded: false,
  hasPeek: true,
};

describe("dockMode", () => {
  it("is hidden on the desktop layout, which keeps the inline right panel", () => {
    expect(dockMode({ ...base, mobile: false })).toBe("hidden");
    expect(dockMode({ ...base, mobile: false, expanded: true })).toBe("hidden");
  });

  it("rests as a non-modal peek when the screen has a peek row", () => {
    expect(dockMode(base)).toBe("peek");
  });

  it("expands when the user opens the inspector", () => {
    expect(dockMode({ ...base, expanded: true })).toBe("expanded");
  });

  it("still expands on a screen that owns its own bottom row (session composer)", () => {
    // The session screen passes no peek row — the composer's compact bar carries
    // the dock's handle — but the sheet it opens is the same one.
    expect(dockMode({ ...base, hasPeek: false })).toBe("hidden");
    expect(dockMode({ ...base, hasPeek: false, expanded: true })).toBe(
      "expanded",
    );
  });

  it("is hidden on a browser screen, expanded or not: there is no main-pane object", () => {
    expect(dockMode({ ...base, browserScreen: true })).toBe("hidden");
    expect(dockMode({ ...base, browserScreen: true, expanded: true })).toBe(
      "hidden",
    );
  });
});
