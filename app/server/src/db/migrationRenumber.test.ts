/**
 * A renumbered migration must name itself in the crash it causes.
 *
 * Two branches both added `0042_*.sql`; the rebased one was renamed to `0043`
 * after production had already applied the original as version 42. The runner
 * keys on the integer, so the shipped build hashed a different file for that
 * version and threw "checksum changed after it was applied" — which reads as
 * "someone edited a migration" and sends you looking for an edit that does not
 * exist. The recorded name is right there in the row; use it.
 *   pnpm --filter @assistant/server test src/db/migrationRenumber.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "migration-renumber-"));
process.env.DATA_DIR = dataDir;

const { closeDb, getDb } = await import("./index.ts");
const DB_PATH = join(dataDir, "app.sqlite3");

/**
 * Rewrite one `schema_migrations` row on a CLOSED database. `getDb` runs the
 * migrations it is meant to trip over, so it can neither break nor repair the
 * row — only a raw connection can.
 */
function setRow(version: number, name: string, checksum: string): void {
  const raw = new DatabaseSync(DB_PATH);
  raw
    .prepare(
      "UPDATE schema_migrations SET name = ?, checksum = ? WHERE version = ?",
    )
    .run(name, checksum, version);
  raw.close();
}

// Migrate a fresh database once, then record what this build shipped as the
// highest version — the row every case below rewrites.
const shipped = (() => {
  const row = getDb()
    .prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: number; name: string; checksum: string };
  closeDb();
  return row;
})();

test("a renumbered version reports the rename, not a phantom edit", () => {
  // As if this version had been applied under a DIFFERENT file name — exactly
  // what a rebase-renumbered migration leaves behind in a live database.
  setRow(shipped.version, "0042_something_else.sql", "0".repeat(64));

  assert.throws(
    () => getDb(),
    (err: Error) => {
      assert.match(err.message, /was applied as 0042_something_else\.sql/);
      assert.match(err.message, new RegExp(`ships it as ${shipped.name}`));
      assert.match(err.message, /RENUMBERED/);
      return true;
    },
  );
  closeDb();
});

test("an edit to a shipped migration still reports as an edit", () => {
  // Same row, same name: only the content differs. That IS an edit, and the
  // message must not blame a rename.
  setRow(shipped.version, shipped.name, "1".repeat(64));

  assert.throws(
    () => getDb(),
    (err: Error) => {
      assert.match(err.message, /checksum changed after it was applied/);
      assert.ok(!err.message.includes("RENUMBERED"));
      return true;
    },
  );
  closeDb();
});

test("an intact database opens cleanly", () => {
  setRow(shipped.version, shipped.name, shipped.checksum);

  assert.doesNotThrow(() => getDb());
  closeDb();
});
