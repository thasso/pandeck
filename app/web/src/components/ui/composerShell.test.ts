import { describe, expect, it } from "vitest";
import { autosizeComposerField } from "./composerShell.ts";

function field(options: {
  value: string;
  oneRowHeight: number;
  scrollHeight: number;
  height?: string;
}): HTMLTextAreaElement {
  return {
    value: options.value,
    style: { height: options.height ?? "" },
    scrollHeight: options.scrollHeight,
    getBoundingClientRect: () => ({ height: options.oneRowHeight }) as DOMRect,
  } as unknown as HTMLTextAreaElement;
}

describe("autosizeComposerField", () => {
  it("leaves a one-line draft at the same intrinsic height as the placeholder", () => {
    const textarea = field({
      value: "a",
      oneRowHeight: 33.59375,
      scrollHeight: 34,
      height: "34px",
    });

    autosizeComposerField(textarea, 240);

    expect(textarea.style.height).toBe("");
  });

  it("grows for additional lines and caps the result", () => {
    const growing = field({
      value: "first\nsecond",
      oneRowHeight: 33.59375,
      scrollHeight: 60,
    });
    autosizeComposerField(growing, 240);
    expect(growing.style.height).toBe("60px");

    const capped = field({
      value: "many lines",
      oneRowHeight: 33.59375,
      scrollHeight: 300,
    });
    autosizeComposerField(capped, 240);
    expect(capped.style.height).toBe("240px");
  });

  it("clears a stale measured height for an empty draft", () => {
    const textarea = field({
      value: "",
      oneRowHeight: 33.59375,
      scrollHeight: 34,
      height: "60px",
    });

    autosizeComposerField(textarea, 240);

    expect(textarea.style.height).toBe("");
  });
});
