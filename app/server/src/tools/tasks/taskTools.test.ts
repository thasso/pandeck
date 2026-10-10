import assert from "node:assert/strict";
import { test } from "vitest";
import { createTask, deleteTask, readTask } from "../../tasks.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { affirmed, assertPromptRules } from "../../test/promptRules.ts";
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

test("task_manage closes a Task out in ONE call: edit and suggestion", async () => {
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
    if (result.content[0]?.type === "text")
      assert.equal(result.content[0].text, JSON.stringify(payload));

    const read = taskToolsForKind("assistant").find(
      (candidate) => candidate.name === "task_read",
    )!;
    const after = await read.execute(
      { id: task.id, includeDescriptions: true },
      ctx,
    );
    const readPayload = after.details as {
      items: Array<{ description?: string }>;
    };
    assert.equal(
      readPayload.items[0]?.description,
      "Intro line.\n\nOutcome: shipped.\n\nTrailer, revised.",
    );
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

test("task_manage resolves a duplicate Slack create onto the existing Task", async () => {
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
          },
        ],
      },
      ctx,
    );
    const payload = result.details as ManageResult;

    // No second Task: the create resolves to the one that already exists.
    assert.equal(payload.changed[0]?.id, existing.id);
    assert.match(payload.warnings?.[0] ?? "", /Skipped duplicate Slack import/);
    // Flagged on the ENTRY too: the payload never says which operation produced
    // one, so a renderer taking the verb from the call would say "created" about
    // a Task that already existed.
    assert.equal(payload.changed[0]?.deduplicated, true);
  } finally {
    deleteTask(existing.id);
  }
});

/** The budget the read tool bounds itself to, plus the slack of a JSON envelope. */
const READ_BUDGET_BYTES = 24_000;

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
  };
}

function resultBytes(result: ToolResult): number {
  const first = result.content[0];
  return first?.type === "text" ? Buffer.byteLength(first.text, "utf8") : 0;
}

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
    const result = await readTool().execute(
      {
        id: parent.id,
        includeSubtasks: true,
        includeDescriptions: true,
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
  assertPromptRules({
    task_read: {
      text: readTool().description,
      rules: {
        "results-are-byte-bounded": /byte-bounded|bounded by bytes/i,
        "narrow-not-assume-complete": affirmed(
          /(?<key>narrow)[^.\n]*(instead of|rather than) assum/i,
        ),
      },
    },
    task_manage: {
      text: manageTool().description,
      rules: {
        "create-only-for-later-work": /not (happen|be done) in this session/i,
        "created-lands-in-inbox":
          /Inbox[^.\n]*untriaged|untriaged[^.\n]*Inbox/i,
        "status-is-a-suggestion": affirmed(
          /(?<subject>status writes? (are|is))(?<what> (only )?(a )?suggestions?)[^.\n]*?\buser\b[^.\n]*?(?<verb>answer|decide|accept|confirm)/i,
        ),
        "evidence-bar-for-fields": /(explicit|strong) evidence/i,
        // Folded up from six schema properties by Task-285.
        "delete-only-on-request": affirmed(
          /delete only (when|if) the user (explicitly )?(asks|requests)|delete only on (explicit )?(user )?request/i,
        ),
        "empty-string-clears": /empty string[^.\n]*clears?/i,
      },
    },
  });
});
