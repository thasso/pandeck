import assert from "node:assert/strict";
import { test } from "vitest";
import { createTask, deleteTask, readTask } from "../../tasks.ts";
import { addTaskComment } from "../../taskComments.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { taskToolsForKind } from "./taskTools.ts";

const ctx: ToolCallContext = {
  toolCallId: "task-read-test",
  session: {
    sessionId: "task-read-test-session",
    harness: "pi",
    agentType: "assistant",
  },
};

test("task_read resolves an exact id with ordered descendants in one compact call", async () => {
  const parent = createTask({
    title: "Exact task lookup parent",
    description: "parent body",
    source: { createdBy: "user" },
  });
  const later = createTask({
    title: "Later child",
    description: "later body",
    parentId: parent.id,
    sortOrder: 1,
    source: { createdBy: "user" },
  });
  const first = createTask({
    title: "First child",
    description: "first body",
    parentId: parent.id,
    sortOrder: 0,
    source: { createdBy: "user" },
  });
  const grandchild = createTask({
    title: "Grandchild",
    description: "grandchild body",
    parentId: first.id,
    sortOrder: 0,
    source: { createdBy: "user" },
  });

  try {
    const tool = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const result = await tool.execute(
      { id: parent.id, includeSubtasks: true, includeDescriptions: true },
      ctx,
    );
    const payload = result.details as {
      count: number;
      totalCount: number;
      truncated: boolean;
      items: Array<{ id: string; description?: string }>;
    };

    assert.deepEqual(
      payload.items.map((item) => item.id),
      [parent.id, first.id, grandchild.id, later.id],
    );
    assert.deepEqual(
      payload.items.map((item) => item.description),
      ["parent body", "first body", "grandchild body", "later body"],
    );
    assert.equal(payload.count, 4);
    assert.equal(payload.totalCount, 4);
    assert.equal(payload.truncated, false);
    assert.equal(result.content[0]?.type, "text");
    if (result.content[0]?.type === "text")
      assert.equal(result.content[0].text, JSON.stringify(payload));
  } finally {
    deleteTask(grandchild.id);
    deleteTask(first.id);
    deleteTask(later.id);
    deleteTask(parent.id);
  }
});

test("task_read treats query as text search rather than an id lookup", async () => {
  const task = createTask({
    title: "No numeric marker here",
    description: "plain body",
    source: { createdBy: "user" },
  });
  try {
    const tool = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const result = await tool.execute({ query: task.id }, ctx);
    const payload = result.details as { items: Array<{ id: string }> };
    assert.equal(
      payload.items.some((item) => item.id === task.id),
      false,
    );
  } finally {
    deleteTask(task.id);
  }
});

/** The `task_manage` result is a rendering contract, so it is asserted whole. */
type ManageResult = {
  renderKind: string;
  version: number;
  changedCount: number;
  changed: Array<{
    id: string;
    status: string;
    statusSuggestion?: { to: string; at: number; reason?: string };
    statusSetByRequest?: boolean;
    descriptionEditsApplied?: number;
    deduplicated?: boolean;
  }>;
  comments?: Array<{ taskId: string; body: string; authorKind: string }>;
  warnings?: string[];
};

function manageTool() {
  return taskToolsForKind("assistant").find(
    (candidate) => candidate.name === "task_manage",
  )!;
}

function readTool() {
  return taskToolsForKind("assistant").find(
    (candidate) => candidate.name === "task_read",
  )!;
}

test("task_manage reports a done write as a recorded suggestion, not a warning", async () => {
  const task = createTask({
    title: "Closeout probe",
    status: "doing",
    source: { createdBy: "user" },
  });
  try {
    const result = await manageTool().execute(
      {
        operations: [
          {
            operation: "update",
            id: task.id,
            status: "done",
            statusReason: "tests pass",
          },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    assert.equal(payload.renderKind, "taskManage");
    assert.equal(payload.version, 1);
    assert.equal(payload.changedCount, 1);
    // The entry answers "what is it now" by itself: out of `doing`, with the
    // suggestion still waiting. Nothing about it reads as a failure.
    assert.equal(payload.changed[0]?.status, "todo");
    assert.equal(payload.changed[0]?.statusSuggestion?.to, "done");
    assert.equal(payload.changed[0]?.statusSuggestion?.reason, "tests pass");
    assert.equal(payload.changed[0]?.statusSetByRequest, undefined);
    assert.equal(payload.warnings, undefined);
    if (result.content[0]?.type === "text")
      assert.equal(result.content[0].text, JSON.stringify(payload));
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage applies a status the user asked for and says it did", async () => {
  const task = createTask({
    title: "Escape hatch probe",
    status: "doing",
    source: { createdBy: "user" },
  });
  try {
    const result = await manageTool().execute(
      {
        operations: [
          {
            operation: "update",
            id: task.id,
            status: "done",
            userRequestedStatus: true,
          },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    assert.equal(payload.changed[0]?.status, "done");
    assert.equal(payload.changed[0]?.statusSetByRequest, true);
    // The claim is still recorded, so it stays visible and reversible.
    assert.equal(payload.changed[0]?.statusSuggestion?.to, "done");
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage closes a Task out in ONE call: edit, comment, and suggestion", async () => {
  const task = createTask({
    title: "One-call closeout",
    description: "Intro line.\n\nOutcome: unknown.\n\nTrailer.",
    status: "doing",
    source: { createdBy: "user" },
  });
  try {
    const result = await manageTool().execute(
      {
        operations: [
          {
            operation: "update",
            id: task.id,
            status: "done",
            statusReason: "shipped",
            descriptionEdits: [
              { oldText: "Outcome: unknown.", newText: "Outcome: shipped." },
              { oldText: "Trailer.", newText: "Trailer, revised." },
            ],
            comment: "Landed behind the flag.",
          },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    assert.equal(payload.changedCount, 1);
    assert.equal(payload.changed[0]?.status, "todo");
    assert.equal(payload.changed[0]?.statusSuggestion?.to, "done");
    assert.equal(payload.changed[0]?.descriptionEditsApplied, 2);
    assert.deepEqual(
      payload.comments?.map((c) => [c.taskId, c.body, c.authorKind]),
      [[task.id, "Landed behind the flag.", "agent"]],
    );
    if (result.content[0]?.type === "text")
      assert.equal(result.content[0].text, JSON.stringify(payload));

    const read = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const after = await read.execute(
      { id: task.id, includeDescriptions: true, comments: {} },
      ctx,
    );
    const readPayload = after.details as {
      items: Array<{ description?: string }>;
      comments?: {
        count: number;
        totalCount: number;
        olderCount: number;
        items: Array<{ body: string; authorKind: string }>;
      };
    };
    assert.equal(
      readPayload.items[0]?.description,
      "Intro line.\n\nOutcome: shipped.\n\nTrailer, revised.",
    );
    assert.deepEqual(
      readPayload.comments?.items.map((c) => c.body),
      ["Landed behind the flag."],
    );
    assert.equal(readPayload.comments?.items[0]?.authorKind, "agent");
    assert.equal(readPayload.comments?.totalCount, 1);
    assert.equal(readPayload.comments?.olderCount, 0);

    // comments is opt-in: absent by default.
    const bare = await read.execute({ id: task.id }, ctx);
    assert.equal((bare.details as { comments?: unknown }).comments, undefined);
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage links GitHub issues canonically and refuses a ref without its repository", async () => {
  const task = createTask({
    title: "GitHub link probe",
    source: { createdBy: "user" },
  });
  try {
    await manageTool().execute(
      {
        operations: [
          {
            operation: "update",
            id: task.id,
            githubIssues: [
              "https://github.com/nodejs/.github/issues/1",
              "acme/app#12",
            ],
          },
        ],
      },
      ctx,
    );
    assert.deepEqual(readTask(task.id)?.githubIssues, [
      "nodejs/.github#1",
      "acme/app#12",
    ]);
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            { operation: "update", id: task.id, githubIssues: ["#12"] },
          ],
        },
        ctx,
      ),
      /Not a GitHub issue reference: "#12"/,
    );
    assert.deepEqual(readTask(task.id)?.githubIssues, [
      "nodejs/.github#1",
      "acme/app#12",
    ]);
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage refuses to replace a whole description on update", async () => {
  const task = createTask({
    title: "Unreadable body probe",
    description: "The body the agent did not read.",
    source: { createdBy: "user" },
  });
  try {
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            { operation: "update", id: task.id, description: "Clobbered." },
          ],
        },
        ctx,
      ),
      /cannot replace a whole Task description/i,
    );
    // Even an empty string is a replacement, so it is refused too.
    await assert.rejects(
      manageTool().execute(
        { operations: [{ operation: "update", id: task.id, description: "" }] },
        ctx,
      ),
      /cannot replace a whole Task description/i,
    );

    const read = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const after = await read.execute(
      { id: task.id, includeDescriptions: true },
      ctx,
    );
    assert.equal(
      (after.details as { items: Array<{ description?: string }> }).items[0]
        ?.description,
      "The body the agent did not read.",
    );
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage rejects a stale or ambiguous description edit", async () => {
  const task = createTask({
    title: "Edit anchoring probe",
    description: "repeated\nrepeated\nunique tail",
    source: { createdBy: "user" },
  });
  try {
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            {
              operation: "update",
              id: task.id,
              descriptionEdits: [{ oldText: "absent", newText: "x" }],
            },
          ],
        },
        ctx,
      ),
      /oldText not found/i,
    );
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            {
              operation: "update",
              id: task.id,
              descriptionEdits: [{ oldText: "repeated", newText: "x" }],
            },
          ],
        },
        ctx,
      ),
      /not unique/i,
    );
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            {
              operation: "archive",
              id: task.id,
              descriptionEdits: [{ oldText: "unique tail", newText: "x" }],
            },
          ],
        },
        ctx,
      ),
      /only to an update operation/i,
    );
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage batches bare comments across Tasks in one call", async () => {
  const first = createTask({
    title: "Trace target one",
    source: { createdBy: "user" },
  });
  const second = createTask({
    title: "Trace target two",
    source: { createdBy: "user" },
  });
  try {
    const result = await manageTool().execute(
      {
        operations: [
          { operation: "comment", id: first.id, comment: "note one" },
          { operation: "comment", id: second.id, comment: "note two" },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    // A bare comment mutates no Task, so it stays out of changed/changedCount.
    assert.equal(payload.changedCount, 0);
    assert.deepEqual(payload.changed, []);
    assert.deepEqual(
      payload.comments?.map((c) => [c.taskId, c.body]),
      [
        [first.id, "note one"],
        [second.id, "note two"],
      ],
    );

    await assert.rejects(
      manageTool().execute(
        { operations: [{ operation: "comment", id: first.id, comment: " " }] },
        ctx,
      ),
      /comment must not be empty/i,
    );
    await assert.rejects(
      manageTool().execute(
        { operations: [{ operation: "comment", id: first.id }] },
        ctx,
      ),
      /requires comment text/i,
    );
  } finally {
    deleteTask(second.id);
    deleteTask(first.id);
  }
});

test("task_manage refuses a comment operation that also asks for a change", async () => {
  const task = createTask({
    title: "Wrong-operation probe",
    status: "doing",
    source: { createdBy: "user" },
  });
  try {
    // The likeliest slip: meaning "update AND comment", writing "comment". The
    // status must not be dropped on the floor.
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            {
              operation: "comment",
              id: task.id,
              comment: "closing out",
              status: "done",
              statusReason: "shipped",
            },
          ],
        },
        ctx,
      ),
      /cannot carry status, statusReason.*operation "update" with comment/is,
    );
    await assert.rejects(
      manageTool().execute(
        {
          operations: [
            {
              operation: "comment",
              id: task.id,
              comment: "renaming",
              title: "New title",
            },
          ],
        },
        ctx,
      ),
      /cannot carry title/i,
    );

    // Nothing landed: not the status, not the suggestion, not the comment.
    const read = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const after = await read.execute({ id: task.id, comments: {} }, ctx);
    const payload = after.details as {
      items: Array<{
        title: string;
        status: string;
        statusSuggestion?: object;
      }>;
      comments?: { count: number; totalCount: number; items: unknown[] };
    };
    assert.equal(payload.items[0]?.title, "Wrong-operation probe");
    assert.equal(payload.items[0]?.status, "doing");
    assert.equal(payload.items[0]?.statusSuggestion, undefined);
    assert.deepEqual(payload.comments?.items, []);
    assert.equal(payload.comments?.totalCount, 0);
  } finally {
    deleteTask(task.id);
  }
});

test("task_manage routes a create's comment onto a de-duplicated Slack Task", async () => {
  const permalink =
    "https://example.slack.com/archives/C0DEDUPE/p1700000000000100";
  const existing = createTask({
    title: "Already imported from Slack",
    externalLinks: [
      { url: permalink, type: "source", source: "slack", addedAt: Date.now() },
    ],
    source: { createdBy: "user" },
  });
  try {
    const result = await manageTool().execute(
      {
        operations: [
          {
            operation: "create",
            title: "Re-import of the same message",
            externalLinks: [{ url: permalink, source: "slack" }],
            comment: "seen again today",
          },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    // No second Task, and the comment lands on the one that already exists.
    assert.equal(payload.changed[0]?.id, existing.id);
    assert.match(payload.warnings?.[0] ?? "", /Skipped duplicate Slack import/);
    // Flagged on the ENTRY too: the payload never says which operation produced
    // one, so a renderer taking the verb from the call would say "created" about
    // a Task that already existed.
    assert.equal(payload.changed[0]?.deduplicated, true);
    assert.deepEqual(
      payload.comments?.map((c) => [c.taskId, c.body]),
      [[existing.id, "seen again today"]],
    );
  } finally {
    deleteTask(existing.id);
  }
});

test("task_manage carries a comment on a create, onto the new Task", async () => {
  const result = await manageTool().execute(
    {
      operations: [
        {
          operation: "create",
          title: "Created with a trace entry",
          description: "body",
          comment: "filed from the closeout call",
        },
      ],
    },
    ctx,
  );
  const payload = result.details as ManageResult;
  const createdId = payload.changed[0]!.id;
  try {
    assert.deepEqual(
      payload.comments?.map((c) => [c.taskId, c.body]),
      [[createdId, "filed from the closeout call"]],
    );
  } finally {
    deleteTask(createdId);
  }
});

/** The budget the read tool bounds itself to, plus the slack of a JSON envelope. */
const READ_BUDGET_BYTES = 24_000;

interface CommentsBlock {
  count: number;
  totalCount: number;
  olderCount: number;
  nextCursor?: string;
  items: Array<{ id: string; body: string; bodyTruncated?: boolean }>;
}

function readPayloadOf(result: ToolResult) {
  return result.details as {
    count: number;
    totalCount: number;
    truncated: boolean;
    descriptionsTruncated?: boolean;
    descriptionsOmitted?: boolean;
    omittedForBudget?: number;
    items: Array<{
      id: string;
      description?: string;
      descriptionPreview?: string;
      descriptionTruncated?: boolean;
      descriptionChars?: number;
    }>;
    comments?: CommentsBlock;
  };
}

function resultBytes(result: ToolResult): number {
  const first = result.content[0];
  return first?.type === "text" ? Buffer.byteLength(first.text, "utf8") : 0;
}

test("task_read returns the recent comments oldest-first and pages back through older history", async () => {
  const task = createTask({
    title: "Long trace probe",
    source: { createdBy: "user" },
  });
  try {
    for (let i = 1; i <= 25; i++)
      addTaskComment({
        taskId: task.id,
        authorKind: "agent",
        authorName: "probe",
        body: `entry ${i}`,
      });

    const recent = readPayloadOf(
      await readTool().execute({ id: task.id, comments: {} }, ctx),
    );
    const comments = recent.comments!;
    assert.deepEqual(
      comments.items.map((c) => c.body),
      Array.from({ length: 10 }, (_, i) => `entry ${i + 16}`),
    );
    assert.equal(comments.count, 10);
    assert.equal(comments.totalCount, 25);
    assert.equal(comments.olderCount, 15);
    assert.equal(comments.nextCursor, comments.items[0]!.id);

    const older = readPayloadOf(
      await readTool().execute(
        { id: task.id, comments: { limit: 5, before: comments.nextCursor } },
        ctx,
      ),
    ).comments!;
    assert.deepEqual(
      older.items.map((c) => c.body),
      ["entry 11", "entry 12", "entry 13", "entry 14", "entry 15"],
    );
    assert.equal(older.totalCount, 25);
    assert.equal(older.olderCount, 10);

    await assert.rejects(
      readTool().execute({ id: task.id, comments: { before: "999999" } }, ctx),
      /Unknown comments.before cursor/i,
    );
    // A trace belongs to one Task: asking for one on a list read fails loudly
    // rather than returning no trace and no reason why.
    await assert.rejects(
      readTool().execute({ query: "Long trace probe", comments: {} }, ctx),
      /comments requires id/i,
    );
  } finally {
    deleteTask(task.id);
  }
});

test("task_read clips long comment bodies and stays inside the budget", async () => {
  const task = createTask({
    title: "Fat trace probe",
    source: { createdBy: "user" },
  });
  try {
    for (let i = 0; i < 20; i++)
      addTaskComment({
        taskId: task.id,
        authorKind: "agent",
        authorName: "probe",
        body: `comment ${i} `.padEnd(19_000, "x"),
      });

    const result = await readTool().execute(
      { id: task.id, comments: { limit: 100 } },
      ctx,
    );
    const comments = readPayloadOf(result).comments!;

    assert.ok(comments.count < 20, "the byte budget returned fewer comments");
    assert.ok(comments.olderCount > 0, "dropped comments are counted as older");
    assert.equal(comments.nextCursor, comments.items[0]!.id);
    for (const comment of comments.items) {
      assert.equal(comment.bodyTruncated, true);
      assert.ok(comment.body.endsWith("…[truncated]"));
    }
    assert.ok(
      resultBytes(result) <= READ_BUDGET_BYTES,
      `result ${resultBytes(result)} bytes exceeded the budget`,
    );
  } finally {
    deleteTask(task.id);
  }
});

test("task_read degrades an epic read instead of overflowing: clip, then drop descriptions", async () => {
  const parent = createTask({
    title: "Fat epic probe",
    description: "epic body ".padEnd(9_000, "y"),
    source: { createdBy: "user" },
  });
  const children = [
    createTask({
      title: "Fat child one",
      description: "child body ".padEnd(9_000, "y"),
      parentId: parent.id,
      sortOrder: 0,
      source: { createdBy: "user" },
    }),
    createTask({
      title: "Fat child two",
      description: "child body ".padEnd(9_000, "y"),
      parentId: parent.id,
      sortOrder: 1,
      source: { createdBy: "user" },
    }),
  ];
  try {
    const clippedResult = await readTool().execute(
      { id: parent.id, includeSubtasks: true, includeDescriptions: true },
      ctx,
    );
    const clipped = readPayloadOf(clippedResult);
    assert.equal(clipped.count, 3, "every Task in the epic still comes back");
    assert.equal(clipped.descriptionsTruncated, true);
    assert.equal(clipped.descriptionsOmitted, undefined);
    assert.equal(clipped.items[0]?.descriptionTruncated, true);
    assert.equal(clipped.items[0]?.descriptionChars, 9_000);
    assert.ok(resultBytes(clippedResult) <= READ_BUDGET_BYTES);
  } finally {
    for (const child of children) deleteTask(child.id);
    deleteTask(parent.id);
  }
});

test("task_read drops the bodies rather than the Tasks when even clipped descriptions do not fit", async () => {
  const parent = createTask({
    title: "Fatter epic probe",
    description: "epic body ".padEnd(9_000, "y"),
    source: { createdBy: "user" },
  });
  const children = Array.from({ length: 14 }, (_, i) =>
    createTask({
      title: `Fat child ${i}`,
      description: "child body ".padEnd(9_000, "y"),
      parentId: parent.id,
      sortOrder: i,
      source: { createdBy: "user" },
    }),
  );
  try {
    for (let i = 0; i < 4; i++)
      addTaskComment({
        taskId: parent.id,
        authorKind: "agent",
        authorName: "probe",
        body: `trace ${i}`,
      });
    const result = await readTool().execute(
      {
        id: parent.id,
        includeSubtasks: true,
        includeDescriptions: true,
        comments: {},
      },
      ctx,
    );
    const payload = readPayloadOf(result);

    assert.equal(payload.count, 15, "every Task in the epic still comes back");
    assert.equal(payload.descriptionsOmitted, true);
    assert.equal(payload.descriptionsTruncated, undefined);
    assert.equal(payload.omittedForBudget, undefined);
    assert.equal(payload.items[0]?.description, undefined);
    assert.ok(payload.items[0]?.descriptionPreview);
    assert.equal(payload.comments?.count, 4);
    assert.ok(resultBytes(result) <= READ_BUDGET_BYTES);
  } finally {
    for (const child of children) deleteTask(child.id);
    deleteTask(parent.id);
  }
});

test("task_read drops trailing Tasks and says so when previews alone exceed the budget", async () => {
  const parent = createTask({
    title: "Wide epic probe",
    source: { createdBy: "user" },
  });
  const children = Array.from({ length: 60 }, (_, i) =>
    createTask({
      title: `Wide child ${i} `.padEnd(200, "t"),
      description: "preview body ".padEnd(400, "p"),
      parentId: parent.id,
      sortOrder: i,
      source: { createdBy: "user" },
    }),
  );
  try {
    const result = await readTool().execute(
      { id: parent.id, includeSubtasks: true, maxResults: 61 },
      ctx,
    );
    const payload = readPayloadOf(result);
    assert.ok(payload.count < 61, "trailing Tasks were dropped for the budget");
    assert.equal(payload.truncated, true);
    assert.equal(payload.omittedForBudget, 61 - payload.count);
    assert.equal(payload.totalCount, 61);
    assert.ok(resultBytes(result) <= READ_BUDGET_BYTES);
  } finally {
    for (const child of children) deleteTask(child.id);
    deleteTask(parent.id);
  }
});

test("task_manage exposes exactly two Task tools", () => {
  assert.deepEqual(
    taskToolsForKind("assistant").map((tool) => tool.name),
    ["task_read", "task_manage"],
  );
});

/** The rules that exist on NO other model-visible surface, pinned by substring. */
test("Task descriptions carry the rules no schema field states", () => {
  const read = readTool().description;
  assert.match(read, /byte-bounded/, "task_read must warn the read is bounded");
  assert.match(
    read,
    /narrow the read/,
    "task_read must say to narrow rather than assume completeness",
  );

  const manage = manageTool().description;
  assert.match(
    manage,
    /NOT happen in this session/,
    "task_manage must say when a Task is worth creating",
  );
  assert.match(
    manage,
    /Inbox untriaged/,
    "task_manage must say a created Task lands in the user's Inbox",
  );
  assert.match(
    manage,
    /SUGGESTIONS the user answers/,
    "task_manage must say status writes are suggestions",
  );
  assert.match(
    manage,
    /one comment per session/,
    "task_manage must cap comments per session",
  );
  assert.match(
    manage,
    /explicit or strong evidence/,
    "task_manage must state the evidence bar for dates, priority, project and issue links",
  );
  // Folded up from the schema by Task-285: one sentence in the description
  // instead of the same clause repeated on six properties.
  assert.match(
    manage,
    /delete only when the user explicitly asks/,
    "task_manage must keep delete an explicitly requested operation",
  );
  assert.match(
    manage,
    /empty string clears/,
    "task_manage must say how an update clears a field",
  );
});
