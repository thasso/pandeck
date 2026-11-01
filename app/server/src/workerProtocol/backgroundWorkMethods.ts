/**
 * The background-work methods of worker protocol 1.9 and their wire shapes,
 * shared by the Worker's item table (`worker/backgroundWork.ts`) and the
 * server's host (`workers/backgroundWorkHost.ts`). An engine's background
 * work executes on its session's Worker; admission, the durable row, Stop and
 * output evidence stay the server's (`docs/workers.md`).
 *
 * - `backgroundWork.admit` (Worker → server) asks the supervisor to admit one
 *   item and, for a new one, to launch it. `launchKey` is the Worker's opaque
 *   name for the reserved launch, so admission and launch stay one span on the
 *   server. The answer is a denial's message, or the item id, its state, and
 *   whether a retried request reused it.
 * - `backgroundWork.launch` (server → Worker) starts the launch reserved under
 *   `launchKey` as the admitted item.
 * - `backgroundWork.stop` and `backgroundWork.stopAll` (server → Worker) stop
 *   held items by PA id; the answer follows the work's end.
 * - `backgroundWork.activity`, `.rateExceeded`, `.output` and `.completed`
 *   (Worker → server) report one item's facts, each answered `{}`. One item's
 *   reports are sent in order, each after the previous answer.
 *
 * Every address is the PA item id. A command crosses only in `admit`, which
 * records it on the row; a cwd, an environment or a shell never crosses.
 * `output` names a file on the Worker, which the server copies through
 * `files.open`. The runner and reporter an engine hands the Worker's table
 * are typed here too, since the Worker side may import only this folder.
 */
import type {
  BackgroundWorkActivity,
  BackgroundWorkActivityRateExceeded,
  BackgroundWorkCompletion,
  BackgroundWorkLaunchAck,
  BackgroundWorkLaunchRequest,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
  BackgroundWorkTarget,
} from "../backgroundWork/backends.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

export const BACKGROUND_WORK_METHODS = {
  /** Worker → server: admit one item and launch a new one. */
  admit: "backgroundWork.admit",
  /** Server → Worker: start the launch reserved under a launch key. */
  launch: "backgroundWork.launch",
  /** Server → Worker: stop one held item. */
  stop: "backgroundWork.stop",
  /** Server → Worker: stop an owner's reserved items. */
  stopAll: "backgroundWork.stopAll",
  /** Worker → server: one bounded batch of an item's activity. */
  activity: "backgroundWork.activity",
  /** Worker → server: an item exceeded its notification rate. */
  rateExceeded: "backgroundWork.rateExceeded",
  /** Worker → server: an item's captured output file. */
  output: "backgroundWork.output",
  /** Worker → server: how an item ended. */
  completed: "backgroundWork.completed",
} as const;

export type BackgroundWorkMethod =
  (typeof BACKGROUND_WORK_METHODS)[keyof typeof BACKGROUND_WORK_METHODS];

/** The kinds a Worker executes; every other kind runs on the server. */
const WORKER_KINDS = ["shell", "monitor-command", "monitor-websocket"] as const;

type WorkerBackgroundWorkKind = (typeof WORKER_KINDS)[number];

/** One item to admit; `launchKey` is added by the Worker's table. */
export interface BackgroundWorkAdmitRequest {
  sessionId: string;
  launchKey: string;
  kind: WorkerBackgroundWorkKind;
  label: string;
  description?: string;
  /** The command or URL the row records, never executed by the server. */
  command: string;
  sourceRequestId: string;
  requestedLifetimeMs?: number;
}

export type BackgroundWorkAdmitAnswer =
  | { admitted: false; message: string }
  | {
      admitted: true;
      itemId: string;
      state: string;
      /** A retried request: the item admitted before, never launched again. */
      reused: boolean;
      intent?: "service";
      /** The launch outcome of a new item that is not running. */
      outcomeSummary?: string;
    };

export interface BackgroundWorkLaunch {
  launchKey: string;
  request: BackgroundWorkLaunchRequest;
}

/**
 * An item's captured output: a file on the Worker, or the fact that writing
 * it failed. `truncated` and `originalBytes` say the writer exceeded its head
 * cap, whatever the server finds in the file.
 */
export interface BackgroundWorkOutputReport {
  itemId: string;
  eventId: string;
  file?: string;
  writeFailed?: true;
  originalBytes?: number;
  truncated?: true;
}

/** How a runner reports one item's facts; the table sends them in order. */
export interface BackgroundWorkReporter {
  activity(activity: BackgroundWorkActivity): void;
  rateExceeded(event: BackgroundWorkActivityRateExceeded): void;
  /** Resolves once the server has answered, or the report failed. */
  output(output: BackgroundWorkOutputReport): Promise<void>;
  completed(completion: BackgroundWorkCompletion): void;
}

/** A started item's execution, as the table holds it. */
export interface BackgroundWorkRun {
  /** Settles once the work ended and its output was reported. */
  readonly done: Promise<void>;
  /** Stop the work; settles as {@link done} does, or fails with evidence. */
  stop(): Promise<void>;
}

/** One reserved launch, handed to the table with its admission. */
export interface BackgroundWorkRunner {
  readonly ownerSessionId: string;
  readonly kind: WorkerBackgroundWorkKind;
  launch(
    request: BackgroundWorkLaunchRequest,
    reporter: BackgroundWorkReporter,
  ): Promise<
    | { launched: true; run: BackgroundWorkRun }
    | { launched: false; reason?: string }
  >;
}

/** How an engine admits background work through its Worker. */
export interface BackgroundWorkAdmitter {
  admit(
    request: Omit<BackgroundWorkAdmitRequest, "launchKey">,
    runner: BackgroundWorkRunner,
    signal?: AbortSignal,
  ): Promise<BackgroundWorkAdmitAnswer>;
}

/** An answer that is not what its method answers. */
class MalformedBackgroundWorkAnswerError extends Error {}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(method: string): never {
  throw new MalformedBackgroundWorkAnswerError(
    `The peer answered a malformed ${method} result.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function body(payload: Payload, what: string): Record<string, unknown> {
  return record(payload.json) ?? invalid(what);
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") invalid(what);
  return value;
}

/** A non-empty string: an id or a key. */
function id(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") invalid(what);
  return value;
}

function optionalText(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : text(value, what);
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(what);
  return value;
}

function optionalCount(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : count(value, what);
}

function kindOf(value: unknown): WorkerBackgroundWorkKind {
  if (!(WORKER_KINDS as readonly unknown[]).includes(value))
    invalid("background work kind");
  return value as WorkerBackgroundWorkKind;
}

function targetOf(value: unknown): BackgroundWorkTarget {
  const target = record(value) ?? invalid("background work target");
  const hostEpochKey = optionalText(target.hostEpochKey, "host epoch key");
  return {
    itemId: id(target.itemId, "item id"),
    ownerSessionId: id(target.ownerSessionId, "owner session id"),
    kind: kindOf(target.kind),
    ...(hostEpochKey !== undefined ? { hostEpochKey } : {}),
  };
}

function attemptOf(value: unknown): 1 | 2 {
  if (value !== 1 && value !== 2) invalid("stop attempt");
  return value;
}

function lines(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((line) => typeof line !== "string"))
    invalid("activity lines");
  return value as string[];
}

function ids(value: unknown, what: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  )
    invalid(what);
  return value as string[];
}

/** Any request or answer body; the receiving side decodes it per method. */
export function encodeBackgroundWork(value: object): Payload {
  return { json: { ...value } };
}

export function decodeAdmitRequest(
  payload: Payload,
): BackgroundWorkAdmitRequest {
  const json = body(payload, "admission");
  const description = optionalText(json.description, "description");
  const requestedLifetimeMs = optionalCount(
    json.requestedLifetimeMs,
    "requested lifetime",
  );
  return {
    sessionId: id(json.sessionId, "session id"),
    launchKey: id(json.launchKey, "launch key"),
    kind: kindOf(json.kind),
    label: text(json.label, "label"),
    ...(description !== undefined ? { description } : {}),
    command: text(json.command, "command"),
    sourceRequestId: id(json.sourceRequestId, "source request id"),
    ...(requestedLifetimeMs !== undefined ? { requestedLifetimeMs } : {}),
  };
}

export function decodeAdmitAnswer(payload: Payload): BackgroundWorkAdmitAnswer {
  const json = record(payload.json);
  if (json?.admitted === false && typeof json.message === "string")
    return { admitted: false, message: json.message };
  if (
    json?.admitted !== true ||
    typeof json.itemId !== "string" ||
    typeof json.state !== "string" ||
    typeof json.reused !== "boolean" ||
    (json.intent !== undefined && json.intent !== "service") ||
    (json.outcomeSummary !== undefined &&
      typeof json.outcomeSummary !== "string")
  )
    return malformed(BACKGROUND_WORK_METHODS.admit);
  return {
    admitted: true,
    itemId: json.itemId,
    state: json.state,
    reused: json.reused,
    ...(json.intent === "service" ? { intent: "service" as const } : {}),
    ...(typeof json.outcomeSummary === "string"
      ? { outcomeSummary: json.outcomeSummary }
      : {}),
  };
}

export function decodeLaunch(payload: Payload): BackgroundWorkLaunch {
  const json = body(payload, "launch");
  const request = record(json.request) ?? invalid("launch request");
  return {
    launchKey: id(json.launchKey, "launch key"),
    request: {
      target: targetOf(request.target),
      deadlineAt: count(request.deadlineAt, "deadline"),
      emptyHostGraceMs: count(request.emptyHostGraceMs, "empty-host grace"),
    },
  };
}

export function decodeLaunchAck(payload: Payload): BackgroundWorkLaunchAck {
  const json = record(payload.json);
  if (
    typeof json?.launched !== "boolean" ||
    (json.reason !== undefined && typeof json.reason !== "string")
  )
    return malformed(BACKGROUND_WORK_METHODS.launch);
  return {
    launched: json.launched,
    ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
  };
}

export function decodeStop(payload: Payload): BackgroundWorkStopRequest {
  const json = body(payload, "stop");
  return {
    target: targetOf(json.target),
    sourceRequestId: id(json.sourceRequestId, "source request id"),
    attempt: attemptOf(json.attempt),
    reason: text(json.reason, "stop reason"),
  };
}

export function decodeStopAck(payload: Payload): BackgroundWorkStopAck {
  const json = record(payload.json);
  if (
    typeof json?.acknowledged !== "boolean" ||
    (json.evidence !== undefined && typeof json.evidence !== "string")
  )
    return malformed(BACKGROUND_WORK_METHODS.stop);
  return {
    acknowledged: json.acknowledged,
    ...(typeof json.evidence === "string" ? { evidence: json.evidence } : {}),
  };
}

export function decodeStopAll(payload: Payload): BackgroundWorkStopAllRequest {
  const json = body(payload, "stop-all");
  const callerSessionId = optionalText(
    json.callerSessionId,
    "caller session id",
  );
  if (typeof json.protectOrdinaryTurn !== "boolean")
    invalid("ordinary-turn protection");
  return {
    ownerSessionId: id(json.ownerSessionId, "owner session id"),
    ...(callerSessionId !== undefined ? { callerSessionId } : {}),
    sourceRequestId: id(json.sourceRequestId, "source request id"),
    attempt: attemptOf(json.attempt),
    reason: text(json.reason, "stop reason"),
    itemIds: ids(json.itemIds, "item ids"),
    protectOrdinaryTurn: json.protectOrdinaryTurn,
  };
}

export function decodeStopAllAck(payload: Payload): BackgroundWorkStopAllAck {
  const json = record(payload.json);
  const list = (value: unknown) =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? (value as string[])
      : malformed(BACKGROUND_WORK_METHODS.stopAll);
  return {
    acknowledgedItemIds: list(json?.acknowledgedItemIds),
    unconfirmedItemIds: list(json?.unconfirmedItemIds),
  };
}

export function decodeActivity(payload: Payload): BackgroundWorkActivity {
  const json = body(payload, "activity");
  return {
    itemId: id(json.itemId, "item id"),
    lines: lines(json.lines),
    bytes: count(json.bytes, "activity bytes"),
    droppedEventCount: count(json.droppedEventCount, "dropped event count"),
    eventId: id(json.eventId, "event id"),
  };
}

export function decodeRateExceeded(
  payload: Payload,
): BackgroundWorkActivityRateExceeded {
  const json = body(payload, "rate report");
  return {
    itemId: id(json.itemId, "item id"),
    eventId: id(json.eventId, "event id"),
    notificationCount: count(json.notificationCount, "notification count"),
    windowMs: count(json.windowMs, "rate window"),
  };
}

export function decodeOutput(payload: Payload): BackgroundWorkOutputReport {
  const json = body(payload, "output report");
  const file = optionalText(json.file, "output file");
  if (json.writeFailed !== undefined && json.writeFailed !== true)
    invalid("output write failure");
  // Exactly one: a file to copy, or the writer's failure.
  if ((file === undefined) === (json.writeFailed === undefined))
    invalid("output report");
  if (json.truncated !== undefined && json.truncated !== true)
    invalid("output truncation");
  const originalBytes = optionalCount(json.originalBytes, "original bytes");
  return {
    itemId: id(json.itemId, "item id"),
    eventId: id(json.eventId, "event id"),
    ...(file !== undefined ? { file } : { writeFailed: true as const }),
    ...(originalBytes !== undefined ? { originalBytes } : {}),
    ...(json.truncated === true ? { truncated: true as const } : {}),
  };
}

export function decodeCompletion(payload: Payload): BackgroundWorkCompletion {
  const json = body(payload, "completion");
  if (
    json.state !== "completed" &&
    json.state !== "failed" &&
    json.state !== "stopped"
  )
    invalid("completion state");
  const exitCode = json.exitCode;
  if (exitCode !== undefined && !Number.isSafeInteger(exitCode))
    invalid("exit code");
  const outcomeSummary = optionalText(json.outcomeSummary, "outcome summary");
  const eventId = optionalText(json.eventId, "event id");
  const sequence = optionalCount(json.sequence, "sequence");
  return {
    itemId: id(json.itemId, "item id"),
    state: json.state,
    ...(exitCode !== undefined ? { exitCode: exitCode as number } : {}),
    ...(outcomeSummary !== undefined ? { outcomeSummary } : {}),
    ...(eventId !== undefined ? { eventId } : {}),
    ...(sequence !== undefined ? { sequence } : {}),
  };
}

/** The four reports answer `{}` once the server has applied them. */
export function decodeReportAcknowledgement(
  method: string,
  payload: Payload,
): void {
  if (!record(payload.json)) malformed(method);
}
