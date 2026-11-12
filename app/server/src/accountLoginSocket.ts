/**
 * The login dialog's socket, `/ws/account-login?profileId=…&intent=…`, for a
 * Claude or OpenAI (Codex) account login (Task-1402 B1, `docs/workers.md`
 * "Credentials"). It validates the request, picks the run (the gateway's in
 * client mode, else the local Claude CLI or pi's device-code login), and
 * installs the socket's listeners synchronously, before anything awaits.
 *
 * - `start` (a deliberate user action) joins the account's unfinished run, or
 *   starts a new one, retiring a finished one;
 * - `attach` (the browser's reconnect) joins any retained run, unfinished or
 *   finished, and never starts a provider login. Without a run it answers a
 *   fixed error and touches nothing.
 *
 * Every message is validated before it has any effect: a non-null, non-array
 * object with a known `type`; `input` needs a string of at most 8,192
 * characters. Input is never logged or echoed. Closing the socket only
 * detaches its viewer; only `cancel` ends a login.
 */
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type {
  AccountLoginClientMessage,
  AccountLoginIntent,
  AccountLoginServerMessage,
} from "@assistant/shared";
import { attachClaudeLogin } from "./claudeLoginTerminal.ts";
import { credentialProfileById } from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import { attachOpenAiLogin } from "./openAiLoginTerminal.ts";
import { attachRemoteLogin, remoteLoginsActive } from "./remoteLogins.ts";

const MAX_INPUT_CHARS = 8_192;
export const LOGIN_NOT_RUNNING_TEXT =
  "This login is no longer running. Start it again from the account.";

/** One client message, or undefined for anything malformed. */
function parseClientMessage(
  raw: string,
): AccountLoginClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const message = parsed as { type?: unknown; data?: unknown };
  if (message.type === "cancel") return { type: "cancel" };
  if (
    message.type === "input" &&
    typeof message.data === "string" &&
    message.data.length <= MAX_INPUT_CHARS
  )
    return { type: "input", data: message.data };
  return undefined;
}

function refuse(
  viewer: WebSocket,
  error: string,
  code: number,
  reason: string,
) {
  const message: AccountLoginServerMessage = {
    type: "status",
    status: "error",
    error,
  };
  if (viewer.readyState === 1)
    try {
      viewer.send(JSON.stringify(message));
    } catch {
      /* a close races the refusal */
    }
  viewer.close(code, reason);
}

/** Attaches one authenticated browser to an account's login. */
export function attachAccountLoginSocket(
  viewer: WebSocket,
  req: IncomingMessage,
): void {
  const url = new URL(
    req.url ?? "/ws/account-login",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const profileId = url.searchParams.get("profileId") ?? "";
  const rawIntent = url.searchParams.get("intent");
  const profile = credentialProfileById(profileId);
  if (
    !profile ||
    (profile.provider !== "claude" && profile.provider !== "openai-codex")
  ) {
    refuse(viewer, "That is not a login account.", 1008, "Invalid profile");
    return;
  }
  if (rawIntent !== "start" && rawIntent !== "attach") {
    refuse(viewer, "Unknown login intent.", 1008, "Invalid intent");
    return;
  }
  const intent: AccountLoginIntent = rawIntent;
  let attached: ReturnType<typeof attachClaudeLogin>;
  try {
    attached = remoteLoginsActive()
      ? attachRemoteLogin(viewer, profileId, intent)
      : profile.provider === "claude"
        ? attachClaudeLogin(viewer, profileId, intent)
        : attachOpenAiLogin(viewer, profileId, intent);
  } catch (error) {
    refuse(viewer, errorText(error), 1011, "Login unavailable");
    return;
  }
  if (!attached) {
    refuse(viewer, LOGIN_NOT_RUNNING_TEXT, 1000, "No login");
    return;
  }
  const { message, detach } = attached;
  viewer.on("message", (raw) => {
    const parsed = parseClientMessage(String(raw));
    if (parsed) message(parsed);
  });
  viewer.on("close", detach);
  viewer.on("error", detach);
}
