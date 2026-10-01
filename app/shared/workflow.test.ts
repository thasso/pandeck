import { describe, expect, it } from "vitest";
import {
  applyWorkflowRunLimits,
  defaultWorkflowRunLimits,
  normalizeWorkflowRunLimits,
  raiseWorkflowRunLimits,
} from "./workflow.ts";

describe("applyWorkflowRunLimits", () => {
  const base = defaultWorkflowRunLimits();

  it("clamps each ceiling into its own bounds", () => {
    expect(
      applyWorkflowRunLimits(base, {
        maxIterations: 99,
        maxReviewPasses: 0,
      }),
    ).toEqual({ maxIterations: 10, maxReviewPasses: 1 });
  });

  it("changes only what the patch names", () => {
    expect(applyWorkflowRunLimits(base, { maxReviewPasses: 4 })).toEqual({
      maxIterations: base.maxIterations,
      maxReviewPasses: 4,
    });
    expect(applyWorkflowRunLimits(base, { maxIterations: 1 })).toEqual({
      maxIterations: 1,
      maxReviewPasses: base.maxReviewPasses,
    });
  });

  it("keeps the two ceilings independent of each other", () => {
    // They bound different events — independent opinions, and fix round trips
    // — and the sessions a run opens follow from both rather than being
    // rationed beside them, so raising one never moves the other.
    const opinions = applyWorkflowRunLimits(base, { maxReviewPasses: 5 });
    expect(opinions.maxIterations).toBe(base.maxIterations);
    const rounds = applyWorkflowRunLimits(base, { maxIterations: 10 });
    expect(rounds.maxReviewPasses).toBe(base.maxReviewPasses);
  });

  it("allows a run that reviews but never fixes automatically", () => {
    // "Three opinions, and no agent touches the code again without me" is a
    // meaningful configuration, not one to be repaired into something else.
    expect(
      applyWorkflowRunLimits(base, { maxIterations: 0, maxReviewPasses: 3 }),
    ).toEqual({ maxIterations: 0, maxReviewPasses: 3 });
  });
});

describe("normalizeWorkflowRunLimits", () => {
  it("falls back to the recommended defaults", () => {
    expect(normalizeWorkflowRunLimits(undefined)).toEqual(
      defaultWorkflowRunLimits(),
    );
  });

  it("repairs a stale stored set rather than dropping it", () => {
    expect(normalizeWorkflowRunLimits({ maxReviewPasses: 99 })).toEqual({
      maxIterations: defaultWorkflowRunLimits().maxIterations,
      maxReviewPasses: 5,
    });
  });

  it("ignores a non-numeric stored value", () => {
    expect(
      normalizeWorkflowRunLimits({
        maxIterations: Number.NaN,
        maxReviewPasses: 2,
      }),
    ).toEqual({
      maxIterations: defaultWorkflowRunLimits().maxIterations,
      maxReviewPasses: 2,
    });
  });
});

describe("raiseWorkflowRunLimits", () => {
  it("accepts a raise beyond the start-form maxima", () => {
    // The start bounds guard a one-tap form against a typo; a raise at an
    // open ceiling gate is the user's explicit decision, so it is never
    // clamped back to them — that clamp is what once made a run at the wire
    // maximum impossible to continue.
    expect(
      raiseWorkflowRunLimits({ maxIterations: 11, maxReviewPasses: 6 }),
    ).toEqual({ maxIterations: 11, maxReviewPasses: 6 });
    expect(
      raiseWorkflowRunLimits({ maxIterations: 40, maxReviewPasses: 25 }),
    ).toEqual({ maxIterations: 40, maxReviewPasses: 25 });
  });

  it("still floors each limit at its minimum and coerces to an integer", () => {
    expect(
      raiseWorkflowRunLimits({ maxIterations: -3, maxReviewPasses: 0 }),
    ).toEqual({ maxIterations: 0, maxReviewPasses: 1 });
    expect(
      raiseWorkflowRunLimits({ maxIterations: 6.4, maxReviewPasses: 5.6 }),
    ).toEqual({ maxIterations: 6, maxReviewPasses: 6 });
  });

  it("turns a garbage number into the minimum, never a silent raise", () => {
    // The engine refuses a raise that moves nothing, so falling to the
    // minimum makes a malformed answer a refused no-op.
    expect(
      raiseWorkflowRunLimits({
        maxIterations: Number.NaN,
        maxReviewPasses: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ maxIterations: 0, maxReviewPasses: 1 });
    expect(raiseWorkflowRunLimits(undefined)).toEqual({
      maxIterations: 0,
      maxReviewPasses: 1,
    });
  });
});
