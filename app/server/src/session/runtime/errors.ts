/**
 * Typed runtime errors. `prompt` rejects with these so the transport can deliver
 * a precise, private error to the originating client.
 */

/** A prompt arrived while a run was already in flight (one run per session). */
export class SessionBusyError extends Error {
  constructor(sessionId: string, message?: string) {
    super(message ?? `Session ${sessionId} is busy with an active run.`);
    this.name = "SessionBusyError";
  }
}

/**
 * A steer the provider held was dropped because its turn ended first (the user
 * stopped it, or it failed). Busy to anything with its own queue; the one who
 * typed it gets it back rather than losing it.
 */
export class SteerWithdrawnError extends SessionBusyError {
  /**
   * @param uncertain The provider never confirmed the message was dropped
   * unread: it may have been read, so handing it back must say so.
   */
  constructor(
    sessionId: string,
    readonly uncertain = false,
  ) {
    super(sessionId);
    this.name = "SteerWithdrawnError";
    this.message = `Session ${sessionId} ended its turn before reading the steer.`;
  }
}

/**
 * A `steerOnly` prompt found no running turn to join, so nothing was sent and
 * nothing was appended. The opposite of {@link SessionBusyError}: the session was
 * not busy enough. Callers are expected to fall back to an ordinary delivery.
 */
export class SteerNotTakenError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} had no running turn to steer.`);
    this.name = "SteerNotTakenError";
  }
}

/**
 * A run resolved with `stopReason: "error"`. The user entry is already durably
 * persisted; the run-state still returns to idle (this throws after the finally).
 */
export class RunFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RunFailedError";
  }
}

/** An operation targeted a session that is not live in the runtime. */
export class InactiveSessionError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is not active in the runtime.`);
    this.name = "InactiveSessionError";
  }
}
