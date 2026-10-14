/**
 * The single inventory of configured model slots in {@link AppSettings}, and
 * the one place that decides which provider account such a slot runs on.
 *
 * A slot is any settings field pair `{ provider, modelId }` naming a model for
 * an agent PA runs on the user's behalf (helper one-shots, the permanent
 * assistant…). Each may pin a `credentialProfileId`;
 * unset means automatic, selected by the account router on each run.
 *
 * The write-time sanitizers remain synchronous. Runtime resolution loads the
 * router lazily so settings.ts can import them without an import cycle.
 */
import {
  accountProviderForModelProvider,
  type AppSettings,
  type CredentialProfilePin,
  type CredentialProfileSlotUsage,
  type ThinkingLevel,
} from "@assistant/shared";
import { credentialProfileById } from "./credentialProfiles.ts";

/** The model reference carried by every slot. */
export type SettingsModelSlot = CredentialProfilePin & {
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  requiresEnterprise?: boolean;
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
      key: "sessionStatus",
      label: "Session status",
      section: "session-status",
      slot: settings.sessionStatus,
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
      key: "pdfConversion",
      label: "PDF conversion fallback",
      section: "pdf-conversion",
      slot: settings.pdfConversion,
    },
  ];
  return refs;
}

/** A transcript helper cannot run without an eligible enterprise account. */
export class EnterpriseAccountRequiredError extends Error {
  constructor(
    message = "This helper requires an eligible enterprise account.",
  ) {
    super(message);
    this.name = "EnterpriseAccountRequiredError";
  }
}

/** Why a pinned account could not be used. */
type SlotAccountDegradation = "missing" | "disabled" | "provider-mismatch";

export interface SlotAccountResolution {
  /** The account the slot actually runs on. */
  profileId: string;
  /** Why a pin or the router's preferred eligibility could not be honored. */
  degraded?: string;
  /** The pin that was not honored, for diagnostics. */
  pinnedProfileId?: string;
}

/**
 * The account a slot runs on. A missing, disabled or provider-mismatched pin
 * falls back to Automatic. Refuses when no account can be picked, or when an
 * enterprise requirement would need a personal or degraded account.
 */
export async function resolveSlotAccount(
  slot: SettingsModelSlot,
): Promise<SlotAccountResolution> {
  const wanted = accountProviderForModelProvider(slot.provider);
  const pinned = slot.credentialProfileId?.trim();
  let degraded: SlotAccountDegradation | undefined;
  if (pinned) {
    const profile = credentialProfileById(pinned);
    if (slot.requiresEnterprise && profile && !profile.enterprise)
      throw new EnterpriseAccountRequiredError(
        "This helper requires an enterprise account, but its explicit account pin is personal.",
      );
    degraded = !profile
      ? "missing"
      : profile.provider !== wanted
        ? "provider-mismatch"
        : !profile.enabled
          ? "disabled"
          : undefined;
    // Health, model, effort and usage eligibility apply only to Automatic.
    // An enabled matching pin must fail/alert on that account, not spend another.
    if (!degraded) return { profileId: pinned };
  }
  const { pickAccount } = await import("./accountRouter.ts");
  const picked = await pickAccount({
    model: { provider: slot.provider, modelId: slot.modelId },
    ...(slot.thinkingLevel !== undefined
      ? { thinkingLevel: slot.thinkingLevel }
      : {}),
    requiresEnterprise: slot.requiresEnterprise === true,
    allowDisabledDefault: slot.requiresEnterprise !== true,
  });
  if (slot.requiresEnterprise && (!picked.profileId || picked.degraded))
    throw new EnterpriseAccountRequiredError();
  if (!picked.profileId)
    throw new Error("No account is available for this background model.");
  return {
    profileId: picked.profileId,
    ...(degraded && pinned
      ? { degraded, pinnedProfileId: pinned }
      : picked.degraded
        ? { degraded: picked.degraded }
        : {}),
  };
}

/** Convenience for background session creation that only needs the id. */
export async function accountForSlot(slot: SettingsModelSlot): Promise<string> {
  return (await resolveSlotAccount(slot)).profileId;
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
