/**
 * Append-only migration guard (CI). Fails when:
 *   - an already-locked migration's content changed (an applied migration was
 *     edited — the exact bug that crash-looped prod), or
 *   - a migration file on disk is not registered in migrations.lock.json (a new
 *     migration was added without locking it), or
 *   - a locked migration file was deleted.
 *
 * To add a migration, create the new file then run:
 *   pnpm --filter @assistant/server migrations:lock
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  computeMigrationHashes,
  readMigrationsLock,
} from "./migrationsManifest.ts";

const UPDATE_CMD = "pnpm --filter @assistant/server migrations:lock";

test("migrations.lock.json matches the migration files exactly", () => {
  const current = computeMigrationHashes();
  const lock = readMigrationsLock();

  const edited: string[] = [];
  const deleted: string[] = [];
  for (const [name, hash] of Object.entries(lock)) {
    if (!(name in current)) deleted.push(name);
    else if (current[name] !== hash) edited.push(name);
  }
  const unregistered = Object.keys(current).filter((name) => !(name in lock));

  assert.deepEqual(
    edited,
    [],
    `Already-applied migration(s) were edited: ${edited.join(", ")}. Migrations are append-only — revert the edit and add a NEW forward migration. Do NOT re-lock.`,
  );
  assert.deepEqual(
    deleted,
    [],
    `Locked migration(s) were deleted: ${deleted.join(", ")}. Migrations are append-only.`,
  );
  assert.deepEqual(
    unregistered,
    [],
    `New migration(s) not registered in migrations.lock.json: ${unregistered.join(", ")}. Run \`${UPDATE_CMD}\`.`,
  );
});
