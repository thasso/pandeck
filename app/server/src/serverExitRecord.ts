/**
 * Why the previous server process ended, in its own last words.
 *
 * Boot can see THAT a turn was cut off (its log ends on an open run bracket)
 * but not why: the process that knew is gone. So the dying process writes one
 * small file on its way out — a crash from the uncaught-exception handler, a
 * restart from the signal handler — and the next boot takes it, exactly once,
 * before it marks interrupted turns. A process killed outright (OOM, SIGKILL,
 * power loss) writes nothing, and that absence is itself the answer.
 *
 * Synchronous on purpose: the crash path calls `process.exit` right after.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerExitCause } from "@assistant/shared";
import { DATA_DIR } from "./config.ts";

const DETAIL_MAX = 300;

function recordPath(dataDir: string): string {
  return join(dataDir, "server-exit.json");
}

/** Record why this process is ending. Never throws: it runs on the way out. */
export function noteServerExit(
  cause: ServerExitCause,
  dataDir = DATA_DIR,
): void {
  try {
    const detail = cause.detail.split("\n")[0]!.slice(0, DETAIL_MAX);
    writeFileSync(
      recordPath(dataDir),
      `${JSON.stringify({ kind: cause.kind, detail, at: Date.now() })}\n`,
    );
  } catch {
    // Nothing to report to: the process is ending.
  }
}

/**
 * The previous process's last words, removed as they are read so a later
 * boot cannot attribute a different exit to them. Undefined when it left none.
 */
export function takePreviousServerExit(
  dataDir = DATA_DIR,
): ServerExitCause | undefined {
  const path = recordPath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  rmSync(path, { force: true });
  try {
    const parsed = JSON.parse(raw) as Partial<ServerExitCause>;
    if (
      (parsed.kind === "crash" || parsed.kind === "restart") &&
      typeof parsed.detail === "string"
    )
      return { kind: parsed.kind, detail: parsed.detail.slice(0, DETAIL_MAX) };
  } catch {
    // A torn write says nothing reliable.
  }
  return undefined;
}
