/**
 * The enrollment port's approval routes (Task-1410): what `/enroll/start`
 * and `/enroll/poll` accept, and the per-request poll limiter. The routes
 * themselves live in `clientListener.ts`, the requests in `clientRegistry.ts`.
 */
import { clientPublicKey } from "./x509.ts";
import {
  MAX_RETAINED_REQUESTS,
  isHash,
  isRequestId,
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

interface StartBody {
  /** The key re-exported as SPKI PEM, not the text sent. */
  publicKeyPem: string;
  mcpTokenHash: string;
  name: string;
  kind: EnrollmentKind;
}

/**
 * A start's body, checked: an EC P-256 public key, the token's hash as 64
 * lowercase hex, a name of 1-64 shown characters after trimming, and a kind
 * of `devbox`, `laptop` or `other` (`other` when absent). Undefined for any
 * other body.
 */
export function decodeStart(body: unknown): StartBody | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { publicKeyPem, mcpTokenHash, name, kind } = body as Record<
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
  const key = clientPublicKey(publicKeyPem);
  if (!key) return undefined;
  return {
    publicKeyPem: key.export({ type: "spki", format: "pem" }) as string,
    mcpTokenHash,
    name: shown,
    kind: (kind as EnrollmentKind | undefined) ?? "other",
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
