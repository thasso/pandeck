/**
 * The engine methods of worker protocol 1.8 and their wire shapes, shared by
 * the Worker's engine table (`worker/engines.ts`) and the server's client
 * (`workers/engineClient.ts`). A live agent engine runs on the session's
 * Worker; the server drives it through these methods, keyed by harness
 * (`docs/workers.md`).
 *
 * - `engine.open` (server → Worker) names a server-assigned engine id, the
 *   harness and its JSON spec, and answers the engine's info, its snapshot and
 *   the `seq` of the last item emitted before the answer.
 * - `engine.command` (server → Worker) names the engine, a command id the
 *   server assigns per engine, and a harness-defined command with JSON
 *   arguments. It answers `{ seq, result }`, or `{ seq, failed, code? }` with
 *   the message as text when the engine's command failed. A request the
 *   Worker cannot serve at all (an engine it does not hold, malformed
 *   parameters) fails as a protocol error and carries no `seq`.
 * - `engine.dispose` (server → Worker) removes the engine, optionally
 *   discarding its state, and answers `{}`.
 * - `engine.events` (Worker → server) carries one engine's items in order,
 *   each with a `seq` and a harness-defined `kind`. One delivery per engine is
 *   in flight at a time; the next follows the server's `{}`, which it sends
 *   once the items are applied.
 *
 * The server settles a command's answer only once it applied every item up to
 * the answer's `seq`, so neither a result nor a failure overtakes the state it
 * follows. The factory contract an engine table hosts is typed here too, since
 * the Worker side may import only this folder.
 */
import type { AppToolCall, AppToolResult } from "./appToolMethods.ts";
import type { BackgroundWorkAdmitter } from "./backgroundWorkMethods.ts";
import { INVALID_PARAMS } from "./checkoutMethods.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";
import type {
  PersistOutputRequest,
  SessionOutputArtifact,
} from "./sessionHookMethods.ts";

export const ENGINE_METHODS = {
  /** Server → Worker: open an engine under a server-assigned id. */
  open: "engine.open",
  /** Server → Worker: run one command on an open engine. */
  command: "engine.command",
  /** Server → Worker: remove an engine. */
  dispose: "engine.dispose",
  /** Worker → server: one engine's next items, in order. */
  events: "engine.events",
} as const;

/** `engine.open` named a harness the Worker hosts no factory for. */
export const UNKNOWN_HARNESS = "unknown_harness";
/** `engine.open` named an engine id the Worker holds or is opening. */
export const ENGINE_ID_TAKEN = "engine_id_taken";
/** The engine is not, or no longer, open on this connection. */
export const ENGINE_GONE = "engine_gone";

/** What an engine's teardown also discards. */
export interface EngineDiscard {
  /** Delete its state on disk, best-effort, unless that is `except`. */
  removeFile?: { except?: string };
}

export interface EngineOpen {
  engineId: number;
  harness: string;
  spec: unknown;
}

export interface EngineOpened {
  info: unknown;
  snapshot: unknown;
  seq: number;
}

export interface EngineCommand {
  engineId: number;
  commandId: number;
  command: string;
  args: unknown;
}

export type EngineCommandAnswer =
  | { seq: number; result: unknown }
  | { seq: number; error: { code?: string; message: string } };

export interface EngineDispose {
  engineId: number;
  discard?: EngineDiscard;
}

/** One item of an engine's ordered stream; the rest is the harness's. */
export interface EngineItem {
  seq: number;
  kind: string;
  [field: string]: unknown;
}

export interface EngineEvents {
  engineId: number;
  items: EngineItem[];
}

/** An item an engine emits; the table numbers it. */
export type HostedEngineItem = { kind: string } & Record<string, unknown>;

/** A live engine as the Worker's table holds it. */
export interface HostedEngine {
  /** What the opened engine reports, as JSON. */
  readonly info: unknown;
  /** Its state now, as JSON; items emitted afterwards follow it. */
  snapshot(): unknown;
  /**
   * Run a command. It starts in the caller's synchronous span, so commands
   * start in the order they arrive; a failure carrying a `code`
   * (`WorkerMethodError`) answers it.
   */
  command(name: string, args: unknown, commandId: number): Promise<unknown>;
  /** Receives every item from now on, in order. Set once. */
  onItem(listener: (item: HostedEngineItem) => void): void;
  dispose(discard?: EngineDiscard): Promise<void>;
}

/** What the table gives each engine it opens. */
export interface HostedEngineHost {
  readonly engineId: number;
  /** The base environment of the engine's children. */
  childEnv(): NodeJS.ProcessEnv;
  /**
   * Run one of the session's app tools on the server (`appTools.call`), once
   * the server has applied every item the engine emitted before the call.
   */
  callAppTool(
    request: Omit<AppToolCall, "callId" | "progress">,
    options: {
      signal?: AbortSignal;
      onProgress?: (partial: AppToolResult) => void;
    },
  ): Promise<AppToolResult>;
  /**
   * Persist an elided native result's full output on the server: the
   * Worker's own `sessionHooks.persistOutput` call, for either harness.
   */
  persistOutput(
    request: PersistOutputRequest,
    signal?: AbortSignal,
  ): Promise<SessionOutputArtifact>;
  /**
   * Admit background work through the Worker's item table, which executes it
   * and reports its facts (`backgroundWork.*`).
   */
  readonly backgroundWork: BackgroundWorkAdmitter;
  /**
   * Materialize a frozen skill set on the server (`skills.materialize`),
   * before every loader reload.
   */
  materializeSkills(names: readonly string[]): Promise<void>;
}

/** Opens one harness's engine from its JSON spec. */
export type HostedEngineFactory = (
  spec: unknown,
  host: HostedEngineHost,
) => Promise<HostedEngine>;

/** An answer that is not what the engine method answers. */
class MalformedEngineAnswerError extends Error {}

/** An engine command's failure, as the server reads it from the answer. */
export class EngineCommandError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function malformed(what: string): never {
  throw new MalformedEngineAnswerError(
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

const isSeq = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function encodeEngineOpen(open: EngineOpen): Payload {
  return { json: { ...open } };
}

export function decodeEngineOpen(payload: Payload): EngineOpen {
  const json = record(payload.json);
  if (!json || !isId(json.engineId)) invalid("engine id");
  if (typeof json.harness !== "string" || json.harness === "")
    invalid("harness");
  return { engineId: json.engineId, harness: json.harness, spec: json.spec };
}

export function encodeEngineOpened(opened: EngineOpened): Payload {
  return { json: { ...opened } };
}

export function decodeEngineOpened(payload: Payload): EngineOpened {
  const json = record(payload.json);
  if (!json || !isSeq(json.seq)) malformed("engine open answer");
  return { info: json.info, snapshot: json.snapshot, seq: json.seq };
}

export function encodeEngineCommand(command: EngineCommand): Payload {
  return { json: { ...command } };
}

export function decodeEngineCommand(payload: Payload): EngineCommand {
  const json = record(payload.json);
  if (!json || !isId(json.engineId)) invalid("engine id");
  if (!isId(json.commandId)) invalid("command id");
  if (typeof json.command !== "string" || json.command === "")
    invalid("command");
  return {
    engineId: json.engineId,
    commandId: json.commandId,
    command: json.command,
    args: json.args,
  };
}

export function encodeEngineCommandAnswer(
  answer: EngineCommandAnswer,
): Payload {
  if ("result" in answer)
    return { json: { seq: answer.seq, result: answer.result } };
  const { code, message } = answer.error;
  return {
    json: {
      seq: answer.seq,
      failed: true,
      ...(code !== undefined ? { code } : {}),
    },
    text: { message },
  };
}

export function decodeEngineCommandAnswer(
  payload: Payload,
): EngineCommandAnswer {
  const json = record(payload.json);
  if (!json || !isSeq(json.seq)) malformed("engine command answer");
  if (json.failed === undefined) return { seq: json.seq, result: json.result };
  if (json.failed !== true) malformed("engine command answer");
  if (json.code !== undefined && typeof json.code !== "string")
    malformed("engine command failure code");
  const message = payload.text?.message;
  if (message === undefined) malformed("engine command failure");
  return {
    seq: json.seq,
    error: {
      ...(json.code !== undefined ? { code: json.code } : {}),
      message,
    },
  };
}

export function encodeEngineDispose(dispose: EngineDispose): Payload {
  return { json: { ...dispose } };
}

export function decodeEngineDispose(payload: Payload): EngineDispose {
  const json = record(payload.json);
  if (!json || !isId(json.engineId)) invalid("engine id");
  if (json.discard === undefined) return { engineId: json.engineId };
  const discard = record(json.discard);
  if (!discard) invalid("discard");
  if (discard.removeFile === undefined)
    return { engineId: json.engineId, discard: {} };
  const removeFile = record(discard.removeFile);
  if (
    !removeFile ||
    (removeFile.except !== undefined && typeof removeFile.except !== "string")
  )
    invalid("discard");
  return {
    engineId: json.engineId,
    discard: {
      removeFile:
        removeFile.except !== undefined ? { except: removeFile.except } : {},
    },
  };
}

/** What `engine.dispose` answers. */
export function encodeEngineDisposed(): Payload {
  return { json: {} };
}

export function encodeEngineEvents(events: EngineEvents): Payload {
  return { json: { engineId: events.engineId, items: events.items } };
}

/** A delivery's items, each numbered after the one before it. */
export function decodeEngineEvents(payload: Payload): EngineEvents {
  const json = record(payload.json);
  if (!json || !isId(json.engineId)) invalid("engine id");
  if (!Array.isArray(json.items) || json.items.length === 0) invalid("items");
  let last = 0;
  for (const value of json.items) {
    const item = record(value);
    if (!item || !isId(item.seq) || item.seq <= last) invalid("item seq");
    if (typeof item.kind !== "string" || item.kind === "") invalid("item kind");
    last = item.seq;
  }
  return { engineId: json.engineId, items: json.items as EngineItem[] };
}

/** What `engine.events` answers. */
export function encodeEngineEventsApplied(): Payload {
  return { json: {} };
}
