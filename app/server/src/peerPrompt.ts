/**
 * Peer-prompt engine (Task 90): the one server-owned path for sending a prompt
 * from one app session to another. It resolves the target, decides the
 * server-owned conversation/chain (with automatic reply correlation), persists
 * through {@link peerPromptStore}, and delivers a concise, token-efficient
 * envelope to the recipient runtime with agent provenance.
 *
 * Delivery here is non-interrupting but intentionally minimal; Task 88 hardens
 * the queue/drain/recovery semantics, Task 105 adds the loop guard, and Task 89
 * adds lifecycle projections and the history view.
 */
import { drainPromptQueue, promptQueueHasPriority } from "./promptQueue.ts";
import { existsSync, readFileSync } from "node:fs";
import type {
  PeerPromptCard,
  PromptAttachment,
  PeerPromptState,
  PeerPromptThread,
  PeerPromptThreadMessage,
  PeerPromptThreadsProjection,
} from "@assistant/shared";
import { peerPromptExcerpt } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import {
  peerPromptStore,
  PeerPromptHopLimitError,
  type PeerPromptRecord,
  type PeerPromptRecoveryDecision,
  type PeerPromptStatus,
} from "./db/peerPromptStore.ts";
import { getSettings } from "./settings.ts";
import { sessionFirstTurnContext } from "./sessionContext.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import type { SessionLogEntry } from "./session/log/rawEntry.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import { readTask } from "./tasks.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import {
  resumableState,
  runtimeStateFor,
} from "./tools/sessions/sessionInspection.ts";

export const MAX_PEER_PROMPT_CHARS = 8_000;
export const BATCH_MAX_MESSAGES = 5;
const BATCH_MAX_CHARS = 16_000;
/** Non-message overhead budget for the delivered envelope. */
export const ENVELOPE_OVERHEAD_MAX = 300;
const SENDER_TITLE_MAX = 80;
/** How much of an interrupted prompt an interruption notice quotes back. */
const NOTICE_PROMPT_EXCERPT_MAX = 120;
/** How much of a provider failure reason an interruption notice quotes. */
const NOTICE_ERROR_MAX = 1_200;
const LEASE_MS = 60_000;
/** Unresolved reply expectations expire after 30 days. */
const RESPONSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Completed/expired conversation detail is pruned after 90 days. */
const PRUNE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounds on the durable per-session history projection. */
const HISTORY_MAX_MESSAGES = 50;
/** Hard ceiling for an explicit history-expansion request. */
export const HISTORY_EXPANSION_MAX_MESSAGES = 200;
/** Bounded exponential backoff for retryable_failed rows. */
const RETRY_BASE_BACKOFF_MS = 5_000;
const RETRY_MAX_BACKOFF_MS = 5 * 60_000;
/** After this many attempts, give up permanently (`failed`) instead of retrying. */
export const RETRY_MAX_ATTEMPTS = 6;
/** How often the boot-independent retry sweep runs. */
export const RETRY_SWEEP_INTERVAL_MS = 15_000;
/** Non-identifying placeholder agentId for ordinary PromptOrigin projection; the real sender identity stays server-side (peerPromptStore) and in the sanitized card's senderTitle. */
const PEER_ORIGIN_AGENT_ID = "peer-prompt";

/**
 * While a delivered peer turn is running for a recipient, this binds the
 * server-owned context so a reply from that recipient back to the sender
 * correlates automatically without any id crossing the model boundary.
 */
interface ActiveDeliveryContext {
  senderSessionId: string;
  conversationId: string;
  chainId: string;
  /** The response-requested message a reply should mark replied, if any. */
  primaryRequestMessageId?: string;
}
const activeContexts = new Map<string, ActiveDeliveryContext>();

/**
 * When false, `sendPeerPrompt` persists + returns without scheduling delivery.
 * Tests set this so they can assert persistence/correlation without driving a
 * real recipient runtime. Production keeps it true.
 */
let autoDeliver = true;
export function setPeerPromptAutoDeliverForTests(enabled: boolean): void {
  autoDeliver = enabled;
}

/**
 * The narrow hub surface this engine needs. Resolved through one seam
 * (rather than three separate `await import("./hub.ts")` call sites) so tests
 * can substitute a fake hub deterministically via {@link setHubForTests}
 * instead of relying on module-mocking a process-wide singleton.
 */
export interface PeerPromptHub {
  getLiveById(id: string): RuntimePromptDriver | undefined;
  acquireById(id: string): Promise<RuntimePromptDriver | undefined>;
  /** Rebuild the session list; optional so a test hub need not stub it. */
  broadcastSessions?(): Promise<void> | void;
  broadcastPeerPromptCardUpdate(
    sessionId: string,
    update: {
      messageKey: string;
      state: PeerPromptState;
      failureReason?: string;
    },
  ): void;
}

let hubOverride: PeerPromptHub | undefined;
/** Test-only seam: substitute the hub this engine talks to. Pass undefined to restore the real one. */
export function setHubForTests(hub: PeerPromptHub | undefined): void {
  hubOverride = hub;
}

async function getHub(): Promise<PeerPromptHub> {
  if (hubOverride) return hubOverride;
  const mod = await import("./hub.ts");
  return mod.hub as unknown as PeerPromptHub;
}

export interface SendPeerPromptInput {
  senderSessionId: string;
  senderTitle?: string;
  targetSessionId: string;
  prompt: string;
  responseRequested: boolean;
  taskId?: string;
}

export interface SendPeerPromptResult {
  message: PeerPromptRecord;
  card: PeerPromptCard;
}

/* ------------------------------- send ------------------------------------ */

export async function sendPeerPrompt(
  input: SendPeerPromptInput,
): Promise<SendPeerPromptResult> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("prompt is required.");
  if (prompt.length > MAX_PEER_PROMPT_CHARS) {
    throw new Error(
      `prompt exceeds the ${MAX_PEER_PROMPT_CHARS}-character limit (${prompt.length}). Shorten it and resend.`,
    );
  }
  if (input.targetSessionId === input.senderSessionId)
    throw new Error("Cannot send a peer prompt to the current session.");

  const target = await resolvePromptableTarget(input.targetSessionId);
  const taskLabel = resolveTaskLabel(input.taskId);

  // Routing chooses the conversation/chain (reads only). The closed-chain
  // re-check, hop reservation, the loop-guard limit check, participant
  // accumulation, the message insert, and the reply-mark all happen in ONE
  // store transaction so a rejected over-limit send neither persists a message
  // nor consumes a hop, and a concurrent human-reset close can't be raced.
  const routing = resolveConversation(input.senderSessionId, target.id);
  let message: PeerPromptRecord;
  try {
    message = peerPromptStore.enqueueRouted({
      conversationId: routing.conversationId,
      chainId: routing.chainId,
      ...(routing.fallbackChainId
        ? { fallbackChainId: routing.fallbackChainId }
        : {}),
      senderSessionId: input.senderSessionId,
      recipientSessionId: target.id,
      participants: [input.senderSessionId, target.id],
      maxHops: getSettings().sessionPeerPromptMaxHops,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      prompt,
      responseRequested: input.responseRequested,
      ...(input.senderTitle ? { senderLabel: input.senderTitle } : {}),
      ...(taskLabel ? { taskLabel } : {}),
      ...(routing.replyToMessageId
        ? { replyToMessageId: routing.replyToMessageId }
        : {}),
      ...(routing.markRepliedId
        ? { markRepliedId: routing.markRepliedId }
        : {}),
      ...(input.responseRequested
        ? { expiresAt: Date.now() + RESPONSE_TTL_MS }
        : {}),
    });
  } catch (err) {
    if (err instanceof PeerPromptHopLimitError) {
      throw new Error(
        `This agent-to-agent conversation reached its ${err.maxHops}-hop limit without a human in the loop. Wait for a human prompt or involve the user before sending again.`,
      );
    }
    throw err;
  }

  const card = cardFor(message, "sent", target.title);
  void broadcastParticipants([message]);
  void broadcastCardUpdateFor(message);
  // enqueueRouted marks the original request replied atomically, but that
  // original row's own card (a different messageKey, possibly rendered in the
  // sender's OR recipient's session) never gets its own update unless we
  // explicitly re-fetch and broadcast it here.
  if (routing.markRepliedId) {
    const original = peerPromptStore.getById(routing.markRepliedId);
    if (original) void broadcastCardUpdateFor(original);
  }
  // Fire-and-forget delivery; the send call never blocks on the recipient turn.
  if (autoDeliver) void drainRecipient(target.id).catch(() => {});
  return { message, card };
}

export interface CancelQueuedPeerPromptsInput {
  recipientSessionId: string;
  /** Omit only when a coordinator is clearing its still-owned child's queue. */
  senderSessionId?: string;
  reason: string;
}

/**
 * Cancel durable prompts that have not started dispatching, then update both
 * participants' session state and cards. The store owns the atomic status
 * transition; this layer owns the same projections as every other lifecycle
 * change.
 */
export function cancelQueuedPeerPrompts(
  input: CancelQueuedPeerPromptsInput,
): PeerPromptRecord[] {
  const cancelled = peerPromptStore.cancelPending(
    input.recipientSessionId,
    input.reason,
    input.senderSessionId,
  );
  if (cancelled.length === 0) return [];
  void broadcastParticipants(cancelled);
  for (const message of cancelled) void broadcastCardUpdateFor(message);
  return cancelled;
}

/* --------------------------- target resolution --------------------------- */

interface PromptableTarget {
  id: string;
  title: string;
}

/**
 * Reject a target we already know cannot receive a message: deleted/internal/
 * archived by index flags, or evicted with no resumable pi/Claude state (so a
 * message would queue forever with no path to delivery). A live session or one
 * with resumable on-disk state is accepted; transient acquire/resume failures at
 * DELIVERY time are handled separately by the retry path.
 */
async function resolvePromptableTarget(
  targetSessionId: string,
): Promise<PromptableTarget> {
  const meta = sessionStore.getIncludingDeleted(targetSessionId);
  if (!meta) throw new Error(`No session found with id ${targetSessionId}.`);
  if (meta.deletedAt)
    throw new Error(
      `Session ${targetSessionId} was deleted and cannot receive prompts.`,
    );
  if (meta.scope !== "user")
    throw new Error(
      `Session ${targetSessionId} is not a user session (${meta.scope}) and cannot receive prompts.`,
    );
  if (meta.archivedAt != null)
    throw new Error(
      `Session ${targetSessionId} is archived; restore it before sending a peer prompt.`,
    );
  const runtime = await runtimeStateFor(meta.id);
  const resumable = resumableState(meta, runtime);
  if (!resumable.resumable) {
    throw new Error(
      `Session ${targetSessionId} cannot currently be prompted (${resumable.reason ?? "not resumable"}); it cannot receive a peer prompt.`,
    );
  }
  return { id: meta.id, title: meta.title };
}

function resolveTaskLabel(taskId?: string): string | undefined {
  if (!taskId) return undefined;
  const task = readTask(taskId);
  if (!task) throw new Error(`Task ${taskId} was not found.`);
  return task.title;
}

/* ---------------------- conversation / correlation ----------------------- */

interface Routing {
  conversationId: string;
  /** Preferred chain to continue. */
  chainId: string;
  /**
   * Pre-generated fresh chain id, used by the store INSTEAD of `chainId`
   * atomically iff `chainId` turns out closed at transaction time (closes the
   * human-reset race: a human prompt closing the chain between this read-only
   * routing decision and the enqueue transaction can never land the message on
   * a chain that only LOOKED open here).
   */
  fallbackChainId?: string;
  replyToMessageId?: string;
  markRepliedId?: string;
}

/**
 * Decide the conversation + causal chain for a send (reads only; the closed-
 * chain re-check, hop reservation, and reply-mark all happen atomically later
 * in {@link peerPromptStore.enqueueRouted}). Whenever an existing chain might be
 * continued, a fresh fallback chain id is generated up front so the store can
 * reroute atomically without calling back into this routing logic mid-transaction.
 */
function resolveConversation(senderId: string, targetId: string): Routing {
  const active = activeContexts.get(senderId);
  if (active && active.senderSessionId === targetId) {
    // A reply within the delivered turn. If a human prompt closes the old chain
    // before the atomic enqueue runs, the store reroutes to the fresh fallback
    // chain rather than reopening it, but still marks the original replied.
    const reply = active.primaryRequestMessageId
      ? {
          replyToMessageId: active.primaryRequestMessageId,
          markRepliedId: active.primaryRequestMessageId,
        }
      : {};
    return {
      conversationId: active.conversationId,
      chainId: active.chainId,
      fallbackChainId: newChainId(),
      ...reply,
    };
  }
  if (active) {
    // Forwarding to a third session during an active turn: inherit the causal
    // chain (Task 105) but start a new conversation; do not close the original.
    return {
      conversationId: newId("conv"),
      chainId: active.chainId,
      fallbackChainId: newChainId(),
    };
  }
  // No active context: continue a prior conversation only when EXACTLY ONE
  // unreplied response-requested message from the target to us exists on an
  // open chain; otherwise start fresh. Ambiguity never asks the model to choose.
  const candidates = peerPromptStore
    .unrepliedRequestsBetween(targetId, senderId)
    .filter((m) => !peerPromptStore.getChain(m.chainId)?.closed);
  if (candidates.length === 1) {
    const one = candidates[0]!;
    return {
      conversationId: one.conversationId,
      chainId: one.chainId,
      fallbackChainId: newChainId(),
      replyToMessageId: one.id,
      markRepliedId: one.id,
    };
  }
  return { conversationId: newId("conv"), chainId: newChainId() };
}

function newChainId(): string {
  return `chain_${newId("c").slice(2)}`;
}

/* ------------------------------- delivery -------------------------------- */

/**
 * The starting context for a recipient that has never taken a turn, in the
 * shape `promptRuntimeSession` wants — or nothing at all, which is the case for
 * every ordinary peer message.
 */
function firstTurnAttachments(
  sessionId: string,
): { attachments: PromptAttachment[] } | undefined {
  if (sessionStore.get(sessionId)?.messageCount) return undefined;
  const { attachments } = sessionFirstTurnContext(sessionId);
  return attachments.length > 0 ? { attachments } : undefined;
}

/** One in-flight drain per recipient; concurrent calls coalesce onto it. */
const drainLocks = new Map<string, Promise<void>>();
/**
 * Senders newly owed a notice while their drain was already in flight. That
 * drain may be past its owed-notice read (or inside the notice turn itself),
 * so coalescing onto it would lose the wake; it runs once more on release.
 */
const noticeWakesPending = new Set<string>();

/**
 * Set on graceful shutdown (SIGTERM/deploy) so no NEW peer-prompt batch delivery
 * starts while the server drains. The idle hook keeps firing as active turns
 * finish, and without this guard each idle session would immediately claim and
 * deliver another queued batch — or even cold-resume a target via `acquireById`
 * purely to deliver one — re-driving runs so `runningCount()` never reaches zero,
 * the reload/shutdown never settles, and `nixos-rebuild switch` blocks on the app
 * stop until the force timeout (surfacing as a hanging CI deploy). Rows stay
 * `queued`/`retryable_failed` and resume on next boot via `drainAllQueuedOnBoot`,
 * so nothing is lost; delivery just does not START new work during drain.
 */
let deliveryStopped = false;

/** Halt all new peer-prompt delivery; in-flight `deliverBatch` calls still finish. */
export function stopPeerPromptDelivery(): void {
  deliveryStopped = true;
  cancelInterruptionNoticeRetries();
}

/** Test seam: restore delivery after a `stopPeerPromptDelivery` test so the module-level flag does not leak. */
export function setPeerPromptDeliveryStoppedForTests(stopped: boolean): void {
  deliveryStopped = stopped;
}

/**
 * Bounded automatic retry for an interruption notice the provider refused.
 *
 * Nothing else would come back for it. The runtime fires its idle hook from
 * inside `LiveRuntimeSession.prompt`'s `finally` — synchronously, while this module's
 * `drainLocks` entry for the session is still held — so the hook's own
 * `drainRecipient` coalesces onto the drain that is failing and starts nothing
 * new. After that the session is idle with no queue, so no further event exists
 * to ride: the notice would sit owed until an unrelated turn or the next boot,
 * which is the deadlock it was written to end.
 *
 * A schedule rather than an immediate re-attempt, because the failure it
 * recovers from is a provider refusing a turn a moment ago. Bounded, because
 * each attempt may COLD-RESUME the session, and an unbounded schedule would
 * respawn a provider process for a session that cannot take the notice at all.
 * Attempts are in-memory on purpose: the owed fact is durable in the row, and
 * exhausting the budget defers to boot rather than losing anything.
 */
const NOTICE_RETRY_MAX_ATTEMPTS = 5;
const noticeRetries = new Map<
  string,
  { attempts: number; timer?: NodeJS.Timeout }
>();
/** Test seam: collapse the backoff so a retry test does not sleep for seconds. */
let noticeRetryDelayMsForTests: number | undefined;
export function setInterruptionNoticeRetryDelayForTests(
  ms: number | undefined,
): void {
  noticeRetryDelayMsForTests = ms;
}

function scheduleInterruptionNoticeRetry(sessionId: string): void {
  const prior = noticeRetries.get(sessionId);
  if (prior?.timer) clearTimeout(prior.timer);
  const attempts = (prior?.attempts ?? 0) + 1;
  if (deliveryStopped || attempts > NOTICE_RETRY_MAX_ATTEMPTS) {
    // Remember the exhausted budget so a later failure cannot silently reset it.
    noticeRetries.set(sessionId, { attempts });
    return;
  }
  const timer = setTimeout(
    () => {
      void drainRecipient(sessionId).catch(() => {});
    },
    noticeRetryDelayMsForTests ?? backoffMsFor(attempts),
  );
  timer.unref();
  noticeRetries.set(sessionId, { attempts, timer });
}

/** A delivered notice returns the session's full retry budget for a future one. */
function clearInterruptionNoticeRetry(sessionId: string): void {
  const state = noticeRetries.get(sessionId);
  if (state?.timer) clearTimeout(state.timer);
  noticeRetries.delete(sessionId);
}

/** Drop every pending retry, so a shutdown drain cannot be re-driven by one. */
function cancelInterruptionNoticeRetries(): void {
  for (const state of noticeRetries.values())
    if (state.timer) clearTimeout(state.timer);
  noticeRetries.clear();
}

/**
 * Deliver queued peer prompts to a recipient without interrupting a running
 * turn. Idle/resumable targets receive one FIFO batch as a fresh turn. Concurrent
 * calls for the same recipient coalesce so competing drains cannot double-admit.
 */
export function drainRecipient(recipientId: string): Promise<void> {
  if (deliveryStopped) return Promise.resolve();
  const existing = drainLocks.get(recipientId);
  if (existing) return existing;
  const run = drainRecipientOnce(recipientId).finally(() => {
    drainLocks.delete(recipientId);
    if (noticeWakesPending.delete(recipientId))
      void drainRecipient(recipientId).catch(() => {});
  });
  drainLocks.set(recipientId, run);
  return run;
}

async function drainRecipientOnce(recipientId: string): Promise<void> {
  const hub = await getHub();
  let live = hub.getLiveById(recipientId);
  // Nothing owed: do not open a harness for it. A drain runs on every session
  // OPEN, and acquiring first would put the cost this avoids — parsing a
  // provider transcript — back on the reader's navigation for every session
  // that has no peer traffic at all, which is nearly all of them.
  if (
    !live &&
    peerPromptStore.listPendingForRecipient(recipientId).length === 0 &&
    peerPromptStore.interruptedOwingSenderNotice(recipientId).length === 0
  )
    return;
  if (!live) {
    try {
      live = await hub.acquireById(recipientId);
    } catch (err) {
      noteDrainTargetUnavailable(recipientId, err);
      return;
    }
  }
  if (!live) {
    noteDrainTargetUnavailable(
      recipientId,
      new Error("target session could not be resumed"),
    );
    return;
  }
  if (!isRuntimePromptDriver(live)) {
    noteDrainTargetUnavailable(
      recipientId,
      new Error("target session cannot be prompted by the runtime"),
    );
    return;
  }
  if (live.isRunning) return; // never steer/interrupt a busy target
  // The user's own queued messages go first; their drain sends one now, and
  // this session's next idle edge comes back here once none is owed.
  if (promptQueueHasPriority(recipientId)) {
    void drainPromptQueue(recipientId);
    return;
  }

  const driver = live;
  // Drain FIFO batches until the queue is empty or the target starts running.
  for (;;) {
    if (driver.isRunning) return;
    const batch = peerPromptStore.claimBatch(
      recipientId,
      "drainer",
      LEASE_MS,
      BATCH_MAX_MESSAGES,
      BATCH_MAX_CHARS,
    );
    if (batch.length === 0) break;
    await deliverBatch(driver, batch);
  }
  // Incoming work first: a session that is about to be told an old prompt died
  // should already be holding whatever arrived for it since.
  await deliverInterruptionNotice(driver, recipientId);
}

/**
 * Tell a session that a prompt IT sent was cut off mid-turn, by a restart or by
 * a provider failure.
 *
 * Without this the sender simply waits: `interrupted` is terminal, the prompt
 * is never re-injected (it is already in the recipient's log), and the only
 * signal is a card state in a browser nobody may be looking at. An agent that
 * set `responseRequested` and then went idle has no way to learn that the reply
 * it is waiting for is never coming — the deadlock this releases.
 *
 * It is a NOTICE, not an instruction: it deliberately does not re-send the
 * prompt or tell the sender to. The sender knows what it asked for and whether
 * it still matters; all it was missing is the fact.
 */
async function deliverInterruptionNotice(
  driver: RuntimePromptDriver,
  sessionId: string,
): Promise<void> {
  if (deliveryStopped || driver.isRunning) return;
  const owed = peerPromptStore.interruptedOwingSenderNotice(sessionId);
  if (owed.length === 0) return;
  try {
    // The notice turn continues the interrupted request's causal chain, so a
    // sender that re-asks or forwards in response spends the same hop budget.
    // A failure that persists then ends at the hop limit instead of cycling
    // failure, notice, re-ask on a fresh chain each time.
    activeContexts.set(sessionId, noticeContext(owed));
    // Deliberately NO `clientRequestId`. An ordinary prompt claims that dedup key
    // BEFORE reaching the provider and keeps it when the provider then fails
    // (only the steer-only path releases it), so a stable key would answer the
    // next attempt "already handled" without sending anything — and the mark
    // below would then record a delivery that never happened, leaving the sender
    // waiting exactly as it was. Idempotence here is `sender_notified_at_ms`,
    // which is written only from an accepted turn; concurrent drains for one
    // session already coalesce on `drainLocks`.
    await promptRuntimeSession(driver, buildInterruptionNotice(owed), {
      origin: { kind: "agent", agentId: PEER_ORIGIN_AGENT_ID },
    });
    // Only an accepted turn consumes the notice.
    peerPromptStore.markSenderNotified(owed.map((m) => m.id));
    clearInterruptionNoticeRetry(sessionId);
  } catch (err) {
    // The rows stay owed. Nothing else will come back for them on its own, so
    // this schedules the only retry that exists.
    console.warn(
      `[peer] interruption notice for ${sessionId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
    scheduleInterruptionNoticeRetry(sessionId);
  } finally {
    activeContexts.delete(sessionId);
  }
}

/**
 * The chain a notice turn speaks in. One notice can cover several chains; the
 * deepest (then newest) wins, so the budget closest to running out is the one
 * a recovery send spends. A send to another recipient in the notice inherits it
 * as a forward.
 */
function noticeContext(owed: PeerPromptRecord[]): ActiveDeliveryContext {
  const anchor = owed.reduce((a, b) =>
    b.hop > a.hop || (b.hop === a.hop && b.createdAt > a.createdAt) ? b : a,
  );
  return {
    senderSessionId: anchor.recipientSessionId,
    conversationId: anchor.conversationId,
    chainId: anchor.chainId,
  };
}

/**
 * The notice envelope. Names the recipient SESSION ID, not just its title: the
 * one useful action is poking that session directly, and a title needs a
 * `session_lookup` round trip and can be ambiguous. A provider failure quotes
 * the error, because what the sender should do next depends on it.
 */
function buildInterruptionNotice(owed: PeerPromptRecord[]): string {
  const restarts = owed.filter((m) => m.interruptionKind !== "failure");
  const failures = owed.filter((m) => m.interruptionKind === "failure");
  const lines = [
    "Peer-prompt interruption notice (server-generated; no session sent this).",
  ];
  if (restarts.length > 0) {
    lines.push(
      "",
      `${promptCount(restarts)} you sent asked for a reply, and the server restarted while the recipient's turn was still running. That turn may not have completed, and no reply is coming on its own:`,
      ...restarts.map(noticeLine),
      "",
      "Whatever the recipient had already done is still in its own context. Decide whether to ask it for a status, re-send, or drop it.",
    );
  }
  if (failures.length > 0) {
    lines.push(
      "",
      `${promptCount(failures)} you sent asked for a reply, and the recipient's turn failed with a provider error. No reply is coming on its own:`,
      ...failures.flatMap((m) => [
        noticeLine(m),
        `  Error: ${clip(m.failureReason ?? "unknown provider error", NOTICE_ERROR_MAX)}`,
      ]),
      "",
      "The prompt is in the recipient's context, but its turn ended without an answer. A usage limit or content refusal applies to the whole conversation, so re-sending to the same session usually fails the same way. Depending on the error: wait and retry, hand the work to a fresh session with a short summary that leaves the flagged material out, switch model, or tell the user.",
    );
  }
  lines.push("", "Nothing further happens automatically.");
  return lines.join("\n");
}

function promptCount(rows: PeerPromptRecord[]): string {
  return rows.length === 1 ? "A prompt" : `${rows.length} prompts`;
}

function noticeLine(m: PeerPromptRecord): string {
  const title = clip(
    sessionStore.get(m.recipientSessionId)?.title ?? "a session",
    SENDER_TITLE_MAX,
  );
  return `- ${title} (session \`${m.recipientSessionId}\`): "${clip(m.prompt, NOTICE_PROMPT_EXCERPT_MAX)}"`;
}

/**
 * The session could not be turned into something promptable — it would not
 * resume, resumed as nothing, or resumed as a session the runtime cannot prompt.
 *
 * Two obligations hang off that, and only one of them is the queue's. An owed
 * interruption notice has no queued row behind it, so
 * {@link markResumeFailureRetryable} claims an empty batch and records nothing;
 * without the schedule here a COLD sender — the case boot exists for, since the
 * restart that stranded it is what left it cold — would lose its only trigger to
 * a resume failure that may well be transient.
 */
function noteDrainTargetUnavailable(sessionId: string, err: unknown): void {
  markResumeFailureRetryable(sessionId, err);
  if (peerPromptStore.interruptedOwingSenderNotice(sessionId).length > 0)
    scheduleInterruptionNoticeRetry(sessionId);
}

/**
 * A transient failure to acquire/resume the target session leaves it with no
 * actionable state otherwise (it would just stay `queued` forever with no
 * reason and no scheduled retry). Claim one FIFO batch purely to record the
 * attempt and apply the bounded retry/backoff transition.
 *
 * Defense in depth: a row can only be claimed here while `queued`, so it
 * should never ALSO already be canonically admitted (boot recovery's atomic
 * decision pass is what prevents that combination from ever being durably
 * committed) — but if one somehow is, retrying/failing it would be WRONG: the
 * recipient already saw that prompt. Check first and, if so, restore its
 * batch grouping and interrupt it exactly like boot recovery would, without
 * ever needing to acquire the target.
 */
function markResumeFailureRetryable(recipientId: string, err: unknown): void {
  const reason = `Target session could not be resumed: ${err instanceof Error ? err.message : String(err)}`;
  const batch = peerPromptStore.claimBatch(
    recipientId,
    "drainer-resume-check",
    LEASE_MS,
    BATCH_MAX_MESSAGES,
    BATCH_MAX_CHARS,
  );
  if (batch.length === 0) return;
  const head = batch[0]!;
  if (alreadyAdmitted(recipientId, head.id)) {
    const admittedBatch = findAdmittedBatch(recipientId, head.id);
    const memberIds = admittedBatch?.memberIds ?? batch.map((m) => m.id);
    const headId = admittedBatch?.headId ?? head.id;
    const applied = peerPromptStore.applyRecoveryDecisions(
      memberIds.map((id) => ({
        id,
        toStatus: "interrupted" as const,
        batchHeadId: headId,
      })),
      STRANDED_ADMISSION_REASON,
      "restart",
    );
    void broadcastParticipants(applied);
    for (const m of applied) void broadcastCardUpdateFor(m);
    return;
  }
  for (const m of batch) retryOrFail(m.id, m.attempts, reason);
  void broadcastParticipants(batch);
  for (const m of batch)
    void broadcastCardUpdateFor(peerPromptStore.getById(m.id) ?? m);
}

/** Bounded exponential backoff: retry until {@link RETRY_MAX_ATTEMPTS}, then give up permanently. */
function backoffMsFor(attempts: number): number {
  return Math.min(
    RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
    RETRY_MAX_BACKOFF_MS,
  );
}

function retryOrFail(id: string, attempts: number, reason: string): void {
  if (attempts >= RETRY_MAX_ATTEMPTS) {
    peerPromptStore.markFailed(
      id,
      `${reason} (giving up after ${attempts} attempts)`,
    );
  } else {
    peerPromptStore.markRetryable(id, reason, backoffMsFor(attempts));
  }
}

/**
 * Requeue every `retryable_failed` row whose backoff has elapsed and attempt
 * delivery for its recipient. This is the ONLY path back from `retryable_failed`
 * — without it those rows would be a permanent dead end. Runs on a boot-
 * independent interval (see index.ts) and can be invoked directly by tests.
 */
export function sweepPeerPromptRetries(now = Date.now()): void {
  const requeued = peerPromptStore.requeueDueRetries(now);
  for (const m of requeued) void broadcastCardUpdateFor(m);
  const recipients = new Set(requeued.map((m) => m.recipientSessionId));
  for (const id of recipients) void drainRecipient(id).catch(() => {});
}

function peerKey(messageId: string): string {
  return `peer:${messageId}`;
}

/**
 * Durable idempotency: whether the recipient canonical log already contains the
 * admission entry for this batch key. Survives restart because the log persists
 * `clientRequestId`. Prevents injecting a second visible prompt after admission.
 */
function alreadyAdmitted(recipientId: string, messageId: string): boolean {
  const path = canonicalSessionLogPath(recipientId);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(
      JSON.stringify(peerKey(messageId)),
    );
  } catch {
    return false;
  }
}

/**
 * The canonical log append (with `peerMessageIds`, the full batch's admission
 * keys) happens BEFORE our own `markDeliveryBatch` bookkeeping (see
 * `deliverBatch`), so a crash in that exact window leaves `batch_head_id`
 * unset even though the recipient's log already committed the ONE canonical
 * batch card. Parse the log entry itself to recover the true batch
 * composition — `peerMessageIds[0]` is always the head, since `deliverBatch`
 * persists `batch.map(m => peerKey(m.id))` in FIFO (head-first) order — so
 * boot recovery can restore `batch_head_id` before reconciling, rather than
 * falling back to `id` and permanently splitting one canonical card into
 * separate, unmatchable per-row entries.
 */
function findAdmittedBatch(
  recipientId: string,
  messageId: string,
): { headId: string; memberIds: string[] } | undefined {
  const path = canonicalSessionLogPath(recipientId);
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const needle = peerKey(messageId);
  if (!text.includes(JSON.stringify(needle))) return undefined;
  for (const line of text.split("\n")) {
    if (!line || !line.includes(needle)) continue;
    let entry: { peerMessageIds?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !Array.isArray(entry.peerMessageIds) ||
      !entry.peerMessageIds.includes(needle)
    )
      continue;
    const memberIds = entry.peerMessageIds
      .filter((k): k is string => typeof k === "string")
      .map((k) => k.replace(/^peer:/, ""));
    const headId = memberIds[0];
    if (headId) return { headId, memberIds };
  }
  return undefined;
}

async function deliverBatch(
  driver: RuntimePromptDriver,
  batch: PeerPromptRecord[],
): Promise<void> {
  const head = batch[0]!;
  // Exactly-once admission: if a crash left this key already in the recipient
  // log, never re-inject the prompt. Mark it interrupted so it is explicit that
  // the delivered turn's completion is unknown.
  if (alreadyAdmitted(driver.sessionId, head.id)) {
    peerPromptStore.markDeliveryBatch(
      batch.map((m) => m.id),
      head.id,
    );
    for (const m of batch) {
      peerPromptStore.markAdmitted(m.id);
      peerPromptStore.markInterrupted(
        m.id,
        STRANDED_ADMISSION_REASON,
        "restart",
      );
    }
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates(batch.map((m) => m.id));
    return;
  }
  const envelope = buildEnvelope(batch);
  const primaryRequest = [...batch].reverse().find((m) => m.responseRequested);
  const context: ActiveDeliveryContext = {
    senderSessionId: head.senderSessionId,
    conversationId: head.conversationId,
    chainId: head.chainId,
    ...(primaryRequest ? { primaryRequestMessageId: primaryRequest.id } : {}),
  };
  activeContexts.set(driver.sessionId, context);
  try {
    // The recipient card's responseRequested reflects whether ANY batched
    // message wants a reply, not just the head. Its messageKey is the DISTINCT
    // batch key (not the head's own opaque key), so a later aggregate-state
    // broadcast can never bleed into the head's own individual sender-side card.
    const receivedCard: PeerPromptCard = {
      ...cardFor(head, "received", undefined, batchMessage(batch)),
      messageKey: batchCardKey(head.id),
      responseRequested: batch.some((m) => m.responseRequested),
      state: "delivered",
    };
    const turn = promptRuntimeSession(driver, envelope, {
      origin: { kind: "agent", agentId: PEER_ORIGIN_AGENT_ID },
      clientRequestId: peerKey(head.id),
      // A session an agent spawned is created by one path and first prompted
      // HERE, and this envelope is plain text with no attachment slot of its
      // own. So its starting context is rebuilt from the links its creator
      // recorded (`sessionContext.ts`) — durable, so it survives a restart
      // between creation and delivery. Only on the very first turn: a session
      // already in conversation has had this context since it began.
      ...(firstTurnAttachments(driver.sessionId) ?? {}),
      // Persist EVERY batched row's admission key so crash recovery detects each,
      // not just the batch head.
      peerMessageIds: batch.map((m) => peerKey(m.id)),
      // The recipient transcript card is a delivery-time snapshot; mark it
      // "delivered" (not the pre-claim "queued") so it does not mislead. The
      // durable Peer prompts section and the live card-update broadcast are the
      // reconciling lifecycle surfaces.
      peerPrompt: receivedCard,
    });
    // Admitted (present in the recipient log) and acknowledged (run started).
    // Record the batch grouping durably alongside admission, so history
    // projection can later reconstruct this same recipient-side grouping.
    peerPromptStore.markDeliveryBatch(
      batch.map((m) => m.id),
      head.id,
    );
    for (const m of batch) {
      peerPromptStore.markAdmitted(m.id);
      peerPromptStore.markAcknowledged(m.id);
    }
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates(batch.map((m) => m.id));
    await turn;
    for (const m of batch) peerPromptStore.markCompleted(m.id);
  } catch (err) {
    // Failure disposition depends on whether canonical admission occurred: an
    // admitted-but-failed turn is interrupted (never re-injected); a send that
    // never reached the log (busy race, pre-append rejection) is retryable
    // (bounded — RETRY_MAX_ATTEMPTS gives up permanently).
    const reason = err instanceof Error ? err.message : String(err);
    const admitted = alreadyAdmitted(driver.sessionId, head.id);
    for (const m of batch) {
      // The turn reached the recipient's log and then failed on its own terms:
      // a provider refusal or harness exit, not a process that vanished.
      if (admitted) peerPromptStore.markInterrupted(m.id, reason, "failure");
      else retryOrFail(m.id, m.attempts, reason);
    }
    // A sender waiting on a reply is usually idle, so no idle edge of its own
    // will come to collect the notice it is now owed.
    if (admitted) wakeSendersOwingNotice(batch, driver.sessionId);
  } finally {
    activeContexts.delete(driver.sessionId);
  }
  await broadcastParticipants(batch);
  // Re-fetch each row before broadcasting: `batch` holds the pre-transition
  // snapshot from claimBatch, so broadcasting it directly would always report
  // the stale "dispatching" state instead of the actual final outcome.
  await broadcastBatchCardUpdates(batch.map((m) => m.id));
}

function wakeSendersOwingNotice(
  batch: PeerPromptRecord[],
  recipientId: string,
): void {
  const senders = new Set(
    batch
      .filter((m) => m.responseRequested && m.senderSessionId !== recipientId)
      .map((m) => m.senderSessionId),
  );
  for (const id of senders) {
    if (drainLocks.has(id)) noticeWakesPending.add(id);
    void drainRecipient(id).catch(() => {});
  }
}

const STRANDED_ADMISSION_REASON =
  "Recovered after restart; the delivered turn may not have completed.";

/**
 * Decide the fate of every currently-`dispatching` row against the recipient
 * canonical log, WITHOUT writing anything yet (read-only decision phase —
 * see {@link applyRecoveryDecisions} for why the write must be one atomic
 * pass). A row whose admission key is already present was delivered before
 * the crash and must become `interrupted` (restoring its true batch grouping
 * from the log via {@link findAdmittedBatch}) rather than re-injected; others
 * decide `queued` and drain when their recipient next opens.
 */
function decideDispatchingRecovery(
  rows: PeerPromptRecord[],
): PeerPromptRecoveryDecision[] {
  const decisions: PeerPromptRecoveryDecision[] = [];
  const decidedIds = new Set<string>();
  for (const m of rows) {
    if (decidedIds.has(m.id)) continue; // already decided as part of an earlier member's batch group
    if (alreadyAdmitted(m.recipientSessionId, m.id)) {
      const admittedBatch = findAdmittedBatch(m.recipientSessionId, m.id);
      const memberIds = admittedBatch?.memberIds ?? [m.id];
      const headId = admittedBatch?.headId ?? m.id;
      for (const id of memberIds) {
        decidedIds.add(id);
        decisions.push({ id, toStatus: "interrupted", batchHeadId: headId });
      }
    } else {
      decidedIds.add(m.id);
      decisions.push({ id: m.id, toStatus: "queued" });
    }
  }
  return decisions;
}

/**
 * Boot recovery (Task 88): reconcile every in-flight (`dispatching`) row
 * against the recipient canonical log and commit ALL decisions in ONE atomic
 * transaction ({@link applyRecoveryDecisions}) — every row moves DIRECTLY from
 * `dispatching` to its final status, never through an intermediate `queued`
 * commit for a row that turns out to be already admitted. A two-phase commit
 * (dispatching->queued always, THEN separately maybe ->interrupted) would
 * leave a durably-committed "queued but already canonically admitted" state
 * reachable after a crash between those two commits: a state neither this
 * function nor `recoverStrandedAdmitted` would ever re-scan on a LATER boot,
 * and that ordinary drain/retry logic (see `markResumeFailureRetryable`)
 * could misinterpret as never having been delivered.
 *
 * A row already `admitted`/`acknowledged` at boot never passed through
 * `dispatching` recovery above (it already left that state) but is JUST AS
 * strandable: the crash window "after admission, before run completion" (Task
 * 88) leaves it durably delivered with no result. Re-queuing would re-inject a
 * second visible prompt, so every such row unconditionally becomes
 * `interrupted` — never re-checked against the log, since admission is a fact
 * already recorded in its status. Never blocks on live delivery.
 */
export function recoverPeerPromptsOnBoot(): {
  recovered: number;
  interrupted: number;
} {
  const decisions = decideDispatchingRecovery(
    peerPromptStore.listDispatching(),
  );
  const applied = peerPromptStore.applyRecoveryDecisions(
    decisions,
    STRANDED_ADMISSION_REASON,
    "restart",
  );
  let interrupted = 0;
  for (const m of applied) {
    if (m.status === "interrupted") interrupted++;
    void broadcastCardUpdateFor(m);
  }
  const strandedAdmitted = peerPromptStore.recoverStrandedAdmitted(
    STRANDED_ADMISSION_REASON,
    "restart",
  );
  for (const m of strandedAdmitted) {
    interrupted++;
    void broadcastCardUpdateFor(m);
  }
  return { recovered: applied.length + strandedAdmitted.length, interrupted };
}

/**
 * Periodic lease sweep (Task 88): requeue any `dispatching` row whose lease
 * expired without a matching drainer completing it (e.g. a crashed/hung drain
 * attempt), broadcasting the recovered state. Runs alongside the retry sweep.
 */
export function sweepExpiredLeases(now = Date.now()): void {
  const requeued = peerPromptStore.requeueExpiredLeases(now);
  for (const m of requeued) void broadcastCardUpdateFor(m);
  const recipients = new Set(requeued.map((m) => m.recipientSessionId));
  for (const id of recipients) void drainRecipient(id).catch(() => {});
}

/**
 * Startup queue drain: attempt delivery for every recipient that still has
 * queued work, independent of any browser connection. Resumable/idle targets
 * are acquired and delivered; busy ones stay queued for their next idle.
 */
export function drainAllQueuedOnBoot(): void {
  // Senders owing an interruption notice are included because the restart that
  // stranded them is the same one running this: they are typically cold, hold
  // nothing queued, and would otherwise never reach an idle hook at all.
  const sessions = new Set([
    ...peerPromptStore.queuedRecipientIds(),
    ...peerPromptStore.senderIdsOwingNotice(),
  ]);
  for (const sessionId of sessions) {
    void drainRecipient(sessionId).catch(() => {});
  }
}

/* ------------------------------- envelope -------------------------------- */

/** The combined message body of a batch (the actual peer prompts). */
function batchMessage(batch: PeerPromptRecord[]): string {
  return batch.map((m) => m.prompt).join("\n\n");
}

/**
 * The delivered model envelope: a short sender label, the prompt(s), and an
 * optional reply cue. Non-message overhead stays under {@link ENVELOPE_OVERHEAD_MAX}.
 *
 * The cue names the SENDER's session id so the recipient can reply without a
 * `session_lookup` round trip (and without mis-targeting an ambiguous title).
 * `head.senderSessionId` is authoritative for the whole batch: `claimBatch`
 * stops at the first sender or conversation mismatch. It is model-facing only
 * — the transcript renders the sanitized card, never this envelope — and stays
 * inside the conditional cue so fire-and-forget notifications stay minimal.
 */
export function buildEnvelope(batch: PeerPromptRecord[]): string {
  const head = batch[0]!;
  const title = clip(head.senderLabel ?? "another session", SENDER_TITLE_MAX);
  const header = `Peer message from ${title}:`;
  const cue = batch.some((m) => m.responseRequested)
    ? `\n\nReply with session_send_prompt to session \`${head.senderSessionId}\` if a response is needed, then end your turn — further messages arrive while you are idle.`
    : "";
  return `${header}\n\n${batchMessage(batch)}${cue}`;
}

/* ------------------------------- cards ----------------------------------- */

function cardState(status: PeerPromptStatus): PeerPromptState {
  switch (status) {
    case "queued":
    case "dispatching":
      return "queued";
    case "admitted":
      return "delivered";
    case "acknowledged":
      return "acknowledged";
    case "completed":
      return "completed";
    case "awaiting_response":
      return "awaiting_response";
    case "replied":
      return "replied";
    case "retryable_failed":
      return "retrying";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return "failed";
  }
}

function cardFor(
  message: PeerPromptRecord,
  direction: "sent" | "received",
  recipientTitle?: string,
  overrideMessage?: string,
): PeerPromptCard {
  return {
    direction,
    messageKey: opaqueKey(message.id),
    senderTitle: message.senderLabel ?? "another session",
    ...(recipientTitle ? { recipientTitle } : {}),
    // The other party's session id, so the card can link to that conversation.
    // Never the message/conversation/chain id: those stay opaque.
    peerSessionId:
      direction === "sent"
        ? message.recipientSessionId
        : message.senderSessionId,
    message: overrideMessage ?? message.prompt,
    responseRequested: message.responseRequested,
    ...(message.taskLabel ? { taskTitle: message.taskLabel } : {}),
    ...(message.failureReason ? { failureReason: message.failureReason } : {}),
    state: cardState(message.status),
  };
}

/** Broadcast one card-state patch to one session's viewers, keyed by an opaque `messageKey`. */
async function broadcastCardKeyUpdate(
  sessionId: string,
  key: string,
  state: PeerPromptState,
  failureReason?: string,
): Promise<void> {
  try {
    const hub = await getHub();
    hub.broadcastPeerPromptCardUpdate(sessionId, {
      messageKey: key,
      state,
      ...(failureReason ? { failureReason } : {}),
    });
  } catch {
    // Best-effort UI refresh only; the durable Peer prompts history stays authoritative.
  }
}

/**
 * Precedence used to aggregate a batch's per-row states into ONE state
 * (most-attention-needed first). A batch delivers as a single recipient
 * transcript card, so if any member still needs a reply (or failed) the
 * shared card must reflect that rather than an arbitrary member's own state.
 */
const AGGREGATE_STATE_PRIORITY: PeerPromptState[] = [
  "failed",
  "interrupted",
  "retrying",
  "cancelled",
  "expired",
  "awaiting_response",
  "queued",
  "delivered",
  "acknowledged",
  "replied",
  "completed",
];

function aggregateCardState(rows: PeerPromptRecord[]): PeerPromptState {
  const states = new Set(rows.map((r) => cardState(r.status)));
  for (const s of AGGREGATE_STATE_PRIORITY) if (states.has(s)) return s;
  return "completed";
}

/**
 * THE one centralized, batch-aware card broadcaster (Task-82 review round 5):
 * every lifecycle path (delivery, reply correlation, expiry, boot recovery,
 * retry/lease sweeps) drives its card updates through this single function so
 * none of them can drift out of sync with how a batch is actually rendered.
 * The sender's own per-message card always shows ITS OWN true state at
 * `opaqueKey(m.id)`. The recipient's card is batch-aware: it looks up EVERY
 * member of `m`'s delivered batch (via the durable `batch_head_id`, complete
 * regardless of any bounded/paginated window) and broadcasts the AGGREGATE
 * state at the batch's shared `batchCardKey`, never `m`'s own individual key —
 * a solo delivery is a trivial one-member "batch" so this degrades safely.
 */
async function broadcastCardUpdateFor(m: PeerPromptRecord): Promise<void> {
  const effectiveHeadId = m.batchHeadId ?? m.id;
  const members = peerPromptStore.listByBatchHead(
    m.recipientSessionId,
    effectiveHeadId,
  );
  const rowsForAggregate = members.length > 0 ? members : [m];
  const aggregateState = aggregateCardState(rowsForAggregate);
  const aggregateFailureReason = rowsForAggregate.find(
    (r) => r.failureReason,
  )?.failureReason;
  await Promise.all([
    broadcastCardKeyUpdate(
      m.senderSessionId,
      opaqueKey(m.id),
      cardState(m.status),
      m.failureReason,
    ),
    broadcastCardKeyUpdate(
      m.recipientSessionId,
      batchCardKey(effectiveHeadId),
      aggregateState,
      aggregateFailureReason,
    ),
  ]);
}

/** Broadcast every batched row's own (batch-aware) card update; see {@link broadcastCardUpdateFor}. */
async function broadcastBatchCardUpdates(batchIds: string[]): Promise<void> {
  const rows = batchIds
    .map((id) => peerPromptStore.getById(id))
    .filter((r): r is PeerPromptRecord => Boolean(r));
  await Promise.all(rows.map((r) => broadcastCardUpdateFor(r)));
}

/** Distinct opaque key for a batch's ONE shared recipient card, never shared with the head row's own per-message key. */
function batchCardKey(headId: string): string {
  return opaqueKey(`batch:${headId}`);
}

/* --------------------------- history projection -------------------------- */

/**
 * Bounded, sanitized peer-prompt history for a session (sender + recipient),
 * grouped into conversations. Contains no ids/paths/reply syntax that render —
 * conversation/message ids are opaque reconciliation keys only.
 */
export function peerPromptThreadsFor(
  sessionId: string,
  limit = HISTORY_MAX_MESSAGES,
): PeerPromptThreadsProjection {
  const cappedLimit = Math.min(
    Math.max(1, Math.floor(limit)),
    HISTORY_EXPANSION_MAX_MESSAGES,
  );
  const records = peerPromptStore.listByParticipant(sessionId, cappedLimit + 1);
  const truncated = records.length > cappedLimit;
  const bounded = records.slice(0, cappedLimit); // newest-first
  const byConversation = new Map<string, PeerPromptThread>();
  const order: string[] = [];
  // Received-direction rows delivered together share ONE recipient transcript
  // card (see deliverBatch); group them the same way here, keyed identically
  // to the live batchCardKey broadcast, so a reconnect/navigation read seeds
  // the SAME aggregate state instead of one arbitrary member's own. The
  // aggregate is always computed from the batch's COMPLETE membership (a
  // fresh `listByBatchHead` lookup), never just whichever members this
  // bounded/paginated window happens to include -- a batch straddling the
  // page boundary must still report the same aggregate state as an
  // unpaginated read, not a partial one.
  const emittedGroupKeys = new Set<string>();
  for (const r of bounded) {
    const direction: "sent" | "received" =
      r.senderSessionId === sessionId ? "sent" : "received";
    let thread = byConversation.get(r.conversationId);
    if (!thread) {
      thread = {
        conversationId: opaqueKey(r.conversationId),
        otherPartyTitle: otherPartyTitle(r, direction),
        peerSessionId: peerSessionIdOf(sessionId, r),
        messages: [],
      };
      byConversation.set(r.conversationId, thread);
      order.push(r.conversationId);
    }
    if (direction === "received") {
      const effectiveHeadId = r.batchHeadId ?? r.id;
      const groupKey = `${r.conversationId} ${effectiveHeadId}`;
      if (emittedGroupKeys.has(groupKey)) continue;
      emittedGroupKeys.add(groupKey);
      const members = peerPromptStore.listByBatchHead(
        sessionId,
        effectiveHeadId,
      );
      thread.messages.push(
        buildReceivedGroupMessage(
          effectiveHeadId,
          members.length > 0 ? members : [r],
        ),
      );
      continue;
    }
    const message: PeerPromptThreadMessage = {
      id: opaqueKey(r.id),
      direction,
      message: peerPromptExcerpt(r.prompt),
      state: cardState(r.status),
      responseRequested: r.responseRequested,
      ...(r.taskLabel ? { taskTitle: r.taskLabel } : {}),
      ...(r.failureReason ? { failureReason: r.failureReason } : {}),
      createdAt: r.createdAt,
    };
    thread.messages.push(message);
  }
  // listByParticipant is newest-first; present each thread chronologically.
  for (const thread of byConversation.values()) thread.messages.reverse();
  return { threads: order.map((id) => byConversation.get(id)!), truncated };
}

/** Build one aggregate-state grouped message from a batch's COMPLETE membership (see {@link peerPromptThreadsFor}). */
function buildReceivedGroupMessage(
  effectiveHeadId: string,
  rows: PeerPromptRecord[],
): PeerPromptThreadMessage {
  const aggregateState = aggregateCardState(rows);
  const sorted = [...rows].sort((a, b) => a.queueSeq - b.queueSeq);
  const failureReason = rows.find((r) => r.failureReason)?.failureReason;
  return {
    id: batchCardKey(effectiveHeadId),
    direction: "received",
    message: peerPromptExcerpt(batchMessage(sorted)),
    state: aggregateState,
    responseRequested: rows.some((r) => r.responseRequested),
    ...(sorted[0]?.taskLabel ? { taskTitle: sorted[0].taskLabel } : {}),
    ...(failureReason ? { failureReason } : {}),
    createdAt: Math.min(...rows.map((r) => r.createdAt)),
  };
}

/* ----------------------------- anchor lookup ----------------------------- */

/**
 * Where the OTHER party's copy of one peer-prompt message sits, so the Peer
 * prompts section can send the reader to the message itself rather than to the
 * top of a conversation.
 *
 * `messageKey` is what the viewer's own side shows — the key on its transcript
 * card, which {@link peerPromptThreadsFor} also uses as the projected message
 * id. Both sides of a message carry DIFFERENT keys (the sender's is per-row,
 * the recipient's is the shared batch key), so the row is found from the
 * viewer's key and then re-keyed for the peer, exactly as the two cards were
 * written. Nothing here trusts `messageKey` as an id: it is only ever compared
 * against keys derived from rows this session actually participates in.
 */
export function peerPromptAnchorFor(
  sessionId: string,
  messageKey: string,
): { sessionId: string; entryId: string; index: number } | undefined {
  const rows = peerPromptStore.listByParticipant(
    sessionId,
    HISTORY_EXPANSION_MAX_MESSAGES,
  );
  for (const r of rows) {
    const sent = r.senderSessionId === sessionId;
    const headId = r.batchHeadId ?? r.id;
    const ownKey = sent ? opaqueKey(r.id) : batchCardKey(headId);
    if (ownKey !== messageKey) continue;
    // The peer's copy of the same message. A sent row's copy is the recipient's
    // ONE batch card. A received card is the other way round — every member of
    // the batch shares the key that just matched, so the row found here is an
    // arbitrary member: take the HEAD's own sender-side card, and the session to
    // look in from that same row, so a batch whose members came from different
    // senders cannot be answered with one member's key in another's log.
    const head = sent ? r : (peerPromptStore.getById(headId) ?? r);
    const peerKey = sent ? batchCardKey(headId) : opaqueKey(head.id);
    const peerSessionId = peerSessionIdOf(sessionId, head);
    const located = sessionRuntime.locateAnchor(peerSessionId, (entry) =>
      entryCarriesCardKey(entry, peerKey),
    );
    return located
      ? {
          sessionId: peerSessionId,
          entryId: located.entryId,
          index: located.index,
        }
      : undefined;
  }
  return undefined;
}

/**
 * Whether a raw log entry is the one rendering the card `key` names: the
 * recipient's delivery entry carries it as structured provenance, while the
 * sender's is the `session_send_prompt` result whose payload the transcript
 * parses the card out of.
 */
function entryCarriesCardKey(entry: SessionLogEntry, key: string): boolean {
  if (entry.type !== "message") return false;
  if (entry.role === "user") return entry.peerPrompt?.messageKey === key;
  if (entry.role !== "toolResult") return false;
  return entry.content.some(
    (block) => block.type === "text" && block.text.includes(key),
  );
}

/** Stable opaque key for reconciliation that is not the raw routing/thread id. */
function opaqueKey(id: string): string {
  let hash = 5381;
  for (let i = 0; i < id.length; i++)
    hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0;
  return `k${hash.toString(36)}`;
}

/** The session on the OTHER end of a row, whichever end the viewer is on. */
function peerSessionIdOf(sessionId: string, r: PeerPromptRecord): string {
  return r.senderSessionId === sessionId
    ? r.recipientSessionId
    : r.senderSessionId;
}

function otherPartyTitle(
  r: PeerPromptRecord,
  direction: "sent" | "received",
): string {
  if (direction === "received")
    return (
      r.senderLabel ??
      sessionStore.get(r.senderSessionId)?.title ??
      "another session"
    );
  return sessionStore.get(r.recipientSessionId)?.title ?? "another session";
}

/* ------------------------------- retention ------------------------------- */

/**
 * Expire unresolved reply expectations past their 30-day TTL and prune terminal
 * conversation detail older than 90 days. Never prunes queued/dispatching/
 * awaiting/retryable/otherwise-unresolved rows. Cancelled rows are terminal and
 * follow the same retention window. Idempotent; safe on a schedule.
 * Every expiry is an audited transition, broadcast to both participants.
 */
export function runPeerPromptRetention(now = Date.now()): {
  expired: number;
  pruned: number;
} {
  const expired = peerPromptStore.expireUnresolved(now, now);
  for (const m of expired) void broadcastCardUpdateFor(m);
  // An expired request owes nothing any more: the session list must hear it.
  if (expired.length > 0) void broadcastParticipants(expired);
  // A request whose reply was lost stops being owed at its own deadline with
  // no transition to announce it, so each sweep rebuilds the list (debounced).
  void getHub()
    .then((hub) => hub.broadcastSessions?.())
    .catch(() => undefined);
  const pruned = peerPromptStore.pruneTerminal(now - PRUNE_TTL_MS);
  return { expired: expired.length, pruned };
}

/* ------------------------------- helpers --------------------------------- */

async function broadcastParticipants(batch: PeerPromptRecord[]): Promise<void> {
  try {
    const hub = await getHub();
    const ids = new Set<string>();
    for (const m of batch) {
      ids.add(m.senderSessionId);
      ids.add(m.recipientSessionId);
    }
    for (const id of ids) hub.getLiveById(id)?.broadcastState();
    // The session LIST reads peer prompts too (`queuedWork`, the replies a
    // session still awaits), and a transition outside any turn — a cancel, a
    // retry that gave up — moves no other row; debounced, so a burst is one.
    void hub.broadcastSessions?.();
  } catch {
    // Best-effort UI refresh only.
  }
}

function isRuntimePromptDriver(value: unknown): value is RuntimePromptDriver {
  if (!value || typeof value !== "object") return false;
  const c = value as Partial<RuntimePromptDriver>;
  return (
    typeof c.id === "string" &&
    typeof c.sessionId === "string" &&
    typeof c.createRuntimeAdapter === "function" &&
    typeof c.broadcastState === "function" &&
    typeof c.isRunning === "boolean"
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

let counter = 0;
function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * Human-in-the-loop reset (Task 105): a human-origin prompt to a session closes
 * every open causal chain it participates in, so future sends start fresh.
 * Already-queued messages keep their immutable old-chain hop; a reply from their
 * later delivered turn starts a new chain because the old one is closed. Agent/
 * system prompts, resume, restart, and Task attachment never reset a chain.
 */
export function closeChainsForHumanPrompt(sessionId: string): void {
  try {
    peerPromptStore.closeChainsForSession(sessionId);
  } catch {
    // Best-effort; a failed close only leaves a chain open, not corrupted.
  }
}
