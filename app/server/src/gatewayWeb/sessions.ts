/**
 * The gateway UI's in-memory state (Task-1402): sign-ins waiting for their
 * callback and signed-in sessions, both bounded and on an injected clock. An
 * edge restart forgets both, which signs everyone out.
 */
import { createHash, randomBytes } from "node:crypto";

const MAX_PENDING = 256;
export const PENDING_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 1_024;
const MAX_SESSIONS_PER_USER = 16;
const IDLE_MS = 2 * 60 * 60_000;
export const ABSOLUTE_MS = 12 * 60 * 60_000;

function token(): string {
  return randomBytes(32).toString("base64url");
}

interface Pending<T> {
  cookieId: string;
  value: T;
  createdAt: number;
}

/** What a callback's state and pending cookie lead to. */
export type PendingTake<T> =
  { kind: "ok"; value: T } | { kind: "expired" } | { kind: "failed" };

/**
 * Redirects waiting for their callback, keyed by their state and bound to the
 * browser by a `__Host-` cookie's id: sign-ins between `/auth/login` and
 * `/auth/callback` (`__Host-pgw_signin`), Atlassian connects between their
 * start and `/auth/atlassian/callback` (`__Host-pgw_atlassian`). Each is used
 * once: any callback naming its state removes it.
 */
export class PendingRedirects<T> {
  private readonly entries = new Map<string, Pending<T>>();

  constructor(private readonly now: () => number) {}

  /** The browser's cookie id for `state`, or undefined when full. */
  add(state: string, value: T): string | undefined {
    if (this.entries.size >= MAX_PENDING) this.sweep();
    if (this.entries.size >= MAX_PENDING) return undefined;
    const cookieId = token();
    this.entries.set(state, { cookieId, value, createdAt: this.now() });
    return cookieId;
  }

  take(state: string | null, cookieId: string | undefined): PendingTake<T> {
    const entry = state === null ? undefined : this.entries.get(state);
    if (entry) this.entries.delete(state!);
    // Without its cookie the browser dropped it (Max-Age is the TTL) or never
    // started this redirect; either way, start again.
    if (cookieId === undefined) return { kind: "expired" };
    if (!entry || entry.cookieId !== cookieId) return { kind: "failed" };
    if (this.now() - entry.createdAt >= PENDING_TTL_MS)
      return { kind: "expired" };
    return { kind: "ok", value: entry.value };
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
