/**
 * The Initiative reads walk the `links` graph from a handful of ids, and one
 * of them — the holders read — runs on EVERY Task write. `EXPLAIN QUERY PLAN`
 * runs against the exact statements the store issues
 * (`INITIATIVE_STORE_SQL`), so this cannot drift from the real queries: each
 * step must be an index search driven by the ids already found, never a scan
 * of every edge leaving a Task.
 *   pnpm --filter @assistant/server test src/db/initiativeStoreQueryPlan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { INITIATIVE_STORE_SQL } from "./initiativeStore.ts";
import { getDb } from "./index.ts";

function planLines(sql: string, param: string): string[] {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(param) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

/** No step may read `links` or `tasks` without its leading key bound. */
function assertIndexed(name: keyof typeof INITIATIVE_STORE_SQL, param: string) {
  const plan = planLines(INITIATIVE_STORE_SQL[name], param);
  const text = plan.join("\n");
  for (const line of plan) {
    assert.doesNotMatch(
      line,
      /^SCAN (links|l|b|j|p|t|bt)\b/,
      `${name} scans a table:\n${text}`,
    );
    assert.doesNotMatch(
      line,
      /USING (COVERING )?INDEX \S+ \(from_type=\?\)$/,
      `${name} searches links by from_type alone, which is every Task edge:\n${text}`,
    );
  }
  return text;
}

test("the holders read climbs the ancestor chain through links_to_idx", () => {
  const plan = assertIndexed("holders", "[]");
  assert.match(
    plan,
    /SEARCH l USING (COVERING )?INDEX links_to_idx \(to_type=\? AND to_id=\? AND relation=\?\)/,
  );
});

test("the member walk searches each step by its parent's id", () => {
  const plan = assertIndexed("members", "1");
  assert.match(plan, /SEARCH t USING INTEGER PRIMARY KEY/);
  assertIndexed("memberSessions", "1");
  assertIndexed("blockersInto", "[]");
});
