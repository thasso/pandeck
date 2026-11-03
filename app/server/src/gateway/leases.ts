/**
 * The gateway's lease table, in memory (`docs/workers.md` "Credentials").
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

/** The upstream credential a lease spends. */
export type LeaseProvider = "claude" | "openai-codex";

/** What a lease is bound to when granted. */
export interface LeaseBinding {
  profileId: string;
  provider: LeaseProvider;
  /** Absolute path of the profile's token file, resolved by the caller. */
  tokenFile: string;
}

export interface LeaseRecord extends LeaseBinding {
  leaseId: string;
  /** Hex SHA-256 of the token's secret bytes. */
  secretHash: string;
  revoked?: RevokeReason;
}

export type LeaseCheck =
  | { ok: true; leaseId: string; binding: LeaseBinding }
  | { ok: false; refusal: "unknown" }
  | { ok: false; refusal: "revoked"; leaseId: string; reason: RevokeReason };

const TOKEN_HEADER = base64url(JSON.stringify({ alg: "none", typ: "JWT" }));
const MAX_BEARER_BYTES = 4096;
const SECRET_BYTES = 32;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const LEASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
  return v === 1 && typeof lease === "string" && LEASE_ID_RE.test(lease)
    ? lease
    : undefined;
}

export class LeaseTable {
  private readonly leases = new Map<
    string,
    { binding: LeaseBinding; secretHash: Buffer; revoked?: RevokeReason }
  >();

  grant(binding: LeaseBinding): { leaseId: string; token: string } {
    const leaseId = randomBytes(16).toString("base64url");
    const secret = randomBytes(SECRET_BYTES);
    this.leases.set(leaseId, {
      binding: { ...binding },
      secretHash: sha256(secret),
    });
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
   * Ends a lease. The id is remembered with its reason so the refusal can name
   * it. Returns false for an id the table never granted.
   */
  revoke(leaseId: string, reason: RevokeReason): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    lease.revoked = reason;
    return true;
  }

  records(): readonly Readonly<LeaseRecord>[] {
    return [...this.leases].map(([leaseId, lease]) => ({
      leaseId,
      secretHash: lease.secretHash.toString("hex"),
      ...lease.binding,
      ...(lease.revoked ? { revoked: lease.revoked } : {}),
    }));
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
