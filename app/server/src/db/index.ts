import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import { PACKAGED_MIGRATIONS_DIR } from "../runtimeAssets.ts";
import {
  assertMayApplyMigrations,
  recordMigrationOwner,
} from "./migrationOwner.ts";

const DB_PATH = join(DATA_DIR, "app.sqlite3");
const MIGRATIONS_DIR = PACKAGED_MIGRATIONS_DIR;

let db: DatabaseSync | undefined;
let migrated = false;

export function getDb(): DatabaseSync {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    // Tests only (`src/test/setup.ts`): each test file builds a throwaway
    // database, and waiting on fsync for every commit was half the suite.
    if (process.env.ASSISTANT_TEST_DB_NO_FSYNC === "1") {
      db.exec("PRAGMA synchronous = OFF");
    }
  }
  if (!migrated) {
    runMigrations(db);
    migrated = true;
  }
  return db;
}

/**
 * Checkpoint the WAL and close the handle. Safe to call synchronously from a
 * `process.on("exit")` hook: node:sqlite writes are synchronous, so all metadata
 * is already durable; this just truncates the WAL and releases the file cleanly
 * on Ctrl-C, SIGTERM, and the dev-reload exit.
 */
export function closeDb(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // best-effort; a failed checkpoint still leaves a recoverable WAL.
  }
  try {
    db.close();
  } catch {
    // ignore — we are exiting anyway.
  }
  db = undefined;
  migrated = false;
}

/**
 * Run `fn` inside a single IMMEDIATE transaction, committing on success and
 * rolling back on any throw. node:sqlite writes are synchronous, so this makes a
 * multi-statement mutation (e.g. supersede-then-create) atomic. Not re-entrant —
 * never nest for the same connection.
 */
export function withDbTransaction<T>(fn: () => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // ignore rollback failure; surface the original error.
    }
    throw err;
  }
}

/**
 * {@link withDbTransaction}, or plain `fn` when this connection already has a
 * transaction open — for a read-modify-write that must be atomic on its own and
 * may also run inside a caller's transaction.
 */
export function inDbTransaction<T>(fn: () => T): T {
  return getDb().isTransaction ? fn() : withDbTransaction(fn);
}

/** sha256 of a migration's content — the checksum recorded in the database. */
function hashMigration(name: string): string {
  return createHash("sha256")
    .update(readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
    .digest("hex");
}

function runMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const files = existsSync(MIGRATIONS_DIR)
    ? readdirSync(MIGRATIONS_DIR)
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort()
    : [];

  const getApplied = database.prepare(
    "SELECT name, checksum FROM schema_migrations WHERE version = ?",
  );
  const insertApplied = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)",
  );

  // Decide what would be applied BEFORE applying any of it, so the ownership
  // guard sees the whole set and a refusal leaves the database untouched.
  const pending: string[] = [];
  for (const name of files) {
    const version = Number(name.split("_", 1)[0]);
    if (!Number.isInteger(version)) continue;
    const applied = getApplied.get(version) as
      { name?: string; checksum?: string } | undefined;
    if (!applied) {
      pending.push(name);
      continue;
    }
    if (applied.checksum === hashMigration(name)) continue;
    // Same version, different content. Distinguish the two ways that happens:
    // an edit to a shipped file, or — far more confusing to read in a crash
    // loop — two branches that both claimed this version number, one of them
    // renumbered by a rebase after the other had already been applied here.
    throw new Error(
      applied.name && applied.name !== name
        ? `SQLite migration version ${version} was applied as ${applied.name}, but this build ships it as ${name}. A migration was RENUMBERED after it had been applied — see docs/migrations.md; renumber the never-applied migration instead and repair this database's schema_migrations row.`
        : `SQLite migration ${name} checksum changed after it was applied.`,
    );
  }
  assertMayApplyMigrations(pending);

  for (const name of pending) {
    const version = Number(name.split("_", 1)[0]);
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    let began = false;
    try {
      if (foreignKeysOff) database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN IMMEDIATE");
      began = true;
      database.exec(sql);
      if (foreignKeysOff) {
        const violations = database
          .prepare("PRAGMA foreign_key_check")
          .all() as unknown[];
        if (violations.length > 0)
          throw new Error(
            `SQLite migration ${name} left ${violations.length} foreign-key violation(s).`,
          );
      }
      insertApplied.run(version, name, checksum, Date.now());
      database.exec("COMMIT");
      began = false;
    } catch (err) {
      if (began) database.exec("ROLLBACK");
      throw err;
    } finally {
      if (foreignKeysOff) {
        database.exec("PRAGMA legacy_alter_table = OFF");
        database.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

  // Claim ownership only once the whole set landed, so a half-applied run never
  // hands a working copy a data directory it could not finish migrating.
  if (pending.length > 0) recordMigrationOwner();
}
