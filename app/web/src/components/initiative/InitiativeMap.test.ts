/**
 * Where the Initiative map opens (`InitiativeMap.tsx`).
 *   pnpm --filter @assistant/web test src/components/initiative/InitiativeMap.test.ts
 */
import { describe, expect, it } from "vitest";
import { initialViewport } from "./InitiativeMap.tsx";

describe("initialViewport", () => {
  it("shows a small map whole and centred", () => {
    const view = initialViewport(
      { width: 800, height: 400 },
      { width: 1200, height: 800 },
    );
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(200);
    expect(view.y).toBe(200);
  });

  it("opens a Hosted Labs-sized map readable, from its left edge", () => {
    const view = initialViewport(
      { width: 3356, height: 1048 },
      { width: 1024, height: 860 },
    );
    expect(view.zoom).toBeGreaterThanOrEqual(0.6);
    expect(view.zoom).toBeCloseTo(828 / 1048, 5);
    expect(view.x).toBe(16);
  });

  it("never opens below the readable zoom, even for a very tall map", () => {
    const view = initialViewport(
      { width: 3000, height: 6000 },
      { width: 1024, height: 700 },
    );
    expect(view.zoom).toBe(0.6);
    expect(view.y).toBe(16);
  });
});
