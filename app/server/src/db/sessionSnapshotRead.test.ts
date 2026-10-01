/**
 * The read-only cross-data-dir reader must answer whatever schema it FINDS.
 * It opens data directories this process did not configure — older backups,
 * another machine, a `measure:session`/`session_audit --data-dir` target — and
 * may never migrate one, so a directory that predates
 * `0047_session_scope.sql` (still classifying rows in `visibility`) has to read
 * as cleanly as one that has applied it.
 *   pnpm --filter @assistant/server test src/db/sessionSnapshotRead.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { readSessionSnapshot } from "./sessionSnapshotRead.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const SCOPE_MIGRATION = "0047_session_scope.sql";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * A data directory migrated up to (and optionally including) the scope
 * migration, built from the SHIPPED migration files rather than a hand-written
 * schema — the point is to read what a real older directory looks like.
 */
function dataDir(opts: { withScopeMigration: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-read-test-"));
  tempDirs.push(dir);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const applied = opts.withScopeMigration
    ? files
    : files.slice(0, files.indexOf(SCOPE_MIGRATION));
  assert.ok(applied.length > 0, "the migration set resolved");
  const db = new DatabaseSync(join(dir, "app.sqlite3"));
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of applied) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    if (sql.includes("-- assistant:migration:foreign_keys_off"))
      db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.exec(sql);
    db.exec("COMMIT");
    if (sql.includes("-- assistant:migration:foreign_keys_off")) {
      db.exec("PRAGMA legacy_alter_table = OFF");
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
  db.close();
  return dir;
}

function seed(
  dir: string,
  column: string,
  rows: Array<[string, string]>,
): void {
  const db = new DatabaseSync(join(dir, "app.sqlite3"));
  const insert = db.prepare(
    `INSERT INTO session_index (id, ${column}, purpose, harness, agent_type, title,
       created_at_ms, updated_at_ms, message_count)
       VALUES (?, ?, 'chat', 'pi', 'developer', 'A session', 10, 20, 3)`,
  );
  for (const [id, scope] of rows) insert.run(id, scope);
  db.close();
}

test("a data directory that predates the scope migration still reads, through its legacy column", () => {
  const dir = dataDir({ withScopeMigration: false });
  seed(dir, "visibility", [
    ["legacy-user", "user"],
    ["legacy-internal", "internal"],
  ]);

  const user = readSessionSnapshot(dir, "legacy-user");
  assert.ok(user, "the pre-migration row is readable");
  assert.equal(user.session.scope, "user");
  assert.equal(user.session.title, "A session");
  assert.equal(user.session.messageCount, 3);
  assert.equal(user.session.deleted, false);

  // The classification carries over as-is, so the callers' refusal for a
  // non-user session works on an old directory exactly as on a new one.
  assert.equal(
    readSessionSnapshot(dir, "legacy-internal")?.session.scope,
    "internal",
  );
});

test("a migrated data directory reads its scope column, including subagent", () => {
  const dir = dataDir({ withScopeMigration: true });
  seed(dir, "scope", [
    ["scoped-user", "user"],
    ["scoped-subagent", "subagent"],
  ]);
  const db = new DatabaseSync(join(dir, "app.sqlite3"));
  db.prepare(
    "INSERT INTO session_skills (session_id, names_json, created_at_ms) VALUES (?, ?, ?)",
  ).run("scoped-user", '["alpha"]', 30);
  db.close();

  assert.equal(readSessionSnapshot(dir, "scoped-user")?.session.scope, "user");
  assert.equal(
    readSessionSnapshot(dir, "scoped-user")?.sessionSkillsJson,
    '["alpha"]',
  );
  assert.equal(
    readSessionSnapshot(dir, "scoped-subagent")?.session.scope,
    "subagent",
  );
});

test("an unclassifiable stored value fails closed rather than reading as the user's", () => {
  // A real pre-0047 directory, with only its session table swapped for one
  // that carries no CHECK: our own constraints refuse such a value, but a
  // foreign data directory is not one this process controls, so the READ is
  // what decides — and it decides against the user's scope.
  const dir = dataDir({ withScopeMigration: false });
  const db = new DatabaseSync(join(dir, "app.sqlite3"));
  db.exec("DROP TABLE session_index");
  db.exec(
    `CREATE TABLE session_index (
       id TEXT PRIMARY KEY, visibility TEXT, purpose TEXT, harness TEXT,
       agent_type TEXT, title TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
       message_count INTEGER, provider TEXT, provider_session_id TEXT, model TEXT,
       thinking_level TEXT, archived_at_ms INTEGER, deleted_at_ms INTEGER
     )`,
  );
  db.close();
  seed(dir, "visibility", [["odd", "something-new"]]);

  assert.equal(readSessionSnapshot(dir, "odd")?.session.scope, "internal");
});

test("a missing database, a database with no sessions table, and an unknown id are all not-found", () => {
  const empty = mkdtempSync(join(tmpdir(), "snapshot-read-empty-"));
  tempDirs.push(empty);
  assert.equal(readSessionSnapshot(empty, "whatever"), undefined);

  // A file that is a database but not one of ours: no session row to report.
  const unrelated = mkdtempSync(join(tmpdir(), "snapshot-read-unrelated-"));
  tempDirs.push(unrelated);
  const db = new DatabaseSync(join(unrelated, "app.sqlite3"));
  db.exec("CREATE TABLE something_else (id TEXT PRIMARY KEY)");
  db.close();
  assert.equal(readSessionSnapshot(unrelated, "whatever"), undefined);

  const dir = dataDir({ withScopeMigration: true });
  assert.equal(readSessionSnapshot(dir, "never-existed"), undefined);
});
