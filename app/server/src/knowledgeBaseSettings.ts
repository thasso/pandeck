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
import { statSync } from "node:fs";
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

let cached: { identity: string; settings: KnowledgeBaseSettings } | null = null;

function current(): KnowledgeBaseSettings {
  const stat = statSync(APP_SETTINGS_PATH, { throwIfNoEntry: false });
  const identity = stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "absent";
  if (cached?.identity === identity) return cached.settings;
  const settings = knowledgeBaseSettingsProjection(
    readStoredAppSettings().knowledgeBase,
  );
  cached = { identity, settings };
  return settings;
}

/** Drop the cached section; the in-process settings write calls this. */
export function invalidateKnowledgeBaseSettingsCache(): void {
  cached = null;
}

/** Whether the app offers the Knowledge Base at all. */
export function knowledgeBaseEnabled(): boolean {
  return current().enabled;
}

/** The Knowledge Base folder in effect. */
export function knowledgeBaseRoot(): string {
  return current().effectivePath;
}
