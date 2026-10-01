// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { embeddedPdfScrolls, pdfZoomMode } from "./embeddedPdf.ts";

/**
 * The feature test stands in for "is this iOS/iPadOS WebKit", which is the one
 * engine that cannot scroll a framed PDF. It must answer the optimistic way
 * wherever the feature query itself is unavailable: a viewer that hides a
 * perfectly good embedded document is the worse failure.
 */

afterEach(() => vi.unstubAllGlobals());

it("keeps the frame on an engine without the iOS-only CSS feature", () => {
  vi.stubGlobal("CSS", { supports: () => false });
  expect(embeddedPdfScrolls()).toBe(true);
});

it("keeps the frame where the feature query is unavailable", () => {
  vi.stubGlobal("CSS", undefined);
  expect(embeddedPdfScrolls()).toBe(true);
});

it("reports no scrolling on iOS/iPadOS WebKit", () => {
  stubIosWebKit();
  expect(embeddedPdfScrolls()).toBe(false);
});

it("zooms an embedded PDF as a picture and the fallback panel not at all", () => {
  vi.stubGlobal("CSS", { supports: () => false });
  expect(pdfZoomMode()).toBe("visual");
  stubIosWebKit();
  // The panel is not the document: the controls would move a scale nothing on
  // screen reads, so the viewer registers no zoom at all.
  expect(pdfZoomMode()).toBeNull();
});

function stubIosWebKit(): void {
  vi.stubGlobal("CSS", {
    supports: (property: string, value: string) =>
      property === "-webkit-touch-callout" && value === "none",
  });
}
