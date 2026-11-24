import { mkdirSync, renameSync, rmSync, cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** Canonical per-session folder. The session id is the only durable locator. */
function canonicalSessionDir(sessionId: string): string {
  return join(DATA_DIR, "sessions", sessionId);
}

/** App-owned normalized conversation log. */
export function canonicalSessionLogPath(sessionId: string): string {
  return join(canonicalSessionDir(sessionId), "log.jsonl");
}

/** The session's last status card (`docs/session-status.md`). */
export function sessionStatusCardPath(sessionId: string): string {
  return join(canonicalSessionDir(sessionId), "status-card.json");
}

/** Where the Claude SDK store keeps its session records (`<id>.json` and log). */
export const CLAUDE_SDK_STORE_DIR = join(DATA_DIR, "claude-sdk");

/**
 * Provider-native pi transcript of the pi session `sessionId` names. Reach a
 * stored session's file through its binding instead ({@link piNativeFile},
 * `piSessionFile.ts`); this direct form is for a session being created, whose
 * native id is the app id by construction, and for a session without a row.
 */
export function canonicalPiSessionPath(sessionId: string): string {
  return join(canonicalSessionDir(sessionId), "native.jsonl");
}

/**
 * The pi transcript of app session `appId`'s pi binding whose native id is
 * `nativeId` (design 20: a binding stores the id, never the path). Every pi
 * binding so far has native id = app id; a binding with its own id gets its
 * layout with the cross-harness switch, so until then one is refused rather
 * than guessed.
 */
export function piNativeFile(appId: string, nativeId: string): string {
  if (nativeId === appId) return canonicalPiSessionPath(appId);
  throw new Error(
    `Session ${appId} has a pi binding with its own native id ${nativeId}; this build cannot open it.`,
  );
}

/** Move/copy a legacy provider transcript into its canonical per-session folder. */
export function migrateFileToCanonical(source: string, target: string): string {
  if (source === target) return target;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    // Prefer the canonical copy and remove stale legacy duplicates.
    try {
      rmSync(source, { force: true });
    } catch {
      /* best effort */
    }
    return target;
  }
  try {
    renameSync(source, target);
  } catch {
    // Cross-device or permission edge case: copy, then best-effort remove.
    cpSync(source, target);
    try {
      rmSync(source, { force: true });
    } catch {
      /* best effort */
    }
  }
  return target;
}
