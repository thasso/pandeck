/**
 * The server's side of session hooks (`docs/workers.md`): it serves
 * `sessionHooks.*` for the sessions placed on the Worker that asks. Each
 * request is decoded first, its session id included; then the asking Worker's
 * id, taken from that connection's admission and never from the payload, must
 * hold the session; only then does the server look anything up.
 *
 * Claude's permission and hook decisions apply a binding its session
 * registers by id while it is live: the session's tool allowlist and live
 * mode, its background admission, and its per-query `Stop` and `PostCompact`
 * bookkeeping. `persistOutput` serves both harnesses and needs no binding: it
 * writes only under the named session's artifact folder, and reads a vendor
 * full-output file on that session's Worker.
 *
 * Imports no connection acquisition, so `inProcessWorker.ts` can wire it.
 */
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { persistOutputArtifact } from "../outputPolicy.ts";
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  SESSION_HOOK_METHODS,
  decodeCanUseToolRequest,
  decodePersistOutputRequest,
  decodePostCompactRequest,
  decodePreToolUseRequest,
  decodeStopRequest,
  encodeSessionHookAnswer,
  type PreToolUseRequest,
  type SessionHookMethod,
  type SessionStopTask,
  type SessionToolAdmission,
  type SessionToolPermission,
} from "../workerProtocol/sessionHookMethods.ts";
import type { AdmittedPeer } from "./appToolHost.ts";
import { sessionCheckoutSide, type CheckoutSide } from "./placement.ts";

/** The error code of a request for a session not placed on the asking Worker. */
const NOT_PLACED = "not_placed";
/** The error code of a Claude hook request for a session with no binding. */
const NO_SESSION_HOOKS = "no_session_hooks";

/** One live Claude session's hook authority, registered by its harness. */
export interface SessionHookBinding {
  /** The permission verdict for `toolName` now. */
  canUseTool(toolName: string): SessionToolPermission;
  /** Plan's refusal first, then background admission, in query `epoch`. */
  preToolUse(
    epoch: string,
    input: Omit<PreToolUseRequest, "sessionId" | "epoch">,
  ): Promise<SessionToolAdmission>;
  /** Reconciles query `epoch`'s background tasks at `Stop`. */
  stop(epoch: string, tasks: SessionStopTask[]): void | Promise<void>;
  /** Records query `epoch`'s compact summary. */
  postCompact(epoch: string, summary: string): void | Promise<void>;
}

/** Each session's registrations, the newest last. */
const bindings = new Map<string, Array<{ binding: SessionHookBinding }>>();
const served = new Map<SessionHookMethod, number>();

/**
 * Serve `sessionId`'s hook decisions through `binding`. The newest
 * registration for an id serves; the returned disposer removes only its own.
 */
export function registerSessionHooks(
  sessionId: string,
  binding: SessionHookBinding,
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

/**
 * Copies a vendor full-output file from the session's Worker to `destination`
 * as a stream, one read piece in memory at a time. Never read on the server:
 * the path may come from the agent's own output.
 */
async function copyFromWorker(
  side: CheckoutSide,
  source: string,
  destination: string,
): Promise<void> {
  // Lazy: `servedFileAccess.ts` reaches the in-process Worker, which imports
  // this module, so a static import would close a cycle.
  const { openServedFile } = await import("../servedFileAccess.ts");
  const handle = await openServedFile(source, { stat: false, side });
  try {
    await pipeline(
      handle.createReadStream({ start: 0, end: Number.MAX_SAFE_INTEGER }),
      createWriteStream(destination),
    );
  } finally {
    await handle.close();
  }
}

/**
 * The server's `sessionHooks.*` handlers for one Worker connection. `peer`
 * answers the connection and its admitted Worker id; a request runs only once
 * the handshake has admitted one.
 */
export function sessionHookHandlers(
  peer: () => AdmittedPeer | undefined,
): MethodHandlers {
  /** The session's side once the asking Worker holds it; counts the request. */
  const admit = (method: SessionHookMethod, sessionId: string) => {
    const asking = peer();
    const side = sessionCheckoutSide(sessionId);
    if (!asking || side === "server" || side.workerId !== asking.workerId)
      throw new WorkerMethodError(
        NOT_PLACED,
        `Session ${sessionId} is not placed on this Worker.`,
      );
    served.set(method, (served.get(method) ?? 0) + 1);
    return side;
  };
  const bound = (sessionId: string): SessionHookBinding => {
    const binding = bindings.get(sessionId)?.at(-1)?.binding;
    if (!binding)
      throw new WorkerMethodError(
        NO_SESSION_HOOKS,
        `Session ${sessionId} has no live session hooks.`,
      );
    return binding;
  };
  return {
    [SESSION_HOOK_METHODS.canUseTool]: async (payload) => {
      const request = decodeCanUseToolRequest(payload);
      admit(SESSION_HOOK_METHODS.canUseTool, request.sessionId);
      return encodeSessionHookAnswer(
        bound(request.sessionId).canUseTool(request.toolName),
      );
    },
    [SESSION_HOOK_METHODS.preToolUse]: async (payload) => {
      const { sessionId, epoch, ...input } = decodePreToolUseRequest(payload);
      admit(SESSION_HOOK_METHODS.preToolUse, sessionId);
      return encodeSessionHookAnswer(
        await bound(sessionId).preToolUse(epoch, input),
      );
    },
    [SESSION_HOOK_METHODS.stop]: async (payload) => {
      const request = decodeStopRequest(payload);
      admit(SESSION_HOOK_METHODS.stop, request.sessionId);
      await bound(request.sessionId).stop(request.epoch, request.tasks);
      return encodeSessionHookAnswer({});
    },
    [SESSION_HOOK_METHODS.postCompact]: async (payload) => {
      const request = decodePostCompactRequest(payload);
      admit(SESSION_HOOK_METHODS.postCompact, request.sessionId);
      await bound(request.sessionId).postCompact(
        request.epoch,
        request.summary,
      );
      return encodeSessionHookAnswer({});
    },
    [SESSION_HOOK_METHODS.persistOutput]: async (payload) => {
      const request = decodePersistOutputRequest(payload);
      const side = admit(SESSION_HOOK_METHODS.persistOutput, request.sessionId);
      return encodeSessionHookAnswer(
        await persistOutputArtifact(request, (source, destination) =>
          copyFromWorker(side, source, destination),
        ),
      );
    },
  };
}

/** Test seam: how many `method` requests the server has admitted and served. */
export function sessionHookCallsServedForTests(
  method: SessionHookMethod,
): number {
  return served.get(method) ?? 0;
}
