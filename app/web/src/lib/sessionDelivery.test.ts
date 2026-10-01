import { describe, expect, it } from "vitest";
import type { SessionPullRequestSummary } from "@assistant/shared";
import {
  sessionDelivery,
  sessionDeliveryKey,
  sessionDeliveryState,
} from "./sessionDelivery.ts";

const OPEN: SessionPullRequestSummary = { status: "open", number: 12 };

describe("sessionDeliveryState", () => {
  it("states the card's own states before the pull request exists", () => {
    expect(sessionDeliveryState({ status: "choosing-task" })).toBe(
      "choosing-task",
    );
    expect(sessionDeliveryState({ status: "creating" })).toBe("creating");
    expect(sessionDeliveryState({ status: "failed" })).toBe("failed");
  });

  /**
   * The one that cannot self-correct: the watcher fetches CI for the merged
   * head and stops polling the moment the card leaves `open`, so a merge over a
   * red required check would have said "CI failed" about a shipped pull request
   * for as long as the row existed.
   */
  it("lets nothing outrank a terminal status", () => {
    expect(
      sessionDeliveryState({
        ...OPEN,
        status: "merged",
        ci: { state: "failure", total: 2 },
        review: { changesRequested: true },
        conflicts: true,
      }),
    ).toBe("merged");
    expect(
      sessionDeliveryState({
        ...OPEN,
        status: "closed",
        ci: { state: "pending", total: 2 },
      }),
    ).toBe("closed");
  });

  // A draft is open but not up for review — so it takes the LAST rung, and
  // anything that is actually asking still outranks it.
  it("names a draft on the rung a plain open PR would take", () => {
    expect(sessionDeliveryState({ ...OPEN, draft: true })).toBe("draft");
    expect(
      sessionDeliveryState({
        ...OPEN,
        draft: true,
        review: { changesRequested: false, unresolvedThreads: 1 },
      }),
    ).toBe("review-requested");
    expect(
      sessionDeliveryState({
        ...OPEN,
        draft: true,
        ci: { state: "failure", total: 1 },
      }),
    ).toBe("ci-failed");
  });

  it("ranks the pull request on the shared ladder", () => {
    expect(
      sessionDeliveryState({ ...OPEN, ci: { state: "failure", total: 4 } }),
    ).toBe("ci-failed");
    expect(
      sessionDeliveryState({ ...OPEN, review: { changesRequested: true } }),
    ).toBe("review-requested");
    expect(
      sessionDeliveryState({ ...OPEN, ci: { state: "pending", total: 2 } }),
    ).toBe("ci-pending");
    expect(sessionDeliveryState(OPEN)).toBe("open");
    expect(sessionDeliveryState({ ...OPEN, status: "merged" })).toBe("merged");
  });

  // The conflict is the card's own state, and it goes UNDER the red checks
  // rather than reordering the ladder the other surfaces read.
  it("puts a conflict below failed checks and above a review", () => {
    expect(sessionDeliveryState({ ...OPEN, conflicts: true })).toBe(
      "conflicts",
    );
    expect(
      sessionDeliveryState({
        ...OPEN,
        conflicts: true,
        review: { changesRequested: true },
      }),
    ).toBe("conflicts");
    expect(
      sessionDeliveryState({
        ...OPEN,
        conflicts: true,
        ci: { state: "error", total: 1 },
      }),
    ).toBe("ci-failed");
  });

  // A closed pull request asks nothing, but the session still OWNS it — which
  // is the question this indicator exists to answer.
  it("keeps a closed pull request stated rather than dropping it", () => {
    expect(sessionDeliveryState({ ...OPEN, status: "closed" })).toBe("closed");
    expect(
      sessionDelivery({ pullRequest: { ...OPEN, status: "closed" } }),
    ).toEqual({
      state: "closed",
      tone: "muted",
      label: "Closed",
      title: "Closed without merging · PR #12",
    });
  });
});

describe("sessionDelivery", () => {
  it("is absent for a session with no card", () => {
    expect(sessionDelivery({})).toBeNull();
    expect(sessionDeliveryKey({})).toBe("");
  });

  it("states an open pull request as its number", () => {
    expect(sessionDelivery({ pullRequest: OPEN })).toEqual({
      state: "open",
      tone: "muted",
      label: "PR #12",
      title: "A pull request is open · PR #12",
    });
  });

  it("puts what the chip cannot fit in the title", () => {
    expect(
      sessionDelivery({
        pullRequest: { ...OPEN, ci: { state: "failure", total: 3 } },
      })?.title,
    ).toBe("Checks failed · 3 checks · PR #12");
    expect(
      sessionDelivery({
        pullRequest: {
          ...OPEN,
          review: { changesRequested: false, unresolvedThreads: 1 },
        },
      })?.title,
    ).toBe("Review pending · 1 unresolved thread · PR #12");
    // Nothing to name it by yet: a card that has not created the PR has no
    // number, and the title must not pretend otherwise.
    expect(
      sessionDelivery({ pullRequest: { status: "creating" } })?.title,
    ).toBe("The pull request is being opened");
  });

  it("states a draft as a draft", () => {
    expect(sessionDelivery({ pullRequest: { ...OPEN, draft: true } })).toEqual({
      state: "draft",
      tone: "muted",
      label: "Draft",
      title: "A draft pull request is open — not up for review yet · PR #12",
    });
  });

  // The key is what stops a row freezing on the state it first rendered.
  it("moves its key when only the pull request moved", () => {
    const before = sessionDeliveryKey({ pullRequest: OPEN });
    expect(
      sessionDeliveryKey({
        pullRequest: { ...OPEN, ci: { state: "pending", total: 2 } },
      }),
    ).not.toBe(before);
    expect(
      sessionDeliveryKey({ pullRequest: { ...OPEN, number: 13 } }),
    ).not.toBe(before);
    expect(sessionDeliveryKey({ pullRequest: { ...OPEN } })).toBe(before);
  });
});
