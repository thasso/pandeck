/**
 * The memory settings automatic memory obeys (`docs/agent-memory.md`): the
 * stored ones, except while first run is `pending`. A fresh install has not
 * been asked about memory yet, so until setup begins nothing is loaded,
 * captured, processed or maintained, whatever the settings file says
 * (`docs/onboarding.md`). That covers the moment before the persisted opt-out
 * lands, and every turn a `pending` install runs, whatever its persona.
 */
import type { MemorySettings } from "@assistant/shared";
import { FIRST_RUN_MEMORY, onboardingState } from "../onboarding.ts";
import { getSettings } from "../settings.ts";

export function memorySettingsInEffect(): MemorySettings {
  const settings = getSettings().memory;
  return onboardingState() === "pending"
    ? { ...settings, ...FIRST_RUN_MEMORY }
    : settings;
}
