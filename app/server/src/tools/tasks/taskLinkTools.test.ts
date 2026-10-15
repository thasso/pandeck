/**
 * Task links through the agent tools: `task_manage` writes them on create and
 * update (each operation whole or not at all), and `task_read` shows grouped
 * links on a read by id and only an open-blocker count in lists, inside the
 * same byte budget as everything else.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createTask,
  deleteTask,
  listTasks,
  readTask,
  updateTask,
} from "../../tasks.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import {
  taskToolsForKind,
  workflowCoordinatorTaskCreateTools,
} from "./taskTools.ts";

const ctx: ToolCallContext = {
  toolCallId: "task-link-tool-test",
  session: {
    sessionId: "task-link-tool-session",
    harness: "pi",
    agentType: "assistant",
  },
};

const READ_BUDGET_BYTES = 24_000;

function tool(name: "task_read" | "task_manage") {
  return taskToolsForKind("assistant").find((t) => t.name === name)!;
}

function make(title: string) {
  return createTask({ title, source: { createdBy: "user" } });
}

function discard(...ids: string[]): void {
  for (const id of ids) {
    try {
      deleteTask(id);
    } catch {
      /* already gone */
    }
  }
}

type LinkedEntry = {
  id: string;
  title: string;
  status: string;
  projectId?: string;
  archived?: true;
};

type ReadItem = {
  id: string;
  links?: {
    blocks?: LinkedEntry[];
    blockedBy?: LinkedEntry[];
    relates?: LinkedEntry[];
  };
  linksOmitted?: number;
  openBlockerCount?: number;
  blocked?: true;
};

function readItems(result: ToolResult): ReadItem[] {
  return (result.details as { items: ReadItem[] }).items;
}

function resultBytes(result: ToolResult): number {
  const first = result.content[0];
  return first?.type === "text" ? Buffer.byteLength(first.text, "utf8") : 0;
}

test("task_manage schema offers addLinks on create/update and removeLinks; the coordinator's does not", () => {
  const props = (
    tool("task_manage").parameters as {
      properties: {
        operations: { items: { properties: Record<string, unknown> } };
      };
    }
  ).properties.operations.items.properties;
  assert.ok("addLinks" in props);
  assert.deepEqual(
    (props.removeLinks as { items: unknown }).items,
    { type: "string" },
    "removeLinks is a plain list of Task ids",
  );
  const addLinks = props.addLinks as {
    items: { properties: { type: { enum: string[] } } };
  };
  assert.deepEqual(addLinks.items.properties.type.enum, [
    "blocks",
    "blocked-by",
    "relates",
  ]);

  const coordinator = workflowCoordinatorTaskCreateTools()[0]!;
  const coordinatorProps = (
    coordinator.parameters as {
      properties: {
        operations: { items: { properties: Record<string, unknown> } };
      };
    }
  ).properties.operations.items.properties;
  assert.equal("addLinks" in coordinatorProps, false);
  assert.equal("removeLinks" in coordinatorProps, false);
});

test("task_manage writes links on create and update, and removes them", async () => {
  const blocker = make("Tool blocker");
  const peer = make("Tool peer");
  let createdId = "";
  try {
    const created = await tool("task_manage").execute(
      {
        operations: [
          {
            operation: "create",
            title: "Tool-created blocked Task",
            addLinks: [{ type: "blocked-by", taskId: blocker.id }],
          },
        ],
      },
      ctx,
    );
    createdId = (created.details as { changed: Array<{ id: string }> })
      .changed[0]!.id;
    assert.deepEqual(
      readTask(createdId)?.links?.blockedBy.map((t) => t.id),
      [blocker.id],
    );

    await tool("task_manage").execute(
      {
        operations: [
          {
            operation: "update",
            id: createdId,
            addLinks: [{ type: "relates", taskId: peer.id }],
            removeLinks: [blocker.id],
          },
        ],
      },
      ctx,
    );
    const links = readTask(createdId)?.links;
    assert.deepEqual(links?.blockedBy, []);
    assert.deepEqual(
      links?.relates.map((t) => t.id),
      [peer.id],
    );
  } finally {
    discard(createdId, blocker.id, peer.id);
  }
});

test("a link rule breach fails its whole operation; earlier operations stand", async () => {
  const a = make("Batch A");
  const b = make("Batch B");
  try {
    updateTask(a.id, { addLinks: [{ type: "blocks", taskId: b.id }] });
    await assert.rejects(
      tool("task_manage").execute(
        {
          operations: [
            { operation: "update", id: a.id, title: "Batch A renamed" },
            {
              operation: "update",
              id: b.id,
              title: "Must not land",
              addLinks: [{ type: "relates", taskId: "999999" }],
            },
          ],
        },
        ctx,
      ),
      /Task-999999 does not exist or was deleted/,
    );
    // Operations apply in order: the first one is kept, as before.
    assert.equal(readTask(a.id)?.title, "Batch A renamed");
    // The failing one wrote nothing, not even its title.
    assert.equal(readTask(b.id)?.title, "Batch B");

    const before = listTasks({ includeArchived: true }).length;
    await assert.rejects(
      tool("task_manage").execute(
        {
          operations: [
            {
              operation: "create",
              title: "Cyclic create",
              addLinks: [
                { type: "blocked-by", taskId: b.id },
                { type: "blocks", taskId: a.id },
              ],
            },
          ],
        },
        ctx,
      ),
      /cycle/,
    );
    assert.equal(listTasks({ includeArchived: true }).length, before);

    await assert.rejects(
      tool("task_manage").execute(
        {
          operations: [
            {
              operation: "create",
              title: "Remove on create",
              removeLinks: [a.id],
            },
          ],
        },
        ctx,
      ),
      /removeLinks applies only to an update/,
    );
    await assert.rejects(
      tool("task_manage").execute(
        {
          operations: [
            {
              operation: "update",
              id: a.id,
              addLinks: [{ type: "depends-on", taskId: b.id }],
            },
          ],
        } as never,
        ctx,
      ),
      /addLinks\[\]\.type must be one of blocks, blocked-by, relates/,
    );
    await assert.rejects(
      tool("task_manage").execute(
        {
          operations: [
            {
              operation: "archive",
              id: a.id,
              addLinks: [{ type: "relates", taskId: b.id }],
            },
          ],
        },
        ctx,
      ),
      /addLinks applies only to a create or update/,
    );
  } finally {
    discard(a.id, b.id);
  }
});

test("a Slack-dedupe create applies addLinks to the existing Task, or nothing at all", async () => {
  const permalink =
    "https://example.slack.com/archives/C0LINKDEDUPE/p1700000000000200";
  const existing = createTask({
    title: "Imported Slack Task with links",
    externalLinks: [
      { url: permalink, type: "source", source: "slack", addedAt: Date.now() },
    ],
    source: { createdBy: "user" },
  });
  const blocker = make("Dedupe blocker");
  const reimport = (taskId: string) =>
    tool("task_manage").execute(
      {
        operations: [
          {
            operation: "create",
            title: "Re-import with a link",
            externalLinks: [{ url: permalink, source: "slack" }],
            addLinks: [{ type: "blocked-by", taskId }],
          },
        ],
      },
      ctx,
    );
  try {
    // An invalid link fails the whole resolved update: the session ref the
    // dedupe would have added does not land either.
    await assert.rejects(
      reimport("999999"),
      /Task-999999 does not exist or was deleted/,
    );
    const untouched = readTask(existing.id)!;
    assert.equal(untouched.links, undefined);
    assert.equal(
      untouched.sessionRefs?.some(
        (ref) => ref.sessionId === ctx.session.sessionId,
      ),
      false,
    );

    const result = await reimport(blocker.id);
    const changed = (
      result.details as {
        changed: Array<{ id: string; deduplicated?: boolean }>;
      }
    ).changed[0]!;
    assert.equal(changed.id, existing.id);
    assert.equal(changed.deduplicated, true);
    assert.deepEqual(
      readTask(existing.id)?.links?.blockedBy.map((t) => t.id),
      [blocker.id],
    );
  } finally {
    discard(existing.id, blocker.id);
  }
});

test("the tool's delete drops the deleted Task's links from the survivors", async () => {
  const doomed = make("Tool doomed");
  const survivor = make("Tool survivor");
  try {
    updateTask(survivor.id, {
      addLinks: [{ type: "blocked-by", taskId: doomed.id }],
    });
    await tool("task_manage").execute(
      { operations: [{ operation: "delete", id: doomed.id }] },
      ctx,
    );
    assert.equal(readTask(doomed.id), null);
    const item = readItems(
      await tool("task_read").execute({ id: survivor.id }, ctx),
    )[0]!;
    assert.equal(item.links, undefined);
    assert.equal(item.blocked, undefined);
  } finally {
    discard(doomed.id, survivor.id);
  }
});

test("task_read groups links on a read by id and counts open blockers in lists", async () => {
  const task = createTask({
    title: "Read subject",
    projectId: "links-read-project",
    source: { createdBy: "user" },
  });
  const openBlocker = make("Read open blocker");
  const doneBlocker = make("Read done blocker");
  const downstream = make("Read downstream");
  const peer = make("Read peer");
  try {
    updateTask(task.id, {
      addLinks: [
        { type: "blocked-by", taskId: openBlocker.id },
        { type: "blocked-by", taskId: doneBlocker.id },
        { type: "blocks", taskId: downstream.id },
        { type: "relates", taskId: peer.id },
      ],
    });
    updateTask(doneBlocker.id, { status: "done", actor: { kind: "user" } });

    const item = readItems(
      await tool("task_read").execute({ id: task.id }, ctx),
    )[0]!;
    assert.deepEqual(item.links, {
      blocks: [{ id: downstream.id, title: "Read downstream", status: "todo" }],
      blockedBy: [
        { id: openBlocker.id, title: "Read open blocker", status: "todo" },
        { id: doneBlocker.id, title: "Read done blocker", status: "done" },
      ],
      relates: [{ id: peer.id, title: "Read peer", status: "todo" }],
    });
    assert.equal(item.blocked, true);

    // The downstream Task's own read names this Task as its blocker, with
    // its project.
    const downstreamItem = readItems(
      await tool("task_read").execute({ id: downstream.id }, ctx),
    )[0]!;
    assert.deepEqual(downstreamItem.links?.blockedBy, [
      {
        id: task.id,
        title: "Read subject",
        status: "todo",
        projectId: "links-read-project",
      },
    ]);

    const list = readItems(
      await tool("task_read").execute({ query: "Read " }, ctx),
    );
    const listed = list.find((entry) => entry.id === task.id)!;
    assert.equal(listed.links, undefined, "lists carry no link lists");
    assert.equal(listed.openBlockerCount, 1);
    assert.equal(listed.blocked, true);
    const free = list.find((entry) => entry.id === peer.id)!;
    assert.equal(free.openBlockerCount, undefined);
    assert.equal(free.blocked, undefined);
  } finally {
    discard(task.id, openBlocker.id, doneBlocker.id, downstream.id, peer.id);
  }
});

test("task_read keeps a heavily linked Task inside the byte budget and says what it dropped", async () => {
  const hub = make("Heavily linked hub");
  const spokes = Array.from({ length: 140 }, (_, i) =>
    make(`Spoke ${i} `.padEnd(200, "s")),
  );
  try {
    updateTask(hub.id, {
      addLinks: spokes.map((spoke) => ({
        type: "relates" as const,
        taskId: spoke.id,
      })),
    });
    const result = await tool("task_read").execute({ id: hub.id }, ctx);
    const item = readItems(result)[0]!;
    assert.ok(resultBytes(result) <= READ_BUDGET_BYTES);
    assert.ok(item.linksOmitted && item.linksOmitted > 0);
    assert.equal(
      (item.links?.relates?.length ?? 0) + item.linksOmitted,
      spokes.length,
    );
  } finally {
    discard(hub.id, ...spokes.map((spoke) => spoke.id));
  }
});
