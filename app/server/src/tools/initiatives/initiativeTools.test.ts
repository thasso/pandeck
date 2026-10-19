import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { InitiativeDetail } from "@assistant/shared";
import { createTask, updateTask } from "../../tasks.ts";
import {
  listInitiatives,
  readInitiative,
  setInitiativeMilestones,
} from "../../initiatives.ts";
import type { ToolCallContext, ToolResult } from "../../mcp/tool.ts";
import { deepTaskChain } from "../../test/deepTaskChain.ts";
import { affirmed, assertPromptRules } from "../../test/promptRules.ts";
import { toolGroupsFor } from "../catalog.ts";
import { initiativeTools } from "./initiativeTools.ts";

const BUDGET = 24_000;
/** The tool's whole-record caps: a read's head, a member, an outside blocker. */
const HEAD_MAX = 19_000;
const NODE_MAX = 4_000;
const BLOCKER_MAX = 2_000;

/**
 * Details the read serves for ids no store holds: a generic shape whose every
 * string may be far larger than the store accepts today.
 */
const synthetic = vi.hoisted(() => new Map<string, InitiativeDetail>());
vi.mock("../../initiatives.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../initiatives.ts")>();
  return {
    ...real,
    readInitiative: (id: string) =>
      synthetic.get(id) ?? real.readInitiative(id),
  };
});

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

/** Fields a record left out or cut to fit its cap. */
interface FitNote {
  omitted?: string[];
  clipped?: string[];
}

interface ToolMember extends FitNote {
  id: string;
  title?: string;
  status: string;
  blocked?: boolean;
  projectId?: string;
  milestone?: boolean;
  archived?: boolean;
  parentId?: string;
  blockedBy?: string[];
  blockedByCount?: number;
  children?: ToolMember[];
}

interface ReadAnswer extends FitNote {
  id: string;
  title: string;
  description?: string;
  descriptionTruncated?: boolean;
  milestoneIds?: string[];
  milestonesOmitted?: number;
  externalBlockers?: Array<{ id: string; projectId?: string } & FitNote>;
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
  const answer = result.details as ReadAnswer;
  assertEnvelope(answer, offset ?? 0);
  return answer;
}

function flatten(members: readonly ToolMember[]): ToolMember[] {
  return members.flatMap((member) => [
    member,
    ...flatten(member.children ?? []),
  ]);
}

const MEMBER_KEYS = new Set([
  "id",
  "title",
  "status",
  "blocked",
  "projectId",
  "milestone",
  "archived",
  "parentId",
  "blockedBy",
  "blockedByCount",
  "omitted",
  "clipped",
  "children",
]);

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * One record's fit notes are true: each omitted field may be given up and is
 * absent, each clipped one is required and ends in the clip mark, none twice.
 */
function assertFitNote(
  record: FitNote,
  droppable: readonly string[],
  clippable: readonly string[],
) {
  const { omitted = [], clipped = [] } = record;
  const fields = record as Record<string, unknown>;
  assert.equal(new Set(omitted).size, omitted.length);
  assert.equal(new Set(clipped).size, clipped.length);
  for (const key of omitted) {
    assert.ok(droppable.includes(key), `${key} may not be omitted`);
    assert.equal(fields[key], undefined, `omitted ${key} is absent`);
  }
  for (const key of clipped) {
    assert.ok(clippable.includes(key), `${key} may not be clipped`);
    const value = fields[key];
    assert.ok(typeof value === "string" && value.endsWith("…"), key);
  }
}

/**
 * The whole envelope of a read by id: within the budget (`bounded`), its head,
 * each outside blocker and each member within their caps with true fit notes,
 * only known member fields, and a `nextOffset` that moved on.
 */
function assertEnvelope(answer: ReadAnswer, offset: number) {
  const { members, truncated, nextOffset, ...head } = answer;
  assert.ok(bytesOf(head) <= HEAD_MAX, `head is ${bytesOf(head)} bytes`);
  assertFitNote(
    head,
    ["externalBlockers", "description", "milestoneIds"],
    ["title", "id"],
  );
  for (const stub of answer.externalBlockers ?? []) {
    assert.ok(bytesOf(stub) <= BLOCKER_MAX, `blocker is ${bytesOf(stub)}`);
    assertFitNote(stub, ["projectId"], ["title", "id"]);
  }
  for (const member of flatten(members)) {
    const { children, ...own } = member;
    assert.ok(bytesOf(own) <= NODE_MAX, `member is ${bytesOf(own)} bytes`);
    for (const key of Object.keys(member)) assert.ok(MEMBER_KEYS.has(key), key);
    assertFitNote(own, ["projectId", "blockedBy"], ["title", "parentId", "id"]);
    if (children) assert.ok(children.length > 0);
  }
  if (nextOffset !== undefined) {
    assert.equal(truncated, true);
    assert.ok(nextOffset > offset, `page at ${offset} advanced`);
    assert.ok(members.length > 0);
  }
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

/**
 * Levels below the root. A recursive member walk in a test worker on Node 24
 * read 6,000 levels and overflowed at 7,000.
 */
const DEEP = 10_000;

test("a hierarchy deeper than any call stack: manage answers the writes it landed, and the read pages it whole", async () => {
  const deep = deepTaskChain(DEEP);
  const [root] = deep.chain;
  const leaf = deep.chain.at(-1)!;
  // The answer reads the graph after the writes committed. Failing there
  // would report landed writes as failed, and a retried create would make a
  // second Initiative.
  const created = await manage([
    { operation: "create", title: "Deep chain", taskIds: [root] },
  ]);
  const id = created.changed[0]!.id;
  assert.equal(created.changed[0]!.progress.total, DEEP + 2);
  const marked = await manage([
    { operation: "setMilestone", id, taskIds: [leaf] },
  ]);
  assert.equal(marked.changed[0]!.milestoneCount, 1);
  assert.deepEqual(
    listInitiatives({ query: "Deep chain" }).map((item) => item.id),
    [id],
  );

  const order = [
    ...deep.chain.slice(0, deep.branchAt + 1),
    deep.side,
    ...deep.chain.slice(deep.branchAt + 1),
  ];
  const seen: ToolMember[] = [];
  let page = await read(id);
  assert.equal(page.totalMembers, DEEP + 2);
  assert.equal(page.members[0]!.id, root);
  for (;;) {
    const members = flatten(page.members);
    if (seen.length > 0) {
      const top = page.members[0]!;
      const above = order.indexOf(top.id) - 1;
      const parent =
        top.id === deep.chain[deep.branchAt + 1]
          ? deep.chain[deep.branchAt]
          : order[above];
      assert.equal(top.parentId, parent, "a page top says where it hangs");
    }
    seen.push(...members);
    if (page.nextOffset === undefined) break;
    page = await read(id, page.nextOffset);
  }
  assert.deepEqual(
    seen.map((member) => member.id),
    order,
  );
  const byId = new Map(seen.map((member) => [member.id, member]));
  assert.equal(byId.get(leaf)!.milestone, true);
  assert.equal(byId.get(deep.side)!.archived, true);
  assert.equal(byId.get(deep.side)!.status, "done");
}, 120_000);

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
        "opt-in-activity": /includeActivity/,
      },
    },
    "initiative_read.includeActivity": {
      text: JSON.stringify(readTool().parameters),
      rules: {
        "positive-roots":
          /task-start.*Task-linked worktrees.*Workflow Run roles/,
        "reference-exclusion": /Passive references do not qualify/,
        "activity-drops-first":
          /Activity is omitted before other member fields/,
        "snapshot-pr": /last observed, not a provider refresh/,
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

test("removeMembers takes its list in any order and names the Tasks it absorbed", async () => {
  const epic = task("Any-order epic");
  const child = task("Any-order child", epic);
  for (const order of [
    [child, epic],
    [epic, child],
  ]) {
    const { changed } = await manage([
      { operation: "create", title: "Any order", taskIds: [epic] },
    ]);
    const id = changed[0]!.id;
    const removed = await manage([
      { operation: "removeMembers", id, taskIds: order },
    ]);
    assert.deepEqual(
      removed.changed[0]!.absorbedTaskIds,
      [child],
      `order ${order.join(",")}`,
    );
    assert.equal(removed.changed[0]!.stillMembers, undefined);
    assert.equal(readInitiative(id)!.progress.total, 0);
  }

  // A later operation never makes an earlier list valid: the first one is
  // refused as written, and the batch stops there.
  const { changed } = await manage([
    { operation: "create", title: "Not retroactive", taskIds: [epic] },
  ]);
  const id = changed[0]!.id;
  await assert.rejects(
    manage([
      { operation: "removeMembers", id, taskIds: [child] },
      { operation: "removeMembers", id, taskIds: [epic] },
    ]),
    new RegExp(`only through Task-${epic}`),
  );
  assert.equal(readInitiative(id)!.rootIds[0], epic);
});

test("an accepted 30,000-byte projectId cannot overrun a first or later page", async () => {
  // Task writes accept an unknown projectId with a warning and store it whole.
  const huge = "p".repeat(30_000);
  const created = (title: string, projectId: string, parentId?: string) =>
    createTask({
      title,
      description: "",
      source: { createdBy: "user" },
      projectId,
      ...(parentId ? { parentId } : {}),
    }).id;
  const epic = created("Huge project epic", huge);
  const small = created("Small project member", "small-project", epic);
  const subtasks: string[] = [];
  for (let index = 0; index < 150; index += 1)
    subtasks.push(created(`Huge ${index} ${"y".repeat(150)}`, huge, epic));
  const outside = created("Huge project outside", huge);
  updateTask(subtasks[0]!, {
    addLinks: [{ type: "blocked-by", taskId: outside }],
  });
  const { changed } = await manage([
    { operation: "create", title: "Huge projects", taskIds: [epic] },
  ]);
  const id = changed[0]!.id;
  setInitiativeMilestones(id, [subtasks[1]!], true);

  const first = await read(id);
  assert.equal(first.totalMembers, 152);
  assert.equal(first.truncated, true);
  assert.equal(first.members[0]!.id, epic, "the first node is the huge one");
  assert.deepEqual(first.externalBlockers, [
    {
      id: outside,
      title: "Huge project outside",
      status: "todo",
      omitted: ["projectId"],
    },
  ]);
  let page = first;
  const seen: ToolMember[] = flatten(first.members);
  let pages = 1;
  while (page.nextOffset !== undefined) {
    page = await read(id, page.nextOffset);
    const top = page.members[0]!;
    assert.equal(top.parentId, epic, "a later page's top still hangs on");
    assert.deepEqual(top.omitted, ["projectId"]);
    seen.push(...flatten(page.members));
    pages += 1;
  }
  assert.ok(pages > 1, "the tree needed a continuation page");
  assert.equal(new Set(seen.map((member) => member.id)).size, 152);
  assert.equal(seen.length, 152);
  for (const member of seen) {
    assert.equal(member.clipped, undefined, "titles fit whole");
    assert.ok(member.title);
    if (member.id === small) {
      assert.equal(member.projectId, "small-project");
      assert.equal(member.omitted, undefined);
    } else {
      assert.equal(member.projectId, undefined);
      assert.deepEqual(member.omitted, ["projectId"]);
    }
  }
  const blockedMember = seen.find((member) => member.id === subtasks[0]);
  assert.deepEqual(blockedMember!.blockedBy, [outside]);
  assert.equal(blockedMember!.blocked, true);
  assert.equal(seen.find((m) => m.id === subtasks[1])!.milestone, true);
});

test("every string of a read may be oversized: fields drop, then clip, and paging still advances", async () => {
  const big = (mark: string, index: number | string = "") =>
    `${mark}${index}-${"\u0000界".repeat(6_000)}`;
  const stubs = Array.from({ length: 12 }, (_, index) => ({
    id: big("stub", index),
    title: big("stub title", index),
    status: "todo" as const,
    projectId: big("stub project", index),
  }));
  const root = {
    id: big("root"),
    title: big("root title"),
    status: "doing" as const,
    blocked: true as const,
    projectId: big("root project"),
    direct: true as const,
    milestone: true as const,
  };
  const children = Array.from({ length: 40 }, (_, index) => ({
    // Short ids beside huge ones: a generic shape, not a canonical number.
    id: index % 2 ? big("child", index) : `child-${index}`,
    title: big("child title", index),
    status: "todo" as const,
    projectId: big("child project", index),
    parentId: root.id,
    ...(index % 5 === 0 ? { archived: true as const } : {}),
    // A future field the tool does not name never reaches the answer.
    label: big("label", index),
  }));
  const nodes = [root, ...children];
  const progress = {
    total: nodes.length,
    done: 0,
    doing: 1,
    startable: 40,
    blocked: 1,
  };
  synthetic.set("synthetic", {
    id: big("initiative"),
    title: big("initiative title"),
    state: "active",
    progress,
    sessionIds: [],
    sessionCount: 0,
    updatedAt: 0,
    description: big("description"),
    createdAt: 0,
    rootIds: [root.id],
    nodes,
    externalBlockers: stubs,
    edges: [
      ...stubs.map((stub) => ({ from: stub.id, to: root.id })),
      { from: root.id, to: children[1]!.id },
    ],
    milestoneIds: Array.from({ length: 25 }, (_, index) => big("ms", index)),
  });

  const sources = new Map(nodes.map((node) => [node.id, node]));
  let offset = 0;
  const seen: ToolMember[] = [];
  const blockerCount = new Map([
    [root.id, stubs.length],
    [children[1]!.id, 1],
  ]);
  let page = await read("synthetic");
  // Twenty 54 KB milestone ids alone outgrow a head: every optional list
  // goes, in order, then the title and the id are cut.
  assert.deepEqual(page.omitted, [
    "externalBlockers",
    "description",
    "milestoneIds",
  ]);
  assert.equal(page.descriptionTruncated, undefined);
  assert.equal(page.milestonesOmitted, undefined);
  assert.deepEqual(page.clipped, ["title", "id"]);
  for (;;) {
    const got = flatten(page.members);
    assert.ok(got.length > 0, `page at ${offset} advanced`);
    got.forEach((member, index) => {
      const source = nodes[offset + index]!;
      assert.equal(member.status, source.status);
      assert.equal(member.blocked, "blocked" in source ? true : undefined);
      assert.equal(member.archived, "archived" in source ? true : undefined);
      assert.equal(member.milestone, "milestone" in source ? true : undefined);
      assert.ok(!("label" in member) && !("direct" in member));
      for (const key of ["id", "title", "parentId"] as const) {
        const value = member[key];
        if (value === undefined) continue;
        const whole = (source as { [key: string]: unknown })[key] as string;
        if (member.clipped?.includes(key))
          assert.ok(whole.startsWith(value.slice(0, -1)), key);
        else assert.equal(value, whole, key);
      }
      // A page top names where it hangs, whole or clipped.
      if (index === 0 && "parentId" in source) assert.ok(member.parentId);
      // Their blockers' 54 KB ids cannot ride along; the count still does.
      const blockers = blockerCount.get(source.id) ?? 0;
      assert.deepEqual(
        member.omitted,
        blockers ? ["projectId", "blockedBy"] : ["projectId"],
      );
      assert.equal(member.blockedByCount, blockers > 10 ? blockers : undefined);
      assert.ok(sources.has(source.id));
    });
    seen.push(...got);
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
    page = await read("synthetic", offset);
    assert.equal(page.omitted, undefined, "a later page has no lists to drop");
    assert.deepEqual(page.clipped, ["title", "id"]);
  }
  assert.equal(seen.length, nodes.length, "every member read once");
  synthetic.delete("synthetic");
});
