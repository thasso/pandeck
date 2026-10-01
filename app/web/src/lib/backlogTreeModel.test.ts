import { describe, expect, it } from "vitest";
import type { TaskStatus } from "@assistant/shared";
import {
  ALL_STATUSES,
  statusFilterActive,
  statusFilterFor,
} from "./backlogTreeModel.ts";

const FOCUS_OPTIONS: readonly TaskStatus[] = ["todo", "doing"];

describe("statusFilterActive", () => {
  it("treats empty and all-three as no filter", () => {
    expect(statusFilterActive(new Set())).toBe(false);
    expect(statusFilterActive(new Set(ALL_STATUSES))).toBe(false);
  });

  it("is active only for a strict, non-empty subset", () => {
    expect(statusFilterActive(new Set<TaskStatus>(["todo"]))).toBe(true);
    expect(statusFilterActive(new Set<TaskStatus>(["todo", "doing"]))).toBe(
      true,
    );
  });
});

describe("statusFilterFor over all three statuses", () => {
  it("returns null — show everything — for empty and for all", () => {
    expect(statusFilterFor(new Set())).toBeNull();
    expect(statusFilterFor(new Set(ALL_STATUSES))).toBeNull();
  });

  it("returns the subset when one is genuinely selected", () => {
    expect([...statusFilterFor(new Set<TaskStatus>(["doing"]))!]).toEqual([
      "doing",
    ]);
  });
});

describe("statusFilterFor over a view's OFFERED statuses", () => {
  it("ignores a status the view does not offer", () => {
    // Focus never shows done. The default persisted set is all three, and that
    // must read as "no filter" there rather than as a strict subset.
    expect(statusFilterFor(new Set(ALL_STATUSES), FOCUS_OPTIONS)).toBeNull();
    expect(
      statusFilterFor(new Set<TaskStatus>(["todo", "doing"]), FOCUS_OPTIONS),
    ).toBeNull();
  });

  it("returns null when NOTHING the view offers is selected", () => {
    // The regression: turning both visible Focus chips off left `{done}`, which
    // read as a strict subset of all three — so Focus filtered to done, a status
    // it never shows, and the list went blank. Within its own options that is
    // "empty", which means no filter.
    expect(
      statusFilterFor(new Set<TaskStatus>(["done"]), FOCUS_OPTIONS),
    ).toBeNull();
    expect(statusFilterFor(new Set(), FOCUS_OPTIONS)).toBeNull();
  });

  it("still narrows to a real subset of the offered statuses", () => {
    expect([
      ...statusFilterFor(new Set<TaskStatus>(["todo", "done"]), FOCUS_OPTIONS)!,
    ]).toEqual(["todo"]);
    expect([
      ...statusFilterFor(new Set<TaskStatus>(["doing"]), FOCUS_OPTIONS)!,
    ]).toEqual(["doing"]);
  });
});
