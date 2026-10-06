/**
 * The single inventory of configured model slots in {@link AppSettings}, and
 * the one place that decides which provider account such a slot runs on.
 *
 * A slot is any settings field pair `{ provider, modelId }` naming a model for
 * an agent PA runs on the user's behalf (helper one-shots, the permanent
 * assistant…). Each may pin a `credentialProfileId`;
 * unset means automatic — the first enabled account of that model's provider.
 *
 * Deliberately pure: every function takes the settings object, so `settings.ts`
 * can import the write-time sanitizer without an import cycle.
 */
import {
  accountProviderForModelProvider,
  type AppSettings,
  type CredentialProfilePin,
  type CredentialProfileSlotUsage,
} from "@assistant/shared";
import {
  automaticProfileIdFor,
  credentialProfileById,
} from "./credentialProfiles.ts";

/** The model reference carried by every slot. */
export type SettingsModelSlot = CredentialProfilePin & {
  provider: string;
  modelId: string;
};

/** One enumerated slot: where it lives, what to call it, and its current value. */
export interface SettingsModelSlotRef extends CredentialProfileSlotUsage {
  slot: SettingsModelSlot;
}

/** Every model slot in the current settings, in Settings display order. */
export function listSettingsModelSlots(
  settings: AppSettings,
): SettingsModelSlotRef[] {
  const refs: SettingsModelSlotRef[] = [
    {
      key: "permanentAssistant",
      label: "Personal Assistant",
      section: "personal-assistant",
      slot: settings.permanentAssistant,
    },
    {
      key: "memory.processor",
      label: "Memory processor",
      section: "memory",
      slot: settings.memory.processor,
    },
    {
      key: "sessionNaming",
      label: "Session naming",
      section: "naming",
      slot: settings.sessionNaming,
    },
    {
      key: "promptRefinement",
      label: "Prompt refinement",
      section: "refinement",
      slot: settings.promptRefinement,
    },
    {
      key: "worktrees.namingAgent",
      label: "Worktree naming agent",
      section: "worktrees",
      slot: settings.worktrees.namingAgent,
    },
    {
      key: "worktrees.mergeAgent",
      label: "Merge conflict agent",
      section: "worktrees",
      slot: settings.worktrees.mergeAgent,
    },
    {
      key: "commitAgent",
      label: "Commit agent",
      section: "commit",
      slot: settings.commitAgent,
    },
    {
      key: "prAgent",
      label: "Pull request agent",
      section: "pull-request",
      slot: settings.prAgent,
    },
    {
      key: "taskIntakeAgent",
      label: "Task intake agent",
      section: "task-intake",
      slot: settings.taskIntakeAgent,
    },
    {
      key: "meetingMinutesScanner",
      label: "Minutes scanner",
      section: "minutes-scanner",
      slot: settings.meetingMinutesScanner,
    },
    {
      key: "calendarDaySession",
      label: "Calendar day session",
      section: "minutes-scanner",
      slot: settings.calendarDaySession,
    },
    {
      key: "pdfConversion",
      label: "PDF conversion fallback",
      section: "pdf-conversion",
      slot: settings.pdfConversion,
    },
  ];
  return refs;
}

/** Why a pinned account could not be used. */
type SlotAccountDegradation = "missing" | "disabled" | "provider-mismatch";

export interface SlotAccountResolution {
  /** The account the slot actually runs on. */
  profileId: string;
  /** Set when a pin existed but could not be honored; the resolution fell back to automatic. */
  degraded?: SlotAccountDegradation;
  /** The pin that was not honored, for diagnostics. */
  pinnedProfileId?: string;
}

/**
 * The account a slot runs on. An unusable pin falls back to another enabled
 * account of the same provider. If none exists, the run fails explicitly
 * instead of using a hidden local CLI credential.
 */
export function resolveSlotAccount(
  slot: SettingsModelSlot,
): SlotAccountResolution {
  const wanted = accountProviderForModelProvider(slot.provider);
  const automatic = () => automaticProfileIdFor(wanted);
  const pinned = slot.credentialProfileId?.trim();
  if (!pinned) return { profileId: automatic() };
  const profile = credentialProfileById(pinned);
  const degraded: SlotAccountDegradation | undefined = !profile
    ? "missing"
    : profile.provider !== wanted
      ? "provider-mismatch"
      : !profile.enabled
        ? "disabled"
        : undefined;
  return degraded
    ? { profileId: automatic(), degraded, pinnedProfileId: pinned }
    : { profileId: pinned };
}

/** Convenience for the many call sites that only need the id. */
export function accountForSlot(slot: SettingsModelSlot): string {
  return resolveSlotAccount(slot).profileId;
}

/** Slots explicitly pinned to one account (regardless of whether the pin is currently honorable). */
export function pinnedSlotsForProfile(
  settings: AppSettings,
  profileId: string,
): CredentialProfileSlotUsage[] {
  return listSettingsModelSlots(settings)
    .filter((ref) => ref.slot.credentialProfileId === profileId)
    .map(({ key, label, section }) => ({ key, label, section }));
}

/**
 * Drop pins that name an unknown account or an account of the wrong provider,
 * so nothing invalid is ever persisted. A pin to a currently DISABLED account
 * is kept: disabling is reversible and the resolver degrades it meanwhile.
 */
function sanitizeSlotPin<
  T extends CredentialProfilePin & { provider?: string },
>(value: T): T {
  const pinned = value.credentialProfileId?.trim();
  if (!pinned) {
    if (value.credentialProfileId === undefined) return value;
    const { credentialProfileId: _dropped, ...rest } = value;
    return rest as T;
  }
  const profile = credentialProfileById(pinned);
  const provider = typeof value.provider === "string" ? value.provider : "";
  if (
    profile &&
    profile.provider === accountProviderForModelProvider(provider)
  ) {
    return { ...value, credentialProfileId: pinned };
  }
  const { credentialProfileId: _dropped, ...rest } = value;
  return rest as T;
}

/**
 * Apply {@link sanitizeSlotPin} to every slot in a settings tree. Runs on WRITE
 * only (the registry read is too costly for every `getSettings()` and a pin can
 * become stale later anyway — {@link resolveSlotAccount} owns that case).
 */
export function sanitizeSlotPinsDeep<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item) => sanitizeSlotPinsDeep(item)) as unknown as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record))
    out[key] = sanitizeSlotPinsDeep(item);
  return (
    typeof record.provider === "string" && "credentialProfileId" in record
      ? sanitizeSlotPin(out as CredentialProfilePin & { provider?: string })
      : out
  ) as T;
}

/**
 * Recursively strip every pin naming `profileId`, used when an account is
 * deleted. Returns the rewritten value; slot identity/labels are reported
 * separately by {@link pinnedSlotsForProfile} before the rewrite.
 */
export function stripProfilePins<T>(value: T, profileId: string): T {
  if (Array.isArray(value))
    return value.map((item) =>
      stripProfilePins(item, profileId),
    ) as unknown as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "credentialProfileId" && item === profileId) continue;
    out[key] = stripProfilePins(item, profileId);
  }
  return out as T;
}
