/**
 * Rule P over the persisted settings (`docs/account-routing.md`): a compatible
 * model is served by exactly one account, whose id is its provider, so every
 * stored account pin on such a model names that account. Model slots and
 * approved peer runtimes are normalized at every boot and on every write;
 * an unpinned (Automatic) entry stays unpinned.
 *
 * A leaf over `appSettingsFile.ts`, so the boot pass in `piSdk/models.ts` runs
 * before `settings.ts` loads, without an import cycle.
 */
import { isDeepStrictEqual } from "node:util";
import { accountPinForModel } from "@assistant/shared";
import {
  readStoredAppSettings,
  writeStoredAppSettings,
} from "./appSettingsFile.ts";

/**
 * Apply rule P to every pinned `{ provider, credentialProfileId }` under
 * `value`, wherever it sits; everything else is carried through unchanged.
 */
export function applyAccountPinRuleDeep<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item) => applyAccountPinRuleDeep(item)) as unknown as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] = applyAccountPinRuleDeep(item);
  const pin = out.credentialProfileId;
  if (typeof out.provider === "string" && typeof pin === "string" && pin.trim())
    out.credentialProfileId = accountPinForModel(out.provider, pin);
  return out as T;
}

/**
 * The boot pass: rewrite the stored settings only when a pin changed. It is
 * idempotent and independent of the endpoint migration's outcome, so a crash
 * anywhere is repaired by the next boot. A failure is logged and never blocks
 * boot.
 */
export function normalizeCompatibleSettingsPins(): void {
  try {
    const stored = readStoredAppSettings();
    const normalized = applyAccountPinRuleDeep(stored);
    if (!isDeepStrictEqual(stored, normalized))
      writeStoredAppSettings(normalized);
  } catch (err) {
    console.warn(
      "[settings] OpenAI-compatible account pins were not normalized:",
      err instanceof Error ? err.message : err,
    );
  }
}
