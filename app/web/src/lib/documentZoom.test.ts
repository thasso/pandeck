import { describe, expect, it } from "vitest";
import { clampDocumentZoom, steppedDocumentZoom } from "./documentZoom.ts";

describe("document zoom math", () => {
  it("clamps text and visual content to their own readable bounds", () => {
    expect(clampDocumentZoom("text", 0.1)).toBe(0.75);
    expect(clampDocumentZoom("text", 9)).toBe(2);
    expect(clampDocumentZoom("visual", 0.1)).toBe(0.5);
    expect(clampDocumentZoom("visual", 9)).toBe(4);
  });

  it("steps symmetrically and stops at bounds", () => {
    expect(steppedDocumentZoom("text", 1, 1)).toBe(1.25);
    expect(steppedDocumentZoom("text", 1, -1)).toBe(0.75);
    expect(steppedDocumentZoom("text", 2, 1)).toBe(2);
  });
});
