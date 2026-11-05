/**
 * The gateway's Claude OAuth refresh (U8, `docs/workers.md` "Renewal"),
 * mirroring CLI 2.1.316 (MR-1344-01): the same request, and the same
 * compare-and-swap save into `.credentials.json`, run under the CLI's own
 * locks (`refreshLock.ts`).
 *
 * The request goes only to `https://platform.claude.com/v1/oauth/token`; a
 * test overrides where to connect and the CA, never the URL, `Host` or TLS
 * name, so a refresh token cannot go anywhere else. Redirects are not
 * followed. A result names a status, an errno code or a fixed word, never
 * response text.
 *
 * The save is a same-directory temp file and a rename onto the real path, so
 * a reader sees the old file or the new one, a symlink stays a symlink, and a
 * deleted profile directory is never recreated. The blank-token form the CLI
 * writes after a rejected refresh is never written here (C18).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import https from "node:https";
import { basename, dirname, join } from "node:path";

const TOKEN_HOST = "platform.claude.com";
const TOKEN_PATH = "/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const TIMEOUT_MS = 30_000;
/** A token response is small; anything larger is not one. */
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_EXPIRES_IN_S = 31_536_000;
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;
/** Leftover temp files older than this are removed before a save. */
const STALE_TEMP_MS = 60_000;

/** Where to connect instead of the token host (tests): never the URL. */
export interface TokenEndpoint {
  connect: { host: string; port: number };
  ca?: string | string[];
}

/** A validated token response; held in memory only. */
export interface ClaudeTokens {
  accessToken: string;
  refreshToken: string | undefined;
  expiresInS: number;
  scope: string | undefined;
  refreshTokenExpiresInS: number | undefined;
}

export type ClaudeRefreshResult =
  | { kind: "ok"; tokens: ClaudeTokens }
  | { kind: "rejected" }
  | { kind: "failed"; code: string };

export type ClaudeSaveResult =
  { kind: "renewed" } | { kind: "adopted" } | { kind: "failed"; code: string };

function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The stored scopes the CLI sends: a non-empty array, else its defaults. */
function scopeOf(scopes: unknown): string {
  return Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every((scope) => typeof scope === "string")
    ? scopes.join(" ")
    : DEFAULT_SCOPES.join(" ");
}

function parseTokens(body: string): ClaudeTokens | undefined {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(body));
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  const {
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    scope,
    refresh_token_expires_in: refreshExpiresIn,
  } = parsed;
  if (typeof access !== "string" || !HEADER_SAFE_RE.test(access))
    return undefined;
  if (
    refresh !== undefined &&
    (typeof refresh !== "string" || !HEADER_SAFE_RE.test(refresh))
  )
    return undefined;
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > MAX_EXPIRES_IN_S
  )
    return undefined;
  if (scope !== undefined && typeof scope !== "string") return undefined;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresInS: expiresIn,
    scope,
    // The CLI takes any typeof number; only a finite positive one is kept here.
    refreshTokenExpiresInS:
      typeof refreshExpiresIn === "number" &&
      Number.isFinite(refreshExpiresIn) &&
      refreshExpiresIn > 0
        ? refreshExpiresIn
        : undefined,
  };
}

function isInvalidGrant(body: string): boolean {
  try {
    return record(JSON.parse(body))?.error === "invalid_grant";
  } catch {
    return false;
  }
}

/**
 * One refresh request as CLI 2.1.316 sends it (MR Q1): a JSON POST of the
 * grant, the client id and the scopes, with axios's `Accept` and
 * `User-Agent`, at most 30 s end to end.
 */
export function refreshClaude(
  stored: { refreshToken: string; scopes?: unknown },
  endpoint: TokenEndpoint | undefined,
  signal: AbortSignal,
  timeoutMs = TIMEOUT_MS,
): Promise<ClaudeRefreshResult> {
  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: CLIENT_ID,
    scope: scopeOf(stored.scopes),
  });
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ClaudeRefreshResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      request.destroy();
      resolve(result);
    };
    const request = https.request({
      host: endpoint?.connect.host ?? TOKEN_HOST,
      port: endpoint?.connect.port ?? 443,
      servername: TOKEN_HOST,
      ...(endpoint?.ca ? { ca: endpoint.ca } : {}),
      agent: false,
      method: "POST",
      path: TOKEN_PATH,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "User-Agent": "axios/1.15.2",
        "Content-Length": Buffer.byteLength(body),
        Host: TOKEN_HOST,
      },
    });
    const timer = setTimeout(
      () => settle({ kind: "failed", code: "timeout" }),
      timeoutMs,
    );
    const onAbort = (): void => settle({ kind: "failed", code: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    request.on("error", (err) =>
      settle({ kind: "failed", code: errnoOf(err) ?? "network" }),
    );
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        settle({ kind: "failed", code: "redirect" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES)
          settle({ kind: "failed", code: "bad_response" });
        else chunks.push(chunk);
      });
      response.on("aborted", () => settle({ kind: "failed", code: "aborted" }));
      response.on("error", (err) =>
        settle({ kind: "failed", code: errnoOf(err) ?? "network" }),
      );
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (status >= 200 && status < 300) {
          const tokens = parseTokens(text);
          settle(
            tokens
              ? { kind: "ok", tokens }
              : { kind: "failed", code: "bad_response" },
          );
        } else if ((status === 400 || status === 401) && isInvalidGrant(text))
          settle({ kind: "rejected" });
        else settle({ kind: "failed", code: String(status) });
      });
    });
    request.end(body);
  });
}

/** Removes `<prefix>*.tmp` files in `dir` older than a minute. */
function removeStaleTemps(dir: string, prefix: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < now - STALE_TEMP_MS) unlinkSync(path);
    } catch {
      // Gone already, or another writer's: left alone.
    }
  }
}

/**
 * Writes `text` to a new 0600 temp file beside `target` and renames it onto
 * `target`, synchronously; the temp file never outlives a failure.
 */
function replaceFileAtomically(
  target: string,
  text: string,
  rename: (from: string, to: string) => void,
): void {
  const temp = join(
    dirname(target),
    `${basename(target)}.pandeck-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    rename(temp, target);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or renamed already.
    }
    throw err;
  }
}

/**
 * The CLI's compare-and-swap save (MR Q11), under the refresh locks: writes
 * only when `claudeAiOauth` exists and its refresh token is still the one
 * submitted, or blank; otherwise another writer's login or refresh landed and
 * is adopted untouched. Every other key is kept. Synchronous from the read to
 * the rename.
 */
export function saveClaude(
  file: string,
  submittedRefresh: string,
  tokens: ClaudeTokens,
  now: number,
  /** Test seam for the write boundary. */
  rename: (from: string, to: string) => void = renameSync,
): ClaudeSaveResult {
  let target: string;
  try {
    target = realpathSync(file);
  } catch (err) {
    return {
      kind: "failed",
      code: errnoOf(err) === "ENOENT" ? "gone" : (errnoOf(err) ?? "error"),
    };
  }
  removeStaleTemps(dirname(target), `${basename(target)}.pandeck-`, now);
  let doc: Record<string, unknown> | undefined;
  try {
    doc = record(JSON.parse(readFileSync(target, "utf8")));
  } catch (err) {
    const code = errnoOf(err);
    return {
      kind: "failed",
      code: code === "ENOENT" ? "gone" : (code ?? "malformed"),
    };
  }
  const oauth = record(doc?.claudeAiOauth);
  if (
    !doc ||
    !oauth ||
    (oauth.refreshToken !== "" && oauth.refreshToken !== submittedRefresh)
  )
    return { kind: "adopted" };
  const next = {
    ...doc,
    claudeAiOauth: {
      ...oauth,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? submittedRefresh,
      expiresAt: now + tokens.expiresInS * 1000,
      ...(tokens.refreshTokenExpiresInS !== undefined
        ? { refreshTokenExpiresAt: now + tokens.refreshTokenExpiresInS * 1000 }
        : {}),
      ...(tokens.scope !== undefined
        ? { scopes: tokens.scope.split(" ").filter(Boolean) }
        : {}),
    },
  };
  try {
    replaceFileAtomically(target, JSON.stringify(next), rename);
  } catch (err) {
    const code = errnoOf(err);
    return {
      kind: "failed",
      code: code === "ENOENT" ? "gone" : (code ?? "write_failed"),
    };
  }
  return { kind: "renewed" };
}
