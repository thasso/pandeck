import type {
  ApprovalCard,
  AppSettings,
  SettingsInputApprovalBody,
} from "@assistant/shared";
import {
  settingDescriptor,
  valueAtPath,
  type SettingDescriptor,
} from "@assistant/shared/settingsRegistry";
import { deliverAgentHandoff } from "./agentHandoffs.ts";
import {
  credentialProfileSummaryById,
  subscribeCredentialProfileChanges,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import {
  approvalsForSession,
  pendingApprovalSessionIds,
  registerApprovalExecutor,
  resolveApproval,
} from "./pendingApprovals.ts";
import { redactSecrets } from "./secretRedaction.ts";
import { getSettings } from "./settings.ts";
import {
  onSettingsChanged,
  saveSettings,
  settingsPatchForWrites,
  TESTABLE_SETTINGS_SECTIONS,
  testSettingsSection,
} from "./settingsService.ts";

/**
 * Settings-input cards ([Task-729](pa://task/729)): the Personal Assistant
 * asks for a secret or an account connection it may not handle itself, and the
 * user answers in the card. Approval cards carry the durability, attention and
 * outcome handoff; this module owns what approving one means.
 *
 * A secret arrives only in the approving decision's edits. `prepare` checks it
 * and holds it in memory for the one resolution that follows, `execute` writes
 * it through `saveSettings`, and neither returns it: the stored card, the
 * outcome and the agent see only that it was saved and how the connection
 * test went. A connection card cannot be approved before the account is
 * connected; the OAuth callback's settings announcement approves it.
 */

/** Longer than any token an integration issues; a paste of something else. */
const MAX_SECRET_CHARS = 8_192;

/**
 * Secrets between `prepare` and `execute` of one resolution, by approval id.
 * `release` drops an entry however the resolution ends.
 */
const submitted = new Map<string, string>();

/** How many secrets wait between `prepare` and `execute`; for tests. */
export function heldSecretCountForTests(): number {
  return submitted.size;
}

/** How `saveSettings` reports a write that landed while a side effect failed. */
const SAVED_BUT = "Settings saved, but";

function details(body: SettingsInputApprovalBody): string {
  return `The Settings page shows its state: /settings/${body.section}.`;
}

function bodyOf(card: ApprovalCard): SettingsInputApprovalBody {
  if (card.body.kind !== "settingsInput")
    throw new Error("Mismatched approval body for settingsInput.");
  return card.body;
}

function descriptorOf(body: SettingsInputApprovalBody): SettingDescriptor {
  const descriptor = settingDescriptor(body.path);
  if (!descriptor?.configuredBy)
    throw new Error(`${body.path} is no longer a setting that can be entered.`);
  return descriptor;
}

/** Whether the secret is stored, or the account connected. */
export function settingIsSet(
  descriptor: SettingDescriptor,
  settings: AppSettings = getSettings(),
): boolean {
  return valueAtPath(settings, descriptor.configuredBy ?? "") === true;
}

async function testOutcome(body: SettingsInputApprovalBody): Promise<string> {
  if (!TESTABLE_SETTINGS_SECTIONS.includes(body.section)) return "";
  try {
    const test = await testSettingsSection(body.section);
    return test.ok
      ? ` The connection test passed: ${test.message}`
      : ` ${test.message}`;
  } catch (err) {
    return ` ${errorText(err)}`;
  }
}

/** Whether a sign-in card's account exists, is enabled and has credentials. */
function accountReady(body: SettingsInputApprovalBody): boolean {
  const account = body.account
    ? credentialProfileSummaryById(body.account.id)
    : undefined;
  return Boolean(account?.enabled && account.status === "ready");
}

registerApprovalExecutor("settingsInput", {
  async prepare(card, edits) {
    const body = bodyOf(card);
    if (body.mode === "signIn") {
      if (!body.account || !credentialProfileSummaryById(body.account.id))
        throw new Error(`${body.label} no longer exists.`);
      if (!accountReady(body))
        throw new Error(
          `${body.label} is not signed in yet. Sign in from the card; it updates by itself.`,
        );
      return body;
    }
    const descriptor = descriptorOf(body);
    if (body.mode === "connect") {
      if (!settingIsSet(descriptor))
        throw new Error(
          `${body.label} is not connected yet. Connect in the window the card opens; the card updates by itself.`,
        );
      return body;
    }
    const value = edits?.kind === "settingsInput" ? edits.value.trim() : "";
    if (!value) throw new Error("Type the value into the card, then save.");
    if (value.length > MAX_SECRET_CHARS)
      throw new Error(
        `That is longer than ${MAX_SECRET_CHARS} characters; check what was pasted.`,
      );
    submitted.set(card.id, value);
    return body;
  },

  async execute(card) {
    const body = bodyOf(card);
    if (body.mode === "signIn")
      return { resultSummary: `${body.label}: signed in.` };
    if (body.mode === "connect")
      return {
        resultSummary: `${body.label}: connected.${await testOutcome(body)}`,
      };
    const value = submitted.get(card.id);
    submitted.delete(card.id);
    if (!value)
      throw new Error(
        "The value did not reach the server's write. Nothing was saved; ask again.",
      );
    // What failed is told in the server's words: a writer's or a side
    // effect's message may carry the value in some encoding, and this text is
    // stored on the card and handed to the agent.
    try {
      await saveSettings(settingsPatchForWrites([{ path: body.path, value }]));
    } catch (err) {
      if (errorText(err).startsWith(SAVED_BUT))
        return {
          resultSummary: `${body.label} saved, but applying it did not complete everywhere. ${details(body)}`,
        };
      throw new Error(`Saving ${body.label} failed. ${details(body)}`);
    }
    return {
      resultSummary: `${body.label} saved.${await testOutcome(body)}`,
    };
  },

  release(card) {
    submitted.delete(card.id);
  },
});

/**
 * Approve every pending connection card a settings write has satisfied, and
 * hand the outcome to its session. Runs on every write; the OAuth callbacks
 * announce theirs (`announceSettingsWritten`).
 */
async function resolveConnectedCards(
  sections: readonly (keyof AppSettings)[],
): Promise<void> {
  const waiting: Array<{ card: ApprovalCard; descriptor: SettingDescriptor }> =
    [];
  for (const sessionId of pendingApprovalSessionIds())
    for (const card of approvalsForSession(sessionId)) {
      if (card.status !== "pending" || card.body.kind !== "settingsInput")
        continue;
      if (card.body.mode !== "connect") continue;
      const section = card.body.path.split(".")[0] as keyof AppSettings;
      const descriptor = settingDescriptor(card.body.path);
      if (descriptor && sections.includes(section))
        waiting.push({ card, descriptor });
    }
  // Read full settings only when some card waits on this write: every other
  // write would pay for, and could fail on, a read it does not need.
  if (waiting.length === 0) return;
  const settings = getSettings();
  for (const { card, descriptor } of waiting) {
    if (!settingIsSet(descriptor, settings)) continue;
    try {
      const { outcomePrompt } = await resolveApproval(card.id, "approved");
      if (outcomePrompt)
        await deliverAgentHandoff({
          sessionId: card.sessionId,
          text: outcomePrompt,
          origin: { kind: "system", source: "approval-decision" },
        });
    } catch (err) {
      console.warn(
        `[settings] connecting ${descriptor.path} did not resolve its card:`,
        redactSecrets(errorText(err)),
      );
    }
  }
}

/**
 * Approve every pending sign-in card for an account that is now ready, and
 * hand the outcome to its session.
 */
async function resolveSignedInCards(accountId: string): Promise<void> {
  for (const sessionId of pendingApprovalSessionIds())
    for (const card of approvalsForSession(sessionId)) {
      if (card.status !== "pending" || card.body.kind !== "settingsInput")
        continue;
      if (card.body.mode !== "signIn" || card.body.account?.id !== accountId)
        continue;
      if (!accountReady(card.body)) continue;
      try {
        const { outcomePrompt } = await resolveApproval(card.id, "approved");
        if (outcomePrompt)
          await deliverAgentHandoff({
            sessionId: card.sessionId,
            text: outcomePrompt,
            origin: { kind: "system", source: "approval-decision" },
          });
      } catch (err) {
        console.warn(
          `[settings] signing in ${accountId} did not resolve its card:`,
          redactSecrets(errorText(err)),
        );
      }
    }
}

subscribeCredentialProfileChanges((accountId) => {
  resolveSignedInCards(accountId).catch((err: unknown) =>
    console.warn(
      "[settings] could not check sign-in cards after an account change:",
      redactSecrets(errorText(err)),
    ),
  );
});

onSettingsChanged(({ sections }) => {
  resolveConnectedCards(sections).catch((err: unknown) =>
    console.warn(
      "[settings] could not check connection cards after a settings write:",
      redactSecrets(errorText(err)),
    ),
  );
});
