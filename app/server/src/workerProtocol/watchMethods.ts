/**
 * The watch methods of worker protocol 1.4 and their wire shapes, shared by
 * the server's side (`workers/watchClient.ts`, `workers/watchDeliveries.ts`)
 * and the Worker's (`worker/watch.ts`). The worktree watcher's native
 * subscriptions run on the Worker that owns the checkout (`docs/workers.md`).
 *
 * `watch.subscribe` and `watch.unsubscribe` go server → Worker and name their
 * Worker, which refuses another Worker's id before any native call. The
 * server allocates each subscription id, a positive integer never reused on
 * its connection, and an id belongs to the connection that carries it. The
 * Worker → server request `watch.events` delivers a subscription's queued
 * callbacks, one delivery in flight per subscription; its `{}` answer is the
 * acknowledgement.
 *
 * Paths and ignore entries travel as NUL-joined UTF-16 text streams, exact to
 * the code unit; NUL cannot occur in a POSIX path. A native failure is an
 * answer, `{error:{}}` with parcel's message as text, rebuilt by the client as
 * an {@link AnsweredWatchFailure}; parcel's rejections carry no `code`. An
 * answer that is not what its method answers is a
 * {@link MalformedWorkerAnswerError}.
 */
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import { MalformedWorkerAnswerError } from "./fileMethods.ts";

export const WATCH_METHODS = {
  /** Subscribe a directory natively; deliveries may precede the answer. */
  subscribe: "watch.subscribe",
  /** Release a subscription; an id the Worker does not hold is released. */
  unsubscribe: "watch.unsubscribe",
  /** Worker → server: a subscription's queued batches, or its overflow. */
  events: "watch.events",
} as const;

const SEPARATOR = "\0";

/** What `watch.subscribe` asks for. */
export interface WatchSubscribeRequest {
  workerId: string;
  id: number;
  path: string;
  ignore: readonly string[];
}

/** A subscription a `watch.unsubscribe` names. */
export interface WatchRef {
  workerId: string;
  id: number;
}

/** One native callback: its event paths in order, or its error message. */
export type WatchBatch =
  { paths: readonly string[]; error?: undefined } | { error: string };

/** One `watch.events` request. */
export interface WatchDelivery {
  id: number;
  /** Empty when `overflow` is set: the marker replaced the whole queue. */
  batches: readonly WatchBatch[];
  overflow: boolean;
}

/** A native watch failure the Worker answered: the call ran there and failed. */
export class AnsweredWatchFailure extends Error {}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new MalformedWorkerAnswerError(
    `The Worker answered a malformed ${what}.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** `count` strings from one NUL-joined stream; undefined if they do not fit. */
function split(joined: string, count: number): string[] | undefined {
  if (count === 0) return joined === "" ? [] : undefined;
  const parts = joined.split(SEPARATOR);
  return parts.length === count ? parts : undefined;
}

function decodeRef(payload: Payload): WatchRef {
  const json = record(payload.json);
  if (typeof json?.workerId !== "string") invalid("Worker id");
  const id = json.id;
  if (!isId(id)) invalid("watch id");
  return { workerId: json.workerId, id };
}

export function encodeSubscribe(request: WatchSubscribeRequest): Payload {
  return {
    json: { workerId: request.workerId, id: request.id },
    text: { path: request.path, ignore: request.ignore.join(SEPARATOR) },
  };
}

export function decodeSubscribe(payload: Payload): WatchSubscribeRequest {
  const ref = decodeRef(payload);
  const path = payload.text?.path;
  const ignore = payload.text?.ignore;
  if (path === undefined) invalid("watch path");
  if (ignore === undefined) invalid("watch ignore list");
  return { ...ref, path, ignore: ignore === "" ? [] : ignore.split(SEPARATOR) };
}

export function encodeUnsubscribe(ref: WatchRef): Payload {
  return { json: { workerId: ref.workerId, id: ref.id } };
}

export function decodeUnsubscribe(payload: Payload): WatchRef {
  return decodeRef(payload);
}

/** What both control methods answer when the native call succeeded. */
export function encodeWatchDone(): Payload {
  return { json: {} };
}

/** A native watch failure as an answer: its message as text. */
export function encodeWatchFailure(error: unknown): Payload {
  return {
    json: { error: {} },
    text: { message: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Settles a control method's answer: `{}` returns, an answered native failure
 * throws as an {@link AnsweredWatchFailure}, anything else is malformed.
 */
export function decodeWatchOutcome(payload: Payload): void {
  const json = record(payload.json);
  if (!json) malformed("watch answer");
  const keys = Object.keys(json);
  if (keys.length === 0) return;
  const message = payload.text?.message;
  if (
    keys.length !== 1 ||
    record(json.error) === undefined ||
    message === undefined
  )
    malformed("watch answer");
  throw new AnsweredWatchFailure(message);
}

export function encodeEvents(delivery: WatchDelivery): Payload {
  const paths: string[] = [];
  const batches = delivery.batches.map((batch) => {
    if (batch.error !== undefined) {
      paths.push(batch.error);
      return { count: 1, error: true };
    }
    paths.push(...batch.paths);
    return { count: batch.paths.length };
  });
  return {
    json: {
      id: delivery.id,
      batches,
      ...(delivery.overflow ? { overflow: true } : {}),
    },
    text: { paths: paths.join(SEPARATOR) },
  };
}

export function decodeEvents(payload: Payload): WatchDelivery {
  const json = record(payload.json);
  if (!json || !isId(json.id)) invalid("watch id");
  if (!Array.isArray(json.batches)) invalid("watch batches");
  const overflow = json.overflow;
  if (overflow !== undefined && overflow !== true) invalid("watch overflow");
  if (overflow && json.batches.length > 0) invalid("watch overflow");
  const shapes = json.batches.map((value: unknown) => {
    const batch = record(value);
    if (!isCount(batch?.count)) invalid("watch batch");
    if (
      batch.error !== undefined &&
      (batch.error !== true || batch.count !== 1)
    )
      invalid("watch error batch");
    return { count: batch.count, error: batch.error === true };
  });
  const joined = payload.text?.paths;
  if (joined === undefined) invalid("watch paths");
  const total = shapes.reduce((sum, shape) => sum + shape.count, 0);
  const paths = split(joined, total);
  if (!paths) invalid("watch paths");
  let at = 0;
  const batches = shapes.map((shape): WatchBatch => {
    const slice = paths.slice(at, at + shape.count);
    at += shape.count;
    return shape.error ? { error: slice[0]! } : { paths: slice };
  });
  return { id: json.id, batches, overflow: overflow === true };
}
