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
