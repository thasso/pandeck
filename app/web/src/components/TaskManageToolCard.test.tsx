import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  DisplayBlock,
  TaskSaveRequest,
  TaskSummary,
} from "@assistant/shared";
import { parseTaskManagePayload } from "@assistant/shared/toolCards";
import {
  TaskManageToolCard,
  changeSummary,
  changedOperationKinds,
  recordedSuggestionState,
} from "./TaskManageToolCard.tsx";
import {
  TaskLiveSourceProvider,
  type TaskLiveSource,
} from "./TaskLiveState.tsx";
import { acceptStatusSuggestionSave } from "../lib/backlogTree.ts";
import type { TaskStatusRecord } from "../hooks/useAssistant.ts";
import { renderToolBlock, toolBlockIsVisible } from "./tools/registry.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

function manageBlock(args: unknown, payload: unknown): ToolBlock {
  return {
    kind: "tool",
    toolId: "toolu_01Task",
    name: "mcp__pa__task_manage",
    args,
    output: JSON.stringify({
      renderKind: "taskManage",
      version: 1,
      ...(payload as Record<string, unknown>),
    }),
    isError: false,
    done: true,
  };
}

const createBlock = manageBlock(
  { operations: [{ operation: "create", title: "Render Task mutations" }] },
  {
    changedCount: 1,
    changed: [{ id: "297", title: "Render Task mutations", status: "todo" }],
  },
);

const suggestionBlock = manageBlock(
  {
    operations: [
      { operation: "update", id: "297", status: "done", suggestOnly: true },
    ],
  },
  {
    changedCount: 1,
    changed: [
      {
        id: "297",
        title: "Render Task mutations",
        status: "todo",
        statusSuggestion: { to: "done", at: 5, reason: "tests pass" },
        statusWrite: "suggested",
        descriptionEditsApplied: 1,
      },
    ],
  },
);

describe("task_manage payload", () => {
  it("reads the mutations, deletions and warnings", () => {
    const payload = parseTaskManagePayload(suggestionBlock.output);
    expect(payload?.changed).toHaveLength(1);
    expect(payload?.changed[0]?.statusSuggestion?.to).toBe("done");
    expect(payload?.changed[0]?.statusWrite).toBe("suggested");
    expect(payload?.warnings).toEqual([]);
  });

  it("degrades to null on partial or malformed output", () => {
    expect(parseTaskManagePayload('{"renderKind":"taskMan')).toBeNull();
    expect(parseTaskManagePayload("")).toBeNull();
    // An unexpected entry shape drops that entry, not the card.
    expect(
      parseTaskManagePayload(JSON.stringify({ changed: [{ id: 7 }] }))?.changed,
    ).toEqual([]);
  });

  it("takes the operation verbs from the call, skipping ops with no changed entry", () => {
    const kinds = changedOperationKinds(
      {
        operations: [
          { operation: "create", title: "New" },
          { operation: "delete", id: "13" },
          { operation: "update", id: "14" },
        ],
      },
      2,
    );
    expect(kinds).toEqual(["create", "update"]);
  });

  it("gives up on verbs when the call cannot be lined up with the result", () => {
    // A lazily summarized tool input, and a batch whose result is shorter than
    // its operations: no verb is better than the wrong Task's verb.
    expect(changedOperationKinds({ operations: 3 }, 1)).toBeNull();
    expect(
      changedOperationKinds({ operations: [{ operation: "create" }] }, 2),
    ).toBeNull();
  });

  it("summarizes an update by what actually landed", () => {
    const task = {
      id: "297",
      title: "T",
      status: "todo" as const,
      descriptionEditsApplied: 2,
    };
    expect(changeSummary(task, "update")).toBe("2 description edits");
    expect(
      changeSummary({ ...task, descriptionEditsApplied: 1 }, "update"),
    ).toBe("description updated");
    expect(
      changeSummary({ id: "1", title: "T", status: "done" }, "create"),
    ).toBe("created");
  });

  it("says whether a status was set or only suggested", () => {
    expect(
      changeSummary(
        { id: "1", title: "T", status: "done", statusWrite: "applied" },
        "update",
      ),
    ).toBe("set done");
    expect(
      changeSummary(
        { id: "1", title: "T", status: "todo", statusWrite: "applied" },
        "update",
      ),
    ).toBe("set to do");
    // Named by its target, not by the `todo` a `done` suggestion parks it in.
    expect(
      changeSummary(
        {
          id: "1",
          title: "T",
          status: "todo",
          statusSuggestion: { to: "done", at: 5 },
          statusWrite: "suggested",
        },
        "update",
      ),
    ).toBe("suggested done");
    expect(
      changeSummary(
        {
          id: "1",
          title: "T",
          status: "doing",
          statusSuggestion: { to: "todo", at: 5 },
          statusWrite: "suggested",
        },
        "update",
      ),
    ).toBe("suggested to do");
  });
});

describe("TaskManageToolCard", () => {
  it("does not call a deduplicated Slack import a create", () => {
    const deduped = manageBlock(
      {
        operations: [
          { operation: "create", title: "Re-import of the same message" },
        ],
      },
      {
        changedCount: 1,
        changed: [
          {
            id: "12",
            title: "Already imported from Slack",
            status: "todo",
            deduplicated: true,
          },
        ],
        warnings: [
          "Skipped duplicate Slack import for existing Task 12; matched source link by permalink/channel+ts.",
        ],
      },
    );
    const html = renderToStaticMarkup(
      <TaskManageToolCard block={deduped} onOpenTask={() => {}} />,
    );
    // The op says create; the server says it landed on an existing Task, and the
    // warning beside it must not be contradicted.
    expect(html).toContain("already imported");
    expect(html).not.toContain(">created<");
    expect(html).toContain("Skipped duplicate Slack import");
  });

  it("shows a created Task as a chip that opens it", () => {
    const html = renderToStaticMarkup(
      <TaskManageToolCard block={createBlock} onOpenTask={() => {}} />,
    );
    expect(html).toContain("Render Task mutations");
    expect(html).toContain("#297");
    expect(html).toContain("created");
    expect(html).toContain("Open task details");
  });

  it("offers a confirm affordance for a pending status suggestion", () => {
    const html = renderToStaticMarkup(
      <TaskManageToolCard
        block={suggestionBlock}
        onApplyTaskStatusSuggestion={() => {}}
      />,
    );
    expect(html).toContain("says done: tests pass");
    expect(html).toContain("Confirm done");
    expect(html).toContain("description updated · suggested done");
  });

  it("shows no question for a suggestion the status already satisfies", () => {
    const applied = manageBlock(
      { operations: [{ operation: "update", id: "297", status: "done" }] },
      {
        changedCount: 1,
        changed: [
          {
            id: "297",
            title: "Done by the agent",
            status: "done",
            statusSuggestion: { to: "done", at: 5 },
            statusWrite: "applied",
          },
        ],
      },
    );
    const html = renderToStaticMarkup(
      <TaskManageToolCard
        block={applied}
        onApplyTaskStatusSuggestion={() => {}}
      />,
    );
    expect(html).not.toContain("Confirm done");
    expect(html).toContain("set done");
  });

  it("confirming sends the same save the Backlog's Focus row sends, with no title", () => {
    const sent: TaskSaveRequest[] = [];
    // What the card hands its host, and what the host does with it (App.tsx).
    const applyFromCard = (task: { id: string; status: "todo" | "done" }) =>
      sent.push(acceptStatusSuggestionSave({ id: task.id, to: task.status }));

    applyFromCard({ id: "297", status: "done" });
    // The Focus row's accept, from the live Task summary.
    const fromFocus = acceptStatusSuggestionSave({ id: "297", to: "done" });

    expect(sent[0]).toEqual(fromFocus);
    // No title: the card's copy is frozen at mutation time, and confirming a
    // status must not rename a Task someone renamed since.
    expect(sent[0]).toEqual({
      id: "297",
      status: "done",
      clearStatusSuggestion: true,
    });
    expect("title" in sent[0]!).toBe(false);
  });
});

describe("a recorded suggestion against the live Task", () => {
  const recorded = { to: "done", at: 5 } as const;
  function live(fields: Partial<TaskStatusRecord>): TaskStatusRecord {
    return { status: "todo", updatedAt: 6, ...fields };
  }
  function renderWithLive(
    statuses: TaskLiveSource["statuses"],
    listed: TaskSummary[] = [],
  ): string {
    return renderToStaticMarkup(
      <TaskLiveSourceProvider
        source={{
          statuses,
          listed: new Map(listed.map((task) => [task.id, task])),
          connected: true,
          request: () => {},
        }}
      >
        <TaskManageToolCard
          block={suggestionBlock}
          onApplyTaskStatusSuggestion={() => {}}
        />
      </TaskLiveSourceProvider>,
    );
  }

  it("reads what the Task says now", () => {
    expect(recordedSuggestionState(recorded, undefined)).toBe("unknown");
    expect(recordedSuggestionState(recorded, null)).toBe("settled");
    expect(
      recordedSuggestionState(recorded, live({ statusSuggestion: recorded })),
    ).toBe("pending");
    expect(recordedSuggestionState(recorded, live({ status: "done" }))).toBe(
      "accepted",
    );
    // Dismissed: the Task stayed put and the claim is gone.
    expect(recordedSuggestionState(recorded, live({}))).toBe("settled");
  });

  it("settles when a LATER claim with the same target replaced it", () => {
    const later = { to: "done", at: 10, reason: "new work" } as const;
    expect(
      recordedSuggestionState(recorded, live({ statusSuggestion: later })),
    ).toBe("settled");
    const html = renderWithLive({ "297": live({ statusSuggestion: later }) });
    expect(html).not.toContain("Confirm done");
    // A payload too old to carry `at` can only match on the target.
    expect(
      recordedSuggestionState(
        { to: "done", at: 0 },
        live({ statusSuggestion: later }),
      ),
    ).toBe("pending");
  });

  it("no longer asks once the Task was confirmed, e.g. after a reload", () => {
    const html = renderWithLive({ "297": live({ status: "done" }) });
    expect(html).not.toContain("Confirm done");
    expect(html).toContain("Confirmed done");
  });

  it("drops the question for a dismissed suggestion or a deleted Task", () => {
    for (const record of [live({}), null]) {
      const html = renderWithLive({ "297": record });
      expect(html).not.toContain("Confirm done");
      expect(html).not.toContain("says done");
    }
  });

  it("takes the newer of its own read and the Backlog summary", () => {
    const summary = (status: "todo" | "done", updatedAt: number) =>
      ({
        id: "297",
        title: "Render Task mutations",
        status,
        updatedAt,
      }) as TaskSummary;
    const read = live({ statusSuggestion: recorded });
    expect(renderWithLive({ "297": read }, [summary("done", 9)])).toContain(
      "Confirmed done",
    );
    // A cached list older than the read says nothing new.
    expect(renderWithLive({ "297": read }, [summary("done", 2)])).toContain(
      "Confirm done",
    );
  });

  it("still asks while the Task waits for the answer", () => {
    expect(
      renderWithLive({ "297": live({ statusSuggestion: recorded }) }),
    ).toContain("Confirm done");
    // Before the live state arrives, the card shows what it recorded.
    expect(renderWithLive({})).toContain("Confirm done");
  });
});

describe("task tool renderers", () => {
  it("renders a mutation as a card with tools hidden, and a read as a body", () => {
    expect(toolBlockIsVisible(createBlock, false)).toBe(true);
    expect(
      renderToolBlock(createBlock, { showTools: false, expandTools: false }),
    ).not.toBeNull();

    const read: ToolBlock = {
      kind: "tool",
      toolId: "toolu_02Task",
      name: "mcp__pa__task_read",
      args: { id: "297" },
      output: JSON.stringify({ count: 1, items: [{ id: "297" }] }),
      isError: false,
      done: true,
    };
    expect(toolBlockIsVisible(read, false)).toBe(false);
    expect(
      renderToolBlock(read, { showTools: false, expandTools: false }),
    ).toBeNull();
  });

  it("does not card a failed or unfinished mutation", () => {
    expect(toolBlockIsVisible({ ...createBlock, isError: true }, false)).toBe(
      false,
    );
    expect(toolBlockIsVisible({ ...createBlock, done: false }, false)).toBe(
      false,
    );
  });
});
