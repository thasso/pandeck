/**
 * A devbox's proof of its owner (Task-1410 PR2): the Google access token
 * Coder holds for the workspace owner, checked with Google before the edge
 * approves an enrollment request without a click.
 *
 * Two calls, in order. Token info (`POST https://oauth2.googleapis.com/
 * tokeninfo`, the token in a form body, never a URL) says whom the token was
 * issued to and how long it lives: `aud` (and `azp` when present) must be
 * Coder's client, `expires_in` an integer of 1-3600 seconds, `scope` must
 * include email, `sub` must be there. The proof stops counting at `notAfter`,
 * the clock read just before sending plus `expires_in`, fixed once. Its
 * `email`, `email_verified` and `hd` are never read. Userinfo (`GET
 * https://openidconnect.googleapis.com/v1/userinfo`, the token as a Bearer)
 * gives the claims the injected allow rule judges, for the same `sub`.
 *
 * A test overrides where to connect, the CA and the deadlines, never the
 * URL, `Host` or TLS name, so the token goes only to those two hosts.
 * Redirects are not followed. Each call is bounded, the whole proof too, and
 * at most `MAX_PROOFS_IN_FLIGHT` run at once (`ProofSlots`). The result never
 * holds a token or upstream text, only a fixed reason and, for the log, an
 * HTTP status, an errno code or a fixed word.
 */
import https from "node:https";

const TOKEN_INFO_HOST = "oauth2.googleapis.com";
const TOKEN_INFO_PATH = "/tokeninfo";
const USER_INFO_HOST = "openidconnect.googleapis.com";
const USER_INFO_PATH = "/v1/userinfo";
/** Each Google call's deadline, connect to last byte. */
const CALL_TIMEOUT_MS = 3_000;
/** The whole proof's deadline. */
const PROOF_TIMEOUT_MS = 6_000;
/** Proofs running at once, at most. */
export const MAX_PROOFS_IN_FLIGHT = 4;
/** A token info or userinfo answer is small; anything larger is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Google's access tokens are at most 2048 bytes. */
const TOKEN_RE = /^[\x21-\x7e]{1,2048}$/;
/** An access token lives an hour at most. */
const MAX_EXPIRES_IN_S = 3_600;
const EMAIL_SCOPES = new Set([
  "email",
  "https://www.googleapis.com/auth/userinfo.email",
]);

/** Where to connect instead of Google's hosts (tests): never the URL. */
interface DevboxEndpoints {
  connect: { host: string; port: number };
  ca?: string | string[];
}

/**
 * Why a proof did not pass. `token_rejected`: Google refused the token, or it
 * is for another client, too long-lived, without the email scope, of another
 * subject at userinfo, or past its `notAfter`. `not_admitted`: the allow rule
 * refused the owner. `unavailable`: no free slot, or Google unreachable, 5xx,
 * redirecting, oversized or too slow.
 */
type DevboxProofReason = "token_rejected" | "not_admitted" | "unavailable";

export type DevboxProofResult =
  | {
      ok: true;
      /** Google's `sub` for the owner. */
      subject: string;
      /** The admitted email, as the allow rule answers it. */
      email: string;
      /** From this instant on the proof no longer counts. */
      notAfter: number;
    }
  | {
      ok: false;
      reason: DevboxProofReason;
      /** An HTTP status, an errno code or a fixed word, for the log. */
      code?: string;
    };

/** The proofs running now; one per edge, shared by every verification. */
export class ProofSlots {
  private running = 0;

  constructor(readonly max = MAX_PROOFS_IN_FLIGHT) {}

  get inFlight(): number {
    return this.running;
  }

  /** Takes a slot, or answers false when all are taken. */
  take(): boolean {
    if (this.running >= this.max) return false;
    this.running += 1;
    return true;
  }

  release(): void {
    if (this.running > 0) this.running -= 1;
  }
}

export interface DevboxProofDeps {
  /** The OAuth client id Coder signs its users in with. */
  googleClientId: string;
  /** The allow rule on userinfo's claims: the admitted email, or undefined. */
  admit(claims: Record<string, unknown>): string | undefined;
  /** The clock `notAfter` is read from; the registry's. */
  now(): number;
  slots: ProofSlots;
  /** Aborts the proof (the caller's connection ended); `unavailable`. */
  signal?: AbortSignal;
  /** Test seam: where both hosts are reached. */
  endpoints?: DevboxEndpoints;
  /** Test seam: each call's deadline (3 s) and the proof's (6 s). */
  timeouts?: { callMs?: number; proofMs?: number };
}

type HttpAnswer =
  | { kind: "answer"; status: number; body: string }
  | { kind: "unreachable"; code: string };

function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "network";
}

/**
 * One bounded HTTPS request to a fixed Google host; never rejects. Ends with
 * `timeout` at its own deadline, with the reason `abort` gives when `abort`
 * fires; either destroys the request.
 */
function call(
  host: typeof TOKEN_INFO_HOST | typeof USER_INFO_HOST,
  request: {
    method: "GET" | "POST";
    path: string;
    headers: Record<string, string | number>;
    body?: string;
  },
  deps: DevboxProofDeps,
  abort: AbortSignal,
): Promise<HttpAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = (): void =>
      settle({
        kind: "unreachable",
        code: typeof abort.reason === "string" ? abort.reason : "aborted",
      });
    const settle = (answer: HttpAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.removeEventListener("abort", onAbort);
      req.destroy();
      resolve(answer);
    };
    const endpoints = deps.endpoints;
    const req = https.request({
      host: endpoints?.connect.host ?? host,
      port: endpoints?.connect.port ?? 443,
      servername: host,
      ...(endpoints?.ca ? { ca: endpoints.ca } : {}),
      agent: false,
      method: request.method,
      path: request.path,
      headers: { ...request.headers, Host: host },
    });
    req.on("error", (err) =>
      settle({ kind: "unreachable", code: errnoOf(err) }),
    );
    const timer = setTimeout(
      () => settle({ kind: "unreachable", code: "timeout" }),
      deps.timeouts?.callMs ?? CALL_TIMEOUT_MS,
    );
    if (abort.aborted) onAbort();
    else abort.addEventListener("abort", onAbort, { once: true });
    req.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        settle({ kind: "unreachable", code: "redirect" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES)
          settle({ kind: "unreachable", code: "oversize" });
        else chunks.push(chunk);
      });
      response.on("aborted", () =>
        settle({ kind: "unreachable", code: "aborted" }),
      );
      response.on("error", (err) =>
        settle({ kind: "unreachable", code: errnoOf(err) }),
      );
      response.on("end", () =>
        settle({
          kind: "answer",
          status,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    if (!settled) req.end(request.body);
  });
}

function record(body: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `expires_in` as a whole number of seconds, 1-3600; a string or a number. */
function expiresIn(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]{1,5}$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(seconds) &&
    seconds >= 1 &&
    seconds <= MAX_EXPIRES_IN_S
    ? seconds
    : undefined;
}

/**
 * What token info vouches for, taking only `aud`, `azp`, `expires_in`, `sub`
 * and `scope`; undefined when any is missing or wrong.
 */
function decodeTokenInfo(
  body: string,
  clientId: string,
): { subject: string; expiresInS: number } | undefined {
  const info = record(body);
  if (!info) return undefined;
  const { aud, azp, expires_in, sub, scope } = info;
  if (aud !== clientId) return undefined;
  if (azp !== undefined && azp !== clientId) return undefined;
  const expiresInS = expiresIn(expires_in);
  if (expiresInS === undefined) return undefined;
  if (typeof sub !== "string" || sub === "") return undefined;
  if (
    typeof scope !== "string" ||
    !scope.split(" ").some((entry) => EMAIL_SCOPES.has(entry))
  )
    return undefined;
  return { subject: sub, expiresInS };
}

/**
 * A call that did not answer 200: `unavailable` for the network, a redirect,
 * an oversized answer and 5xx; any other status rejects the token.
 */
function failure(answer: HttpAnswer): DevboxProofResult {
  if (answer.kind === "unreachable")
    return { ok: false, reason: "unavailable", code: answer.code };
  return {
    ok: false,
    reason: answer.status >= 500 ? "unavailable" : "token_rejected",
    code: String(answer.status),
  };
}

/**
 * Checks `token` with Google and the allow rule; never rejects. Holds the
 * token only for these two calls, in a form body and a header.
 */
export async function verifyDevboxProof(
  token: string,
  deps: DevboxProofDeps,
): Promise<DevboxProofResult> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "token_rejected" };
  if (!deps.slots.take())
    return { ok: false, reason: "unavailable", code: "busy" };
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort("timeout"),
    deps.timeouts?.proofMs ?? PROOF_TIMEOUT_MS,
  );
  const onCallerAbort = (): void => deadline.abort("aborted");
  if (deps.signal?.aborted) onCallerAbort();
  else deps.signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const body = new URLSearchParams({ access_token: token }).toString();
    const sentAt = deps.now();
    const info = await call(
      TOKEN_INFO_HOST,
      {
        method: "POST",
        path: TOKEN_INFO_PATH,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          accept: "application/json",
        },
        body,
      },
      deps,
      deadline.signal,
    );
    if (info.kind !== "answer" || info.status !== 200) return failure(info);
    const vouched = decodeTokenInfo(info.body, deps.googleClientId);
    if (!vouched) return { ok: false, reason: "token_rejected" };
    const notAfter = sentAt + vouched.expiresInS * 1_000;

    const user = await call(
      USER_INFO_HOST,
      {
        method: "GET",
        path: USER_INFO_PATH,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      },
      deps,
      deadline.signal,
    );
    if (user.kind !== "answer" || user.status !== 200) return failure(user);
    const claims = record(user.body);
    if (!claims || claims.sub !== vouched.subject)
      return { ok: false, reason: "token_rejected" };
    if (deps.now() >= notAfter) return { ok: false, reason: "token_rejected" };
    const email = deps.admit(claims);
    if (email === undefined) return { ok: false, reason: "not_admitted" };
    return { ok: true, subject: vouched.subject, email, notAfter };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onCallerAbort);
    deps.slots.release();
  }
}
