/**
 * The Worker's side of session hooks (`docs/workers.md`): an engine on this
 * Worker asks the server for what its permission and hook callbacks cannot
 * decide alone, one request per callback. It serves no requests.
 *
 * Each call forwards the callback's `AbortSignal`: aborting it withdraws a
 * request not yet sent and cancels a sent one. `stop` and `postCompact`
 * resolve only once the server has run them, so the engine continues after
 * the server's bookkeeping, never beside it.
 */
import type { Payload } from "../workerProtocol/codec.ts";
import type { EngineSessionHookCalls } from "../workerProtocol/engineMethods.ts";
import {
  SESSION_HOOK_METHODS,
  decodeAcknowledgement,
  decodeCanUseToolAnswer,
  decodePersistOutputAnswer,
  decodePreToolUseAnswer,
  encodeSessionHookRequest,
  type PersistOutputRequest,
  type SessionOutputArtifact,
} from "../workerProtocol/sessionHookMethods.ts";

export interface SessionHookCalls extends EngineSessionHookCalls {
  persistOutput(
    request: PersistOutputRequest,
    signal?: AbortSignal,
  ): Promise<SessionOutputArtifact>;
}

export function sessionHookCalls(
  send: (
    method: string,
    payload: Payload,
    signal?: AbortSignal,
  ) => Promise<Payload>,
): SessionHookCalls {
  return {
    canUseTool: async (request, signal) =>
      decodeCanUseToolAnswer(
        await send(
          SESSION_HOOK_METHODS.canUseTool,
          encodeSessionHookRequest(request),
          signal,
        ),
      ),
    preToolUse: async (request, signal) =>
      decodePreToolUseAnswer(
        await send(
          SESSION_HOOK_METHODS.preToolUse,
          encodeSessionHookRequest(request),
          signal,
        ),
      ),
    stop: async (request, signal) =>
      decodeAcknowledgement(
        SESSION_HOOK_METHODS.stop,
        await send(
          SESSION_HOOK_METHODS.stop,
          encodeSessionHookRequest(request),
          signal,
        ),
      ),
    postCompact: async (request, signal) =>
      decodeAcknowledgement(
        SESSION_HOOK_METHODS.postCompact,
        await send(
          SESSION_HOOK_METHODS.postCompact,
          encodeSessionHookRequest(request),
          signal,
        ),
      ),
    persistOutput: async (request, signal) =>
      decodePersistOutputAnswer(
        await send(
          SESSION_HOOK_METHODS.persistOutput,
          encodeSessionHookRequest(request),
          signal,
        ),
      ),
  };
}
