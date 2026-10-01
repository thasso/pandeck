import { describe, expect, it } from "vitest";
import {
  dispatchableThreads,
  firstLineOf,
  groupReviewThreads,
  pendingReviewThreadIds,
  type ReviewThreadView,
} from "./reviewThread.ts";

function thread(
  overrides: Partial<ReviewThreadView> & { id: string },
): ReviewThreadView {
  return {
    state: "open",
    orphaned: false,
    moved: false,
    firstLine: "Comment",
    anchorLabel: "line 1",
    author: "you",
    replies: 0,
    sent: false,
    ...overrides,
  };
}

describe("groupReviewThreads", () => {
  it("keeps the working set, the unreachable, and the history apart", () => {
    const groups = groupReviewThreads([
      thread({ id: "open" }),
      thread({ id: "lost", orphaned: true }),
      thread({ id: "done", state: "resolved" }),
      // A resolved thread whose passage is also gone is still history, not a
      // working item: the state decides the group first.
      thread({ id: "done-lost", state: "resolved", orphaned: true }),
    ]);
    expect(groups.open.map((t) => t.id)).toEqual(["open"]);
    expect(groups.orphaned.map((t) => t.id)).toEqual(["lost"]);
    expect(groups.resolved.map((t) => t.id)).toEqual(["done", "done-lost"]);
  });

  it("offers open threads for dispatch whether or not they are still located", () => {
    const groups = groupReviewThreads([
      thread({ id: "a" }),
      thread({ id: "b", orphaned: true }),
      thread({ id: "c", state: "resolved" }),
    ]);
    expect(dispatchableThreads(groups).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("pendingReviewThreadIds", () => {
  it("is the review in progress: open threads no session has seen yet", () => {
    expect(
      pendingReviewThreadIds([
        thread({ id: "fresh" }),
        thread({ id: "already", sent: true }),
        // An unanchored thread is still part of the review — it is open work.
        thread({ id: "lost-fresh", orphaned: true }),
        // Resolved threads are never pending, even if they were never sent.
        thread({ id: "done", state: "resolved" }),
      ]),
    ).toEqual(["fresh", "lost-fresh"]);
  });
});

describe("firstLineOf", () => {
  it("takes the first line with content and bounds it", () => {
    expect(firstLineOf("\n\n  Second thoughts\nand more")).toBe(
      "Second thoughts",
    );
    expect(firstLineOf("")).toBe("");
    expect(firstLineOf(null)).toBe("");
    expect(firstLineOf("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
