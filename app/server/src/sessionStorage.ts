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

/** Where the Claude SDK store keeps its session records (`<id>.json` and log). */
export const CLAUDE_SDK_STORE_DIR = join(DATA_DIR, "claude-sdk");

/** Provider-native pi transcript used only to resume/fork pi sessions. */
export function canonicalPiSessionPath(sessionId: string): string {
  return join(canonicalSessionDir(sessionId), "native.jsonl");
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
