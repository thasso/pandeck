import { describe, expect, it } from "vitest";
import { transcriptWindowStart } from "./transcriptWindow.ts";

const rows = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, i) => ({ key: `m${i + offset}` }));
const keyAt = (list: Array<{ key: string }>, index: number) => list[index]!.key;

describe("transcriptWindowStart", () => {
  it("renders the newest rows and hides the rest", () => {
    expect(transcriptWindowStart(rows(500), 120, null)).toBe(380);
    expect(transcriptWindowStart(rows(40), 120, null)).toBe(0);
  });

  it("keeps a shown row shown when new messages arrive", () => {
    const start = transcriptWindowStart(rows(500), 120, null);
    const topKey = keyAt(rows(500), start);
    // Ten more messages land: the window grows at the tail, it does not slide.
    expect(transcriptWindowStart(rows(510), 120, topKey)).toBe(start);
  });

  it("grows when the limit grows", () => {
    const start = transcriptWindowStart(rows(500), 120, null);
    const topKey = keyAt(rows(500), start);
    expect(transcriptWindowStart(rows(500), 360, topKey)).toBe(140);
  });

  it("re-anchors on the ROW when a preview resolves into the full transcript", () => {
    // While the preview is displayed the transcript is short, so nothing is hidden.
    const preview = rows(40, 460);
    expect(transcriptWindowStart(preview, 120, null)).toBe(0);
    const topKey = keyAt(preview, 0);
    // The full transcript arrives with 460 older rows in front of the same rows.
    expect(transcriptWindowStart(rows(500), 120, topKey)).toBe(380);
  });

  it("falls back to the plain window when the anchor is gone", () => {
    expect(transcriptWindowStart(rows(500), 120, "not-in-this-session")).toBe(
      380,
    );
  });
});
