/**
 * The Initiative reads walk the `links` graph from a handful of ids, and two
 * of them run on hot paths: the holders read on EVERY Task write, and the
 * session-to-Task read on every session archive, settle and raised outcome.
 * `EXPLAIN QUERY PLAN` runs against the exact statements the store issues
 * (`INITIATIVE_STORE_SQL`), so this cannot drift from the real queries: each
 * step must be an index search driven by the ids already found, never a scan
 * of every edge leaving a Task or of the session history.
 *   pnpm --filter @assistant/server test src/db/initiativeStoreQueryPlan.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { INITIATIVE_STORE_SQL } from "./initiativeStore.ts";
import { getDb } from "./index.ts";

function planLines(sql: string, params: string[]): string[] {
  const rows = getDb()
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

/** No step may read `links`, `tasks` or `session_index` without its key bound. */
function assertIndexed(
  name: keyof typeof INITIATIVE_STORE_SQL,
  params: string[],
): string {
  const plan = planLines(INITIATIVE_STORE_SQL[name], params);
  const text = plan.join("\n");
  for (const line of plan) {
    assert.doesNotMatch(
      line,
      /^SCAN (links|l|b|j|p|t|bt|s|session_index)\b/,
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

test("the holders read seeds with blocked Tasks and climbs through links_to_idx", () => {
  const plan = assertIndexed("holders", ["[]", "[]"]);
  assert.match(
    plan,
    /SEARCH l USING (COVERING )?INDEX links_to_idx \(to_type=\? AND to_id=\? AND relation=\?\)/,
  );
  assert.match(
    plan,
    /SEARCH b USING (COVERING )?INDEX \S+ \(from_type=\? AND from_id=\? AND relation=\?/,
    "the blocked-Task seed is a search by the blocker's id",
  );
});

test("a session change finds its Tasks through links_to_idx", () => {
  const plan = assertIndexed("sessionTasks", ["[]"]);
  assert.match(
    plan,
    /SEARCH l USING (COVERING )?INDEX links_to_idx \(to_type=\? AND to_id=\? AND relation=\?\)/,
  );
});

test("the member walk and its session filter search by key", () => {
  const plan = assertIndexed("members", ["1"]);
  assert.match(plan, /SEARCH t USING INTEGER PRIMARY KEY/);
  for (const name of ["memberSessions", "memberSessionCount"] as const) {
    const sessions = assertIndexed(
      name,
      name === "memberSessions" ? ["1", "50"] : ["1"],
    );
    assert.match(
      sessions,
      /SEARCH s USING INDEX sqlite_autoindex_session_index_1 \(id=\?\)/,
      `${name}: each linked session is one primary-key lookup`,
    );
  }
  assertIndexed("blockersInto", ["[]"]);
});
