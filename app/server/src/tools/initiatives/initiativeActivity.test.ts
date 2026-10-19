import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { InitiativeDetail, SessionListItem } from "@assistant/shared";
import { createTask, linkSessionToTask } from "../../tasks.ts";
import { createInitiative } from "../../initiatives.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import {
  getWorktree,
  insertWorktree,
  linkTaskToWorktree,
  linkSessionToWorktree,
  listWorktrees,
  markWorktreeRemovedForTests,
  worktreeIdsForTask,
} from "../../db/worktreeStore.ts";
import {
  createPullRequestCard,
  patchPullRequestCard,
} from "../../pullRequestCards.ts";
import { setInitiativeActivitySessionReaderForTests } from "../../initiativeActivityRead.ts";
import { freezeSessionAgent } from "../../agents/sessionAgent.ts";
import { listSessions } from "../../sessions.ts";
import { listWorktreeRecords } from "../../worktrees/worktrees.ts";
import { initiativeTools } from "./initiativeTools.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";

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
  toolCallId: "activity",
  session: { sessionId: "activity", harness: "pi", agentType: "developer" },
};
const tool = () => initiativeTools().find((t) => t.name === "initiative_read")!;
let serial = 0;
const unique = () => `initiative-activity-${serial++}`;
function task() {
  return createTask({ title: unique(), source: { createdBy: "user" } }).id;
}
function initiative(ids: string[]) {
  return String(
    createInitiative({ title: unique(), taskIds: ids }).initiative.id,
  );
}
function session(
  taskId?: string,
  origin: "task-start" | "reference" = "task-start",
) {
  const id = unique();
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    scope: "user",
    messageCount: 1,
  });
  if (taskId) linkSessionToTask(taskId, { sessionId: id, origin });
  return id;
}
function tree(taskId: string) {
  const id = unique();
  insertWorktree({
    id,
    projectId: "activity",
    mainRepoRoot: "/tmp/initiative-activity",
    path: `/tmp/${id}`,
    branch: id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  linkTaskToWorktree(taskId, id);
  return id;
}
function card(sessionId: string, worktreeId?: string) {
  const c = createPullRequestCard(
    {
      sessionId,
      ...(worktreeId ? { worktreeId } : {}),
      status: "merged",
      title: "merged",
      headBranch: "feature",
      baseBranch: "main",
      provider: "github",
      number: serial,
      url: `https://github.com/o/r/pull/${serial}`,
    },
    {
      repoRoot: "/tmp/initiative-activity",
      sessionKind: "developer",
      sessionId,
      headBranch: "feature",
      baseBranch: "main",
      draft: false,
      acceptedHeadSha: "accepted",
    },
  );
  patchPullRequestCard(c.id, {}, { observedHeadSha: "observed" });
}
afterEach(() => {
  setInitiativeActivitySessionReaderForTests();
  synthetic.clear();
});
async function read(id: string, includeActivity?: boolean, offset?: number) {
  const result = await tool().execute(
    {
      id,
      ...(includeActivity !== undefined ? { includeActivity } : {}),
      ...(offset !== undefined ? { offset } : {}),
    },
    ctx,
  );
  const text = result.content[0];
  assert.ok(text?.type === "text");
  assert.ok(Buffer.byteLength(text.text) <= 24000);
  return result.details as {
    activityAsOf?: string;
    nextOffset?: number;
    members: Array<{
      id: string;
      title: string;
      activity?: {
        stalled?: boolean;
        sessions: Array<{
          id: string;
          agent?: string;
          state: string;
          owedRepliesFrom: string[];
        }>;
        sessionCount?: number;
        worktrees: Array<{ id: string; status: string }>;
        pullRequests: Array<{ status: string; headSha?: string }>;
      };
      omitted?: string[];
      clipped?: string[];
    }>;
  };
}

test("opt-in keeps defaults identical, excludes references and hydrates outside owed peers in two batches", async () => {
  const t = task(),
    id = initiative([t]);
  const asker = session(t),
    reference = session(t, "reference"),
    peer = session();
  let overlay: Partial<SessionListItem> = {};
  const batches: string[][] = [];
  setInitiativeActivitySessionReaderForTests(async (ids) => {
    batches.push(ids);
    return (
      await listSessions([], () => 0, {
        includeArchived: true,
        onlyIds: new Set(ids),
      })
    ).map((row) =>
      row.id === asker
        ? { ...row, awaitingRepliesFrom: [peer] }
        : row.id === peer
          ? { ...row, ...overlay }
          : row,
    );
  });
  assert.deepEqual(await read(id), await read(id, false));
  assert.equal((await read(id)).activityAsOf, undefined);
  const answer = await read(id, true);
  assert.ok(answer.activityAsOf);
  assert.equal(answer.members[0]!.activity!.stalled, true);
  assert.deepEqual(
    answer.members[0]!.activity!.sessions.map((s) => s.id),
    [asker],
  );
  assert.deepEqual(batches, [[asker], [peer]]);
  assert.ok(!batches.flat().includes(reference));
  for (const state of [
    { isStreaming: true },
    { queuedWork: true },
    { awaitingInput: true },
  ]) {
    overlay = state;
    assert.equal(
      (await read(id, true)).members[0]!.activity!.stalled,
      undefined,
    );
  }
  overlay = { isStreaming: true };
  const callerRead = await tool().execute(
    { id, includeActivity: true },
    { ...ctx, session: { ...ctx.session, sessionId: peer } },
  );
  const callerActivity = (
    callerRead.details as Awaited<ReturnType<typeof read>>
  ).members[0]!.activity!;
  assert.equal(callerActivity.stalled, undefined);
  assert.deepEqual(callerActivity.sessions[0]!.owedRepliesFrom, [peer]);
  await assert.rejects(
    tool().execute({ includeActivity: true }, ctx),
    /includeActivity/,
  );
});

test("settled active sessions hydrate their owed peers and frozen agents", async () => {
  const t = task(),
    id = initiative([t]);
  const settled = session(t),
    peer = session();
  sessionStore.setSettled(settled, true);
  freezeSessionAgent(settled, {
    name: "test-implementer",
    blob: "0".repeat(40),
    persona: "developer",
    provider: "claude-sdk",
    model: "opus",
    effort: "high",
    runtimeSource: "definition",
    denyTools: [],
    skills: [],
    body: "Implement the Task.",
  });
  let overlay: Partial<SessionListItem> = {};
  const batches: string[][] = [];
  setInitiativeActivitySessionReaderForTests(async (ids) => {
    batches.push(ids);
    return (
      await listSessions([], () => 0, {
        includeArchived: true,
        onlyIds: new Set(ids),
      })
    ).map((row) =>
      row.id === settled
        ? { ...row, settledAt: 1, awaitingRepliesFrom: [peer], ...overlay }
        : row,
    );
  });
  for (const state of [{ isStreaming: true }, { awaitingInput: true }]) {
    overlay = state;
    batches.length = 0;
    const activity = (await read(id, true)).members[0]!.activity!;
    assert.equal(activity.sessions[0]!.id, settled);
    assert.equal(activity.sessions[0]!.agent, "test-implementer");
    assert.equal(
      activity.sessions[0]!.state,
      state.isStreaming ? "running" : "waiting-on-user",
    );
    assert.deepEqual(activity.sessions[0]!.owedRepliesFrom, [peer]);
    assert.deepEqual(batches, [[settled], [peer]]);
    assert.equal(activity.stalled, undefined);
  }
});

test("settled sessions and removed task-linked worktrees preserve PR observations without changing store defaults", async () => {
  const t = task(),
    id = initiative([t]);
  const settled = session(t);
  sessionStore.setSettled(settled, true);
  card(settled);
  const wt = tree(t);
  markWorktreeRemovedForTests(wt);
  card(session(), wt); // Card reachable only through the removed worktree.
  assert.deepEqual(worktreeIdsForTask(t), [wt]);
  assert.equal(getWorktree(wt)?.status, "removed");
  assert.ok(!listWorktrees().some((row) => row.id === wt));
  assert.ok(
    !(await listWorktreeRecords("activity")).some((row) => row.id === wt),
  );
  setInitiativeActivitySessionReaderForTests((ids) =>
    listSessions([], () => 0, { includeArchived: true, onlyIds: new Set(ids) }),
  );
  const a = (await read(id, true)).members[0]!.activity!;
  assert.deepEqual(a.sessions, []);
  assert.deepEqual(a.worktrees, [{ id: wt, branch: wt, status: "removed" }]);
  assert.equal(a.pullRequests.length, 2);
  assert.ok(
    a.pullRequests.every(
      (pr) => pr.status === "merged" && pr.headSha === "observed",
    ),
  );
});

test("production reader roots Task-linked worktrees but excludes internal sessions and synthetic main checkouts", async () => {
  const t = task(),
    id = initiative([t]);
  const active = tree(t),
    removed = tree(t);
  markWorktreeRemovedForTests(removed);
  const worker = session();
  linkSessionToWorktree(worker, active);
  const hidden = unique();
  sessionStore.upsert({
    id: hidden,
    harness: "pi",
    agentType: "developer",
    title: "internal",
    scope: "internal",
    messageCount: 1,
  });
  linkSessionToWorktree(hidden, active);
  linkTaskToWorktree(t, "main:activity");
  assert.deepEqual(
    new Set(worktreeIdsForTask(t)),
    new Set([active, removed, "main:activity"]),
  );
  const a = (await read(id, true)).members[0]!.activity!;
  assert.deepEqual(
    a.sessions.map((s) => s.id),
    [worker],
  );
  assert.deepEqual(
    a.worktrees.map((w) => w.id),
    [active, removed],
  );
});

test("activity caps and record drop order preserve bounded paging across 200 members", async () => {
  const ids = Array.from({ length: 200 }, task);
  const id = initiative(ids);
  for (const t of ids) session(t);
  for (let i = 0; i < 7; i++) session(ids[0]);
  const rows = await listSessions([], () => 0, { includeArchived: true });
  setInitiativeActivitySessionReaderForTests(async (ids) => {
    const requested = new Set(ids);
    return rows.filter((row) => requested.has(row.id));
  });
  const first = await read(id, true);
  assert.equal(first.members[0]!.activity!.sessions.length, 5);
  assert.equal(first.members[0]!.activity!.sessionCount, 8);
  const seen: string[] = [];
  let page = first;
  for (;;) {
    seen.push(...page.members.map((m) => m.id));
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > seen.length - page.members.length);
    page = await read(id, true, page.nextOffset);
  }
  assert.deepEqual(new Set(seen), new Set(ids));
  assert.equal(seen.length, ids.length);
  const { readInitiative } = await import("../../initiatives.ts");
  const detail = readInitiative(id)!;
  synthetic.set(id, {
    ...detail,
    nodes: [
      { ...detail.nodes[0]!, title: "界".repeat(10000), projectId: "project" },
    ],
  });
  const oversized = (await read(id, true)).members[0]!;
  assert.equal(oversized.activity, undefined);
  assert.equal(oversized.omitted![0], "activity");
  assert.ok(oversized.clipped!.includes("title"));
});
