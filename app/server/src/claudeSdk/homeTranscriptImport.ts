/**
 * The one-time boot import of Pandeck's own Default Claude transcripts out of
 * the user's home (`docs/credential-distribution.md`). Default Claude runs from
 * `DATA_DIR/credential-profiles/claude-default/claude` now, so the transcripts
 * its sessions wrote under `~/.claude/projects` are copied there once, and old
 * sessions still resume.
 *
 * - **Selection.** Every non-deleted `claude-sdk` row bound to the default or
 *   to nothing, in any scope (`db/defaultClaudeTranscriptSelection.ts`). For
 *   each, `<key>/<id>.jsonl` and its `<key>/<id>/` tree, under the same `<key>`.
 *   Nothing else: no config, no credential, no terminal-only transcript.
 * - **Home is read-only and the backup.** Nothing under home is written,
 *   renamed, chmodded or deleted. Once the state records `done`, home is never
 *   read again.
 * - **Crash safety.** The state (`home-import/state.json`) is replaced by an
 *   fsynced temp file, renamed, and its directory fsynced. Each unit is staged
 *   in `home-import/staging/`, its manifest record appended as ONE
 *   newline-terminated write and fsynced, and only then renamed into place,
 *   tree first and main last. So a manifest line without its newline belongs
 *   to a unit with no rename yet, and a `<key>/<id>/` without its main is this
 *   import's own interrupted install. Every unfinished run removes the staging
 *   and temp-state leftovers and cuts a torn manifest tail before it reads the
 *   source, and never re-copies a unit whose main is installed.
 * - **Set-aside.** A non-empty destination `projects/` that predates the
 *   import is renamed aside once, under a name persisted before the rename.
 * - **Boundary before release.** The set-aside and the durable `copy` phase
 *   come before the source is listed or the space checked, so nothing a
 *   session writes later is ever taken for pre-existing content. Until `copy`
 *   or `done` is durable, the service must not start
 *   ({@link homeTranscriptImportStartupRefusal}); after it, a failure or low
 *   space only defers the copy to the next boot.
 * - **Never throws.** A failure returns `refused` before the boundary and
 *   `aborted` after it, with one log line; the next boot resumes from the
 *   persisted phase.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.ts";
import { credentialProfileRoot } from "../credentialProfilePaths.ts";
import { DEFAULT_CLAUDE_PROFILE_ID } from "../credentialProfiles.ts";
import { defaultClaudeProviderSessionIds } from "../db/defaultClaudeTranscriptSelection.ts";
import { userHomeDir } from "../userHome.ts";

/** The points a test may throw at, as an ordinary failure would. */
export type HomeTranscriptImportStep =
  | "cleaned"
  | "manifest-repaired"
  | "state-backup"
  | "set-aside"
  | "state-copy"
  /** The copy is planned and the space checked, before any unit is staged. */
  | "planned"
  /** A source directory of the unit was listed, before its entries are copied. */
  | "listed"
  | "staged"
  | "recorded"
  | "installed-tree"
  | "installed-main";

/** The manifest's only writes, a seam so tests can fail them part-way. */
export interface ManifestIo {
  /** One write of `data` to the end of `path`, then fsync; throws on a short write. */
  append(path: string, data: Buffer): Promise<void>;
  /** Cut `path` to `length` bytes, then fsync. */
  truncate(path: string, length: number): Promise<void>;
}

export interface HomeTranscriptImportOptions {
  /** `~/.claude/projects`. */
  homeProjectsDir?: string;
  /** `credentialProfileRoot("claude-default")`. Must be below `dataDir`. */
  profileRoot?: string;
  /** Existing DATA_DIR; tests with an outside profileRoot must set this explicitly. */
  dataDir?: string;
  providerSessionIds?: () => string[];
  /** Free bytes on the profile's filesystem; undefined skips the check. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
  afterStep?: (
    step: HomeTranscriptImportStep,
    providerSessionId?: string,
  ) => void;
  now?: () => number;
  manifestIo?: ManifestIo;
}

interface HomeTranscriptImportCounts {
  selected: number;
  copied: number;
  alreadyInstalled: number;
  missing: number;
  unsupported: number;
  invalid: number;
}

export type HomeTranscriptImportResult =
  | { outcome: "already-done" }
  | {
      outcome: "done";
      sourceMissing: boolean;
      aside: string | null;
      counts: HomeTranscriptImportCounts;
      bytes: number;
      /** How the space preflight ran: `statfs`, or skipped without it. */
      preflight: "statfs" | "unavailable" | "not-needed";
    }
  /** The boundary is durable; the copy waits for more free space. */
  | { outcome: "insufficient-space"; need: number; free: number }
  /** The boundary is durable; the rest of the copy resumes next boot. */
  | { outcome: "aborted"; reason: string }
  /**
   * The boundary is not durable, or the state is unknown: no session may run
   * as Default Claude, so the service must not start. `operation` is what
   * failed, in words for the operator.
   */
  | { outcome: "refused"; operation: string; reason: string };

type ImportState =
  | { phase: "backup"; aside: string }
  | { phase: "copy"; aside: string | null }
  | {
      phase: "done";
      aside: string | null;
      sourceMissing?: true;
      counts: HomeTranscriptImportCounts;
      bytes: number;
      startedAt: number;
      finishedAt: number;
    };

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface ManifestRecord {
  providerSessionId: string;
  projectKey: string;
  files: ManifestFile[];
  at: string;
}

/** One session's transcript in one project directory. */
interface Unit {
  key: string;
  id: string;
  bytes: number;
  hasTree: boolean;
}

/** A failure this module detected itself; its reason is safe to log. */
class ImportAbort extends Error {}

/** A unit whose source vanished or changed kind under the copy. */
class UnitSkip extends Error {
  constructor(readonly kind: "missing" | "unsupported") {
    super(kind);
  }
}

const LOG = "[home-transcript-import]";
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/i;
const ASIDE_NAME = /^projects\.before-home-import-\d{8}T\d{6}Z(?:-\d+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SPACE_MARGIN = 256 * 1024 * 1024;
const COPY_CHUNK = 1024 * 1024;

/**
 * How far a run got: the operation under way, and whether the destination's
 * boundary (`copy` or `done`) is durable, so the service may start.
 */
interface ImportProgress {
  operation: string;
  startupSafe: boolean;
  /** The unit being copied, for the abort line. */
  providerSessionId: string | undefined;
}

/**
 * Run the import once. Never throws: a failure is logged and returned, and the
 * next call resumes from the persisted phase. A failure before the boundary is
 * durable returns `refused`, which the caller must enforce.
 */
export async function importDefaultClaudeHomeTranscripts(
  options: HomeTranscriptImportOptions = {},
): Promise<HomeTranscriptImportResult> {
  const progress: ImportProgress = {
    operation: "read the import state",
    startupSafe: false,
    providerSessionId: undefined,
  };
  try {
    return await runImport(options, progress);
  } catch (err) {
    const reason =
      err instanceof ImportAbort ? err.message : (errorCode(err) ?? "error");
    if (!progress.startupSafe) {
      console.error(
        `${LOG} could not ${progress.operation} (${reason}) before Default Claude's transcript directory was separated from earlier content`,
      );
      return { outcome: "refused", operation: progress.operation, reason };
    }
    console.warn(
      `${LOG} aborted (${reason})${progress.providerSessionId !== undefined ? ` at ${progress.providerSessionId}` : ""}; it resumes next boot`,
    );
    return { outcome: "aborted", reason };
  }
}

/**
 * Startup's gate on the import: undefined when the service may start, else
 * the operator's refusal, to be logged before the process exits ahead of the
 * gateway, the listener and every session. A `run` that throws is an unknown
 * outcome and refuses too. Never throws.
 */
export async function homeTranscriptImportStartupRefusal(
  run: () => Promise<HomeTranscriptImportResult> = importDefaultClaudeHomeTranscripts,
): Promise<string | undefined> {
  let failure: string;
  try {
    const result = await run();
    if (result.outcome !== "refused") return undefined;
    failure = `could not ${result.operation} (${result.reason})`;
  } catch (err) {
    failure = `ended in an unknown state (${errorCode(err) ?? "error"})`;
  }
  return (
    `${LOG} startup refused: the one-time import of Default Claude's transcripts ${failure}, ` +
    `so Default Claude's transcript directory is not yet separated from what was there before and no session may run. ` +
    `Fix the cause (free space on the DATA_DIR filesystem, permissions or ownership under credential-profiles/claude-default/, ` +
    `a file where ~/.claude/projects should be a directory, or what the reason names) and restart the service; the import resumes from its saved state. ` +
    `Keep every file in the data directory: deleting home-import/, a projects directory or its set-aside is not a recovery. ` +
    `See "Default Claude transcript import" in docs/deployment.md.`
  );
}

async function runImport(
  options: HomeTranscriptImportOptions,
  progress: ImportProgress,
): Promise<HomeTranscriptImportResult> {
  const step = (operation: string) => {
    progress.operation = operation;
  };
  const now = options.now ?? Date.now;
  const afterStep = options.afterStep ?? (() => {});
  const io = options.manifestIo ?? fileManifestIo;
  const dataDir = resolve(options.dataDir ?? DATA_DIR);
  const profile = resolve(
    options.profileRoot ?? credentialProfileRoot(DEFAULT_CLAUDE_PROFILE_ID),
  );
  step("validate the import's data root");
  assertWithinDataDir(profile, dataDir);
  if (profile === dataDir)
    throw new ImportAbort("the import profile must be below DATA_DIR");
  step("read the import state");
  const configDir = join(profile, "claude");
  const destination = join(configDir, "projects");
  const work = join(profile, "home-import");
  const statePath = join(work, "state.json");
  const manifestPath = join(work, "manifest.jsonl");
  const staging = join(work, "staging");

  // 1. Visibility is not durability: an earlier attempt may have failed
  // after a rename or mkdir. Renew its barriers before trusting saved state,
  // including a recovered set-aside. Done still never resolves or reads home.
  const state = await readState(statePath);
  if (state !== undefined) {
    step("renew the import state's durability");
    const handle = await open(statePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDirectoryPath(work, dataDir);
    if ((await lstatOrUndefined(configDir)) !== undefined)
      await fsyncDirectoryPath(configDir, dataDir);
  }
  if (state?.phase === "done") return { outcome: "already-done" };
  if (state?.phase === "copy") progress.startupSafe = true;
  const startedAt = now();

  // 2. Owned leftovers of a dead run: staging and temp state files.
  step("remove the import's leftover staging and temp state files");
  await rm(staging, { recursive: true, force: true });
  for (const name of await listNames(work))
    if (name.startsWith("state.json.tmp-"))
      await rm(join(work, name), { force: true });
  afterStep("cleaned");

  // 3. Manifest tail repair, before anything can append.
  step("repair the import manifest");
  const records = await repairManifest(manifestPath, io);
  afterStep("manifest-repaired");

  // 4. Source: only whether it is there, before the boundary.
  step("check the home transcript directory");
  const source =
    options.homeProjectsDir ?? join(userHomeDir(), ".claude", "projects");
  const sourceStat = await lstatOrUndefined(source);
  if (sourceStat === undefined) {
    step("record the finished import");
    if (state === undefined) {
      await writeState(dataDir, work, statePath, {
        phase: "done",
        aside: null,
        counts: zeroCounts(),
        bytes: 0,
        startedAt,
        finishedAt: now(),
      });
      progress.startupSafe = true;
      console.info(`${LOG} done: no Claude transcripts in the home directory`);
      return {
        outcome: "done",
        sourceMissing: false,
        aside: null,
        counts: zeroCounts(),
        bytes: 0,
        preflight: "not-needed",
      };
    }
    const aside =
      state.aside !== null &&
      (await lstatOrUndefined(join(configDir, state.aside))) !== undefined
        ? state.aside
        : null;
    const effective = effectiveManifest(records);
    const counts = { ...zeroCounts(), copied: effective.size };
    const bytes = [...effective.values()].reduce(
      (sum, record) => sum + record.files.reduce((n, f) => n + f.size, 0),
      0,
    );
    await writeState(dataDir, work, statePath, {
      phase: "done",
      aside,
      sourceMissing: true,
      counts,
      bytes,
      startedAt,
      finishedAt: now(),
    });
    progress.startupSafe = true;
    console.warn(
      `${LOG} done: the home transcripts disappeared after an earlier attempt; ${counts.copied} sessions copied before stay`,
    );
    return {
      outcome: "done",
      sourceMissing: true,
      aside,
      counts,
      bytes,
      preflight: "not-needed",
    };
  }
  if (!sourceStat.isDirectory())
    throw new ImportAbort("the home transcript path is not a directory");

  // 5. Boundary, before the source is listed or the space checked: the
  // set-aside and a durable `copy`. Only then may the service start, so no
  // session can have written the destination before it is set aside.
  let aside: string | null;
  if (state === undefined || state.phase === "backup") {
    let name: string;
    if (state === undefined) {
      step("record the import's backup state");
      name = await freshAsideName(configDir, now());
      await writeState(dataDir, work, statePath, {
        phase: "backup",
        aside: name,
      });
      afterStep("state-backup");
    } else name = state.aside;
    step("set the former projects/ aside");
    const asidePath = join(configDir, name);
    if ((await lstatOrUndefined(asidePath)) !== undefined) {
      if (await nonEmpty(destination))
        throw new ImportAbort(
          "both the destination and its set-aside exist; resolve by hand",
        );
      aside = name;
    } else if (await nonEmpty(destination)) {
      await rename(destination, asidePath);
      await fsyncDir(configDir);
      afterStep("set-aside");
      aside = name;
    } else aside = null;
    step("record the import's copy state");
    await writeState(dataDir, work, statePath, { phase: "copy", aside });
    progress.startupSafe = true;
    afterStep("state-copy");
  } else aside = state.aside;

  // 6. Plan against the destination as it stands: a unit whose main is there
  // is installed, never staged, and not in the need.
  step("plan the copy");
  const counts = zeroCounts();
  const ids = new Set<string>();
  for (const id of (options.providerSessionIds ?? selectedIds)()) {
    counts.selected += 1;
    if (PROVIDER_ID.test(id)) ids.add(id);
    else counts.invalid += 1;
  }
  const { units, unsupported } = await planUnits(source, ids);
  counts.unsupported = unsupported.size;
  const found = new Set([...units.map((u) => u.id), ...unsupported]);
  counts.missing = [...ids].filter((id) => !found.has(id)).length;

  // 7. Preflight: below the need, stage nothing and retry next boot.
  const pending: Unit[] = [];
  for (const unit of units)
    if (!(await exists(mainPath(destination, unit)))) pending.push(unit);
  const peak = pending.reduce((sum, unit) => sum + unit.bytes, 0);
  const need = Math.ceil(peak * 1.1) + SPACE_MARGIN;
  const free = await (options.freeBytes ?? statfsFreeBytes)(profile);
  if (free !== undefined && free < need) {
    console.warn(
      `${LOG} needs ${need} free bytes and ${free} are free; it retries next boot`,
    );
    return { outcome: "insufficient-space", need, free };
  }
  afterStep("planned");

  // 8. Copy each unit not installed yet.
  step("copy the transcripts");
  let bytes = 0;
  for (const unit of units) {
    progress.providerSessionId = unit.id;
    const main = mainPath(destination, unit);
    if (await exists(main)) {
      counts.alreadyInstalled += 1;
      continue;
    }
    const installedTree = join(destination, unit.key, unit.id);
    // Only this import's own interrupted install leaves a tree without main.
    await rm(installedTree, { recursive: true, force: true });
    let files: ManifestFile[];
    try {
      files = await stageUnit(dataDir, source, sourceStat, staging, unit, () =>
        afterStep("listed", unit.id),
      );
    } catch (err) {
      if (!(err instanceof UnitSkip)) throw err;
      counts[err.kind] += 1;
      await rm(join(staging, unit.key), { recursive: true, force: true });
      continue;
    }
    afterStep("staged", unit.id);
    await appendRecord(
      dataDir,
      manifestPath,
      work,
      {
        providerSessionId: unit.id,
        projectKey: unit.key,
        files,
        at: new Date(now()).toISOString(),
      },
      io,
    );
    afterStep("recorded", unit.id);
    const keyDir = join(destination, unit.key);
    await ensureDir(keyDir, dataDir);
    if (unit.hasTree) {
      await rename(join(staging, unit.key, unit.id), installedTree);
      afterStep("installed-tree", unit.id);
    }
    await rename(join(staging, unit.key, `${unit.id}.jsonl`), main);
    await fsyncDir(keyDir);
    afterStep("installed-main", unit.id);
    counts.copied += 1;
    bytes += files.reduce((sum, file) => sum + file.size, 0);
  }
  progress.providerSessionId = undefined;

  // 9. Done.
  await rm(staging, { recursive: true, force: true });
  await writeState(dataDir, work, statePath, {
    phase: "done",
    aside,
    counts,
    bytes,
    startedAt,
    finishedAt: now(),
  });
  console.info(
    `${LOG} done: ${counts.copied} sessions copied (${bytes} bytes), ${counts.alreadyInstalled} already there, ${counts.missing} without a transcript, ${counts.unsupported} unsupported, ${counts.invalid} invalid ids${aside !== null ? `; the former projects/ is set aside as ${aside}` : ""}`,
  );
  return {
    outcome: "done",
    sourceMissing: false,
    aside,
    counts,
    bytes,
    preflight: free === undefined ? "unavailable" : "statfs",
  };
}

function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function selectedIds(): string[] {
  return defaultClaudeProviderSessionIds(DEFAULT_CLAUDE_PROFILE_ID);
}

function zeroCounts(): HomeTranscriptImportCounts {
  return {
    selected: 0,
    copied: 0,
    alreadyInstalled: 0,
    missing: 0,
    unsupported: 0,
    invalid: 0,
  };
}

function mainPath(destination: string, unit: Unit): string {
  return join(destination, unit.key, `${unit.id}.jsonl`);
}

/**
 * Every (key, id) unit under `source`: one listing per project directory,
 * links never followed. A unit holding anything but directories and regular
 * files is unsupported, by id.
 */
async function planUnits(
  source: string,
  ids: Set<string>,
): Promise<{ units: Unit[]; unsupported: Set<string> }> {
  const units: Unit[] = [];
  const unsupported = new Set<string>();
  const keys = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const key of keys) {
    const entries = (
      await readdir(join(source, key), { withFileTypes: true })
    ).sort(byName);
    for (const entry of entries) {
      if (!entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!ids.has(id)) continue;
      if (!entry.isFile()) {
        unsupported.add(id);
        continue;
      }
      const mainSize = (await lstat(join(source, key, entry.name))).size;
      const tree = await lstatOrUndefined(join(source, key, id));
      if (tree !== undefined && !tree.isDirectory()) {
        unsupported.add(id);
        continue;
      }
      const treeBytes =
        tree === undefined ? 0 : await regularTreeBytes(join(source, key, id));
      if (treeBytes === undefined) {
        unsupported.add(id);
        continue;
      }
      units.push({
        key,
        id,
        bytes: mainSize + treeBytes,
        hasTree: tree !== undefined,
      });
    }
  }
  return { units, unsupported };
}

/** The tree's regular-file bytes, or undefined if it holds anything else. */
async function regularTreeBytes(dir: string): Promise<number | undefined> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await regularTreeBytes(path);
      if (inner === undefined) return undefined;
      total += inner;
    } else if (entry.isFile()) total += (await lstat(path)).size;
    else return undefined;
  }
  return total;
}

/**
 * Copy one unit into `staging/<key>/`: the `<id>/` tree, then the main, each
 * file hashed from the bytes written and fsynced, each directory fsynced
 * once its entries are in. Files end 0600 and directories 0700.
 *
 * Paths are walked by name, so every source directory the copy goes through
 * (`projects/` as step 4 saw it, the project, the tree and each directory in
 * it; not home or `.claude` above them) must be a real directory,
 * not a link, both before it is used and after everything under it is
 * staged, with the same device and inode. A directory replaced since the plan
 * makes the unit unsupported and its staging is discarded, so nothing read
 * through a link is recorded or installed. This detects a replacement present
 * at either check; it cannot see one made and undone between them, since Node
 * has no directory-relative open or listing.
 */
async function stageUnit(
  dataDir: string,
  source: string,
  sourceBefore: Stats,
  staging: string,
  unit: Unit,
  listed: () => void,
): Promise<ManifestFile[]> {
  await assertSameDirectory(source, sourceBefore);
  const project = join(source, unit.key);
  const projectBefore = await sourceDirectory(project);
  const stagedKey = join(staging, unit.key);
  await ensureDir(stagedKey, dataDir);
  const files: ManifestFile[] = [];
  if (unit.hasTree)
    await stageTree(
      join(project, unit.id),
      join(stagedKey, unit.id),
      `${unit.key}/${unit.id}`,
      files,
      listed,
    );
  files.push({
    path: `${unit.key}/${unit.id}.jsonl`,
    ...(await copyFile(
      join(project, `${unit.id}.jsonl`),
      join(stagedKey, `${unit.id}.jsonl`),
    )),
  });
  await assertSameDirectory(project, projectBefore);
  await assertSameDirectory(source, sourceBefore);
  await fsyncDir(stagedKey);
  return files;
}

async function stageTree(
  from: string,
  to: string,
  relative: string,
  files: ManifestFile[],
  listed: () => void,
): Promise<void> {
  const before = await sourceDirectory(from);
  await mkdir(to, { mode: 0o700 });
  await chmod(to, 0o700);
  let entries: Dirent[];
  try {
    entries = await readdir(from, { withFileTypes: true });
  } catch (err) {
    throw skipFor(err);
  }
  listed();
  entries.sort(byName);
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory())
      await stageTree(
        join(from, entry.name),
        join(to, entry.name),
        path,
        files,
        listed,
      );
    else if (entry.isFile())
      files.push({
        path,
        ...(await copyFile(join(from, entry.name), join(to, entry.name))),
      });
    else throw new UnitSkip("unsupported");
  }
  await assertSameDirectory(from, before);
  await fsyncDir(to);
}

/**
 * The source directory at `path`, never through a link at it: gone makes the
 * unit missing, anything but a directory unsupported.
 */
async function sourceDirectory(path: string): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (err) {
    throw skipFor(err);
  }
  if (!stat.isDirectory()) throw new UnitSkip("unsupported");
  return stat;
}

/**
 * `path` is still the directory `before` was. Either way the unit is skipped:
 * gone makes it missing (AC10(2)), replaced unsupported.
 */
async function assertSameDirectory(path: string, before: Stats): Promise<void> {
  const after = await sourceDirectory(path);
  if (after.dev !== before.dev || after.ino !== before.ino)
    throw new UnitSkip("unsupported");
}

/** Stream `from` into a new `to`, never following a link at `from`. */
async function copyFile(
  from: string,
  to: string,
): Promise<{ size: number; sha256: string }> {
  let input: FileHandle;
  try {
    // Non-blocking, so an entry swapped for a FIFO cannot stall boot.
    input = await open(
      from,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (err) {
    throw skipFor(err);
  }
  try {
    if (!(await input.stat()).isFile()) throw new UnitSkip("unsupported");
    const output = await open(to, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(COPY_CHUNK);
      let size = 0;
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, COPY_CHUNK, null);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(
            buffer,
            written,
            bytesRead - written,
          );
          written += bytesWritten;
        }
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
      await output.chmod(0o600);
      await output.sync();
      return { size, sha256: hash.digest("hex") };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

/** A vanished source makes the unit missing; a link at it, unsupported. */
function skipFor(err: unknown): unknown {
  const code = errorCode(err);
  if (code === "ENOENT") return new UnitSkip("missing");
  if (code === "ELOOP" || code === "ENOTDIR")
    return new UnitSkip("unsupported");
  return err;
}

/**
 * Cut bytes after the last newline (a torn append by construction), fsync,
 * and parse every remaining line. A complete line that is not a record cannot
 * be this import's, so the run stops rather than repair someone else's file.
 */
async function repairManifest(
  path: string,
  io: ManifestIo,
): Promise<ManifestRecord[]> {
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
  const keep = raw.lastIndexOf(0x0a) + 1;
  if (keep < raw.length) {
    await io.truncate(path, keep);
    console.warn(
      `${LOG} cut ${raw.length - keep} bytes of an unfinished manifest record`,
    );
  }
  const records: ManifestRecord[] = [];
  const text = raw.subarray(0, keep).toString("utf8");
  for (const line of text.split("\n").slice(0, -1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ImportAbort("the manifest holds a line it did not write");
    }
    if (!isManifestRecord(parsed))
      throw new ImportAbort("the manifest holds a line it did not write");
    records.push(parsed);
  }
  return records;
}

function isManifestRecord(value: unknown): value is ManifestRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerSessionId === "string" &&
    PROVIDER_ID.test(record.providerSessionId) &&
    typeof record.projectKey === "string" &&
    record.projectKey.length > 0 &&
    !record.projectKey.includes("/") &&
    typeof record.at === "string" &&
    Array.isArray(record.files) &&
    record.files.every(
      (file: unknown) =>
        !!file &&
        typeof file === "object" &&
        typeof (file as ManifestFile).path === "string" &&
        typeof (file as ManifestFile).size === "number" &&
        typeof (file as ManifestFile).sha256 === "string" &&
        SHA256.test((file as ManifestFile).sha256),
    )
  );
}

/** The last record per (key, id): the one that describes the installed files. */
function effectiveManifest(
  records: ManifestRecord[],
): Map<string, ManifestRecord> {
  const effective = new Map<string, ManifestRecord>();
  for (const record of records)
    effective.set(`${record.projectKey}/${record.providerSessionId}`, record);
  return effective;
}

/**
 * Append one record as one newline-terminated write and fsync it. A failed
 * or short write is truncated back to the length before it; if even that
 * fails, the next run's tail repair removes it. Either way this run stops
 * before the unit's renames.
 */
async function appendRecord(
  dataDir: string,
  path: string,
  work: string,
  record: ManifestRecord,
  io: ManifestIo,
): Promise<void> {
  const before = await lstatOrUndefined(path);
  await ensureDir(work, dataDir);
  try {
    await io.append(path, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
  } catch (err) {
    try {
      await io.truncate(path, before?.size ?? 0);
    } catch {
      // The torn tail is repaired by the next run before it appends.
    }
    throw err;
  }
  if (before === undefined) await fsyncDir(work);
}

const fileManifestIo: ManifestIo = {
  async append(path, data) {
    const handle = await open(path, "a", 0o600);
    try {
      const { bytesWritten } = await handle.write(data, 0, data.length);
      if (bytesWritten !== data.length)
        throw new ImportAbort("a manifest record was written short");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async truncate(path, length) {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

async function readState(path: string): Promise<ImportState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ImportAbort("the import state is unreadable");
  }
  const state = parsed as Record<string, unknown> | null;
  const aside = state?.aside;
  const asideValid =
    aside === null || (typeof aside === "string" && ASIDE_NAME.test(aside));
  if (
    !state ||
    !asideValid ||
    !(
      state.phase === "done" ||
      state.phase === "copy" ||
      (state.phase === "backup" && aside !== null)
    )
  )
    throw new ImportAbort("the import state is unreadable");
  return state as ImportState;
}

/** Replace the state: fsynced temp file, rename, fsynced directory. */
async function writeState(
  dataDir: string,
  work: string,
  path: string,
  state: ImportState,
): Promise<void> {
  await ensureDir(work, dataDir);
  const temp = join(work, `state.json.tmp-${randomUUID()}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await fsyncDir(work);
}

/** A set-aside name for `at` that no entry has yet. */
async function freshAsideName(configDir: string, at: number): Promise<string> {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const base = `projects.before-home-import-${stamp}`;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if ((await lstatOrUndefined(join(configDir, name))) === undefined)
      return name;
  }
}

/** Reject an outside test profile before any state read or directory operation. */
function assertWithinDataDir(dir: string, dataDir: string): void {
  const path = relative(dataDir, dir);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new ImportAbort("the import path is outside DATA_DIR");
}

/** Create missing directories below the existing DATA_DIR at 0700, each durably. */
async function ensureDir(dir: string, dataDir: string): Promise<void> {
  assertWithinDataDir(dir, dataDir);
  if (dir === dataDir) {
    await fsyncDir(dir);
    return;
  }
  const stat = await lstatOrUndefined(dir);
  if (stat?.isDirectory()) {
    // mkdir may have succeeded before a previous parent's sync failed.
    await fsyncDirectoryPath(dirname(dir), dataDir);
    return;
  }
  if (stat !== undefined) throw new ImportAbort("a directory path is taken");
  await ensureDir(dirname(dir), dataDir);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
  await chmod(dir, 0o700);
  await fsyncDir(dirname(dir));
}

/** Renew namespace barriers up to DATA_DIR inclusive, never its ancestors. */
async function fsyncDirectoryPath(dir: string, dataDir: string): Promise<void> {
  assertWithinDataDir(dir, dataDir);
  for (;;) {
    await fsyncDir(dir);
    if (dir === dataDir) return;
    dir = dirname(dir);
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** True when `path` is missing nothing: a non-empty directory or any other entry. */
async function nonEmpty(path: string): Promise<boolean> {
  const stat = await lstatOrUndefined(path);
  if (stat === undefined) return false;
  if (!stat.isDirectory()) return true;
  return (await readdir(path)).length > 0;
}

async function exists(path: string): Promise<boolean> {
  return (await lstatOrUndefined(path)) !== undefined;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
}

/**
 * What says statfs itself is not there: no such call in the kernel or on the
 * filesystem, or none in this runtime. Only these skip the space check.
 */
const STATFS_UNSUPPORTED = new Set([
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ERR_METHOD_NOT_IMPLEMENTED",
  "ERR_NOT_IMPLEMENTED",
]);

/**
 * Free bytes for `dir`'s filesystem, from its nearest existing ancestor;
 * undefined only when statfs is unsupported. Any other failure (EIO, EACCES,
 * …) throws, so the run aborts before it changes anything and retries next
 * boot.
 */
async function statfsFreeBytes(dir: string): Promise<number | undefined> {
  if (typeof statfs !== "function") return undefined;
  let probe = dir;
  for (;;) {
    try {
      const disk = await statfs(probe);
      return Number(disk.bavail) * Number(disk.bsize);
    } catch (err) {
      const code = errorCode(err);
      if (code !== undefined && STATFS_UNSUPPORTED.has(code)) return undefined;
      const parent = dirname(probe);
      if (code !== "ENOENT" || parent === probe) throw err;
      probe = parent;
    }
  }
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
