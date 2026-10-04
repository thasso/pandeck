import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
