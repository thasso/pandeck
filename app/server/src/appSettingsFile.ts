import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AppSettings } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";
import { fileReadErrorText } from "./errors.ts";

/**
 * User-editable settings are live runtime state, so they live under `DATA_DIR`
 * (alongside the integration secrets) and are never committed. `config/app.json`
 * holds only bootstrap config (`dataDir`); the shipped defaults are the
 * `DEFAULT_*` constants in `settings.ts`. The file is the settings object
 * itself — any missing section falls back to its default in `getSettings`.
 *
 * A leaf module so the few readers that sit BELOW `settings.ts` in the import
 * graph (`userProfile.ts`) can read the file without an import cycle.
 */
export const APP_SETTINGS_PATH = join(DATA_DIR, "settings", "app.json");

/** Read the persisted settings; empty object if the file is absent. */
export function readStoredAppSettings(): Partial<AppSettings> {
  if (!existsSync(APP_SETTINGS_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(APP_SETTINGS_PATH, "utf8"),
    ) as Partial<AppSettings>;
    return parsed ?? {};
  } catch (err) {
    throw new Error(
      `Failed to read app settings at ${APP_SETTINGS_PATH}: ${fileReadErrorText(err)}`,
    );
  }
}

/**
 * Replace the persisted settings with `settings` as given. Written to a
 * sibling temp file then renamed, so a crash mid-write can't leave a truncated
 * file behind. The settings dir may not exist yet on first save.
 */
export function writeStoredAppSettings(settings: unknown): void {
  mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
  const tmp = `${APP_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, APP_SETTINGS_PATH);
}
