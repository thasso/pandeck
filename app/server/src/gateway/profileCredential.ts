/**
 * Reads a profile's upstream credential for one forwarded request.
 *
 * The token file is opened read-only on every request: no caching, no expiry
 * check (an expired token goes upstream and its 401 passes through) and never
 * a write, rename or chmod. Renewal and custody belong to a later slice. An
 * error never carries the file's text, which can hold a token.
 */
import { readFile } from "node:fs/promises";
import type { LeaseProvider } from "./leases.ts";
import type { CredentialProblem } from "./refusals.ts";

export type CredentialRead =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; problem: CredentialProblem };

/** A token goes into a header verbatim, so it must be a visible ASCII run. */
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/;

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

/**
 * The credential headers for `provider` from its token file: Claude's
 * `<config dir>/.credentials.json` or pi's `auth.json`.
 */
export async function readCredential(
  provider: LeaseProvider,
  tokenFile: string,
): Promise<CredentialRead> {
  let text: string;
  try {
    text = await readFile(tokenFile, { encoding: "utf8", flag: "r" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { ok: false, problem: code === "ENOENT" ? "missing" : "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "malformed" };
  }
  if (provider === "claude") {
    const access = headerValue(
      field(field(parsed, "claudeAiOauth"), "accessToken"),
    );
    return access
      ? { ok: true, headers: { authorization: `Bearer ${access}` } }
      : { ok: false, problem: "malformed" };
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
      }
    : { ok: false, problem: "malformed" };
}
