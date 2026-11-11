/**
 * The YubiKey helper (plan Task-1395, ADR-0005): Node has no PC/SC, so a small
 * Python process using the installed `yubikit` (`pivHelper.py`) does the PIV
 * operations. Spawned per use, with no argv secrets and a minimal env; JSON
 * lines on stdin and stdout, one answer per request:
 *
 * - `{op: "public", slot}` → `{ok, spki}` (base64 DER), no PIN needed;
 * - `{op: "verify", pin}` → `{ok}`, or `{error: "wrong_pin", triesLeft}`,
 *   `{error: "blocked"}`;
 * - `{op: "ecdh", slot, epk}` (an uncompressed point) → `{ok, secret}`;
 * - any failure: `{error}`, a fixed code (`no_device`, `no_key`, `failed`).
 *
 * The helper never echoes the PIN and exits when stdin closes. Its stderr is
 * dropped unread. A spawn error, an exit, a malformed line or the deadline
 * answers `{error: "failed"}` and ends the helper.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface PivHelperCommand {
  file: string;
  args: readonly string[];
}

/** `python3 -I pivHelper.py`, next to this module. */
export const PIV_HELPER: PivHelperCommand = {
  file: "python3",
  args: ["-I", fileURLToPath(new URL("./pivHelper.py", import.meta.url))],
};

/** A longer line is not an answer. */
const MAX_LINE_BYTES = 8192;
/** The whole session's deadline; a PIN entry happens before it starts. */
const DEADLINE_MS = 60_000;

type PivAnswer = Record<string, unknown>;

export interface PivSession {
  /** One request and its answer; `{error: "failed"}` once the helper ended. */
  request(message: Record<string, unknown>): Promise<PivAnswer>;
  /** Closes stdin and waits for the exit (killed after a grace). */
  close(): Promise<void>;
}

const FAILED: PivAnswer = { error: "failed" };

export function openPivHelper(
  command: PivHelperCommand = PIV_HELPER,
  deadlineMs = DEADLINE_MS,
): PivSession {
  let child: ChildProcess | undefined;
  let ended = false;
  const waiting: ((answer: PivAnswer) => void)[] = [];
  let buffer = "";
  const end = (): void => {
    ended = true;
    for (const answer of waiting.splice(0)) answer(FAILED);
  };
  const exited = new Promise<void>((resolveExit) => {
    try {
      child = spawn(command.file, [...command.args], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      });
    } catch {
      ended = true;
      resolveExit();
      return;
    }
    child.once("error", () => end());
    child.once("exit", () => {
      end();
      resolveExit();
    });
  });
  const timer = setTimeout(() => {
    end();
    child?.kill("SIGKILL");
  }, deadlineMs);
  timer.unref();
  child?.stdin?.on("error", () => end());
  child?.stdout?.setEncoding("utf8");
  child?.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES && !buffer.includes("\n")) {
      end();
      child?.kill("SIGKILL");
      return;
    }
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let answer: PivAnswer = FAILED;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null)
          answer = parsed as PivAnswer;
      } catch {
        // Not an answer: FAILED.
      }
      waiting.shift()?.(answer);
    }
  });

  return {
    request(message) {
      if (ended || !child?.stdin) return Promise.resolve(FAILED);
      return new Promise((resolveAnswer) => {
        waiting.push(resolveAnswer);
        child!.stdin!.write(`${JSON.stringify(message)}\n`);
      });
    },
    async close() {
      child?.stdin?.end();
      const grace = setTimeout(() => child?.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(grace);
      clearTimeout(timer);
    },
  };
}
