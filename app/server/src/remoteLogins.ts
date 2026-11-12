/**
 * Client mode's logins (plan Task-1385, M12; Task-1402 B1): the login
 * dialog, rendered from the gateway's login API (`logins.*` on gateway
 * client 1.0, through `gatewayClientLink.ts`). The gateway runs the driver
 * and keeps the credential; this server only relays the interaction.
 *
 * - Adding an account starts its first login on the gateway, which registers
 *   the account at once (it needs a login until that succeeds).
 * - The login dialog's socket (`/ws/account-login`, `accountLoginSocket.ts`)
 *   attaches to the account's run. Claude's output streams and its input goes
 *   to the gateway; Codex's URL and code become one `device` message once
 *   both arrived, and never the account's login state. Cancel goes to the
 *   gateway for both.
 * - Deleting an account removes it on the gateway; the mirror then drops it.
 *
 * Lifecycle: `start` joins an unfinished run, or retires a finished one and
 * asks the gateway for a new login; `attach` joins any retained run and never
 * starts one. A run exists from the moment its start is asked, so a viewer's
 * listeners are in place before the gateway answers: a cancel meanwhile is
 * latched and forwarded once the answer names the login, input is dropped,
 * and a viewer that closes just leaves. A run finishes on the gateway's
 * terminal state, sent after its driver settled, and is kept exactly two
 * minutes from then.
 *
 * The gateway sends a login's events only over current connections, so a
 * run whose link dropped may have missed its end. Such a run is marked
 * interrupted; once a connection is back it is cancelled on the gateway.
 * An `unknown_login` answer (to that or to the user's own cancel) proves the
 * gateway no longer runs it: it ends with the interrupted text, and the
 * account's state is the mirror's. Otherwise the gateway's own terminal
 * event ends it. A transport loss alone never ends a run.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AccountLoginClientMessage,
  AccountLoginDevice,
  AccountLoginIntent,
  AccountLoginServerMessage,
  AccountLoginStatus,
} from "@assistant/shared";
import {
  assertCredentialProfileDeletable,
  clearCredentialProfileLoginState,
  completeCredentialProfileLogin,
  credentialProfileById,
  setCredentialProfileLoginState,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import { GATEWAY_LOGIN_UNAVAILABLE_TEXT } from "./gatewayLink.ts";

type LoginKind = "claude" | "openai-codex";

export type RemoteLoginEvent =
  | { type: "output"; text: string }
  | { type: "url"; url: string }
  | { type: "code"; code: string }
  | {
      type: "state";
      state: "running" | "ready" | "error" | "cancelled";
      error?: string;
    };

/** The gateway's login API, as the client link offers it. */
export interface RemoteLoginPort {
  start(start: {
    kind: LoginKind;
    accountId?: string;
    name?: string;
  }): Promise<{ loginId: string; accountId: string }>;
  input(loginId: string, text: string): Promise<void>;
  /** `unknown`: the gateway runs no such login for this client any more. */
  cancel(loginId: string): Promise<"cancelled" | "unknown">;
  /** Removes the account on the gateway (`accounts.remove`). */
  remove(accountId: string): Promise<void>;
}

interface RemoteRun {
  /** This server's id for the run, shown to viewers; not the gateway's. */
  runId: string;
  /** The token of the dialog start that created it; never sent upstream. */
  startToken?: string;
  /** Absent until the gateway answered the start. */
  loginId?: string;
  /** Empty for an account being added, until the gateway answered. */
  accountId: string;
  kind: LoginKind;
  status: AccountLoginStatus;
  output: string;
  startedAt: number;
  error?: string;
  finished: boolean;
  viewers: Set<WebSocket>;
  url?: string;
  code?: string;
  /** A cancel before the start's answer, forwarded once with its login id. */
  cancelLatched: boolean;
  /** The link dropped while it ran: its events may be lost. */
  interrupted: boolean;
  /** The gateway's answer to the start. */
  started: Promise<void>;
}

const MAX_OUTPUT_CHARS = 64_000;
const FINISHED_RETENTION_MS = 2 * 60_000;
const MAX_EARLY_EVENTS = 100;
const INTERRUPTED_TEXT =
  "The gateway connection was interrupted. Start the login again.";

let port: RemoteLoginPort | undefined;
const runs = new Map<string, RemoteRun>();
const byLogin = new Map<string, RemoteRun>();
/** Events that arrived before their start's answer, by login id. */
const early = new Map<string, RemoteLoginEvent[]>();

/** Installs the client link's port; answers its uninstall. */
export function installRemoteLoginPort(next: RemoteLoginPort): () => void {
  port = next;
  return () => {
    if (port === next) port = undefined;
  };
}

/** Whether logins go to a remote gateway (client mode). */
export function remoteLoginsActive(): boolean {
  return port !== undefined;
}

function send(viewer: WebSocket, message: AccountLoginServerMessage): void {
  if (viewer.readyState !== 1) return;
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /* a close races buffered output */
  }
}

function broadcast(run: RemoteRun, message: AccountLoginServerMessage): void {
  for (const viewer of run.viewers) send(viewer, message);
}

function deviceOf(run: RemoteRun): AccountLoginDevice | undefined {
  return run.url !== undefined && run.code !== undefined
    ? { verificationUri: run.url, userCode: run.code }
    : undefined;
}

/** `errorOnAccount: false` shows an error to the dialog only, not on the account. */
function finish(
  run: RemoteRun,
  status: Exclude<AccountLoginStatus, "connecting">,
  error?: string,
  errorOnAccount = true,
): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  if (error !== undefined) run.error = error;
  if (run.loginId !== undefined) byLogin.delete(run.loginId);
  if (status === "ready") completeCredentialProfileLogin(run.accountId);
  else if (
    status === "error" &&
    errorOnAccount &&
    credentialProfileById(run.accountId)
  )
    setCredentialProfileLoginState(run.accountId, {
      status: "error",
      error: error?.slice(0, 180) ?? "Login failed.",
    });
  else clearCredentialProfileLoginState(run.accountId);
  broadcast(run, {
    type: "status",
    runId: run.runId,
    status,
    ...(error ? { error } : {}),
  });
  setTimeout(() => {
    if (runs.get(run.accountId) === run) runs.delete(run.accountId);
  }, FINISHED_RETENTION_MS).unref?.();
}

function apply(run: RemoteRun, event: RemoteLoginEvent): void {
  if (run.finished) return;
  switch (event.type) {
    case "output": {
      // Codex's output repeats its URL and code; the dialog shows `device`.
      if (run.kind !== "claude") return;
      const chunk = event.text.slice(0, MAX_OUTPUT_CHARS - run.output.length);
      if (!chunk) return;
      run.output += chunk;
      broadcast(run, { type: "output", chunk });
      return;
    }
    case "url":
    case "code": {
      if (run.kind !== "openai-codex") return;
      // Short-lived instructions, not credentials: kept out of logs.
      if (event.type === "url") run.url = event.url;
      else run.code = event.code;
      const device = deviceOf(run);
      if (device) broadcast(run, { type: "device", device });
      return;
    }
    case "state":
      if (event.state === "running") return;
      // The reconnect's cancel ended it; its own end was lost.
      if (event.state === "cancelled" && run.interrupted)
        finish(run, "error", INTERRUPTED_TEXT, false);
      else finish(run, event.state, event.error);
  }
}

/**
 * Cancels the run's login on the gateway. An `unknown` answer means the
 * gateway no longer runs it, so its end never reached this server.
 */
function cancelOnGateway(run: RemoteRun, loginId: string): void {
  const gateway = port;
  if (!gateway) return;
  gateway.cancel(loginId).then(
    (answer) => {
      if (answer === "unknown") finish(run, "error", INTERRUPTED_TEXT, false);
    },
    // No answer (the link dropped): a later reconnect cancels it again.
    () => {},
  );
}

/** The link's connection ended: every running login may miss its events. */
export function remoteLoginsDisconnected(): void {
  for (const run of byLogin.values()) run.interrupted = true;
}

/** A connection is back: each interrupted login is ended on the gateway. */
export function remoteLoginsReconnected(): void {
  for (const [loginId, run] of [...byLogin])
    if (run.interrupted) cancelOnGateway(run, loginId);
}

/** A `logins.event` from the gateway. */
export function remoteLoginEvent(
  loginId: string,
  event: RemoteLoginEvent,
): void {
  const run = byLogin.get(loginId);
  if (run) return apply(run, event);
  const queued = early.get(loginId) ?? [];
  if (queued.length >= MAX_EARLY_EVENTS) return;
  queued.push(event);
  early.set(loginId, queued);
}

/**
 * Asks the gateway for a login and answers its run at once: in the account's
 * slot when the account is known, else (an account being added) once the
 * gateway named it. A rejected start ends its viewers with its error.
 */
function launch(
  start: {
    kind: LoginKind;
    accountId?: string;
    name?: string;
  },
  startToken?: string,
): RemoteRun {
  const gateway = port;
  if (!gateway) throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  const run: RemoteRun = {
    runId: randomUUID(),
    ...(startToken !== undefined ? { startToken } : {}),
    accountId: start.accountId ?? "",
    kind: start.kind,
    status: "connecting",
    output: "",
    startedAt: Date.now(),
    finished: false,
    viewers: new Set(),
    cancelLatched: false,
    interrupted: false,
    started: Promise.resolve(),
  };
  if (start.accountId) runs.set(start.accountId, run);
  run.started = gateway.start(start).then(
    ({ loginId, accountId }) => {
      run.loginId = loginId;
      run.accountId = accountId;
      runs.set(accountId, run);
      byLogin.set(loginId, run);
      setCredentialProfileLoginState(accountId, { status: "connecting" });
      const queued = early.get(loginId) ?? [];
      early.delete(loginId);
      for (const event of queued) apply(run, event);
      if (run.cancelLatched && !run.finished) cancelOnGateway(run, loginId);
    },
    (err: unknown) => {
      if (runs.get(run.accountId) === run) runs.delete(run.accountId);
      run.finished = true;
      run.status = "error";
      run.error = errorText(err);
      for (const viewer of run.viewers) {
        send(viewer, {
          type: "status",
          runId: run.runId,
          status: "error",
          error: run.error,
        });
        viewer.close(1011, "Login unavailable");
      }
      run.viewers.clear();
      throw err;
    },
  );
  return run;
}

/** Adds an account through its first login; answers its id. */
export async function createRemoteAccount(
  kind: LoginKind,
  name: string,
): Promise<string> {
  const run = launch({ kind, name });
  await run.started;
  return run.accountId;
}

/** Settings' delete in client mode: the gateway removes the account. */
export async function deleteRemoteAccount(accountId: string): Promise<void> {
  if (!port) throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  if (!credentialProfileById(accountId))
    throw new Error("Credential profile not found.");
  assertCredentialProfileDeletable(accountId);
  await port.remove(accountId);
}

function handleMessage(run: RemoteRun, message: AccountLoginClientMessage) {
  if (run.finished) return;
  if (message.type === "cancel") {
    if (run.loginId === undefined) run.cancelLatched = true;
    else cancelOnGateway(run, run.loginId);
    return;
  }
  // Before the answer there is no login to take it; Codex takes none.
  if (run.loginId === undefined || run.kind !== "claude") return;
  // Never logged: it may be the OAuth authorization code.
  void port?.input(run.loginId, message.data).catch(() => {});
}

/**
 * The login dialog's viewer of an account's gateway login, under `intent`;
 * undefined for an `attach` that finds no run. Throws, sending nothing, when
 * no gateway is linked or the account is no login account.
 */
export function attachRemoteLogin(
  viewer: WebSocket,
  accountId: string,
  intent: AccountLoginIntent,
  startToken?: string,
):
  | {
      runId: string;
      message(message: AccountLoginClientMessage): void;
      detach(): void;
    }
  | undefined {
  const profile = credentialProfileById(accountId);
  if (
    !profile ||
    (profile.provider !== "claude" && profile.provider !== "openai-codex")
  )
    throw new Error("That is not a login account.");
  let run = runs.get(accountId);
  if (intent === "attach") {
    if (!run) return undefined;
  } else if (!run || run.finished) {
    // A finished run's viewers keep it; the account's slot gets a new one.
    run = launch({ kind: profile.provider, accountId }, startToken);
    run.started.catch(() => {});
  }
  const current = run;
  current.viewers.add(viewer);
  const device = deviceOf(current);
  send(viewer, {
    type: "snapshot",
    profileId: accountId,
    runId: current.runId,
    ...(current.startToken !== undefined
      ? { startToken: current.startToken }
      : {}),
    provider: current.kind,
    status: current.status,
    output: current.output,
    startedAt: current.startedAt,
    ...(current.error ? { error: current.error } : {}),
    ...(device ? { device } : {}),
  });
  return {
    runId: current.runId,
    message: (message) => handleMessage(current, message),
    detach: () => current.viewers.delete(viewer),
  };
}
