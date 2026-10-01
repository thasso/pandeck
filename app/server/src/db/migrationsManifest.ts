import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PACKAGED_MIGRATIONS_DIR,
  PACKAGED_MIGRATIONS_LOCK_PATH,
} from "../runtimeAssets.ts";

/**
 * Append-only migration guard.
 *
 * `runMigrations` (index.ts) records a sha256 of each migration's content the
 * first time it applies, and aborts startup forever after if that file's
 * content ever changes. Editing an already-shipped migration therefore
 * crash-loops every database that applied the original — a class of bug that
 * only surfaces on a real deployment, never in a fresh test DB.
 *
 * `migrations.lock.json` is a checked-in manifest of the SAME sha256 (byte-for
 * byte the runtime checksum). `migrationsLock.test.ts` fails CI when a locked
 * migration's hash changes (an edit to an applied migration) or a new migration
 * is not registered. `updateMigrationsLock.ts` adds new entries but refuses to
 * rewrite an existing one, so an illegal edit cannot be laundered by
 * regenerating the lock.
 */

const MIGRATIONS_DIR = PACKAGED_MIGRATIONS_DIR;
export const MIGRATIONS_LOCK_PATH = PACKAGED_MIGRATIONS_LOCK_PATH;

const MIGRATION_FILE_RE = /^\d+_.+\.sql$/;

/** Sorted list of migration file names, matching `runMigrations`' filter/order. */
function listMigrationFileNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort();
}

/** sha256 of one migration's UTF-8 content — identical to the runtime checksum. */
function hashMigrationContent(name: string): string {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

/** Current on-disk migration hashes, keyed by file name (sorted insertion order). */
export function computeMigrationHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of listMigrationFileNames())
    out[name] = hashMigrationContent(name);
  return out;
}

/** The checked-in lock manifest. Throws if unreadable/malformed. */
export function readMigrationsLock(): Record<string, string> {
  const parsed = JSON.parse(
    readFileSync(MIGRATIONS_LOCK_PATH, "utf8"),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "migrations.lock.json is not a JSON object of { filename: sha256 }.",
    );
  }
  return parsed as Record<string, string>;
}

/** Deterministic, key-sorted JSON serialization for a stable diff. */
export function serializeMigrationsLock(
  hashes: Record<string, string>,
): string {
  const sorted: Record<string, string> = {};
  for (const [name, hash] of Object.entries(hashes).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  ))
    sorted[name] = hash;
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
