/**
 * The handoff a switched session still owes its new engine
 * (`docs/session-runtime-switching.md` "Handoff"): the switch note and a
 * budgeted selection of the app log, carried as model-only context
 * (`RuntimePromptOptions.contextBlock`) on each new turn until the new engine
 * has replied once. The log keeps the clean user text.
 *
 * Owed while the active binding is not the session's first and the log holds
 * no assistant entry after the binding's `started_seq`, so a turn that failed
 * before any reply carries it again.
 */
import { ACCOUNT_KINDS } from "@assistant/shared";
import { credentialProfileById } from "./credentialProfiles.ts";
import type { SessionEngineBinding } from "./db/sessionEngineBinding.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { pickerModels } from "./harnesses/models.ts";
import { logPathFor } from "./session/log/persistence.ts";
import {
  handoffTokenCap,
  readHandoffRecords,
  renderSwitchContext,
  selectHandoff,
  type HandoffRecord,
} from "./sessionHandoff.ts";
import { getSettings } from "./settings.ts";

/**
 * Sessions whose active binding already replied, by that binding's seq: the
 * question is settled for good once it holds, so later turns skip the log scan.
 */
const answered = new Map<string, number>();

function readRecords(sessionId: string, afterSeq: number): HandoffRecord[] {
  try {
    return readHandoffRecords(logPathFor(sessionId), afterSeq);
  } catch {
    // No log yet: nothing to carry.
    return [];
  }
}

function modelFor(binding: SessionEngineBinding) {
  return pickerModels().find(
    (option) =>
      option.provider === binding.provider && option.id === binding.model,
  );
}

/**
 * The earlier binding whose native session the active one resumed, if any.
 * Claude resumes by native id; every pi binding uses the app id, so an
 * earlier pi binding means pi reopened its own transcript.
 */
function resumedFrom(
  all: readonly SessionEngineBinding[],
  active: SessionEngineBinding,
): SessionEngineBinding | undefined {
  return all
    .filter(
      (binding) =>
        binding.seq < active.seq &&
        binding.harness === active.harness &&
        active.nativeSessionId !== undefined &&
        binding.nativeSessionId === active.nativeSessionId,
    )
    .at(-1);
}

/**
 * The context the next turn owes the session's new engine, or undefined when
 * it owes none. Synchronous: the caller runs it after admission, with nothing
 * awaited before the append.
 */
export function owedSwitchContext(sessionId: string): string | undefined {
  const active = sessionStore.activeBinding(sessionId);
  if (!active || active.seq <= 1 || answered.get(sessionId) === active.seq)
    return undefined;
  const sinceSwitch = readRecords(sessionId, active.startedSeq);
  if (sinceSwitch.some((record) => record.role === "assistant")) {
    answered.set(sessionId, active.seq);
    return undefined;
  }
  const all = sessionStore.bindings(sessionId);
  const previous = all.find((binding) => binding.seq === active.seq - 1);
  const resumed = resumedFrom(all, active);
  // A return carries only what the resumed native session missed: everything
  // after the binding that followed its last use began.
  const afterSeq = resumed
    ? (all.find((binding) => binding.seq === resumed.seq + 1)?.startedSeq ?? 0)
    : 0;
  const target = modelFor(active);
  const cap = handoffTokenCap({
    setting: getSettings().sessionSwitching.handoffTokenCap,
    contextWindow: target?.contextWindow,
    // What a resumed native session already holds is not tracked per binding;
    // the window reserve covers it.
    usedTokens: 0,
  });
  const fromProfile = previous?.credentialProfileId
    ? credentialProfileById(previous.credentialProfileId)
    : undefined;
  const toProfile = active.credentialProfileId
    ? credentialProfileById(active.credentialProfileId)
    : undefined;
  return renderSwitchContext({
    sessionId,
    from: {
      model: (previous && modelFor(previous)?.name) ?? previous?.model ?? "",
      where: fromProfile ? ACCOUNT_KINDS[fromProfile.provider].label : "",
    },
    to: {
      model: target?.name ?? active.model ?? "",
      where: toProfile?.name ?? "",
    },
    resumed: resumed !== undefined,
    selection: selectHandoff(readRecords(sessionId, afterSeq), cap),
  });
}
