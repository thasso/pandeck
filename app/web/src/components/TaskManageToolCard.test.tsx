import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisplayBlock, TaskSaveRequest } from "@assistant/shared";
import { parseTaskManagePayload } from "@assistant/shared/toolCards";
import {
  TaskManageToolCard,
  changeSummary,
  changedOperationKinds,
} from "./TaskManageToolCard.tsx";
import { acceptStatusSuggestionSave } from "../lib/backlogTree.ts";
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
    operations: [{ operation: "update", id: "297", status: "done" }],
  },
  {
    changedCount: 1,
    changed: [
      {
        id: "297",
        title: "Render Task mutations",
        status: "todo",
        statusSuggestion: { to: "done", at: 5, reason: "tests pass" },
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
    expect(html).toContain("description updated");
  });

  it("shows no question for a suggestion the status already satisfies", () => {
    const applied = manageBlock(
      { operations: [{ operation: "update", id: "297", status: "done" }] },
      {
        changedCount: 1,
        changed: [
          {
            id: "297",
            title: "Done at your request",
            status: "done",
            statusSuggestion: { to: "done", at: 5 },
            statusSetByRequest: true,
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
