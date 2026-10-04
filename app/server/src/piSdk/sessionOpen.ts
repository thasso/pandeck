import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentType } from "@assistant/shared";
import { CWD } from "../config.ts";
import { sessionDirFor } from "./options.ts";

/** Extract the session id embedded after the first `_` in a session filename (`<ts>_<uuid>.jsonl`). */
export function sessionIdFromFile(file: string): string | undefined {
  const name = basename(file);
  const idx = name.indexOf("_");
  if (idx < 0) return undefined;
  const rest = name.slice(idx + 1);
  const dot = rest.lastIndexOf(".");
  const id = dot >= 0 ? rest.slice(0, dot) : rest;
  return id || undefined;
}

/** Parse the first non-empty line of a session file as its session header. */
function readSessionHeader(
  file: string,
): { id: string; cwd?: string } | undefined {
  try {
    const content = readFileSync(file, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).type === "session" &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        (parsed as Record<string, unknown>).id
      ) {
        const record = parsed as Record<string, unknown>;
        return {
          id: record.id as string,
          ...(typeof record.cwd === "string" && record.cwd
            ? { cwd: record.cwd }
            : {}),
        };
      }
      return undefined; // first non-empty line is not a valid session header
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The header `id` of a session file, if the header is valid. */
export function readSessionHeaderId(file: string): string | undefined {
  return readSessionHeader(file)?.id;
}

/**
 * Find a pre-canonical pi transcript still stored under its persona directory.
 * Forks created before canonicalization was applied to that path can have a
 * valid metadata row and app log while their native transcript remains here.
 */
export function findLegacySessionFile(
  kind: AgentType,
  sessionId: string,
): string | undefined {
  const dir = sessionDirFor(kind);
  const suffix = `_${sessionId}.jsonl`;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const file = join(dir, entry.name);
      if (readSessionHeaderId(file) === sessionId) return file;
    }
  } catch {
    // A missing/unreadable legacy directory means there is nothing to recover.
  }
  return undefined;
}

const RETRY_DELAY_MS = 50;

/**
 * Open an existing session file with pre-open integrity guards.
 *
 * The SDK's SessionManager.open() silently mints a new id and truncates the
 * file when its header read returns [] (empty/partial file). This can happen
 * on a transient truncate/rewrite race during server restart. This helper
 * prevents that:
 *
 * 1. Reads and validates the header id *before* constructing SessionManager.
 * 2. If an expected id is provided (or derivable from the filename), verifies
 *    match before construction — a mismatch is a hard error, not retried.
 * 3. Retries on missing/invalid header (covers zero-byte transient race).
 * 4. Throws if still unreadable — callers fall back to a fresh session safely.
 * 5. Passes a cwdOverride so cwd never falls back to process.cwd(): the
 *    caller's cwd (the session's worktree path) wins, else the session
 *    header's own creation cwd (sessions created in a non-CWD directory, e.g.
 *    merge agents in another repo's main checkout, reopen where they started),
 *    else the app CWD.
 * 6. Post-open assertion as belt-and-suspenders against SDK surprises.
 *
 * Cannot patch the SDK (node_modules, pinned 0.79.1); all guards are at call sites.
 */
export async function openExistingSession(
  kind: AgentType,
  file: string,
  opts?: { expectedId?: string; retries?: number; cwd?: string },
): Promise<SessionManager> {
  if (!existsSync(file))
    throw new Error(`Session file does not exist: ${file}`);

  const maxRetries = opts?.retries ?? 3;
  const filenameId = sessionIdFromFile(file);
  const expectedId = opts?.expectedId ?? filenameId;

  let headerId: string | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    headerId = readSessionHeaderId(file);
    if (headerId !== undefined) break;
    // Immediately fail if we read something but it's not valid (rather than retrying a clearly corrupt file).
    // headerId === undefined covers both: file empty/unreadable AND first line not a session header.
    // We retry all such cases since a race can present as any of those.
    if (attempt < maxRetries)
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
  }

  if (headerId === undefined) {
    throw new Error(
      `Session file has no valid header after ${maxRetries + 1} read attempt(s) — ` +
        `file may be corrupt or mid-rewrite: ${file}`,
    );
  }

  if (expectedId !== undefined && headerId !== expectedId) {
    throw new Error(
      `Session id mismatch before open: expected ${expectedId}, header contains ${headerId} in ${file}`,
    );
  }

  const sm = SessionManager.open(
    file,
    sessionDirFor(kind),
    opts?.cwd ?? readSessionHeader(file)?.cwd ?? CWD,
  );
  const actualId = sm.getSessionId();
  if (actualId !== headerId) {
    // Should be impossible after the pre-check, but guards against SDK surprises.
    throw new Error(
      `Session id changed during open (SDK minted a new id): expected ${headerId}, got ${actualId} in ${file}`,
    );
  }
  return sm;
}
