/**
 * Host tool requirements.
 *
 * This server runs coding agents on a real machine and deliberately does not
 * vendor their toolchain: the nixosModule puts only the host's profiles on the
 * service PATH, so `bash`, `coreutils` and friends are whatever the operator
 * installed. `config/host-tools.json` is the contract that replaces the vendored
 * closure, and {@link verifyRequiredHostTools} checks it ONCE during startup so a
 * missing or too-old tool fails the boot with an actionable message instead of
 * surfacing later as an opaque agent error.
 *
 * Checked once, on purpose. A host update can change a tool under a running
 * agent; that is an accepted consequence of using host tools rather than pinned
 * ones, and re-checking per invocation would cost far more than it protects.
 *
 * OPTIONAL capabilities do not belong here. They are discovered by the subsystem
 * that needs them and reported as a status carrying a reason the UI can show —
 * see {@link ./speech/sttConfig.ts}, which is the reference implementation.
 */
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { CWD, IS_PROD } from "./config.ts";
import { PACKAGED_CONFIG_DIR } from "./runtimeAssets.ts";

/** One required tool, as committed in `config/host-tools.json`. */
export interface HostToolRequirement {
  binary: string;
  /** Dotted numeric floor, compared component-wise. */
  minVersion: string;
  /** Arguments that make the tool print its version. */
  versionArgs: string[];
  /** Why the server needs it, quoted verbatim in failure messages. */
  reason: string;
}

/** Outcome for one requirement. */
export interface HostToolCheck {
  requirement: HostToolRequirement;
  ok: boolean;
  /** Absolute path found on PATH, when it was found at all. */
  path?: string;
  /** Version parsed from the tool's own output, when it could be parsed. */
  version?: string;
  /** Present when `ok` is false: one sentence naming what is wrong. */
  problem?: string;
}

/** Table path: prefer the agent workspace's copy, else the one bundled with the build. */
function tablePath(): string {
  const fromEnv = process.env.ASSISTANT_HOST_TOOLS?.trim();
  if (fromEnv) return fromEnv;
  const cwdPath = join(CWD, "config", "host-tools.json");
  return existsSync(cwdPath)
    ? cwdPath
    : join(PACKAGED_CONFIG_DIR, "host-tools.json");
}

let tableCache: HostToolRequirement[] | undefined;

/** Parsed requirements, or an empty list when the file is missing/unreadable. */
export function hostToolRequirements(): HostToolRequirement[] {
  if (tableCache) return tableCache;
  try {
    const parsed = JSON.parse(readFileSync(tablePath(), "utf8")) as {
      required?: unknown;
    };
    const rows = Array.isArray(parsed.required) ? parsed.required : [];
    tableCache = rows.filter(isRequirement);
  } catch {
    tableCache = [];
  }
  return tableCache;
}

/** Test seam: drop the memoized table so a changed file/env is picked up. */
export function resetHostToolsCache(): void {
  tableCache = undefined;
}

function isRequirement(value: unknown): value is HostToolRequirement {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.binary === "string" &&
    row.binary.length > 0 &&
    typeof row.minVersion === "string" &&
    row.minVersion.length > 0 &&
    typeof row.reason === "string" &&
    Array.isArray(row.versionArgs) &&
    row.versionArgs.every((arg) => typeof arg === "string")
  );
}

/** A directory's canonical path; its absolute form when it does not exist. */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * First RUNNABLE match for `binary` on PATH, so "absent" and "too old" stay
 * distinguishable. Existence is not enough: a directory or a non-executable file
 * of the same name would otherwise be reported as "produced no version output",
 * which sends an operator looking in the wrong place. The result is absolute: a
 * relative PATH entry resolves against this process's working directory, so the
 * path stays valid wherever it is used from. PATH entries that are `excludeDir`
 * or an alias of it are skipped.
 */
export function findOnPath(
  binary: string,
  excludeDir?: string,
): string | undefined {
  const excluded =
    excludeDir === undefined ? undefined : canonicalDir(excludeDir);
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const dir = resolve(entry);
    if (excluded !== undefined && canonicalDir(dir) === excluded) continue;
    const candidate = join(dir, binary);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * First dotted-numeric run in the tool's own output, e.g. `5.3.15` out of
 * "GNU bash, version 5.3.15(1)-release". Tools differ wildly in phrasing but
 * agree on printing the number first.
 */
export function parseVersion(output: string): string | undefined {
  return /\d+(?:\.\d+)*/.exec(output)?.[0];
}

/** Negative when `a` is older than `b`; missing components count as zero. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Run one requirement's check. Never throws: a failure is a result, not an error. */
export function checkHostTool(requirement: HostToolRequirement): HostToolCheck {
  const path = findOnPath(requirement.binary);
  if (!path) {
    return {
      requirement,
      ok: false,
      problem: `not found on PATH`,
    };
  }
  // spawnSync, not execFileSync: version flags go to stdout for some tools and
  // stderr for others (`ssh -V`), and only spawnSync hands back BOTH streams
  // whatever the exit status — several tools print a version and then exit
  // non-zero. A tool that hangs must not hang the boot, hence the timeout.
  const run = spawnSync(path, requirement.versionArgs, {
    encoding: "utf8",
    timeout: 5000,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (!output.trim()) {
    return {
      requirement,
      ok: false,
      path,
      problem: `found at ${path} but ${requirement.binary} ${requirement.versionArgs.join(" ")} produced no version output`,
    };
  }
  const version = parseVersion(output);
  if (!version) {
    return {
      requirement,
      ok: false,
      path,
      problem: `found at ${path} but its version output could not be parsed`,
    };
  }
  if (compareVersions(version, requirement.minVersion) < 0) {
    return {
      requirement,
      ok: false,
      path,
      version,
      problem: `version ${version} is older than the required ${requirement.minVersion}`,
    };
  }
  return { requirement, ok: true, path, version };
}

/** Every requirement's outcome, in table order. */
export function checkHostTools(): HostToolCheck[] {
  return hostToolRequirements().map(checkHostTool);
}

/**
 * Refuse to serve when a required tool is missing or too old, naming every
 * failure at once — an operator fixing a host should not have to rediscover them
 * one boot at a time.
 *
 * FATAL in production only. The table describes the deploy target
 * (`x86_64-linux`), and the probes are GNU-shaped: on macOS `env` has no
 * `--version` and prints a usage line, while the system `bash` is 3.2. Throwing
 * there would make a developer's `pnpm dev` unbootable over a contract that does
 * not apply to their machine, so outside production this warns and continues —
 * the tools are still discovered per use, and a genuinely missing one surfaces
 * where it is used.
 */
export function verifyRequiredHostTools(opts?: { fatal?: boolean }): void {
  // Explicit rather than reading IS_PROD inside the branch: NODE_ENV is
  // inherited by agent sessions from the production service, so a test that
  // depended on it would pass in a developer shell and fail under an agent.
  const fatal = opts?.fatal ?? IS_PROD;
  const report = hostToolFailureReport();
  if (!report) return;
  if (!fatal) {
    console.warn(`[host-tools] ${report}`);
    return;
  }
  throw new Error(report);
}

/**
 * The operator-facing message for every failing requirement, or `undefined` when
 * the host satisfies the table. Separate from {@link verifyRequiredHostTools} so
 * the message is testable without depending on `NODE_ENV`, which decides only
 * whether it is fatal.
 */
export function hostToolFailureReport(): string | undefined {
  const failures = checkHostTools().filter((check) => !check.ok);
  if (failures.length === 0) return undefined;
  const lines = failures.map(
    (check) =>
      `  - ${check.requirement.binary}: ${check.problem}. Needed for: ${check.requirement.reason}`,
  );
  return (
    `Required host tools are missing or too old:\n${lines.join("\n")}\n` +
    `Install them on the service PATH; the contract is config/host-tools.json.`
  );
}
