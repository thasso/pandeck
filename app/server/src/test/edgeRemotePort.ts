/**
 * A remote tool port backed by the edge's real tool host, in process
 * (Task-1463 P6b): `prepare` and `apply` run the host's two phases and come
 * back through the wire's JSON and the link's own decoders, so a client test
 * sees what the gateway would answer it. The host, its caller and the
 * link's decoders (`gateway/clientMethods.ts`) come from the test: only
 * `.test.ts` files import edge or gateway code (`workerBoundary.test.ts`).
 *
 * With an upload scope (Task-1441 P8a) the port's `uploads` run the edge's
 * own store in process: `open` and `put` go through the scope and the link's
 * decoders, `prepare` declares the frozen sources, and an apply naming an
 * upload consumes it, its output hold settling once the answer is decoded.
 * The real link and listener carry the same bytes in
 * `gatewayClientUploadChain.test.ts`.
 */
import {
  RemoteToolRefusal,
  type RemoteApplyAnswer,
  type RemoteApplyOutcome,
  type RemotePrepareAnswer,
  type RemoteToolPort,
  type RemoteUploadPort,
  type RemoteUploadSource,
  type RemoteUploadStream,
} from "../remoteTools.ts";

/** The edge's `ToolHost`, structurally; only its two phases. */
interface EdgeTwoPhaseHost<Caller, Scope> {
  prepare(
    name: string,
    args: unknown,
    caller: Caller,
    options?: { uploads?: readonly RemoteUploadSource[] },
  ): Promise<object>;
  apply(
    name: string,
    request: { site: string; items: unknown[] },
    caller: Caller & { onSettled?: (fn: () => void) => void },
    options?: { upload?: { id: string; scope: Scope } },
  ): Promise<object>;
}

/** The edge's `UploadScope`, structurally; what the port's uploads ask. */
interface EdgeUploadScope {
  open(request: { streams: RemoteUploadStream[]; work: number }): object;
  put(
    request: { uploadId: string; stagedAttachmentId: string; offset: number },
    chunk: Uint8Array,
  ): object;
  release(uploadId: string): object;
}

/** The link's own decoders. */
interface LinkDecoders {
  decodePrepareAnswer(payload: { json?: unknown }): RemotePrepareAnswer;
  decodeApplyAnswer(payload: { json?: unknown }): RemoteApplyAnswer;
  decodeUploadOpenAnswer(payload: {
    json?: unknown;
  }): { ok: true; uploadId: string } | { ok: false; message: string };
  decodeUploadPutAnswer(payload: {
    json?: unknown;
  }):
    | { ok: true; received: number; streamComplete: boolean; sealed: boolean }
    | { ok: false; message: string };
}

const NO_UPLOADS = () =>
  Promise.reject(new Error("edgeRemotePort has no uploads"));

/** An answer as it leaves the edge and arrives at the link. */
const overTheWire = (answer: object) => ({
  json: JSON.parse(JSON.stringify(answer)) as unknown,
});

/**
 * The port; `caller()` is asked once per request, so a test can hand the
 * host a signal it aborts. `uploads` is the edge scope the port's uploads
 * run on; without it the port is an edge before 1.3: its uploads reject and
 * `prepare` drops the declared sources.
 */
export function edgeRemotePort<
  Caller extends object,
  Scope extends EdgeUploadScope,
>(
  host: EdgeTwoPhaseHost<Caller, Scope>,
  caller: () => Caller,
  link: LinkDecoders,
  uploads?: Scope,
): RemoteToolPort {
  return {
    call: () => Promise.reject(new Error("edgeRemotePort has no tools.call")),
    callFile: () =>
      Promise.reject(new Error("edgeRemotePort has no file calls")),
    uploads: uploads
      ? scopeUploads(uploads, link)
      : {
          open: NO_UPLOADS,
          put: NO_UPLOADS,
          release: () => {},
        },
    async prepare(name, args, _signal, declared) {
      const payload = overTheWire(
        await host.prepare(
          name,
          args,
          caller(),
          // Without a scope the port is an edge before 1.3: the declared
          // sources never reach it.
          ...(declared && uploads
            ? [{ uploads: overTheWire(declared).json as RemoteUploadSource[] }]
            : []),
        ),
      );
      try {
        return link.decodePrepareAnswer(payload);
      } catch {
        throw new RemoteToolRefusal("undecodable");
      }
    },
    async apply(name, site, items, upload): Promise<RemoteApplyOutcome> {
      if (upload && !uploads) throw new Error("edgeRemotePort has no uploads");
      // The listener's output hold: settled once the answer is read.
      const held: (() => void)[] = [];
      const payload = overTheWire(
        await host.apply(
          name,
          { site, items },
          upload
            ? { ...caller(), onSettled: (fn: () => void) => held.push(fn) }
            : caller(),
          ...(upload && uploads
            ? [{ upload: { id: upload.uploadId, scope: uploads } }]
            : []),
        ),
      );
      for (const settled of held) settled();
      try {
        return { outcome: "answer", answer: link.decodeApplyAnswer(payload) };
      } catch {
        return { outcome: "undecodable" };
      }
    },
  };
}

/** The port's uploads on an edge scope, through the wire and the decoders. */
function scopeUploads(
  scope: EdgeUploadScope,
  link: LinkDecoders,
): RemoteUploadPort {
  const refusal = (answer: { ok: false; message: string }) => ({
    ok: false as const,
    message: answer.message,
  });
  return {
    open(streams, work) {
      const answer = link.decodeUploadOpenAnswer(
        overTheWire(
          scope.open({
            streams: streams.map(({ stagedAttachmentId, size, sha256 }) => ({
              stagedAttachmentId,
              size,
              sha256,
            })),
            work,
          }),
        ),
      );
      return Promise.resolve(answer.ok ? answer : refusal(answer));
    },
    put(uploadId, stagedAttachmentId, offset, chunk) {
      const answer = link.decodeUploadPutAnswer(
        overTheWire(scope.put({ uploadId, stagedAttachmentId, offset }, chunk)),
      );
      return Promise.resolve(answer.ok ? answer : refusal(answer));
    },
    release(uploadId) {
      scope.release(uploadId);
    },
  };
}
