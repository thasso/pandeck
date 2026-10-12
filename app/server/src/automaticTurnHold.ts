/**
 * Stop stays stopped: the hold a human Stop puts on a session's AUTOMATIC
 * turns (`docs/steering-and-queueing.md`).
 *
 * Stopping a turn used to pause only the user's own queue. Everything else that
 * waits for a session's idle edge — peer prompts, background completions,
 * approval outcomes and other handoffs — took the edge the Stop produced, and a
 * peer drain already awaiting the stopped turn simply claimed its next batch:
 * one session took 35 aborted turns in 29 seconds, each Stop admitting the
 * next delivery.
 *
 * The hold is durable (`session_automatic_turn_hold`), so a release, reload or
 * restart cannot lift it. It is enforced where every run passes
 * (`runtimePrompt.ts` refuses a non-human origin), and each automatic drain
 * also checks it before it claims or cold-resumes anything, so held work is
 * never claimed, retried or consumed: it waits in its own store. Only the user
 * lifts it — Resume, a send-now, or a human prompt reaching the session —
 * never a peer message, a background fact, an approval or an idle edge.
 */
import type { PromptOrigin } from "@assistant/shared/session";
import { automaticTurnHoldStore } from "./db/automaticTurnHoldStore.ts";
import { SessionBusyError } from "./session/runtime/errors.ts";

/**
 * An automatic turn refused because the session is held. It IS busy to every
 * caller: each one already keeps its work for a later idle edge on
 * `SessionBusyError` instead of spending a retry or dropping it.
 */
export class AutomaticTurnsHeldError extends SessionBusyError {
  constructor(sessionId: string) {
    super(
      sessionId,
      `Session ${sessionId} was stopped; automatic turns wait until it is resumed.`,
    );
    this.name = "AutomaticTurnsHeldError";
  }
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

/** Anything that is not the user's own words. */
export function isAutomaticOrigin(origin: PromptOrigin | undefined): boolean {
  return (origin?.kind ?? "human") !== "human";
}

/** The user pressed Stop. Persisted before the turn is aborted. */
export function holdAutomaticTurns(sessionId: string): void {
  if (automaticTurnHoldStore.isHeld(sessionId)) return;
  automaticTurnHoldStore.hold(sessionId);
  host?.changed(sessionId);
}

/**
 * The user resumed the session explicitly: lift the hold and offer it the idle
 * edge everything held is waiting for. `false` when nothing was held.
 */
export function resumeAutomaticTurns(sessionId: string): boolean {
  if (!automaticTurnHoldStore.release(sessionId)) return false;
  host?.changed(sessionId);
  host?.resumed(sessionId);
  return true;
}

/**
 * The user's own words reached the session (or they chose one waiting message
 * to send now). The turn that carries them ends in an idle edge of its own, so
 * nothing is offered here: a drain started now would race that turn for it.
 */
export function releaseAutomaticTurnsForHumanPrompt(sessionId: string): void {
  if (automaticTurnHoldStore.release(sessionId)) host?.changed(sessionId);
}

/** Refuse an automatic turn while the session is held. */
export function assertAutomaticTurnAllowed(
  sessionId: string,
  origin: PromptOrigin | undefined,
): void {
  if (isAutomaticOrigin(origin) && automaticTurnHoldStore.isHeld(sessionId))
    throw new AutomaticTurnsHeldError(sessionId);
}

/** Forget a deleted session's hold. */
export function deleteAutomaticTurnHold(sessionId: string): void {
  automaticTurnHoldStore.release(sessionId);
}
