/**
 * Gateway client 1.0 (plan Task-1384 §2): what an enrolled client (a Pandeck
 * server, through its relay) and the gateway edge send each other over the
 * worker protocol's framing, on the edge's mutual-TLS client port. The client
 * is who its certificate names; every method acts on that client's leases and
 * its user's accounts only.
 *
 * - `client.hello {}` answers `{clientId, userId}`.
 * - `accounts.list {}` answers `{accounts}`: the user's Claude and Codex
 *   accounts, `{id, provider, name, enabled, needsLogin}`.
 * - `leases.grant {accountId, workerId, sessionId?}` answers `{leaseId,
 *   token}`, an engine lease owned by this client.
 * - `leases.client {accountId}` answers `{leaseId, token}`: the client's
 *   lease for its own one-shots and usage, revoking its earlier one for that
 *   account.
 * - `leases.bindSession`, `leases.revoke` and `leases.reconcileWorker` as in
 *   gateway control 1.x, on this client's leases only.
 *
 * - `accounts.remove {accountId}` answers `{}`: removes the user's account,
 *   its leases and any login it has running, and the token file the gateway
 *   made for it.
 * - `logins.start {kind, accountId?, name?}` answers `{loginId, accountId}`:
 *   a login for the user's account, or for a new one (`logins.ts`).
 * - `logins.input {loginId, text}` and `logins.cancel {loginId}` answer `{}`,
 *   for this client's logins only.
 *
 * The user's integration credentials (Task-1397), the user always the
 * client's from the registry; a `userId` in a payload is ignored:
 *
 * - `integrations.set {integration, site, email, token}` checks the
 *   credential with the integration and stores it in the vault; answers
 *   `{connected: true, kind: "token", site, email, displayName?,
 *   accountId?, connectWith}`. A gateway whose page offers "Sign in with
 *   Atlassian" (Task-1411) refuses every set `integration_sign_in_required`.
 * - `integrations.clear {integration}` answers `{}`.
 * - `integrations.status {integration, check?}` answers `{connected, kind?,
 *   site?, email?, displayName?, accountId?, problem?, connectWith}`: `kind`
 *   (`token` or `oauth`) and `site` whenever a credential is stored, `email`
 *   for an API token (an OAuth record has none), and with `check` whether it
 *   works; `problem: "rejected"` with `kind: "oauth"` also when the vault's
 *   OAuth refresh was refused. Never a token.
 * - `connectWith` on both says how this gateway makes a new connection:
 *   `oauth` on its page, or `token` through `integrations.set`. An older edge
 *   answers without it or `kind`.
 *
 * The edge's tools (Task-1398), run with the client's user's credential:
 *
 * - `tools.list {}` answers `{tools}`: each `{name, description,
 *   inputSchema, effect, actionKey}`, and `twoPhase: true` on a write tool
 *   that runs as `tools.prepare` and `tools.apply` (1.1, Task-1463 P6a), or
 *   `file: {limitParam, defaultBytes, maxBytes}` on a file tool (1.2,
 *   Task-1441 P7a).
 * - `tools.call {name, args}` answers the tool's outcome, `{ok: true, text}`
 *   or `{ok: false, code, message}`, with no stream; only a malformed request
 *   fails the call. A `cancel` aborts it. A write tool is refused
 *   `invalid_params` before any credential read: a client connection writes
 *   only in two phases (1.1; a 1.0 client gets the same refusal).
 * - A file tool's `tools.call` (1.2) may instead answer `{ok: true, text,
 *   file: {name, mimeType, size, sha256}}` with exactly one byte stream,
 *   `file`: `size` its length, `sha256` its lowercase hex digest. A client
 *   reads it only with `decodeFileAnswer`, chosen by the tool it called,
 *   never by the reply. One file call runs at a time per edge; another
 *   answers `tool_error` with a fixed busy text and sends nothing upstream.
 *   A client refuses a stream on any other call's answer and keeps nothing.
 * - `tools.prepare {name, args}` (1.1) answers `{ok: true, site, items,
 *   warnings}`, the proposal the shared prepare built for the credential's
 *   site, or `{ok: false, code, message}`; nothing is written. At most
 *   `PREPARE_ANSWER_MAX_BYTES`. A `cancel` aborts it.
 * - `tools.apply {name, site, items}` (1.1) runs the approved items, every
 *   refusal before any write, and answers `{ok: true, results, effects,
 *   trimmed?}`, one result record per item, or `{ok: false, code, message,
 *   effects, itemEffects?, results?, trimmed?}`. `effects` (`none` or
 *   `possible`) says whether any write request left the edge; `itemEffects`
 *   says it per item once the items passed their check; a failure after the
 *   apply started keeps the records its working copy shows. A root `none`
 *   with any `possible` record or item is undecodable. A `cancel` starts no
 *   further item and never aborts a running request. At most
 *   `APPLY_ANSWER_MAX_BYTES`: the edge never sends a larger answer, and the
 *   client refuses one.
 *
 * Client-mode uploads (1.3, Task-1441 P8a): Pandeck sends the approved bytes
 * before the apply that writes them, on the same connection.
 *
 * - `tools.prepare` may carry `uploads: [{stagedAttachmentId, name, mimeType,
 *   size, sha256, source}]` beside `name` and `args`: the sources its upload
 *   items name by `sourceAttachmentId`. At most ten, ids unique.
 * - `uploads.open {streams: [{stagedAttachmentId, size, sha256}], work}`
 *   answers `{ok: true, uploadId}`: one to ten streams, `work` (W) the items'
 *   total bytes, at least the streams' and at most 100 MiB. It reserves the
 *   edge's one file permit, so a running download or upload answers busy.
 * - `uploads.put {uploadId, stagedAttachmentId, offset}` with exactly one
 *   bytes stream, `chunk` (1 B to 1 MiB), at exactly the bytes received so
 *   far, answers `{ok: true, received, streamComplete, sealed}`:
 *   `streamComplete` on the put that completes its stream with the declared
 *   digest, `sealed` once every stream is complete.
 * - `uploads.release {uploadId}` answers `{ok: true}` and discards an
 *   upload no apply took; it is idempotent.
 * - `tools.apply` may carry `uploadId`: the apply consumes that sealed upload,
 *   whose streams must match its upload items exactly. It answers only in the
 *   apply envelope.
 * - Each `uploads.*` request has exactly its JSON keys and no other stream;
 *   any failure answers `{ok: false, code: "tool_error", message}` with a
 *   fixed text, and a bad put or request discards the upload.
 *
 * Gateway → client: `accounts.changed {accounts}`, the full list after any
 * change, and `logins.event {loginId, accountId, event}`, each answered `{}`.
 */
import { createHash } from "node:crypto";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerMethodError,
  type ConnectionProtocol,
} from "../workerProtocol/connection.ts";
import type { LeaseProvider } from "./leases.ts";
import type { LoginEvent, LoginStart } from "./logins.ts";
import { isLeaseProvider, isProfileId } from "./profiles.ts";
import { isOwnerId } from "./state.ts";
import { INVALID_PARAMS } from "./controlMethods.ts";
import type {
  ApplyAnswer,
  ApplyRequest,
  Effects,
  PrepareAnswer,
  ToolAnswer,
  ToolFailureCode,
} from "./edgeTools.ts";

/**
 * 1.1 (Task-1463 P6a) adds `tools.prepare` and `tools.apply`, 1.2 (Task-1441
 * P7a) file answers, 1.3 (Task-1441 P8a) the upload methods and fields; every
 * 1.x peer still connects.
 */
export const GATEWAY_CLIENT_VERSION = "gateway-client/1.3";

const CLIENT_VERSION_RE =
  /^gateway-client\/(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export const GATEWAY_CLIENT_PROTOCOL: ConnectionProtocol = {
  version: GATEWAY_CLIENT_VERSION,
  compatible: (version) => CLIENT_VERSION_RE.exec(version)?.[1] === "1",
};

export const CLIENT_METHODS = {
  hello: "client.hello",
  listAccounts: "accounts.list",
  grant: "leases.grant",
  clientLease: "leases.client",
  bindSession: "leases.bindSession",
  revoke: "leases.revoke",
  reconcileWorker: "leases.reconcileWorker",
  removeAccount: "accounts.remove",
  loginStart: "logins.start",
  loginInput: "logins.input",
  loginCancel: "logins.cancel",
  integrationSet: "integrations.set",
  integrationClear: "integrations.clear",
  integrationStatus: "integrations.status",
  toolsList: "tools.list",
  toolsCall: "tools.call",
  toolsPrepare: "tools.prepare",
  toolsApply: "tools.apply",
  uploadsOpen: "uploads.open",
  uploadsPut: "uploads.put",
  uploadsRelease: "uploads.release",
  /** Gateway → client. */
  accountsChanged: "accounts.changed",
  loginEvent: "logins.event",
} as const;

/** The client's certificate is unknown or revoked: the connection ends. */
export const CLIENT_REVOKED = "client_revoked";
/** The account is not the client's user's, or not a login. */
export const UNKNOWN_ACCOUNT = "unknown_account";
/** No login by this id for this client. */
export const UNKNOWN_LOGIN = "unknown_login";
/** The gateway runs no driver for this kind of login. */
export const LOGIN_UNAVAILABLE = "login_unavailable";

/**
 * The integration methods' failures (Task-1397), each with one fixed text
 * the gateway sends and the client may show.
 */
const INTEGRATION_FAILURES = {
  integration_invalid: "The site, email or API token is not valid.",
  integration_rejected: "Atlassian rejected the email and API token.",
  integration_unreachable: "Atlassian could not check the credential.",
  vault_locked: "The vault is locked.",
  vault_unavailable: "The vault did not answer; check the Jira status.",
  tools_unavailable: "This gateway runs no tools.",
  integration_busy:
    "Another change to this credential is still running. Try again.",
  integration_sign_in_required:
    "This gateway connects Jira only with Sign in with Atlassian on its page.",
} as const;
export type IntegrationFailure = keyof typeof INTEGRATION_FAILURES;

export function isIntegrationFailure(code: string): code is IntegrationFailure {
  return Object.hasOwn(INTEGRATION_FAILURES, code);
}

export function integrationFailure(code: IntegrationFailure): never {
  throw new WorkerMethodError(code, INTEGRATION_FAILURES[code]);
}

/** Why a status answer is not connected. */
type IntegrationProblem =
  | "vault_locked"
  | "vault_unavailable"
  | "invalid"
  | "rejected"
  | "unreachable"
  | "failed";
const INTEGRATION_PROBLEMS = new Set<string>([
  "vault_locked",
  "vault_unavailable",
  "invalid",
  "rejected",
  "unreachable",
  "failed",
]);

type IntegrationKind = "token" | "oauth";
const isIntegrationKind = (value: unknown): value is IntegrationKind =>
  value === "token" || value === "oauth";

export interface IntegrationStatus {
  connected: boolean;
  /** How the stored credential was made; absent from an older edge. */
  kind?: IntegrationKind;
  /** How the gateway makes a new connection; absent from an older edge. */
  connectWith?: IntegrationKind;
  site?: string;
  email?: string;
  displayName?: string;
  accountId?: string;
  problem?: IntegrationProblem;
}

export interface ClientAccount {
  id: string;
  provider: LeaseProvider;
  name: string;
  enabled: boolean;
  needsLogin: boolean;
}

export interface ClientIdentity {
  clientId: string;
  userId: string;
}

export interface ClientGrant {
  accountId: string;
  workerId: string;
  sessionId?: string;
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new Error(`The gateway's ${what} is malformed.`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function encodeClientMessage(value: object): Payload {
  return { json: { ...value } };
}

export function decodeClientIdentity(payload: Payload): ClientIdentity {
  const answer = record(payload.json);
  if (
    !answer ||
    typeof answer.clientId !== "string" ||
    typeof answer.userId !== "string"
  )
    malformed("hello answer");
  return { clientId: answer.clientId, userId: answer.userId };
}

export function decodeAccounts(payload: Payload): ClientAccount[] {
  const accounts = record(payload.json)?.accounts;
  if (!Array.isArray(accounts)) malformed("account list");
  return accounts.map((value: unknown) => {
    const a = record(value);
    if (
      !a ||
      !isProfileId(a.id) ||
      !isLeaseProvider(a.provider) ||
      typeof a.name !== "string" ||
      typeof a.enabled !== "boolean" ||
      typeof a.needsLogin !== "boolean"
    )
      malformed("account list");
    return {
      id: a.id,
      provider: a.provider,
      name: a.name,
      enabled: a.enabled,
      needsLogin: a.needsLogin,
    };
  });
}

export function decodeClientGrant(payload: Payload): ClientGrant {
  const { accountId, workerId, sessionId } = record(payload.json) ?? {};
  if (!isProfileId(accountId)) invalid("account id");
  if (!isOwnerId(workerId)) invalid("Worker id");
  if (sessionId === undefined) return { accountId, workerId };
  if (!isOwnerId(sessionId)) invalid("session id");
  return { accountId, workerId, sessionId };
}

export function decodeAccountId(payload: Payload): string {
  const accountId = record(payload.json)?.accountId;
  if (!isProfileId(accountId)) invalid("account id");
  return accountId;
}

export function decodeLoginStart(payload: Payload): LoginStart {
  const { kind, accountId, name } = record(payload.json) ?? {};
  if (!isLeaseProvider(kind)) invalid("login kind");
  if (accountId !== undefined && !isProfileId(accountId)) invalid("account id");
  if (name !== undefined && (typeof name !== "string" || name.length > 200))
    invalid("account name");
  return {
    kind,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

export function decodeLoginStarted(payload: Payload): {
  loginId: string;
  accountId: string;
} {
  const { loginId, accountId } = record(payload.json) ?? {};
  if (typeof loginId !== "string" || !isProfileId(accountId))
    malformed("login start answer");
  return { loginId, accountId };
}

export function decodeLoginId(payload: Payload): string {
  const loginId = record(payload.json)?.loginId;
  if (typeof loginId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(loginId))
    invalid("login id");
  return loginId;
}

export function decodeLoginInput(payload: Payload): {
  loginId: string;
  text: string;
} {
  const text = record(payload.json)?.text;
  if (typeof text !== "string") invalid("login input");
  return { loginId: decodeLoginId(payload), text };
}

function integrationOf(value: unknown): "atlassian" {
  if (value !== "atlassian") invalid("integration");
  return value;
}

/** `integrations.set`: the integration and the raw fields its parser checks. */
export function decodeIntegrationSet(payload: Payload): {
  integration: "atlassian";
  input: { site: unknown; email: unknown; token: unknown };
} {
  const { integration, site, email, token } = record(payload.json) ?? {};
  return {
    integration: integrationOf(integration),
    input: { site, email, token },
  };
}

export function decodeIntegration(payload: Payload): "atlassian" {
  return integrationOf(record(payload.json)?.integration);
}

export function decodeIntegrationStatusRequest(payload: Payload): {
  integration: "atlassian";
  check: boolean;
} {
  const body = record(payload.json) ?? {};
  if (body.check !== undefined && typeof body.check !== "boolean")
    invalid("check");
  return {
    integration: integrationOf(body.integration),
    check: body.check === true,
  };
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;

/** A `integrations.set` or `integrations.status` answer, on the client. */
export function decodeIntegrationStatus(payload: Payload): IntegrationStatus {
  const answer = record(payload.json);
  if (!answer || typeof answer.connected !== "boolean")
    malformed("integration status");
  const site = text(answer.site, 255);
  const email = text(answer.email, 254);
  const displayName = text(answer.displayName, 200);
  const accountId = text(answer.accountId, 200);
  const problem =
    typeof answer.problem === "string" &&
    INTEGRATION_PROBLEMS.has(answer.problem)
      ? (answer.problem as IntegrationProblem)
      : undefined;
  return {
    connected: answer.connected,
    ...(isIntegrationKind(answer.kind) ? { kind: answer.kind } : {}),
    ...(isIntegrationKind(answer.connectWith)
      ? { connectWith: answer.connectWith }
      : {}),
    ...(site !== undefined ? { site } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(problem !== undefined ? { problem } : {}),
  };
}

const LOGIN_STATES = new Set(["running", "ready", "error", "cancelled"]);

/** A `logins.event` from the gateway, or undefined when malformed. */
export function decodeLoginEvent(
  payload: Payload,
): { loginId: string; accountId: string; event: LoginEvent } | undefined {
  const { loginId, accountId, event } = record(payload.json) ?? {};
  const e = record(event);
  if (typeof loginId !== "string" || !isProfileId(accountId) || !e)
    return undefined;
  const at = { loginId, accountId };
  if (e.type === "output" && typeof e.text === "string")
    return { ...at, event: { type: "output", text: e.text } };
  if (e.type === "url" && typeof e.url === "string")
    return { ...at, event: { type: "url", url: e.url } };
  if (e.type === "code" && typeof e.code === "string")
    return { ...at, event: { type: "code", code: e.code } };
  if (
    e.type === "state" &&
    typeof e.state === "string" &&
    LOGIN_STATES.has(e.state) &&
    (e.error === undefined || typeof e.error === "string")
  )
    return {
      ...at,
      event: {
        type: "state",
        state: e.state as Extract<LoginEvent, { type: "state" }>["state"],
        ...(typeof e.error === "string" ? { error: e.error } : {}),
      },
    };
  return undefined;
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** `tools.call`: the tool's name and its arguments, a plain object. */
export function decodeToolCall(payload: Payload): {
  name: string;
  args: Record<string, unknown>;
} {
  const { name, args } = record(payload.json) ?? {};
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name))
    invalid("tool name");
  if (args === undefined) return { name, args: {} };
  const object = record(args);
  if (!object) invalid("tool arguments");
  return { name, args: object };
}

/** A `tools.list` answer's entries, unchecked: the client accepts them. */
export function decodeToolListing(payload: Payload): unknown[] {
  const tools = record(payload.json)?.tools;
  if (!Array.isArray(tools)) malformed("tool list");
  return tools;
}

const TOOL_FAILURE_CODES = new Set<string>([
  "unknown_tool",
  "invalid_params",
  "tool_error",
  "result_too_large",
  "timeout",
  "cancelled",
  "failed",
] satisfies ToolFailureCode[]);
const TOOL_MESSAGE_MAX = 500;

/** A failure answer's code and message, capped; an unknown code is `failed`. */
function toolFailure(answer: Record<string, unknown>): {
  ok: false;
  code: ToolFailureCode;
  message: string;
} {
  return {
    ok: false,
    code:
      typeof answer.code === "string" && TOOL_FAILURE_CODES.has(answer.code)
        ? (answer.code as ToolFailureCode)
        : "failed",
    message:
      typeof answer.message === "string"
        ? answer.message.slice(0, TOOL_MESSAGE_MAX)
        : "",
  };
}

/** Whether `payload` carries any named text or byte stream. */
function hasStreams(payload: Payload): boolean {
  return (
    Object.keys(payload.text ?? {}).length > 0 ||
    Object.keys(payload.bytes ?? {}).length > 0
  );
}

/**
 * A `tools.call` answer, on the client: an unknown code reads as `failed`.
 * A stream is a {@link FileAnswerRefusal} `unexpected` here, whatever the
 * JSON says: a file answer is read only by `decodeFileAnswer`, for a call
 * made as a file call (Task-1441 P7a, G1).
 */
export function decodeToolAnswer(payload: Payload): ToolAnswer {
  if (hasStreams(payload)) throw new FileAnswerRefusal("unexpected");
  const answer = record(payload.json);
  if (answer?.ok === true && typeof answer.text === "string")
    return { ok: true, text: answer.text };
  if (answer?.ok !== false) malformed("tool answer");
  return toolFailure(answer);
}

/**
 * An answer the client refuses for carrying, or being, a file it cannot take
 * (Task-1441 P7a, G4): `unexpected` for a stream on a plain call or a file
 * answer's shape or size, `corrupted` for a digest that does not match.
 * Nothing of it may be kept. The message names only the reason; the agent's
 * fixed text is the caller's (`tools/gateway/remoteReadRules.ts`).
 */
export class FileAnswerRefusal extends Error {
  constructor(readonly reason: "unexpected" | "corrupted") {
    super(`The gateway's file answer is ${reason}.`);
  }
}

/** A decoded file tool answer: a file, a plain success, or the failure. */
export type FileAnswer =
  | {
      kind: "file";
      text: string;
      file: { name: string; mimeType: string; size: number; sha256: string };
      bytes: Uint8Array;
    }
  | { kind: "plain"; text: string }
  | { kind: "failure"; code: ToolFailureCode; message: string };

/** The longest result text a tool answers (the edge's 60k budget). */
const FILE_TEXT_MAX = 60_000;
const FILE_NAME_MAX = 1024;
const FILE_MIME_MAX = 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value);
  return (
    own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
};

/**
 * A file tool's `tools.call` answer (Task-1441 P7a, G4 and H3), at most
 * `maxBytes` (the call's effective limit), checked in order: exact keys, the
 * one `file` stream, its size, its digest, then the name and MIME bounds and
 * the text. Tool-neutral: the tool's own adapter checks the text's fields.
 * Throws `FileAnswerRefusal`.
 */
export function decodeFileAnswer(
  payload: Payload,
  expect: { maxBytes: number },
): FileAnswer {
  const unexpected = (): never => {
    throw new FileAnswerRefusal("unexpected");
  };
  const answer = record(payload.json) ?? unexpected();
  if (answer.ok === false) {
    if (hasStreams(payload) || !exactKeys(answer, ["ok", "code", "message"]))
      unexpected();
    const { code, message } = toolFailure(answer);
    return { kind: "failure", code, message };
  }
  if (answer.ok !== true || typeof answer.text !== "string") unexpected();
  const text = answer.text as string;
  if (exactKeys(answer, ["ok", "text"])) {
    if (hasStreams(payload) || text.length > FILE_TEXT_MAX) unexpected();
    return { kind: "plain", text };
  }
  // 1. Exact keys.
  const file = record(answer.file);
  if (
    !exactKeys(answer, ["ok", "text", "file"]) ||
    !file ||
    !exactKeys(file, ["name", "mimeType", "size", "sha256"])
  )
    unexpected();
  // 2. Exactly one byte stream, `file`, and no text stream.
  const streams = Object.keys(payload.bytes ?? {});
  const bytes = payload.bytes?.file;
  if (
    Object.keys(payload.text ?? {}).length > 0 ||
    streams.length !== 1 ||
    !(bytes instanceof Uint8Array)
  )
    unexpected();
  // 3. Its size, within the call's limit.
  const { name, mimeType, size, sha256 } = file!;
  if (
    !Number.isSafeInteger(size) ||
    size !== bytes!.byteLength ||
    (size as number) > expect.maxBytes
  )
    unexpected();
  // 4. Its digest.
  if (
    typeof sha256 !== "string" ||
    !SHA256_RE.test(sha256) ||
    createHash("sha256").update(bytes!).digest("hex") !== sha256
  )
    throw new FileAnswerRefusal("corrupted");
  // 5. Name, MIME type and text bounds.
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > FILE_NAME_MAX ||
    typeof mimeType !== "string" ||
    mimeType.length > FILE_MIME_MAX ||
    text.length > FILE_TEXT_MAX
  )
    unexpected();
  return {
    kind: "file",
    text,
    file: {
      name: name as string,
      mimeType: mimeType as string,
      size: size as number,
      sha256,
    },
    bytes: bytes!,
  };
}

/** One upload source a `tools.prepare` declares (1.3). */
export interface UploadMeta {
  stagedAttachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  source: string;
}

/**
 * The upload bounds, mirrored from the edge's store
 * (`gatewayTools/uploads.ts`), which checks them again: `gateway/` imports no
 * tool module.
 */
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
export const UPLOAD_CHUNK_MAX_BYTES = 1024 * 1024;
const UPLOAD_MAX_STREAMS = 10;
const UPLOAD_TEXT_MAX = 1024;
/** A staged attachment id: 1-128 printable ASCII characters. */
const STAGED_ID_RE = /^[\x20-\x7e]{1,128}$/;
/** An upload id as the edge mints it, `upl-` and 32 hex digits. */
const UPLOAD_ID_RE = /^upl-[0-9a-f]{32}$/;

const isUploadSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= UPLOAD_MAX_BYTES;
const isBoundedText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= UPLOAD_TEXT_MAX;

/** v02 AC2's `uploads`: 1-10 exact entries, ids unique, else undefined. */
function uploadMetas(value: unknown): UploadMeta[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > UPLOAD_MAX_STREAMS
  )
    return undefined;
  const ids = new Set<string>();
  const out: UploadMeta[] = [];
  for (const raw of value) {
    const entry = record(raw);
    if (
      !entry ||
      !exactKeys(entry, [
        "stagedAttachmentId",
        "name",
        "mimeType",
        "size",
        "sha256",
        "source",
      ])
    )
      return undefined;
    const { stagedAttachmentId, name, mimeType, size, sha256, source } = entry;
    if (
      typeof stagedAttachmentId !== "string" ||
      !STAGED_ID_RE.test(stagedAttachmentId) ||
      ids.has(stagedAttachmentId) ||
      !isBoundedText(name) ||
      !isBoundedText(mimeType) ||
      !isBoundedText(source) ||
      !isUploadSize(size) ||
      typeof sha256 !== "string" ||
      !SHA256_RE.test(sha256)
    )
      return undefined;
    ids.add(stagedAttachmentId);
    out.push({ stagedAttachmentId, name, mimeType, size, sha256, source });
  }
  return out;
}

/**
 * `tools.prepare`: as `tools.call`, plus the optional `uploads` (1.3), never
 * read from `args`.
 */
export function decodeToolPrepare(payload: Payload): {
  name: string;
  args: Record<string, unknown>;
  uploads?: UploadMeta[];
} {
  const call = decodeToolCall(payload);
  const raw = record(payload.json)?.uploads;
  if (raw === undefined) return call;
  const uploads = uploadMetas(raw);
  if (!uploads) invalid("uploads");
  return { ...call, uploads };
}

const SITE_MAX = 253;

/**
 * `tools.apply`: the tool's name, the site the proposal was prepared for and
 * the approved items, an array; the tool checks the items themselves.
 */
export function decodeToolApply(payload: Payload): {
  name: string;
  request: ApplyRequest;
  uploadId?: string;
} {
  const { name, site, items, uploadId } = record(payload.json) ?? {};
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name))
    invalid("tool name");
  if (typeof site !== "string" || site.length === 0 || site.length > SITE_MAX)
    invalid("site");
  if (!Array.isArray(items)) invalid("items");
  if (uploadId === undefined) return { name, request: { site, items } };
  if (typeof uploadId !== "string" || !UPLOAD_ID_RE.test(uploadId))
    invalid("upload id");
  // The id is the listener's, never part of the request the tool sees.
  return { name, request: { site, items }, uploadId };
}

/** Whether `payload` carries a text stream, or a bytes stream not in `allowed`. */
function hasOtherStreams(payload: Payload, allowed: string[] = []): boolean {
  return (
    Object.keys(payload.text ?? {}).length > 0 ||
    [
      ...Object.keys(payload.bytes ?? {}),
      ...Object.keys(payload.byteParts ?? {}),
    ].some((name) => !allowed.includes(name))
  );
}

/**
 * `uploads.open` (1.3): the streams and W with v02 AC6's bounds, exact keys
 * and no stream; undefined when invalid, which the edge answers with a fixed
 * refusal rather than failing the call (v03 K3).
 */
export function decodeUploadOpen(payload: Payload):
  | {
      streams: { stagedAttachmentId: string; size: number; sha256: string }[];
      work: number;
    }
  | undefined {
  const request = record(payload.json);
  if (
    !request ||
    hasOtherStreams(payload) ||
    !exactKeys(request, ["streams", "work"])
  )
    return undefined;
  const { streams: raw, work } = request;
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > UPLOAD_MAX_STREAMS ||
    !Number.isSafeInteger(work)
  )
    return undefined;
  const ids = new Set<string>();
  const streams: {
    stagedAttachmentId: string;
    size: number;
    sha256: string;
  }[] = [];
  let total = 0;
  for (const value of raw) {
    const stream = record(value);
    if (!stream || !exactKeys(stream, ["stagedAttachmentId", "size", "sha256"]))
      return undefined;
    const { stagedAttachmentId, size, sha256 } = stream;
    if (
      typeof stagedAttachmentId !== "string" ||
      !STAGED_ID_RE.test(stagedAttachmentId) ||
      ids.has(stagedAttachmentId) ||
      !isUploadSize(size) ||
      typeof sha256 !== "string" ||
      !SHA256_RE.test(sha256)
    )
      return undefined;
    ids.add(stagedAttachmentId);
    total += size;
    streams.push({ stagedAttachmentId, size, sha256 });
  }
  if (total > (work as number) || (work as number) > UPLOAD_MAX_BYTES)
    return undefined;
  return { streams, work: work as number };
}

/**
 * `uploads.put` (1.3): `put` when the envelope is valid (exact keys, a
 * non-negative safe offset, exactly one bytes stream `chunk` of 1 B to
 * 1 MiB, no text stream); `uploadId` whenever the request names a
 * well-formed one, so the edge can discard that upload on a bad put. The
 * chunk is the stream's received slices when the connection delivers
 * `byteParts` (F004a), which the caller copies before it returns.
 */
export function decodeUploadPut(payload: Payload): {
  uploadId?: string;
  put?: {
    uploadId: string;
    stagedAttachmentId: string;
    offset: number;
    chunk: Uint8Array | readonly Uint8Array[];
  };
} {
  const request = record(payload.json);
  const named =
    typeof request?.uploadId === "string" && UPLOAD_ID_RE.test(request.uploadId)
      ? request.uploadId
      : undefined;
  const { stagedAttachmentId, offset } = request ?? {};
  const chunk = payload.byteParts?.chunk ?? payload.bytes?.chunk;
  const length = !chunk
    ? 0
    : chunk instanceof Uint8Array
      ? chunk.byteLength
      : chunk.reduce((sum, part) => sum + part.byteLength, 0);
  if (
    !request ||
    named === undefined ||
    !exactKeys(request, ["uploadId", "stagedAttachmentId", "offset"]) ||
    typeof stagedAttachmentId !== "string" ||
    !STAGED_ID_RE.test(stagedAttachmentId) ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    hasOtherStreams(payload, ["chunk"]) ||
    !chunk ||
    length < 1 ||
    length > UPLOAD_CHUNK_MAX_BYTES
  )
    return named === undefined ? {} : { uploadId: named };
  return {
    uploadId: named,
    put: {
      uploadId: named,
      stagedAttachmentId,
      offset: offset as number,
      chunk,
    },
  };
}

/** `uploads.release` (1.3): the id, exact keys and no stream; else undefined. */
export function decodeUploadRelease(payload: Payload): string | undefined {
  const request = record(payload.json);
  if (
    !request ||
    hasOtherStreams(payload) ||
    !exactKeys(request, ["uploadId"]) ||
    typeof request.uploadId !== "string" ||
    !UPLOAD_ID_RE.test(request.uploadId)
  )
    return undefined;
  return request.uploadId;
}

/** An `uploads.*` failure, on the client: always `tool_error`, its text capped. */
type UploadRefusal = { ok: false; code: "tool_error"; message: string };

function uploadRefusal(
  payload: Payload,
  answer: Record<string, unknown> | undefined,
): UploadRefusal | undefined {
  if (answer?.ok !== false) return undefined;
  if (
    hasStreams(payload) ||
    !exactKeys(answer, ["ok", "code", "message"]) ||
    answer.code !== "tool_error" ||
    typeof answer.message !== "string"
  )
    malformed("upload answer");
  return {
    ok: false,
    code: "tool_error",
    message: answer.message.slice(0, TOOL_MESSAGE_MAX),
  };
}

/** An `uploads.open` answer, on the client (1.3). */
export function decodeUploadOpenAnswer(
  payload: Payload,
): { ok: true; uploadId: string } | UploadRefusal {
  const answer = record(payload.json);
  const refused = uploadRefusal(payload, answer);
  if (refused) return refused;
  if (
    !answer ||
    hasStreams(payload) ||
    !exactKeys(answer, ["ok", "uploadId"]) ||
    answer.ok !== true ||
    typeof answer.uploadId !== "string" ||
    !UPLOAD_ID_RE.test(answer.uploadId)
  )
    malformed("upload answer");
  return { ok: true, uploadId: answer.uploadId };
}

/** An `uploads.put` answer, on the client (1.3). */
export function decodeUploadPutAnswer(
  payload: Payload,
):
  | { ok: true; received: number; streamComplete: boolean; sealed: boolean }
  | UploadRefusal {
  const answer = record(payload.json);
  const refused = uploadRefusal(payload, answer);
  if (refused) return refused;
  if (
    !answer ||
    hasStreams(payload) ||
    !exactKeys(answer, ["ok", "received", "streamComplete", "sealed"]) ||
    answer.ok !== true ||
    !Number.isSafeInteger(answer.received) ||
    (answer.received as number) < 1 ||
    (answer.received as number) > UPLOAD_MAX_BYTES ||
    typeof answer.streamComplete !== "boolean" ||
    typeof answer.sealed !== "boolean" ||
    (answer.sealed && !answer.streamComplete)
  )
    malformed("upload answer");
  return {
    ok: true,
    received: answer.received as number,
    streamComplete: answer.streamComplete as boolean,
    sealed: answer.sealed as boolean,
  };
}

/** An `uploads.release` answer, on the client (1.3). */
export function decodeUploadReleaseAnswer(
  payload: Payload,
): { ok: true } | UploadRefusal {
  const answer = record(payload.json);
  const refused = uploadRefusal(payload, answer);
  if (refused) return refused;
  if (
    !answer ||
    hasStreams(payload) ||
    !exactKeys(answer, ["ok"]) ||
    answer.ok !== true
  )
    malformed("upload answer");
  return { ok: true };
}

/**
 * The answers' ceilings in UTF-8 bytes of their JSON (P6-F3). They mirror
 * the edge's own (`gatewayTools/twoPhase.ts`), which `clientMethods.test.ts`
 * pins equal: `gateway/` imports no tool module.
 */
export const APPLY_ANSWER_MAX_BYTES = 524_288;
export const PREPARE_ANSWER_MAX_BYTES = 1_048_576 + 32_768;
const PHASE_ITEMS_MAX = 10;
const PREPARE_WARNINGS_MAX = 10;

function withinCap(payload: Payload, max: number, what: string): void {
  if (Buffer.byteLength(JSON.stringify(payload.json ?? null)) > max)
    malformed(`${what} (over its size)`);
}

/** Up to ten plain objects, else undefined. */
function records(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length > PHASE_ITEMS_MAX) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const entry of value) {
    const object = record(entry);
    if (!object) return undefined;
    out.push(object);
  }
  return out;
}

/** Anything but a plain `none` may have written. */
function effectsOf(value: unknown): Effects {
  return value === "none" ? "none" : "possible";
}

/**
 * A `tools.prepare` answer, on the client: shallow. The client checks the
 * items with the closed proposal check before it shows them.
 */
export function decodePrepareAnswer(payload: Payload): PrepareAnswer {
  withinCap(payload, PREPARE_ANSWER_MAX_BYTES, "prepare answer");
  const answer = record(payload.json);
  if (answer?.ok === false) return toolFailure(answer);
  const items = records(answer?.items);
  const warnings = answer?.warnings;
  if (
    answer?.ok !== true ||
    typeof answer.site !== "string" ||
    !items ||
    !Array.isArray(warnings) ||
    warnings.length > PREPARE_WARNINGS_MAX ||
    !warnings.every((warning) => typeof warning === "string")
  )
    malformed("prepare answer");
  return { ok: true, site: answer.site, items, warnings: [...warnings] };
}

/**
 * A `tools.apply` answer, on the client: shallow. The client checks each
 * record with the product's result contract. A failure's effects read
 * `possible` unless the edge said `none`; its `itemEffects` and `results`
 * stay only when well formed. A root `none` beside a `possible` record or
 * item is undecodable (P6a v03 "Nonblocking precision"): the edge never
 * sends one.
 */
export function decodeApplyAnswer(payload: Payload): ApplyAnswer {
  withinCap(payload, APPLY_ANSWER_MAX_BYTES, "apply answer");
  const answer = record(payload.json);
  if (answer?.ok === false) {
    const items = answer.itemEffects;
    const itemEffects =
      Array.isArray(items) && items.length <= PHASE_ITEMS_MAX
        ? items.map(effectsOf)
        : undefined;
    const results = records(answer.results);
    const failure: ApplyAnswer = {
      ...toolFailure(answer),
      effects: effectsOf(answer.effects),
      ...(itemEffects ? { itemEffects } : {}),
      ...(results ? { results } : {}),
      ...(results && answer.trimmed === true ? { trimmed: true as const } : {}),
    };
    return consistent(failure, [
      ...(itemEffects ?? []),
      ...(results ?? []).map((result) => result.effects),
    ]);
  }
  const results = records(answer?.results);
  if (
    answer?.ok !== true ||
    !results ||
    (answer.effects !== "none" && answer.effects !== "possible") ||
    (answer.trimmed !== undefined && answer.trimmed !== true)
  )
    malformed("apply answer");
  return consistent(
    {
      ok: true,
      results,
      effects: answer.effects,
      ...(answer.trimmed ? { trimmed: true as const } : {}),
    },
    results.map((result) => result.effects),
  );
}

/** `answer`, unless its root says `none` while a record or item says `possible`. */
function consistent(answer: ApplyAnswer, parts: unknown[]): ApplyAnswer {
  if (answer.effects === "none" && parts.includes("possible"))
    malformed("apply answer (its effects disagree)");
  return answer;
}
