/**
 * What the runtime has OBSERVED of the run in flight: timestamps and counters,
 * never content. It exists so a reader can tell a working session from a quiet
 * one without reading native logs, and it states only what the harness
 * reported — a provider that streams nothing for a minute shows a minute
 * without output, never a stall or a deadlock.
 *
 * Every timestamp is the SERVER's epoch milliseconds. `observedAt` is the
 * server clock when this value was published, so a client ages the others
 * against it plus its own time since receipt and never compares two clocks.
 *
 * Runtime memory only: nothing here is persisted, and a server restart ends
 * every run, so a reconnect after one gets no progress at all rather than a
 * stale one.
 */
export interface RunProgress {
  /** When the runtime marked this run as running. */
  startedAt: number;
  /** Server clock when this value was published. */
  observedAt: number;
  /**
   * The most recent sign of life from the provider or a tool in this run:
   * output, a response starting, stop and usage metadata, a tool starting,
   * writing or finishing, a retry report. Equals `startedAt` until the first.
   */
  lastActivityAt: number;
  /**
   * The most recent model OUTPUT: text, thinking, a tool call chosen or its
   * arguments being written. A response that starts and ends with nothing but
   * metadata does not move it. Absent until the model produced anything.
   */
  lastModelOutputAt?: number;
  /**
   * Input went to the model at this time and no output has come back since
   * (a response carrying only metadata is not output): the prompt, or the
   * results of the tools it last called. Absent while output is arriving or a
   * tool runs.
   */
  awaitingModelSince?: number;
  /** Tools running right now, in the order they started. Names only. */
  runningTools: RunProgressTool[];
  /** The latest tool transition, kept after the tool finishes. */
  lastTool?: {
    name: string;
    state: "started" | "completed" | "failed";
    at: number;
  };
  /**
   * The provider reported a failed request it is retrying, and has not
   * answered since (a response starting, or output, ends it). Only what the harness reported: no attempt number
   * is ever inferred.
   */
  retry?: RunProgressRetry;
}

export interface RunProgressTool {
  toolCallId: string;
  name: string;
  startedAt: number;
}

export interface RunProgressRetry {
  attempt: number;
  maxAttempts?: number;
  /** How long the provider said it would wait before this attempt. */
  delayMs?: number;
  /** HTTP status of the failed request, when the provider had one. */
  status?: number;
  at: number;
}

/**
 * What the run is doing, from the progress alone:
 * - `tool`: at least one tool is running.
 * - `retrying`: the provider is retrying a failed request.
 * - `waiting`: input went to the model and nothing has come back yet.
 * - `receiving`: the model's output has started arriving.
 */
export type RunProgressPhase = "tool" | "retrying" | "waiting" | "receiving";

export function runProgressPhase(progress: RunProgress): RunProgressPhase {
  if (progress.runningTools.length > 0) return "tool";
  if (progress.retry) return "retrying";
  if (progress.awaitingModelSince !== undefined) return "waiting";
  return "receiving";
}

/**
 * Milliseconds since server time `at`, read by a client that received
 * `progress` at its own `receivedAt` and now reads `now` on the same clock.
 * Never negative.
 */
export function runProgressAge(
  progress: Pick<RunProgress, "observedAt">,
  at: number,
  receivedAt: number,
  now: number,
): number {
  return Math.max(0, progress.observedAt - at + Math.max(0, now - receivedAt));
}
