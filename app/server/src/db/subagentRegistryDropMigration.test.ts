/**
 * Migration regression for dropping the PA subagent registry (0097): on an
 * empty registry the real runner drops `subagent_runs`, then
 * `subagent_threads`, and only the `subagent_revision` sequence row. A row in
 * EITHER table makes the migration refuse with an actionable message, and the
 * runner's rollback leaves the database exactly as it was.
 *   pnpm --filter @assistant/server test src/db/subagentRegistryDropMigration.test.ts
 *
 * Every case seeds a database file through 0096 with a raw connection, records
 * those versions in `schema_migrations` under their shipped checksums, then
 * opens it with `getDb()` so the runner applies 0097 in its own transaction.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "subagent-registry-drop-"));
process.env.DATA_DIR = dataDir;

const { closeDb, getDb } = await import("./index.ts");
const DB_PATH = join(dataDir, "app.sqlite3");
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const DROP_MIGRATION = "0097_drop_subagent_registry.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

/**
 * A database file migrated up to, but not including, the drop, with the
 * bookkeeping the runner would have written, plus two sessions a thread can
 * reference and sequence rows on both sides of the cleanup.
 */
function seedBeforeDrop(): void {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    rmSync(`${DB_PATH}${suffix}`, { force: true });
  const files = migrationFiles();
  const index = files.indexOf(DROP_MIGRATION);
  assert.ok(index > 0, "the registry drop migration ships");

  const raw = new DatabaseSync(DB_PATH);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `);
  const record = raw.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, 1)",
  );
  for (const name of files.slice(0, index)) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    if (foreignKeysOff) raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(sql);
    record.run(
      Number(name.split("_", 1)[0]),
      name,
      createHash("sha256").update(sql).digest("hex"),
    );
    raw.exec("COMMIT");
    if (foreignKeysOff) {
      raw.exec("PRAGMA legacy_alter_table = OFF");
      raw.exec("PRAGMA foreign_keys = ON");
    }
  }
  raw.exec(`
    INSERT INTO session_index (id, scope, purpose, harness, agent_type, title, created_at_ms, updated_at_ms)
    VALUES ('parent', 'user', 'chat', 'pi', 'developer', 'Parent', 1, 1),
           ('child', 'user', 'chat', 'pi', 'developer', 'Child', 1, 1);
    INSERT INTO sequences (entity_type, next_id) VALUES ('subagent_revision', 9)
      ON CONFLICT(entity_type) DO UPDATE SET next_id = 9;
    INSERT INTO sequences (entity_type, next_id) VALUES ('task_revision', 41)
      ON CONFLICT(entity_type) DO UPDATE SET next_id = 41;
  `);
  raw.close();
}

/** Run `fn` against the seeded file on a raw connection the runner never sees. */
function withRaw<T>(fn: (raw: DatabaseSync) => T): T {
  const raw = new DatabaseSync(DB_PATH);
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

/** A tombstoned thread: the smallest row the 0048 CHECKs accept. */
function insertThread(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO subagent_threads (id, parent_session_id, session_id, is_member, deleted_at_ms)
    VALUES ('thread-1', 'parent', 'child', 0, 5)
  `);
}

/** A tombstoned terminal run; `thread-1` need not exist when foreign keys are off. */
function insertRun(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO subagent_runs (
      id, thread_id, thread_seq, status, terminal_at_ms, is_member, deleted_at_ms
    ) VALUES ('run-1', 'thread-1', 1, 'failed', 4, 0, 5)
  `);
}

/** Every main-schema object and every table's row count: the whole observable state. */
function snapshot(raw: DatabaseSync): {
  schema: unknown[];
  counts: Record<string, number>;
  sequences: unknown[];
} {
  const schema = raw
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .map((row) => ({ ...row }));
  const counts: Record<string, number> = {};
  for (const { name } of raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as Array<{ name: string }>)
    counts[name] = (
      raw.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }
    ).n;
  const sequences = raw
    .prepare("SELECT entity_type, next_id FROM sequences ORDER BY entity_type")
    .all()
    .map((row) => ({ ...row }));
  return { schema, counts, sequences };
}

function assertRefuses(table: "subagent_runs" | "subagent_threads"): void {
  const before = withRaw(snapshot);
  assert.throws(
    () => getDb(),
    (err: Error) => {
      assert.match(err.message, /0097_drop_subagent_registry refused/);
      assert.match(err.message, new RegExp(`${table} still holds rows`));
      assert.match(err.message, /will not delete its records/);
      assert.match(err.message, /Nothing was changed/);
      return true;
    },
  );
  closeDb();
  assert.deepEqual(
    withRaw(snapshot),
    before,
    "the refused migration left schema, rows and sequences untouched",
  );
  assert.equal(
    withRaw(
      (raw) =>
        raw
          .prepare("SELECT 1 FROM schema_migrations WHERE version = 97")
          .get() ?? null,
    ),
    null,
    "a refused migration is not recorded as applied",
  );
}

afterEach(() => closeDb());

test("an empty registry drops both tables and only the subagent revision sequence", () => {
  seedBeforeDrop();
  const before = withRaw(snapshot);
  assert.ok(before.counts.subagent_runs === 0);
  assert.ok(before.counts.subagent_threads === 0);

  const db = getDb();
  const after = snapshot(db);

  const registryObjects = after.schema.filter((row) =>
    /subagent_(runs|threads)/.test(String((row as { name: string }).name)),
  );
  assert.deepEqual(registryObjects, [], "tables and their indexes are gone");
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'subagent_registry_drop_guard%'",
        )
        .get() as { n: number }
    ).n,
    0,
    "the guard leaves no temp objects behind",
  );
  assert.deepEqual(
    after.sequences,
    before.sequences.filter(
      (row) =>
        (row as { entity_type: string }).entity_type !== "subagent_revision",
    ),
    "every other sequence row keeps its value",
  );
  const untouchedCounts = (counts: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(counts).filter(
        ([name]) =>
          !/^(subagent_runs|subagent_threads|schema_migrations|sequences)$/.test(
            name,
          ),
      ),
    );
  assert.deepEqual(
    untouchedCounts(after.counts),
    untouchedCounts(before.counts),
    "no other table gained or lost a row",
  );
  assert.equal(
    (
      db.prepare("SELECT count(*) AS n FROM session_index").get() as {
        n: number;
      }
    ).n,
    2,
  );
  assert.ok(
    db.prepare("SELECT 1 FROM schema_migrations WHERE version = 97").get(),
    "the drop is recorded as applied",
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a thread row refuses the drop and leaves the database untouched", () => {
  seedBeforeDrop();
  withRaw(insertThread);
  assertRefuses("subagent_threads");
});

test("a run row refuses the drop even without a thread", () => {
  seedBeforeDrop();
  withRaw((raw) => {
    raw.exec("PRAGMA foreign_keys = OFF");
    insertRun(raw);
  });
  assertRefuses("subagent_runs");
});

test("a refused drop applies once the operator has cleared the registry", () => {
  seedBeforeDrop();
  withRaw((raw) => {
    insertThread(raw);
    insertRun(raw);
  });
  assertRefuses("subagent_runs");

  withRaw((raw) =>
    raw.exec("DELETE FROM subagent_runs; DELETE FROM subagent_threads;"),
  );
  const db = getDb();
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name IN ('subagent_runs', 'subagent_threads')",
      )
      .get(),
    undefined,
  );
  assert.equal(
    db
      .prepare(
        "SELECT 1 FROM sequences WHERE entity_type = 'subagent_revision'",
      )
      .get(),
    undefined,
  );
});
