/**
 * The gateway UI's in-memory state (Task-1402): sign-ins waiting for their
 * callback and signed-in sessions, both bounded and on an injected clock. An
 * edge restart forgets both, which signs everyone out.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AuthorizationRequest } from "./oidc.ts";

const MAX_PENDING = 256;
export const PENDING_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 1_024;
const MAX_SESSIONS_PER_USER = 16;
const IDLE_MS = 2 * 60 * 60_000;
export const ABSOLUTE_MS = 12 * 60 * 60_000;

function token(): string {
  return randomBytes(32).toString("base64url");
}

interface Pending {
  signinId: string;
  request: AuthorizationRequest;
  createdAt: number;
}

/** What a callback's state and sign-in cookie lead to. */
export type PendingTake =
  | { kind: "ok"; request: AuthorizationRequest }
  | { kind: "expired" }
  | { kind: "failed" };

/**
 * Sign-ins between `/auth/login` and `/auth/callback`, keyed by their state
 * and bound to the browser by the `__Host-pgw_signin` cookie's id. Each is
 * used once: any callback naming its state removes it.
 */
export class PendingSignins {
  private readonly entries = new Map<string, Pending>();

  constructor(private readonly now: () => number) {}

  /** The browser's sign-in id for `request`, or undefined when full. */
  add(request: AuthorizationRequest): string | undefined {
    if (this.entries.size >= MAX_PENDING) this.sweep();
    if (this.entries.size >= MAX_PENDING) return undefined;
    const signinId = token();
    this.entries.set(request.state, {
      signinId,
      request,
      createdAt: this.now(),
    });
    return signinId;
  }

  take(state: string | null, signinId: string | undefined): PendingTake {
    const entry = state === null ? undefined : this.entries.get(state);
    if (entry) this.entries.delete(state!);
    // Without its cookie the browser dropped it (Max-Age is the TTL) or never
    // started this sign-in; either way, start again.
    if (signinId === undefined) return { kind: "expired" };
    if (!entry || entry.signinId !== signinId) return { kind: "failed" };
    if (this.now() - entry.createdAt >= PENDING_TTL_MS)
      return { kind: "expired" };
    return { kind: "ok", request: entry.request };
  }

  private sweep(): void {
    for (const [state, entry] of this.entries)
      if (this.now() - entry.createdAt >= PENDING_TTL_MS)
        this.entries.delete(state);
  }
}

interface Session {
  userId: string;
  /** The session as a login actor; random, never the cookie or its hash. */
  actorId: string;
  createdAt: number;
  lastSeenAt: number;
}

/** A live session's user and its login actor. */
export interface SessionRef {
  userId: string;
  actorId: string;
}

/**
 * Signed-in sessions, kept by the SHA-256 of their cookie value: 2 h idle,
 * 12 h absolute, 1,024 in all and 16 per user (the oldest dropped).
 *
 * Every session that leaves the table, however (sign-out, expiry found by a
 * lookup, `live` or the sweep, eviction by a newer one), is reported to
 * `onEnded` exactly once, with its actor id.
 */
export class Sessions {
  private readonly entries = new Map<string, Session>();
  /** Actor id → the entry's key. */
  private readonly actors = new Map<string, string>();

  constructor(
    private readonly now: () => number,
    private readonly onEnded: (actorId: string) => void = () => {},
  ) {}

  /** Whether the table is full after dropping expired sessions. */
  full(): boolean {
    if (this.entries.size >= MAX_SESSIONS) this.sweep();
    return this.entries.size >= MAX_SESSIONS;
  }

  /** A new session's cookie value, or undefined when the table is full. */
  create(userId: string): string | undefined {
    this.full();
    const own = [...this.entries].filter(([, s]) => s.userId === userId);
    if (own.length >= MAX_SESSIONS_PER_USER) {
      own.sort(([, a], [, b]) => a.createdAt - b.createdAt);
      for (const [key] of own.slice(0, own.length - MAX_SESSIONS_PER_USER + 1))
        this.remove(key);
    }
    if (this.entries.size >= MAX_SESSIONS) return undefined;
    const value = token();
    const at = this.now();
    const key = hashOf(value);
    const actorId = token();
    this.entries.set(key, {
      userId,
      actorId,
      createdAt: at,
      lastSeenAt: at,
    });
    this.actors.set(actorId, key);
    return value;
  }

  /** The session's user and actor, marking it seen; undefined once expired. */
  lookup(value: string | undefined): SessionRef | undefined {
    if (value === undefined) return undefined;
    const key = hashOf(value);
    const session = this.entries.get(key);
    if (!session) return undefined;
    if (this.expired(session)) {
      this.remove(key);
      return undefined;
    }
    session.lastSeenAt = this.now();
    return { userId: session.userId, actorId: session.actorId };
  }

  /** Whether the actor's session is live; never marks it seen. */
  live(actorId: string): boolean {
    const key = this.actors.get(actorId);
    const session = key === undefined ? undefined : this.entries.get(key);
    if (!session) return false;
    if (this.expired(session)) {
      this.remove(key!);
      return false;
    }
    return true;
  }

  /** Ends the session; answers its user, if it was live. */
  end(value: string | undefined): string | undefined {
    const userId = this.lookup(value)?.userId;
    if (value !== undefined) this.remove(hashOf(value));
    return userId;
  }

  /** Drops every expired session. */
  sweep(): void {
    for (const [key, session] of [...this.entries])
      if (this.expired(session)) this.remove(key);
  }

  private remove(key: string): void {
    const session = this.entries.get(key);
    if (!session) return;
    this.entries.delete(key);
    this.actors.delete(session.actorId);
    this.onEnded(session.actorId);
  }

  private expired(session: Session): boolean {
    const at = this.now();
    return (
      at - session.lastSeenAt >= IDLE_MS ||
      at - session.createdAt >= ABSOLUTE_MS
    );
  }
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
