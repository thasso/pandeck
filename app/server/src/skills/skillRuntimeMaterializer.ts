import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSafeSkillName } from "@assistant/shared";
import { SKILLS_LIBRARY_DIR, SKILLS_RUNTIME_DIR } from "../config.ts";

const RUNTIME_METADATA_FILE = ".pa-skills-runtime.json";
const RUNTIME_SCHEMA_VERSION = 1;
const SKILL_FILE_NAME = "SKILL.md";

interface RuntimeMetadata {
  schemaVersion: number;
  hash: string;
  names: string[];
}

interface RuntimeSource {
  name: string;
  directory: string;
}

export interface SkillRuntimeMaterializerOptions {
  libraryDir?: string;
  runtimeDir?: string;
}

/** The scanner projection materialization needs; a full library scan is structurally compatible. */
export interface SkillRuntimeScan {
  readonly skills: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly diagnostics: readonly {
    readonly declaredName?: string;
    readonly error: string;
  }[];
}

export interface MaterializedSkillRuntime {
  hash: string;
  names: string[];
  root: string;
  skillsDir: string;
}

/** A frozen name set cannot be represented by the supplied scanner snapshot. */
export class SkillRuntimeMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRuntimeMaterializationError";
  }
}

const targetLocks = new Map<string, Promise<void>>();

/** Stable SHA-256 identity for a set of safe skill names. */
export function skillSetHash(names: readonly string[]): string {
  const normalized = normalizeNames(names);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Materialize one scanner-validated frozen name set for both coding harnesses.
 *
 * The returned root is a Claude local plugin. `skillsDir` is the pi loader root.
 * Source folders stay symlinked so supporting files and uncommitted edits remain
 * visible without refreshing generated output.
 */
export async function materializeSkillRuntime(
  frozenNames: readonly string[],
  scan: SkillRuntimeScan,
  options: SkillRuntimeMaterializerOptions = {},
): Promise<MaterializedSkillRuntime> {
  const names = normalizeNames(frozenNames);
  const hash = skillSetHash(names);
  const libraryDir = resolve(options.libraryDir ?? SKILLS_LIBRARY_DIR);
  const runtimeDir = resolve(options.runtimeDir ?? SKILLS_RUNTIME_DIR);
  const root = join(runtimeDir, hash);
  const result: MaterializedSkillRuntime = {
    hash,
    names,
    root,
    skillsDir: join(root, "skills"),
  };

  return withTargetLock(root, async () => {
    const sources = await resolveRuntimeSources(names, scan, libraryDir);
    const expected = expectedRuntime(hash, names, sources);
    if (await isCompleteRuntime(root, expected)) return result;

    await mkdir(runtimeDir, { recursive: true });
    const stage = await mkdtemp(join(runtimeDir, `.${hash}.tmp-`));
    try {
      await writeStagedRuntime(stage, expected);
      await publishRuntime(stage, root, expected);
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
    return result;
  });
}

function normalizeNames(names: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const name of names) {
    // The shared predicate, never a copy of it: a name is a directory child
    // here and the toggle map's key in settings, so a second rule would let
    // what may be enabled and what may be materialized drift apart.
    if (typeof name !== "string" || !isSafeSkillName(name)) {
      throw new SkillRuntimeMaterializationError(
        `Invalid frozen skill name ${JSON.stringify(name)}.`,
      );
    }
    unique.add(name);
  }
  return [...unique].sort(compareText);
}

async function resolveRuntimeSources(
  names: readonly string[],
  scan: SkillRuntimeScan,
  libraryDir: string,
): Promise<RuntimeSource[]> {
  const summaries = summariesByName(scan.skills);
  const sources: RuntimeSource[] = [];
  for (const name of names) {
    const summary = summaries.get(name);
    if (!summary) {
      throw missingSkillError(name, scan.diagnostics);
    }
    const directory = sourceDirectory(summary, libraryDir);
    await validateSource(name, directory);
    sources.push({ name, directory });
  }
  return sources;
}

type RuntimeScanSummary = SkillRuntimeScan["skills"][number];

function summariesByName(
  skills: SkillRuntimeScan["skills"],
): Map<string, RuntimeScanSummary> {
  const summaries = new Map<string, RuntimeScanSummary>();
  for (const skill of skills) {
    if (summaries.has(skill.name)) {
      throw new SkillRuntimeMaterializationError(
        `Scanner result is ambiguous for skill ${JSON.stringify(skill.name)}.`,
      );
    }
    summaries.set(skill.name, skill);
  }
  return summaries;
}

function missingSkillError(
  name: string,
  diagnostics: SkillRuntimeScan["diagnostics"],
): SkillRuntimeMaterializationError {
  const matching = diagnostics
    .filter((diagnostic) => diagnostic.declaredName === name)
    .map((diagnostic) => diagnostic.error);
  const detail = matching.length > 0 ? ` ${matching.join(" ")}` : "";
  return new SkillRuntimeMaterializationError(
    `Frozen skill ${JSON.stringify(name)} is missing or invalid in the supplied scanner result.${detail}`,
  );
}

function sourceDirectory(
  summary: RuntimeScanSummary,
  libraryDir: string,
): string {
  const suffix = `/${SKILL_FILE_NAME}`;
  if (!summary.path.endsWith(suffix)) {
    throw unsafeSourcePath(summary);
  }
  const folder = summary.path.slice(0, -suffix.length);
  if (
    folder.length === 0 ||
    folder === "." ||
    folder === ".." ||
    folder.startsWith(".") ||
    folder.includes("/") ||
    folder.includes("\\")
  ) {
    throw unsafeSourcePath(summary);
  }

  const directory = resolve(libraryDir, folder);
  const fromLibrary = relative(libraryDir, directory);
  if (
    fromLibrary.length === 0 ||
    fromLibrary.startsWith("..") ||
    isAbsolute(fromLibrary)
  ) {
    throw unsafeSourcePath(summary);
  }
  return directory;
}

function unsafeSourcePath(
  summary: RuntimeScanSummary,
): SkillRuntimeMaterializationError {
  return new SkillRuntimeMaterializationError(
    `Scanner path ${JSON.stringify(summary.path)} for skill ${JSON.stringify(summary.name)} is not one top-level SKILL.md path.`,
  );
}

async function validateSource(name: string, directory: string): Promise<void> {
  try {
    const directoryEntry = await lstat(directory);
    if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
      throw new Error("source is not a regular directory");
    }
    const skillFile = await stat(join(directory, SKILL_FILE_NAME));
    if (!skillFile.isFile()) throw new Error("SKILL.md is not a file");
    await access(join(directory, SKILL_FILE_NAME), constants.R_OK);
  } catch (error) {
    throw new SkillRuntimeMaterializationError(
      `Source folder for frozen skill ${JSON.stringify(name)} is missing or unreadable at ${directory}: ${errorMessage(error)}`,
    );
  }
}

function expectedRuntime(
  hash: string,
  names: readonly string[],
  sources: readonly RuntimeSource[],
): {
  metadataText: string;
  manifestText: string;
  sources: readonly RuntimeSource[];
} {
  const metadata: RuntimeMetadata = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    hash,
    names: [...names],
  };
  return {
    metadataText: `${JSON.stringify(metadata, null, 2)}\n`,
    manifestText: `${JSON.stringify(pluginManifest(hash), null, 2)}\n`,
    sources,
  };
}

/** The Claude plugin name of a runtime layout; Claude qualifies its skills as `<plugin>:<name>`. */
export function skillRuntimePluginName(hash: string): string {
  return `pa-skills-${hash.slice(0, 16)}`;
}

function pluginManifest(hash: string): Record<string, unknown> {
  return {
    name: skillRuntimePluginName(hash),
    version: "1.0.0",
    description: "Pandeck materialized skills library set",
    author: { name: "Pandeck" },
  };
}

async function writeStagedRuntime(
  stage: string,
  expected: ReturnType<typeof expectedRuntime>,
): Promise<void> {
  const pluginDir = join(stage, ".claude-plugin");
  const skillsDir = join(stage, "skills");
  await mkdir(pluginDir);
  await mkdir(skillsDir);
  await writeFile(
    join(pluginDir, "plugin.json"),
    expected.manifestText,
    "utf8",
  );
  for (const source of expected.sources) {
    await symlink(source.directory, join(skillsDir, source.name), "dir");
  }
  // Written last: its presence never marks a partially constructed stage ready.
  await writeFile(
    join(stage, RUNTIME_METADATA_FILE),
    expected.metadataText,
    "utf8",
  );
}

async function publishRuntime(
  stage: string,
  target: string,
  expected: ReturnType<typeof expectedRuntime>,
): Promise<void> {
  for (;;) {
    try {
      await rename(stage, target);
      return;
    } catch (error) {
      if (!isPublishConflict(error)) throw error;
    }

    if (await isCompleteRuntime(target, expected)) {
      await rm(stage, { recursive: true, force: true });
      return;
    }

    const quarantine = `${target}.partial-${randomUUID()}`;
    try {
      await rename(target, quarantine);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  }
}

async function isCompleteRuntime(
  root: string,
  expected: ReturnType<typeof expectedRuntime>,
): Promise<boolean> {
  try {
    const rootEntry = await lstat(root);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return false;

    if (
      !sameNames(await entryNames(root), [
        ".claude-plugin",
        RUNTIME_METADATA_FILE,
        "skills",
      ]) ||
      !sameNames(await entryNames(join(root, ".claude-plugin")), [
        "plugin.json",
      ]) ||
      (await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8")) !==
        expected.manifestText ||
      (await readFile(join(root, RUNTIME_METADATA_FILE), "utf8")) !==
        expected.metadataText ||
      !sameNames(
        await entryNames(join(root, "skills")),
        expected.sources.map(({ name }) => name),
      )
    ) {
      return false;
    }

    for (const source of expected.sources) {
      const link = join(root, "skills", source.name);
      const entry = await lstat(link);
      if (!entry.isSymbolicLink()) return false;
      const target = await readlink(link);
      if (resolve(dirname(link), target) !== source.directory) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function entryNames(path: string): Promise<string[]> {
  return (await readdir(path)).sort(compareText);
}

function sameNames(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const sortedExpected = [...expected].sort(compareText);
  return (
    actual.length === sortedExpected.length &&
    actual.every((name, index) => name === sortedExpected[index])
  );
}

async function withTargetLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = targetLocks.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  targetLocks.set(key, tail);
  try {
    return await next;
  } finally {
    if (targetLocks.get(key) === tail) targetLocks.delete(key);
  }
}

function isPublishConflict(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "ENOTDIR")
  );
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
