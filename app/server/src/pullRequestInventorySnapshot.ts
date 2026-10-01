/**
 * Restart-surviving cache for the provider-backed Pull Requests inventory.
 *
 * This is derived provider state, not durable user-authored data, so it follows
 * the versioned cache-file convention used by `usageCache.ts`: memory serves
 * reads, a private tmp+rename file seeds the next process, and corrupt or old
 * data is a cold cache rather than a startup failure.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  PullRequestInventoryItem,
  PullRequestInventoryResponse,
} from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { errorText } from "./errors.ts";

const CACHE_PATH = join(DATA_DIR, "cache", "pull-requests", "inventory.json");
const CACHE_VERSION = 1;

interface PullRequestProjectSnapshot {
  fetchedAt: number;
  items: PullRequestInventoryItem[];
}

export interface PullRequestInventorySnapshot {
  version: 1;
  /** Completion time of the newest build, including one with no projects. */
  builtAt: number;
  projects: Record<string, PullRequestProjectSnapshot>;
}

let memory: PullRequestInventorySnapshot | null | undefined;

/** Read from memory after one tolerant disk load. */
export function readPullRequestInventorySnapshot(): PullRequestInventorySnapshot | null {
  if (memory !== undefined) return memory;
  if (!existsSync(CACHE_PATH)) return (memory = null);
  try {
    const parsed = JSON.parse(
      readFileSync(CACHE_PATH, "utf8"),
    ) as PullRequestInventorySnapshot;
    if (
      parsed?.version !== CACHE_VERSION ||
      !Number.isFinite(parsed.builtAt) ||
      !parsed.projects ||
      typeof parsed.projects !== "object" ||
      Array.isArray(parsed.projects)
    )
      return (memory = null);
    for (const project of Object.values(parsed.projects)) {
      if (
        !project ||
        !Number.isFinite(project.fetchedAt) ||
        !Array.isArray(project.items)
      )
        return (memory = null);
    }
    return (memory = parsed);
  } catch {
    return (memory = null);
  }
}

/** Replace memory immediately and persist the same versioned value best-effort. */
export function writePullRequestInventorySnapshot(
  snapshot: PullRequestInventorySnapshot,
): void {
  memory = snapshot;
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
    const tmp = `${CACHE_PATH}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.warn(
      "[pull-requests] failed to persist inventory snapshot:",
      errorText(err),
    );
  }
}

/** Flatten the per-project cache while retaining the oldest source timestamp. */
export function pullRequestInventoryResponse(
  snapshot: PullRequestInventorySnapshot,
): PullRequestInventoryResponse {
  const projects = Object.values(snapshot.projects);
  return {
    status: "ready",
    items: projects.flatMap((project) => project.items),
    fetchedAt:
      projects.length > 0
        ? Math.min(...projects.map((project) => project.fetchedAt))
        : snapshot.builtAt,
  };
}

/** Test seam: forget memory and remove the disposable cache file. */
export function resetPullRequestInventorySnapshotForTests(): void {
  memory = undefined;
  rmSync(CACHE_PATH, { force: true });
  rmSync(`${CACHE_PATH}.tmp`, { force: true });
}

/** Test seam: forget only memory so the next read exercises restart loading. */
export function unloadPullRequestInventorySnapshotForTests(): void {
  memory = undefined;
}

/** Test seam for corrupt/version-mismatch fixtures. */
export function pullRequestInventorySnapshotPathForTests(): string {
  return CACHE_PATH;
}
