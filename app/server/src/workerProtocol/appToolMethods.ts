/**
 * The app-tool methods of worker protocol 1.6 and their wire shapes, shared by
 * the Worker's side (`worker/appTools.ts`) and the server's
 * (`workers/appToolHost.ts`). App tools run as the server; an interactive
 * session's engine asks for one through its Worker (`docs/workers.md`).
 *
 * `appTools.call` goes Worker → server and names the session, the tool, the
 * engine's tool-call id and the arguments; it answers the tool's result. The
 * Worker mints each call id, a positive integer never reused on its
 * connection. When the engine asked for progress, the server sends each
 * partial as a server → Worker `appTools.progress` request naming that call
 * id, answered `{}`, before the call's answer. Cancelling the call is the
 * protocol's `cancel`. A tool's failure is the call's failure response, its
 * message as text.
 *
 * Arguments, results and partials travel as the JSON body, which carries a
 * lone surrogate as its escape and is not size-limited by the protocol. A
 * result's non-JSON `details` reach the engine in their JSON form.
 */
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

export const APP_TOOL_METHODS = {
  /** Worker → server: run one app tool for a session placed on the Worker. */
  call: "appTools.call",
  /** Server → Worker: one progress partial of a running call. */
  progress: "appTools.progress",
} as const;

/** A tool's final or partial result on the wire (`mcp/tool.ts`'s `ToolResult`). */
export interface AppToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  details?: unknown;
  terminate?: boolean;
}

/** What `appTools.call` asks for. */
export interface AppToolCall {
  callId: number;
  sessionId: string;
  tool: string;
  toolCallId: string;
  args: Record<string, unknown>;
  /** Whether the engine takes progress partials for this call. */
  progress: boolean;
}

/** One `appTools.progress` request. */
export interface AppToolProgress {
  callId: number;
  partial: AppToolResult;
}

/** An answer that is not what `appTools.call` answers. */
class MalformedAppToolAnswerError extends Error {}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * A result's shape, or undefined. A block is checked only for its `type`: a
 * proxied MCP tool's blocks pass through to the engine as they came.
 */
function resultOf(value: unknown): AppToolResult | undefined {
  const json = record(value);
  if (!json || !Array.isArray(json.content)) return undefined;
  if (json.content.some((block) => typeof record(block)?.type !== "string"))
    return undefined;
  if (json.terminate !== undefined && typeof json.terminate !== "boolean")
    return undefined;
  return json as unknown as AppToolResult;
}

export function encodeAppToolCall(call: AppToolCall): Payload {
  return { json: { ...call } };
}

export function decodeAppToolCall(payload: Payload): AppToolCall {
  const json = record(payload.json);
  if (!json || !isId(json.callId)) invalid("app-tool call id");
  if (typeof json.sessionId !== "string" || json.sessionId === "")
    invalid("session id");
  if (typeof json.tool !== "string") invalid("tool name");
  if (typeof json.toolCallId !== "string") invalid("tool-call id");
  const args = record(json.args);
  if (!args) invalid("tool arguments");
  if (typeof json.progress !== "boolean") invalid("progress flag");
  return {
    callId: json.callId,
    sessionId: json.sessionId,
    tool: json.tool,
    toolCallId: json.toolCallId,
    args,
    progress: json.progress,
  };
}

export function encodeAppToolResult(result: AppToolResult): Payload {
  return { json: result };
}

/** The call's answer; anything but a result is malformed, not trusted. */
export function decodeAppToolResult(payload: Payload): AppToolResult {
  const result = resultOf(payload.json);
  if (!result)
    throw new MalformedAppToolAnswerError(
      "The server answered a malformed app-tool result.",
    );
  return result;
}

export function encodeAppToolProgress(progress: AppToolProgress): Payload {
  return { json: { callId: progress.callId, partial: progress.partial } };
}

export function decodeAppToolProgress(payload: Payload): AppToolProgress {
  const json = record(payload.json);
  if (!json || !isId(json.callId)) invalid("app-tool call id");
  const partial = resultOf(json.partial);
  if (!partial) invalid("progress partial");
  return { callId: json.callId, partial };
}

/** What `appTools.progress` answers. */
export function encodeAppToolProgressDone(): Payload {
  return { json: {} };
}
