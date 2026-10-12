/**
 * Stop stays stopped: the hold a human Stop puts on every turn the user did not
 * just ask for (`docs/steering-and-queueing.md`).
 *
 * Stopping a turn used to pause only the user's own queue. Everything else that
 * waits for a session's idle edge — peer prompts, background completions,
 * approval outcomes and other handoffs — took the edge the Stop produced, and a
 * peer drain already awaiting the stopped turn simply claimed its next batch:
 * one session took 35 aborted turns in 29 seconds, each Stop admitting the
 * next delivery.
 *
 * The hold is durable (`session_automatic_turn_hold`), so a release, reload or
 * restart cannot lift it. While it stands, `runtimePrompt.ts` refuses EVERY
 * turn — automatic ones, and the user's own older work queued for later (their
 * drafts, the permanent Assistant's intake) — unless it carries a
 * {@link HumanResumeToken} for the current hold. Each automatic drain also
 * checks it before it claims or cold-resumes anything, so held work is never
 * claimed, retried or consumed: it waits in its own store.
 *
 * Only the user lifts it. Resume does so at once; a message they send right now
 * does so once it is appended as a turn of its own. Both are tied to the hold's
 * GENERATION as it stood when the user acted, and every Stop starts a new one,
 * so an authorization that a newer Stop overtook resumes nothing. Peer
 * messages, background facts, approvals, reconnects and idle edges carry no
 * authorization at all.
 */
import { automaticTurnHoldStore } from "./db/automaticTurnHoldStore.ts";
import { backgroundDeliveryOutboxStore } from "./db/backgroundDeliveryOutboxStore.ts";
import { SessionBusyError } from "./session/runtime/errors.ts";

/**
 * A turn refused because the session is held. It IS busy to every caller: each
 * one already keeps its work for a later idle edge on `SessionBusyError`
 * instead of spending a retry or dropping it.
 */
export class AutomaticTurnsHeldError extends SessionBusyError {
  constructor(sessionId: string) {
    super(
      sessionId,
      `Session ${sessionId} was stopped; nothing is sent until it is resumed.`,
    );
    this.name = "AutomaticTurnsHeldError";
  }
}

/**
 * The user's authority to resume, captured AT the moment they acted (sent a
 * message, chose a waiting one) and spent later, once the work it authorizes
 * is accepted. `generation` is the hold that stood then, or null when none did.
 */
export interface HumanResumeToken {
  readonly sessionId: string;
  readonly generation: number | null;
}

/** What the hold needs from the hub, injected so this module never imports it. */
export interface AutomaticTurnHoldHost {
  /** Tell the session's viewers the hold changed. */
  changed(sessionId: string): void;
  /** The user resumed: offer the session its idle edge again. */
  resumed(sessionId: string): void;
}

let host: AutomaticTurnHoldHost | undefined;
export function setAutomaticTurnHoldHost(
  next: AutomaticTurnHoldHost | undefined,
): void {
  host = next;
}

export function automaticTurnsHeld(sessionId: string): boolean {
  return automaticTurnHoldStore.isHeld(sessionId);
}

/** Capture the user's resume authority as the session stands right now. */
export function captureHumanResume(sessionId: string): HumanResumeToken {
  return {
    sessionId,
    generation: automaticTurnHoldStore.generation(sessionId) ?? null,
  };
}

/**
 * The user pressed Stop. Persisted before the turn is aborted, under a new
 * generation even when already held.
 */
export function holdAutomaticTurns(sessionId: string): void {
  const wasHeld = automaticTurnHoldStore.isHeld(sessionId);
  automaticTurnHoldStore.hold(sessionId);
  // What the session is owed now waits on the user, so it must outlive a
  // restart until it is delivered — also after they resume (a completion that
  // arrives later is retained as it is saved, while the hold stands).
  backgroundDeliveryOutboxStore.retainSession(sessionId);
  if (!wasHeld) host?.changed(sessionId);
}

/**
 * The user pressed Resume: lift the hold and offer the idle edge everything
 * held is waiting for. `false` when nothing was held.
 */
export function resumeAutomaticTurns(sessionId: string): boolean {
  if (!automaticTurnHoldStore.release(sessionId)) return false;
  host?.changed(sessionId);
  host?.resumed(sessionId);
  return true;
}

/**
 * Spend a resume authority: lift the hold it was captured under, and nothing
 * newer. Called once the work it authorized is accepted — a turn appended, an
 * intake row stored, a chosen message claimed — never for a refusal. Nothing is
 * offered: the work it accepted brings an idle edge of its own.
 */
export function spendHumanResume(token: HumanResumeToken): boolean {
  if (token.generation === null) return false;
  if (
    !automaticTurnHoldStore.releaseGeneration(token.sessionId, token.generation)
  )
    return false;
  host?.changed(token.sessionId);
  return true;
}

/**
 * Refuse a turn while the session is held, unless the user authorized it under
 * the hold that stands now.
 */
export function assertTurnAllowed(
  sessionId: string,
  resume: HumanResumeToken | undefined,
): void {
  const generation = automaticTurnHoldStore.generation(sessionId);
  if (generation === undefined) return;
  if (resume?.sessionId === sessionId && resume.generation === generation)
    return;
  throw new AutomaticTurnsHeldError(sessionId);
}

/** Forget a deleted session's hold. */
export function deleteAutomaticTurnHold(sessionId: string): void {
  automaticTurnHoldStore.release(sessionId);
}
