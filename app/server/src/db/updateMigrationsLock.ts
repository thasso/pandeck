import { existsSync, writeFileSync } from "node:fs";
import {
  computeMigrationHashes,
  MIGRATIONS_LOCK_PATH,
  readMigrationsLock,
  serializeMigrationsLock,
} from "./migrationsManifest.ts";

/**
 * Regenerate `migrations.lock.json`. Run after ADDING a new migration:
 *   pnpm --filter @assistant/server migrations:lock
 *
 * Add-only by design: it registers new migrations but REFUSES to rewrite the
 * hash of one already in the lock. Migrations are append-only — an existing
 * migration's content changing means an already-applied file was edited, which
 * crash-loops deployed databases. Fix that by reverting the edit and writing a
 * new forward migration, never by re-locking.
 */
function main(): void {
  const current = computeMigrationHashes();
  const existing = existsSync(MIGRATIONS_LOCK_PATH) ? readMigrationsLock() : {};

  const changed: string[] = [];
  const removed: string[] = [];
  for (const [name, hash] of Object.entries(existing)) {
    if (!(name in current)) removed.push(name);
    else if (current[name] !== hash) changed.push(name);
  }

  if (changed.length > 0 || removed.length > 0) {
    const lines = [
      "Refusing to update migrations.lock.json: migrations are append-only.",
    ];
    if (changed.length > 0) {
      lines.push(`  Edited already-locked migration(s): ${changed.join(", ")}`);
      lines.push("  Revert the edit and add a NEW forward migration instead.");
    }
    if (removed.length > 0)
      lines.push(
        `  Removed already-locked migration(s): ${removed.join(", ")}`,
      );
    console.error(lines.join("\n"));
    process.exit(1);
  }

  const merged = { ...existing, ...current };
  writeFileSync(MIGRATIONS_LOCK_PATH, serializeMigrationsLock(merged), "utf8");

  const added = Object.keys(current).filter((name) => !(name in existing));
  console.log(
    added.length > 0
      ? `migrations.lock.json updated (+${added.length}): ${added.join(", ")}`
      : "migrations.lock.json already up to date.",
  );
}

main();
