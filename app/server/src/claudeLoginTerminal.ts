import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { WebSocket } from "ws";
/**
 * The official Claude CLI's login for a profile, viewed and driven from the
 * login dialog (`accountLoginSocket.ts`, `docs/workers.md` "Credentials").
 * One current run per profile; a second browser attaches to it.
 *
 * Lifecycle: `start` joins an unfinished run, or retires a finished one (its
 * viewers keep their finished state) and starts anew; `attach` joins any
 * retained run and never spawns. A run finishes only on its child's `close`
 * and is kept exactly two minutes from then, whatever its viewers do.
 *
 * With the gateway switch on, the run takes the profile's login hold before
 * it spawns `claude auth login`, names the child as the hold's writer right
 * after, and forwards no input until the gateway acknowledged it: input that
 * arrives earlier is held in order, and a stop discards it. With the switch
 * off there is no hold and input goes through at once.
 *
 * Every way a run is stopped (timeout, cancel, server stop, a failed
 * registration, a stdin error, the profile's deletion, Clear) signals the
 * child and waits for its `close`: SIGTERM, then SIGKILL after 5 s; deletion
 * and Clear send SIGKILL at once. Only `close` releases the hold and finishes
 * the run, so no hold ends while its writer may still write. An exit hook
 * sends SIGKILL to every child not closed yet.
 */
import { releaseChildOomScore } from "./childOomScore.ts";
import {
  loginStuckText,
  type AccountLoginClientMessage,
  type AccountLoginIntent,
  type AccountLoginServerMessage,
  type AccountLoginStatus,
} from "@assistant/shared";
import {
  claudeProfileEnvironment,
  claudeProfileHasCredential,
  clearCredentialProfileLoginState,
  completeCredentialProfileLogin,
  credentialProfileById,
  setCredentialProfileLoginState,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import { GATEWAY_LOGIN_UNAVAILABLE_TEXT } from "./gatewayLink.ts";
import {
  takeLoginHold,
  type LoginHold,
  type LoginHoldTaken,
} from "./loginHolds.ts";
import {
  bundledClaudeCliPath,
  CLAUDE_LOGIN_ARGS,
  claudeLoginEnvironmentFrom,
  KILL_AFTER_MS,
  sanitizeClaudeLoginOutput,
} from "./claudeLoginDriver.ts";

const MAX_OUTPUT_CHARS = 64_000;
/** Input held until the gateway acknowledged the writer (L8). */
const MAX_PENDING_INPUT_CHARS = 64_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const FINISHED_RETENTION_MS = 2 * 60_000;
const TIMED_OUT_TEXT =
  "Claude login timed out after 10 minutes. Start it again to retry.";
const CANCELLED_LINE = "\nClaude login cancelled.\n";

type SpawnClaudeLogin = (
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

let spawnClaudeLogin: SpawnClaudeLogin = (executable, args, options) =>
  spawn(executable, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
let loginTimeoutMs = DEFAULT_TIMEOUT_MS;

/** How a stopped run finishes once its child closed. */
interface LoginEnding {
  status: "error" | "cancelled";
  message?: string;
  /** The output line the stop appends at once. */
  line?: string;
}

interface LoginRun {
  profileId: string;
  name: string;
  /** Absent until spawned. */
  child?: ChildProcessWithoutNullStreams;
  hold?: LoginHold;
  viewers: Set<WebSocket>;
  status: AccountLoginStatus;
  output: string;
  startedAt: number;
  error?: string;
  finished: boolean;
  /** Input reaches the child: the gateway acknowledged it, or there is no hold. */
  writerReady: boolean;
  pendingInput: string[];
  pendingChars: number;
  /** The first stop's ending; the run finishes with it on `close`. */
  ending?: LoginEnding;
  killTimer?: ReturnType<typeof setTimeout>;
  /** The child closed, or never ran. */
  closed: boolean;
  timeout: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, LoginRun>();

/** Minimal child environment: login never needs the server's integration tokens or app secret. */
export function claudeLoginEnvironment(
  profileId: string,
): Record<string, string> {
  return claudeLoginEnvironmentFrom(claudeProfileEnvironment(profileId));
}

function send(viewer: WebSocket, message: AccountLoginServerMessage): void {
  if (viewer.readyState !== 1) return;
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /* a close races buffered output */
  }
}

function broadcast(run: LoginRun, message: AccountLoginServerMessage): void {
  for (const viewer of run.viewers) send(viewer, message);
}

function appendOutput(run: LoginRun, raw: string): void {
  if (run.finished) return;
  let chunk = sanitizeClaudeLoginOutput(raw);
  if (!chunk) return;
  const remaining = MAX_OUTPUT_CHARS - run.output.length;
  if (remaining <= 0) return;
  if (chunk.length > remaining) {
    const suffix = "\n[Further terminal output was truncated.]\n";
    chunk =
      remaining <= suffix.length
        ? suffix.slice(0, remaining)
        : `${chunk.slice(0, remaining - suffix.length)}${suffix}`;
  }
  run.output += chunk;
  broadcast(run, { type: "output", chunk });
}

function retainFinished(run: LoginRun): void {
  run.retention = setTimeout(() => {
    if (runs.get(run.profileId) === run) runs.delete(run.profileId);
  }, FINISHED_RETENTION_MS);
  run.retention.unref?.();
}

/** `errorOnAccount: false` shows an error to the dialog only, not on the account. */
function finish(
  run: LoginRun,
  status: AccountLoginStatus,
  message?: string,
  errorOnAccount = true,
): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  if (message !== undefined) run.error = message;
  clearTimeout(run.timeout);
  if (status === "ready") completeCredentialProfileLogin(run.profileId);
  else if (
    status === "error" &&
    errorOnAccount &&
    credentialProfileById(run.profileId)
  ) {
    setCredentialProfileLoginState(run.profileId, {
      status: "error",
      error: message?.slice(0, 180) ?? "Claude login failed.",
    });
  } else if (status === "cancelled" || !errorOnAccount)
    clearCredentialProfileLoginState(run.profileId);
  broadcast(run, {
    type: "status",
    status,
    ...(message ? { error: message } : {}),
  });
  retainFinished(run);
}

function startRun(profileId: string): LoginRun {
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "claude")
    throw new Error("That is not a Claude credential profile.");
  setCredentialProfileLoginState(profileId, { status: "connecting" });
  const run: LoginRun = {
    profileId,
    name: profile.name,
    viewers: new Set(),
    status: "connecting",
    output: "Starting the official Claude login…\n",
    startedAt: Date.now(),
    finished: false,
    writerReady: false,
    pendingInput: [],
    pendingChars: 0,
    closed: false,
    timeout: setTimeout(
      () => stop(run, { status: "error", message: TIMED_OUT_TEXT }, "SIGTERM"),
      loginTimeoutMs,
    ),
  };
  run.timeout.unref?.();
  runs.set(profileId, run);
  // Without a link the answer is not a promise: the child spawns right here.
  const taking = takeLoginHold(profile, () =>
    stop(run, { status: "cancelled", line: CANCELLED_LINE }, "SIGKILL"),
  );
  if (taking instanceof Promise) void taking.then((taken) => begin(run, taken));
  else begin(run, taking);
  return run;
}

/** Spawns the child once the hold is taken, unless the run stopped meanwhile. */
function begin(run: LoginRun, taken: LoginHoldTaken): void {
  if (taken.kind === "held") run.hold = taken.hold;
  if (run.ending) {
    run.closed = true;
    run.hold?.release();
    finish(run, run.ending.status, run.ending.message);
    return;
  }
  if (taken.kind === "stuck") {
    run.closed = true;
    // The account shows U7's text from its login-stuck flag, which ends with
    // the hold; as its error the text would outlive a Clear.
    finish(run, "error", loginStuckText(run.name), false);
    return;
  }
  if (taken.kind === "unavailable") {
    run.closed = true;
    finish(run, "error", GATEWAY_LOGIN_UNAVAILABLE_TEXT);
    return;
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnClaudeLogin(bundledClaudeCliPath(), [...CLAUDE_LOGIN_ARGS], {
      env: claudeLoginEnvironment(run.profileId),
      windowsHide: true,
    });
  } catch (error) {
    run.closed = true;
    run.hold?.release();
    finish(
      run,
      "error",
      `Could not start the official Claude CLI: ${errorText(error)}`,
    );
    return;
  }
  run.child = child;
  releaseChildOomScore(child.pid);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => appendOutput(run, chunk));
  child.stderr.on("data", (chunk: string) => appendOutput(run, chunk));
  child.stdin.on("error", (error) =>
    stop(
      run,
      {
        status: "error",
        message: `Claude login input closed: ${errorText(error)}`,
      },
      "SIGTERM",
    ),
  );
  child.on("error", (error) => {
    // Only a child that never ran has no pid; one that ran ends on `close`.
    if (child.pid !== undefined) return;
    run.closed = true;
    run.hold?.release();
    finish(
      run,
      "error",
      `Could not start the official Claude CLI: ${errorText(error)}`,
    );
  });
  child.on("close", (code, signal) => closed(run, code, signal));
  const { hold } = run;
  if (!hold) {
    run.writerReady = true;
    return;
  }
  // A child that never ran cannot write: nothing is left to hold.
  if (child.pid === undefined) {
    hold.release();
    return;
  }
  hold.registerWriter(child.pid).then(
    () => {
      if (!acceptsInput(run)) return;
      run.writerReady = true;
      for (const data of run.pendingInput) child.stdin.write(`${data}\n`);
      run.pendingInput = [];
      run.pendingChars = 0;
    },
    () =>
      stop(
        run,
        { status: "error", message: GATEWAY_LOGIN_UNAVAILABLE_TEXT },
        "SIGTERM",
      ),
  );
}

/** The child closed: the hold ends, then the run finishes. */
function closed(
  run: LoginRun,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  run.closed = true;
  clearTimeout(run.killTimer);
  run.pendingInput = [];
  run.pendingChars = 0;
  run.hold?.release();
  if (run.finished) return;
  if (run.ending) {
    finish(run, run.ending.status, run.ending.message);
    return;
  }
  if (code === 0 && claudeProfileHasCredential(run.profileId)) {
    appendOutput(run, "\nClaude login completed.\n");
    finish(run, "ready");
    return;
  }
  const detail = signal
    ? `Claude login stopped (${signal}).`
    : `Claude login exited with code ${code ?? "unknown"}.`;
  finish(run, "error", detail);
}

/**
 * Stops the run: the first ending wins, held input is dropped, and the child
 * gets `signal` (SIGTERM escalates to SIGKILL after 5 s). The run finishes
 * only on the child's `close`; before the spawn, `begin` sees the ending.
 */
function stop(
  run: LoginRun,
  ending: LoginEnding,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (run.finished || run.closed) return;
  if (run.ending) {
    // A later SIGKILL stop still escalates.
    if (signal !== "SIGKILL") return;
  } else {
    run.ending = ending;
    run.pendingInput = [];
    run.pendingChars = 0;
    clearTimeout(run.timeout);
    if (ending.line) appendOutput(run, ending.line);
  }
  const { child } = run;
  if (!child) return;
  child.kill(signal);
  if (signal === "SIGTERM" && !run.closed && !run.killTimer) {
    run.killTimer = setTimeout(() => {
      if (!run.closed) child.kill("SIGKILL");
    }, KILL_AFTER_MS);
    run.killTimer.unref?.();
  }
}

const acceptsInput = (run: LoginRun): boolean =>
  !run.finished && !run.ending && !run.closed;

function snapshot(run: LoginRun): AccountLoginServerMessage {
  return {
    type: "snapshot",
    profileId: run.profileId,
    provider: "claude",
    status: run.status,
    output: run.output,
    startedAt: run.startedAt,
    ...(run.error ? { error: run.error } : {}),
  };
}

/** One validated message (`accountLoginSocket.ts`); input is never logged. */
function handleClientMessage(
  run: LoginRun,
  message: AccountLoginClientMessage,
): void {
  if (message.type === "cancel") {
    stop(run, { status: "cancelled", line: CANCELLED_LINE }, "SIGTERM");
    return;
  }
  if (!acceptsInput(run)) return;
  const data = message.data.trim();
  if (!data) return;
  // Never append or log this value: it may be the short-lived OAuth authorization code.
  if (run.writerReady) {
    run.child!.stdin.write(`${data}\n`);
    return;
  }
  if (run.pendingChars + data.length > MAX_PENDING_INPUT_CHARS) return;
  run.pendingInput.push(data);
  run.pendingChars += data.length;
}

/**
 * Attaches one viewer to the profile's run under `intent`; undefined for an
 * `attach` that finds no run. Throws, sending nothing, for a profile that is
 * not a Claude login.
 */
export function attachClaudeLogin(
  viewer: WebSocket,
  profileId: string,
  intent: AccountLoginIntent,
):
  | { message(message: AccountLoginClientMessage): void; detach(): void }
  | undefined {
  let run = runs.get(profileId);
  if (intent === "attach") {
    if (!run) return undefined;
  } else if (!run || run.finished) {
    // A finished run's viewers keep it; the account's slot gets a new one.
    if (run?.retention) clearTimeout(run.retention);
    run = startRun(profileId);
  }
  const current = run;
  current.viewers.add(viewer);
  send(viewer, snapshot(current));
  return {
    message: (message) => handleClientMessage(current, message),
    detach: () => current.viewers.delete(viewer),
  };
}

/** Login subprocesses are not agent turns and must never hold a deploy drain open. */
export function stopClaudeLoginTerminals(): void {
  for (const run of [...runs.values()]) {
    if (run.retention) clearTimeout(run.retention);
    stop(run, { status: "cancelled" }, "SIGTERM");
    for (const viewer of run.viewers) {
      try {
        viewer.close(1012, "Server restarting");
      } catch {
        /* already closed */
      }
    }
    // A child not closed yet stays, for its `close` and the exit hook.
    if (run.closed) {
      if (run.retention) clearTimeout(run.retention);
      runs.delete(run.profileId);
    }
  }
}

/** SIGKILL to every login child that has not closed; the process is exiting. */
export function killUnclosedClaudeLoginChildren(): void {
  for (const run of runs.values())
    if (run.child && !run.closed)
      try {
        run.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
}

process.once("exit", killUnclosedClaudeLoginChildren);

subscribeCredentialProfileDeleted((profileId) => {
  const run = runs.get(profileId);
  if (run)
    stop(
      run,
      {
        status: "cancelled",
        line: "\nProfile deleted; Claude login cancelled.\n",
      },
      "SIGKILL",
    );
});

/** Test seams; production callers never replace the official CLI spawn. */
export function setClaudeLoginSpawnForTests(
  value: SpawnClaudeLogin | null,
): void {
  spawnClaudeLogin =
    value ??
    ((executable, args, options) =>
      spawn(executable, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
}

export function setClaudeLoginTimeoutForTests(value: number | null): void {
  loginTimeoutMs = value ?? DEFAULT_TIMEOUT_MS;
}
