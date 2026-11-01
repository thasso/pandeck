/**
 * The Worker that runs inside the server's own process: the default Worker of
 * phase 1, and the one dev and tests keep using afterwards (`docs/workers.md`).
 * It dials the registry over an in-process transport and speaks the real
 * protocol, byte for byte.
 *
 * A connection end is not sticky: the next request dials a fresh Worker on a
 * new connection epoch. Requests the old Worker received are rejected only
 * once it reports quiescence — every git child it started has exited — so a
 * caller never releases a repo lock beside a running git. In-process, the
 * server observes that directly; an out-of-process Worker (phase 2) needs
 * fencing instead. The Worker's native watches are released apart from that
 * quiescence: a lost watch subscription is reported only once the old Worker
 * holds no native watch (`watchDeliveries.ts`).
 *
 * The only module that imports `worker/` (`workerBoundary.test.ts`).
 */
import type { AppToolExecutor } from "../mcp/tool.ts";
import {
  startWorker,
  type RunningWorker,
  type SubstituteHandler,
} from "../worker/worker.ts";
import type { WatchSnapshot } from "../worker/watch.ts";
import type { BackgroundWorkAdmitter } from "../workerProtocol/backgroundWorkMethods.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import type { HostedEngineFactory } from "../workerProtocol/engineMethods.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";
import type {
  PersistOutputRequest,
  PreToolUseRequest,
  SessionOutputArtifact,
  SessionStopTask,
  SessionToolAdmission,
  SessionToolPermission,
} from "../workerProtocol/sessionHookMethods.ts";
import { appToolHandlers, type AdmittedPeer } from "./appToolHost.ts";
import { backgroundWorkHandlers } from "./backgroundWorkHost.ts";
import { engineDeliveries } from "./engineClient.ts";
import { isolationBoundary } from "./isolationBoundary.ts";
import { DEFAULT_WORKER_ID } from "./placement.ts";
import { sessionHookHandlers } from "./sessionHookHost.ts";
import { skillHandlers } from "./skillHost.ts";
import { watchDeliveries } from "./watchDeliveries.ts";
import { workerRegistry } from "./workerRegistry.ts";

let current:
  | {
      connection: WorkerConnection;
      workerEnd: ByteEndpoint;
      worker: RunningWorker;
    }
  | undefined;
let served = 0;
const servedByMethod = new Map<string, number>();
const substitutes = new Map<string, SubstituteHandler>();
/** The engine factory per harness, registered by each harness's store. */
const engineFactories = new Map<string, HostedEngineFactory>();

/**
 * Host `harness`'s engines on in-process Workers from now on: the composition
 * root's injection, kept here so `workers/` imports no engine folder.
 */
export function registerInProcessEngineFactory(
  harness: string,
  factory: HostedEngineFactory,
): void {
  engineFactories.set(harness, factory);
}

/** The server's connection to the in-process Worker, dialing one if needed. */
export function ensureInProcessWorker(): WorkerConnection {
  if (current && !current.connection.isEnded) return current.connection;
  const [serverEnd, workerEnd] = isolationBoundary.workerEndpoint();
  // Accept first, as a listening socket would, then let the Worker dial.
  let quiescent: Promise<void> = Promise.resolve();
  const deliveries = watchDeliveries();
  // Calls are served only after the handshake, so `connection` is set by then.
  const peer = (): AdmittedPeer | undefined => {
    const workerId = workerRegistry.admittedAs(connection);
    return workerId === undefined ? undefined : { connection, workerId };
  };
  const connection: WorkerConnection = workerRegistry.accept(serverEnd, {
    quiescence: () => quiescent,
    handlers: {
      ...deliveries.handlers,
      ...appToolHandlers(peer),
      ...sessionHookHandlers(peer),
      ...backgroundWorkHandlers(peer),
      ...skillHandlers(peer),
      ...engineDeliveries(() => connection),
    },
  });
  const worker = startWorker({
    workerId: DEFAULT_WORKER_ID,
    transport: workerEnd,
    childEnv: () => isolationBoundary.workerChildEnv(),
    engines: (harness) => engineFactories.get(harness),
    onRequest: (method) => {
      served += 1;
      servedByMethod.set(method, (servedByMethod.get(method) ?? 0) + 1);
      const substitute = substitutes.get(method);
      substitutes.delete(method);
      return substitute;
    },
  });
  ({ quiescent } = worker);
  deliveries.attach(connection, worker.watchesReleased);
  current = { connection, workerEnd, worker };
  return connection;
}

/**
 * How an interactive engine runs `sessionId`'s app tools: from the session's
 * Worker, which asks the server (`appTools.call`). In phase 1 the in-process
 * Worker serves every session (`docs/workers.md`).
 */
export function appToolExecutorFor(sessionId: string): AppToolExecutor {
  return (tool, args, ctx) => {
    ensureInProcessWorker();
    return current!.worker.callAppTool(
      { sessionId, tool, toolCallId: ctx.toolCallId, args },
      {
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(ctx.progress !== undefined ? { onProgress: ctx.progress } : {}),
      },
    );
  };
}

/**
 * How an interactive engine asks the server for `sessionId`'s permission and
 * hook decisions and persists its elided output: from the session's Worker
 * (`sessionHooks.*`). In phase 1 the in-process Worker serves every session.
 */
export interface SessionHooks {
  canUseTool(
    toolName: string,
    signal?: AbortSignal,
  ): Promise<SessionToolPermission>;
  preToolUse(
    epoch: string,
    input: Omit<PreToolUseRequest, "sessionId" | "epoch">,
    signal?: AbortSignal,
  ): Promise<SessionToolAdmission>;
  stop(
    epoch: string,
    tasks: SessionStopTask[],
    signal?: AbortSignal,
  ): Promise<void>;
  postCompact(
    epoch: string,
    summary: string,
    signal?: AbortSignal,
  ): Promise<void>;
  persistOutput(
    input: Omit<PersistOutputRequest, "sessionId">,
    signal?: AbortSignal,
  ): Promise<SessionOutputArtifact>;
}

/** The current in-process Worker's session-hook calls, dialing one if needed. */
function sessionHookCallsNow() {
  ensureInProcessWorker();
  return current!.worker.sessionHooks;
}

export function sessionHooksFor(sessionId: string): SessionHooks {
  return {
    canUseTool: (toolName, signal) =>
      sessionHookCallsNow().canUseTool({ sessionId, toolName }, signal),
    preToolUse: (epoch, input, signal) =>
      sessionHookCallsNow().preToolUse({ sessionId, epoch, ...input }, signal),
    stop: (epoch, tasks, signal) =>
      sessionHookCallsNow().stop({ sessionId, epoch, tasks }, signal),
    postCompact: (epoch, summary, signal) =>
      sessionHookCallsNow().postCompact({ sessionId, epoch, summary }, signal),
    persistOutput: (input, signal) =>
      persistSessionOutput({ sessionId, ...input }, signal),
  };
}

/**
 * {@link SessionHooks}' `persistOutput` for an engine that learns its session
 * id per call (pi's extension).
 */
export function persistSessionOutput(
  request: PersistOutputRequest,
  signal?: AbortSignal,
): Promise<SessionOutputArtifact> {
  return sessionHookCallsNow().persistOutput(request, signal);
}

/**
 * How server-built pi options materialize a frozen skill set before a loader
 * reload (`buildAgentOptions`): the in-process Worker's `skills.materialize`,
 * as an engine on it asks.
 */
export function materializeSkillsThroughWorker(
  names: readonly string[],
): Promise<void> {
  ensureInProcessWorker();
  return current!.worker.materializeSkills(names);
}

/** Boot: dial the in-process Worker before the first checkout needs it. */
export function startInProcessWorker(): void {
  ensureInProcessWorker();
}

/**
 * Test seam: how a test's pi background tools admit their work, as an engine
 * on the current in-process Worker does (`backgroundWork.admit`).
 */
export function inProcessBackgroundWorkForTests(): BackgroundWorkAdmitter {
  return {
    admit: (request, runner, signal) => {
      ensureInProcessWorker();
      return current!.worker.backgroundWork.admit(request, runner, signal);
    },
  };
}

/** Test seam: how many requests in-process Workers have decoded and served. */
export function inProcessWorkerServedForTests(): number {
  return served;
}

/** Test seam: how many `method` requests in-process Workers have served. */
export function inProcessWorkerServedMethodForTests(method: string): number {
  return servedByMethod.get(method) ?? 0;
}

/** Test seam: the engines the current in-process Worker holds or is opening. */
export function inProcessWorkerEnginesForTests(): number {
  return current?.worker.engines() ?? 0;
}

/** Test seam: the file handles the current in-process Worker holds. */
export function inProcessWorkerFileHandlesForTests(): number {
  return current?.worker.fileHandles() ?? 0;
}

/**
 * Test seam: the native watch subscriptions the current in-process Worker
 * holds, and its watch release. Read `released` before ending the
 * connection: the next request dials a new Worker.
 */
export function inProcessWorkerWatchesForTests(): {
  subscriptions: WatchSnapshot[];
  released: Promise<void>;
} {
  return {
    subscriptions: current?.worker.watches() ?? [],
    released: current?.worker.watchesReleased ?? Promise.resolve(),
  };
}

/**
 * Test seam: the current in-process Worker's quiescence, which resolves once
 * its connection has ended, every request has settled and the sweep has
 * closed every descriptor its handles held. Read it before ending the
 * connection: the next request dials a new Worker.
 */
export function inProcessWorkerQuiescentForTests(): Promise<void> {
  return current?.worker.quiescent ?? Promise.resolve();
}

/** Test seam: the connection epoch of the open in-process connection. */
export function inProcessWorkerEpochForTests(): number | undefined {
  return workerRegistry.epoch(DEFAULT_WORKER_ID);
}

/**
 * Test seam: the next `method` request an in-process Worker serves is served
 * by `substitute`, which receives the real handler. One-shot per method;
 * answers the disarm.
 */
export function answerNextInProcessWorkerCallForTests(
  method: string,
  substitute: SubstituteHandler,
): () => void {
  substitutes.set(method, substitute);
  return () => {
    if (substitutes.get(method) === substitute) substitutes.delete(method);
  };
}

/** Test seam: bytes the server receives as if the Worker had sent them. */
export function writeAsInProcessWorkerForTests(bytes: Uint8Array): void {
  current?.workerEnd.write(bytes);
}
