import { statSync } from "node:fs";
import type { ProfileSettings } from "@assistant/shared";
import { isValidIanaTimeZone } from "@assistant/shared";
import { APP_SETTINGS_PATH, readStoredAppSettings } from "./appSettingsFile.ts";

/** The persisted half of {@link ProfileSettings}; the effective zone is derived. */
export type StoredProfileSettings = Omit<ProfileSettings, "effectiveTimeZone">;

/** The server host's IANA zone, or "UTC" when the host reports none usable. */
export function hostTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidIanaTimeZone(zone) ? zone : "UTC";
}

/** Trimmed name, and a valid IANA zone or "" (follow the host). */
export function normalizeProfileSettings(
  stored: Partial<ProfileSettings> | undefined,
): StoredProfileSettings {
  const displayName =
    typeof stored?.displayName === "string" ? stored.displayName.trim() : "";
  const timeZone =
    typeof stored?.timeZone === "string" ? stored.timeZone.trim() : "";
  return {
    displayName,
    timeZone: isValidIanaTimeZone(timeZone) ? timeZone : "",
  };
}

/** The client projection: the stored profile plus the zone in effect. */
export function profileSettingsProjection(
  stored: Partial<ProfileSettings> | undefined,
): ProfileSettings {
  const profile = normalizeProfileSettings(stored);
  return {
    ...profile,
    effectiveTimeZone: profile.timeZone || hostTimeZone(),
  };
}

/**
 * The stored profile, parsed once per version of the settings file. Formatters
 * resolve the zone per item and per field, so a read per call would put
 * hundreds of synchronous file reads on the event loop for one listing. A
 * `stat` identity (inode + size + mtime) revalidates each use, which catches
 * an out-of-process edit; `updateSettings` writes via tmp+rename (a new inode)
 * and also drops the cache explicitly.
 */
let cachedProfile: { identity: string; profile: StoredProfileSettings } | null =
  null;

function settingsFileIdentity(): string {
  const stat = statSync(APP_SETTINGS_PATH, { throwIfNoEntry: false });
  return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "absent";
}

function storedProfile(): StoredProfileSettings {
  const identity = settingsFileIdentity();
  if (cachedProfile?.identity === identity) return cachedProfile.profile;
  const profile = normalizeProfileSettings(readStoredAppSettings().profile);
  cachedProfile = { identity, profile };
  return profile;
}

/** Drop the cached profile; the in-process settings write calls this. */
export function invalidateUserProfileCache(): void {
  cachedProfile = null;
}

/**
 * The ONE zone user-local days and times resolve in: the configured profile
 * zone, else the host's, else "UTC". Resolved at use time so a settings change
 * applies without a restart — never capture it in a module-level constant.
 */
export function userTimeZone(): string {
  return storedProfile().timeZone || hostTimeZone();
}

/** The user's configured display name, trimmed; "" when unset. */
export function userDisplayName(): string {
  return storedProfile().displayName;
}

/** The author name a NEW user comment carries: the display name, else "You". */
export function userAuthorName(): string {
  return userDisplayName() || "You";
}
