/**
 * Runs elkjs off the server's event loop, in one worker thread
 * (`initiativeLayoutWorker.ts`). A layout of a few hundred nodes can take
 * seconds of CPU, and nothing that serves sockets or flushes events may wait
 * behind it.
 *
 * The worker starts on the first layout and ends after a minute without one,
 * so an idle server holds no thread. It never keeps the process alive. Jobs run
 * one at a time in arrival order: a job past its time limit ends the worker
 * (ELK cannot be interrupted any other way) and fails alone, and the next job
 * starts a fresh one.
 */
import { Worker } from "node:worker_threads";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { INITIATIVE_LAYOUT_WORKER } from "./runtimeAssets.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
const IDLE_MS = 60_000;

interface Job {
  id: number;
  graph: ElkNode;
  timeoutMs: number;
  resolve: (graph: ElkNode) => void;
  reject: (err: Error) => void;
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

/** Lay out one ELK graph in the worker; rejects on an ELK error or the time limit. */
export function runElkLayout(
  graph: ElkNode,
  options: { timeoutMs?: number } = {},
): Promise<ElkNode> {
  return new Promise((resolve, reject) => {
    queue.push({
      id: nextId++,
      graph,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      resolve,
      reject,
    });
    pump();
  });
}

/** End the worker now; a queued job starts a new one. */
export function stopInitiativeLayoutWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  const ending = worker;
  worker = undefined;
  if (current) fail(new Error("The layout worker was stopped."));
  void ending?.terminate();
}

function pump(): void {
  if (current) return;
  const job = queue.shift();
  if (!job) {
    idleTimer ??= setTimeout(stopInitiativeLayoutWorker, IDLE_MS);
    idleTimer.unref();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  current = job;
  currentTimer = setTimeout(() => {
    const ending = worker;
    worker = undefined;
    fail(
      new Error(
        `The layout took longer than ${Math.round(job.timeoutMs / 1000)} s.`,
      ),
    );
    void ending?.terminate();
  }, job.timeoutMs);
  currentTimer.unref();
  ensureWorker().postMessage({ id: job.id, graph: job.graph });
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const started = new Worker(INITIATIVE_LAYOUT_WORKER);
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
    if (current) fail(err);
  };
  started.on("error", lost);
  started.on("exit", (code) =>
    lost(new Error(`The layout worker exited (code ${code}).`)),
  );
  worker = started;
  return started;
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
