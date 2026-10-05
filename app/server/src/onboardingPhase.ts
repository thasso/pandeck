import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";

export const ONBOARDING_COMPLETION_FILE = join(DATA_DIR, "onboarding-complete");

/** The provider is connected, but the focused first-run conversation is ongoing. */
export function guidedSetupInProgress(): boolean {
  return (
    existsSync(ONBOARDING_COMPLETION_FILE) &&
    readFileSync(ONBOARDING_COMPLETION_FILE, "utf8") === "complete\n"
  );
}
