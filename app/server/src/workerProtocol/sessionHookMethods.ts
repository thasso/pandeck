/**
 * The session-hook methods of worker protocol 1.7 and their wire shapes,
 * shared by the Worker's side (`worker/sessionHooks.ts`) and the server's
 * (`workers/sessionHookHost.ts`). An interactive engine's permission and hook
 * callbacks run on its Worker; where one needs the session's live authority or
 * writes the server's stores, it asks the server (`docs/workers.md`).
 *
 * Every method goes Worker → server and names the session:
 *
 * - `sessionHooks.canUseTool`: Claude's permission verdict for a tool name;
 * - `sessionHooks.preToolUse`: Claude's `PreToolUse` decision, Plan's refusal
 *   of a mutating native and then background admission;
 * - `sessionHooks.stop`: Claude's `Stop` task reconciliation, answered `{}`
 *   once it has run;
 * - `sessionHooks.postCompact`: Claude's compact summary, answered `{}` once
 *   it is recorded;
 * - `sessionHooks.persistOutput`: an elided native result, either harness,
 *   written as a session artifact.
 *
 * `epoch` is the engine's opaque query-epoch key; the server reads it only
 * inside the session's own binding. Bodies are JSON, which carries a lone
 * surrogate as its escape and is not size-limited by the protocol.
 *
 * Every request's session id must be one artifact-safe path segment
 * ({@link isArtifactSessionId}); the decoder refuses any other before the
 * server looks anything up.
 */
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

export const SESSION_HOOK_METHODS = {
  canUseTool: "sessionHooks.canUseTool",
  preToolUse: "sessionHooks.preToolUse",
  stop: "sessionHooks.stop",
  postCompact: "sessionHooks.postCompact",
  persistOutput: "sessionHooks.persistOutput",
} as const;

export type SessionHookMethod =
  (typeof SESSION_HOOK_METHODS)[keyof typeof SESSION_HOOK_METHODS];

/** A permission verdict; an allow keeps the engine's own input. */
export type SessionToolPermission =
  { behavior: "allow" } | { behavior: "deny"; message: string };

/** `PreToolUse`'s decision; `context` reaches the model beside the call. */
export type SessionToolAdmission =
  { allowed: true; context?: string } | { allowed: false; reason: string };

/** One background task the CLI reports at `Stop`. */
export interface SessionStopTask {
  id: string;
  type: string;
  status: string;
  description: string;
  command?: string;
}

/** A persisted artifact: its file and the URL the notice links. */
export interface SessionOutputArtifact {
  path: string;
  url: string;
}

export interface CanUseToolRequest {
  sessionId: string;
  toolName: string;
}

export interface PreToolUseRequest {
  sessionId: string;
  epoch: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface StopRequest {
  sessionId: string;
  epoch: string;
  tasks: SessionStopTask[];
}

export interface PostCompactRequest {
  sessionId: string;
  epoch: string;
  summary: string;
}

export interface PersistOutputRequest {
  sessionId: string;
  toolName: string;
  raw: string;
  /** The vendor's full-output file, read on the session's Worker. */
  sourcePath?: string;
}

/**
 * Whether `sessionId` names one artifact folder: non-empty, one path segment,
 * neither the folder itself nor its parent. The same rule as
 * `documentGrantTargets.ts`'s `assertArtifactSessionId`, which also accepts
 * the empty id; it stays here so Worker code imports no server module.
 */
export function isArtifactSessionId(sessionId: string): boolean {
  return (
    sessionId !== "" &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    sessionId !== "." &&
    sessionId !== ".."
  );
}

/** An answer that is not what its method answers. */
class MalformedSessionHookAnswerError extends Error {}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(method: string): never {
  throw new MalformedSessionHookAnswerError(
    `The server answered a malformed ${method} result.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The request's body with its session id checked, before anything else. */
function requestOf(payload: Payload): Record<string, unknown> & {
  sessionId: string;
} {
  const json = record(payload.json);
  if (
    !json ||
    typeof json.sessionId !== "string" ||
    !isArtifactSessionId(json.sessionId)
  )
    invalid("session id");
  return json as Record<string, unknown> & { sessionId: string };
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") invalid(what);
  return value;
}

function stopTaskOf(value: unknown): SessionStopTask {
  const task = record(value);
  if (
    !task ||
    typeof task.id !== "string" ||
    typeof task.type !== "string" ||
    typeof task.status !== "string" ||
    typeof task.description !== "string" ||
    (task.command !== undefined && typeof task.command !== "string")
  )
    invalid("stop task");
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    description: task.description,
    ...(task.command !== undefined ? { command: task.command } : {}),
  };
}

/** Any request's body; the receiving side decodes it per method. */
export function encodeSessionHookRequest(
  request:
    | CanUseToolRequest
    | PreToolUseRequest
    | StopRequest
    | PostCompactRequest
    | PersistOutputRequest,
): Payload {
  return { json: { ...request } };
}

export function decodeCanUseToolRequest(payload: Payload): CanUseToolRequest {
  const json = requestOf(payload);
  return {
    sessionId: json.sessionId,
    toolName: text(json.toolName, "tool name"),
  };
}

export function decodePreToolUseRequest(payload: Payload): PreToolUseRequest {
  const json = requestOf(payload);
  const toolInput = record(json.toolInput);
  if (!toolInput) invalid("tool input");
  return {
    sessionId: json.sessionId,
    epoch: text(json.epoch, "query epoch"),
    toolName: text(json.toolName, "tool name"),
    toolInput,
    toolUseId: text(json.toolUseId, "tool-use id"),
  };
}

export function decodeStopRequest(payload: Payload): StopRequest {
  const json = requestOf(payload);
  const epoch = text(json.epoch, "query epoch");
  if (!Array.isArray(json.tasks)) invalid("stop tasks");
  return {
    sessionId: json.sessionId,
    epoch,
    tasks: json.tasks.map(stopTaskOf),
  };
}

export function decodePostCompactRequest(payload: Payload): PostCompactRequest {
  const json = requestOf(payload);
  return {
    sessionId: json.sessionId,
    epoch: text(json.epoch, "query epoch"),
    summary: text(json.summary, "compact summary"),
  };
}

export function decodePersistOutputRequest(
  payload: Payload,
): PersistOutputRequest {
  const json = requestOf(payload);
  const toolName = text(json.toolName, "tool name");
  const raw = text(json.raw, "tool output");
  if (json.sourcePath !== undefined && typeof json.sourcePath !== "string")
    invalid("source path");
  return {
    sessionId: json.sessionId,
    toolName,
    raw,
    ...(json.sourcePath !== undefined ? { sourcePath: json.sourcePath } : {}),
  };
}

/** Any answer's body. */
export function encodeSessionHookAnswer(
  answer:
    | SessionToolPermission
    | SessionToolAdmission
    | SessionOutputArtifact
    | Record<string, never>,
): Payload {
  return { json: { ...answer } };
}

export function decodeCanUseToolAnswer(
  payload: Payload,
): SessionToolPermission {
  const json = record(payload.json);
  if (json?.behavior === "allow") return { behavior: "allow" };
  if (json?.behavior === "deny" && typeof json.message === "string")
    return { behavior: "deny", message: json.message };
  return malformed(SESSION_HOOK_METHODS.canUseTool);
}

export function decodePreToolUseAnswer(payload: Payload): SessionToolAdmission {
  const json = record(payload.json);
  if (json?.allowed === true) {
    if (json.context === undefined) return { allowed: true };
    if (typeof json.context === "string")
      return { allowed: true, context: json.context };
  }
  if (json?.allowed === false && typeof json.reason === "string")
    return { allowed: false, reason: json.reason };
  return malformed(SESSION_HOOK_METHODS.preToolUse);
}

/** `stop` and `postCompact` answer `{}` once the server has run them. */
export function decodeAcknowledgement(method: string, payload: Payload): void {
  if (!record(payload.json)) malformed(method);
}

export function decodePersistOutputAnswer(
  payload: Payload,
): SessionOutputArtifact {
  const json = record(payload.json);
  if (typeof json?.path !== "string" || typeof json.url !== "string")
    return malformed(SESSION_HOOK_METHODS.persistOutput);
  return { path: json.path, url: json.url };
}
