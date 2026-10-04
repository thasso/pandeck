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
import { errorText } from "./errors.ts";
import {
  approvalsForSession,
  pendingApprovalSessionIds,
  registerApprovalExecutor,
  resolveApproval,
} from "./pendingApprovals.ts";
import { redactSecretsWith } from "./secretRedaction.ts";
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

/** Secrets between `prepare` and `execute` of one resolution, by approval id. */
const submitted = new Map<string, string>();

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

registerApprovalExecutor("settingsInput", {
  async prepare(card, edits) {
    const body = bodyOf(card);
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
    try {
      await saveSettings(settingsPatchForWrites([{ path: body.path, value }]));
    } catch (err) {
      throw new Error(
        `Saving ${body.label} failed: ${redactSecretsWith(errorText(err), [value])}`,
      );
    }
    return {
      resultSummary: `${body.label} saved.${await testOutcome(body)}`,
    };
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
  const settings = getSettings();
  for (const sessionId of pendingApprovalSessionIds()) {
    for (const card of approvalsForSession(sessionId)) {
      if (card.status !== "pending" || card.body.kind !== "settingsInput")
        continue;
      const body = card.body;
      if (body.mode !== "connect") continue;
      const section = body.path.split(".")[0] as keyof AppSettings;
      if (!sections.includes(section)) continue;
      const descriptor = settingDescriptor(body.path);
      if (!descriptor || !settingIsSet(descriptor, settings)) continue;
      try {
        const { outcomePrompt } = await resolveApproval(card.id, "approved");
        if (outcomePrompt)
          await deliverAgentHandoff({
            sessionId,
            text: outcomePrompt,
            origin: { kind: "system", source: "approval-decision" },
          });
      } catch (err) {
        console.warn(
          `[settings] connecting ${body.path} did not resolve its card:`,
          errorText(err),
        );
      }
    }
  }
}

onSettingsChanged(({ sections }) => {
  void resolveConnectedCards(sections);
});
