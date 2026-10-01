import { describe, expect, it } from "vitest";
import type { Task } from "./backlogTree.ts";
import {
  buildFocusBuckets,
  dueLabel,
  effectiveFocusDate,
  focusBucketFor,
  priorityRank,
  scheduledLabel,
} from "./backlogFocus.ts";

// 2026-07-29 is a Wednesday, so the ISO week closes on Sunday 2026-08-02.
const TODAY = "2026-07-29";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${patch.id}`,
    status: "todo",
    source: { createdBy: "user" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task;
}

describe("focusBucketFor", () => {
  it("buckets a due date by its distance from today", () => {
    expect(
      focusBucketFor(task({ id: "a", dueDate: "2026-07-01" }), TODAY),
    ).toBe("overdue");
    expect(focusBucketFor(task({ id: "b", dueDate: TODAY }), TODAY)).toBe(
      "today",
    );
    expect(
      focusBucketFor(task({ id: "c", dueDate: "2026-07-30" }), TODAY),
    ).toBe("tomorrow");
    // Friday and the closing Sunday both still fall inside this week.
    expect(
      focusBucketFor(task({ id: "d", dueDate: "2026-07-31" }), TODAY),
    ).toBe("week");
    expect(
      focusBucketFor(task({ id: "e", dueDate: "2026-08-02" }), TODAY),
    ).toBe("week");
    expect(
      focusBucketFor(task({ id: "f", dueDate: "2026-08-03" }), TODAY),
    ).toBe("later");
  });

  it("treats a missing due date as unscheduled", () => {
    expect(focusBucketFor(task({ id: "a" }), TODAY)).toBe("unscheduled");
  });
});

describe("priorityRank", () => {
  it("ranks urgent first and treats a missing priority as normal", () => {
    expect(priorityRank("urgent")).toBeLessThan(priorityRank("high"));
    expect(priorityRank("high")).toBeLessThan(priorityRank("normal"));
    expect(priorityRank("low")).toBeGreaterThan(priorityRank("normal"));
    expect(priorityRank(undefined)).toBe(priorityRank("normal"));
  });
});

describe("buildFocusBuckets", () => {
  it("orders the buckets and drops the empty ones", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "later", dueDate: "2026-09-01" }),
        task({ id: "none" }),
        task({ id: "late", dueDate: "2026-07-02" }),
      ],
      TODAY,
    );
    expect(buckets.map((bucket) => bucket.id)).toEqual([
      "overdue",
      "later",
      "unscheduled",
    ]);
  });

  it("sorts by priority inside a bucket, not across buckets", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "ordinary-today", dueDate: TODAY }),
        task({ id: "urgent-later", dueDate: "2026-09-01", priority: "urgent" }),
        task({ id: "urgent-today", dueDate: TODAY, priority: "urgent" }),
      ],
      TODAY,
    );
    // The urgent task due in September must not outrank today's work.
    expect(buckets[0]!.id).toBe("today");
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual([
      "urgent-today",
      "ordinary-today",
    ]);
    expect(buckets[1]!.tasks.map((t) => t.id)).toEqual(["urgent-later"]);
  });

  it("breaks a priority tie on the nearer deadline, then the most recent update", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "far", dueDate: "2026-09-10" }),
        task({ id: "near-stale", dueDate: "2026-09-01", updatedAt: 10 }),
        task({ id: "near-fresh", dueDate: "2026-09-01", updatedAt: 20 }),
      ],
      TODAY,
    );
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual([
      "near-fresh",
      "near-stale",
      "far",
    ]);
  });

  it("keeps a subtask in its own bucket rather than under its parent", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "parent", dueDate: "2026-09-01" }),
        task({ id: "child", parentId: "parent", dueDate: TODAY }),
      ],
      TODAY,
    );
    expect(buckets[0]!.id).toBe("today");
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual(["child"]);
  });
});

describe("dueLabel", () => {
  it("is relative near today and absolute further out", () => {
    expect(dueLabel(task({ id: "a", dueDate: TODAY }), TODAY)).toBe("Today");
    expect(dueLabel(task({ id: "b", dueDate: "2026-07-30" }), TODAY)).toBe(
      "Tomorrow",
    );
    expect(dueLabel(task({ id: "c", dueDate: "2026-07-31" }), TODAY)).toBe(
      "Fri",
    );
    expect(dueLabel(task({ id: "d", dueDate: "2026-09-01" }), TODAY)).toBe(
      "1 Sep",
    );
  });

  it("counts how late an overdue task is", () => {
    expect(dueLabel(task({ id: "a", dueDate: "2026-07-28" }), TODAY)).toBe(
      "1d late",
    );
    expect(dueLabel(task({ id: "b", dueDate: "2026-07-26" }), TODAY)).toBe(
      "3d late",
    );
  });

  it("says nothing when there is no deadline", () => {
    expect(dueLabel(task({ id: "a" }), TODAY)).toBeNull();
  });
});

describe("effectiveFocusDate", () => {
  it("takes whichever of the plan and the deadline comes first", () => {
    // Planned today, due in a fortnight: the plan pulls it forward.
    expect(
      effectiveFocusDate(
        task({ id: "a", scheduledFor: TODAY, dueDate: "2026-08-12" }),
      ),
    ).toBe(TODAY);
    // Due today, planned for Friday: the deadline pulls it forward.
    expect(
      effectiveFocusDate(
        task({ id: "b", scheduledFor: "2026-07-31", dueDate: TODAY }),
      ),
    ).toBe(TODAY);
  });

  it("falls back to whichever date exists, and to neither", () => {
    expect(effectiveFocusDate(task({ id: "a", scheduledFor: TODAY }))).toBe(
      TODAY,
    );
    expect(effectiveFocusDate(task({ id: "b", dueDate: TODAY }))).toBe(TODAY);
    expect(effectiveFocusDate(task({ id: "c" }))).toBeUndefined();
  });
});

describe("focus bucketing with a plan", () => {
  it("puts a task planned for today in Today even when it is not due for weeks", () => {
    expect(
      focusBucketFor(
        task({ id: "a", scheduledFor: TODAY, dueDate: "2026-08-20" }),
        TODAY,
      ),
    ).toBe("today");
  });

  it("still surfaces a near deadline that was planned for later", () => {
    // The whole point of taking the earlier date: planning cannot bury a deadline.
    expect(
      focusBucketFor(
        task({ id: "a", scheduledFor: "2026-08-20", dueDate: TODAY }),
        TODAY,
      ),
    ).toBe("today");
  });

  it("treats a plan that has come and gone as overdue", () => {
    expect(
      focusBucketFor(task({ id: "a", scheduledFor: "2026-07-27" }), TODAY),
    ).toBe("overdue");
  });

  it("groups a planned task with the rest of that day's work", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "planned", scheduledFor: TODAY }),
        task({ id: "due", dueDate: TODAY }),
      ],
      TODAY,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.id).toBe("today");
    expect(buckets[0]!.tasks.map((t) => t.id).sort()).toEqual([
      "due",
      "planned",
    ]);
  });
});

describe("scheduledLabel", () => {
  it("shows the plan only when it differs from the deadline", () => {
    expect(
      scheduledLabel(
        task({ id: "a", scheduledFor: TODAY, dueDate: "2026-08-20" }),
        TODAY,
      ),
    ).toBe("Today");
    // Same day: the due chip already says it, so the plan chip stays away.
    expect(
      scheduledLabel(
        task({ id: "b", scheduledFor: TODAY, dueDate: TODAY }),
        TODAY,
      ),
    ).toBeNull();
    expect(scheduledLabel(task({ id: "c", dueDate: TODAY }), TODAY)).toBeNull();
  });

  it("reports a slipped plan as elapsed rather than late", () => {
    // "late" is reserved for a missed DEADLINE; a plan only slipped.
    expect(
      scheduledLabel(task({ id: "a", scheduledFor: "2026-07-26" }), TODAY),
    ).toBe("3d ago");
  });
});

describe("the review bucket", () => {
  it("outranks every date, whatever the task was scheduled for", () => {
    // Answering the claim is a yes/no; the date it was planned for is beside
    // the point until that is settled.
    const claimed = task({
      id: "a",
      dueDate: "2026-12-01",
      statusSuggestion: { to: "done", at: 1 },
    });
    expect(focusBucketFor(claimed, TODAY)).toBe("review");
    const alsoClaimed = task({
      id: "b",
      dueDate: "2026-01-01",
      statusSuggestion: { to: "done", at: 1 },
    });
    expect(focusBucketFor(alsoClaimed, TODAY)).toBe("review");
  });

  it("leads the list", () => {
    const buckets = buildFocusBuckets(
      [
        task({ id: "late", dueDate: "2026-07-01" }),
        task({ id: "claimed", statusSuggestion: { to: "done", at: 1 } }),
      ],
      TODAY,
    );
    expect(buckets.map((b) => b.id)).toEqual(["review", "overdue"]);
  });

  it("holds a reopen suggestion on a Task that is already done", () => {
    // "This is not actually finished" is a genuine question, and Focus is the
    // only surface that can answer it.
    const reopen = task({
      id: "a",
      status: "done",
      statusSuggestion: { to: "todo", at: 1 },
    });
    expect(focusBucketFor(reopen, TODAY)).toBe("review");
  });

  it("ignores a suggestion the Task already agrees with", () => {
    // Reached by the userRequestedStatus escape hatch: the agent applied the
    // status the user asked for AND recorded the claim. That is provenance, not
    // a pending question, so it must not sit here asking to be confirmed.
    const answered = task({
      id: "a",
      status: "done",
      dueDate: "2026-07-01",
      statusSuggestion: { to: "done", at: 1 },
    });
    expect(focusBucketFor(answered, TODAY)).toBe("overdue");
  });

  it("puts the longest-ignored suggestion first, whichever kind it is", () => {
    // Oldest first: something an agent called finished a week ago is the one
    // that has been sitting unanswered. Both kinds of suggestion are the same
    // question — "do you agree?" — so they share the bucket and the ordering.
    const buckets = buildFocusBuckets(
      [
        task({
          id: "recent",
          priority: "urgent",
          statusSuggestion: { to: "done", at: 500 },
        }),
        task({
          id: "stale",
          priority: "low",
          status: "doing",
          statusSuggestion: { to: "todo", at: 100 },
        }),
      ],
      TODAY,
    );
    // Priority deliberately does NOT override age here.
    expect(buckets[0]!.tasks.map((t) => t.id)).toEqual(["stale", "recent"]);
  });
});
