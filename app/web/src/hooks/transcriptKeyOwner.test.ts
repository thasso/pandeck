// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimScrollKeys, ownsScrollKey } from "./transcriptKeyOwner.ts";

function transcript(): HTMLElement {
  const element = document.createElement("div");
  element.append(document.createElement("p"));
  document.body.append(element);
  vi.spyOn(element, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("scroll key ownership between two transcripts", () => {
  it("gives an unfocused key to the transcript last touched, and only it", () => {
    const center = transcript();
    const panel = transcript();
    claimScrollKeys(panel);
    expect(ownsScrollKey(center, document.body)).toBe(false);
    expect(ownsScrollKey(panel, document.body)).toBe(true);
  });

  it("gives a key inside a transcript to that transcript", () => {
    const center = transcript();
    const panel = transcript();
    claimScrollKeys(panel);
    expect(ownsScrollKey(center, center.firstElementChild as HTMLElement)).toBe(
      true,
    );
    expect(ownsScrollKey(panel, document.body)).toBe(false);
  });

  it("does not leave the keys with a transcript that left the screen", () => {
    const center = transcript();
    const panel = transcript();
    claimScrollKeys(panel);
    vi.spyOn(panel, "getClientRects").mockReturnValue(
      [] as unknown as DOMRectList,
    );
    expect(ownsScrollKey(center, document.body)).toBe(true);
  });
});
