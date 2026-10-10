/**
 * The user's prompt queue: messages sent while a session's turn runs that wait
 * for it to end, then go one by one as its next turns
 * (`docs/steering-and-queueing.md`).
 *
 * The rows stay the user's draft until their turn: editable, reorderable and
 * withdrawable, which is why they live here and not in either harness's own
 * follow-up queue (the Claude CLI's cannot be edited, pi's is lost with the
 * process). A queued message goes AHEAD of anything agents queued for the same
 * session: the idle chain drains it before background completions and peer
 * prompts, and a peer drain defers to it (`promptQueueHasPriority`).
 *
 * Delivery is one message per idle edge. A prompt counts as sent once its user
 * entry is appended, so the drain returns then instead of waiting out the turn,
 * and everything later in the idle chain sees a running session. A Stop pauses
 * the queue rather than feeding it the next message; so does a failed send,
 * which keeps its row with the error.
 */
import { randomUUID } from "node:crypto";
import type {
  PromptAttachment,
  PromptQueueState,
  QueuedPrompt,
  QueuedPromptAttachment,
} from "@assistant/shared";
import {
  WORKTREE_MISSING_BLOCKED_REASON,
  slashCommandApplies,
} from "@assistant/shared";
import { errorText } from "./errors.ts";
import { promptQueueStore } from "./db/promptQueueStore.ts";
import {
  CONTEXT_ONLY_SLASH_COMMANDS,
  hostSlashCommandRunner,
  type SyntheticToolHost,
} from "./hostSlashCommands.ts";
import {
  persistUploadedAttachment,
  readSessionAttachmentBytes,
} from "./sessionAttachments.ts";
import { SessionBusyError } from "./session/runtime/index.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import { findSlashCommand } from "./slashCommands.ts";
import { sessionWorktreeMissing } from "./worktrees/sessionCwd.ts";

/** A driver the queue can prompt and run host commands against. */
export type PromptQueueDriver = RuntimePromptDriver & SyntheticToolHost;
type QueueDriver = PromptQueueDriver;

/** What the queue needs from the hub, injected so this module never imports it. */
export interface PromptQueueHost {
  /** The session's driver, opening its harness if needed. */
  resolve(sessionId: string): Promise<QueueDriver | undefined>;
  /** The session's driver only if its harness is already open. */
  live(sessionId: string): QueueDriver | undefined;
  /** Tell the session's viewers its queue changed. */
  publish(sessionId: string, queue: PromptQueueState): void;
  /** Report a failed queued command to the session's viewers. */
  reportError(sessionId: string, message: string): void;
  /**
   * The queue stopped holding this session's next idle edge (it paused on a
   * failure, or emptied without a turn): offer it to what waited behind it.
   */
  yieldToOthers(sessionId: string): void;
}

let host: PromptQueueHost | undefined;
export function setPromptQueueHost(next: PromptQueueHost | undefined): void {
  host = next;
}

let deliveryStopped = false;
/** A graceful shutdown starts no turn from the queue; rows wait for the next boot. */
export function stopPromptQueueDelivery(): void {
  deliveryStopped = true;
}

/** The session state's queue field; absent when nothing is queued. */
export function promptQueueField(sessionId: string): {
  promptQueue?: PromptQueueState;
} {
  const state = queueState(sessionId);
  return state.items.length > 0 ? { promptQueue: state } : {};
}

/** The stored queue, with the rows whose send is under way marked so. */
function queueState(sessionId: string): PromptQueueState {
  const state = promptQueueStore.state(sessionId);
  return {
    items: state.items.map((item) =>
      sending.has(item.id) ? { ...item, sending: true as const } : item,
    ),
    paused: isHeld(sessionId),
  };
}

/**
 * Nothing is sent from a held queue: one the user paused (a Stop), or one whose
 * next row carries a note — a failed send, or a steer Claude may already have
 * read. Such a row waits for the user to send it explicitly; a message of their
 * own lifts a Stop, never the row's note, since that would send it unasked.
 */
function isHeld(sessionId: string): boolean {
  return (
    promptQueueStore.isPaused(sessionId) ||
    Boolean(promptQueueStore.list(sessionId)[0]?.error)
  );
}

/** Whether a queued message is owed before anything an agent queued. */
export function promptQueueHasPriority(sessionId: string): boolean {
  return promptQueueStore.list(sessionId).length > 0 && !isHeld(sessionId);
}

function publish(sessionId: string): void {
  host?.publish(sessionId, queueState(sessionId));
}

/**
 * A row being sent is no longer the user's to change: the text that reaches
 * the model is the text read when the send began.
 */
function assertNotSending(id: string): void {
  if (sending.has(id)) throw new Error("That message is already being sent.");
}

/* ------------------------------ user commands ----------------------------- */

export function queuePrompt(
  sessionId: string,
  input: {
    text: string;
    attachments?: PromptAttachment[];
    command?: { name: string; rawArgs: string };
  },
  options: {
    paused?: boolean;
    /** Shown on the row until the user resumes, e.g. "may have been read". */
    note?: string;
  } = {},
): void {
  // The bytes go where every other prompt attachment already waits; the row
  // keeps only what the tray renders and the send needs to read them back.
  const attachments: QueuedPromptAttachment[] = (input.attachments ?? []).map(
    (attachment) => {
      persistUploadedAttachment(sessionId, attachment);
      const { data: _data, ...meta } = attachment;
      return meta;
    },
  );
  const id = randomUUID();
  promptQueueStore.append({
    id,
    sessionId,
    text: input.text,
    ...(attachments.length ? { attachments } : {}),
    ...(input.command ? { command: input.command } : {}),
  });
  if (options.note) promptQueueStore.setError(sessionId, id, options.note);
  // Held: the turn it was meant for was stopped, and a Stop sends nothing.
  if (options.paused) promptQueueStore.setPaused(sessionId, true);
  publish(sessionId);
  // The turn the user queued behind may have ended while this was in flight.
  void drainPromptQueue(sessionId);
}

export function updateQueuedPrompt(
  sessionId: string,
  id: string,
  text: string,
): void {
  assertNotSending(id);
  if (promptQueueStore.updateText(sessionId, id, text)) publish(sessionId);
}

export function removeQueuedPrompt(sessionId: string, id: string): void {
  assertNotSending(id);
  if (promptQueueStore.remove(sessionId, id)) settleEmptyQueue(sessionId);
}

export function moveQueuedPrompt(
  sessionId: string,
  id: string,
  toIndex: number,
): void {
  assertNotSending(id);
  if (promptQueueStore.move(sessionId, id, toIndex)) publish(sessionId);
}

/** Everything but a row already being sent, which is past recalling. */
export function clearPromptQueue(sessionId: string): void {
  promptQueueStore.clear(sessionId, sending);
  settleEmptyQueue(sessionId);
}

/** Lift a pause (and clear the failures that caused one) and send what is owed. */
export function resumePromptQueue(sessionId: string): void {
  promptQueueStore.setPaused(sessionId, false);
  // "Send next" vouches for the NEXT row only; a later one with its own note
  // holds the queue again when its turn comes.
  const head = promptQueueStore.list(sessionId)[0];
  if (head?.error) promptQueueStore.clearError(sessionId, head.id);
  publish(sessionId);
  void drainPromptQueue(sessionId);
}

/**
 * The user stopped the running turn. With messages still queued that is
 * "stop", not "next": hold them until the user says otherwise.
 */
export function pausePromptQueueForStop(sessionId: string): void {
  if (promptQueueStore.list(sessionId).length === 0) return;
  if (promptQueueStore.isPaused(sessionId)) return;
  promptQueueStore.setPaused(sessionId, true);
  publish(sessionId);
}

/** The user sent a message of their own: the queue follows it again. */
export function resumePromptQueueForHumanPrompt(sessionId: string): void {
  if (!promptQueueStore.isPaused(sessionId)) return;
  promptQueueStore.setPaused(sessionId, false);
  publish(sessionId);
}

/**
 * Send one queued message now: into the running turn as a steer where the
 * harness takes one, else as the next turn (which resumes a paused queue).
 * A queued command cannot join a turn, so it moves to the front instead.
 */
export async function sendQueuedPromptNow(
  sessionId: string,
  id: string,
): Promise<void> {
  const item = promptQueueStore.get(sessionId, id);
  if (!item) return;
  const driver = host?.live(sessionId);
  if (driver?.isRunning && driver.canSteer && !item.command) {
    if (sending.has(id)) return;
    markSending(sessionId, id, true);
    try {
      await deliverPrompt(driver, item, { steer: true });
    } finally {
      markSending(sessionId, id, false);
    }
    return;
  }
  promptQueueStore.move(sessionId, id, 0);
  resumePromptQueue(sessionId);
}

/** Forget a deleted session's queue; its attachments go with the session. */
export function deleteSessionPromptQueue(sessionId: string): void {
  promptQueueStore.clear(sessionId);
}

/* -------------------------------- delivery -------------------------------- */

/** Queued items whose send is in flight, so no second path sends them again. */
const sending = new Set<string>();
const drainLocks = new Map<string, Promise<void>>();
const drainAuthorityGuards = new Map<string, Set<() => boolean>>();
const rerunAfterDrain = new Set<string>();

/**
 * Send the next queued message if the session is idle and the queue is not
 * held. Coalesces per session; a call during a drain reruns after it, because
 * that drain may already have decided "still running".
 */
export function drainPromptQueue(
  sessionId: string,
  shouldStart: () => boolean = () => true,
): Promise<void> {
  if (deliveryStopped || !host) return Promise.resolve();
  const existing = drainLocks.get(sessionId);
  if (existing) {
    drainAuthorityGuards.get(sessionId)?.add(shouldStart);
    rerunAfterDrain.add(sessionId);
    return existing;
  }
  const guards = new Set([shouldStart]);
  drainAuthorityGuards.set(sessionId, guards);
  const run = drainOnce(sessionId, () =>
    [...guards].every((guard) => guard()),
  ).finally(() => {
    drainLocks.delete(sessionId);
    drainAuthorityGuards.delete(sessionId);
    if (rerunAfterDrain.delete(sessionId))
      void drainPromptQueue(sessionId, () =>
        [...guards].every((guard) => guard()),
      );
  });
  drainLocks.set(sessionId, run);
  return run;
}

/** Offer every queue left over from before a restart. */
export function drainPromptQueuesOnBoot(): void {
  for (const sessionId of promptQueueStore.sessionIds())
    if (!promptQueueStore.isPaused(sessionId)) void drainPromptQueue(sessionId);
}

async function drainOnce(
  sessionId: string,
  shouldStart: () => boolean,
): Promise<void> {
  if (!promptQueueHasPriority(sessionId)) return;
  const driver = await host?.resolve(sessionId).catch(() => undefined);
  // Resolution can cold-acquire a session. Callers coordinating a higher
  // priority delivery may have lost authority while that await was pending.
  if (!shouldStart()) return;
  const head = promptQueueStore.list(sessionId)[0];
  if (!head || deliveryStopped || sending.has(head.id)) return;
  if (!driver) {
    holdOnFailure(sessionId, head, "That session could not be resumed.");
    return;
  }
  if (driver.isRunning || isHeld(sessionId)) return;
  // From here the row is the send's: no await separates reading it from
  // locking it, so an edit or removal on another device is refused rather
  // than silently losing to the text read here.
  markSending(sessionId, head.id, true);
  try {
    if (head.command) await runQueuedCommand(driver, head, head.command);
    else await deliverPrompt(driver, head, {});
  } finally {
    markSending(sessionId, head.id, false);
  }
}

function markSending(sessionId: string, id: string, on: boolean): void {
  if (on) sending.add(id);
  else if (!sending.delete(id)) return;
  if (promptQueueStore.get(sessionId, id)) publish(sessionId);
}

/**
 * Hand one queued prompt to the runtime and resolve once it is IN the session
 * (its user entry appended) or refused — never after the whole turn. Busy is
 * not a failure: the row waits for the next idle edge.
 */
function deliverPrompt(
  driver: QueueDriver,
  item: QueuedPrompt,
  options: { steer?: boolean },
): Promise<void> {
  const { sessionId } = driver;
  let attachments: PromptAttachment[];
  try {
    attachments = loadAttachments(sessionId, item);
  } catch (err) {
    holdOnFailure(sessionId, item, errorText(err));
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let accepted = false;
    const run = promptRuntimeSession(driver, item.text, {
      ...(attachments.length ? { attachments } : {}),
      // One identity per row: a reconnect resend or a second drain of the same
      // row is a duplicate to the runtime, never a second turn.
      clientRequestId: `queued:${item.id}`,
      ...(options.steer ? { steer: true } : {}),
      // Runs inside the runtime's append; nothing here may throw.
      onUserEntry: () => {
        accepted = true;
        try {
          promptQueueStore.remove(sessionId, item.id);
          settleEmptyQueue(sessionId);
        } catch (err) {
          console.warn("[prompt-queue] could not retire a sent row:", err);
        }
        resolve();
      },
    });
    run.then(
      () => resolve(),
      (err: unknown) => {
        if (!accepted && !(err instanceof SessionBusyError))
          holdOnFailure(sessionId, item, errorText(err));
        resolve();
      },
    );
  });
}

/** A queued host command runs as that command when its turn comes. */
async function runQueuedCommand(
  driver: QueueDriver,
  item: QueuedPrompt,
  command: { name: string; rawArgs: string },
): Promise<void> {
  const { sessionId } = driver;
  const cmd = findSlashCommand(command.name);
  const runner = hostSlashCommandRunner(command.name);
  if (
    !cmd ||
    cmd.execution === "client" ||
    !runner ||
    !slashCommandApplies(cmd, driver.agentType, driver.harness)
  ) {
    holdOnFailure(
      sessionId,
      item,
      `/${command.name} is not available for this session.`,
    );
    return;
  }
  if (
    !CONTEXT_ONLY_SLASH_COMMANDS.has(command.name) &&
    sessionWorktreeMissing(sessionId)
  ) {
    holdOnFailure(sessionId, item, WORKTREE_MISSING_BLOCKED_REASON);
    return;
  }
  try {
    await runner(driver, command.rawArgs);
  } catch (err) {
    // Another turn started between the idle check and the command's own:
    // that is busy, not failure, and the row waits for the next idle edge.
    if (err instanceof SessionBusyError) return;
    host?.reportError(
      sessionId,
      `Failed to run /${command.name}: ${errorText(err)}`,
    );
    holdOnFailure(sessionId, item, errorText(err));
    return;
  }
  promptQueueStore.remove(sessionId, item.id);
  settleEmptyQueue(sessionId);
}

function loadAttachments(
  sessionId: string,
  item: QueuedPrompt,
): PromptAttachment[] {
  return (item.attachments ?? []).map((meta) => {
    const stored = readSessionAttachmentBytes(sessionId, meta.id);
    if (!stored) throw new Error(`The attachment ${meta.name} is gone.`);
    return { ...meta, data: stored.bytes.toString("base64") };
  });
}

/** Keep the row with its error and hold the queue there for the user to decide. */
function holdOnFailure(
  sessionId: string,
  item: QueuedPrompt,
  reason: string,
): void {
  if (!promptQueueStore.get(sessionId, item.id)) return;
  console.warn(`[prompt-queue] send to ${sessionId} failed:`, reason);
  promptQueueStore.setError(sessionId, item.id, reason);
  promptQueueStore.setPaused(sessionId, true);
  publish(sessionId);
  // A peer drain that deferred to this row started no turn of its own; with
  // the queue held, nothing else would bring it back.
  host?.yieldToOthers(sessionId);
}

/** An empty queue has nothing left to hold, and owes the next edge to nobody. */
function settleEmptyQueue(sessionId: string): void {
  if (promptQueueStore.list(sessionId).length === 0) {
    promptQueueStore.setPaused(sessionId, false);
    host?.yieldToOthers(sessionId);
  }
  publish(sessionId);
}
