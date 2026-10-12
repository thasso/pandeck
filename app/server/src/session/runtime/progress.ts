/**
 * The observed progress of one session's running run (`RunProgress`): what
 * the adapter reported and when, kept in memory beside the run state and
 * published through the runtime's outward feed.
 *
 * Publication is the cost to watch. A model streams many deltas a second, and
 * every one of them only moves a timestamp, so those changes are coalesced to
 * one publish per {@link PROGRESS_COALESCE_MS}. A TRANSITION — the run
 * starting, a tool starting or finishing, a retry report, the first output
 * after a wait — publishes at once and takes any pending coalesced publish with
 * it, so what a reader sees never lags a change of state.
 *
 * The tracker reports and decides nothing: it never starts, holds or resumes a
 * turn, and its only output is the `publish` callback.
 */
import type {
  RunProgress,
  RunProgressRetry,
  RunProgressTool,
} from "@assistant/shared/session";

/** At most one publish per window for changes that only move a timestamp. */
export const PROGRESS_COALESCE_MS = 2_000;

interface ProgressState {
  startedAt: number;
  lastActivityAt: number;
  lastModelOutputAt?: number;
  awaitingModelSince?: number;
  /** Insertion order is start order. */
  runningTools: Map<string, RunProgressTool>;
  lastTool?: RunProgress["lastTool"];
  retry?: RunProgressRetry;
}

export class RunProgressTracker {
  private state: ProgressState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly publish: (progress: RunProgress) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a run is being tracked. */
  get active(): boolean {
    return this.state !== undefined;
  }

  /** The current progress, stamped with the time it is read; undefined when idle. */
  snapshot(): RunProgress | undefined {
    const state = this.state;
    if (!state) return undefined;
    return {
      startedAt: state.startedAt,
      observedAt: this.now(),
      lastActivityAt: state.lastActivityAt,
      ...(state.lastModelOutputAt !== undefined
        ? { lastModelOutputAt: state.lastModelOutputAt }
        : {}),
      ...(state.awaitingModelSince !== undefined
        ? { awaitingModelSince: state.awaitingModelSince }
        : {}),
      runningTools: [...state.runningTools.values()].map((tool) => ({
        ...tool,
      })),
      ...(state.lastTool ? { lastTool: { ...state.lastTool } } : {}),
      ...(state.retry ? { retry: { ...state.retry } } : {}),
    };
  }

  /** A run started: input is on its way to the model. A no-op while one is tracked. */
  start(): void {
    if (this.state) return;
    const now = this.now();
    this.state = {
      startedAt: now,
      lastActivityAt: now,
      awaitingModelSince: now,
      runningTools: new Map(),
    };
    this.publishNow();
  }

  /** The run ended. Nothing more is published for it, including a pending coalesced update. */
  stop(): void {
    this.state = undefined;
    this.cancelTimer();
  }

  /** The model produced output: text, thinking, or a tool call being written. */
  modelOutput(): void {
    const state = this.state;
    if (!state) return;
    const now = this.now();
    const transition =
      state.awaitingModelSince !== undefined || state.retry !== undefined;
    state.lastModelOutputAt = now;
    state.lastActivityAt = now;
    delete state.awaitingModelSince;
    delete state.retry;
    if (transition) this.publishNow();
    else this.publishSoon();
  }

  /** Something moved without changing what the run is doing (tool output arriving). */
  activity(): void {
    const state = this.state;
    if (!state) return;
    state.lastActivityAt = this.now();
    this.publishSoon();
  }

  /** The model called a tool, which starts running now. */
  toolStarted(toolCallId: string, name: string): void {
    const state = this.state;
    if (!state) return;
    const now = this.now();
    state.runningTools.delete(toolCallId);
    state.runningTools.set(toolCallId, { toolCallId, name, startedAt: now });
    state.lastTool = { name, state: "started", at: now };
    state.lastModelOutputAt = now;
    state.lastActivityAt = now;
    delete state.awaitingModelSince;
    delete state.retry;
    this.publishNow();
  }

  /**
   * A tool finished. Only a tool this run started counts: a completion this
   * run never saw start (a late one from an earlier run, the durable copy of a
   * completion already reported live) changes nothing. When the last running
   * tool finishes, its results are on their way back to the model.
   */
  toolEnded(toolCallId: string, isError: boolean): void {
    const state = this.state;
    if (!state) return;
    const tool = state.runningTools.get(toolCallId);
    if (!tool) return;
    const now = this.now();
    state.runningTools.delete(toolCallId);
    state.lastTool = {
      name: tool.name,
      state: isError ? "failed" : "completed",
      at: now,
    };
    state.lastActivityAt = now;
    if (state.runningTools.size === 0) state.awaitingModelSince = now;
    this.publishNow();
  }

  /** The provider reported it is retrying a failed request. */
  retry(retry: Omit<RunProgressRetry, "at">): void {
    const state = this.state;
    if (!state) return;
    const now = this.now();
    state.retry = { ...retry, at: now };
    state.lastActivityAt = now;
    // The failed request is replaced by the retried one: the wait continues
    // from the original input, not from this report.
    state.awaitingModelSince ??= now;
    this.publishNow();
  }

  dispose(): void {
    this.stop();
  }

  private publishNow(): void {
    this.cancelTimer();
    const progress = this.snapshot();
    if (!progress) return;
    this.lastPublishedAt = progress.observedAt;
    this.publish(progress);
  }

  private publishSoon(): void {
    if (this.timer) return;
    const wait = this.lastPublishedAt + PROGRESS_COALESCE_MS - this.now();
    if (wait <= 0) {
      this.publishNow();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Whatever the run looks like NOW: a run that ended meanwhile publishes
      // nothing, and one that started since publishes its own state.
      this.publishNow();
    }, wait);
    this.timer.unref?.();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
