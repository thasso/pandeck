import type { Payload } from "../workerProtocol/codec.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
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

/** A malformed answer for each path-level file method. */
export const MALFORMED_ANSWERS: Record<string, Payload> = {
  [FILE_METHODS.exists]: { json: { exists: "yes" } },
  [FILE_METHODS.inspect]: { json: { inspection: { kind: "pipe" } } },
  [FILE_METHODS.readdir]: { json: { entries: "a" } },
  [FILE_METHODS.realpath]: { json: { path: 5 } },
  [FILE_METHODS.open]: { json: { opened: { handle: 0 } } },
  [FILE_METHODS.readlink]: { json: { target: 5 } },
};
