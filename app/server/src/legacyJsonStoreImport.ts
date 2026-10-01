/**
 * One-time import of a whole-file JSON store under `DATA_DIR` into SQLite — the
 * pull-request card and approval stores, which were rewritten whole on every
 * change. Follows `peerPromptLegacyImport.ts`: the file is never deleted, only
 * renamed, to `<name>.imported-<ms>.bak` after a successful import or
 * `<name>.corrupt-<ms>.json` when it cannot be read as its store.
 *
 * Idempotent across a crash at any point. The rows and a `legacy_file_imports`
 * row naming the file's sha256 commit in ONE transaction, and only then is the
 * file renamed. A crash before the commit imported nothing; a crash after it
 * leaves the same bytes in place, which the next boot finds already recorded
 * and only renames. Rows insert with `OR IGNORE` on their id, so a different
 * file appearing later (an older build run in between) adds its new records
 * without overwriting any row SQLite already holds.
 *
 * The rows commit only while the path still holds the bytes they came from
 * (same inode, same hash, checked inside the transaction): a file rewritten
 * during the import rolls that attempt back and is read again, so no stale
 * snapshot is ever committed. The rename re-checks the same way.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { basename } from "node:path";
import { getDb, withDbTransaction } from "./db/index.ts";
import { legacyFileImportStore } from "./db/legacyFileImportStore.ts";

/** How one parsed file becomes rows; `undefined` when it is not this store's shape. */
export interface LegacyStorePlan {
  /** Distinct records this import will try to insert. */
  records: number;
  /** Records dropped for lacking what a row needs (they stay in the backup). */
  invalid: number;
  /** Later records repeating an earlier one's id; the first wins (they stay in the backup). */
  duplicates: number;
  /** Insert every record inside the caller's transaction; returns how many were new. */
  write(): number;
}

/** What one import attempt left behind. */
export type LegacyImportOutcome =
  /** No legacy file: nothing to import, ever again in this process. */
  | { kind: "absent" }
  /** The file's records are in SQLite. `backup` is absent when the rename failed. */
  | {
      kind: "imported";
      /** Rows newly inserted. */
      imported: number;
      invalid: number;
      duplicates: number;
      /** Records whose id SQLite already held (an earlier import of this store). */
      existing: number;
      backup?: string;
    }
  /** The file was not a readable store and was moved aside; nothing to import. */
  | { kind: "quarantined"; target: string }
  /** The file is still in place and its records are NOT in SQLite. */
  | { kind: "failed"; reason: string };

/** How many times a file that changed mid-import is re-read before giving up. */
const ATTEMPTS = 3;

/** Thrown inside the import transaction to roll it back: the file moved on. */
class FileChangedDuringImport extends Error {}

/**
 * Run the import if the file is still there. Never throws: anything unexpected
 * (a record the plan cannot handle, a database error) is a `failed` outcome
 * with nothing committed, so one bad file can never abort a boot.
 */
export function importLegacyJsonStore(
  path: string,
  plan: (parsed: unknown) => LegacyStorePlan | undefined,
): LegacyImportOutcome {
  try {
    return importAttempts(path, plan);
  } catch (err) {
    return failed(`importing ${path} failed: ${errorText(err)}`);
  }
}

function importAttempts(
  path: string,
  plan: (parsed: unknown) => LegacyStorePlan | undefined,
): LegacyImportOutcome {
  const name = basename(path);
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (!existsSync(path)) return { kind: "absent" };
    let file: ReadFile;
    try {
      file = readBound(path);
    } catch (err) {
      return failed(`could not read ${path}: ${errorText(err)}`);
    }
    // Already recorded: an earlier boot committed these bytes and died before
    // the rename, so only the rename is left.
    if (legacyFileImportStore.has(name, file.sha256)) {
      const renamed = renameIfUnchanged(path, file, "imported", ".bak");
      if (renamed === "changed") continue;
      return imported(
        path,
        { imported: 0, invalid: 0, duplicates: 0, existing: 0 },
        renamed,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.bytes.toString("utf8"));
    } catch {
      const moved = quarantine(path, file, "could not be parsed as JSON");
      if (moved) return moved;
      continue;
    }
    const rows = plan(parsed);
    if (!rows) {
      const moved = quarantine(path, file, "is not an object");
      if (moved) return moved;
      continue;
    }
    // The snapshot commits only if it is still the file: checked INSIDE the
    // transaction, after the inserts, so a rewrite that landed meanwhile rolls
    // this attempt back instead of committing a stale state that a later
    // attempt's `OR IGNORE` could never correct.
    let inserted: number;
    try {
      inserted = withDbTransaction(() => {
        const count = rows.write();
        if (!unchanged(path, file)) throw new FileChangedDuringImport();
        legacyFileImportStore.record(name, file.sha256, count);
        return count;
      });
    } catch (err) {
      if (!(err instanceof FileChangedDuringImport)) throw err;
      console.warn(
        `[legacy-import] ${path} changed during its import; rolled back and reading it again`,
      );
      continue;
    }
    if (rows.invalid > 0 || rows.duplicates > 0)
      console.warn(
        `[legacy-import] ${name}: ${rows.invalid} invalid record(s) and ${rows.duplicates} repeated id(s) were not imported; the backup keeps them`,
      );
    const counts = {
      imported: inserted,
      invalid: rows.invalid,
      duplicates: rows.duplicates,
      existing: rows.records - inserted,
    };
    // Between the commit and the rename is the one window left, and it is
    // outside the one-writer contract (this server is the only writer, and a
    // second server on the same DATA_DIR is refused at boot). A file that
    // changed there stays in place; the next boot imports it, adding new ids.
    return imported(
      path,
      counts,
      renameIfUnchanged(path, file, "imported", ".bak"),
    );
  }
  return failed(
    `${path} kept changing while it was imported; nothing was committed and it stays in place`,
  );
}

type ImportCounts = Omit<
  Extract<LegacyImportOutcome, { kind: "imported" }>,
  "kind" | "backup"
>;

/** The records are in SQLite; report where the file went, or why it did not. */
function imported(
  path: string,
  counts: ImportCounts,
  renamed: "changed" | { backup: string } | { error: string },
): LegacyImportOutcome {
  if (renamed === "changed")
    console.warn(
      `[legacy-import] ${path} changed after its import committed; it stays in place for the next boot`,
    );
  else if ("error" in renamed)
    console.warn(
      `[legacy-import] imported ${path} but could not rename it; the next boot renames it: ${renamed.error}`,
    );
  return {
    kind: "imported",
    ...counts,
    ...(typeof renamed === "object" && "backup" in renamed
      ? { backup: renamed.backup }
      : {}),
  };
}

/**
 * Whether the legacy import has left each store's table complete, for the one
 * module that owns it. Every read and write asks {@link ensure} first; it runs
 * the import when it has not run yet. A store whose file is still in place and
 * unimported (unreadable, unmovable, or changing) is UNAVAILABLE, never empty:
 * reading it as empty would let a caller act on records it cannot see.
 *
 * Unavailable lasts until the server restarts: there is no in-process retry.
 * Every cause needs someone to fix the file anyway, and a store that could
 * come back mid-process would leave each client holding a stale outage notice
 * and missing cards until it reattached. Boot's {@link run} is the retry.
 */
export interface LegacyImportGate {
  /** Run the import now (boot, tests). */
  run(): LegacyImportOutcome;
  /** Throw {@link LegacyStoreUnavailableError} unless the table is complete. */
  ensure(): void;
  /**
   * Why the table is unavailable, or `undefined` when it can be read — for a
   * READ-ONLY projection that degrades to an empty answer and says so, rather
   * than failing a whole session list or view over one store.
   */
  unavailable(): string | undefined;
}

export class LegacyStoreUnavailableError extends Error {}

export function legacyImportGate(
  label: string,
  importOnce: () => LegacyImportOutcome,
): LegacyImportGate {
  let complete = false;
  let failure: string | undefined;
  const run = (): LegacyImportOutcome => {
    let outcome: LegacyImportOutcome;
    try {
      outcome = importOnce();
    } catch (err) {
      outcome = failed(`the ${label} import failed: ${errorText(err)}`);
    }
    // A failed run leaves records only in the file, whatever an earlier run
    // completed: the table is not the whole store until they are imported.
    complete = outcome.kind !== "failed";
    failure = outcome.kind === "failed" ? outcome.reason : undefined;
    return outcome;
  };
  const inTransaction =
    "it was first read inside an open transaction, before the boot import ran";
  /** Why, or `undefined` once complete; runs the first import if none has. */
  const reason = (): string | undefined => {
    if (complete) return undefined;
    if (failure) return failure;
    // The import commits on its own; inside a caller's transaction a rollback
    // could undo rows whose file is already renamed.
    if (getDb().isTransaction) return inTransaction;
    run();
    return failure;
  };
  return {
    run,
    unavailable: reason,
    ensure() {
      const why = reason();
      if (why)
        throw new LegacyStoreUnavailableError(
          `The ${label} store is unavailable until its legacy file is imported (fix it and restart the server): ${why}`,
        );
    },
  };
}

/**
 * The records of `values` that pass `valid`, first occurrence per key — how the
 * file store's `find` resolved a repeated id. Counts what it drops.
 */
export function firstByKey<T>(
  values: unknown[],
  valid: (value: unknown) => value is T,
  key: (value: T) => string,
): { records: T[]; invalid: number; duplicates: number } {
  const records: T[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let duplicates = 0;
  for (const value of values) {
    if (!valid(value)) {
      invalid += 1;
      continue;
    }
    const id = key(value);
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    records.push(value);
  }
  return { records, invalid, duplicates };
}

interface ReadFile {
  bytes: Buffer;
  sha256: string;
  dev: number;
  ino: number;
}

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Read through ONE descriptor, so the inode and the bytes describe the same file. */
function readBound(path: string): ReadFile {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd);
    return { bytes, sha256: hash(bytes), dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

/** Still the file that was read: same inode (not replaced) and same bytes (not rewritten). */
function unchanged(path: string, file: ReadFile): boolean {
  try {
    const stat = statSync(path);
    if (stat.dev !== file.dev || stat.ino !== file.ino) return false;
    return hash(readFileSync(path)) === file.sha256;
  } catch {
    return false;
  }
}

/**
 * `<path>.<tag>-<ms><ext>`, suffixed until nothing is there: a rename onto an
 * existing name replaces it, and two files handled within one millisecond must
 * not cost the user the first.
 */
function unusedName(path: string, tag: string, ext: string): string {
  const stem = `${path}.${tag}-${Date.now()}`;
  let name = `${stem}${ext}`;
  for (let n = 1; existsSync(name); n += 1) name = `${stem}-${n}${ext}`;
  return name;
}

/** Rename `path` aside, but only while it still holds exactly `file`. */
function renameIfUnchanged(
  path: string,
  file: ReadFile,
  tag: string,
  ext: string,
): "changed" | { backup: string } | { error: string } {
  if (!unchanged(path, file)) return "changed";
  const target = unusedName(path, tag, ext);
  try {
    renameSync(path, target);
    return { backup: target };
  } catch (err) {
    return { error: errorText(err) };
  }
}

/** Move an unreadable store aside; `undefined` when the file changed under us. */
function quarantine(
  path: string,
  file: ReadFile,
  reason: string,
): LegacyImportOutcome | undefined {
  const moved = renameIfUnchanged(path, file, "corrupt", ".json");
  if (moved === "changed") return undefined;
  if ("error" in moved)
    return failed(
      `${path} ${reason}, and could not be moved aside: ${moved.error}`,
    );
  console.warn(
    `[legacy-import] ${path} ${reason}; moved to ${moved.backup}. Nothing was imported from it.`,
  );
  return { kind: "quarantined", target: moved.backup };
}

function failed(reason: string): LegacyImportOutcome {
  console.warn(`[legacy-import] ${reason}`);
  return { kind: "failed", reason };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
