/**
 * The server's side of app tools (`docs/workers.md`): it serves
 * `appTools.call` for the sessions placed on the Worker that asks. App tools
 * run as the server, so the server, not the Worker, decides what a call may
 * do: it takes the asking Worker's id from that connection's admission, never
 * from the payload, refuses a session placed elsewhere before any lookup, and
 * then applies the session's own tool authority.
 *
 * That authority is a binding each interactive harness registers by session
 * id while its engine is live: which tool a name resolves to now (refusing
 * with the harness's own unknown, inactive or Plan text), the session's
 * identity per call, and what to note once a call is admitted.
 *
 * Imports no connection acquisition, so `inProcessWorker.ts` can wire it.
 */
import type { AgentTool, ToolSession } from "../mcp/tool.ts";
import {
  APP_TOOL_METHODS,
  decodeAppToolCall,
  encodeAppToolProgress,
  encodeAppToolResult,
} from "../workerProtocol/appToolMethods.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
  type WorkerConnection,
} from "../workerProtocol/connection.ts";
import { sessionCheckoutSide } from "./placement.ts";

/** The error code of a call for a session not placed on the asking Worker. */
const NOT_PLACED = "not_placed";
/** The error code of a call for a session with no live tool binding. */
const NO_TOOL_SESSION = "no_tool_session";

/** One live session's tool authority, registered by its harness. */
export interface AppToolBinding {
  /** The tool `name` runs now; throws the harness's refusal text otherwise. */
  resolve(name: string): AgentTool;
  /** The session's identity, read fresh per call. */
  session(): ToolSession;
  /** Called once a call is admitted, immediately before the tool executes. */
  onExecute?(name: string): void;
}

/** Each session's registrations, the newest last. */
const bindings = new Map<string, Array<{ binding: AppToolBinding }>>();
let served = 0;

/**
 * Serve `sessionId`'s app tools through `binding`. The newest registration
 * for an id serves; the returned disposer removes only its own, so an engine
 * built for an id another engine holds and then discarded leaves the
 * holder's in place.
 */
export function registerAppToolSession(
  sessionId: string,
  binding: AppToolBinding,
): () => void {
  // Its own entry, so registering one binding twice still disposes once each.
  const entry = { binding };
  bindings.set(sessionId, [...(bindings.get(sessionId) ?? []), entry]);
  return () => {
    const rest = (bindings.get(sessionId) ?? []).filter((b) => b !== entry);
    if (rest.length > 0) bindings.set(sessionId, rest);
    else bindings.delete(sessionId);
  };
}

/** The Worker connection a handler serves, as that connection admitted it. */
export interface AdmittedPeer {
  connection: WorkerConnection;
  workerId: string;
}

/**
 * The server's `appTools.call` handler for one Worker connection. `peer`
 * answers the connection and its admitted Worker id; a call runs only once
 * the handshake has admitted one.
 */
export function appToolHandlers(
  peer: () => AdmittedPeer | undefined,
): MethodHandlers {
  return {
    [APP_TOOL_METHODS.call]: async (payload, signal) => {
      const call = decodeAppToolCall(payload);
      const asking = peer();
      const side = sessionCheckoutSide(call.sessionId);
      if (!asking || side === "server" || side.workerId !== asking.workerId)
        throw new WorkerMethodError(
          NOT_PLACED,
          `Session ${call.sessionId} is not placed on this Worker.`,
        );
      const binding = bindings.get(call.sessionId)?.at(-1)?.binding;
      if (!binding)
        throw new WorkerMethodError(
          NO_TOOL_SESSION,
          `Session ${call.sessionId} has no live tool session.`,
        );
      const tool = binding.resolve(call.tool);
      binding.onExecute?.(tool.name);
      served += 1;
      const result = await tool.execute(call.args, {
        toolCallId: call.toolCallId,
        session: binding.session(),
        signal,
        ...(call.progress
          ? {
              progress: (partial) => {
                void asking.connection
                  .request(
                    APP_TOOL_METHODS.progress,
                    encodeAppToolProgress({ callId: call.callId, partial }),
                  )
                  .catch(() => {});
              },
            }
          : {}),
      });
      return encodeAppToolResult(result);
    },
  };
}

/** Test seam: how many app-tool calls the server has admitted and run. */
export function appToolCallsServedForTests(): number {
  return served;
}
