/**
 * The vault's logins as isolated children (ADR-0005 "The login children",
 * M11): one child process per login behind {@link LoginDriver}, so neither pi
 * nor the Claude CLI's resolver loads in the vault. The children are
 * `claudeLoginMain.ts` and `codexLoginMain.ts`; `loginChildEntry.ts` speaks
 * their side.
 *
 * - in, JSON lines on stdin: first `{"configDir"}`, then one `{"input"}` per
 *   typed line. Nothing goes in argv, and the env is minimal.
 * - out, JSON lines on stdout: `{"type":"output"|"url"|"code","text"}`, then
 *   exactly one `{"type":"done","ok"}`, then exit 0. Its stderr is dropped.
 * - The child leads its own process group. Once the leader exits, on every
 *   path, the port kills the group and waits, bounded, for no live member to
 *   be left, so no process of that group writes into `configDir` after
 *   `done`. A descendant that detached from the group (its own session or
 *   group) is not contained: a per-login Cancel does not reach it, only the
 *   vault unit's stop or restart does (Task-1407 contains logins fully).
 * - `done` settles within a bound even if the pipes never close or the
 *   leader never exits after its SIGKILL; settling that way logs
 *   "login child settled with processes still running".
 * - A line or output over its bound, or anything malformed, cancels the
 *   login. Every rejection is a fixed text, never the child's.
 *
 * Linux only: the group is observed through `/proc`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  LOGIN_CLOSE_WAIT_MS,
  LOGIN_GROUP_WAIT_MS,
  LOGIN_KILL_GRACE_MS,
} from "./vaultMethods.ts";
import type { LoginDriver } from "./vaultPort.ts";

export interface LoginChildCommand {
  file: string;
  args: readonly string[];
}

export interface LoginChildOptions {
  /** Between a cancel's SIGTERM and the group's SIGKILL; 10 s. */
  killGraceMs?: number;
  /**
   * After the leader exited, how long its pipes may stay open (a descendant
   * outside the group may hold them); 5 s. Also how long past the SIGKILL a
   * leader that never exits is waited for.
   */
  closeWaitMs?: number;
  /** How long the group may take to end after its leader; 5 s. */
  groupWaitMs?: number;
  log?: (line: string) => void;
}

const MAX_LINE_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_URL_CHARS = 2048;
const MAX_CODE_CHARS = 64;
const GROUP_POLL_MS = 25;

const DID_NOT_COMPLETE = "The login did not complete.";
const COULD_NOT_START = "The login could not start.";

const ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TZ",
  "LANG",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NIX_SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_ENV",
  // The bundled child resolves its assets and the Claude CLI from these.
  "ASSISTANT_RUNTIME_DIR",
  "ASSISTANT_CLAUDE_CLI_BIN",
]);

/** The environment a login child gets: enough to run, no credential. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && (ENV_NAMES.has(name) || name.startsWith("LC_")))
      env[name] = value;
  return env;
}

/**
 * Whether a process of group `pgid` still runs. A zombie does not: it runs no
 * code, whoever reaps it. An unreadable `/proc` counts as alive.
 */
function groupAlive(pgid: number): boolean {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue; // Gone meanwhile.
    }
    // `pid (comm) state ppid pgrp …`; comm may hold spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X")
      return true;
  }
  return false;
}

function isLoginUrl(text: string): boolean {
  if (text.length > MAX_URL_CHARS) return false;
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}

export function loginChildDriver(
  command: LoginChildCommand,
  {
    killGraceMs = LOGIN_KILL_GRACE_MS,
    closeWaitMs = LOGIN_CLOSE_WAIT_MS,
    groupWaitMs = LOGIN_GROUP_WAIT_MS,
    log = (line) => console.error(`[vault] ${line}`),
  }: LoginChildOptions = {},
): LoginDriver {
  return (configDir, events) => {
    let settle!: { resolve: () => void; reject: (err: Error) => void };
    const done = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    let child: ChildProcess;
    try {
      child = spawn(command.file, [...command.args], {
        env: childEnv(),
        stdio: ["pipe", "pipe", "ignore"],
        // Its own process group, so the port can end every descendant.
        detached: true,
      });
    } catch {
      settle.reject(new Error(COULD_NOT_START));
      return { input: () => {}, cancel: () => {}, done };
    }
    let settled = false;
    let exited = false;
    let cancelled = false;
    let faulted = false;
    /** The `done` line's `ok`, once it came. */
    let reported: boolean | undefined;
    let pending = "";
    let outputBytes = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    /** Settles `done` without waiting for a close that never comes. */
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let finishing = false;
    let exitCode: number | null = null;

    const killGroup = (): void => {
      if (settled || child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // ESRCH: no member left.
      }
    };
    const cancel = (): void => {
      if (cancelled || exited) return;
      cancelled = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(killGroup, killGraceMs);
      // Even a leader that never exits after the SIGKILL ends the run.
      hardTimer = setTimeout(
        () => finish(null, true),
        killGraceMs + closeWaitMs,
      );
    };
    const fault = (): void => {
      faulted = true;
      cancel();
    };

    const handle = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fault();
        return;
      }
      if (
        reported !== undefined ||
        typeof message !== "object" ||
        message === null
      ) {
        fault();
        return;
      }
      const { type, text, ok } = message as Record<string, unknown>;
      if (type === "done" && typeof ok === "boolean") reported = ok;
      else if (typeof text !== "string") fault();
      else if (type === "output") events.output(text);
      else if (type === "url" && isLoginUrl(text)) events.url(text);
      else if (type === "code" && text.length <= MAX_CODE_CHARS)
        events.code(text);
      else fault();
    };

    child.on("error", () => {
      // A spawn failure: no group to end.
      if (child.pid !== undefined || settled) return;
      settled = true;
      settle.reject(new Error(COULD_NOT_START));
    });
    child.stdin!.on("error", () => {
      // The child closed stdin early; its exit decides.
    });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (faulted) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        fault();
        return;
      }
      pending += chunk;
      for (let at = pending.indexOf("\n"); at !== -1;) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 1);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) fault();
        else handle(line);
        if (faulted) return;
        at = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) fault();
    });
    // A descendant may hold the leader's pipes: end the group at its exit,
    // and stop waiting for the pipes after `closeWaitMs`.
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      killGroup();
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        finish(exitCode, true);
      }, closeWaitMs);
    });
    child.on("close", (code) => finish(code));
    /** Waits for the group to end, then settles `done`, once. */
    /**
     * `forced`: by the hard timer or the close watchdog, so the pipes are
     * still held (or the leader still runs) when `done` settles.
     */
    function finish(code: number | null, forced = false): void {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(closeTimer);
      clearTimeout(hardTimer);
      void (async () => {
        const pgid = child.pid!;
        const until = Date.now() + groupWaitMs;
        let empty = !groupAlive(pgid);
        while (!empty && Date.now() < until) {
          // Again each round: a member may have forked before it died.
          killGroup();
          await delay(GROUP_POLL_MS);
          empty = !groupAlive(pgid);
        }
        // From here no signal goes to this group id.
        settled = true;
        clearTimeout(graceTimer);
        if (forced) log("login child settled with processes still running");
        else if (!empty) log("login child group did not end");
        if (
          empty &&
          !faulted &&
          reported === true &&
          code === 0 &&
          pending === ""
        )
          settle.resolve();
        else settle.reject(new Error(DID_NOT_COMPLETE));
      })();
    }

    child.stdin!.write(`${JSON.stringify({ configDir })}\n`);
    return {
      input: (text) => {
        if (!exited && !faulted)
          child.stdin!.write(`${JSON.stringify({ input: text })}\n`);
      },
      cancel,
      done,
    };
  };
}
