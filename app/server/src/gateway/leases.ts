/**
 * The gateway's lease table (`docs/workers.md` "Credentials"), in memory and,
 * when the gateway has a state directory, saved through `persist`.
 *
 * A lease token is JWT-shaped, `base64url(header).base64url(payload).
 * base64url(secret)`, because pi's `openai-codex` provider only accepts a JWT
 * carrying a ChatGPT account id. The third segment, 32 random bytes, is the
 * capability itself: the table keeps only its SHA-256, compares in constant
 * time, and answers with the lease's own profile binding. A request never
 * names its profile.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RevokeReason } from "./refusals.ts";

/** The login providers: the upstream credentials with a token file. */
export type LeaseProvider = "claude" | "openai-codex";

/** A lease on a login: it spends the profile's token file. */
export interface LoginBinding {
  profileId: string;
  provider: LeaseProvider;
  /** Absolute path of the profile's token file, resolved by the caller. */
  tokenFile: string;
}

/**
 * A lease on an OpenAI-compatible account: it spends the endpoint and key the
 * server pushed for this profile (`compatUpstream.ts`), never a token file.
 */
interface EndpointBinding {
  profileId: string;
  provider: "openai-compatible";
}

/** What a lease is bound to when granted. */
export type LeaseBinding = LoginBinding | EndpointBinding;

/**
 * Who holds a lease: its kind names the routes it serves later slices. A
 * lease granted over gateway client 1.0 names its enrolled client
 * (`clientId`); it is spent only through that client's mutual-TLS port.
 */
export type LeaseOwnership =
  /** An engine's: its Worker, and its session once the open names it. */
  | {
      kind: "engine";
      owner: { workerId: string; sessionId?: string; clientId?: string };
    }
  /** The server's own requests, for one server boot or one client. */
  | { kind: "server"; owner: { serverBootId: string; clientId?: string } };

export type LeaseRecord = LeaseBinding &
  LeaseOwnership & {
    leaseId: string;
    /** Hex SHA-256 of the token's secret bytes. */
    secretHash: string;
    /** Epoch milliseconds. */
    grantedAt: number;
    revoked?: RevokeReason;
    /** Epoch milliseconds; set with `revoked`. */
    revokedAt?: number;
  };

/** What `bindSession` did; see there. */
export type BindOutcome =
  "bound" | "unchanged" | "unknown" | "server" | "conflict";

export type LeaseCheck =
  | { ok: true; leaseId: string; binding: LeaseBinding }
  | { ok: false; refusal: "unknown" }
  | { ok: false; refusal: "revoked"; leaseId: string; reason: RevokeReason };

const TOKEN_HEADER = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
const MAX_BEARER_BYTES = 4096;
const SECRET_BYTES = 32;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const LEASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a revoked lease is still named in its refusal. */
const REVOKED_KEPT_MS = 24 * 60 * 60 * 1000;

export function isLeaseId(value: unknown): value is string {
  return typeof value === "string" && LEASE_ID_RE.test(value);
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function sha256(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** The lease id a token's payload names, or undefined for any malformed token. */
function tokenLeaseId(payloadSegment: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
  } catch {
    return undefined;
  }
  const pandeck =
    typeof payload === "object" && payload !== null
      ? (payload as { pandeck?: unknown }).pandeck
      : undefined;
  if (typeof pandeck !== "object" || pandeck === null) return undefined;
  const { v, lease } = pandeck as { v?: unknown; lease?: unknown };
  return v === 1 && isLeaseId(lease) ? lease : undefined;
}

interface Lease {
  binding: LeaseBinding;
  ownership: LeaseOwnership;
  secretHash: Buffer;
  grantedAt: number;
  revoked?: RevokeReason;
  revokedAt?: number;
}

export interface LeaseTableOptions {
  /** Epoch milliseconds; the clock tests inject. */
  now?: (() => number) | undefined;
  /**
   * Saves every record after a change, throwing when it cannot. Without it the
   * table lives in memory only.
   */
  persist?: ((records: LeaseRecord[]) => void) | undefined;
}

/**
 * The leases, keyed by id. With `persist`, a grant or a session bind is saved
 * before it returns and undone in memory when saving throws; a revocation
 * takes effect in memory first and stays in force when saving throws. After a
 * failed save, the next revocation call saves even when it revokes nothing, so
 * a retry fails again or makes the earlier one durable. Revoked leases are
 * pruned 24 h after their revocation, on restore and before each save, so
 * their tokens then get the unknown-lease refusal.
 */
export class LeaseTable {
  private readonly leases = new Map<string, Lease>();
  private readonly now: () => number;
  private readonly persist: ((records: LeaseRecord[]) => void) | undefined;
  /** Whether the last save threw, so memory may be ahead of the file. */
  private unsaved = false;

  constructor(options: LeaseTableOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
  }

  grant(
    binding: LeaseBinding,
    ownership: LeaseOwnership,
  ): { leaseId: string; token: string } {
    const leaseId = randomBytes(16).toString("base64url");
    const secret = randomBytes(SECRET_BYTES);
    this.leases.set(leaseId, {
      binding: { ...binding },
      ownership: copyOwnership(ownership),
      secretHash: sha256(secret),
      grantedAt: this.now(),
    });
    try {
      this.save();
    } catch (err) {
      this.leases.delete(leaseId);
      throw err;
    }
    const payload = base64url(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "pandeck-gateway",
        },
        pandeck: { v: 1, lease: leaseId },
      }),
    );
    return {
      leaseId,
      token: `${TOKEN_HEADER}.${payload}.${secret.toString("base64url")}`,
    };
  }

  /**
   * Completes an engine lease's owner with the session its open named. The
   * same session again changes nothing; another one is a conflict. A revoked
   * lease is unknown here.
   */
  bindSession(leaseId: string, sessionId: string): BindOutcome {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.revoked) return "unknown";
    const { ownership } = lease;
    if (ownership.kind === "server") return "server";
    if (ownership.owner.sessionId !== undefined)
      return ownership.owner.sessionId === sessionId ? "unchanged" : "conflict";
    ownership.owner.sessionId = sessionId;
    try {
      this.save();
    } catch (err) {
      delete ownership.owner.sessionId;
      throw err;
    }
    return "bound";
  }

  /**
   * Ends a lease. The id is remembered with its reason so the refusal can name
   * it. Returns whether this call revoked it: false for an id the table does
   * not hold or a lease already revoked, whose first reason stands.
   */
  revoke(leaseId: string, reason: RevokeReason): boolean {
    return (
      this.revokeWhere((record) => record.leaseId === leaseId, reason).length >
      0
    );
  }

  /**
   * Revokes every live lease `match` selects; answers their ids. Saves when it
   * revoked one or an earlier save failed.
   */
  revokeWhere(
    match: (record: Readonly<LeaseRecord>) => boolean,
    reason: RevokeReason,
  ): string[] {
    const revokedAt = this.now();
    const revoked: string[] = [];
    for (const [leaseId, lease] of this.leases)
      if (!lease.revoked && match(recordOf(leaseId, lease))) {
        lease.revoked = reason;
        lease.revokedAt = revokedAt;
        revoked.push(leaseId);
      }
    if (revoked.length > 0 || this.unsaved) this.save();
    return revoked;
  }

  /** Loads saved records into an empty table, without saving. */
  restore(records: readonly LeaseRecord[]): void {
    for (const record of records) {
      const { leaseId, secretHash, grantedAt, revoked, revokedAt } = record;
      this.leases.set(leaseId, {
        binding:
          record.provider === "openai-compatible"
            ? { profileId: record.profileId, provider: record.provider }
            : {
                profileId: record.profileId,
                provider: record.provider,
                tokenFile: record.tokenFile,
              },
        ownership: copyOwnership(record),
        secretHash: Buffer.from(secretHash, "hex"),
        grantedAt,
        ...(revoked ? { revoked, revokedAt } : {}),
      });
    }
    this.prune();
  }

  records(): LeaseRecord[] {
    return [...this.leases].map(([leaseId, lease]) => recordOf(leaseId, lease));
  }

  /** Whether a lease bound to the profile is still live (renewal's rule). */
  hasLiveLease(profileId: string): boolean {
    for (const lease of this.leases.values())
      if (!lease.revoked && lease.binding.profileId === profileId) return true;
    return false;
  }

  /** Whose a held lease is: the routes beyond its provider's depend on it. */
  kindOf(leaseId: string): LeaseOwnership["kind"] | undefined {
    return this.leases.get(leaseId)?.ownership.kind;
  }

  /** The enrolled client a held lease belongs to, if any. */
  clientOf(leaseId: string): string | undefined {
    return this.leases.get(leaseId)?.ownership.owner.clientId;
  }

  private prune(): void {
    const cutoff = this.now() - REVOKED_KEPT_MS;
    for (const [leaseId, lease] of this.leases)
      if (lease.revokedAt !== undefined && lease.revokedAt <= cutoff)
        this.leases.delete(leaseId);
  }

  private save(): void {
    this.prune();
    this.unsaved = true;
    this.persist?.(this.records());
    this.unsaved = false;
  }

  /**
   * Checks a bearer token from a model request. Never throws on peer input. An
   * unknown id and a wrong secret get the same answer; a revoked lease is named
   * only to a caller holding its secret.
   */
  verify(bearer: string | undefined): LeaseCheck {
    const unknown = { ok: false, refusal: "unknown" } as const;
    if (!bearer || bearer.length > MAX_BEARER_BYTES) return unknown;
    const segments = bearer.split(".");
    if (segments.length !== 3 || !segments.every((s) => SEGMENT_RE.test(s)))
      return unknown;
    const leaseId = tokenLeaseId(segments[1]!);
    if (leaseId === undefined) return unknown;
    const secret = Buffer.from(segments[2]!, "base64url");
    if (secret.length !== SECRET_BYTES) return unknown;
    const lease = this.leases.get(leaseId);
    if (!lease || !timingSafeEqual(sha256(secret), lease.secretHash))
      return unknown;
    if (lease.revoked)
      return { ok: false, refusal: "revoked", leaseId, reason: lease.revoked };
    return { ok: true, leaseId, binding: { ...lease.binding } };
  }
}

function copyOwnership(ownership: LeaseOwnership): LeaseOwnership {
  return ownership.kind === "engine"
    ? { kind: "engine", owner: { ...ownership.owner } }
    : { kind: "server", owner: { ...ownership.owner } };
}

function recordOf(leaseId: string, lease: Lease): LeaseRecord {
  return {
    leaseId,
    secretHash: lease.secretHash.toString("hex"),
    ...lease.binding,
    ...copyOwnership(lease.ownership),
    grantedAt: lease.grantedAt,
    ...(lease.revoked
      ? { revoked: lease.revoked, revokedAt: lease.revokedAt }
      : {}),
  };
}
