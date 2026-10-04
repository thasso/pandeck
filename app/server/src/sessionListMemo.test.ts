/**
 * The session list reads its link-derived maps from memos
 * (`memoizedOnLinks`), its Task progress from one join, and its missing-worktree
 * flag from one read of the active worktrees. None of that may change a single
 * row: after every kind of write, the memoized list must equal the list a fresh
 * connection builds from scratch.
 *   pnpm --filter @assistant/server test src/sessionListMemo.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { AgentType, SessionTaskProgress } from "@assistant/shared";
import { closeDb } from "./db/index.ts";
import { removeLink } from "./db/links.ts";
import { projectStore } from "./db/projectStore.ts";
import { linkSessionToObject } from "./db/sessionObjectStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  insertWorktree,
  linkSessionToWorktree,
  markWorktreeRemovedForTests,
} from "./db/worktreeStore.ts";
import { listSessions, type SessionListOptions } from "./sessions.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  listTasks,
  updateTask,
} from "./tasks.ts";
import { sessionWorktreeMissing } from "./worktrees/sessionCwd.ts";

const liveDir = mkdtempSync(join(tmpdir(), "session-list-memo-"));
afterAll(() => rmSync(liveDir, { recursive: true, force: true }));

let n = 0;
const unique = (label: string) => `list-memo-${label}-${Date.now()}-${n++}`;

function seed(agentType: AgentType = "developer"): string {
  const id = unique("session");
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType,
    title: `Session ${id}`,
    scope: "user",
    messageCount: 2,
  });
  return id;
}

function worktree(path: string): string {
  const id = unique("wt");
  insertWorktree({
    id,
    projectId: "list-memo-project",
    mainRepoRoot: liveDir,
    path,
    branch: id,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    mergeStateJson: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  });
  return id;
}

const VARIANTS: SessionListOptions[] = [{}, { includeArchived: true }];

/**
 * The memoized list, asserted equal to the one a reopened connection builds —
 * which misses every memo — for both the default and the archived variant.
 */
async function listedAfter(label: string) {
  const warm = await Promise.all(
    VARIANTS.map((opts) => listSessions([], () => 0, opts)),
  );
  closeDb();
  const cold = await Promise.all(
    VARIANTS.map((opts) => listSessions([], () => 0, opts)),
  );
  assert.deepEqual(warm, cold, `${label}: memoized list equals a fresh build`);
  return new Map(warm[1]!.map((row) => [row.id, row]));
}

test("the memoized list equals a fresh build across every kind of write", async () => {
  const a = seed();
  const b = seed("assistant");
  await listedAfter("sessions created");

  const live = worktree(liveDir);
  linkSessionToWorktree(a, live);
  projectStore.setSessionProject(b, "list-memo-p1");
  linkSessionToObject(a, "task", "41", "manual");
  let rows = await listedAfter("edges inserted");
  assert.equal(rows.get(a)?.worktreeId, live);
  assert.equal(rows.get(a)?.worktreeMissing, undefined);
  assert.equal(rows.get(b)?.projectId, "list-memo-p1");
  assert.deepEqual(
    rows.get(a)?.objectRefs?.map((ref) => ref.id),
    ["41"],
  );

  const gone = worktree(join(liveDir, "never-created"));
  linkSessionToWorktree(a, gone);
  projectStore.setSessionProject(b, "list-memo-p2");
  linkSessionToObject(a, "knowledge", "notes/x", "initial-context");
  rows = await listedAfter("edges relinked");
  assert.equal(rows.get(a)?.worktreeId, gone);
  assert.equal(rows.get(a)?.worktreeMissing, true);
  assert.equal(rows.get(b)?.projectId, "list-memo-p2");
  assert.equal(rows.get(a)?.objectRefs?.length, 2);

  removeLink({ type: "session", id: a }, "context", { type: "task", id: "41" });
  projectStore.forgetSessionProject(b);
  rows = await listedAfter("edges deleted");
  assert.deepEqual(
    rows.get(a)?.objectRefs?.map((ref) => ref.id),
    ["notes/x"],
  );
  assert.equal(rows.get(b)?.projectId, undefined);

  const c = seed();
  projectStore.setSessionProject(c, "list-memo-p3");
  sessionStore.setArchived(c, true);
  rows = await listedAfter("session archived");
  assert.equal(rows.get(c)?.archived, true);
  assert.equal(rows.get(c)?.projectId, "list-memo-p3");

  // Deleting a project sweeps the session edges INTO it.
  projectStore.remove("list-memo-p3");
  rows = await listedAfter("project removed");
  assert.equal(rows.get(c)?.projectId, undefined);

  // A worktree retired in its own row, not through an edge: the probe is read
  // per build, so the flag still follows.
  linkSessionToWorktree(b, live);
  const d = seed();
  linkSessionToWorktree(d, live);
  markWorktreeRemovedForTests(live);
  rows = await listedAfter("worktree row removed");
  assert.equal(rows.get(d)?.worktreeMissing, true);
  assert.equal(
    rows.get(b)?.worktreeMissing,
    undefined,
    "only a coding session is flagged",
  );
  for (const row of rows.values())
    assert.equal(
      Boolean(row.worktreeMissing),
      sessionWorktreeMissing(row.id),
      `${row.id}: the batched probe agrees with the per-session check`,
    );

  sessionStore.remove(a);
  rows = await listedAfter("session deleted");
  assert.equal(rows.has(a), false);
});

test("Task progress counts exactly what the listed Tasks say", async () => {
  const session = seed();
  const other = seed();
  const ref = (sessionId: string) => ({ sessionId, harness: "pi" as const });
  const source = { createdBy: "user" as const };
  createTask({ title: "todo", source, sessionRefs: [ref(session)] });
  createTask({
    title: "doing",
    status: "doing",
    source,
    sessionRefs: [ref(session), ref(other)],
  });
  const done = createTask({
    title: "done",
    status: "done",
    source,
    sessionRefs: [ref(session)],
  });
  const archived = createTask({
    title: "archived",
    source,
    sessionRefs: [ref(session)],
  });
  archiveTask(archived.id);
  const deleted = createTask({
    title: "deleted",
    source,
    sessionRefs: [ref(other)],
  });
  deleteTask(deleted.id);
  updateTask(done.id, { status: "doing" });

  // The derivation this replaced: counts over `listTasks()`' session refs.
  const expected = new Map<string, SessionTaskProgress>();
  for (const task of listTasks())
    for (const { sessionId } of task.sessionRefs ?? []) {
      const counts = expected.get(sessionId) ?? { todo: 0, doing: 0, done: 0 };
      counts[task.status] += 1;
      expected.set(sessionId, counts);
    }

  const rows = await listedAfter("tasks written");
  assert.deepEqual(rows.get(session)?.taskProgress, {
    todo: 1,
    doing: 2,
    done: 0,
  });
  assert.deepEqual(rows.get(other)?.taskProgress, {
    todo: 0,
    doing: 1,
    done: 0,
  });
  for (const row of rows.values())
    assert.deepEqual(row.taskProgress, expected.get(row.id), row.id);
});

test("a row's refs are not the memo's: writing to one cannot change the next build", async () => {
  const id = seed();
  linkSessionToObject(id, "task", "7", "manual");
  const row = (await listSessions([], () => 0)).find((item) => item.id === id);
  const ref = row?.objectRefs?.[0];
  assert.ok(ref, "the row carries its ref");
  assert.throws(() => {
    ref.id = "wrong";
  }, TypeError);
  row.objectRefs!.push({ ...ref, id: "extra" });

  const next = (await listSessions([], () => 0)).find((item) => item.id === id);
  assert.deepEqual(
    next?.objectRefs?.map((item) => item.id),
    ["7"],
    "the next build still lists the stored ref, and only it",
  );
});

test("sessionStore.list({ ids }) keeps every other filter it is given", () => {
  const plain = seed();
  const archived = seed();
  sessionStore.setArchived(archived, true);
  const deleted = seed();
  sessionStore.remove(deleted);
  const internal = unique("internal");
  sessionStore.upsert({
    id: internal,
    harness: "pi",
    agentType: "assistant",
    title: "Internal",
    scope: "internal",
    messageCount: 2,
  });
  const ids = [plain, archived, deleted, internal, unique("absent")];
  const listed = (opts: Parameters<typeof sessionStore.list>[0]) =>
    sessionStore
      .list({ ...opts, ids })
      .map((row) => row.id)
      .sort();

  assert.deepEqual(listed({}), [plain, archived].sort());
  assert.deepEqual(listed({ excludeArchived: true }), [plain]);
  assert.deepEqual(
    listed({ includeDeleted: true }),
    [plain, archived, deleted].sort(),
  );
  assert.deepEqual(
    listed({ scopes: "all" }),
    [plain, archived, internal].sort(),
  );
  assert.deepEqual(sessionStore.list({ ids: [] }), [], "no ids, no rows");
});

test("a stored Claude SDK row lists the picker's model, not its credential kind", async () => {
  const id = unique("claude");
  // Not resident: the list falls back to the row, whose provider column holds
  // the Claude SDK store's credential kind.
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "developer",
    title: `Session ${id}`,
    scope: "user",
    messageCount: 2,
    provider: "claude",
    model: "claude-opus-5-5[1m]",
    thinkingLevel: "high",
  });
  const row = (await listSessions([], () => 0)).find((item) => item.id === id);
  assert.deepEqual(row?.model, {
    provider: "claude-sdk",
    id: "opus",
    name: "Claude Opus",
  });
  assert.equal(row?.thinkingLevel, "high");
});
