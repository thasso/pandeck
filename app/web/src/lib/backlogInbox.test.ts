import { describe, expect, it } from "vitest";
import type { Task } from "./backlogTree.ts";
import {
  belongsInInbox,
  buildInboxList,
  hasInboxWork,
  taskOrigin,
} from "./backlogInbox.ts";

function task(patch: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${patch.id}`,
    status: "todo",
    source: { createdBy: "agent" },
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  } as Task;
}

describe("belongsInInbox", () => {
  it("holds a top-level Task an agent created", () => {
    expect(belongsInInbox(task({ id: "a" }))).toBe(true);
  });

  it("never holds a subtask", () => {
    // A coding session decomposing work you already accepted would otherwise
    // fill the Inbox with implementation detail.
    expect(belongsInInbox(task({ id: "a", parentId: "1" }))).toBe(false);
  });

  it("holds an arrival the user is recorded as creating", () => {
    // Slack shortcut intake: created BY the user (they asked for it), never
    // typed into the Backlog. Keying membership on `createdBy` is what used to
    // keep every Slack Task out of the surface advertised for it.
    expect(
      belongsInInbox(task({ id: "a", source: { createdBy: "user" } })),
    ).toBe(true);
  });

  it("does not hold a Task the user typed, which the server triages at birth", () => {
    expect(
      belongsInInbox(
        task({ id: "a", source: { createdBy: "user" }, triagedAt: 1 }),
      ),
    ).toBe(false);
  });

  it("drops a Task once it has been processed", () => {
    expect(belongsInInbox(task({ id: "a", triagedAt: 1 }))).toBe(false);
  });

  it("drops finished work, which needs no decision", () => {
    expect(belongsInInbox(task({ id: "a", status: "done" }))).toBe(false);
  });
});

describe("buildInboxList", () => {
  it("puts the newest arrival first", () => {
    const list = buildInboxList([
      task({ id: "old", createdAt: 100 }),
      task({ id: "new", createdAt: 300 }),
      task({ id: "mid", createdAt: 200 }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("filters as it sorts", () => {
    const list = buildInboxList([
      task({ id: "keep", createdAt: 2 }),
      task({ id: "subtask", parentId: "1", createdAt: 3 }),
      task({
        id: "typed",
        source: { createdBy: "user" },
        triagedAt: 1,
        createdAt: 4,
      }),
      task({ id: "processed", triagedAt: 1, createdAt: 5 }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["keep"]);
  });
});

describe("hasInboxWork", () => {
  it("is false when everything has been processed", () => {
    expect(hasInboxWork([task({ id: "a", triagedAt: 1 })])).toBe(false);
    expect(hasInboxWork([])).toBe(false);
  });

  it("is true while anything waits", () => {
    expect(
      hasInboxWork([task({ id: "a", triagedAt: 1 }), task({ id: "b" })]),
    ).toBe(true);
  });
});

describe("taskOrigin", () => {
  it("prefers a real external source over the persona that recorded it", () => {
    // What produced the Task is more useful than which agent wrote it down.
    expect(
      taskOrigin(
        task({
          id: "a",
          externalLinks: [
            { url: "https://slack.com/x", source: "slack", type: "source" },
          ],
        }),
      ),
    ).toBe("From Slack");
    expect(
      taskOrigin(
        task({
          id: "b",
          externalLinks: [
            { url: "https://jira/x", source: "jira", type: "source" },
          ],
        }),
      ),
    ).toBe("From Jira");
  });

  it("names the persona when there is no external source", () => {
    expect(
      taskOrigin(
        task({
          id: "a",
          source: { createdBy: "agent", agentType: "developer" },
        }),
      ),
    ).toBe("From a coding session");
    expect(
      taskOrigin(
        task({
          id: "b",
          source: { createdBy: "agent", agentType: "assistant" },
        }),
      ),
    ).toBe("From the assistant");
  });

  it("degrades to a generic phrase rather than printing an internal key", () => {
    expect(
      taskOrigin(
        task({
          id: "a",
          source: {
            createdBy: "agent",
            agentType: "some-new-persona",
          } as never,
        }),
      ),
    ).toBe("From an agent");
    expect(taskOrigin(task({ id: "b", source: { createdBy: "agent" } }))).toBe(
      "From an agent",
    );
  });

  it("names the external source of a user-created ARRIVAL rather than claiming you wrote it", () => {
    // The Slack shortcut records the user as creator; the link is what says
    // where it actually came from.
    expect(
      taskOrigin(
        task({
          id: "a",
          source: { createdBy: "user" },
          externalLinks: [
            { url: "https://slack.com/x", source: "slack", type: "source" },
          ],
        }),
      ),
    ).toBe("From Slack");
  });
});
