/**
 * The Worker's side of app tools (`docs/workers.md`): an engine on this Worker
 * calls one of its session's app tools with `appTools.call`, and the server
 * runs it. Progress partials arrive as `appTools.progress` requests, which
 * reach the waiting call's `onProgress` synchronously, so every partial is
 * delivered before the call's answer settles it. A partial for a call that has
 * settled, or that this Worker never made, is acknowledged and dropped.
 *
 * Aborting the caller's signal withdraws a call not yet sent and cancels a
 * sent one; the tool's own outcome still settles it.
 */
import {
  APP_TOOL_METHODS,
  decodeAppToolProgress,
  decodeAppToolResult,
  encodeAppToolCall,
  encodeAppToolProgressDone,
  type AppToolCall,
  type AppToolResult,
} from "../workerProtocol/appToolMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { MethodHandlers } from "../workerProtocol/connection.ts";

/** One app-tool call an engine makes, without the Worker's call id. */
type AppToolRequest = Omit<AppToolCall, "callId" | "progress">;

interface AppToolCallOptions {
  signal?: AbortSignal;
  /** Receives the tool's partials in order; asks the server for progress. */
  onProgress?: (partial: AppToolResult) => void;
}

export type AppToolCaller = (
  request: AppToolRequest,
  options: AppToolCallOptions,
) => Promise<AppToolResult>;

export function appToolCalls(
  send: (
    method: string,
    payload: Payload,
    signal?: AbortSignal,
  ) => Promise<Payload>,
): { handlers: MethodHandlers; call: AppToolCaller } {
  let nextId = 1;
  const waiting = new Map<number, (partial: AppToolResult) => void>();
  const handlers: MethodHandlers = {
    // Not async: the partial reaches the engine before a later answer frame.
    [APP_TOOL_METHODS.progress]: (payload) => {
      try {
        const { callId, partial } = decodeAppToolProgress(payload);
        waiting.get(callId)?.(partial);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve(encodeAppToolProgressDone());
    },
  };
  const call: AppToolCaller = async (request, options) => {
    const callId = nextId++;
    const { onProgress } = options;
    if (onProgress) waiting.set(callId, onProgress);
    try {
      const answer = await send(
        APP_TOOL_METHODS.call,
        encodeAppToolCall({ ...request, callId, progress: !!onProgress }),
        options.signal,
      );
      return decodeAppToolResult(answer);
    } finally {
      waiting.delete(callId);
    }
  };
  return { handlers, call };
}
