/**
 * The worker thread that runs elkjs for Initiative maps
 * (`initiativeLayoutRunner.ts`). It lays out one ELK graph per message, in
 * arrival order, and answers with the laid-out graph or the error. It holds no
 * state beyond the ELK instance, so the runner may end it at any time.
 *
 * Node runs this file as it is (type stripping); the Bun package runs its
 * bundled copy (`docs/deployment.md#bun-package`). Keep it erasable TypeScript.
 */
import { parentPort } from "node:worker_threads";
import type { ElkNode } from "elkjs/lib/elk-api.js";

interface LayoutRequest {
  id: number;
  graph: ElkNode;
}

// elkjs's GWT worker script registers itself as a web worker wherever `self`
// exists, and only exports the in-process engine its bundle constructs when it
// does not. Bun defines `self`, so `new ELK()` threw there. This thread's
// global is its own, so removing it here changes nothing for the server.
Reflect.deleteProperty(globalThis, "self");
// A CommonJS module whose export is the constructor, which is also its own
// `default`: this names it under Node's interop and the bundle's alike.
const ELK = (await import("elkjs/lib/elk.bundled.js")).default.default;
const elk = new ELK();

const port = parentPort;
if (!port) throw new Error("initiativeLayoutWorker runs only as a worker.");

port.on("message", (request: LayoutRequest) => {
  elk.layout(request.graph).then(
    (graph: ElkNode) => port.postMessage({ id: request.id, graph }),
    (err: unknown) =>
      port.postMessage({
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});
