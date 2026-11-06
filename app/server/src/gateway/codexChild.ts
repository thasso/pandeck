/**
 * The standalone gateway's Codex refresh (ADR-0005, M5): one child process
 * per renewal, behind the vault's {@link CodexRenewPort}, so pi never loads
 * in the gateway. The child (`codexRenewMain.ts`) names exactly one
 * credential:
 *
 * - in: one JSON line on stdin, `{authFile, minValidityMs}`; stdin stays
 *   open until it answers. Nothing goes in argv or env, and the env is minimal.
 * - out: one `CodexRenewResult` line on stdout, never a token, then exit 0.
 * - a spawn error, a non-zero exit, a missing or malformed line, or the
 *   deadline answers `{ok:false, kind:"failed", code:"child"}`.
 * - an abort sends SIGTERM, then SIGKILL after a grace, and answers
 *   `code:"aborted"`.
 *
 * Every answer waits for the child's exit, so no renewal writer outlives its
 * call. The only module in `gateway/` that spawns.
 */
import { spawn } from "node:child_process";
import type { CodexRenewPort } from "./renewal.ts";

type CodexRenewResult = Awaited<ReturnType<CodexRenewPort>>;

export interface CodexChildCommand {
  file: string;
  args: readonly string[];
}

export interface CodexChildOptions {
  /** A child that has not answered and exited by then is killed; 120 s. */
  deadlineMs?: number;
  /** Between SIGTERM and SIGKILL; 5 s. */
  killGraceMs?: number;
}

/** A longer line is not an answer. */
const MAX_LINE_BYTES = 4096;

// The real refresher's fixed result vocabulary, never upstream text. Keep
// numeric OAuth rejection statuses intact so renewal reports needs-login.
const REJECTED_CODES = new Set(["400", "401", "invalid_grant"]);
const FAILED_CODES = new Set([
  "gone",
  "conflict",
  "lock_lost",
  "lock_busy",
  "aborted",
  "oauth",
  "auth",
  "error",
  "no_credential",
  "input",
]);

const CHILD_FAILED: CodexRenewResult = {
  ok: false,
  kind: "failed",
  code: "child",
};
const ABORTED: CodexRenewResult = {
  ok: false,
  kind: "failed",
  code: "aborted",
};

/** The answer's line as a result, or undefined when it is not one. */
function parseAnswer(line: string): CodexRenewResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const answer = value as Record<string, unknown>;
  if (answer.ok === true) return { ok: true };
  if (
    answer.ok === false &&
    (answer.kind === "rejected" || answer.kind === "failed") &&
    typeof answer.code === "string" &&
    (answer.kind === "rejected" ? REJECTED_CODES : FAILED_CODES).has(
      answer.code,
    )
  )
    return { ok: false, kind: answer.kind, code: answer.code };
  return undefined;
}

/** The environment a child gets: enough to run, no credential. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "NODE_ENV"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

export function codexChildPort(
  command: CodexChildCommand,
  { deadlineMs = 120_000, killGraceMs = 5_000 }: CodexChildOptions = {},
): CodexRenewPort {
  return (authFile, minValidityMs, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(ABORTED);
        return;
      }
      const child = spawn(command.file, [...command.args], {
        env: childEnv(),
        stdio: ["pipe", "pipe", "ignore"],
      });
      let outcome: CodexRenewResult | undefined;
      let stdout = "";
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const kill = (result: CodexRenewResult): void => {
        outcome ??= result;
        if (killTimer) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        killTimer.unref();
      };
      const onAbort = (): void => kill(ABORTED);
      signal.addEventListener("abort", onAbort, { once: true });
      const deadline = setTimeout(() => kill(CHILD_FAILED), deadlineMs);
      deadline.unref();

      child.on("error", () => {
        // A spawn failure: no exit follows.
        if (child.pid === undefined) finish(undefined);
        else outcome ??= CHILD_FAILED;
      });
      child.stdin.on("error", () => {
        // The child closed stdin early; its exit decides.
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_LINE_BYTES) kill(CHILD_FAILED);
        else if (stdout.includes("\n")) child.stdin.end();
      });
      // `exit` can precede the final stdout data event; `close` cannot.
      child.on("close", (code) => finish(code));

      function finish(code: number | null | undefined): void {
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        if (outcome) {
          resolve(outcome);
          return;
        }
        const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : undefined;
        const answer =
          code === 0 && line !== undefined && !line.includes("\n")
            ? parseAnswer(line)
            : undefined;
        resolve(answer ?? CHILD_FAILED);
      }

      child.stdin.write(`${JSON.stringify({ authFile, minValidityMs })}\n`);
    });
}
