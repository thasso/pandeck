/**
 * Runs elkjs off the server's event loop, in one worker thread
 * (`initiativeLayoutWorker.ts`). A layout of a few hundred nodes can take
 * seconds of CPU, and nothing that serves sockets or flushes events may wait
 * behind it.
 *
 * The worker starts on the first layout and ends after a minute without one,
 * so an idle server holds no thread. It never keeps the process alive. Jobs run
 * one at a time in arrival order, and every job is bounded:
 * - at most {@link MAX_QUEUED_LAYOUT_JOBS} wait; one more is refused at once;
 * - a job carries a deadline, which also ends its wait in the queue;
 * - a running job has at most 20 s, and past it the worker is ended (ELK
 *   cannot be interrupted any other way); the job fails alone and the next
 *   one starts a fresh worker;
 * - an aborted job leaves the queue; one already running finishes its pass.
 * A worker that cannot start or take a job fails that job with the reason,
 * and the queue moves on. Only an ELK error answers a plain `Error`: every
 * other failure is a {@link TransientLayoutError}, worth trying again later.
 */
import { Worker } from "node:worker_threads";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { INITIATIVE_LAYOUT_WORKER } from "./runtimeAssets.ts";

const PASS_LIMIT_MS = 20_000;
const IDLE_MS = 60_000;
/** Jobs that may wait behind the running one. */
export const MAX_QUEUED_LAYOUT_JOBS = 16;

/** A failure of the machinery, not of the graph: the same layout may work later. */
export class TransientLayoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientLayoutError";
  }
}

interface Job {
  id: number;
  graph: ElkNode;
  passLimitMs: number;
  /** Epoch ms after which the job fails, waiting or running. */
  deadline: number;
  resolve: (graph: ElkNode) => void;
  reject: (err: Error) => void;
  /** Ends the job's wait in the queue (deadline timer, abort listener). */
  release?: (() => void) | undefined;
}

interface Answer {
  id: number;
  graph?: ElkNode;
  error?: string;
}

let worker: Worker | undefined;
let current: Job | undefined;
let currentTimer: ReturnType<typeof setTimeout> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const queue: Job[] = [];
let nextId = 1;

export interface RunElkLayoutOptions {
  /** The running pass's limit; 20 s unless a test shortens it. */
  passLimitMs?: number;
  /** Epoch ms by which the job must finish, its wait included. */
  deadline?: number;
  /** Aborting takes a waiting job out of the queue. */
  signal?: AbortSignal;
}

/**
 * Lay out one ELK graph in the worker. Rejects with a plain `Error` for an
 * ELK error and with a {@link TransientLayoutError} for everything else: a
 * full queue, the deadline or pass limit, an abort, or a worker that could
 * not start, take the job or stay alive.
 */
export function runElkLayout(
  graph: ElkNode,
  options: RunElkLayoutOptions = {},
): Promise<ElkNode> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new TransientLayoutError("The layout was cancelled."));
      return;
    }
    if (queue.length >= MAX_QUEUED_LAYOUT_JOBS) {
      reject(
        new TransientLayoutError(
          "The layout queue is full; read the map again shortly.",
        ),
      );
      return;
    }
    const passLimitMs = options.passLimitMs ?? PASS_LIMIT_MS;
    const job: Job = {
      id: nextId++,
      graph,
      passLimitMs,
      deadline: options.deadline ?? Date.now() + passLimitMs,
      resolve,
      reject,
    };
    const leave = (err: TransientLayoutError) => {
      const at = queue.indexOf(job);
      if (at < 0) return;
      queue.splice(at, 1);
      job.release?.();
      job.reject(err);
    };
    const waited = setTimeout(
      () =>
        leave(
          new TransientLayoutError(
            "The layout waited too long for the worker; read the map again shortly.",
          ),
        ),
      Math.max(0, job.deadline - Date.now()),
    );
    waited.unref();
    const onAbort = () =>
      leave(new TransientLayoutError("The layout was cancelled."));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    job.release = () => {
      clearTimeout(waited);
      options.signal?.removeEventListener("abort", onAbort);
      job.release = undefined;
    };
    queue.push(job);
    pump();
  });
}

/** End the worker now; a queued job starts a new one. */
export function stopInitiativeLayoutWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const ending = worker;
  worker = undefined;
  end(ending);
  if (current) fail(new TransientLayoutError("The layout worker was stopped."));
}

/** What the runner holds right now, for tests: nothing may linger. */
export function initiativeLayoutRunnerState(): {
  running: boolean;
  queued: number;
  worker: boolean;
} {
  return {
    running: current !== undefined || currentTimer !== undefined,
    queued: queue.length,
    worker: worker !== undefined,
  };
}

/**
 * Start queued jobs until one is running or none is left. A loop, never a
 * recursion: a worker that keeps failing to start fails each job once, in
 * order, and nothing it throws leaves this function.
 */
function pump(): void {
  while (!current) {
    const job = queue.shift();
    if (!job) {
      idleTimer ??= setTimeout(stopInitiativeLayoutWorker, IDLE_MS);
      idleTimer.unref();
      return;
    }
    job.release?.();
    const limit = Math.min(job.passLimitMs, job.deadline - Date.now());
    if (limit <= 0) {
      job.reject(
        new TransientLayoutError(
          "The layout waited too long for the worker; read the map again shortly.",
        ),
      );
      continue;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    current = job;
    currentTimer = setTimeout(() => {
      const ending = worker;
      worker = undefined;
      end(ending);
      fail(
        new TransientLayoutError(
          `The layout took longer than ${Math.round(limit / 1000)} s.`,
        ),
      );
    }, limit);
    currentTimer.unref();
    try {
      ensureWorker().postMessage({ id: job.id, graph: job.graph });
    } catch (err) {
      const broken = worker;
      worker = undefined;
      end(broken);
      settle().reject(
        new TransientLayoutError(
          `The layout worker could not take the job: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      );
    }
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const started = new Worker(INITIATIVE_LAYOUT_WORKER);
  worker = started;
  started.unref();
  started.on("message", (answer: Answer) => {
    if (worker !== started || current?.id !== answer.id) return;
    const job = settle();
    if (answer.graph) job.resolve(answer.graph);
    else job.reject(new Error(answer.error ?? "The layout failed."));
    pump();
  });
  const lost = (err: Error) => {
    if (worker !== started) return;
    worker = undefined;
    if (current) fail(new TransientLayoutError(err.message, { cause: err }));
  };
  started.on("error", lost);
  started.on("exit", (code) =>
    lost(new Error(`The layout worker exited (code ${code}).`)),
  );
  return started;
}

function end(ending: Worker | undefined): void {
  if (!ending) return;
  try {
    ending.terminate().catch(() => undefined);
  } catch {
    // A worker that never started has nothing to end.
  }
}

function settle(): Job {
  const job = current!;
  current = undefined;
  if (currentTimer) clearTimeout(currentTimer);
  currentTimer = undefined;
  return job;
}

function fail(err: Error): void {
  settle().reject(err);
  pump();
}
