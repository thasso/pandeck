/**
 * Whether the Knowledge Base is on, and which folder it is
 * (`AppSettings.knowledgeBase`, docs/knowledge-base.md).
 *
 * Read on hot paths — every KB tool call, every Knowledge browser request,
 * every link resolution — so the stored section is parsed once per version of
 * the settings file, the way `userProfile.ts` caches the profile: a `stat`
 * identity (inode + size + mtime) revalidates each use, and the settings
 * write replaces the file (a new inode).
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { KnowledgeBaseSettings } from "@assistant/shared";
import { APP_SETTINGS_PATH, readStoredAppSettings } from "./appSettingsFile.ts";
import { DATA_DIR } from "./config.ts";
import { KB_REPO_DIR_NAME } from "./knowledgeBaseContract.ts";

/** The persisted half of {@link KnowledgeBaseSettings}; the folder in effect is derived. */
type StoredKnowledgeBaseSettings = Omit<KnowledgeBaseSettings, "effectivePath">;

/** On unless turned off; a trimmed folder, "" for the default. */
export function normalizeKnowledgeBaseSettings(
  stored: Partial<KnowledgeBaseSettings> | undefined,
): StoredKnowledgeBaseSettings {
  return {
    enabled: stored?.enabled !== false,
    path: typeof stored?.path === "string" ? stored.path.trim() : "",
  };
}

/** The absolute folder a configured path names. */
function knowledgeBaseFolder(path: string): string {
  if (!path) return join(DATA_DIR, KB_REPO_DIR_NAME);
  const expanded =
    path === "~" || path.startsWith("~/")
      ? join(homedir(), path.slice(1))
      : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(DATA_DIR, expanded);
}

/** The client projection: the stored section plus the folder in effect. */
export function knowledgeBaseSettingsProjection(
  stored: Partial<KnowledgeBaseSettings> | undefined,
): KnowledgeBaseSettings {
  const settings = normalizeKnowledgeBaseSettings(stored);
  return { ...settings, effectivePath: knowledgeBaseFolder(settings.path) };
}

interface ResolvedRoot {
  readonly path: string;
  readonly real?: string;
}

function observeRoot(path: string): ResolvedRoot {
  const normalized = resolve(path);
  try {
    return { path: normalized, real: realpathSync(normalized) };
  } catch {
    // A missing/inaccessible folder still has a lexical match.
    return { path: normalized };
  }
}

// History belongs here, shared by direct KB readers and the settings projection
// of an already-read file. Failed reads and cache invalidation cannot erase it.
const defaultRootPath = knowledgeBaseFolder("");
let defaultRoot = observeRoot(defaultRootPath);
let lastRoot: ResolvedRoot | undefined;
let placementWarned = false;
let cached: { identity: string; settings: KnowledgeBaseSettings } | null = null;

function remember(settings: KnowledgeBaseSettings) {
  const root = observeRoot(settings.effectivePath);
  // History may keep a known physical path when the same alias disappears.
  // The fresh root returned below still governs readable-settings placement.
  if (
    root.real === undefined &&
    lastRoot?.path === root.path &&
    lastRoot.real !== undefined
  )
    lastRoot = { path: root.path, real: lastRoot.real };
  else lastRoot = root;
  if (root.path === defaultRoot.path && root.real !== undefined)
    defaultRoot = root;
  placementWarned = false;
  return { settings, root };
}

/** Project a successfully read settings section and remember its KB root. */
export function knowledgeBaseSettingsFromStored(
  stored: Partial<KnowledgeBaseSettings> | undefined,
): KnowledgeBaseSettings {
  return remember(knowledgeBaseSettingsProjection(stored)).settings;
}

function current() {
  const stat = statSync(APP_SETTINGS_PATH, { throwIfNoEntry: false });
  const identity = stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "absent";
  if (cached?.identity === identity) return remember(cached.settings);
  const settings = knowledgeBaseSettingsProjection(
    readStoredAppSettings().knowledgeBase,
  );
  cached = { identity, settings };
  return remember(settings);
}

/**
 * Placement's only best-effort read: valid settings are authoritative. During
 * failure, retain the last successful root and the default, warning once until
 * any direct/settings read succeeds. Other KB readers keep their own errors.
 */
export function knowledgeBasePlacementRoots(): readonly ResolvedRoot[] {
  try {
    return [current().root];
  } catch {
    const observed = observeRoot(defaultRootPath);
    if (observed.real !== undefined) defaultRoot = observed;
    if (!placementWarned) {
      placementWarned = true;
      console.warn(
        "[workers] Knowledge Base settings unavailable; keeping known/default KB paths local and using the default Worker for other checkout git.",
      );
    }
    return lastRoot ? [lastRoot, defaultRoot] : [defaultRoot];
  }
}

/** Drop the cached section; the in-process settings write calls this. */
export function invalidateKnowledgeBaseSettingsCache(): void {
  cached = null;
}

/** Whether the app offers the Knowledge Base at all. */
export function knowledgeBaseEnabled(): boolean {
  return current().settings.enabled;
}

/** The Knowledge Base folder in effect. */
export function knowledgeBaseRoot(): string {
  return current().settings.effectivePath;
}
