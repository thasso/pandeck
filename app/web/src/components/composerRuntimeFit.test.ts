import { describe, expect, it } from "vitest";
import {
  COMPOSER_GROUP_GAP,
  COMPOSER_ROW_GAP,
  type ComposerRuntimeFit,
  runtimeControlsFit,
  sameComposerRuntimeFit,
} from "./composerRuntimeFit.ts";

const fit = (over: Partial<ComposerRuntimeFit> = {}): ComposerRuntimeFit => ({
  signature: "build|developer|anthropic:Opus 5|high||",
  rowWidth: 640,
  leadWidth: 64,
  trailWidth: 128,
  controlsWidth: 320,
  ...over,
});

describe("composer runtime fit", () => {
  it("keeps the strip inline while the row can hold it", () => {
    expect(runtimeControlsFit(fit())).toBe(true);
  });

  it("folds the strip once the groups plus their gaps exceed the row", () => {
    // 64 + 4 + 320 + 8 + 128 = 524, so 524 fits exactly and 523 does not.
    const exact =
      64 + COMPOSER_GROUP_GAP + 320 + COMPOSER_ROW_GAP + 128; /* = 524 */
    expect(runtimeControlsFit(fit({ rowWidth: exact }))).toBe(true);
    expect(runtimeControlsFit(fit({ rowWidth: exact - 1 }))).toBe(false);
  });

  it("folds when the send cluster grows rather than when the row shrinks", () => {
    expect(runtimeControlsFit(fit({ rowWidth: 530, trailWidth: 128 }))).toBe(
      true,
    );
    expect(runtimeControlsFit(fit({ rowWidth: 530, trailWidth: 160 }))).toBe(
      false,
    );
  });

  it("never folds on a measurement that means 'unknown'", () => {
    // A composer that has not been laid out (hidden, or the first pass) and a
    // strip that has never been shown both have to render it and measure.
    expect(runtimeControlsFit(fit({ rowWidth: 0 }))).toBe(true);
    expect(runtimeControlsFit(fit({ rowWidth: 100, controlsWidth: 0 }))).toBe(
      true,
    );
  });

  it("compares measurements field by field", () => {
    expect(sameComposerRuntimeFit(fit(), fit())).toBe(true);
    expect(sameComposerRuntimeFit(fit(), fit({ rowWidth: 641 }))).toBe(false);
    expect(sameComposerRuntimeFit(fit(), fit({ signature: "plan" }))).toBe(
      false,
    );
  });
});
