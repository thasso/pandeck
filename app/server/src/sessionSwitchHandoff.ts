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
import { statSync } from "node:fs";
import { ACCOUNT_KINDS, type Harness } from "@assistant/shared";
import { credentialProfileById } from "./credentialProfiles.ts";
import type { SessionEngineBinding } from "./db/sessionEngineBinding.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { pickerModels, storedBindingModelOption } from "./harnesses/models.ts";
import { logPathFor } from "./session/log/persistence.ts";
import { estimateTokens } from "./session/runtime/liveBlocks.ts";
import {
  handoffTokenCap,
  readHandoffRecords,
  renderSwitchContext,
  selectHandoff,
  type HandoffRecord,
} from "./sessionHandoff.ts";
import { getSettings } from "./settings.ts";
import { lastReportedContextTokens } from "./tools/sessions/sessionInspection.ts";

/**
 * Sessions whose active binding already replied, by that binding's seq: the
 * question is settled for good once it holds, so later turns skip the log scan.
 */
const answered = new Map<string, number>();

/** The log's handoff records from `fromSeq` on, seq 0 included. */
function readRecords(sessionId: string, fromSeq: number): HandoffRecord[] {
  try {
    return readHandoffRecords(logPathFor(sessionId), fromSeq - 1);
  } catch {
    // No log yet: nothing to carry.
    return [];
  }
}

/**
 * The model option an end of a switch names: the pickers' entry, else (a
 * Claude model no enabled account lists right now) its curated option.
 */
function modelFor(end: SwitchEnd) {
  return (
    pickerModels().find(
      (option) => option.provider === end.provider && option.id === end.model,
    ) ?? storedBindingModelOption(end)
  );
}

/**
 * What a resumed native session already holds: the context size it last
 * reported, from the newest binding along its resume chain that reported one.
 * Unknown (it never replied): every record it could hold, estimated, which can
 * only overstate it (a compacted session holds less).
 */
function resumedContextTokens(
  sessionId: string,
  all: readonly SessionEngineBinding[],
  resumed: SessionEngineBinding,
  beforeSeq: number,
): number {
  const logPath = logPathFor(sessionId);
  for (
    let binding: SessionEngineBinding | undefined = resumed;
    binding;
    binding =
      binding.resumedSeq !== undefined
        ? all.find((other) => other.seq === binding?.resumedSeq)
        : undefined
  ) {
    const next = all.find((other) => other.seq === binding!.seq + 1);
    try {
      const reported = lastReportedContextTokens(
        logPath,
        binding.startedSeq,
        next?.startedSeq ?? beforeSeq,
      );
      if (reported !== undefined) return reported;
    } catch {
      break;
    }
  }
  return readRecords(sessionId, 0)
    .filter((record) => record.seq < beforeSeq)
    .reduce((sum, record) => sum + estimateTokens(record.text), 0);
}

/** The engine a switch leaves or joins, as the handoff names and sizes it. */
interface SwitchEnd {
  harness?: Harness | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  credentialProfileId?: string | undefined;
}

/**
 * The switch context for a move from `from` to `to`: the note and the budgeted
 * log selection. `resumed` is the earlier binding whose native session `to`
 * continues (a return), `bindings` the session's bindings up to and including
 * the one the switch leaves (and the one it starts, once committed). Answers undefined when the resumed native session
 * is the one the switch leaves (pi's account-kind change): it missed nothing.
 */
function switchContext(input: {
  sessionId: string;
  bindings: readonly SessionEngineBinding[];
  left: SessionEngineBinding | undefined;
  from: SwitchEnd;
  to: SwitchEnd;
  resumed: SessionEngineBinding | undefined;
}): string | undefined {
  const { sessionId, bindings, left, from, to, resumed } = input;
  if (resumed && left && resumed.seq === left.seq) return undefined;
  // A return carries only what the resumed native session missed: everything
  // from the start of the binding that followed its last use.
  const fromSeq = resumed
    ? (bindings.find((binding) => binding.seq === resumed.seq + 1)
        ?.startedSeq ?? 0)
    : 0;
  const target = modelFor(to);
  const cap = handoffTokenCap({
    setting: getSettings().sessionSwitching.handoffTokenCap,
    contextWindow: target?.contextWindow,
    usedTokens: resumed
      ? resumedContextTokens(sessionId, bindings, resumed, fromSeq)
      : 0,
  });
  const fromProfile = from.credentialProfileId
    ? credentialProfileById(from.credentialProfileId)
    : undefined;
  const toProfile = to.credentialProfileId
    ? credentialProfileById(to.credentialProfileId)
    : undefined;
  return renderSwitchContext({
    sessionId,
    from: {
      model: modelFor(from)?.name ?? from.model ?? "",
      where: fromProfile ? ACCOUNT_KINDS[fromProfile.provider].label : "",
    },
    to: {
      model: target?.name ?? to.model ?? "",
      where: toProfile?.name ?? "",
    },
    resumed: resumed !== undefined,
    selection: selectHandoff(readRecords(sessionId, fromSeq), cap),
  });
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
  // Only a native session the switch's open actually reopened (the commit
  // records it): a pi return whose transcript was gone shares the native id
  // but starts over, and gets the whole log.
  const resumed =
    active.resumedSeq !== undefined
      ? all.find((binding) => binding.seq === active.resumedSeq)
      : undefined;
  const context = switchContext({
    sessionId,
    bindings: all,
    left: previous,
    from: previous ?? {},
    to: active,
    resumed,
  });
  if (!context) answered.set(sessionId, active.seq);
  return context;
}

/**
 * The tokens the switch to `target` would hand over if it applied now, by the
 * same note, selection and budget the first turn after it carries
 * ({@link owedSwitchContext}): the inspector's "Hands over ~Nk tokens" (Q29).
 * `resumed` is the earlier binding whose native session the switch would
 * reopen. 0 when nothing is handed over (pi's account-kind change continues
 * the native session it leaves).
 */
export function estimateSwitchHandoffTokens(
  sessionId: string,
  target: SwitchEnd,
  resumed: SessionEngineBinding | undefined,
): number {
  const active = sessionStore.activeBinding(sessionId);
  const bindings = sessionStore.bindings(sessionId);
  const key = estimateKey(sessionId, bindings, target, resumed);
  const cached = estimates.get(sessionId);
  if (key !== undefined && cached?.key === key) return cached.tokens;
  const context = switchContext({
    sessionId,
    bindings,
    left: active,
    from: active ?? {},
    to: target,
    resumed,
  });
  const tokens = context ? estimateTokens(context) : 0;
  if (key === undefined) estimates.delete(sessionId);
  else estimates.set(sessionId, { key, tokens });
  return tokens;
}

/**
 * The last estimate per session and what it measured. Asking again while
 * nothing it reads changed answers it without reading the log again: every
 * viewer asks, and a long log takes a noticeable synchronous scan.
 */
const estimates = new Map<string, { key: string; tokens: number }>();

/**
 * Everything {@link switchContext} reads for an estimate: the bindings, the
 * target and the binding it resumes, the cap setting, the models' and
 * accounts' names and windows, and the log's extent (an append grows it, a
 * rewrite moves its time). Undefined when the log cannot be measured, so
 * nothing is cached.
 */
function estimateKey(
  sessionId: string,
  bindings: readonly SessionEngineBinding[],
  target: SwitchEnd,
  resumed: SessionEngineBinding | undefined,
): string | undefined {
  let log: { size: number; mtimeMs: number };
  try {
    log = statSync(logPathFor(sessionId));
  } catch {
    return undefined;
  }
  const active = sessionStore.activeBinding(sessionId);
  const profile = (id: string | undefined) => {
    const found = id ? credentialProfileById(id) : undefined;
    return found ? [found.id, found.name, found.provider] : null;
  };
  const targetModel = modelFor(target);
  return JSON.stringify([
    log.size,
    log.mtimeMs,
    bindings.map((binding) => [
      binding.seq,
      binding.startedSeq,
      binding.resumedSeq ?? null,
      binding.credentialProfileId ?? null,
    ]),
    active?.seq ?? null,
    target,
    resumed?.seq ?? null,
    getSettings().sessionSwitching.handoffTokenCap,
    targetModel?.contextWindow ?? null,
    targetModel?.name ?? null,
    active ? (modelFor(active)?.name ?? null) : null,
    profile(active?.credentialProfileId),
    profile(target.credentialProfileId),
  ]);
}
