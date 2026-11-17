/**
 * The enrollment port's approval routes (Task-1410): what `/enroll/start`
 * and `/enroll/poll` accept, why a devbox's start was not approved
 * automatically, and the per-request poll limiter. The routes themselves live
 * in `clientListener.ts`, the requests in `clientRegistry.ts`.
 */
import { clientPublicKey } from "./x509.ts";
import {
  MAX_RETAINED_REQUESTS,
  isHash,
  isRequestId,
  type AutomaticOutcome,
  type EnrollmentKind,
} from "./clientRegistry.ts";

/** The fastest a machine may poll one request. */
export const POLL_INTERVAL_MS = 4_000;
/** The interval a start tells the machine to poll at, in seconds. */
export const POLL_ADVICE_SECONDS = 5;
const MAX_NAME = 64;
const KINDS: readonly EnrollmentKind[] = ["devbox", "laptop", "other"];
/** Control, format (bidi overrides among them) and line separators. */
const UNSHOWN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** A Google access token: 1-2048 printable ASCII characters, no spaces. */
const GOOGLE_TOKEN_RE = /^[\x21-\x7e]{1,2048}$/;

interface StartBody {
  /** The key re-exported as SPKI PEM, not the text sent. */
  publicKeyPem: string;
  mcpTokenHash: string;
  name: string;
  kind: EnrollmentKind;
  /** A devbox's proof (Task-1410 PR2): its owner's Google access token. */
  devboxToken?: string;
}

/**
 * Why a start with a devbox proof was left to the page, the only text about
 * the proof its answer holds.
 */
export type AutomaticRefused =
  | "not_configured"
  | "token_rejected"
  | "not_admitted"
  | "claim_pending"
  | "already_used"
  | "limit"
  | "unavailable";

/**
 * A refused `approveAutomatically`, as the start answers it: an expired
 * proof is a rejected token, and a request the page decided or that expired
 * while the proof ran (`unknown`) is `unavailable` (the requester's ruling on
 * Task-1410 PR2).
 */
export function registryRefused(
  status: Exclude<AutomaticOutcome["status"], "approved">,
): AutomaticRefused {
  switch (status) {
    case "expired":
      return "token_rejected";
    case "unknown":
      return "unavailable";
    default:
      return status;
  }
}

/**
 * A start's body, checked: an EC P-256 public key, the token's hash as 64
 * lowercase hex, a name of 1-64 shown characters after trimming, a kind of
 * `devbox`, `laptop` or `other` (`other` when absent), and an optional
 * `devbox: {googleAccessToken}` of 1-2048 printable ASCII characters without
 * spaces. Undefined for any other body.
 */
export function decodeStart(body: unknown): StartBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { publicKeyPem, mcpTokenHash, name, kind, devbox } = body as Record<
    string,
    unknown
  >;
  if (typeof publicKeyPem !== "string" || !isHash(mcpTokenHash))
    return undefined;
  if (typeof name !== "string") return undefined;
  const shown = name.trim();
  if (!shown || [...shown].length > MAX_NAME || UNSHOWN.test(shown))
    return undefined;
  if (kind !== undefined && !KINDS.includes(kind as EnrollmentKind))
    return undefined;
  let devboxToken: string | undefined;
  if (devbox !== undefined) {
    if (typeof devbox !== "object" || devbox === null) return undefined;
    const token = (devbox as Record<string, unknown>).googleAccessToken;
    if (typeof token !== "string" || !GOOGLE_TOKEN_RE.test(token))
      return undefined;
    devboxToken = token;
  }
  const key = clientPublicKey(publicKeyPem);
  if (!key) return undefined;
  return {
    publicKeyPem: key.export({ type: "spki", format: "pem" }) as string,
    mcpTokenHash,
    name: shown,
    kind: (kind as EnrollmentKind | undefined) ?? "other",
    ...(devboxToken !== undefined ? { devboxToken } : {}),
  };
}

/** A poll's request id, if the body holds one of the right shape. */
export function decodePoll(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { requestId } = body as Record<string, unknown>;
  return isRequestId(requestId) ? requestId : undefined;
}

/**
 * Admits at most one poll per known request every `POLL_INTERVAL_MS`. Its
 * keys are the hashes of retained requests only (an unknown id never reaches
 * it), an entry is dropped once its interval has passed, and it holds at most
 * `capacity` entries, by default the bound on retained records. Full, it
 * admits nothing new and allocates nothing; recent receipt churn can therefore
 * briefly cause `slow_down` for another retained request.
 */
export class PollLimiter {
  private readonly last = new Map<string, number>();

  constructor(private readonly capacity = MAX_RETAINED_REQUESTS) {}

  /** Whether a poll of the request `key` may run now. */
  admit(key: string, now: number): boolean {
    for (const [entry, at] of this.last)
      if (now - at >= POLL_INTERVAL_MS || now < at) this.last.delete(entry);
    if (this.last.has(key)) return false;
    if (this.last.size >= this.capacity) return false;
    this.last.set(key, now);
    return true;
  }

  /** Entries held; for tests. */
  get size(): number {
    return this.last.size;
  }
}
