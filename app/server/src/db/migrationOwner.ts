/**
 * Who is allowed to change a data directory's schema.
 *
 * Scrubbing the instance environment (`instanceEnv.ts`) removes the ACCIDENT —
 * an agent's worktree process no longer inherits production's `DATA_DIR`. It
 * cannot remove the DELIBERATE form, and that form is common: reading real data
 * from a checkout (`DATA_DIR=/home/alice/assistant-data pnpm …`) is a legitimate,
 * frequently used move. The danger is that opening the database at all runs
 * `runMigrations`, so a read-shaped command from a feature branch can write
 * schema that has never shipped — which is exactly how a renumbered `0042`
 * reached production and crash-looped the next release.
 *
 * So the guard is about provenance, not intent: a data directory whose schema
 * was last changed by a PACKAGED build (a Nix store path — immutable, built
 * from a reviewed commit, the only thing a deploy or a PR preview ever runs)
 * refuses further changes from a WORKING COPY. Reads are untouched; only
 * applying a migration is gated. Deploys keep working because every release is
 * another packaged build, even though its store path changes each time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, packagedAppRootFor } from "../config.ts";

const OWNER_PATH = join(DATA_DIR, ".migration-owner.json");

/** Escape hatch for a deliberate out-of-band repair. Never set in the unit. */
const OVERRIDE_ENV = "ASSISTANT_ALLOW_FOREIGN_MIGRATIONS";

/** The installed tree this module belongs to (repo root, or the Nix package). */
const APP_ROOT = packagedAppRootFor(import.meta.url);

/**
 * True when this code runs from an immutable Nix store path — a built package
 * rather than someone's checkout or an agent's worktree.
 */
export function isPackagedBuild(appRoot: string = APP_ROOT): boolean {
  return appRoot.startsWith("/nix/store/");
}

export type MigrationOwner = {
  /** Whether the recorded owner was a packaged build. */
  packaged: boolean;
  /** Its application root, for a legible error message. */
  appRoot: string;
  updatedAtMs: number;
};

/** The recorded owner, or undefined when absent/unreadable (never throws). */
export function readMigrationOwner(
  path: string = OWNER_PATH,
): MigrationOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const { packaged, appRoot, updatedAtMs } =
      parsed as Partial<MigrationOwner>;
    if (typeof packaged !== "boolean" || typeof appRoot !== "string")
      return undefined;
    return {
      packaged,
      appRoot,
      updatedAtMs: typeof updatedAtMs === "number" ? updatedAtMs : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Record who last applied a migration. A working copy may only claim a data
 * directory nobody owns yet — it must never downgrade a packaged owner, or the
 * first dev process to touch production would disarm the guard permanently.
 */
export function recordMigrationOwner(
  path: string = OWNER_PATH,
  appRoot: string = APP_ROOT,
): void {
  const packaged = isPackagedBuild(appRoot);
  if (!packaged && readMigrationOwner(path)) return;
  const owner: MigrationOwner = { packaged, appRoot, updatedAtMs: Date.now() };
  try {
    writeFileSync(path, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
  } catch {
    // Best effort: never fail startup over the marker. A missing marker costs
    // protection on the next run, not correctness on this one.
  }
}

/**
 * Throw unless this build may apply `pending` to the current data directory.
 * Called only when there is something to apply, so an ordinary read from a
 * checkout against a fully migrated production directory stays silent.
 */
export function assertMayApplyMigrations(
  pending: string[],
  opts: { path?: string; appRoot?: string } = {},
): void {
  if (pending.length === 0) return;
  const path = opts.path ?? OWNER_PATH;
  const appRoot = opts.appRoot ?? APP_ROOT;

  const owner = readMigrationOwner(path);
  // Unowned (a fresh directory) or dev-owned: nothing deployed to protect.
  if (!owner?.packaged) return;
  // A release or a PR preview — the normal way schema changes.
  if (isPackagedBuild(appRoot)) return;
  if (process.env[OVERRIDE_ENV] === "1") return;

  throw new Error(
    `Refusing to apply migration(s) ${pending.join(", ")} to ${DATA_DIR}: ` +
      `its schema is owned by the packaged build at ${owner.appRoot}, but this ` +
      `process runs from the working copy at ${appRoot}. A deployed database ` +
      `must only be migrated by a released build — schema applied from a branch ` +
      `is lost the moment that branch is rebased or renumbered, and the next ` +
      `release then crash-loops on a checksum it cannot produce. Point DATA_DIR ` +
      `at your own data directory, or set ${OVERRIDE_ENV}=1 if you are ` +
      `deliberately repairing this database out of band.`,
  );
}
