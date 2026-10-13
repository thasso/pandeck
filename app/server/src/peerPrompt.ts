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
import {
  AutomaticTurnsHeldError,
  automaticTurnsHeld,
  captureHumanResume,
  spendHumanResume,
} from "./automaticTurnHold.ts";
import { drainPromptQueue, promptQueueHasPriority } from "./promptQueue.ts";
import {
  clearExplicitRecipientAuthority,
  hasExplicitRecipientAuthority,
  markExplicitRecipientAuthority,
  markExplicitRecipientWaiter,
  releaseExplicitRecipientWaiter,
  waitForExplicitRecipientAuthorityRelease,
} from "./recipientDrainAuthority.ts";
import { existsSync, readFileSync } from "node:fs";
import type {
  PeerPromptCard,
  PeerPromptInterruption,
  PromptAttachment,
  PeerPromptState,
  PeerPromptThread,
  PeerPromptThreadMessage,
  PeerPromptPeerSummary,
  PeerPromptThreadsProjection,
  QueuedPeerPrompt,
} from "@assistant/shared";
import { peerPromptExcerpt } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import {
  delegationFailureNoticeStore,
  type DelegationFailureNotice,
} from "./db/delegationFailureNoticeStore.ts";
import {
  categoryForFailureReason,
  clearDelegationStandDown,
  delegationFailureNoticeLines,
  deliverableNotices,
  failureSentence,
  PEER_NOTICE_AGENT_ID,
  recordDeliveryFailureNotice,
  recordRunFailureNotices,
  journaledFailureBacklog,
  pruneDelegationNotices,
  replayJournaledFailures,
} from "./delegationFailureNotice.ts";
import {
  setRunFailureHook,
  subscribeSessionRunEnded,
  subscribeSessionRunStarted,
  type RunFailureReport,
  type RunOutcome,
} from "./session/runtime/liveSession.ts";
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
import {
  SessionBusyError,
  SteerWithdrawnError,
} from "./session/runtime/index.ts";
import { RunFailedError } from "./session/runtime/errors.ts";
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
const LEASE_MS = 60_000;
/** Unresolved reply expectations expire after 30 days. */
const RESPONSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Completed/expired conversation detail is pruned after 90 days. */
const PRUNE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bounds on the durable per-session history projection. */
const HISTORY_MAX_MESSAGES = 50;
/** Hard ceiling for an explicit history-expansion request. */
const HISTORY_EXPANSION_MAX_MESSAGES = 200;
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
      interruption?: PeerPromptInterruption;
    },
  ): void;
  /** Tell a recipient's viewers what still waits for it; optional for test hubs. */
  broadcastPeerPromptQueue?(sessionId: string, items: QueuedPeerPrompt[]): void;
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

/* ---------------------------- the composer queue ---------------------------- */

const WITHDRAWN_REASON = "Withdrawn by the user before delivery.";
const STEER_UNCERTAIN_REASON =
  "The turn it was steered into stopped; the recipient may already have read it.";
const STEERED_RUN_FAILED_REASON = "The turn it was steered into failed.";
/** The harness ended the turn on an abort nobody asked for. */
const CUT_OFF_REASON = "Its turn was cut off before it finished.";
const OUTCOME_UNKNOWN_REASON = "Its turn ended without reporting how.";
const NOT_TAKEN_REASON = "The recipient session did not take the prompt.";

/**
 * What still waits for a recipient, as its composer queue shows it: queued,
 * retrying, or being dispatched (a steer the turn has not read yet).
 */
function queuedPeerPromptsFor(recipientId: string): QueuedPeerPrompt[] {
  return peerPromptStore.listUndeliveredForRecipient(recipientId).map((r) => ({
    id: opaqueKey(r.id),
    senderTitle: r.senderLabel ?? "another session",
    senderSessionId: r.senderSessionId,
    message: peerPromptExcerpt(r.prompt),
    responseRequested: r.responseRequested,
    createdAt: r.createdAt,
    ...(r.status === "retryable_failed" ? { retrying: true as const } : {}),
    ...(r.status === "dispatching" ? { sending: true as const } : {}),
  }));
}

/** The session state's waiting-peer field; absent when nothing waits. */
export function peerPromptQueueField(sessionId: string): {
  queuedPeerPrompts?: QueuedPeerPrompt[];
} {
  const items = queuedPeerPromptsFor(sessionId);
  return items.length > 0 ? { queuedPeerPrompts: items } : {};
}

/**
 * Recipients whose queue projection is due. One delivery moves several rows
 * through several transitions; their viewers get the list once, after them.
 */
const queuePublishes = new Set<string>();

function publishPeerQueue(recipientId: string): void {
  if (queuePublishes.has(recipientId)) return;
  queuePublishes.add(recipientId);
  queueMicrotask(() => {
    queuePublishes.delete(recipientId);
    void getHub()
      .then((hub) =>
        hub.broadcastPeerPromptQueue?.(
          recipientId,
          queuedPeerPromptsFor(recipientId),
        ),
      )
      .catch(() => {});
  });
}

/** A row still waiting for this recipient, by the opaque key its rows carry. */
function undeliveredByKey(
  recipientId: string,
  key: string,
): PeerPromptRecord | undefined {
  return peerPromptStore
    .listUndeliveredForRecipient(recipientId)
    .find((r) => opaqueKey(r.id) === key);
}

/**
 * The recipient's user withdraws a peer prompt before it is delivered. One
 * that is already being dispatched is past recalling; one already delivered
 * is gone from the queue, and the projection the client gets says so.
 */
export function withdrawQueuedPeerPrompt(
  recipientId: string,
  key: string,
): void {
  const row = undeliveredByKey(recipientId, key);
  if (!row) return;
  const cancelled = peerPromptStore.cancelOne(row.id, WITHDRAWN_REASON);
  if (!cancelled) throw new Error("That message is already being delivered.");
  void broadcastParticipants([cancelled]);
  void broadcastCardUpdateFor(cancelled);
}

/**
 * The recipient's user sends a waiting peer prompt now: as a steer into a
 * running turn that takes one, else as the next turn of an idle session —
 * ahead of the user's own queue, because they asked for this one.
 */
export async function sendQueuedPeerPromptNow(
  recipientId: string,
  key: string,
): Promise<void> {
  if (deliveryStopped) return;
  // The user chose this message: like "Send next" in their own queue, that
  // resumes a stopped session — the Stop that stood as they chose, never one
  // that lands while this waits for the recipient's authority.
  const resume = captureHumanResume(recipientId);
  await withRecipientDrainLock(recipientId, async () => {
    if (deliveryStopped) return;
    const row = undeliveredByKey(recipientId, key);
    if (!row || row.status === "dispatching") return;
    const hub = await getHub();
    const live =
      hub.getLiveById(recipientId) ?? (await hub.acquireById(recipientId));
    if (!isRuntimePromptDriver(live))
      throw new Error("That session could not be resumed.");
    const steer = live.isRunning;
    if (steer && !live.canSteer)
      throw new Error(
        "This session takes no messages mid-turn; it gets this one when the turn ends.",
      );
    if (steer && activeContexts.has(recipientId))
      throw new Error(
        "This session already has a peer prompt in its current turn; wait for that turn to finish before steering another.",
      );
    const claimed = peerPromptStore.claimOne(
      row.id,
      steer ? "steer" : "send-now",
    );
    if (!claimed) return;
    // Claimed as the next turn: the user's choice is accepted, and its turn's
    // idle edge brings the rest. A steer aims at the turn running (on a held
    // session, the one being stopped) and resumes nothing. A newer Stop keeps
    // the hold either way; the delivery is then refused and the row put back.
    if (!steer) spendHumanResume(resume);
    publishPeerQueue(recipientId);
    if (steer) await steerPeerPrompt(live, claimed);
    // Hold the recipient authority through the idle delivery so an automatic
    // drainer cannot start a competing turn or replace its reply context.
    else await deliverBatch(live, [claimed]);
  });
}

/**
 * Hand one claimed row to the running turn, resolving once the turn has READ
 * it — at submission for a harness that answers then, at its next step for
 * one that decides later — or refused it. Until then it shows as being sent.
 * It joins that run, so it settles as that run ENDS ({@link settleAdmitted}).
 */
async function steerPeerPrompt(
  driver: RuntimePromptDriver,
  m: PeerPromptRecord,
): Promise<void> {
  const batch = [m];
  const { envelope, receivedCard, context } = deliveryParts(batch);
  let admitted = false;
  let ownsContext = false;
  // What the append admitted (undefined while its write has not succeeded)
  // and the run it joined, read inside that append. A steer does not open its
  // run, so it hears the end from the runtime's run-ended feed, subscribed
  // before the prompt so no end is missed.
  let admittedIds: string[] | undefined;
  let joinedRun: string | undefined;
  let runEnded: (outcome: RunOutcome) => void = () => {};
  const ended = new Promise<RunOutcome>((resolve) => {
    runEnded = resolve;
  });
  const unsubscribe = subscribeSessionRunEnded((sessionId, outcome) => {
    if (sessionId !== driver.sessionId || !admitted) return;
    // No run was open at the append (it should be): the next end is its own.
    if (joinedRun === undefined || outcome.runId === joinedRun)
      runEnded(outcome);
  });
  let thrown: unknown;
  try {
    await promptRuntimeSession(driver, envelope, {
      origin: { kind: "agent", agentId: PEER_ORIGIN_AGENT_ID },
      clientRequestId: peerKey(m.id),
      peerMessageIds: [peerKey(m.id)],
      peerPrompt: receivedCard,
      steer: true,
      // After the last await, before the provider sees anything.
      admit: () => admitClaimed(batch),
      // Runs inside the runtime's append; nothing here may throw.
      onUserEntry: () => {
        admitted = true;
        joinedRun = sessionRuntime.get(driver.sessionId)?.currentRunId;
        // sendQueuedPeerPromptNow refuses steering into an existing peer
        // delivery context, so this run has one unambiguous reply owner.
        activeContexts.set(driver.sessionId, context);
        ownsContext = true;
        admittedIds = recordAppended(batch);
        void broadcastParticipants(batch);
        void broadcastBatchCardUpdates([m.id]);
      },
    });
  } catch (err) {
    thrown = err;
  }
  if (!admitted && persistedDespite(thrown, driver.sessionId, m.id)) {
    // Its entry reached the log, then something after the write threw before
    // the runtime could say so. It is delivered, and its turn failed with it.
    unsubscribe();
    settleAdmitted(recordAppended(batch), driver.sessionId, undefined, thrown);
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates([m.id]);
    return;
  }
  if (!admitted) {
    unsubscribe();
    if (ownsContext) activeContexts.delete(driver.sessionId);
    const claim = { attempts: m.attempts };
    if (thrown instanceof ClaimLostError) {
      // Another delivery or the user took it before anything was sent.
    } else if (thrown instanceof AutomaticTurnsHeldError) {
      // A Stop refused it at the run door: back as it was, no attempt spent.
      peerPromptStore.returnHeldToQueue(m.id, claim);
    } else if (thrown instanceof SteerWithdrawnError && thrown.uncertain) {
      // Never put back what the turn may have read: the sender decides —
      // unless the turn was stopped on purpose, which tells nobody.
      if (thrown.stopped) peerPromptStore.markStopped(m.id, claim);
      else {
        peerPromptStore.markInterrupted(
          m.id,
          STEER_UNCERTAIN_REASON,
          "failure",
        );
        wakeSendersOwingNotice(batch, driver.sessionId);
      }
    } else if (thrown instanceof SessionBusyError) {
      // Withdrawn unread, or the turn ended first: it waits as it did.
      peerPromptStore.releaseToQueue(m.id, claim);
      void drainRecipient(driver.sessionId).catch(() => {});
    } else {
      const reason = thrown instanceof Error ? thrown.message : String(thrown);
      retryOrFail(m.id, m.attempts, reason);
    }
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates([m.id]);
    return;
  }
  // The turn has it; what is left is the run it joined, which can be long.
  void ended.then(async (outcome) => {
    unsubscribe();
    if (ownsContext && activeContexts.get(driver.sessionId) === context)
      activeContexts.delete(driver.sessionId);
    settleAdmitted(
      admittedIds ?? recordAppended(batch),
      driver.sessionId,
      outcome,
      thrown,
    );
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates([m.id]);
  });
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
/** Whether a send-now is waiting for this recipient's authority. */
function explicitSendWaiting(recipientId: string): boolean {
  return hasExplicitRecipientAuthority(recipientId);
}

/**
 * Run an explicit claim under the same recipient authority as automatic drains.
 * If a drain is in flight, wait for it and re-check: it may have delivered or
 * started the target turn. The reservation is installed synchronously before
 * awaiting the operation, so no automatic drain can slip between claim and
 * delivery.
 */
async function withRecipientDrainLock<T>(
  recipientId: string,
  operation: () => Promise<T>,
): Promise<T> {
  markExplicitRecipientWaiter(recipientId);
  while (drainLocks.has(recipientId))
    await drainLocks.get(recipientId)?.catch(() => {});
  releaseExplicitRecipientWaiter(recipientId);
  let release!: () => void;
  const reservation = new Promise<void>((resolve) => {
    release = resolve;
  });
  drainLocks.set(recipientId, reservation);
  markExplicitRecipientAuthority(recipientId);
  try {
    return await operation();
  } finally {
    clearExplicitRecipientAuthority(recipientId);
    if (drainLocks.get(recipientId) === reservation)
      drainLocks.delete(recipientId);
    release();
    // Waiting explicit sends retain authority before ordinary FIFO draining.
    // drainRecipient also checks this count for idle hooks racing the handoff.
    if (!explicitSendWaiting(recipientId)) {
      void drainRecipient(recipientId).catch(() => {});
      if (noticeWakesPending.delete(recipientId))
        void drainRecipient(recipientId).catch(() => {});
    }
  }
}
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
 *
 * The promise settles once this priority phase is over — the user's queued
 * message sent, or the peer FIFO drained — which is what the background phase
 * waits on before it offers a completion of its own.
 */
export function drainRecipient(recipientId: string): Promise<void> {
  if (deliveryStopped) return Promise.resolve();
  // A send-now holds the recipient. Its release resumes the drain, and THAT
  // drain is the phase a caller waits for: resolving on the release alone let
  // a background completion take the turn the resumed drain was owed.
  if (explicitSendWaiting(recipientId))
    return waitForExplicitRecipientAuthorityRelease(recipientId).then(() =>
      drainRecipient(recipientId),
    );
  const existing = drainLocks.get(recipientId);
  if (existing) return existing;
  const run = drainRecipientOnce(recipientId).finally(() => {
    drainLocks.delete(recipientId);
    // A drain that yielded to a send-now leaves a pending wake for that
    // send's release, which drains again once it is done.
    if (
      !explicitSendWaiting(recipientId) &&
      noticeWakesPending.delete(recipientId)
    )
      void drainRecipient(recipientId).catch(() => {});
  });
  drainLocks.set(recipientId, run);
  return run;
}

async function drainRecipientOnce(recipientId: string): Promise<void> {
  // A Stop holds the session: nothing is claimed, and a cold one is not even
  // resumed. Its rows wait, queued, for the user to resume it.
  if (automaticTurnsHeld(recipientId)) return;
  const hub = await getHub();
  let live = hub.getLiveById(recipientId);
  // Nothing owed: do not open a harness for it. A drain runs on every session
  // OPEN, and acquiring first would put the cost this avoids — parsing a
  // provider transcript — back on the reader's navigation for every session
  // that has no peer traffic at all, which is nearly all of them.
  if (
    !live &&
    peerPromptStore.listPendingForRecipient(recipientId).length === 0 &&
    !owesNotice(recipientId)
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
    // The queue resolves its own driver asynchronously. Recheck recipient
    // authority after that acquisition, or a send-now registered while this
    // automatic drain was awaiting acquireById could lose the next turn.
    // Awaited, so the phase covers that send: it settles once the message is
    // in the session, before anything behind it is offered the idle edge.
    await drainPromptQueue(
      recipientId,
      () => !hasExplicitRecipientAuthority(recipientId),
    );
    return;
  }

  const driver = live;
  // Drain FIFO batches until the queue is empty or the target starts running.
  // Each batch is a whole turn, so a send-now can start waiting during one: it
  // goes next, and its release drains again from the FIFO head. A Stop can land
  // during one too, and the loop that awaited the stopped turn must not claim
  // the next batch: the hold is read again at every claim.
  for (;;) {
    if (
      driver.isRunning ||
      // Torn down (deleted, released): nothing more is sent to it.
      driver.released ||
      explicitSendWaiting(recipientId) ||
      automaticTurnsHeld(recipientId)
    )
      return;
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
  if (explicitSendWaiting(recipientId) || automaticTurnsHeld(recipientId))
    return;
  await deliverOwedNotices(driver, recipientId);
}

/** Whether a session is owed a server-generated notice of either kind. */
function owesNotice(sessionId: string): boolean {
  return (
    peerPromptStore.interruptedOwingSenderNotice(sessionId).length > 0 ||
    delegationFailureNoticeStore.hasPendingFor(sessionId)
  );
}

/**
 * A child of `report.sessionId`'s coordinators failed: record what each is owed
 * (`delegationFailureNotice.ts`) — synchronously, from the runtime's failure
 * hook, before the run's closing marker or any listener — and then offer each
 * coordinator its peer drain, which delivers under the usual hold and busy
 * rules. The wake is only a nudge: a coordinator it misses gets the notice on
 * its next idle edge, its Resume or the next boot.
 */
function onChildRunFailed(report: RunFailureReport): void {
  const written = recordRunFailureNotices(report);
  if (written.length === 0) return;
  queueMicrotask(() =>
    wakeForNotice(new Set(written.map((n) => n.coordinatorSessionId))),
  );
}

/**
 * Route every failed turn through {@link onChildRunFailed}. Called once at
 * boot; the returned uninstall exists for tests.
 */
export function installDelegationFailureNotices(): () => void {
  setRunFailureHook(onChildRunFailed);
  // A coordinator's stand-down covers the turn it stopped, not the next one.
  const unsubscribe = subscribeSessionRunStarted(clearDelegationStandDown);
  return () => {
    setRunFailureHook(undefined);
    unsubscribe();
  };
}

function wakeForNotice(sessionIds: Iterable<string>): void {
  for (const id of sessionIds) {
    if (drainLocks.has(id)) noticeWakesPending.add(id);
    void drainRecipient(id).catch(() => {});
  }
}

/**
 * Tell a session what it is owed: that a prompt IT sent was cut off mid-turn,
 * by a restart or by a provider failure, or that work it delegated stopped on a
 * failure (`delegationFailureNotice.ts`).
 *
 * Without this the sender simply waits: `interrupted` is terminal, the prompt
 * is never re-injected (it is already in the recipient's log), a failed child
 * cannot report its own failure, and the only signal is a card state in a
 * browser nobody may be looking at. An agent that set `responseRequested` and
 * then went idle has no way to learn that the reply it is waiting for is never
 * coming — the deadlock this releases.
 *
 * It is a NOTICE, not an instruction: it deliberately does not re-send the
 * prompt or tell the sender to, and it asks for no reply. The sender knows what
 * it asked for and whether it still matters; all it was missing is the fact.
 */
async function deliverOwedNotices(
  driver: RuntimePromptDriver,
  sessionId: string,
): Promise<void> {
  // A notice whose delegation the user ended while the turn was being
  // admitted is rebuilt without it; this bounds how often that can repeat.
  for (let attempt = 0; attempt < NOTICE_ADMISSION_ATTEMPTS; attempt += 1) {
    if (
      deliveryStopped ||
      driver.isRunning ||
      driver.released ||
      automaticTurnsHeld(sessionId)
    )
      return;
    const owed = peerPromptStore.interruptedOwingSenderNotice(sessionId);
    const delegated = deliverableNotices(sessionId);
    if (owed.length === 0 && delegated.length === 0) return;
    const ids = delegated.map((n) => n.id).join();
    try {
      // The notice turn continues the causal chain it reports on, so a sender
      // that re-asks or forwards in response spends the same hop budget. A
      // failure that persists then ends at the hop limit instead of cycling
      // failure, notice, re-ask on a fresh chain each time.
      const context = noticeContext(sessionId, owed, delegated);
      if (context) activeContexts.set(sessionId, context);
      // Deliberately NO `clientRequestId`. An ordinary prompt claims that dedup
      // key BEFORE reaching the provider and keeps it when the provider then
      // fails (only the steer-only path releases it), so a stable key would
      // answer the next attempt "already handled" without sending anything —
      // and the mark below would then record a delivery that never happened,
      // leaving the sender waiting exactly as it was. Idempotence here is
      // `sender_notified_at_ms`, which is written only from an accepted turn,
      // and a delegation notice's `delivered_at_ms`, written as the turn is
      // appended; concurrent drains for one session coalesce on `drainLocks`.
      await promptRuntimeSession(driver, buildNotice(owed, delegated), {
        origin: { kind: "agent", agentId: PEER_NOTICE_AGENT_ID },
        // Asked once more after the last await: the user may have taken the
        // child over, settled it or answered for it since the text was built.
        admit: () => {
          if (
            deliverableNotices(sessionId)
              .map((n) => n.id)
              .join() !== ids
          )
            throw new NoticeSetChangedError();
        },
        // A delegation notice is a fact the coordinator now holds: retired as
        // its turn reaches the log, so a failure of that turn — often the same
        // limit the child hit — does not deliver it again and again.
        onUserEntry: () => {
          try {
            delegationFailureNoticeStore.markDelivered(
              delegated.map((n) => n.id),
            );
          } catch (err) {
            console.warn(
              `[peer] could not retire failure notices for ${sessionId} (${failureLabel(err)})`,
            );
          }
        },
      });
      // Only an accepted turn consumes the interruption notice.
      peerPromptStore.markSenderNotified(owed.map((m) => m.id));
      clearInterruptionNoticeRetry(sessionId);
      return;
    } catch (err) {
      if (err instanceof NoticeSetChangedError) continue;
      // A Stop landed first: the rows stay owed and Resume comes back for them,
      // so no retry is spent.
      if (err instanceof AutomaticTurnsHeldError) return;
      // The rows stay owed. Nothing else will come back for them on its own,
      // so this schedules the only retry that exists. Never the error's text:
      // a provider failure of the notice turn carries the provider's words.
      console.warn(
        `[peer] notice for ${sessionId} was not delivered (${failureLabel(err)}); retrying later`,
      );
      if (owesNotice(sessionId)) scheduleInterruptionNoticeRetry(sessionId);
      return;
    } finally {
      activeContexts.delete(sessionId);
    }
  }
  if (owesNotice(sessionId)) scheduleInterruptionNoticeRetry(sessionId);
}

/** How many times a notice is rebuilt when its delegations change mid-admission. */
const NOTICE_ADMISSION_ATTEMPTS = 3;

/** The notices a turn was built from changed before it was appended. */
class NoticeSetChangedError extends Error {
  constructor() {
    super("The owed notices changed before the notice turn was appended.");
    this.name = "NoticeSetChangedError";
  }
}

/**
 * What kind of failure an error is, in fixed words: safe to log where nothing
 * the error carries is — not its message, stack or even its `name`, which its
 * thrower sets.
 */
function failureLabel(err: unknown): string {
  if (err instanceof RunFailedError) return "provider or harness failure";
  if (err instanceof SessionBusyError) return "session busy";
  return "error";
}

/**
 * The chain a notice turn speaks in. One notice can cover several chains; the
 * deepest (then newest) wins, so the budget closest to running out is the one
 * a recovery send spends. A send to another recipient in the notice inherits it
 * as a forward.
 */
function noticeContext(
  sessionId: string,
  owed: PeerPromptRecord[],
  delegated: DelegationFailureNotice[],
): ActiveDeliveryContext | undefined {
  const anchors = [
    ...owed.map((m) => ({
      peerId: m.recipientSessionId,
      conversationId: m.conversationId,
      chainId: m.chainId,
      hop: m.hop,
      at: m.createdAt,
    })),
    ...delegated.flatMap((n) =>
      n.anchor
        ? [{ peerId: n.childSessionId, ...n.anchor, at: n.failedAt }]
        : [],
    ),
  ].filter((a) => a.peerId !== sessionId);
  if (anchors.length === 0) return undefined;
  const anchor = anchors.reduce((a, b) =>
    b.hop > a.hop || (b.hop === a.hop && b.at > a.at) ? b : a,
  );
  return {
    senderSessionId: anchor.peerId,
    conversationId: anchor.conversationId,
    chainId: anchor.chainId,
  };
}

/**
 * The notice envelope. Names the recipient SESSION ID, not just its title: the
 * one useful action is poking that session directly, and a title needs a
 * `session_lookup` round trip and can be ambiguous. A provider failure is named
 * by its category, never quoted: the provider's wording can carry account
 * details, URLs or request bodies that have no business in another session.
 */
function buildNotice(
  owed: PeerPromptRecord[],
  delegated: DelegationFailureNotice[],
): string {
  const restarts = owed.filter((m) => m.interruptionKind !== "failure");
  const failures = owed.filter((m) => m.interruptionKind === "failure");
  const lines = [
    "Peer notice (server-generated; no session sent this, and it needs no reply).",
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
      `${promptCount(failures)} you sent asked for a reply, and the recipient's turn failed. No reply is coming on its own:`,
      ...failures.flatMap((m) => [
        noticeLine(m),
        `  ${failureSentence(categoryForFailureReason(m.failureReason))}`,
      ]),
      "",
      "The prompt is in the recipient's context, but its turn ended without an answer. A usage limit or content refusal applies to the whole conversation, so re-sending to the same session usually fails the same way.",
    );
  }
  if (delegated.length > 0)
    lines.push("", ...delegationFailureNoticeLines(delegated));
  lines.push(
    "",
    "Nothing was retried, restarted or reassigned, and nothing further happens automatically. Decide the next step under your own instructions; when unsure, tell the user.",
  );
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
  if (owesNotice(sessionId)) scheduleInterruptionNoticeRetry(sessionId);
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
    // The sender's notice commits with the terminal row, or neither does.
    let notified: string[] = [];
    peerPromptStore.markFailed(
      id,
      `${reason} (giving up after ${attempts} attempts)`,
      Date.now(),
      (failed) => {
        notified = recordDeliveryFailureNotice(failed).map(
          (n) => n.coordinatorSessionId,
        );
      },
      { attempts },
    );
    if (notified.length > 0) wakeForNotice(notified);
  } else {
    peerPromptStore.markRetryable(
      id,
      reason,
      backoffMsFor(attempts),
      Date.now(),
      { attempts },
    );
  }
}

/**
 * Requeue every `retryable_failed` row whose backoff has elapsed and attempt
 * delivery for its recipient. This is the ONLY path back from `retryable_failed`
 * — without it those rows would be a permanent dead end. Runs on a boot-
 * independent interval (see index.ts) and can be invoked directly by tests.
 */
export function sweepPeerPromptRetries(now = Date.now()): void {
  // The queue's own retries come first and never wait on the journal.
  const requeued = peerPromptStore.requeueDueRetries(now);
  for (const m of requeued) void broadcastCardUpdateFor(m);
  const recipients = new Set(requeued.map((m) => m.recipientSessionId));
  for (const id of recipients) void drainRecipient(id).catch(() => {});
  // A failure the database refused when it happened is retried here too, a
  // bounded batch per sweep, from the journal that kept it
  // (`delegationFailureJournal.ts`). It reports its own trouble and never
  // throws, so nothing above or after it is held up.
  const replayed = replayJournaledFailures(now);
  if (replayed.length > 0)
    wakeForNotice(new Set(replayed.map((n) => n.coordinatorSessionId)));
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

/** What delivering a batch hands the recipient, however it is delivered. */
function deliveryParts(batch: PeerPromptRecord[]): {
  envelope: string;
  receivedCard: PeerPromptCard;
  context: ActiveDeliveryContext;
} {
  const head = batch[0]!;
  const primaryRequest = [...batch].reverse().find((m) => m.responseRequested);
  return {
    envelope: buildEnvelope(batch),
    // The recipient card's responseRequested reflects whether ANY batched
    // message wants a reply, not just the head. Its messageKey is the DISTINCT
    // batch key (not the head's own opaque key), so a later aggregate-state
    // broadcast can never bleed into the head's own individual sender-side card.
    receivedCard: {
      ...cardFor(head, "received", undefined, batchMessage(batch)),
      messageKey: batchCardKey(head.id),
      responseRequested: batch.some((m) => m.responseRequested),
      state: "delivered",
    },
    context: {
      senderSessionId: head.senderSessionId,
      conversationId: head.conversationId,
      chainId: head.chainId,
      ...(primaryRequest ? { primaryRequestMessageId: primaryRequest.id } : {}),
    },
  };
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
    interruptStrandedBatch(batch, driver.sessionId);
    await broadcastParticipants(batch);
    await broadcastBatchCardUpdates(batch.map((m) => m.id));
    return;
  }
  const { envelope, receivedCard, context } = deliveryParts(batch);
  const ids = batch.map((m) => m.id);
  // Set inside the runtime's append — the one fact that this turn reached
  // the session — to the rows this claim admitted, and then to how the run
  // that append opened ended. Neither is inferred from whether the prompt
  // resolved: a Stop resolves it like a finished turn.
  let appended = false;
  let admittedIds: string[] | undefined;
  let outcome: RunOutcome | undefined;
  let thrown: unknown;
  activeContexts.set(driver.sessionId, context);
  try {
    await promptRuntimeSession(driver, envelope, {
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
      peerMessageIds: ids.map(peerKey),
      // The recipient transcript card is a delivery-time snapshot; mark it
      // "delivered" (not the pre-claim "queued") so it does not mislead. The
      // durable Peer prompts section and the live card-update broadcast are the
      // reconciling lifecycle surfaces.
      peerPrompt: receivedCard,
      // After the last await, before the provider sees anything: every
      // member must still be this claim's, or nothing is sent.
      admit: () => admitClaimed(batch),
      // Runs inside the runtime's append; nothing here may throw. Admitted
      // (in the recipient log) and acknowledged (its run started) together,
      // with the batch grouping history projection reconstructs.
      onUserEntry: () => {
        appended = true;
        admittedIds = recordAppended(batch);
        void broadcastParticipants(batch);
        void broadcastBatchCardUpdates(ids);
      },
      onRunEnded: (ended) => {
        outcome = ended;
      },
    });
  } catch (err) {
    thrown = err;
  } finally {
    activeContexts.delete(driver.sessionId);
  }
  // Its entry reached the log, then something after the write threw before
  // the runtime could say so: delivered, never a draft to send again.
  if (!appended && persistedDespite(thrown, driver.sessionId, head.id))
    appended = true;
  if (appended) {
    // Admitted work is never retried or re-queued: it is in the recipient's
    // context, its tool calls may have run. Only its outcome is recorded. A
    // throw after a clean end is the facade's own bookkeeping, not the turn.
    settleAdmitted(
      admittedIds ?? recordAppended(batch),
      driver.sessionId,
      outcome,
      outcome?.stopReason === "end" ? undefined : thrown,
    );
  } else if (thrown === undefined) {
    // Resolved with nothing appended: the runtime already handled this key,
    // so the prompt reached the session earlier and its outcome is unknown.
    interruptStrandedBatch(batch, driver.sessionId);
  } else {
    // Refused before the append: nothing reached the session. A Stop that
    // landed between the claim and the append, or a claim that went stale
    // while the turn was prepared (a row withdrawn or put back meanwhile),
    // puts the rows still this claim's back as they were, spending no
    // attempt; the drain claims afresh. Anything else is a delivery failure
    // under the bounded retry policy.
    for (const m of batch) {
      if (
        thrown instanceof AutomaticTurnsHeldError ||
        thrown instanceof ClaimLostError
      )
        peerPromptStore.returnHeldToQueue(m.id, { attempts: m.attempts });
      else
        retryOrFail(
          m.id,
          m.attempts,
          thrown instanceof Error ? thrown.message : String(thrown),
        );
    }
  }
  await broadcastParticipants(batch);
  // Re-fetch each row before broadcasting: `batch` holds the pre-transition
  // snapshot from claimBatch, so broadcasting it directly would always report
  // the stale "dispatching" state instead of the actual final outcome.
  await broadcastBatchCardUpdates(ids);
}

/** A claimed batch whose rows are no longer all this claim's: nothing is sent. */
class ClaimLostError extends Error {
  constructor() {
    super("The peer prompt was withdrawn or reclaimed before it was sent.");
    this.name = "ClaimLostError";
  }
}

/**
 * The facade's last check before the provider sees the batch
 * (`RuntimePromptFacadeOptions.admit`): every member must still be held by
 * this claim, and passing reserves them against the lease sweep. A refusal,
 * or a database that cannot say, throws — and nothing is sent.
 */
function admitClaimed(batch: PeerPromptRecord[]): void {
  const claims = batch.map((m) => ({ id: m.id, attempts: m.attempts }));
  if (!peerPromptStore.reserveAdmission(claims)) throw new ClaimLostError();
}

/**
 * Whether a delivery that threw had already written its entry to the
 * recipient's log. The runtime calls `onUserEntry` only once the append
 * returns, and the append persists the entry BEFORE its own bookkeeping (the
 * session's stats row), so a throw from that bookkeeping leaves a delivered
 * entry the caller never heard about. The log is the authority. A refusal
 * that happens before any append by construction — the claim lost, a Stop at
 * the door — is not checked.
 */
function persistedDespite(
  thrown: unknown,
  recipientId: string,
  headId: string,
): boolean {
  if (
    thrown === undefined ||
    thrown instanceof ClaimLostError ||
    thrown instanceof AutomaticTurnsHeldError
  )
    return false;
  return alreadyAdmitted(recipientId, headId);
}

/**
 * Record a batch the runtime just appended, or `undefined` when the write
 * failed. Its rows stay reserved (`dispatching`, no lease): never swept back,
 * never withdrawable, never sent again. The settlement tries once more; if
 * that fails too, boot recovery reads the key in the log.
 */
function recordAppended(batch: PeerPromptRecord[]): string[] | undefined {
  try {
    return peerPromptStore.recordAdmission(
      batch.map((m) => ({ id: m.id, attempts: m.attempts })),
      batch[0]!.id,
    );
  } catch (err) {
    console.warn(
      `[peer-prompt] could not record an admission (${failureLabel(err)})`,
    );
    return undefined;
  }
}

/**
 * Record how the turn that admitted `ids` ended. Called once per delivery;
 * every write is a compare-and-set from `admitted`/`acknowledged`, so a row a
 * genuine reply, a recorded run failure (`interruptAsTold`) or an earlier
 * callback already moved keeps what it has.
 *
 * - An abort someone ASKED for (the user's Stop, a coordinator's stand-down) —
 *   even one that kept an earlier attempt's error — is `stopped`: no notice,
 *   and a requested reply stays owed.
 * - A turn that ended cleanly completes: `completed`, or `awaiting_response`
 *   when a reply was asked for — the turn finishing is not the request
 *   answered.
 * - Anything else ended the turn without finishing it — a provider failure,
 *   an abort nobody asked for, or an end nobody reported — and is a `failure`
 *   interruption whose sender, if it asked for a reply, is told. So is a row
 *   whose own delivery threw after its append (`thrown`): a steer the
 *   provider refused never reached the model, however its run then ended.
 */
function settleAdmitted(
  ids: readonly string[] | undefined,
  recipientId: string,
  outcome: RunOutcome | undefined,
  thrown: unknown,
): void {
  // Its admission could not be recorded: left reserved for boot recovery.
  if (!ids) return;
  const rows = ids
    .map((id) => peerPromptStore.getById(id))
    .filter((r): r is PeerPromptRecord => r !== undefined);
  if (rows.length === 0) return;
  if (outcome?.abortRequested) {
    for (const m of rows) peerPromptStore.markStopped(m.id);
    return;
  }
  if (outcome?.stopReason === "end" && thrown === undefined) {
    for (const m of rows) peerPromptStore.markCompleted(m.id);
    return;
  }
  const reason =
    thrown !== undefined
      ? thrown instanceof Error
        ? thrown.message
        : String(thrown)
      : outcome?.stopReason === "aborted"
        ? CUT_OFF_REASON
        : outcome?.stopReason === "error"
          ? STEERED_RUN_FAILED_REASON
          : OUTCOME_UNKNOWN_REASON;
  // The turn reached the recipient's log and then ended on its own terms: a
  // provider refusal or harness exit, not a process that vanished.
  for (const m of rows)
    peerPromptStore.markInterrupted(m.id, reason, "failure");
  // A sender waiting on a reply is usually idle, so no idle edge of its own
  // will come to collect the notice it is now owed.
  wakeSendersOwingNotice(rows, recipientId);
}

/** A claimed batch the recipient's log already holds: delivered, outcome unknown. */
function interruptStrandedBatch(
  batch: PeerPromptRecord[],
  recipientId: string,
): void {
  if (!alreadyAdmitted(recipientId, batch[0]!.id)) {
    // Nothing in the log after all: an ordinary bounded delivery failure.
    for (const m of batch) retryOrFail(m.id, m.attempts, NOT_TAKEN_REASON);
    return;
  }
  peerPromptStore.markDeliveryBatch(
    batch.map((m) => m.id),
    batch[0]!.id,
  );
  for (const m of batch) {
    peerPromptStore.markAdmitted(m.id);
    peerPromptStore.markInterrupted(m.id, STRANDED_ADMISSION_REASON, "restart");
  }
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
/**
 * Work through a journaled-failure backlog boot left for later, one bounded
 * batch per macrotask so connections and other work run in between. Stops
 * when nothing is left or a whole batch made no progress (the database still
 * refuses); the retry sweep carries on from there.
 */
export function drainJournaledFailureBacklog(): void {
  const step = (): void => {
    if (deliveryStopped) return;
    const before = journaledFailureBacklog();
    if (before === 0) return;
    const written = replayJournaledFailures();
    if (written.length > 0)
      wakeForNotice(new Set(written.map((n) => n.coordinatorSessionId)));
    if (journaledFailureBacklog() < before) setTimeout(step, 0).unref();
  };
  setTimeout(step, 0).unref();
}

export function drainAllQueuedOnBoot(): void {
  // Sessions owed a notice are included because they are typically cold and
  // hold nothing queued — the restart that stranded an interrupted turn is the
  // one running this, and a coordinator waits idle on a child that failed — so
  // they would otherwise never reach an idle hook at all. A held one is skipped
  // by its drain and waits for Resume.
  const sessions = new Set([
    ...peerPromptStore.queuedRecipientIds(),
    ...peerPromptStore.senderIdsOwingNotice(),
    ...delegationFailureNoticeStore.coordinatorsWithPending(),
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
    ...interruptionField(message),
    state: cardState(message.status),
  };
}

/**
 * Why a row's turn never finished, while that still explains its state: an
 * `interrupted` row, or a request whose turn was stopped and is still owed.
 * An answered request drops it — the Stop no longer says anything about it.
 */
function interruptionOf(
  row: Pick<PeerPromptRecord, "status" | "interruptionKind">,
): PeerPromptInterruption | undefined {
  if (!row.interruptionKind) return undefined;
  return row.status === "interrupted" || row.status === "awaiting_response"
    ? row.interruptionKind
    : undefined;
}

function interruptionField(
  row: Pick<PeerPromptRecord, "status" | "interruptionKind">,
): { interruption?: PeerPromptInterruption } {
  const interruption = interruptionOf(row);
  return interruption ? { interruption } : {};
}

/** A batch card's interruption: one of the rows that gave it its state. */
function aggregateInterruption(
  rows: PeerPromptRecord[],
  state: PeerPromptState,
): PeerPromptInterruption | undefined {
  return rows
    .filter((r) => cardState(r.status) === state)
    .map(interruptionOf)
    .find((i) => i !== undefined);
}

/** Broadcast one card-state patch to one session's viewers, keyed by an opaque `messageKey`. */
async function broadcastCardKeyUpdate(
  sessionId: string,
  key: string,
  state: PeerPromptState,
  failureReason?: string,
  interruption?: PeerPromptInterruption,
): Promise<void> {
  try {
    const hub = await getHub();
    hub.broadcastPeerPromptCardUpdate(sessionId, {
      messageKey: key,
      state,
      ...(failureReason ? { failureReason } : {}),
      ...(interruption ? { interruption } : {}),
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
  // Every transition passes here, so the recipient's composer queue follows.
  publishPeerQueue(m.recipientSessionId);
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
      interruptionOf(m),
    ),
    broadcastCardKeyUpdate(
      m.recipientSessionId,
      batchCardKey(effectiveHeadId),
      aggregateState,
      aggregateFailureReason,
      aggregateInterruption(rowsForAggregate, aggregateState),
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

/* ---------------------------- per-peer summary ---------------------------- */

/**
 * The peer prompts involving a session, summed up per other session over the
 * whole history — the inspector's per-peer facts. Its size follows the number
 * of peers, never of messages.
 */
export function peerPromptPeersFor(sessionId: string): PeerPromptPeerSummary[] {
  return peerPromptStore.summarizeByParticipant(sessionId).map((peer) => {
    const direction: "sent" | "received" =
      peer.last.senderSessionId === sessionId ? "sent" : "received";
    const lastInterruption = interruptionOf(peer.last);
    return {
      peerSessionId: peer.peerSessionId,
      title: otherPartyTitle(peer.last, direction),
      sent: peer.sent,
      received: peer.received,
      lastState: cardState(peer.last.status),
      ...(lastInterruption ? { lastInterruption } : {}),
      lastAt: peer.last.createdAt,
      ...(peer.lastFailure?.failureReason
        ? { lastFailureReason: peer.lastFailure.failureReason }
        : {}),
    };
  });
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
      ...interruptionField(r),
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
  const interruption = aggregateInterruption(rows, aggregateState);
  return {
    id: batchCardKey(effectiveHeadId),
    direction: "received",
    message: peerPromptExcerpt(batchMessage(sorted)),
    state: aggregateState,
    responseRequested: rows.some((r) => r.responseRequested),
    ...(sorted[0]?.taskLabel ? { taskTitle: sorted[0].taskLabel } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(interruption ? { interruption } : {}),
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
  pruneDelegationNotices(now - PRUNE_TTL_MS);
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
