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
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
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

// The one superseded checksum `index.ts` accepts: 0005_projects.sql as it was
// applied before two comment examples changed for publication.
const SUPERSEDED_0005 =
  "edeadbf7cfded7d01ca03af36c3a39d6b02935dd40ed5afd7b3d328601b68e4f";
const NAME_0005 = "0005_projects.sql";

function readRow(name: string): {
  version: number;
  name: string;
  checksum: string;
  applied_at_ms: number;
} {
  const raw = new DatabaseSync(DB_PATH);
  const row = raw
    .prepare(
      "SELECT version, name, checksum, applied_at_ms FROM schema_migrations WHERE name = ?",
    )
    .get(name) as {
    version: number;
    name: string;
    checksum: string;
    applied_at_ms: number;
  };
  raw.close();
  return row;
}

const intact0005 = (() => {
  const row = readRow(NAME_0005);
  const current = createHash("sha256")
    .update(
      readFileSync(join(import.meta.dirname, "migrations", NAME_0005), "utf8"),
    )
    .digest("hex");
  return { version: row.version, checksum: current };
})();

/** Put both rows the cases below rewrite back to what this build ships. */
function restoreRows(): void {
  closeDb();
  setRow(intact0005.version, NAME_0005, intact0005.checksum);
  setRow(shipped.version, shipped.name, shipped.checksum);
}

test("a database that applied 0005 before publication still opens", () => {
  restoreRows();
  try {
    setRow(intact0005.version, NAME_0005, SUPERSEDED_0005);
    const before = readRow(NAME_0005);
    assert.doesNotThrow(() => getDb());
    closeDb();
    // Accepted, not repaired: an older build still deployed on this data must
    // keep finding the checksum it recorded.
    assert.deepEqual(readRow(NAME_0005), before);
  } finally {
    restoreRows();
  }
});

test("a superseded checksum is accepted only for its own row and name", () => {
  restoreRows();
  try {
    // Another checksum under 0005's own name is still an edit.
    setRow(intact0005.version, NAME_0005, "2".repeat(64));
    assert.throws(
      () => getDb(),
      new RegExp(`${NAME_0005} checksum changed after it was applied`),
    );
    restoreRows();

    // The superseded checksum on another migration's row is still an edit.
    setRow(shipped.version, shipped.name, SUPERSEDED_0005);
    assert.throws(
      () => getDb(),
      new RegExp(`${shipped.name} checksum changed after it was applied`),
    );
    restoreRows();

    // The superseded checksum recorded under another name for version 5 is a
    // renumber, not the published 0005.
    setRow(intact0005.version, "0005_something_else.sql", SUPERSEDED_0005);
    assert.throws(() => getDb(), /was applied as 0005_something_else\.sql/);
  } finally {
    restoreRows();
  }
});

test("an intact database opens cleanly", () => {
  restoreRows();
  assert.doesNotThrow(() => getDb());
  closeDb();
});
