import assert from "node:assert/strict";
import { test } from "vitest";
import { createTask, updateTask } from "../../tasks.ts";
import { readInitiative, setInitiativeMilestones } from "../../initiatives.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { affirmed, assertPromptRules } from "../../test/promptRules.ts";
import { toolGroupsFor } from "../catalog.ts";
import { initiativeTools } from "./initiativeTools.ts";

const BUDGET = 24_000;

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

function textOf(result: ToolResult): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

/** The answer's text, asserted within the budget in UTF-8 bytes. */
function bounded(result: ToolResult): string {
  const text = textOf(result);
  assert.ok(
    Buffer.byteLength(text, "utf8") <= BUDGET,
    `answer is ${Buffer.byteLength(text, "utf8")} bytes`,
  );
  assert.deepEqual(JSON.parse(text), result.details);
  return text;
}

interface ManageAnswer {
  changedCount: number;
  changed: Array<{
    id: string;
    title: string;
    state: string;
    archived?: boolean;
    progress: { total: number };
    milestoneCount: number;
    absorbedTaskIds?: string[];
    stillMembers?: Array<{ taskId: string; through: string }>;
  }>;
  omittedForBudget?: number;
  deletedIds?: string[];
}

async function manage(operations: Record<string, unknown>[]) {
  const result = await manageTool().execute({ operations }, ctx);
  bounded(result);
  return result.details as ManageAnswer;
}

interface ToolMember {
  id: string;
  status: string;
  blocked?: boolean;
  parentId?: string;
  milestone?: boolean;
  blockedBy?: string[];
  blockedByCount?: number;
  children?: ToolMember[];
}

interface ReadAnswer {
  description?: string;
  descriptionTruncated?: boolean;
  milestoneIds?: string[];
  milestonesOmitted?: number;
  externalBlockers?: Array<{ id: string }>;
  externalBlockersOmitted?: number;
  totalMembers: number;
  offset?: number;
  members: ToolMember[];
  truncated?: boolean;
  nextOffset?: number;
}

async function read(id: string, offset?: number): Promise<ReadAnswer> {
  const result = await readTool().execute(
    { id, ...(offset !== undefined ? { offset } : {}) },
    ctx,
  );
  bounded(result);
  return result.details as ReadAnswer;
}

function flatten(members: readonly ToolMember[]): ToolMember[] {
  return members.flatMap((member) => [
    member,
    ...flatten(member.children ?? []),
  ]);
}

test("initiative_manage creates with members, marks a covered milestone, and reports compactly", async () => {
  const epic = task("Tool epic", undefined, "A long body that never travels.");
  const sub = task("Tool sub", epic);
  const release = task("Tool release");
  updateTask(release, { addLinks: [{ type: "blocked-by", taskId: sub }] });

  const created = await manage([
    {
      operation: "create",
      title: "Hosted rollout",
      description: "Across three projects.",
      taskIds: [epic, sub, release],
    },
  ]);
  const entry = created.changed[0]!;
  const id = entry.id;
  assert.equal(entry.progress.total, 3);
  assert.deepEqual(entry.absorbedTaskIds, [sub], "the epic absorbed its sub");

  const marked = await manage([
    { operation: "setMilestone", id, taskIds: [release, sub] },
    { operation: "update", id, state: "paused" },
  ]);
  assert.equal(marked.changedCount, 1, "one Initiative, reported once");
  assert.equal(marked.changed[0]!.milestoneCount, 2);
  assert.equal(marked.changed[0]!.state, "paused");

  const removed = await manage([
    { operation: "removeMembers", id, taskIds: [sub] },
  ]);
  assert.deepEqual(removed.changed[0]!.stillMembers, [
    { taskId: sub, through: epic },
  ]);

  const result = await readTool().execute({ id }, ctx);
  const text = bounded(result);
  assert.ok(!text.includes("never travels"), "no Task description");
  const detail = result.details as ReadAnswer;
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
  assert.equal(detail.members[1]!.blocked, true);
  assert.equal(detail.members[1]!.status, "todo");
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
    manage([{ operation: "setMilestone", id, taskIds: [task("Outside")] }]),
    /not a member/,
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
  bounded(listed);
  const items = (listed.details as { items: Array<{ id: string }> }).items;
  assert.ok(items.some((item) => item.id === id));
  await assert.rejects(
    readTool().execute({ state: "done", offset: 1 }, ctx),
    /offset applies only to a read by id/,
  );

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

test("a big tree pages on nextOffset until every member was read once", async () => {
  const epic = task("Big epic");
  for (let index = 0; index < 220; index += 1)
    task(`Subtask ${index} ${"x".repeat(80)}`, epic);
  const { changed } = await manage([
    { operation: "create", title: "Big", taskIds: [epic] },
  ]);
  const id = changed[0]!.id;
  const seen: string[] = [];
  let page = await read(id);
  assert.equal(page.totalMembers, 221);
  assert.equal(page.truncated, true);
  assert.ok(page.members[0]!.children!.length > 0, "the tree kept its root");
  seen.push(...flatten(page.members).map((member) => member.id));
  let pages = 1;
  while (page.nextOffset !== undefined) {
    const next = await read(id, page.nextOffset);
    assert.equal(next.offset, page.nextOffset);
    assert.equal(next.description, undefined, "only the first page has it");
    assert.equal(
      next.members[0]!.parentId,
      epic,
      "a page top says where it hangs",
    );
    seen.push(...flatten(next.members).map((member) => member.id));
    page = next;
    pages += 1;
  }
  assert.ok(pages > 1);
  assert.equal(seen.length, 221);
  assert.equal(new Set(seen).size, 221);
});

test("the whole read stays bounded under many outside blockers, milestones and multibyte text", async () => {
  const wide = "界".repeat(200);
  const epic = task(`Multibyte epic ${wide}`);
  const blocked = task(`Blocked ${wide}`, epic);
  for (let index = 0; index < 200; index += 1) {
    const outside = task(`Outside ${index} ${wide}`);
    updateTask(blocked, {
      addLinks: [{ type: "blocked-by", taskId: outside }],
    });
  }
  const milestones: string[] = [];
  for (let index = 0; index < 30; index += 1)
    milestones.push(task(`Milestone ${index} ${wide}`, epic));
  const { changed } = await manage([
    {
      operation: "create",
      title: wide,
      description: "説明".repeat(5_000),
      taskIds: [epic],
    },
  ]);
  const id = changed[0]!.id;
  setInitiativeMilestones(id, milestones, true);

  const detail = await read(id);
  assert.equal(detail.descriptionTruncated, true);
  assert.equal(detail.milestoneIds!.length, 20);
  assert.equal(detail.milestonesOmitted, 10);
  assert.ok(detail.externalBlockersOmitted! > 0);
  assert.equal(
    detail.externalBlockers!.length + detail.externalBlockersOmitted!,
    200,
  );
  const members = flatten(detail.members);
  assert.ok(members.length > 0, "members still fit beside the capped lists");
  const blockedNode = members.find((member) => member.id === blocked);
  assert.ok(blockedNode, "the blocked member is on the first page");
  assert.equal(blockedNode.blockedBy!.length, 10);
  assert.equal(blockedNode.blockedByCount, 200);
  // Reading on reaches every member.
  let page = detail;
  let total = members.length;
  while (page.nextOffset !== undefined) {
    page = await read(id, page.nextOffset);
    total += flatten(page.members).length;
  }
  assert.equal(total, 32);
});

test("a manage answer of twenty wide Initiatives stays bounded", async () => {
  const wide = "界".repeat(200);
  const answer = await manage(
    Array.from({ length: 20 }, () => ({ operation: "create", title: wide })),
  );
  assert.equal(answer.changedCount, 20);
  assert.equal(answer.changed.length + (answer.omittedForBudget ?? 0), 20);
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
        "read-on": /nextOffset/,
      },
    },
    initiative_manage: {
      text: manageTool().description,
      rules: {
        "delete-only-on-request": affirmed(
          /delete only (when|if) the user (explicitly )?(asks|requests)/i,
        ),
        "under-a-member-refused": /adding a Task under a member is refused/i,
        "epic-absorbs": /adding an epic absorbs/i,
        "covered-milestone":
          /milestone is a member Task, even one inside a member epic/i,
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

test("control characters in an accepted description cannot overrun the read or stall its paging", async () => {
  const epic = task(`Escaped epic ${"\u0001".repeat(190)}`);
  for (let index = 0; index < 60; index += 1)
    task(`Escaped ${index} ${"\u0000".repeat(180)}`, epic);
  const { changed } = await manage([
    {
      operation: "create",
      title: "\u0000".repeat(200),
      description: "\u0000".repeat(4_000) + "\u001f".repeat(4_000),
      taskIds: [epic],
    },
  ]);
  const id = changed[0]!.id;
  let page = await read(id);
  assert.equal(page.descriptionTruncated, true);
  let total = flatten(page.members).length;
  assert.ok(total > 0, "the first page carries members beside the head");
  let pages = 1;
  while (page.nextOffset !== undefined) {
    const before = page.nextOffset;
    page = await read(id, page.nextOffset);
    const got = flatten(page.members).length;
    assert.ok(got > 0, `page at ${before} advanced`);
    total += got;
    pages += 1;
  }
  assert.ok(pages > 1);
  assert.equal(total, 61);
});

test("answers name canonical ids, never the caller's spelling", async () => {
  const { changed } = await manage([
    { operation: "create", title: "Canonical ids" },
  ]);
  const id = changed[0]!.id;
  const padded = `${"0".repeat(24_000)}${id}`;
  const renamed = await manage([
    { operation: "update", id: padded, title: "Renamed" },
    { operation: "archive", id: padded },
    { operation: "unarchive", id },
  ]);
  assert.equal(renamed.changedCount, 1, "one Initiative, however spelled");
  assert.equal(renamed.changed[0]!.id, id);
  const deleted = await manage([{ operation: "delete", id: padded }]);
  assert.deepEqual(deleted.deletedIds, [id]);
  for (const call of [
    () => manage([{ operation: "delete", id: padded }]),
    () => readTool().execute({ id: padded }, ctx),
    () => manage([{ operation: padded, id }]),
    () =>
      manage([
        { operation: "create", title: "x", taskIds: [`${"9".repeat(30_000)}`] },
      ]),
  ])
    await assert.rejects(call, (error: Error) => {
      assert.ok(
        Buffer.byteLength(error.message, "utf8") < 400,
        `error is ${Buffer.byteLength(error.message, "utf8")} bytes`,
      );
      return true;
    });
});

test("a batch reports removed Tasks as still members only as the batch leaves them", async () => {
  const top = task("Batch top");
  const leaf = task("Batch leaf", top);
  const { changed } = await manage([
    { operation: "create", title: "Batch final", taskIds: [top] },
  ]);
  const id = changed[0]!.id;
  await manage([{ operation: "setMilestone", id, taskIds: [leaf] }]);
  const both = await manage([
    { operation: "removeMembers", id, taskIds: [leaf] },
    { operation: "removeMembers", id, taskIds: [top] },
  ]);
  assert.equal(both.changed[0]!.stillMembers, undefined);
  assert.equal(readInitiative(id)!.progress.total, 0);

  await manage([
    { operation: "addMembers", id, taskIds: [top] },
    { operation: "setMilestone", id, taskIds: [leaf] },
  ]);
  const kept = await manage([
    { operation: "removeMembers", id, taskIds: [leaf] },
  ]);
  assert.deepEqual(kept.changed[0]!.stillMembers, [
    { taskId: leaf, through: top },
  ]);
  // Removed while covered, then the Initiative itself is deleted: nothing
  // remains to be a member of.
  const gone = await manage([
    { operation: "setMilestone", id, taskIds: [leaf] },
    { operation: "removeMembers", id, taskIds: [leaf] },
    { operation: "delete", id },
  ]);
  assert.deepEqual(gone.changed, []);
  assert.deepEqual(gone.deletedIds, [id]);
});
