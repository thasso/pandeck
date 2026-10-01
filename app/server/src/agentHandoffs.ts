/**
 * Agent handoffs: the one path that tells a session what the user just decided
 * about it.
 *
 * Approving an approval card, answering a question panel, choosing a Task for a
 * pull-request card, accepting a rebase and handing off review comments all end
 * the same way — a prompt that carries the decision to one session. Every one of
 * them used to be a single `promptRuntimeSession` attempt against a session the
 * user was watching, which is exactly when that session is most likely to be
 * MID-TURN. A provider that cannot take mid-turn input (claude-sdk reports
 * `canSteer: false`) answered `SessionBusyError`, the browser showed "Failed to
 * notify the agent …", and the decision reached the agent never: the card said
 * executed, the agent went on believing it was still waiting.
 *
 * So a handoff is never a single attempt. It is delivered NOW when the session
 * can take it — idle, or running behind a provider that steers — and otherwise
 * becomes a durable row (`agentHandoffStore`) delivered on that session's next
 * idle edge, in FIFO order, by {@link drainAgentHandoffs} from the runtime's
 * idle hook. Nothing is re-derived at delivery time: the rendered prompt is
 * stored as it was written, so a card the user later archives cannot change what
 * the agent is told.
 *
 * Three properties are worth stating outright, because each is a choice:
 *
 *  - AT LEAST ONCE, deliberately. The row is dropped inside `onUserEntry` —
 *    the same synchronous step that appends the durable user entry — so a run
 *    that fails afterwards never re-delivers. A process killed BETWEEN those two
 *    writes leaves the row queued and the agent hears the decision twice after
 *    the restart. That is the tolerable side of this trade: the other ordering
 *    (claim, then prompt) loses the decision entirely in the same window, and
 *    losing it is the bug this module exists to fix.
 *  - What became of a handoff is reported through a DURABLE ref, not a
 *    callback. An object that is waiting on the outcome — a pull-request card
 *    that must stop offering a rebase the agent already has — names itself in
 *    `outcomeRef`, and the registered handler runs when the prompt is appended
 *    or when the handoff is finally given up on. A closure would not survive
 *    the restart the row is designed to survive, and a card left advertising an
 *    action that is already running invites the user to start it twice.
 *  - Failure is reported to the caller ONCE, inline. Only `SessionBusyError`
 *    queues; every other refusal is thrown back to whoever asked, which already
 *    reports it against the card or the session.
 */
import { errorText } from "./errors.ts";
import {
  agentHandoffStore,
  type AgentHandoffOrigin,
  type AgentHandoffOutcomeRef,
  type AgentHandoffRecord,
} from "./db/agentHandoffStore.ts";
import { SessionBusyError } from "./session/runtime/index.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";

/**
 * How often a queued handoff may fail for a reason that is NOT busyness (a
 * worktree that is gone, a provider refusing every turn) before it is dropped.
 * Unbounded retries would re-wake a session that cannot take the handoff at all
 * for as long as the row exists.
 */
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * A handoff nobody could deliver for a week is history, not news: the card it
 * belongs to has long since been read, and waking a session with it would say
 * less than the card already says. Swept at boot — and reported, like every
 * other terminal end, to whatever was waiting on it.
 */
const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bounded backoff for a failure that produced no idle edge to ride. */
const RETRY_BASE_BACKOFF_MS = 5_000;
const RETRY_MAX_BACKOFF_MS = 60_000;

export interface AgentHandoffInput {
  sessionId: string;
  /** The rendered prompt; stored verbatim when it has to wait. */
  text: string;
  /** Whose turn this becomes: a card outcome (`system`) or the user's own words. */
  origin: AgentHandoffOrigin;
  /** Model-only context, kept out of the durable transcript on both paths. */
  contextBlock?: string;
  /**
   * The live session, when the caller holds one. Absent means "deliver it
   * whenever you can": the queue resolves the session itself.
   */
  driver?: RuntimePromptDriver;
  /** Visible in the transcript; card outcomes are hidden unless a caller says otherwise. */
  visible?: boolean;
  /**
   * The object to tell when this handoff lands or is given up on, through its
   * {@link registerAgentHandoffOutcome} handler. Durable: it answers after a
   * restart too, which is the whole reason it is a ref and not a closure.
   */
  outcomeRef?: AgentHandoffOutcomeRef;
}

/**
 * What an object waiting on a handoff does with the two answers it can get.
 * `delivered` means the prompt is in the session; `dropped` means nothing will
 * carry it now and the object has to say so where the user will see it.
 */
export interface AgentHandoffOutcomeHandler {
  delivered(ref: AgentHandoffOutcomeRef): void;
  dropped(ref: AgentHandoffOutcomeRef, reason: string): void;
}

const outcomeHandlers = new Map<string, AgentHandoffOutcomeHandler>();

/** Register the handler for one outcome kind (once, at module load). */
export function registerAgentHandoffOutcome(
  kind: string,
  handler: AgentHandoffOutcomeHandler,
): void {
  outcomeHandlers.set(kind, handler);
}

export type AgentHandoffOutcome = "delivered" | "queued";

/** The narrow hub surface delivery needs; see `peerPrompt.ts` for the same seam. */
export interface AgentHandoffHub {
  getLiveById(id: string): unknown;
  acquireById(id: string): Promise<unknown>;
}

let hubOverride: AgentHandoffHub | undefined;
/** Test seam: substitute the hub the drain resolves sessions through. */
export function setAgentHandoffHubForTests(
  hub: AgentHandoffHub | undefined,
): void {
  hubOverride = hub;
}

async function getHub(): Promise<AgentHandoffHub> {
  if (hubOverride) return hubOverride;
  const mod = await import("./hub.ts");
  return mod.hub as unknown as AgentHandoffHub;
}

let deliveryStopped = false;

/**
 * Stop waking sessions from the queue. A graceful shutdown waits for running
 * turns to settle, and every settling turn fires an idle edge: a drain that
 * answered those edges would start fresh turns for as long as the queue is
 * non-empty and the deployment would never finish draining. The rows are
 * durable, so nothing is lost by going quiet — they deliver after the restart.
 */
export function stopAgentHandoffDelivery(): void {
  deliveryStopped = true;
  cancelScheduledRetries();
}

/** Test seam: restore delivery so the module-level flag cannot leak between tests. */
export function setAgentHandoffDeliveryStoppedForTests(stopped: boolean): void {
  deliveryStopped = stopped;
  if (stopped) cancelScheduledRetries();
}

const drainLocks = new Map<string, Promise<void>>();
/** Sessions whose queue changed (or whose turn ended) while a drain was running. */
const rerunAfterDrain = new Set<string>();
/**
 * Rows whose prompt IS in its session but whose delete failed. The decision has
 * landed, so the row must never be prompted again; the drain retries only the
 * delete. In memory: after a restart the row is indistinguishable from an
 * undelivered one, which is the accepted at-least-once window above.
 */
const deliveredPendingRemoval = new Set<number>();

/**
 * Tell whatever is waiting on this handoff how it ended. The handler writes to
 * a card the user is looking at, so a throw there is never allowed to become
 * this queue's failure — or, worse, to abort the turn it is reporting.
 */
function reportOutcome(
  ref: AgentHandoffOutcomeRef | undefined,
  outcome: { kind: "delivered" } | { kind: "dropped"; reason: string },
): void {
  if (!ref) return;
  const handler = outcomeHandlers.get(ref.kind);
  if (!handler) {
    console.warn(`[handoff] no handler registered for outcome ${ref.kind}`);
    return;
  }
  try {
    if (outcome.kind === "delivered") handler.delivered(ref);
    else handler.dropped(ref, outcome.reason);
  } catch (err) {
    console.warn(
      `[handoff] ${ref.kind} outcome handler failed:`,
      errorText(err),
    );
  }
}

/** Delete a row, reporting rather than throwing: the caller is mid-delivery. */
function removeRow(id: number): boolean {
  try {
    agentHandoffStore.remove(id);
    return true;
  } catch (err) {
    console.warn(`[handoff] could not drop handoff ${id}:`, errorText(err));
    return false;
  }
}

/**
 * Hand a decision to its session: delivered inline where the session can take
 * it, queued for the next idle edge where it cannot.
 */
export async function deliverAgentHandoff(
  input: AgentHandoffInput,
): Promise<AgentHandoffOutcome> {
  const { driver } = input;
  // A running session behind a provider that cannot steer has nothing to try:
  // the attempt would append nothing and throw, so it goes straight to the
  // queue rather than through a failure the caller would have to interpret.
  //
  // A session that is ALREADY owed something goes to the back of that queue
  // instead of overtaking it: decisions reach the agent in the order the user
  // made them, whatever the session was doing in between. And during a
  // graceful shutdown nothing is delivered inline either — starting a turn is
  // exactly what the drain is waiting out.
  const worthTrying =
    driver &&
    !(driver.isRunning && !driver.canSteer) &&
    !deliveryStopped &&
    !agentHandoffStore.next(input.sessionId);
  if (worthTrying) {
    let appended = false;
    try {
      await promptRuntimeSession(driver, input.text, {
        ...(input.visible ? {} : { hidden: true }),
        origin: input.origin,
        ...(input.contextBlock ? { contextBlock: input.contextBlock } : {}),
        // Opportunistic: a turn that ended between the check and the call is
        // prompted ordinarily instead (`steerOnly` is what refuses that, and a
        // handoff wants the turn either way).
        ...(driver.isRunning && driver.canSteer ? { steer: true } : {}),
        onUserEntry: () => {
          appended = true;
          reportOutcome(input.outcomeRef, { kind: "delivered" });
        },
      });
      return "delivered";
    } catch (err) {
      if (appended || !(err instanceof SessionBusyError)) throw err;
    }
  }
  queueHandoff(input);
  return "queued";
}

/**
 * Queue a handoff durably WITHOUT starting its delivery. For a caller that owes
 * a session several decisions and must finish producing all of them before the
 * session may take a turn (a batch of auto-approved cards): each decision is
 * safe the moment it exists, and the caller drains once at the end.
 */
export function enqueueAgentHandoff(input: AgentHandoffInput): void {
  agentHandoffStore.enqueue({
    sessionId: input.sessionId,
    origin: input.origin,
    prompt: input.text,
    ...(input.contextBlock ? { contextBlock: input.contextBlock } : {}),
    hidden: !input.visible,
    ...(input.outcomeRef ? { outcomeRef: input.outcomeRef } : {}),
  });
}

function queueHandoff(input: AgentHandoffInput): void {
  enqueueAgentHandoff(input);
  // A session that is running will answer this with its idle hook; one that is
  // merely not live (the user resolved a card from elsewhere) is resumed here,
  // because no idle edge is ever coming for it.
  void drainAgentHandoffs(input.sessionId);
}

/**
 * Deliver what a session is owed, oldest first, without interrupting a turn.
 * Concurrent calls for the same session coalesce: the runtime fires its idle
 * hook from inside the finishing prompt, so the hook's drain lands on the drain
 * that is already running rather than double-admitting a turn.
 */
export function drainAgentHandoffs(sessionId: string): Promise<void> {
  if (deliveryStopped) return Promise.resolve();
  const existing = drainLocks.get(sessionId);
  // Coalescing alone would SWALLOW this call: the drain in flight may already
  // have decided "no session to deliver to" or "still running", and the caller
  // has just changed one of those answers. It is answered after that drain
  // ends instead of being dropped on the floor.
  if (existing) {
    rerunAfterDrain.add(sessionId);
    return existing;
  }
  const run = drainSessionOnce(sessionId).finally(() => {
    drainLocks.delete(sessionId);
    if (rerunAfterDrain.delete(sessionId)) void drainAgentHandoffs(sessionId);
  });
  drainLocks.set(sessionId, run);
  return run;
}

async function drainSessionOnce(sessionId: string): Promise<void> {
  // FIRST, before anything reads the head as work owed: a row whose prompt is
  // already in its session must not be mistaken for an undelivered decision by
  // the failure paths below, which would report it abandoned to a card that has
  // it.
  if (!clearDeliveredRows(sessionId)) return;
  const head = agentHandoffStore.next(sessionId);
  if (!head) return;
  const driver = await resolveDriver(sessionId);
  if (!driver) {
    // A session that cannot be resumed is a DELIVERY failure, not a pause: it
    // produces no idle edge, so an unbudgeted wait here would re-acquire a
    // deleted session every few seconds until the process ended.
    failRow(head, "that session could not be resumed.");
    return;
  }
  for (;;) {
    if (deliveryStopped || driver.isRunning) return;
    if (!clearDeliveredRows(sessionId)) return;
    const row = agentHandoffStore.next(sessionId);
    if (!row) return;
    if (!(await deliverQueued(driver, row))) return;
  }
}

/**
 * Clear the head rows whose prompt already landed and whose delete failed,
 * retrying the DELETE and never the prompt. `false` means the delete still
 * refuses, and the drain stops rather than handing the agent the same decision
 * a second time.
 */
function clearDeliveredRows(sessionId: string): boolean {
  for (;;) {
    const row = agentHandoffStore.next(sessionId);
    if (!row || !deliveredPendingRemoval.has(row.id)) {
      removalFailures.delete(sessionId);
      return true;
    }
    if (!removeRow(row.id)) {
      // Nothing else comes back for a failed DELETE: the turn that delivered
      // this row has ended, so its idle edge is spent, and the row now blocks
      // every later handoff for this session until someone tries again. The
      // retry re-enters here and deletes; it never re-prompts.
      const failures = (removalFailures.get(sessionId) ?? 0) + 1;
      removalFailures.set(sessionId, failures);
      scheduleRetry(sessionId, failures);
      return false;
    }
    deliveredPendingRemoval.delete(row.id);
  }
}

/** One queued handoff. `false` means stop draining this session for now. */
async function deliverQueued(
  driver: RuntimePromptDriver,
  row: AgentHandoffRecord,
): Promise<boolean> {
  let appended = false;
  try {
    await promptRuntimeSession(driver, row.prompt, {
      ...(row.hidden ? { hidden: true } : {}),
      origin: row.origin,
      ...(row.contextBlock ? { contextBlock: row.contextBlock } : {}),
      // Dropped at APPEND time, inside the same synchronous step that records
      // the turn: a run that fails after this must not re-deliver the decision.
      // Nothing in here may throw — this runs inside the runtime's append, and
      // a throw would abort a turn whose user entry already exists.
      onUserEntry: () => {
        appended = true;
        if (!removeRow(row.id)) deliveredPendingRemoval.add(row.id);
        reportOutcome(row.outcomeRef, { kind: "delivered" });
      },
    });
    return true;
  } catch (err) {
    if (appended) return true; // the agent has it; the run failing is its own story
    if (err instanceof SessionBusyError) return false; // the next idle edge takes it
    failRow(row, errorText(err));
    return false;
  }
}

/**
 * One delivery attempt that never reached the session. Spends a unit of the
 * row's budget and schedules the only retry these failures have; the last
 * attempt drops the row and tells whatever was waiting on it.
 */
function failRow(row: AgentHandoffRecord, reason: string): void {
  const attempts = agentHandoffStore.recordAttempt(row.id, reason);
  console.warn(
    `[handoff] delivery to ${row.sessionId} failed (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}):`,
    reason,
  );
  if (attempts < MAX_DELIVERY_ATTEMPTS) {
    // The failure happened BEFORE the runtime started a turn, so it produced no
    // idle edge either. Without this schedule the row would sit until an
    // unrelated event or the next boot.
    scheduleRetry(row.sessionId, attempts);
    return;
  }
  // Only a row that is actually GONE is an abandoned handoff. One that survived
  // its own delete is still queued and can still deliver on a later edge, and a
  // card told "given up on" that then receives the prompt is worse than a card
  // told nothing yet: the next attempt reports the truth either way.
  if (removeRow(row.id)) {
    reportOutcome(row.outcomeRef, { kind: "dropped", reason });
    return;
  }
  // A terminal row that survived its own delete is still there, still blocking
  // the queue behind it, with no event left to come back for it.
  scheduleRetry(row.sessionId, attempts);
}

/**
 * Bounded, in-memory backoff for the failures that leave nothing to ride.
 *
 * A busy session is answered by its own idle edge, and that is the common case.
 * The rest — a worktree held for removal, a session that cannot be resumed
 * right now, a provider refusing the turn before it starts — produce no event
 * at all, and this is the only thing that comes back for them. Bounded by
 * {@link MAX_DELIVERY_ATTEMPTS} through the row itself: each retry that fails
 * spends one attempt, so the schedule cannot outlive the budget — except the
 * delete-only retry, which has no attempt to spend and backs off on its own
 * consecutive-failure count instead. In memory on
 * purpose — the owed fact is durable in the row, and a spent budget defers to
 * the next boot rather than losing anything.
 */
const retryTimers = new Map<string, NodeJS.Timeout>();
/**
 * Consecutive failed DELETEs per session. A delivered row spends no delivery
 * attempts — there is nothing left to attempt — so its retry backs off on this
 * instead of on the row, and a database refusing deletes is asked once a minute
 * rather than every five seconds forever.
 */
const removalFailures = new Map<string, number>();
/** Test seam: collapse the backoff so a retry test does not sleep for seconds. */
let retryDelayMsForTests: number | undefined;
export function setAgentHandoffRetryDelayForTests(
  ms: number | undefined,
): void {
  retryDelayMsForTests = ms;
}

function scheduleRetry(sessionId: string, attempts = 0): void {
  if (deliveryStopped || retryTimers.has(sessionId)) return;
  const delay =
    retryDelayMsForTests ??
    Math.min(RETRY_BASE_BACKOFF_MS * 2 ** attempts, RETRY_MAX_BACKOFF_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(sessionId);
    void drainAgentHandoffs(sessionId).catch(() => {});
  }, delay);
  timer.unref();
  retryTimers.set(sessionId, timer);
}

/** Drop every pending retry, so a shutdown drain cannot be re-driven by one. */
function cancelScheduledRetries(): void {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  removalFailures.clear();
}

async function resolveDriver(
  sessionId: string,
): Promise<RuntimePromptDriver | undefined> {
  const hub = await getHub();
  let live: unknown;
  try {
    live = hub.getLiveById(sessionId) ?? (await hub.acquireById(sessionId));
  } catch (err) {
    console.warn(
      `[handoff] could not resume ${sessionId} to deliver a queued handoff:`,
      errorText(err),
    );
    return undefined;
  }
  return isRuntimePromptDriver(live) ? live : undefined;
}

function isRuntimePromptDriver(
  candidate: unknown,
): candidate is RuntimePromptDriver {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "createRuntimeAdapter" in candidate &&
    "canSteer" in candidate
  );
}

/**
 * Boot: forget handoffs nobody could deliver for a week, then offer the rest to
 * their sessions. A session is resumed for one — the decision it is waiting on
 * is the whole reason the row outlived the process that wrote it.
 */
export function recoverAgentHandoffsOnBoot(
  /** The age at which a handoff expires; a parameter so a test can age one. */
  ttlMs: number = HANDOFF_TTL_MS,
): void {
  const expired = agentHandoffStore.purgeOlderThan(ttlMs);
  if (expired.length > 0) {
    console.log(`[handoff] dropped ${expired.length} expired handoff(s)`);
    // Expiry is a terminal outcome like any other, so it is REPORTED. A card
    // whose handoff quietly evaporated would go on offering an action nobody
    // is carrying out and say nothing about the one that was abandoned.
    for (const row of expired)
      reportOutcome(row.outcomeRef, {
        kind: "dropped",
        reason: "it waited a week without a session that could take it.",
      });
  }
  for (const sessionId of agentHandoffStore.queuedSessionIds())
    void drainAgentHandoffs(sessionId).catch(() => {});
}
