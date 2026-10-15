import assert from "node:assert/strict";
import { test } from "vitest";
import { createTask, updateTask } from "../../tasks.ts";
import { readInitiative } from "../../initiatives.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { affirmed, assertPromptRules } from "../../test/promptRules.ts";
import { toolGroupsFor } from "../catalog.ts";
import { initiativeTools } from "./initiativeTools.ts";

const ctx: ToolCallContext = {
  toolCallId: "initiative-tool-test",
  session: {
    sessionId: "initiative-tool-test-session",
    harness: "pi",
    agentType: "developer",
  },
};

const readTool = () =>
  initiativeTools().find((tool) => tool.name === "initiative_read")!;
const manageTool = () =>
  initiativeTools().find((tool) => tool.name === "initiative_manage")!;

function task(title: string, parentId?: string, description = ""): string {
  return createTask({
    title,
    description,
    source: { createdBy: "user" },
    ...(parentId ? { parentId } : {}),
  }).id;
}

async function manage(operations: Record<string, unknown>[]) {
  const result = await manageTool().execute({ operations }, ctx);
  return result.details as {
    changedCount: number;
    changed: Array<{
      id: string;
      title: string;
      state: string;
      archived?: boolean;
      progress: { total: number };
      milestoneIds: string[];
    }>;
    deletedIds?: string[];
  };
}

test("initiative_manage creates with members, marks a milestone, and reports compactly", async () => {
  const epic = task("Tool epic", undefined, "A long body that never travels.");
  const sub = task("Tool sub", epic);
  const release = task("Tool release");
  updateTask(release, { addLinks: [{ type: "blocked-by", taskId: sub }] });

  const created = await manage([
    {
      operation: "create",
      title: "Hosted rollout",
      description: "Across three projects.",
      taskIds: [epic, release],
    },
  ]);
  const id = created.changed[0]!.id;
  assert.equal(created.changed[0]!.progress.total, 3);

  const marked = await manage([
    { operation: "setMilestone", id, taskIds: [release] },
    { operation: "update", id, state: "paused" },
  ]);
  assert.equal(marked.changedCount, 1, "one Initiative, reported once");
  assert.deepEqual(marked.changed[0]!.milestoneIds, [release]);
  assert.equal(marked.changed[0]!.state, "paused");

  const read = await readTool().execute({ id }, ctx);
  const text = read.content[0]!.type === "text" ? read.content[0]!.text : "";
  assert.ok(!text.includes("never travels"), "no Task description");
  const detail = read.details as {
    description: string;
    milestoneIds: string[];
    members: Array<{
      id: string;
      children?: Array<{ id: string }>;
      blockedBy?: string[];
      milestone?: boolean;
    }>;
  };
  assert.equal(detail.description, "Across three projects.");
  assert.deepEqual(
    detail.members.map((member) => member.id),
    [epic, release],
  );
  assert.deepEqual(
    detail.members[0]!.children?.map((child) => child.id),
    [sub],
  );
  assert.deepEqual(detail.members[1]!.blockedBy, [sub]);
  assert.equal(detail.members[1]!.milestone, true);
});

test("initiative_manage refusals throw, and each operation is all or nothing", async () => {
  const epic = task("Refused epic");
  const child = task("Refused child", epic);
  const { changed } = await manage([
    { operation: "create", title: "Refusals", taskIds: [epic] },
  ]);
  const id = changed[0]!.id;

  await assert.rejects(
    manage([{ operation: "addMembers", id, taskIds: [child] }]),
    /already a member .* through its ancestor/,
  );
  await assert.rejects(
    manage([{ operation: "archive", id, taskIds: [child] }]),
    /taskIds does not apply to archive/,
  );
  await assert.rejects(
    manage([{ operation: "addMembers", id }]),
    /addMembers requires taskIds/,
  );
  await assert.rejects(manage([{ operation: "update", id }]), /needs a title/);
  await assert.rejects(manage([{ operation: "archive" }]), /requires id/);
  await assert.rejects(manage([]), /at least one operation/);
  // An earlier operation in the batch stays written, like task_manage.
  const lone = task("Lone");
  await assert.rejects(
    manage([
      { operation: "addMembers", id, taskIds: [lone] },
      { operation: "addMembers", id, taskIds: ["999999"] },
    ]),
    /Task not found/,
  );
  assert.equal(readInitiative(id)!.progress.total, 3);
});

test("initiative_read lists by state, and delete removes the Initiative", async () => {
  const { changed } = await manage([
    { operation: "create", title: "Listed done", state: "done" },
  ]);
  const id = changed[0]!.id;
  const listed = await readTool().execute({ state: "done" }, ctx);
  const items = (listed.details as { items: Array<{ id: string }> }).items;
  assert.ok(items.some((item) => item.id === id));

  await manage([{ operation: "archive", id }]);
  const hidden = await readTool().execute({ state: "done" }, ctx);
  assert.ok(
    !(hidden.details as { items: Array<{ id: string }> }).items.some(
      (item) => item.id === id,
    ),
  );
  const deleted = await manage([{ operation: "delete", id }]);
  assert.deepEqual(deleted.deletedIds, [id]);
  assert.deepEqual(deleted.changed, []);
  await assert.rejects(readTool().execute({ id }, ctx), /Initiative not found/);
});

test("a read by id is byte-bounded at a node boundary", async () => {
  const epic = task("Big epic");
  for (let index = 0; index < 220; index += 1)
    task(`Subtask ${index} ${"x".repeat(80)}`, epic);
  const { changed } = await manage([
    { operation: "create", title: "Big", taskIds: [epic] },
  ]);
  const read = await readTool().execute({ id: changed[0]!.id }, ctx);
  const text = read.content[0]!.type === "text" ? read.content[0]!.text : "";
  assert.ok(Buffer.byteLength(text) <= 24_000, `${Buffer.byteLength(text)}`);
  const detail = read.details as {
    truncated?: boolean;
    omittedForBudget?: number;
    members: Array<{ children?: unknown[] }>;
  };
  assert.equal(detail.truncated, true);
  assert.ok(detail.omittedForBudget! > 0);
  assert.ok(detail.members[0]!.children!.length > 0, "the tree kept its root");
});

test("the tools are deferred and reach only developer and personal-assistant", () => {
  for (const agentType of ["developer", "personal-assistant"] as const) {
    const group = toolGroupsFor(agentType).find(
      (candidate) => candidate.id === "initiatives",
    );
    assert.ok(group, `${agentType} has no initiatives group`);
    assert.equal(group.loading, "deferred");
    assert.deepEqual(
      group.tools.map((tool) => [tool.name, tool.sideEffects]),
      [
        ["initiative_read", "none"],
        ["initiative_manage", "local"],
      ],
    );
  }
  for (const agentType of ["assistant", "workshop"] as const)
    assert.ok(
      !toolGroupsFor(agentType).some((group) => group.id === "initiatives"),
      `${agentType} should not carry Initiative tools`,
    );
});

/** The rules no schema field states, pinned by pattern. */
test("Initiative tool descriptions carry their rules", () => {
  assertPromptRules({
    initiative_read: {
      text: readTool().description,
      rules: {
        "no-task-descriptions": /Task descriptions are a task_read away/i,
        "byte-bounded": /byte-bounded/i,
      },
    },
    initiative_manage: {
      text: manageTool().description,
      rules: {
        "delete-only-on-request": affirmed(
          /delete only (when|if) the user (explicitly )?(asks|requests)/i,
        ),
        "add-the-epic": /add an epic rather than its subtasks/i,
        "dependencies-are-links":
          /dependencies[^.\n]*task_manage blocks links/i,
      },
    },
    "initiative_manage.state": {
      text: JSON.stringify(manageTool().parameters),
      rules: {
        "state-never-derived": /never derived from the Tasks/i,
      },
    },
  });
});
