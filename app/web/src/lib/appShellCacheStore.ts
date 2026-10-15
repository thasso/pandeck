import { persistentStore } from "./persistentStore.ts";
import type { KeyValueStorage } from "./localStore.ts";

/**
 * Storage layout of the app shell cache (`hooks/useAssistant.ts` owns its
 * shape and validation): one `persistentStore` entry per SLICE, each rewritten
 * only when its serialized value changed.
 *
 * One entry for the whole record made every save a full rewrite (~1.3 MB
 * against production data): the Task list re-sent because one worktree status
 * moved. Splitting the record bounds a write to the slices that actually moved.
 *
 * Fields that must stay consistent with each other share a slice (a list and
 * its revision sidecar). `meta` carries `savedAt`, so it changes on every save;
 * it is written LAST and removed on a failed save, so a reader never assembles
 * a record from a half-written set.
 */

const KEY_PREFIX = "assistant.appShellCache.v2.";

const SLICES = {
  config: [
    "models",
    "agents",
    "settings",
    "slashCommands",
    "credentialProfileProjection",
  ],
  sessions: ["sessions"],
  tasks: ["taskList", "taskRevisions"],
  projects: ["projectList", "projectRevisions"],
  worktrees: ["worktrees"],
  worktreeStatuses: ["worktreeStatuses"],
  meta: [
    "version",
    "savedAt",
    "archivedSessionCount",
    "archivedSessionsLoaded",
  ],
} as const satisfies Record<string, readonly string[]>;

type SliceName = keyof typeof SLICES;
/** `meta` last: it is the commit marker for the slices before it. */
const SLICE_NAMES = Object.keys(SLICES) as SliceName[];

const sliceKey = (slice: SliceName) => `${KEY_PREFIX}${slice}`;

/** The record as last saved, or null when nothing (complete) is stored. */
export function readAppShellCacheRecord(
  storage: KeyValueStorage = persistentStore(),
): Record<string, unknown> | null {
  if (storage.getItem(sliceKey("meta")) === null) return null;
  const record: Record<string, unknown> = {};
  for (const slice of SLICE_NAMES) {
    const raw = storage.getItem(sliceKey(slice));
    if (raw === null) continue;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") Object.assign(record, parsed);
  }
  return record;
}

/**
 * Save `record`, rewriting only the slices whose serialization changed. Throws
 * what the storage throws (quota); the caller owns best-effort handling.
 */
export function writeAppShellCacheRecord(
  record: Record<string, unknown>,
  storage: KeyValueStorage = persistentStore(),
): void {
  try {
    for (const slice of SLICE_NAMES) {
      const value: Record<string, unknown> = {};
      for (const field of SLICES[slice]) value[field] = record[field];
      const serialized = JSON.stringify(value);
      const key = sliceKey(slice);
      if (storage.getItem(key) !== serialized) storage.setItem(key, serialized);
    }
  } catch (error) {
    storage.removeItem(sliceKey("meta"));
    throw error;
  }
}
