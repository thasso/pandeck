import { WRONG_WORKER } from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { LIFECYCLE_METHODS } from "../workerProtocol/lifecycleMethods.ts";
import { answerNextInProcessWorkerCallForTests } from "../workers/inProcessWorker.ts";

type Substitute = Parameters<typeof answerNextInProcessWorkerCallForTests>[1];

/**
 * The in-process Worker's next `method` request naming `path` is served by
 * `substitute` instead; requests for other paths before it are served as
 * usual, so a pass reading several files fails only where the test says.
 * One-shot; answers the disarm.
 */
export function answerForPathForTests(
  method: string,
  path: string,
  substitute: Substitute,
): () => void {
  let armed = true;
  let disarm = () => {};
  const filtered: Substitute = (payload, signal, real) => {
    const location = (payload.json as { location?: { path?: unknown } })
      .location;
    if (location?.path === path) {
      armed = false;
      return substitute(payload, signal, real);
    }
    if (armed) disarm = answerNextInProcessWorkerCallForTests(method, filtered);
    return real(payload, signal);
  };
  disarm = answerNextInProcessWorkerCallForTests(method, filtered);
  return () => {
    armed = false;
    disarm();
  };
}

/** One request the in-process Worker served, by the path it named. */
export interface ServedRequest {
  method: string;
  path: string;
  /** A checkout git request's arguments. */
  args?: string[];
}

/**
 * Records every request of `methods` the in-process Worker serves, each
 * passed through to the real handler. A read or close names a handle, not a
 * path: it is recorded under the path an open recorded here answered that
 * handle for, else as `handle:<n>`. Answers the requests so far and the stop.
 */
export function recordServedForTests(methods: readonly string[]): {
  served: ServedRequest[];
  pathsOf: (method: string) => string[];
  stop: () => void;
} {
  const served: ServedRequest[] = [];
  const opened = new Map<number, string>();
  const disarms = new Map<string, () => void>();
  let recording = true;
  const arm = (method: string) => {
    const substitute: Substitute = async (payload, signal, real) => {
      if (recording)
        disarms.set(
          method,
          answerNextInProcessWorkerCallForTests(method, substitute),
        );
      const json = (payload.json ?? {}) as {
        location?: { path?: unknown };
        handle?: unknown;
        args?: unknown;
      };
      const named = json.location?.path;
      const path =
        typeof named === "string"
          ? named
          : typeof json.handle === "number"
            ? (opened.get(json.handle) ?? `handle:${json.handle}`)
            : "";
      served.push({
        method,
        path,
        ...(Array.isArray(json.args) ? { args: json.args as string[] } : {}),
      });
      const answer = await real(payload, signal);
      const handle = (answer.json as { opened?: { handle?: unknown } } | null)
        ?.opened?.handle;
      if (typeof handle === "number" && typeof named === "string")
        opened.set(handle, named);
      return answer;
    };
    disarms.set(
      method,
      answerNextInProcessWorkerCallForTests(method, substitute),
    );
  };
  for (const method of methods) arm(method);
  return {
    served,
    pathsOf: (method) =>
      served
        .filter((request) => request.method === method)
        .map(({ path }) => path),
    stop: () => {
      recording = false;
      for (const disarm of disarms.values()) disarm();
    },
  };
}

/** A substitute answering `payload` without touching the filesystem. */
export const answering =
  (payload: Payload): Substitute =>
  async () =>
    payload;

/** An answered filesystem failure, as `files.*` encode one. */
export function answeredFailure(
  code: string | null,
  message: string,
  phase?: "open" | "stat",
): Payload {
  return {
    json: { error: { code, ...(phase ? { phase } : {}) } },
    text: { message },
  };
}

/** A malformed answer for each path-level file method and lifecycle method. */
export const MALFORMED_ANSWERS: Record<string, Payload> = {
  [FILE_METHODS.exists]: { json: { exists: "yes" } },
  [FILE_METHODS.inspect]: { json: { inspection: { kind: "pipe" } } },
  [FILE_METHODS.readdir]: { json: { entries: "a" } },
  [FILE_METHODS.realpath]: { json: { path: 5 } },
  [FILE_METHODS.open]: { json: { opened: { handle: 0 } } },
  [FILE_METHODS.readlink]: { json: { target: 5 } },
  [LIFECYCLE_METHODS.mkdir]: { json: "made" },
  [LIFECYCLE_METHODS.createDir]: { json: { dir: "made" } },
  [LIFECYCLE_METHODS.scanResidue]: { json: { scan: { complete: "yes" } } },
  [LIFECYCLE_METHODS.removeTree]: { json: { removal: { removed: "no" } } },
  [LIFECYCLE_METHODS.discardTree]: { json: { discard: { failed: true } } },
  [LIFECYCLE_METHODS.removeAll]: { json: 5 },
  [LIFECYCLE_METHODS.stopProcesses]: {
    json: { stop: { terminated: [1], killed: [2] } },
  },
};

/** A shared flag: the rules gated on it apply only once a rule opened it. */
export interface ScriptGate {
  open: boolean;
}

/** What a rule sees of a request: its location path, git args, and body. */
export interface ScriptedRequest {
  path?: string;
  args?: string[];
  json: Record<string, unknown>;
}

export interface ScriptRule {
  match: (request: ScriptedRequest) => boolean;
  /**
   * `fail`: a refused request (`wrong_worker`), a Worker failure at the
   * client. `answer`: served by the substitute, which may call the real
   * handler. `pass`: served by the real handler.
   */
  action: "fail" | "pass" | { answer: Substitute };
  /** Matching requests the rule passes first, before it applies. */
  skip?: number;
  /** How many times it applies; unlimited when absent. */
  times?: number;
  /** Inactive until this gate is open. */
  gate?: ScriptGate;
  /** Opened each time the rule applies. */
  opens?: ScriptGate;
}

/** One request a script saw, and what it did with it. */
export interface ScriptSeen {
  method: string;
  path?: string;
  args?: string[];
  json: Record<string, unknown>;
  action: "fail" | "answer" | "pass";
}

/**
 * Owns `method`'s substitute slot on the in-process Worker until disarmed:
 * each request re-arms the script FIRST, then the first active matching rule
 * decides it, and an unmatched one passes to the real handler. A rule is
 * active while its gate (if any) is open and its `times` are not used up.
 * Ordering between rules comes from gates opened by earlier requests, never
 * from timing. Every request is recorded in `seen`; never combine this with
 * {@link recordServedForTests} on the same method.
 */
export function scriptWorkerAnswersForTests(
  method: string,
  rules: ScriptRule[],
): { seen: ScriptSeen[]; disarm: () => void } {
  const seen: ScriptSeen[] = [];
  const state = rules.map((rule) => ({ rule, skipped: 0, applied: 0 }));
  let armed = true;
  let disarmSlot = () => {};
  const substitute: Substitute = async (payload, signal, real) => {
    if (armed)
      disarmSlot = answerNextInProcessWorkerCallForTests(method, substitute);
    const json = (payload.json ?? {}) as Record<string, unknown>;
    const named = (json.location as { path?: unknown } | undefined)?.path;
    const request: ScriptedRequest = {
      ...(typeof named === "string" ? { path: named } : {}),
      ...(Array.isArray(json.args) ? { args: json.args as string[] } : {}),
      json,
    };
    const active = state.find(
      ({ rule, applied }) =>
        (!rule.gate || rule.gate.open) &&
        (rule.times === undefined || applied < rule.times) &&
        rule.match(request),
    );
    let action: ScriptSeen["action"] = "pass";
    let answer: Substitute | undefined;
    if (active && active.skipped < (active.rule.skip ?? 0)) active.skipped += 1;
    else if (active) {
      active.applied += 1;
      if (active.rule.opens) active.rule.opens.open = true;
      if (active.rule.action === "fail") action = "fail";
      else if (active.rule.action !== "pass") {
        action = "answer";
        answer = active.rule.action.answer;
      }
    }
    seen.push({
      method,
      ...(request.path !== undefined ? { path: request.path } : {}),
      ...(request.args ? { args: request.args } : {}),
      json,
      action,
    });
    if (action === "fail")
      throw new WorkerMethodError(
        WRONG_WORKER,
        `Scripted Worker failure for ${method}.`,
      );
    return answer ? answer(payload, signal, real) : real(payload, signal);
  };
  disarmSlot = answerNextInProcessWorkerCallForTests(method, substitute);
  return {
    seen,
    disarm: () => {
      armed = false;
      disarmSlot();
    },
  };
}
