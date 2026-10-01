import { describe, expect, it } from "vitest";
import {
  clampPanelWidth,
  MAIN_MIN_WIDTH,
  maxPanelWidth,
} from "./panelSizing.ts";

describe("maxPanelWidth", () => {
  it("reserves the main pane minimum", () => {
    expect(maxPanelWidth(220, 1280)).toBe(1280 - MAIN_MIN_WIDTH);
  });

  it("subtracts width reserved by the opposite panel", () => {
    expect(maxPanelWidth(260, 1280, 300)).toBe(1280 - 300 - MAIN_MIN_WIDTH);
  });

  it("never drops below the panel minimum on small viewports", () => {
    expect(maxPanelWidth(220, 400)).toBe(220);
    expect(maxPanelWidth(260, 500, 300)).toBe(260);
  });
});

describe("clampPanelWidth", () => {
  it("passes through widths inside the allowed range", () => {
    expect(clampPanelWidth(300, 220, 1280)).toBe(300);
  });

  it("rounds fractional widths", () => {
    expect(clampPanelWidth(300.6, 220, 1280)).toBe(301);
  });

  it("clamps below the minimum up", () => {
    expect(clampPanelWidth(100, 220, 1280)).toBe(220);
  });

  it("clamps above the maximum down", () => {
    expect(clampPanelWidth(2000, 220, 1280)).toBe(1280 - MAIN_MIN_WIDTH);
  });
});
