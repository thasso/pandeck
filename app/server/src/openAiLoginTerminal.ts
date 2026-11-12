/**
 * The OpenAI (Codex) device-code login for a profile, viewed and cancelled
 * from the login dialog (`accountLoginSocket.ts`, `docs/workers.md`
 * "Credentials"). It mirrors the Claude login terminal: one current run per
 * profile, any number of viewers, a snapshot for each that attaches.
 *
 * The login itself is pi's, started through `harnesses/boot.ts`
 * (`startOpenAiProfileLogin`), which owns the hold, the account's login state
 * and the outcome precedence: the commit wins, otherwise the first stop
 * reason (cancel, timeout, deletion). A run finishes only once pi's login
 * settled, its hold was released and the operation left its map, so a
 * `start` after a finished run always begins a fresh login.
 *
 * Lifecycle: `start` joins an unfinished run, or retires a finished one and
 * starts anew; `attach` joins any retained run and never starts one. A
 * finished run is kept exactly two minutes, whatever its viewers do. The
 * device code goes only to viewers, never into a log or the account summary.
 */
import type { WebSocket } from "ws";
import type {
  AccountLoginClientMessage,
  AccountLoginDevice,
  AccountLoginIntent,
  AccountLoginServerMessage,
  AccountLoginStatus,
} from "@assistant/shared";
import {
  cancelOpenAiProfileLogin,
  startOpenAiProfileLogin,
  type OpenAiProfileLoginOutcome,
} from "./harnesses/boot.ts";

const FINISHED_RETENTION_MS = 2 * 60_000;
const ALREADY_RUNNING_TEXT =
  "An OpenAI login for this account is still finishing. Try again in a moment.";

interface OpenAiLoginRun {
  profileId: string;
  viewers: Set<WebSocket>;
  status: AccountLoginStatus;
  startedAt: number;
  device?: AccountLoginDevice;
  error?: string;
  finished: boolean;
  retention?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, OpenAiLoginRun>();

function send(viewer: WebSocket, message: AccountLoginServerMessage): void {
  if (viewer.readyState !== 1) return;
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /* a close races the message */
  }
}

function broadcast(run: OpenAiLoginRun, message: AccountLoginServerMessage) {
  for (const viewer of run.viewers) send(viewer, message);
}

function finish(
  run: OpenAiLoginRun,
  status: OpenAiProfileLoginOutcome,
  text?: string,
): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  if (text !== undefined) run.error = text;
  broadcast(run, { type: "status", status, ...(text ? { error: text } : {}) });
  run.retention = setTimeout(() => {
    if (runs.get(run.profileId) === run) runs.delete(run.profileId);
  }, FINISHED_RETENTION_MS);
  run.retention.unref?.();
}

function startRun(profileId: string): OpenAiLoginRun {
  const run: OpenAiLoginRun = {
    profileId,
    viewers: new Set(),
    status: "connecting",
    startedAt: Date.now(),
    finished: false,
  };
  runs.set(profileId, run);
  let started: boolean;
  try {
    started = startOpenAiProfileLogin(profileId, {
      device(verificationUri, userCode) {
        if (run.finished) return;
        // Short-lived instructions, not credentials: kept out of logs.
        run.device = { verificationUri, userCode };
        broadcast(run, { type: "device", device: run.device });
      },
      settled: (outcome, text) => finish(run, outcome, text),
    });
  } catch (error) {
    runs.delete(profileId);
    throw error;
  }
  if (!started) finish(run, "error", ALREADY_RUNNING_TEXT);
  return run;
}

function snapshot(run: OpenAiLoginRun): AccountLoginServerMessage {
  return {
    type: "snapshot",
    profileId: run.profileId,
    provider: "openai-codex",
    status: run.status,
    output: "",
    startedAt: run.startedAt,
    ...(run.error ? { error: run.error } : {}),
    ...(run.device ? { device: run.device } : {}),
  };
}

/**
 * Attaches one viewer to the profile's run under `intent`; undefined for an
 * `attach` that finds no run. Throws, sending nothing, for a profile that is
 * not an OpenAI login.
 */
export function attachOpenAiLogin(
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
    message(message) {
      // Input has no meaning for a device-code login.
      if (message.type === "cancel" && !current.finished)
        cancelOpenAiProfileLogin(current.profileId);
    },
    detach: () => current.viewers.delete(viewer),
  };
}
