/**
 * The checkout git methods of the worker protocol (since 1.0) and their wire
 * shapes, shared by the server's client (`workers/checkoutClient.ts`) and the
 * Worker's handlers (`worker/checkoutGit.ts`).
 *
 * Every request names a {@link CheckoutLocation}; the Worker refuses one that
 * names another Worker. Results are the runner's raw outcome, settled by the
 * caller's executor family exactly as a local outcome is. Every string the
 * process produced travels as a text stream, exact to the code unit; stdin and
 * raw stdout travel as bytes.
 */
import type { GitRunMode } from "../gitProcess.ts";
import type {
  BrokerBoundedOutcome,
  BrokerExecOutcome,
} from "../spawnBroker.ts";
import type { Payload } from "./codec.ts";
import { WorkerMethodError } from "./connection.ts";

/** Where a checkout is: the Worker it is placed on, and its path there. */
export interface CheckoutLocation {
  workerId: string;
  path: string;
}

export const CHECKOUT_GIT_METHODS = {
  /** git with stdout as text. */
  run: "checkout.git.run",
  /** git with stdout as text, fed the `stdin` bytes. */
  runWithInput: "checkout.git.runWithInput",
  /** git with stdout as raw bytes. */
  raw: "checkout.git.raw",
  /** git keeping a bounded prefix of stdout. */
  bounded: "checkout.git.bounded",
} as const;

/** The error code of a request that names another Worker's checkout. */
export const WRONG_WORKER = "wrong_worker";
/** The error code of a request whose params do not decode. */
export const INVALID_PARAMS = "invalid_params";

/**
 * Overrides of the child environment: a name set to a string (empty allowed),
 * or `null` to remove it. A name not listed is left as the Worker has it.
 */
type EnvOverrides = [name: string, value: string | null][];

interface CheckoutGitCommand {
  location: CheckoutLocation;
  args: string[];
  mode: GitRunMode;
  /** Absent: no overrides. A key set to `undefined` removes the variable. */
  env?: NodeJS.ProcessEnv;
}

export interface CheckoutGitRun extends CheckoutGitCommand {
  maxBuffer: number;
  input?: Buffer;
}

export interface CheckoutGitBounded extends CheckoutGitCommand {
  maxChars: number;
  maxStderr: number;
}

function invalid(what: string): never {
  throw new WorkerMethodError(INVALID_PARAMS, `Invalid ${what}.`);
}

function encodeCommand(command: CheckoutGitCommand): Record<string, unknown> {
  return {
    location: {
      workerId: command.location.workerId,
      path: command.location.path,
    },
    args: command.args,
    mode: command.mode,
    ...(command.env
      ? {
          env: Object.entries(command.env).map(
            ([name, value]): EnvOverrides[number] => [name, value ?? null],
          ),
        }
      : {}),
  };
}

function decodeCommand(json: unknown): CheckoutGitCommand {
  if (typeof json !== "object" || json === null) invalid("checkout git params");
  const params = json as Record<string, unknown>;
  const location = params.location as Record<string, unknown> | null;
  if (
    typeof location !== "object" ||
    location === null ||
    typeof location.workerId !== "string" ||
    typeof location.path !== "string"
  )
    invalid("checkout location");
  if (
    !Array.isArray(params.args) ||
    !params.args.every((arg) => typeof arg === "string")
  )
    invalid("git arguments");
  if (params.mode !== "mutating" && params.mode !== "readOnly")
    invalid("git mode");
  let env: NodeJS.ProcessEnv | undefined;
  if (params.env !== undefined) {
    if (!Array.isArray(params.env)) invalid("environment overrides");
    env = {};
    for (const entry of params.env as unknown[]) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string" ||
        (typeof entry[1] !== "string" && entry[1] !== null)
      )
        invalid("environment override");
      env[entry[0]] = entry[1] ?? undefined;
    }
  }
  return {
    location: { workerId: location.workerId, path: location.path },
    args: params.args as string[],
    mode: params.mode,
    ...(env ? { env } : {}),
  };
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !(value >= 0)) invalid(what);
  return value;
}

/** A `maxBuffer` JSON cannot carry (`Infinity`) travels as `null`. */
function encodeLimit(limit: number): number | null {
  return Number.isFinite(limit) ? limit : null;
}

function decodeLimit(value: unknown, what: string): number {
  return value === null ? Infinity : count(value, what);
}

export function encodeRun(run: CheckoutGitRun): {
  method: string;
  payload: Payload;
} {
  const json = { ...encodeCommand(run), maxBuffer: encodeLimit(run.maxBuffer) };
  return run.input === undefined
    ? { method: CHECKOUT_GIT_METHODS.run, payload: { json } }
    : {
        method: CHECKOUT_GIT_METHODS.runWithInput,
        payload: { json, bytes: { stdin: run.input } },
      };
}

/** `withInput`: the request must carry `stdin`. */
export function decodeRun(
  payload: Payload,
  withInput: boolean,
): CheckoutGitRun {
  const command = decodeCommand(payload.json);
  const params = payload.json as Record<string, unknown>;
  const stdin = payload.bytes?.stdin;
  if (withInput && !stdin) invalid("stdin");
  return {
    ...command,
    maxBuffer: decodeLimit(params.maxBuffer, "maxBuffer"),
    ...(withInput && stdin ? { input: Buffer.from(stdin) } : {}),
  };
}

export function encodeBounded(bounded: CheckoutGitBounded): Payload {
  return {
    json: {
      ...encodeCommand(bounded),
      maxChars: bounded.maxChars,
      maxStderr: bounded.maxStderr,
    },
  };
}

export function decodeBounded(payload: Payload): CheckoutGitBounded {
  const command = decodeCommand(payload.json);
  const params = payload.json as Record<string, unknown>;
  return {
    ...command,
    maxChars: count(params.maxChars, "maxChars"),
    maxStderr: count(params.maxStderr, "maxStderr"),
  };
}

type ExecError = NonNullable<BrokerExecOutcome<string>["error"]>;

function encodeExecError(error: ExecError | null): {
  json: unknown;
  text: Record<string, string>;
} {
  return error
    ? {
        json: { error: { code: error.code } },
        text: { errorMessage: error.message },
      }
    : { json: { error: null }, text: {} };
}

function malformed(what: string): never {
  throw new Error(`The Worker answered a malformed ${what}.`);
}

function decodeExecError(payload: Payload): ExecError | null {
  const json = payload.json as { error?: unknown } | null;
  if (typeof json !== "object" || json === null) malformed("git outcome");
  if (json.error === null) return null;
  const error = json.error as { code?: unknown } | undefined;
  const message = payload.text?.errorMessage;
  if (
    typeof error !== "object" ||
    error === null ||
    (typeof error.code !== "number" &&
      typeof error.code !== "string" &&
      error.code !== null) ||
    message === undefined
  )
    malformed("git error");
  return { code: error.code, message };
}

function text(payload: Payload, name: string): string {
  const value = payload.text?.[name];
  if (value === undefined) malformed(`git ${name}`);
  return value;
}

export function encodeExecOutcome(outcome: BrokerExecOutcome<string>): Payload {
  const error = encodeExecError(outcome.error);
  return {
    json: error.json,
    text: { ...error.text, stdout: outcome.stdout, stderr: outcome.stderr },
  };
}

export function decodeExecOutcome(payload: Payload): BrokerExecOutcome<string> {
  return {
    error: decodeExecError(payload),
    stdout: text(payload, "stdout"),
    stderr: text(payload, "stderr"),
  };
}

export function encodeRawOutcome(outcome: BrokerExecOutcome<Buffer>): Payload {
  const error = encodeExecError(outcome.error);
  return {
    json: error.json,
    text: { ...error.text, stderr: outcome.stderr },
    bytes: { stdout: outcome.stdout },
  };
}

export function decodeRawOutcome(payload: Payload): BrokerExecOutcome<Buffer> {
  const stdout = payload.bytes?.stdout;
  if (!stdout) malformed("git stdout");
  return {
    error: decodeExecError(payload),
    stdout: Buffer.from(stdout.buffer, stdout.byteOffset, stdout.byteLength),
    stderr: text(payload, "stderr"),
  };
}

export function encodeBoundedOutcome(outcome: BrokerBoundedOutcome): Payload {
  return {
    json: {
      code: outcome.code,
      aborted: outcome.aborted,
      totalChars: outcome.totalChars,
    },
    text: {
      patch: outcome.patch,
      stderr: outcome.stderr,
      ...(outcome.spawnError !== undefined
        ? { spawnError: outcome.spawnError }
        : {}),
    },
  };
}

export function decodeBoundedOutcome(payload: Payload): BrokerBoundedOutcome {
  const json = payload.json as Record<string, unknown> | null;
  if (
    typeof json !== "object" ||
    json === null ||
    (typeof json.code !== "number" && json.code !== null) ||
    typeof json.aborted !== "boolean" ||
    typeof json.totalChars !== "number"
  )
    malformed("bounded git outcome");
  const spawnError = payload.text?.spawnError;
  return {
    ...(spawnError !== undefined ? { spawnError } : {}),
    code: json.code,
    aborted: json.aborted,
    patch: text(payload, "patch"),
    totalChars: json.totalChars,
    stderr: text(payload, "stderr"),
  };
}
