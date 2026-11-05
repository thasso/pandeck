/**
 * Reads a profile's upstream credential for one forwarded request or renewal
 * (`docs/workers.md` "Renewal").
 *
 * The token file is opened read-only on every read: no caching. Besides the
 * headers a read answers the expiry, the file's identity (the descriptor's
 * `fstat`, which a rename or rewrite changes) and the access token and Claude
 * refresh token, kept in memory only, for renewal and the 401 comparison. A
 * missing or malformed file is read twice more, 50 ms apart, because pi's
 * other writers rewrite `auth.json` in place. Only renewal writes token
 * files (`renewal.ts`). An error never carries the file's text, which can
 * hold a token.
 */
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { LeaseProvider } from "./leases.ts";
import type { CredentialProblem } from "./refusals.ts";

/** What changes when a token file is replaced or rewritten. */
export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export type CredentialRead =
  | {
      ok: true;
      headers: Record<string, string>;
      /** The access token the headers carry. */
      token: string;
      /** Claude's refresh token and stored scopes; absent for Codex. */
      refreshToken?: string;
      scopes?: unknown;
      /** Epoch milliseconds; undefined when not a finite number. */
      expiresAt: number | undefined;
      identity: FileIdentity;
    }
  | { ok: false; problem: CredentialProblem; identity?: FileIdentity };

/** A token goes into a header verbatim, so it must be a visible ASCII run. */
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;
const REREADS = 2;
const REREAD_DELAY_MS = 50;

export function sameIdentity(
  a: FileIdentity | undefined,
  b: FileIdentity | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function headerValue(value: unknown): string | undefined {
  return typeof value === "string" && HEADER_SAFE_RE.test(value)
    ? value
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

async function readOnce(
  provider: LeaseProvider,
  tokenFile: string,
): Promise<CredentialRead> {
  let text: string;
  let identity: FileIdentity;
  try {
    const handle = await open(tokenFile, "r");
    try {
      const stats = await handle.stat();
      identity = {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { ok: false, problem: code === "ENOENT" ? "missing" : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "malformed", identity };
  }
  if (provider === "claude") {
    const oauth = field(parsed, "claudeAiOauth");
    const access = headerValue(field(oauth, "accessToken"));
    if (!access) return { ok: false, problem: "malformed", identity };
    const refresh = field(oauth, "refreshToken");
    return {
      ok: true,
      headers: { authorization: `Bearer ${access}` },
      token: access,
      ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
      scopes: field(oauth, "scopes"),
      expiresAt: finite(field(oauth, "expiresAt")),
      identity,
    };
  }
  const entry = field(parsed, "openai-codex");
  const access = headerValue(field(entry, "access"));
  // A missing account id would send an undefined header: refuse locally.
  const accountId = headerValue(field(entry, "accountId"));
  return access && accountId
    ? {
        ok: true,
        headers: {
          authorization: `Bearer ${access}`,
          "chatgpt-account-id": accountId,
        },
        token: access,
        expiresAt: finite(field(entry, "expires")),
        identity,
      }
    : { ok: false, problem: "malformed", identity };
}

/**
 * The credential for `provider` from its token file: Claude's
 * `<config dir>/.credentials.json` or pi's `auth.json`.
 */
export async function readCredential(
  provider: LeaseProvider,
  tokenFile: string,
): Promise<CredentialRead> {
  let read = await readOnce(provider, tokenFile);
  for (let reread = 0; reread < REREADS; reread++) {
    if (read.ok || read.problem === "unreadable") return read;
    await delay(REREAD_DELAY_MS);
    read = await readOnce(provider, tokenFile);
  }
  return read;
}
