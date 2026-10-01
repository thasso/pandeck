/**
 * Task 91/101 review follow-up: the activeNow `recurring` keyset scan
 * (`memory/memoryApi.ts`'s `scanRecurringActive`) is only actually O(chunk
 * size) per chunk if SQLite can use an index for BOTH the `temporal_mode`
 * filter and the `updated_at_ms DESC, id` order — otherwise it still scans/
 * sorts the remaining recurring rows on every chunk. This verifies via
 * `EXPLAIN QUERY PLAN`, against the EXACT SQL `memoryStore.list` issues (via
 * `debugListQueryForTests`, so there is no risk of the test drifting from the
 * real query), that migration 0016's `memory_cards_recurring_scan_idx` is used
 * and that no temp B-tree sort is needed.
 *   pnpm --filter @assistant/server test src/db/memoryStoreQueryPlan.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "memory-store-query-plan-test-"));
process.env.ASSISTANT_CWD = tmp;

const { memoryStore, debugListQueryForTests } =
  await import("./memoryStore.ts");
const { getDb, closeDb } = await import("./index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function planText(sql: string, params: Array<string | number>): string {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join("\n");
}

test("the recurring keyset scan query uses memory_cards_recurring_scan_idx and needs no temp B-tree sort", () => {
  memoryStore.insert({
    id: "mem_plan_1",
    text: "recurring plan check",
    kind: "working",
    scope: {},
    temporal: {
      mode: "recurring",
      recurrence: { kind: "weekly", weekdays: [2] },
    },
    observedAtMs: 0,
    createdAt: 0,
    updatedAt: 0,
    sourceKind: "manual",
  });

  // The EXACT shape `scanRecurringActive` queries: states + temporalModes +
  // an afterCursor (the second and later chunks of the scan).
  const { sql, params } = debugListQueryForTests({
    states: ["active"],
    temporalModes: ["recurring"],
    afterCursor: { updatedAtMs: 1_700_000_000_000, id: "mem_0" },
    limit: 200,
    offset: 0,
  });

  const plan = planText(sql, params);
  assert.ok(
    plan.includes("memory_cards_recurring_scan_idx"),
    `expected the recurring scan index in the plan, got:\n${plan}`,
  );
  assert.ok(
    !/TEMP B-TREE/i.test(plan),
    `expected no temp B-tree sort (index should already provide the order), got:\n${plan}`,
  );
});

test("the first (no-cursor) chunk of the scan also uses the index and needs no sort", () => {
  const { sql, params } = debugListQueryForTests({
    states: ["active"],
    temporalModes: ["recurring"],
    limit: 200,
    offset: 0,
  });
  const plan = planText(sql, params);
  assert.ok(
    plan.includes("memory_cards_recurring_scan_idx"),
    `expected the recurring scan index in the plan, got:\n${plan}`,
  );
  assert.ok(
    !/TEMP B-TREE/i.test(plan),
    `expected no temp B-tree sort, got:\n${plan}`,
  );
});
