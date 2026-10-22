/**
 * The sessions an Initiative summary lists (docs/initiatives.md, Sessions
 * working on its Tasks): user sessions STARTED from a member Task (`task-start`,
 * `linkTaskStart`) that are neither tombstoned, archived nor settled, archived
 * member Tasks included. The page (newest 50 by session creation, ties by id)
 * and the full count come from SQL over ONE predicate, so a passive reference
 * or a link with no origin inflates neither, and a session on several member
 * Tasks counts once. Running a turn is not required: that is the map's marker.
 *   pnpm --filter @assistant/server test src/initiativeSessions.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { INITIATIVE_SUMMARY_SESSION_LIMIT } from "@assistant/shared";
import {
  createInitiative,
  initiativeStateTopic,
  initiativeSummaryFor,
} from "./initiatives.ts";
import { archiveTask, createTask, linkSessionToTask } from "./tasks.ts";
import { getDb } from "./db/index.ts";
import { INITIATIVE_STORE_SQL, initiativeStore } from "./db/initiativeStore.ts";
import { sessionStore } from "./db/sessionStore.ts";

function task(title: string, parentId?: string): string {
  return createTask({
    title,
    source: { createdBy: "user" },
    ...(parentId ? { parentId } : {}),
  }).id;
}

function initiative(title: string, taskIds: string[]): string {
  return String(createInitiative({ title, taskIds }).initiative.id);
}

let serial = 0;
/** A user session row created at `createdAt`; linked by the caller. */
function sessionRow(
  createdAt: number,
  options: { scope?: "user" | "internal"; id?: string } = {},
): string {
  serial += 1;
  const id = options.id ?? `sess-owned-${serial}`;
  sessionStore.upsert({
    id,
    scope: options.scope ?? "user",
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount: 1,
    createdAt,
  });
  return id;
}

function started(taskId: string, sessionId: string): void {
  linkSessionToTask(taskId, { sessionId, origin: "task-start" });
}

function referenced(taskId: string, sessionId: string): void {
  linkSessionToTask(taskId, { sessionId, origin: "reference" });
}

function sessions(id: string): { ids: string[]; count: number } {
  const summary = initiativeSummaryFor(id)!;
  return { ids: summary.sessionIds, count: summary.sessionCount };
}

function revisionOf(id: string): number {
  return initiativeStateTopic.revisions([id]).get(id)!.revision;
}

test("passive and origin-less links inflate neither the page nor the count", () => {
  const epic = task("Ownership epic");
  const sub = task("Ownership sub", epic);
  const id = initiative("Ownership", [epic]);

  const owned = sessionRow(10);
  started(sub, owned);
  const passive = sessionRow(20);
  referenced(sub, passive);
  const bare = sessionRow(30);
  linkSessionToTask(epic, { sessionId: bare });

  assert.deepEqual(sessions(id), { ids: [owned], count: 1 });
});

test("a started session counts once, whatever else links it", () => {
  const epic = task("Mixed epic");
  const a = task("Mixed A", epic);
  const b = task("Mixed B", epic);
  const outsider = task("Not a member");
  const id = initiative("Mixed", [epic]);

  // Started on one member and referenced on another member.
  const startedAndReferenced = sessionRow(10);
  started(a, startedAndReferenced);
  referenced(b, startedAndReferenced);
  // Started on two member Tasks.
  const startedTwice = sessionRow(20);
  started(a, startedTwice);
  started(b, startedTwice);
  // Started outside the Initiative, only referenced inside it.
  const startedElsewhere = sessionRow(30);
  started(outsider, startedElsewhere);
  referenced(a, startedElsewhere);

  assert.deepEqual(sessions(id), {
    ids: [startedTwice, startedAndReferenced],
    count: 2,
  });
});

test("one session may be listed by several Initiatives", () => {
  const shared = task("Shared Task");
  const first = initiative("First", [shared]);
  const second = initiative("Second", [shared]);
  const session = sessionRow(10);
  started(shared, session);
  assert.deepEqual(sessions(first), { ids: [session], count: 1 });
  assert.deepEqual(sessions(second), { ids: [session], count: 1 });
});

test("archived member Tasks count; scope, tombstones, archive and settle do not", () => {
  const epic = task("Eligibility epic");
  const shelvedTask = task("Shelved member", epic);
  const id = initiative("Eligibility", [epic]);
  archiveTask(shelvedTask);

  const onShelved = sessionRow(10);
  started(shelvedTask, onShelved);
  const internal = sessionRow(20, { scope: "internal" });
  started(epic, internal);
  const tombstoned = sessionRow(30);
  started(epic, tombstoned);
  sessionStore.markDeleted(tombstoned);
  const archivedSession = sessionRow(40);
  started(epic, archivedSession);
  sessionStore.setArchived(archivedSession, true);
  const settled = sessionRow(50);
  started(epic, settled);
  sessionStore.setSettled(settled, true);
  const noRow = "sess-owned-without-row";
  started(epic, noRow);

  assert.deepEqual(sessions(id), { ids: [onShelved], count: 1 });

  // A settled session counts again once a new outcome raises it, and that
  // write reaches the Initiative through the liveness seam.
  const before = revisionOf(id);
  sessionStore.recordSessionOutcome(settled, "completed");
  assert.ok(revisionOf(id) > before);
  assert.deepEqual(sessions(id), { ids: [settled, onShelved], count: 2 });

  // Settling it again, through what it shows, puts it down again.
  const raised = sessionStore.get(settled)!.outcomeAttention!.revision;
  sessionStore.setSettled(settled, true, Date.now(), raised);
  assert.deepEqual(sessions(id), { ids: [onShelved], count: 1 });
});

test("a reference upgraded to task-start joins, through the Task's own notify", () => {
  const member = task("Upgrade member");
  const id = initiative("Upgrade", [member]);
  const session = sessionRow(10);
  referenced(member, session);
  assert.deepEqual(sessions(id), { ids: [], count: 0 });

  const before = revisionOf(id);
  started(member, session);
  assert.ok(revisionOf(id) > before, "the link write moved the summary");
  assert.deepEqual(sessions(id), { ids: [session], count: 1 });

  // `task-start` wins over a later reference: the session stays owned.
  referenced(member, session);
  assert.deepEqual(sessions(id), { ids: [session], count: 1 });
});

test("over 50 eligible: the SQL page is the newest 50 in order, the count is all", () => {
  const epic = task("Crowded epic");
  const a = task("Crowded A", epic);
  const b = task("Crowded B", epic);
  const id = initiative("Crowded", [epic]);

  // The oracle: every eligible session with its creation time, built beside
  // the fixture, never read back from the store.
  const eligible: Array<{ id: string; createdAt: number }> = [];
  for (
    let index = 0;
    index < INITIATIVE_SUMMARY_SESSION_LIMIT + 12;
    index += 1
  ) {
    // Pairs share a creation time, so the id tie-break decides.
    const createdAt = 5_000 + Math.floor(index / 2);
    const session = sessionRow(createdAt, {
      id: `sess-crowd-${String(index).padStart(3, "0")}`,
    });
    started(index % 3 === 0 ? a : b, session);
    // Some are started on BOTH members; they must not count twice.
    if (index % 5 === 0) started(index % 3 === 0 ? b : a, session);
    eligible.push({ id: session, createdAt });
  }
  // Noise that must not reach either value.
  for (let index = 0; index < 20; index += 1) {
    const passive = sessionRow(9_000 + index);
    referenced(a, passive);
  }
  const expected = [...eligible]
    .sort((x, y) => y.createdAt - x.createdAt || (x.id < y.id ? -1 : 1))
    .map((entry) => entry.id);

  const { ids, count } = sessions(id);
  assert.equal(count, eligible.length);
  assert.equal(ids.length, INITIATIVE_SUMMARY_SESSION_LIMIT);
  assert.equal(new Set(ids).size, ids.length, "no session twice");
  assert.deepEqual(ids, expected.slice(0, INITIATIVE_SUMMARY_SESSION_LIMIT));

  // The cap is the statement's own LIMIT: the rows SQLite hands back are the
  // page, never the whole set cut down in JavaScript.
  const rows = getDb()
    .prepare(INITIATIVE_STORE_SQL.memberSessions)
    .all(id, INITIATIVE_SUMMARY_SESSION_LIMIT);
  assert.equal(rows.length, INITIATIVE_SUMMARY_SESSION_LIMIT);
  const counted = getDb()
    .prepare(INITIATIVE_STORE_SQL.memberSessionCount)
    .get(id) as { n: number };
  assert.equal(counted.n, eligible.length);
  assert.deepEqual(
    initiativeStore.memberSessions(Number(id), 3).ids,
    expected.slice(0, 3),
  );
});

test("a malformed link metadata reads as no origin rather than failing the summary", () => {
  const member = task("Malformed member");
  const id = initiative("Malformed", [member]);
  const owned = sessionRow(10);
  started(member, owned);
  const broken = sessionRow(20);
  started(member, broken);
  getDb()
    .prepare(
      "UPDATE links SET metadata_json = '{not json' WHERE relation = 'context' AND to_id = ?",
    )
    .run(broken);
  assert.deepEqual(sessions(id), { ids: [owned], count: 1 });
});
