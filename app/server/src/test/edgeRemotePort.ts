/**
 * A remote tool port backed by the edge's real tool host, in process
 * (Task-1463 P6b): `prepare` and `apply` run the host's two phases and come
 * back through the wire's JSON and the link's own decoders, so a client test
 * sees what the gateway would answer it. The host, its caller and the
 * link's decoders (`gateway/clientMethods.ts`) come from the test: only
 * `.test.ts` files import edge or gateway code (`workerBoundary.test.ts`).
 */
import {
  RemoteToolRefusal,
  type RemoteApplyAnswer,
  type RemoteApplyOutcome,
  type RemotePrepareAnswer,
  type RemoteToolPort,
} from "../remoteTools.ts";

/** The edge's `ToolHost`, structurally; only its two phases. */
interface EdgeTwoPhaseHost<Caller> {
  prepare(name: string, args: unknown, caller: Caller): Promise<object>;
  apply(
    name: string,
    request: { site: string; items: unknown[] },
    caller: Caller,
  ): Promise<object>;
}

/** The link's own decoders. */
interface LinkDecoders {
  decodePrepareAnswer(payload: { json?: unknown }): RemotePrepareAnswer;
  decodeApplyAnswer(payload: { json?: unknown }): RemoteApplyAnswer;
}

/** An answer as it leaves the edge and arrives at the link. */
const overTheWire = (answer: object) => ({
  json: JSON.parse(JSON.stringify(answer)) as unknown,
});

/**
 * The port; `caller()` is asked once per request, so a test can hand the
 * host a signal it aborts.
 */
export function edgeRemotePort<Caller>(
  host: EdgeTwoPhaseHost<Caller>,
  caller: () => Caller,
  link: LinkDecoders,
): RemoteToolPort {
  return {
    call: () => Promise.reject(new Error("edgeRemotePort has no tools.call")),
    callFile: () =>
      Promise.reject(new Error("edgeRemotePort has no file calls")),
    async prepare(name, args) {
      const payload = overTheWire(await host.prepare(name, args, caller()));
      try {
        return link.decodePrepareAnswer(payload);
      } catch {
        throw new RemoteToolRefusal("undecodable");
      }
    },
    async apply(name, site, items): Promise<RemoteApplyOutcome> {
      const payload = overTheWire(
        await host.apply(name, { site, items }, caller()),
      );
      try {
        return { outcome: "answer", answer: link.decodeApplyAnswer(payload) };
      } catch {
        return { outcome: "undecodable" };
      }
    },
  };
}
