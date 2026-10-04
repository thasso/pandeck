/**
 * App-level prompt facade for runtime-backed sessions.
 *
 * Application code should drive pi/Claude-SDK sessions through this module, not
 * through raw engine prompt methods or adapters. The facade ensures the session
 * is attached to the normalized runtime before prompting, so run-state and the
 * durable app-owned log are updated for viewed and background runs alike.
 */
import type {
  AgentType,
  ContextInfo,
  Harness,
  PromptAttachment,
  SessionMode,
} from "@assistant/shared";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";
import { sessionWorktreeMissing } from "../worktrees/sessionCwd.ts";
import type { PromptOrigin, SessionSnapshot } from "@assistant/shared/session";
import type { PromptableAdapter } from "./adapters/contract.ts";
import type { RuntimePromptOptions } from "./runtime/liveSession.ts";
import { SessionRuntime } from "./runtime/runtime.ts";
import { sessionRuntime } from "./runtimeInstance.ts";
import {
  commitMemoryDelivery,
  decideMemoryDeliveryForPrompt,
  recordMemoryDeliveryFailure,
} from "../memory/memoryRuntime.ts";
import { memoryScheduler } from "../memory/memoryScheduler.ts";
import { beginPromptRun } from "./sessionRunLease.ts";
import { planTurnHintFor } from "./planHint.ts";
import { sessionSkills } from "../sessionSkills.ts";

export interface RuntimePromptDriver {
  readonly id: string;
  readonly key: string;
  readonly sessionId: string;
  readonly harness: Harness;
  readonly agentType: AgentType;
  readonly sessionFile: string | undefined;
  readonly isRunning: boolean;
  readonly canSteer: boolean;
  /**
   * Build/Plan for the NEXT turn. Absent means the harness has no mode axis
   * yet, which behaves exactly as `build` (see `planHint.ts`).
   */
  readonly sessionMode?: SessionMode;
  /**
   * True once this instance was disposed — its store released it for being
   * idle, or it was removed (`HarnessDriver.released`, which every harness
   * answers). A released driver is refused before a runtime session is bound
   * to it or anything is appended; each caller surfaces or retries that
   * failure its own way (a peer send retries, a queued prompt holds its row
   * with the error), and a new send acquires the live session.
   */
  readonly released?: boolean;
  contextInfo(): ContextInfo;
  broadcastState(): void;
  createRuntimeAdapter(): PromptableAdapter;
}

export type RuntimePromptFacadeOptions = RuntimePromptOptions & {
  attachments?: PromptAttachment[];
};

/**
 * Notified when a session that was live only for RENDERING gets the harness
 * that will actually run it (`session/adapters/detached.ts`). Whoever opened
 * that harness is irrelevant — a reader's first prompt, a queued peer message,
 * a workflow step — so the signal is taken at the one place all of them pass:
 * the runtime attachment below. Connections showing the session listen so they
 * can re-attach their view to the real driver and stop reporting the
 * placeholder's `canSteer: false`.
 */
const harnessOpenedListeners = new Set<(sessionId: string) => void>();
export function subscribeHarnessOpened(
  listener: (sessionId: string) => void,
): () => void {
  harnessOpenedListeners.add(listener);
  return () => harnessOpenedListeners.delete(listener);
}

export function ensureRuntimeSessionWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
): ReturnType<SessionRuntime["createSession"]> {
  // Binding a released instance would leave the runtime session wrapping a
  // disposed harness, and every later prompt would reuse it.
  if (driver.released)
    throw new Error(
      `Session ${driver.id} was released from memory; send it again.`,
    );
  const existing = runtime.get(driver.id);
  if (!existing)
    return runtime.createSession(driver.id, driver.createRuntimeAdapter());
  // A session brought live for viewing has no harness behind it yet. This is
  // where it gets one: the detached adapter is swapped for the driver's own,
  // which is why a prompt through this facade works on a session the reader
  // merely opened.
  if (!existing.isDetached) return existing;
  existing.rebindAdapter(driver.createRuntimeAdapter());
  for (const listener of harnessOpenedListeners) {
    try {
      listener(driver.id);
    } catch {
      /* best-effort: one bad listener must not fail the prompt */
    }
  }
  return existing;
}

/**
 * Refuse to run a session whose `in_worktree` worktree is GONE and unacknowledged
 * ([Task-321](pa://task/321)).
 *
 * This lives at the run boundary rather than at the client entry points because
 * "resume" has many mouths: the web `prompt`/slash commands, queued peer
 * delivery and `session_send_prompt`, review handoffs into an existing session,
 * day activation and scans, the post-reload continuation, approval outcomes and
 * question answers. Any of them can revive a session whose checkout was cleaned
 * up under it, and `resolveSessionCwd` would then silently point the agent at
 * the app's OWN repository. One check before the runtime session is ensured and
 * before anything is appended, so no path can forget it.
 *
 * It THROWS: every caller here is a background or fire-and-forget driver that
 * already reports a failed send (the peer store retries then fails the message
 * permanently, the connection handlers surface `errorText`). `connection.ts`
 * additionally checks up front on the interactive paths, so the user gets the
 * refusal before any side effect rather than as a failed turn.
 */
function assertSessionWorktreePresent(sessionId: string): void {
  let missing = false;
  try {
    missing = sessionWorktreeMissing(sessionId);
  } catch (err) {
    // A store/filesystem failure must not block every prompt: fail OPEN, the
    // same way memory selection does, and let the cwd fallback stand.
    console.warn(
      "Failed to check session worktree before prompting:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  if (missing) throw new Error(WORKTREE_MISSING_BLOCKED_REASON);
}

export async function promptRuntimeSession(
  driver: RuntimePromptDriver,
  text: string,
  options: RuntimePromptFacadeOptions = {},
): Promise<void> {
  return promptRuntimeSessionWithRuntime(sessionRuntime, driver, text, options);
}

/**
 * Admit a provider-initiated turn that has no app prompt to append. It still
 * passes the same worktree, run-lease, skill and runtime attachment boundary as
 * prompted work. The returned release owns that boundary until the provider's
 * result arrives.
 */
export async function beginRuntimeProviderTurn(
  driver: RuntimePromptDriver,
  origin: PromptOrigin,
): Promise<() => void> {
  assertSessionWorktreePresent(driver.sessionId);
  const releaseRun = beginPromptRun(driver.sessionId);
  const releaseAdmission = sessionRuntime.admitPrompt(driver.sessionId);
  try {
    await sessionSkills(driver.sessionId, driver.agentType);
    const live = ensureRuntimeSessionWithRuntime(sessionRuntime, driver);
    // The provider supplied no user message. Stamp its provenance on the next
    // durable assistant entry instead of fabricating a user row.
    const clearOrigin = live.markNextAssistantOrigin(origin);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      clearOrigin();
      releaseAdmission();
      releaseRun();
    };
  } catch (error) {
    releaseAdmission();
    releaseRun();
    throw error;
  }
}

export async function promptRuntimeSessionWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
  text: string,
  options: RuntimePromptFacadeOptions = {},
): Promise<void> {
  // BEFORE the runtime session is ensured and before any append: a refused turn
  // must leave no trace of itself in the session.
  assertSessionWorktreePresent(driver.sessionId);
  // A session whose WORKTREE is being removed right now must not start a run —
  // and a run that starts here must block that removal until it is done. The
  // session's worktree is resolved HERE, at admission, so a session linked to a
  // held worktree after the hold was taken is covered too. The check and the
  // hold are synchronous, so the two decisions cannot interleave; sampling "is
  // it running" from the removal side never could (see `sessionRunLease.ts`).
  // This is the ONE place every prompt path goes through, which is why the
  // lease lives here and not at each caller.
  const releaseRun = beginPromptRun(driver.sessionId);
  // Until the run settles, no idle release may take this session's harness.
  const releaseAdmission = runtime.admitPrompt(driver.sessionId);
  try {
    // The lifecycle backstop for every prompt mouth. Creation paths freeze
    // eagerly where they know a session is new; this covers reopen/resume and
    // the first post-upgrade start of a legacy coding session. It happens before
    // the runtime session exists or any user entry can be appended.
    await sessionSkills(driver.sessionId, driver.agentType);
    return await runPromptWithRuntime(runtime, driver, text, options);
  } finally {
    releaseAdmission();
    releaseRun();
  }
}

/**
 * Supplies background-work facts that were recorded while the session was NOT
 * running and that did not warrant a turn of their own (`deliveryPolicy.ts`).
 * A seam rather than an import so the session layer keeps knowing nothing about
 * the background-work service; `index.ts` registers the real provider at boot.
 */
let deferredBackgroundContext:
  | ((sessionId: string) => { block: string; commit: () => void } | undefined)
  | undefined;
export function setDeferredBackgroundContextProvider(
  fn:
    | ((sessionId: string) => { block: string; commit: () => void } | undefined)
    | undefined,
): void {
  deferredBackgroundContext = fn;
}

/**
 * Fold any deferred background-work context into the model-only block of a turn
 * that is happening anyway.
 *
 * This is the cheap half of background delivery: the fact costs no turn of its
 * own, and the session learns it before it acts again. It rides AFTER whatever
 * context the caller supplied and before the Plan hint, and — like both — never
 * reaches the durable log, so the visible transcript still shows only what the
 * user wrote.
 *
 * EVERY prompt that reaches the model carries it, hidden and steering ones
 * included. An earlier revision excluded those as "not turns the agent reasons
 * in", which is wrong: `connection.ts` resumes approval decisions, pull-request
 * outcomes and answered questions as hidden prompts — real turns where the agent
 * acts — and each becomes a steer when the session is already running. Skipping
 * them let a session act without a fact that had been deferred precisely so it
 * would arrive before the next action.
 *
 * Consuming the block takes BOTH halves of "the model got it": a durable entry
 * was appended, and the prompt then resolved. `onUserEntry` alone fires before
 * the adapter is called, so a provider that refuses would consume a fact it
 * never saw; resolution alone is satisfied by a deduplicated prompt, which
 * returns successfully having sent nothing.
 */
function withDeferredBackgroundContext(
  driver: RuntimePromptDriver,
  options: RuntimePromptFacadeOptions,
): { options: RuntimePromptFacadeOptions; commitIfDelivered: () => void } {
  const pending = deferredBackgroundContext?.(driver.sessionId);
  if (!pending) return { options, commitIfDelivered: () => {} };
  const contextBlock = options.contextBlock
    ? `${options.contextBlock}\n\n${pending.block}`
    : pending.block;
  let appended = false;
  return {
    options: {
      ...options,
      contextBlock,
      onUserEntry: (entryId) => {
        appended = true;
        options.onUserEntry?.(entryId);
      },
    },
    commitIfDelivered: () => {
      if (appended) pending.commit();
    },
  };
}

/**
 * Prepend the turn's Plan-mode block (if any) to the model-only context block,
 * keeping any structured context the caller already supplied. The commit rides
 * `onUserEntry`, so only an ACCEPTED turn advances the Plan bookkeeping.
 */
function withPlanTurnHint(
  driver: RuntimePromptDriver,
  options: RuntimePromptFacadeOptions,
): RuntimePromptFacadeOptions {
  const hint = planTurnHintFor(driver);
  if (!hint) return options;
  const contextBlock = options.contextBlock
    ? `${options.contextBlock}\n\n${hint.block}`
    : hint.block;
  return {
    ...options,
    contextBlock,
    onUserEntry: (entryId) => {
      hint.commit();
      options.onUserEntry?.(entryId);
    },
  };
}

async function runPromptWithRuntime(
  runtime: SessionRuntime,
  driver: RuntimePromptDriver,
  text: string,
  rawOptions: RuntimePromptFacadeOptions,
): Promise<void> {
  ensureRuntimeSessionWithRuntime(runtime, driver);

  // Plan mode (Task 330) rides EVERY turn — hidden, steering and agent-origin
  // ones included, since they all reach the model — on the model-only context
  // seam, so it stays out of the durable log and the client projection. It is
  // applied before the memory branch below so both paths carry it.
  const deferred = withDeferredBackgroundContext(driver, rawOptions);
  const options = withPlanTurnHint(driver, deferred.options);

  // A deferred background fact is consumed only once the prompt carrying it was
  // appended AND resolved. Every return path below goes through `runPrompt`, so
  // a refusal, a duplicate or a throw leaves the fact queued for the next turn.
  const runPrompt = async (
    prompt: RuntimePromptFacadeOptions,
  ): Promise<void> => {
    await runtime.prompt(driver.id, text, prompt);
    deferred.commitIfDelivered();
  };

  // Memory enrichment (Task 96): only top-level human turns are eligible. Hidden
  // resume/system prompts AND mid-turn steering follow-ups carry no memory snapshot
  // and record no effective load. Selection/delivery failures fail OPEN — the turn
  // proceeds with no memory and the delivered-fingerprint is not advanced.
  const eligible =
    !options.hidden &&
    !options.steer &&
    (options.origin?.kind ?? "human") === "human";
  if (!eligible) {
    return runPrompt(options);
  }

  let decision: ReturnType<typeof decideMemoryDeliveryForPrompt> | undefined;
  let selectionFailed = false;
  try {
    decision = decideMemoryDeliveryForPrompt(driver, text);
  } catch {
    decision = undefined;
    selectionFailed = true;
  }

  let capturedTurnId: string | undefined;
  // Capture the source timestamp at APPEND time (when the durable user entry is
  // created), not after a potentially long model turn.
  let capturedAtMs: number | undefined;
  const enriched: RuntimePromptFacadeOptions = {
    ...options,
    ...(decision?.memoryBlock ? { memoryBlock: decision.memoryBlock } : {}),
    onUserEntry: (entryId) => {
      capturedTurnId = entryId;
      capturedAtMs = Date.now();
      options.onUserEntry?.(entryId);
    },
  };

  await runPrompt(enriched);

  // Nothing accepted (e.g. a duplicate clientRequestId returned before appending):
  // record neither an effective load nor an observation.
  if (!capturedTurnId) return;

  // Commit the effective-load audit + advance the snapshot only when a delivery
  // decision was computed; a SELECTION failure must not also disable learning.
  if (decision) {
    try {
      commitMemoryDelivery(driver, capturedTurnId, decision);
    } catch {
      // The decision was computed but persisting it failed: still record an
      // explicit failure batch so the inspector doesn't show a stale prior turn.
      recordMemoryDeliveryFailure(driver, capturedTurnId);
    }
  } else if (selectionFailed) {
    // Selection itself threw: record an explicit failure batch for this turn.
    recordMemoryDeliveryFailure(driver, capturedTurnId);
  }

  // Capture the completed clean assistant response (text blocks only — tool
  // call/result bodies are separate entries and excluded) for observation context.
  let assistantText: string | undefined;
  try {
    const snapshot = runtime.get(driver.id)?.getSnapshot();
    if (snapshot)
      assistantText = assistantTextAfter(snapshot.entries, capturedTurnId);
  } catch {
    assistantText = undefined;
  }

  // Post-turn observation (Task 99) runs INDEPENDENTLY of memory selection, shares
  // the same accepted user-turn id, uses the clean human text (never the model-only
  // snapshot), and stamps the append-time source timestamp.
  memoryScheduler.observeTurn({
    sessionId: driver.sessionId,
    userTurnId: capturedTurnId,
    persona: driver.agentType,
    humanText: text,
    ...(assistantText ? { assistantText } : {}),
    ...(capturedAtMs !== undefined ? { sourceTimestampMs: capturedAtMs } : {}),
  });
}

/**
 * Concatenate the clean text of assistant entries that follow the accepted user
 * turn `afterId`, stopping at the next user turn. Only `text` blocks are included
 * — tool-call/result bodies (separate entries) are never captured. `maxChars`
 * caps the result (memory observation uses a small cap; capture callers pass a
 * larger one).
 */
function assistantTextAfter(
  entries: SessionSnapshot["entries"],
  afterId: string,
  maxChars = 4_000,
): string | undefined {
  const start = entries.findIndex((e) => e.id === afterId);
  if (start < 0) return undefined;
  const parts: string[] = [];
  for (let i = start + 1; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.role === "user") break;
    if (entry.role !== "assistant") continue;
    for (const block of entry.content) {
      if (block.type === "text" && block.text.trim())
        parts.push(block.text.trim());
    }
  }
  const text = parts.join("\n").trim();
  return text ? text.slice(0, maxChars) : undefined;
}

/**
 * Drive one prompt turn on a session AND return the clean assistant text it
 * produced (Task 162: the day scan's visible synthesis turn — the session's
 * Markdown briefing becomes the durable day report). Layers over
 * `promptRuntimeSession`, capturing the accepted user-turn id via `onUserEntry`
 * and reading the completed snapshot; returns undefined if nothing was produced.
 */
export async function promptRuntimeSessionAndCaptureText(
  driver: RuntimePromptDriver,
  text: string,
  options: RuntimePromptFacadeOptions = {},
  maxChars = 20_000,
): Promise<string | undefined> {
  let capturedTurnId: string | undefined;
  await promptRuntimeSession(driver, text, {
    ...options,
    onUserEntry: (entryId) => {
      capturedTurnId = entryId;
      options.onUserEntry?.(entryId);
    },
  });
  if (!capturedTurnId) return undefined;
  try {
    const snapshot = sessionRuntime.get(driver.id)?.getSnapshot();
    return snapshot
      ? assistantTextAfter(snapshot.entries, capturedTurnId, maxChars)
      : undefined;
  } catch {
    return undefined;
  }
}
