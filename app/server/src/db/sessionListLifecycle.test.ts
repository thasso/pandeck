/**
 * V15: the `sessions` topic across the database lifecycle
 * (`db/sessionListChanges.ts`; `docs/session-list.md`, "Audit"). A global
 * touch never opens a closed database, a close forgets the audit baseline,
 * and an open database stamps the live superset and owes its publication.
 *   pnpm --filter @assistant/server test src/db/sessionListLifecycle.test.ts
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { hub } from "../hub.ts";
import { resetSessionListAuditBaselineForTests } from "../sessionsTopic.ts";
import {
  isStateTopicInvariant,
  takeStateTopicInvariantsForTests,
} from "../stateTopicKernel.ts";
import { closeDb, dbIsOpen, getDb } from "./index.ts";
import {
  sessionListRevisions,
  touchAllSessionRows,
  touchSessionRows,
} from "./sessionListChanges.ts";
import { sessionStore } from "./sessionStore.ts";

let serial = 0;
function seed(): string {
  const id = `lifecycle-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount: 2,
  });
  return id;
}

const rawTitle = (id: string, title: string) =>
  getDb()
    .prepare("UPDATE session_index SET title = ? WHERE id = ?")
    .run(title, id);
const revision = (id: string) => sessionListRevisions([id]).get(id) ?? 0;
/** Flushes; an invariant is still recorded in the ledger the tests read. */
const flush = () =>
  hub.flushPendingBroadcastsForTests().catch((err: unknown) => {
    if (!isStateTopicInvariant(err)) throw err;
  });

afterEach(async () => {
  getDb();
  resetSessionListAuditBaselineForTests();
  await flush();
  takeStateTopicInvariantsForTests();
});

test("closing the database leaves it closed, and a global touch neither opens it nor throws", async () => {
  const id = seed();
  await flush();
  // Any statement on any handle; the close's own WAL checkpoint is not
  // counted (it runs before the spies) and not asserted away.
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  closeDb();
  prepare.mockClear();
  exec.mockClear();
  assert.equal(dbIsOpen(), false);
  touchAllSessionRows("model catalog");
  assert.equal(dbIsOpen(), false, "the touch did not reopen it");
  assert.equal(prepare.mock.calls.length, 0, "no projection or revision SQL");
  assert.equal(exec.mock.calls.length, 0, "no migration or pragma");
  vi.restoreAllMocks();
  // Reopening runs the migrations again: the revision table is there.
  getDb();
  assert.equal(dbIsOpen(), true);
  assert.ok(
    getDb()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_list_revisions'",
      )
      .get(),
  );
  // The close forgot the baseline: a change made behind the stores before
  // the next capture is not judged against rows from the closed database.
  rawTitle(id, "changed while the baseline was gone");
  touchSessionRows([seed()]);
  await flush();
  assert.deepEqual(takeStateTopicInvariantsForTests(), []);
  // The capture that flush made is live again.
  rawTitle(id, "changed after the recapture");
  touchSessionRows([seed()]);
  await flush();
  const violations = takeStateTopicInvariantsForTests();
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, new RegExp(`${id} title`));
});

test("with the database open a global touch stamps the live superset, not archived rows, and owes a check", async () => {
  const [live, archived] = [seed(), seed()];
  sessionStore.setArchived(archived, true);
  await flush();
  const before = { live: revision(live), archived: revision(archived) };
  touchAllSessionRows("reminder-limit");
  assert.ok(revision(live) > before.live, "the live row was stamped");
  assert.equal(revision(archived), before.archived, "archived is not stamped");
  // Owed: an archived row's change is excused until the publication checks.
  rawTitle(archived, "archived change while owed");
  await flush();
  assert.deepEqual(takeStateTopicInvariantsForTests(), []);
  // After it, the next unreported archived change is caught.
  rawTitle(archived, "archived change after the publication");
  touchSessionRows([seed()]);
  await flush();
  const violations = takeStateTopicInvariantsForTests();
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, new RegExp(`${archived} title`));
});
