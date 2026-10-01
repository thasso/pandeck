/**
 * The background registry reads that run per broadcast flush and per subscribe
 * must follow the rows that can change, not the table: every Claude Bash call
 * leaves a finished row behind, and a full scan of that history on each flush
 * was most of the server's idle main-thread I/O. `EXPLAIN QUERY PLAN` runs
 * against the EXACT statements the store issues (`BACKGROUND_WORK_REGISTRY_SQL`,
 * `listItemsQuery`), so this cannot drift from the real queries. The window
 * boundaries are tested here too, because this file owns an empty database.
 *   pnpm --filter @assistant/server test src/db/backgroundWorkStoreQueryPlan.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "background-work-query-plan-test-"));
process.env.ASSISTANT_CWD = tmp;

const { BACKGROUND_WORK_REGISTRY_SQL, backgroundWorkStore, listItemsQuery } =
  await import("./backgroundWorkStore.ts");
const { sessionStore } = await import("./sessionStore.ts");
const { getDb, closeDb } = await import("./index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const OWNER = "bg-query-plan-owner";
sessionStore.upsert({
  id: OWNER,
  scope: "user",
  harness: "pi",
  agentType: "developer",
  title: "owner",
  messageCount: 2,
});

beforeEach(() => {
  getDb().exec("DELETE FROM background_work_items");
});

let serial = 0;
/** One row created at `createdAt`, left active or finished at that instant. */
function row(createdAt: number, finished: boolean): string {
  serial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: OWNER,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    sourceRequestId: `plan_${serial}`,
    lifetimeMs: 60 * 60 * 1000,
    settingsGeneration: 1,
    bootEpoch: "boot-plan",
    ownerLimit: 1_000,
    now: createdAt,
  });
  if (finished)
    backgroundWorkStore.terminalize({
      itemId: item.id,
      state: "completed",
      now: createdAt,
    });
  return item.id;
}

function planText(sql: string, params: Array<string | number>): string {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join("\n");
}

test("the flush's revision read is a primary-key search", () => {
  const plan = planText(BACKGROUND_WORK_REGISTRY_SQL.revision, ["bw_x"]);
  assert.match(plan, /SEARCH background_work_items USING INDEX .*\(id=\?\)/);
});

test("the snapshot's active read uses a partial active index, not the registry index", () => {
  const plan = planText(BACKGROUND_WORK_REGISTRY_SQL.activeWindow, [201]);
  assert.match(
    plan,
    /background_work_items_(boot|owner_active)_idx/,
    `active rows must come from a partial active index:\n${plan}`,
  );
  assert.doesNotMatch(plan, /registry_idx/);
});

test("the snapshot's history read walks the registry index and sorts nothing, even across tied timestamps", () => {
  // Many rows in one millisecond is the case a tie order against the index
  // turns into a sort of the whole tied group before LIMIT applies.
  for (let i = 0; i < 100; i += 1) row(1_000, true);
  const plan = planText(BACKGROUND_WORK_REGISTRY_SQL.historyWindow, [201]);
  assert.match(plan, /USING INDEX background_work_items_registry_idx/);
  assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
});

test("an active listItems read uses a partial active index, globally and per owner", () => {
  for (const options of [
    { state: "active" as const, limit: 200 },
    { state: "active" as const, limit: 200, ownerSessionId: OWNER },
  ]) {
    const { sql, args } = listItemsQuery(options);
    const plan = planText(sql, args);
    assert.match(
      plan,
      /background_work_items_(boot|owner_active)_idx/,
      `${JSON.stringify(options)} must read the partial active index:\n${plan}`,
    );
    // The sort that remains is over active rows only, never all of history.
    assert.doesNotMatch(plan, /registry_idx/);
  }
});

test("the window holds exactly its limit of active rows without truncating", () => {
  for (let i = 0; i < 200; i += 1) row(10_000 + i, false);
  const window = backgroundWorkStore.listRegistryWindow(200);
  assert.equal(window.items.length, 200);
  assert.equal(window.truncated, false);
});

test("one row past the limit truncates, whether that row is active or history", () => {
  for (let i = 0; i < 200; i += 1) row(10_000 + i, false);
  const oldest = row(5_000, true);
  const cut = backgroundWorkStore.listRegistryWindow(200);
  assert.equal(cut.items.length, 200);
  assert.equal(cut.truncated, true);
  assert.equal(
    cut.items.some((item) => item.id === oldest),
    false,
    "history is what a full window of active work drops",
  );

  getDb().exec("DELETE FROM background_work_items");
  for (let i = 0; i < 201; i += 1) row(10_000 + i, false);
  const active = backgroundWorkStore.listRegistryWindow(200);
  assert.equal(active.items.length, 200);
  assert.equal(active.truncated, true);
});

test("more active rows than the limit keep the newest active and no history", () => {
  for (let i = 0; i < 250; i += 1) row(10_000 + i, false);
  row(20_000, true);
  const window = backgroundWorkStore.listRegistryWindow(200);
  assert.equal(window.items.length, 200);
  assert.equal(window.truncated, true);
  assert.ok(
    window.items.every((item) => item.state === "pending-launch"),
    "running work is never cut for newer history",
  );
  assert.equal(window.items[0]?.createdAt, 10_249);
  assert.equal(window.items.at(-1)?.createdAt, 10_050);
});

test("tied timestamps across the window cut split deterministically by id", () => {
  const live = row(50_000, false);
  const tied = Array.from({ length: 10 }, () => row(1_000, true)).sort();
  const newer = row(2_000, true);
  const window = backgroundWorkStore.listRegistryWindow(6);
  assert.equal(window.truncated, true);
  // Active first, then history newest first, ties in ascending id: the cut
  // lands inside the tied group at a stable point.
  assert.deepEqual(
    window.items.map((item) => item.id),
    [live, newer, ...tied.slice(0, 4)],
  );
  // The same read twice cuts in the same place.
  assert.deepEqual(
    backgroundWorkStore.listRegistryWindow(6).items.map((item) => item.id),
    window.items.map((item) => item.id),
  );
});
