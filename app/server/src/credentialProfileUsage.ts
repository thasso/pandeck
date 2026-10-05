/**
 * What depends on one provider account, so disabling or deleting it is an
 * informed decision rather than a guess.
 *
 * Separate from `credentialProfiles.ts` on purpose: this reads settings, and
 * `settings.ts` already depends on the slot registry, which depends on the
 * profile registry. Keeping the projection here keeps that chain acyclic.
 */
import type {
  CredentialProfileSlotUsage,
  CredentialProfileSummary,
  CredentialProfileUsage,
} from "@assistant/shared";
import {
  automaticProfileIdFor,
  credentialProfileSummaryById,
  listCredentialProfiles,
} from "./credentialProfiles.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { getSettings } from "./settings.ts";
import { saveSettings } from "./settingsService.ts";
import {
  pinnedSlotsForProfile,
  stripProfilePins,
} from "./settingsModelSlots.ts";

/** Sessions durably bound to this account (they keep running even when it is disabled). */
function boundSessionCount(profileId: string): number {
  // Every scope, deliberately: this number explains why deleting the account is
  // refused, and `deleteCredentialProfile` counts a binding of ANY scope. A
  // default-scoped read here would report 0 bound sessions for an account the
  // deletion guard then refuses to release.
  return sessionStore
    .list({ scopes: "all" })
    .filter((session) => session.credentialProfileId === profileId).length;
}

export function credentialProfileUsage(
  profile: Pick<CredentialProfileSummary, "id" | "provider">,
): CredentialProfileUsage {
  const settings = getSettings();
  const automaticId = automaticProfileIdFor(profile.provider);
  const usage: CredentialProfileUsage = {
    pinnedSlots: pinnedSlotsForProfile(settings, profile.id),
    boundSessionCount: boundSessionCount(profile.id),
  };
  if (automaticId !== profile.id) return usage;
  // This account currently takes all unpinned work; report where that moves.
  const fallbackId = automaticProfileIdFor(profile.provider, profile.id);
  const fallback =
    fallbackId === profile.id
      ? undefined
      : credentialProfileSummaryById(fallbackId);
  return {
    ...usage,
    automaticForProvider: profile.provider,
    ...(fallback
      ? { automaticFallback: { id: fallback.id, name: fallback.name } }
      : {}),
  };
}

/** The account list with usage attached, for the Settings account pages. */
export function listCredentialProfilesWithUsage(): CredentialProfileSummary[] {
  return listCredentialProfiles().map((profile) => ({
    ...profile,
    usage: credentialProfileUsage(profile),
  }));
}

/**
 * Drop every settings pin naming a deleted account, returning the slots that
 * were unpinned so the caller can report them. Pins never block deletion: they
 * fall back to automatic anyway, and refusing would make an account
 * undeletable until every slot had been repointed by hand.
 */
export async function clearProfilePins(
  profileId: string,
): Promise<CredentialProfileSlotUsage[]> {
  const settings = getSettings();
  const cleared = pinnedSlotsForProfile(settings, profileId);
  if (cleared.length === 0) return [];
  // Only the sections that actually carry a pin are rewritten; each is passed
  // through the ordinary settings write path so normalization still applies
  // and open Settings pages see the change.
  await saveSettings(
    stripProfilePins(
      {
        permanentAssistant: settings.permanentAssistant,
        sessionNaming: settings.sessionNaming,
        commitAgent: settings.commitAgent,
        prAgent: settings.prAgent,
        meetingMinutesScanner: settings.meetingMinutesScanner,
        pdfConversion: settings.pdfConversion,
        calendarDaySession: settings.calendarDaySession,
        promptRefinement: settings.promptRefinement,
        taskIntakeAgent: settings.taskIntakeAgent,
        worktrees: settings.worktrees,
        memory: settings.memory,
      },
      profileId,
    ),
  );
  return cleared;
}
