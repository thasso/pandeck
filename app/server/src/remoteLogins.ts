/**
 * Client mode's logins (plan Task-1385, M12): Settings' existing login UI,
 * rendered from the gateway's login API (`logins.*` on gateway client 1.0,
 * through `gatewayClientLink.ts`). The gateway runs the driver and keeps the
 * credential; this server only relays the interaction.
 *
 * - Adding an account starts its first login on the gateway, which registers
 *   the account at once (it needs a login until that succeeds).
 * - Claude: the login terminal's socket (`/ws/claude-login`) attaches to the
 *   account's run, started on demand, and sees today's `snapshot`, `output`
 *   and `status` messages; its input and cancel go to the gateway.
 * - Codex: the device code's URL and code become the account's login state,
 *   as the server's own login sets them.
 *
 * - Deleting an account removes it on the gateway; the mirror then drops it.
 *
 * One run per account; a finished one is kept two minutes for a viewer that
 * reconnects.
 */
import type { WebSocket } from "ws";
import type {
  ClaudeLoginServerMessage,
  ClaudeLoginTerminalStatus,
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
  cancel(loginId: string): Promise<void>;
  /** Removes the account on the gateway (`accounts.remove`). */
  remove(accountId: string): Promise<void>;
}

interface RemoteRun {
  loginId: string;
  accountId: string;
  kind: LoginKind;
  status: ClaudeLoginTerminalStatus;
  output: string;
  startedAt: number;
  error?: string;
  finished: boolean;
  viewers: Set<WebSocket>;
  url?: string;
}

const MAX_OUTPUT_CHARS = 64_000;
const FINISHED_RETENTION_MS = 2 * 60_000;
const MAX_EARLY_EVENTS = 100;

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

function send(viewer: WebSocket, message: ClaudeLoginServerMessage): void {
  if (viewer.readyState !== 1) return;
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /* a close races buffered output */
  }
}

function broadcast(run: RemoteRun, message: ClaudeLoginServerMessage): void {
  for (const viewer of run.viewers) send(viewer, message);
}

function finish(
  run: RemoteRun,
  status: Exclude<ClaudeLoginTerminalStatus, "connecting">,
  error?: string,
): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  if (error !== undefined) run.error = error;
  byLogin.delete(run.loginId);
  if (status === "ready") completeCredentialProfileLogin(run.accountId);
  else if (status === "error" && credentialProfileById(run.accountId))
    setCredentialProfileLoginState(run.accountId, {
      status: "error",
      error: error?.slice(0, 180) ?? "Login failed.",
    });
  else clearCredentialProfileLoginState(run.accountId);
  broadcast(run, { type: "status", status, ...(error ? { error } : {}) });
  setTimeout(() => {
    if (runs.get(run.accountId) === run) runs.delete(run.accountId);
  }, FINISHED_RETENTION_MS).unref?.();
}

function apply(run: RemoteRun, event: RemoteLoginEvent): void {
  if (run.finished) return;
  switch (event.type) {
    case "output": {
      const chunk = event.text.slice(0, MAX_OUTPUT_CHARS - run.output.length);
      if (!chunk) return;
      run.output += chunk;
      broadcast(run, { type: "output", chunk });
      return;
    }
    case "url":
      run.url = event.url;
      return;
    case "code":
      // Short-lived instructions, not credentials: kept out of logs.
      if (run.kind === "openai-codex")
        setCredentialProfileLoginState(run.accountId, {
          status: "connecting",
          ...(run.url !== undefined ? { verificationUri: run.url } : {}),
          userCode: event.code,
        });
      return;
    case "state":
      if (event.state !== "running") finish(run, event.state, event.error);
  }
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

/** The account's running login, or a new one on the gateway. */
async function begin(start: {
  kind: LoginKind;
  accountId?: string;
  name?: string;
}): Promise<RemoteRun> {
  if (!port) throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  const running = start.accountId ? runs.get(start.accountId) : undefined;
  if (running && !running.finished) return running;
  const { loginId, accountId } = await port.start(start);
  const known = byLogin.get(loginId);
  if (known) return known;
  const run: RemoteRun = {
    loginId,
    accountId,
    kind: start.kind,
    status: "connecting",
    output: "",
    startedAt: Date.now(),
    finished: false,
    viewers: new Set(),
  };
  runs.set(accountId, run);
  byLogin.set(loginId, run);
  setCredentialProfileLoginState(accountId, { status: "connecting" });
  const queued = early.get(loginId) ?? [];
  early.delete(loginId);
  for (const event of queued) apply(run, event);
  return run;
}

/** Adds an account through its first login; answers its id. */
export async function createRemoteAccount(
  kind: LoginKind,
  name: string,
): Promise<string> {
  return (await begin({ kind, name })).accountId;
}

/** Settings' delete in client mode: the gateway removes the account. */
export async function deleteRemoteAccount(accountId: string): Promise<void> {
  if (!port) throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  if (!credentialProfileById(accountId))
    throw new Error("Credential profile not found.");
  assertCredentialProfileDeletable(accountId);
  await port.remove(accountId);
}

/** Settings' Codex login for an account: its device code shows on it. */
export async function startRemoteCodexLogin(accountId: string): Promise<void> {
  const profile = credentialProfileById(accountId);
  if (!profile || profile.provider !== "openai-codex")
    throw new Error("That is not an OpenAI profile.");
  await begin({ kind: "openai-codex", accountId });
}

/** Settings' Claude login terminal for an account, on the gateway's login. */
export function attachRemoteClaudeLogin(
  viewer: WebSocket,
  accountId: string,
): void {
  const profile = credentialProfileById(accountId);
  if (!profile || profile.provider !== "claude") {
    send(viewer, {
      type: "status",
      status: "error",
      error: "That is not a Claude credential profile.",
    });
    viewer.close(1008, "Invalid Claude credential profile");
    return;
  }
  begin({ kind: "claude", accountId }).then(
    (run) => {
      run.viewers.add(viewer);
      send(viewer, {
        type: "snapshot",
        profileId: accountId,
        status: run.status,
        output: run.output,
        startedAt: run.startedAt,
        ...(run.error ? { error: run.error } : {}),
      });
      viewer.on("message", (raw) => {
        let message: { type?: unknown; data?: unknown };
        try {
          message = JSON.parse(raw.toString()) as typeof message;
        } catch {
          return;
        }
        if (run.finished || !port) return;
        if (message.type === "cancel")
          void port.cancel(run.loginId).catch(() => {});
        else if (message.type === "input" && typeof message.data === "string")
          // Never logged: it may be the OAuth authorization code.
          void port.input(run.loginId, message.data).catch(() => {});
      });
      const detach = () => run.viewers.delete(viewer);
      viewer.on("close", detach);
      viewer.on("error", detach);
    },
    (err: unknown) => {
      send(viewer, { type: "status", status: "error", error: errorText(err) });
      viewer.close(1011, "Login unavailable");
    },
  );
}
