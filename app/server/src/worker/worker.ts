/**
 * A Worker: it dials the server, says `hello` with its Worker id, and serves
 * the server's requests until the connection ends; a refusal ends it too.
 *
 * This folder is the Worker's side of the boundary and imports no server
 * state (`workerBoundary.test.ts`). In phase 1 the only Worker runs in the
 * server's own process (`workers/inProcessWorker.ts`); phase 2 moves this
 * folder into a process of its own (`docs/workers.md`).
 */
import type { BackgroundWorkAdmitter } from "../workerProtocol/backgroundWorkMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { ENGINE_METHODS } from "../workerProtocol/engineMethods.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import {
  SKILL_METHODS,
  decodeSkillMaterialized,
  encodeSkillMaterialize,
} from "../workerProtocol/skillMethods.ts";
import { WATCH_METHODS } from "../workerProtocol/watchMethods.ts";
import { appToolCalls, type AppToolCaller } from "./appTools.ts";
import { backgroundWorkTable } from "./backgroundWork.ts";
import { checkoutGitHandlers } from "./checkoutGit.ts";
import { engineHandlers, type EngineFactories } from "./engines.ts";
import { fileHandlers } from "./files.ts";
import { lifecycleHandlers } from "./lifecycle.ts";
import { sessionHookCalls, type SessionHookCalls } from "./sessionHooks.ts";
import { watchHandlers, type WatchSnapshot } from "./watch.ts";

export interface RunningWorker {
  /**
   * Resolves once the connection has ended and every request the Worker was
   * serving has settled: with the exit receipt, once every git child it
   * started has exited, once every lifecycle handler has made its last
   * deletion or signal, once every file handle it held is closed, and once
   * every engine it hosted is disposed. Native opens still awaiting a
   * descriptor are orphaned on end; their eventual descriptors close without
   * registration and do not hold this promise.
   */
  readonly quiescent: Promise<void>;
  /**
   * Resolves once the connection has ended and the Worker holds no native
   * watch: no subscription, no subscribe and no unsubscribe in progress.
   * Separate from {@link quiescent}, which never waits for watch work.
   */
  readonly watchesReleased: Promise<void>;
  /** Asks the server to run one of a session's app tools (`appTools.call`). */
  readonly callAppTool: AppToolCaller;
  /** Asks the server for a session's hook decisions (`sessionHooks.*`). */
  readonly sessionHooks: SessionHookCalls;
  /** Admits an engine's background work, which this Worker executes. */
  readonly backgroundWork: BackgroundWorkAdmitter;
  /** Asks the server to materialize a frozen skill set (`skills.materialize`). */
  materializeSkills(names: readonly string[]): Promise<void>;
  /** Test seam: how many file handles the Worker holds. */
  fileHandles(): number;
  /** Test seam: the native watch subscriptions the Worker holds. */
  watches(): WatchSnapshot[];
  /** Test seam: how many engines the Worker holds or is opening. */
  engines(): number;
}

/**
 * Test seam: serves one request in place of its handler, which it receives so
 * it can run the real effect first. Its answer or failure goes back over the
 * real codec like the handler's would.
 */
export type SubstituteHandler = (
  payload: Payload,
  signal: AbortSignal,
  real: MethodHandler,
) => Promise<Payload>;

export function startWorker(options: {
  workerId: string;
  /** The Worker's end of a stream the server accepts. */
  transport: ByteEndpoint;
  /**
   * The environment each child the Worker starts inherits, read per child
   * (the isolation boundary's, `workers/isolationBoundary.ts`).
   */
  childEnv: () => NodeJS.ProcessEnv;
  /**
   * The engine factory for each harness this Worker hosts, injected by the
   * composition root; without one, `engine.open` refuses the harness.
   */
  engines?: EngineFactories;
  /**
   * Test seam: sees each request the Worker decoded and serves, and may
   * answer a substitute that serves that one request instead.
   */
  onRequest?: (method: string) => SubstituteHandler | undefined;
}): RunningWorker {
  const files = fileHandlers(options.workerId);
  // Deliveries start only after a subscribe, so after the connection exists.
  const watches = watchHandlers(options.workerId, (payload) =>
    connection.request(WATCH_METHODS.events, payload),
  );
  const appTools = appToolCalls((method, payload, signal) =>
    connection.request(method, payload, signal),
  );
  const sessionHooks = sessionHookCalls((method, payload, signal) =>
    connection.request(method, payload, signal),
  );
  const backgroundWork = backgroundWorkTable((method, payload, signal) =>
    connection.request(method, payload, signal),
  );
  const materializeSkills = async (names: readonly string[]) =>
    decodeSkillMaterialized(
      await connection.request(
        SKILL_METHODS.materialize,
        encodeSkillMaterialize({ names: [...names] }),
      ),
    );
  const engines = engineHandlers({
    factories: options.engines,
    childEnv: options.childEnv,
    callAppTool: appTools.call,
    persistOutput: sessionHooks.persistOutput,
    backgroundWork: backgroundWork.admitter,
    materializeSkills,
    deliver: (payload) => connection.request(ENGINE_METHODS.events, payload),
  });
  const handlers = Object.fromEntries(
    Object.entries({
      ...checkoutGitHandlers(options.workerId, options.childEnv),
      ...files.handlers,
      ...lifecycleHandlers(options.workerId),
      ...watches.handlers,
      ...appTools.handlers,
      ...backgroundWork.handlers,
      ...engines.handlers,
    }).map(([method, handler]) => [
      method,
      (payload: Payload, signal: AbortSignal) => {
        const substitute = options.onRequest?.(method);
        return substitute
          ? substitute(payload, signal, handler)
          : handler(payload, signal);
      },
    ]),
  );
  const connection = new WorkerConnection(options.transport, {
    handshake: { role: "worker", workerId: options.workerId },
    handlers,
    onEnd: () => {
      files.end();
      watches.end();
      backgroundWork.end();
      engines.end();
    },
  });
  return {
    quiescent: connection.ended
      .then(() => connection.handlersSettled())
      .then(() => files.sweep())
      .then(() => engines.released()),
    watchesReleased: watches.released,
    callAppTool: appTools.call,
    sessionHooks,
    backgroundWork: backgroundWork.admitter,
    materializeSkills,
    fileHandles: () => files.size,
    watches: () => watches.snapshot(),
    engines: () => engines.size,
  };
}
