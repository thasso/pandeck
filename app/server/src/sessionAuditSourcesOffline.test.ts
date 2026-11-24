/**
 * The offline audit resolver stays read-only against its own process's
 * `DATA_DIR` too: `DATA_DIR=… pnpm measure:session` names the same directory
 * the resolver is handed, and must neither migrate a database from an earlier
 * build nor trip the migration-owner refusal of a deployed one. This file
 * never opens the writable store itself, so a resolver that did would show.
 *
 *   pnpm --filter @assistant/server test src/sessionAuditSourcesOffline.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { databaseBefore } from "./test/schemaBefore.ts";

const ID = "audit-pi";
const NATIVE = join(DATA_DIR, "sessions", ID, "native.jsonl");

/**
 * The resolver from a fresh module graph: a store one case opened (the defect
 * under test) must not hide what the next case would do.
 */
async function resolver() {
  vi.resetModules();
  return (await import("./sessionAuditSources.ts"))
    .resolveAuditSourceFromDataDir;
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const raw = databaseBefore(DATA_DIR, "0102_session_engine_binding.sql");
  raw
    .prepare(
      `INSERT INTO session_index (
         id, scope, harness, agent_type, title, created_at_ms, updated_at_ms,
         message_count, credential_profile_id
       ) VALUES (?, 'user', 'pi', 'assistant', 'Audit', 1, 1, 2, 'default')`,
    )
    .run(ID);
  raw.close();
  mkdirSync(join(DATA_DIR, "sessions", ID), { recursive: true });
  writeFileSync(NATIVE, "");
});

function appliedVersions(): number[] {
  const raw = new DatabaseSync(join(DATA_DIR, "app.sqlite3"), {
    readOnly: true,
  });
  try {
    return (
      raw
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as { version: number }[]
    ).map((row) => row.version);
  } finally {
    raw.close();
  }
}

test("a pi audit of a packaged-owned data dir still reads", async () => {
  writeFileSync(
    join(DATA_DIR, ".migration-owner.json"),
    JSON.stringify({
      packaged: true,
      appRoot: "/nix/store/fixture-pandeck",
      updatedAtMs: 1,
    }),
  );
  const source = (await resolver())(ID, DATA_DIR);
  assert.deepEqual(source.callTranscript, {
    source: "pi-native",
    path: NATIVE,
  });
  assert.equal(source.warnings, undefined);
});

test("a pi audit of this process's own data dir migrates nothing", async () => {
  const before = appliedVersions();
  const source = (await resolver())(ID, DATA_DIR);
  assert.deepEqual(source.callTranscript, {
    source: "pi-native",
    path: NATIVE,
  });
  assert.equal(source.meta.harness, "pi");
  assert.deepEqual(appliedVersions(), before);
  assert.ok(!before.includes(102));
});
