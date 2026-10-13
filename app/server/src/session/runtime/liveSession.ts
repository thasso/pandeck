/**
 * Per-session live runtime state. Owns the SINGLE run-state authority, the
 * in-memory transient streams, the outward subscriber set, and the ingestion of
 * adapter events into the passive {@link SessionLog}. Run state is
 * runtime-derived and NEVER persisted.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentContentBlock,
  AgentStopReason,
  LazyBlockKind,
  SessionConfig,
  SessionConfigModel,
  SessionSnapshot,
  SnapshotRunState,
  PromptDelivery,
  PromptOrigin,
  RunProgress,
  StreamingEntry,
  StreamingMessageEntry,
  StreamingToolEntry,
} from "@assistant/shared/session";
import type { ContextInfo } from "@assistant/shared";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
  PromptOptions,
  ProviderRunId,
  RunFailureFacts,
} from "../adapters/contract.ts";
import { isDetachedAdapter } from "../adapters/detached.ts";
import { contextInfoFromSnapshot, type StatsOptions } from "./stats.ts";
import {
  projectForClient,
  projectHostCommandForClient,
  projectProviderNoticeForClient,
  type ClientTimelineEntry,
} from "../log/projection.ts";
import type {
  ConversationRawEntry,
  HostCommandResultEntry,
  ProviderNoticeEntry,
} from "../log/rawEntry.ts";
import type {
  SessionLog,
  LogEntryDraft,
  TimelineRangeResult,
} from "../log/store.ts";
import {
  InactiveSessionError,
  RunFailedError,
  SessionBusyError,
  SteerNotTakenError,
  SteerWithdrawnError,
} from "./errors.ts";
import type { RuntimeEvent, RuntimeEventListener } from "./events.ts";
import { RunProgressTracker } from "./progress.ts";

export interface RuntimePromptOptions extends PromptOptions {
  /** Provenance of the prompt, recorded on the durable user entry. Defaults to human. */
  origin?: PromptOrigin;
  /**
   * A model-only memory snapshot (Task 91). It is prepended to the text SENT TO
   * THE MODEL but is NEVER written to the durable app-owned log or client
   * projection — the durable user entry keeps only the clean human text. This is
   * the harness-neutral memory-injection seam; the memory runtime computes it.
   */
  memoryBlock?: string;
  /**
   * Additional server-owned context prepended only to the model prompt. Like
   * memoryBlock, it is excluded from the durable user entry so structured
   * handoff context is not misrepresented as user-authored text.
   */
  contextBlock?: string;
  /**
   * Called once with the durable user entry id right after it is appended, so the
   * memory runtime can key its per-turn effective-load audit to the accepted
   * turn (the identity shared with Task 96/99). Not forwarded to the adapter.
   */
  onUserEntry?: (entryId: string) => void;
  /**
   * Called once, synchronously, as the turn this prompt OPENED closes —
   * whichever end closes it — and before the prompt settles. Never for a steer
   * (it joins a run it does not own: {@link subscribeSessionRunEnded}), a
   * duplicate, or a prompt refused before its entry was appended. Not
   * forwarded to the adapter.
   */
  onRunEnded?: (outcome: RunOutcome) => void;
  /** Sanitized peer-prompt card recorded on the durable user entry for rendering. */
  peerPrompt?: import("@assistant/shared").PeerPromptCard;
  /** Durable admission keys for every peer message combined into this entry (server-only). */
  peerMessageIds?: string[];
}

/**
 * How one durable run ended, as the runtime closed its bracket: the terminal
 * fact a caller reads instead of whether a prompt resolved or threw. A Stop
 * resolves a prompt like a finished turn, and a stopped run that kept an
 * earlier attempt's error rejects like a failed one.
 */
export interface RunOutcome {
  /** The run's durable id (`run.started`). */
  runId: string;
  stopReason: "end" | "error" | "aborted";
  /**
   * An abort was ASKED of this run — the user's Stop, a coordinator's
   * stand-down — so how it ended is that abort's doing, an `error` beside it
   * included. A provider-side abort never sets it, and neither does an abort
   * that lands after the run's failure was reported: that failure stands.
   */
  abortRequested: boolean;
}

/**
 * Notified once per durable run as its bracket closes, from whichever end
 * closes it. For a caller that joined a run it did not open (a steer); the
 * opener has {@link RuntimePromptOptions.onRunEnded}.
 */
const runEndedListeners = new Set<
  (sessionId: string, outcome: RunOutcome) => void
>();
export function subscribeSessionRunEnded(
  listener: (sessionId: string, outcome: RunOutcome) => void,
): () => void {
  runEndedListeners.add(listener);
  return () => runEndedListeners.delete(listener);
}

function emitRunEnded(sessionId: string, outcome: RunOutcome): void {
  for (const listener of runEndedListeners) {
    try {
      listener(sessionId, outcome);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Notified when a human-origin prompt — visible or hidden provenance — is
 * appended to a session, so peer-prompt loop chains can reset (Task 105).
 * No prompt changes who owns a spawned session: taking one over is the user's
 * explicit command (`spawnOwnership.ts`). Fires only after the durable user
 * entry exists, and only for the seam BOTH harnesses prompt through — a
 * rejected or deduplicated send appends nothing and never reaches it.
 * Registered at boot; kept as a seam so the runtime layer does not depend on
 * the peer-prompt engine.
 */
let humanPromptHook: ((sessionId: string) => void) | undefined;
export function setHumanPromptHook(
  fn: ((sessionId: string) => void) | undefined,
): void {
  humanPromptHook = fn;
}

/**
 * Notified when a session transitions running→idle, so queued peer prompts can
 * drain regardless of which subsystem drove the turn (browser, permanent
 * assistant, …) and without a browser connection open.
 */
let idleHook: ((sessionId: string) => void) | undefined;
export function setSessionIdleHook(
  fn: ((sessionId: string) => void) | undefined,
): void {
  idleHook = fn;
}

/** One turn that ended in failure, as {@link setRunFailureHook} receives it. */
export interface RunFailureReport {
  sessionId: string;
  /**
   * The failed turn's durable run id (`run.started`) — the identity a consumer
   * deduplicates on, so a repeated report of one turn is recognizable.
   */
  runId: string;
  origin: PromptOrigin | undefined;
  /** The harness's wording. In-memory only: a consumer must not persist it. */
  errorMessage: string | undefined;
  failure: RunFailureFacts | undefined;
  /** When the runtime first saw the failure; a retried report keeps it. */
  at: number;
}

/**
 * Notified once per failed turn, synchronously and BEFORE anything else learns
 * of it: before the turn's error entry is appended or announced, before the
 * run's closing marker, `runStatus` and {@link subscribeSessionRunCompleted}.
 * A consumer that persists a consequence here therefore never loses it to a
 * crash between the failure and a listener. A hook that THROWS stored nothing
 * anywhere: the runtime keeps the report in memory and retries it at every
 * turn boundary (a process exit loses it). What the hook decided at the
 * failure is the hook's to keep across those retries. An aborted turn, or one
 * an abort was asked of, never reaches
 * it, and neither does a straggler of an earlier provider run. Kept as a seam
 * so the runtime layer does not depend on the peer-prompt engine.
 */
let runFailureHook: ((report: RunFailureReport) => void) | undefined;
export function setRunFailureHook(
  fn: ((report: RunFailureReport) => void) | undefined,
): void {
  runFailureHook = fn;
}

/**
 * Notified when a new turn opens, before its prompt can touch session metadata.
 * That ordering lets attention tracking preserve unread state that predates an
 * automatic turn. Out-of-band and synthetic observed turns also open here; a
 * later provider completion decides whether the captured boundary matters.
 */
const runStartedListeners = new Set<(sessionId: string) => void>();
export function subscribeSessionRunStarted(
  listener: (sessionId: string) => void,
): () => void {
  runStartedListeners.add(listener);
  return () => runStartedListeners.delete(listener);
}

function emitRunStarted(sessionId: string): void {
  for (const listener of runStartedListeners) {
    try {
      listener(sessionId);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Notified once for each normalized provider run completion. Unlike the idle
 * hook this excludes synthetic host commands and does not fire for a generic
 * running-state transition. It also carries the turn's prompt origin so
 * attention policy can distinguish a direct human turn from a peer-driven
 * coordinator wake without reading transcript text.
 *
 * A SET rather than one slot: more than one subsystem needs exactly this
 * signal and nothing weaker — usage refresh, push notification, and the
 * Sessions inbox's attention revisions — and a single slot would make the last
 * one to boot silently take the signal away from the others. Each subscriber
 * is isolated: one that throws cannot stop the next from being told.
 */
const runCompletedListeners = new Set<
  (
    sessionId: string,
    stopReason: AgentStopReason,
    origin: PromptOrigin | undefined,
  ) => void
>();
export function subscribeSessionRunCompleted(
  listener: (
    sessionId: string,
    stopReason: AgentStopReason,
    origin: PromptOrigin | undefined,
  ) => void,
): () => void {
  runCompletedListeners.add(listener);
  return () => runCompletedListeners.delete(listener);
}

function emitRunCompleted(
  sessionId: string,
  stopReason: AgentStopReason,
  origin: PromptOrigin | undefined,
): void {
  for (const listener of runCompletedListeners) {
    try {
      listener(sessionId, stopReason, origin);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Every tool call that finished, by session. Worktree status rescans on it, so
 * a viewed checkout reflects an agent's edit without relying on its tree watch.
 */
const toolCompletedListeners = new Set<(sessionId: string) => void>();
export function subscribeSessionToolCompleted(
  listener: (sessionId: string) => void,
): () => void {
  toolCompletedListeners.add(listener);
  return () => toolCompletedListeners.delete(listener);
}

function emitToolCompleted(sessionId: string): void {
  for (const listener of toolCompletedListeners) {
    try {
      listener(sessionId);
    } catch {
      /* best-effort */
    }
  }
}

/** How many closed runs' outcomes a session keeps for late answers. */
const RECENT_OUTCOMES_MAX = 8;

export class LiveRuntimeSession {
  private runState: SnapshotRunState = "idle";
  private readonly streaming = new Map<string, StreamingEntry>();
  private readonly subscribers = new Set<RuntimeEventListener>();
  /** Idempotency: request ids accepted by THIS live session (checked before the busy gate). */
  private readonly handledRequestIds = new Set<string>();
  private unsubscribeAdapter: () => void;
  private config: SessionConfig = {};
  private availableModels: SessionConfigModel[] | undefined;
  private disposed = false;
  /**
   * The session is being torn down (deleted, or its harness released): no
   * new prompt is taken, the idle edge offers nothing, and a prompt still
   * waiting on the provider stops waiting — its source is going away.
   */
  private tornDown = false;
  /** Provider waits a teardown ends, each removed as its own wait settles. */
  private readonly teardownWaiters = new Set<() => void>();
  /**
   * The log cursor when the CURRENT (or most recent) turn began — the boundary a
   * post-turn provider scan is reconciled against, so only that turn is bound and
   * a session's existing history is never rewritten by a scan that reports the
   * whole native file. It survives the turn's end because the scan arrives after
   * the run completion that closed it.
   */
  private turnStartSeq: number;
  private turnOpen = false;
  /**
   * The user entries THIS turn's provider accepted. A prompt is appended to the
   * durable log before the provider answers, so a refused one (a steering
   * message the harness ignored) exists for us and not for it — and pairing it
   * with a native prompt would reach back into an earlier turn.
   */
  private turnPromptEntryIds = new Set<string>();
  /** Identity of the open turn's durable run bracket, while one is open. */
  private turnRunId: string | undefined;
  /** The run whose failure was last recorded, so one turn records once. */
  private recordedFailureRunId: string | undefined;
  /**
   * Failures the hook could not make durable anywhere (it threw), oldest
   * first. Memory is all that holds them, so they are retried at every turn
   * boundary until the hook takes them; a process exit loses them.
   */
  private unrecordedFailures: RunFailureReport[] = [];
  /** The provider run the open turn belongs to, once one announced itself. */
  private turnProviderRun: ProviderRunId | undefined;
  /** The newest provider run known to be over; nothing at or below it is open. */
  private lastClosedProviderRun: ProviderRunId = 0;
  /** An abort was asked of the open turn: how it ends is the abort's doing. */
  private abortRequested = false;
  /**
   * The open turn's failure was already reported: how it ended is decided,
   * and a Stop or teardown abort that lands afterwards does not relabel it.
   */
  private turnFailed = false;
  /** The prompt that opened each still-open run, waiting to hear how it ends. */
  private readonly runEndWaiters = new Map<
    string,
    (outcome: RunOutcome) => void
  >();
  /**
   * The last few closed runs' outcomes, for an answer that arrives after its
   * run closed (a withdrawn steer). Bounded: only the newest matter.
   */
  private readonly recentOutcomes = new Map<string, RunOutcome>();
  /**
   * Why the open turn is running. A visible human steer takes precedence over
   * its earlier trigger: once the user joins a turn, its result is theirs.
   */
  private turnOrigin: PromptOrigin | undefined;
  /** Provenance waiting for the next provider-initiated assistant entry. */
  private pendingAssistantOrigin: PromptOrigin | undefined;
  /**
   * What the running run has been observed doing. Lives and dies with the
   * running state: started by {@link setRunning}, never by an adapter event on
   * its own, so nothing that arrives while idle can bring it back.
   */
  private readonly progress = new RunProgressTracker((progress) =>
    this.emit({ type: "runProgress", progress }),
  );
  /**
   * The provider run (the adapter event's `run`) the current running state
   * belongs to: the run its first message announced. Progress credits events
   * of this run ONLY, so a late callback of an earlier run — which carries
   * that run's id, or none once its harness closed it — moves nothing.
   */
  private progressRun: ProviderRunId | undefined;
  /** Runs are numbered upward per adapter; one already credited is never rebound. */
  private lastProgressRun: ProviderRunId = 0;

  constructor(
    readonly sessionId: string,
    private readonly log: SessionLog,
    private adapter: PromptableAdapter,
  ) {
    // Everything already in the log predates this runtime: no turn of ours.
    this.turnStartSeq = log.seqCursor;
    // Subscribe BEFORE anything else so no adapter event is missed.
    this.unsubscribeAdapter = adapter.subscribe((event) => this.ingest(event));
  }

  /**
   * Swap in the adapter of a harness that has just been opened for a session
   * rendered DETACHED so far (`adapters/detached.ts`).
   *
   * Only legal while nothing is in flight, which is exactly the case it exists
   * for: a detached session cannot run — its adapter refuses every drive call —
   * so there is no stream to strand and no turn to reattribute. Re-binding a
   * session that already has a real adapter would do both, so it is refused.
   */
  rebindAdapter(adapter: PromptableAdapter): void {
    if (!isDetachedAdapter(this.adapter))
      throw new Error(
        `Session ${this.sessionId} already has an open harness adapter.`,
      );
    this.unsubscribeAdapter();
    this.adapter = adapter;
    // A new adapter numbers its runs afresh.
    this.lastProgressRun = 0;
    this.lastClosedProviderRun = 0;
    this.turnProviderRun = undefined;
    // The turn boundary follows the live log, not the old adapter: whatever the
    // detached view rendered predates anything this harness will run.
    this.turnStartSeq = this.log.seqCursor;
    this.unsubscribeAdapter = adapter.subscribe((event) => this.ingest(event));
  }

  /** Whether this session is still rendered without an open harness. */
  get isDetached(): boolean {
    return isDetachedAdapter(this.adapter);
  }

  /**
   * Open a turn at the current end of the log, unless one is already open — a
   * steering prompt joins the running turn rather than starting another.
   *
   * The `run.started` marker is what makes an unfinished turn VISIBLE after the
   * process dies. Both harnesses hand the durable log a turn's assistant entry
   * and tool results in one flush at `messageCompleted`, so a turn killed
   * mid-flight leaves the log with no trace that it ever ran — the session reads
   * as idle and healthy while hours of work are absent. This marker and its
   * closer bracket the run, so the ONLY thing boot has to look for is an
   * unmatched open one.
   */
  private beginTurn(origin: PromptOrigin | undefined): void {
    if (this.turnOpen) return;
    // A failure nothing could store yet gets another attempt.
    this.retryUnrecordedFailures();
    this.turnProviderRun = undefined;
    this.abortRequested = false;
    this.turnFailed = false;
    this.turnStartSeq = this.log.seqCursor;
    this.turnPromptEntryIds = new Set();
    this.turnOrigin = origin;
    this.turnOpen = true;
    this.turnRunId = randomUUID();
    emitRunStarted(this.sessionId);
    this.log.append({ type: "run.started", runId: this.turnRunId });
  }

  private noteTurnOrigin(origin: PromptOrigin, hidden: boolean): void {
    // Hidden human prompts are server provenance/rebuild inputs, not the user
    // speaking. Production user decisions carry an explicit system origin.
    if (origin.kind === "human" && hidden) return;
    if (!this.turnOrigin || origin.kind === "human") this.turnOrigin = origin;
  }

  /**
   * Close the turn, KEEPING its boundary: a provider scan is delivered after the
   * completion that ended the turn, and is reconciled against it. Called from
   * both ends a run can finish at — the observed completion event and the
   * prompt's own settlement — because not every adapter emits both. The
   * `turnOpen` guard is what keeps the closing marker single when both fire;
   * `only` keeps a settlement from closing a turn other than its own.
   *
   * The ONE place a run's {@link RunOutcome} is decided, so its opener and
   * every {@link subscribeSessionRunEnded} listener hear the same answer, once.
   * `abortRequested` adds an emitter's own word that the abort was asked for
   * to the runtime's.
   */
  private endTurn(
    stopReason: RunOutcome["stopReason"] = "end",
    only?: string,
    abortRequested = false,
  ): void {
    if (!this.turnOpen) return;
    if (only !== undefined && this.turnRunId !== only) return;
    this.turnOpen = false;
    const runId = this.turnRunId;
    this.turnRunId = undefined;
    if (!runId) return;
    this.retryUnrecordedFailures();
    this.log.append({
      type: stopReason === "aborted" ? "run.aborted" : "run.ended",
      runId,
    });
    const outcome: RunOutcome = {
      runId,
      stopReason,
      abortRequested:
        !this.turnFailed && (this.abortRequested || abortRequested),
    };
    this.recentOutcomes.set(runId, outcome);
    for (const old of this.recentOutcomes.keys()) {
      if (this.recentOutcomes.size <= RECENT_OUTCOMES_MAX) break;
      this.recentOutcomes.delete(old);
    }
    const waiter = this.runEndWaiters.get(runId);
    this.runEndWaiters.delete(runId);
    try {
      waiter?.(outcome);
    } catch {
      /* best-effort: a waiter must not break the run's close */
    }
    emitRunEnded(this.sessionId, outcome);
  }

  /** The open turn's run id — the run a steer appended now joins. */
  get currentRunId(): string | undefined {
    return this.openRunId();
  }

  /** The open turn's run id, if a turn is open. */
  private openRunId(): string | undefined {
    return this.turnOpen ? this.turnRunId : undefined;
  }

  /**
   * Whether an event belongs to a run that is already over, or to another run
   * than the open turn's. Such a straggler must not fail or end the turn open
   * now. An event its emitter marked `unowned` — a native completion with no
   * run open — belongs to no turn at all. An event of an adapter that numbers
   * no runs is the open turn's, as it always was.
   */
  private isStaleRun(
    run: ProviderRunId | undefined,
    unowned?: boolean,
  ): boolean {
    if (unowned) return true;
    if (run === undefined) return false;
    if (run <= this.lastClosedProviderRun) return true;
    return this.turnProviderRun !== undefined && run !== this.turnProviderRun;
  }

  /**
   * Report run `runId`'s failure to {@link runFailureHook}, once. `runId` is the
   * run the CALLER saw fail — the open turn's for a completion event, the
   * prompt's own for its result — never whichever turn happens to be open by
   * the time a late answer arrives. A turn an abort was asked of reports
   * nothing: how it ends is the abort's doing.
   */
  private reportRunFailure(
    runId: string | undefined,
    errorMessage: string | undefined,
    failure: RunFailureFacts | undefined,
  ): void {
    if (runId === undefined || this.abortRequested) return;
    if (this.openRunId() === runId) this.turnFailed = true;
    if (this.recordedFailureRunId === runId) return;
    this.unrecordedFailures = this.unrecordedFailures.filter(
      (r) => r.runId !== runId,
    );
    this.recordFailure({
      sessionId: this.sessionId,
      runId,
      origin: this.turnOrigin,
      errorMessage,
      failure,
      at: Date.now(),
    });
  }

  /**
   * Hand one failure to the hook. Only a hook that returned counts as
   * recorded; one that threw keeps the failure for another attempt and says
   * so, naming the run but never the provider's words.
   */
  private recordFailure(report: RunFailureReport): boolean {
    try {
      runFailureHook?.(report);
    } catch (err) {
      if (!this.unrecordedFailures.some((r) => r.runId === report.runId))
        this.unrecordedFailures.push(report);
      // Never the error itself: its name, message and stack are its thrower's.
      void err;
      console.error(
        `[runtime] could not store the failure of run ${report.runId} in ${this.sessionId}; it is kept in memory and retried`,
      );
      return false;
    }
    this.recordedFailureRunId = report.runId;
    this.unrecordedFailures = this.unrecordedFailures.filter(
      (r) => r.runId !== report.runId,
    );
    return true;
  }

  private retryUnrecordedFailures(): void {
    for (const report of [...this.unrecordedFailures])
      this.recordFailure(report);
  }

  /* ------------------------------ run state ------------------------------ */

  get isRunning(): boolean {
    return this.runState === "running";
  }

  private setRunning(running: boolean): void {
    const next: SnapshotRunState = running ? "running" : "idle";
    if (this.runState === next) return;
    this.runState = next;
    this.progressRun = undefined;
    if (!running) this.progress.stop();
    this.emit({ type: "runStateChanged", runState: next });
    if (running) this.progress.start();
    // A running→idle transition is the browser-independent trigger to drain any
    // peer prompts queued behind this turn, whatever drove it.
    if (next === "idle" && !this.tornDown) {
      try {
        idleHook?.(this.sessionId);
      } catch {
        /* best-effort */
      }
    }
  }

  /* ------------------------------- prompts ------------------------------- */

  /**
   * Run one prompt. Normally idle-only (concurrent → {@link SessionBusyError});
   * providers with `capabilities.steer` may accept an explicit steering prompt
   * while running. A durable user entry is appended at submission, with `hidden`
   * preserving non-rendered prompts for rebuild/fork provenance. **Idempotent on
   * `clientRequestId`** — the check precedes the busy gate, so a duplicate DURING
   * an in-flight run is a no-op (not a busy error). A run that resolves with
   * `stopReason: "error"` throws {@link RunFailedError}.
   */
  async prompt(
    text: string,
    options: RuntimePromptOptions = {},
  ): Promise<void> {
    const {
      clientRequestId,
      origin,
      memoryBlock,
      contextBlock,
      onUserEntry,
      onRunEnded,
      peerPrompt: _peerPrompt,
      peerMessageIds: _peerMessageIds,
      ...adapterOpts
    } = options;
    if (this.tornDown) throw new InactiveSessionError(this.sessionId);
    if (clientRequestId && this.handledRequestIds.has(clientRequestId)) return; // dup (precedes busy gate)
    const steering =
      this.runState === "running" &&
      options.steer === true &&
      this.adapter.capabilities.steer === true;
    if (this.runState === "running" && !steering)
      throw new SessionBusyError(this.sessionId);
    // "Steer or nothing" with no turn to steer is nothing — never a fresh turn.
    // The caller sampled a running session a moment ago; this is the same race
    // the driver-side check exists for, caught one layer earlier.
    if (options.steerOnly === true && !steering)
      throw new SteerNotTakenError(this.sessionId);
    if (clientRequestId) this.handledRequestIds.add(clientRequestId);

    const promptOrigin = origin ?? { kind: "human" as const };
    const turnOrigin =
      promptOrigin.kind === "human" && options.hidden
        ? undefined
        : promptOrigin;
    const modelContext = [memoryBlock, contextBlock]
      .filter((block): block is string => Boolean(block))
      .join("\n\n");
    const modelText = modelContext ? `${modelContext}\n\n${text}` : text;

    // A steer-only sender accepts "nothing was sent" as an answer, so the driver
    // — which holds the authoritative streaming state — decides, and NOTHING is
    // appended until it says the message went into the running turn. Ordinary
    // prompts and opportunistic steers keep appending first: their durable entry
    // is the record of what the user asked for even when the provider then fails.
    if (steering && options.steerOnly === true) {
      // EVERY failing exit releases the dedup key. Nothing was appended and
      // nothing reached the model, so a caller retrying with the same identity
      // must not be answered "already handled" — that reports a delivery that
      // never happened and discards the only copy of the fact.
      const releaseKey = (): void => {
        if (clientRequestId) this.handledRequestIds.delete(clientRequestId);
      };
      let result: AgentRunResult;
      try {
        result = await this.adapter.prompt(modelText, {
          ...(clientRequestId !== undefined ? { clientRequestId } : {}),
          ...adapterOpts,
          steer: true,
          steerOnly: true,
        });
      } catch (error) {
        releaseKey();
        throw error;
      }
      if (result.stopReason === "error") {
        releaseKey();
        throw new RunFailedError(
          result.errorMessage ?? "Unknown provider error",
          result.code,
        );
      }
      if (result.steered !== true) {
        releaseKey();
        throw new SteerNotTakenError(this.sessionId);
      }
      this.beginTurn(turnOrigin);
      const steeredEntryId = this.appendUserEntry(text, options, "steer");
      if (onUserEntry) onUserEntry(steeredEntryId);
      this.turnPromptEntryIds.add(steeredEntryId);
      return;
    }

    // A provider that decides a steer's fate later (it may join the turn at the
    // next step or run after the reply) is answered before anything is
    // appended, so the durable entry sits where the model actually read it.
    if (steering && this.adapter.capabilities.steerAcceptance === "deferred") {
      const releaseKey = (): void => {
        if (clientRequestId) this.handledRequestIds.delete(clientRequestId);
      };
      // Recorded at the provider's own acceptance, inside its run: the entry
      // joins that run (a follow-up continues it) and never opens a bracket.
      let recorded = false;
      // The run this steer was aimed at, so a withdrawal can say whether that
      // run was stopped on purpose.
      const aimedRun = this.openRunId();
      // An acceptance the provider had already queued can still arrive after
      // that run closed — a teardown, or the run ending first. The run it was
      // aimed at is over, so nothing is appended after its close; the message
      // may have been read, which the caller is told.
      let acceptedLate = false;
      const record = (delivery: PromptDelivery): void => {
        if (recorded || acceptedLate) return;
        if (
          this.tornDown ||
          (aimedRun !== undefined && this.openRunId() !== aimedRun)
        ) {
          acceptedLate = true;
          return;
        }
        recorded = true;
        const entryId = this.appendUserEntry(text, options, delivery);
        if (onUserEntry) onUserEntry(entryId);
        if (this.turnOpen) this.turnPromptEntryIds.add(entryId);
      };
      let result: AgentRunResult;
      try {
        // A teardown ends the wait: whatever became of the message is no
        // longer known, so it reads as possibly read and is never re-sent.
        result = await this.untilTeardown(
          this.adapter.prompt(modelText, {
            ...(clientRequestId !== undefined ? { clientRequestId } : {}),
            ...adapterOpts,
            steer: true,
            onSteerAccepted: record,
          }),
          {
            stopReason: "end",
            steerWithdrawn: true,
            steerUncertain: true,
          },
        );
      } catch (error) {
        if (!recorded) releaseKey();
        // Taken after its run closed, then the provider failed: it may still
        // have been read, which outranks how the provider ended.
        if (acceptedLate && !recorded)
          throw new SteerWithdrawnError(
            this.sessionId,
            true,
            this.abortWasRequested(aimedRun),
          );
        throw error;
      }
      if (acceptedLate && !recorded) {
        releaseKey();
        throw new SteerWithdrawnError(
          this.sessionId,
          true,
          this.abortWasRequested(aimedRun),
        );
      }
      if (result.stopReason === "error" && !recorded) {
        releaseKey();
        throw new RunFailedError(
          result.errorMessage ?? "Unknown provider error",
          result.code,
        );
      }
      // An adapter that answered without calling back is recorded now.
      if (result.steerDelivery) record(result.steerDelivery);
      // Withdrawn (a Stop) or never sent: the session was busy, which is what
      // lets a handoff fall back to its queue instead of losing the decision.
      if (!recorded) {
        releaseKey();
        throw result.steerWithdrawn || acceptedLate
          ? new SteerWithdrawnError(
              this.sessionId,
              result.steerUncertain === true || acceptedLate,
              this.abortWasRequested(aimedRun),
            )
          : new SessionBusyError(this.sessionId);
      }
      return;
    }

    // The durable app log + client projection get ONLY the clean human text;
    // model-only memory and structured context are prepended only to provider
    // input so the visible transcript never presents them as user-authored.
    this.beginTurn(turnOrigin);
    // The run this prompt belongs to. A late result of it must neither fail
    // nor close a turn that opened after it.
    const ownRunId = this.turnRunId;
    let entryId: string;
    try {
      entryId = this.appendUserEntry(
        text,
        options,
        steering ? "steer" : undefined,
      );
    } catch (error) {
      // The entry may be on disk already — the append persists it before its
      // own bookkeeping — but the provider never got it: this prompt's run
      // ends here, failed, rather than stay open for the next prompt to join.
      if (!steering) {
        try {
          this.endTurn("error", ownRunId);
        } catch {
          /* the log refusing again leaves the bracket for boot to see */
        }
      }
      throw error;
    }
    if (onUserEntry) onUserEntry(entryId);

    if (steering) {
      // Only a steering prompt the provider TOOK belongs to the running turn:
      // this call rejects (or reports an error) when it did not, and the durable
      // entry then stays out of the turn's prompt set so no post-turn scan can
      // pair it with a native prompt that belongs to an earlier turn.
      // Already in the log; a teardown closed its run, which says how it went.
      const result = await this.untilTeardown(
        this.adapter.prompt(modelText, {
          ...(clientRequestId !== undefined ? { clientRequestId } : {}),
          ...adapterOpts,
          steer: true,
        }),
        { stopReason: "end" },
      );
      if (result.stopReason === "error")
        throw new RunFailedError(
          result.errorMessage ?? "Unknown provider error",
          result.code,
        );
      this.turnPromptEntryIds.add(entryId);
      return;
    }

    // The turn's own prompt. A provider that refuses it throws below and no scan
    // ever arrives for this turn, so claiming it here cannot mis-bind anything.
    this.turnPromptEntryIds.add(entryId);
    // Only the prompt that opened the run hears how it ends; a steer joins.
    if (ownRunId && onRunEnded) this.runEndWaiters.set(ownRunId, onRunEnded);
    this.setRunning(true);
    // How this prompt saw its run end; a throw is a failed run.
    let settled: RunOutcome["stopReason"] = "error";
    try {
      let result: AgentRunResult;
      try {
        // A teardown ends the wait: the run is closed (`endForTeardown`) and
        // whatever the provider answers afterwards — a default clean end
        // included — is no evidence of how it went.
        result = await this.untilTeardown(
          this.adapter.prompt(modelText, {
            ...(clientRequestId !== undefined ? { clientRequestId } : {}),
            ...adapterOpts,
          }),
          { stopReason: "aborted" },
        );
      } catch (error) {
        // The prompt is already in the log, so a harness that throws instead
        // of answering ended this turn as surely as a failed run does.
        this.reportRunFailure(
          this.openRunId() === ownRunId ? ownRunId : undefined,
          error instanceof Error ? error.message : String(error),
          undefined,
        );
        throw error;
      }
      settled = result.stopReason;
      if (result.stopReason === "error") {
        // An adapter that resolves without emitting its completion event.
        this.reportRunFailure(
          this.openRunId() === ownRunId ? ownRunId : undefined,
          result.errorMessage,
          undefined,
        );
        throw new RunFailedError(
          result.errorMessage ?? "Unknown provider error",
          result.code,
        );
      }
    } finally {
      // A no-op when the completion event already closed the run; otherwise
      // the adapter's own answer is how it ended.
      this.endTurn(settled, ownRunId);
      // A turn that opened after this one ended is not this prompt's to idle.
      if (!this.turnOpen) this.setRunning(false);
    }
  }

  private appendUserEntry(
    text: string,
    options: RuntimePromptOptions,
    delivery?: PromptDelivery,
  ): string {
    const { clientRequestId, origin } = options;
    // Attachments are recorded as content blocks on the durable user entry ONLY
    // when the adapter forwards them to the model, so the durable entry never
    // advertises files the model never saw. Adapters that don't support
    // attachments (`capabilities.attachments` false) drop them.
    const attachments = this.adapter.capabilities.attachments
      ? (options.attachments ?? [])
      : [];
    const content: AgentContentBlock[] = [];
    if (text.length > 0) content.push({ type: "text", text });
    for (const a of attachments) {
      content.push({
        type: "image",
        mimeType: a.mimeType,
        name: a.name,
        ref: a.id,
        size: a.size,
        ...(a.role ? { role: a.role } : {}),
      });
    }
    if (content.length === 0) content.push({ type: "text", text });

    const userRaw = this.log.append({
      type: "message",
      role: "user",
      origin: origin ?? { kind: "human" },
      ...(options.hidden ? { hidden: true } : {}),
      ...(delivery ? { delivery } : {}),
      ...(options.peerPrompt ? { peerPrompt: options.peerPrompt } : {}),
      ...(options.peerMessageIds && options.peerMessageIds.length > 0
        ? { peerMessageIds: options.peerMessageIds }
        : {}),
      content,
      ...(clientRequestId ? { clientRequestId } : {}),
    } as LogEntryDraft) as ConversationRawEntry;

    // Hidden prompts are kept durably for replay/fork/provenance but omitted from
    // the client timeline delta; snapshots also skip them during display mapping.
    if (!options.hidden)
      this.emit({
        type: "entryAppended",
        entry: projectForClient(userRaw),
        ...(clientRequestId ? { clientRequestId } : {}),
      });
    // A real human turn resets peer-prompt loop chains for this session. It
    // never changes who owns a spawned session.
    const promptOrigin = origin ?? { kind: "human" as const };
    this.noteTurnOrigin(promptOrigin, options.hidden === true);
    if (promptOrigin.kind === "human") humanPromptHook?.(this.sessionId);
    return userRaw.id;
  }

  /** Mark the next assistant entry as provider-initiated without inventing a user row. */
  markNextAssistantOrigin(origin: PromptOrigin): () => void {
    if (this.pendingAssistantOrigin)
      throw new Error("a provider-initiated turn origin is already pending");
    this.pendingAssistantOrigin = origin;
    return () => {
      if (this.pendingAssistantOrigin === origin)
        this.pendingAssistantOrigin = undefined;
    };
  }

  abort(): void | Promise<void> {
    // A turn already reported failed stays failed: this abort only tears it
    // down, and its outcome must not read as the Stop's doing.
    if (this.turnOpen && !this.turnFailed) this.abortRequested = true;
    return this.adapter.abort();
  }

  /** Whether an abort was asked of `runId`, open or recently closed. */
  private abortWasRequested(runId: string | undefined): boolean {
    if (runId === undefined) return false;
    if (this.openRunId() === runId)
      return this.abortRequested && !this.turnFailed;
    return this.recentOutcomes.get(runId)?.abortRequested === true;
  }

  /* ---------------------------- ingestion -------------------------------- */

  /** Translate an adapter event into transient-stream updates and/or log appends. */
  private ingest(event: AdapterEvent): void {
    switch (event.type) {
      case "messageStarted": {
        // Usually prompts enter through LiveRuntimeSession.prompt(), which marks
        // the run as active before driving the adapter. Keep the runtime honest
        // even if the underlying engine is driven out-of-band while this adapter
        // is observing it (slash-command synthetic turns, defensive direct calls)
        // — including the turn boundary a post-turn scan is reconciled against.
        this.beginTurn(this.pendingAssistantOrigin);
        if (
          event.run !== undefined &&
          this.turnProviderRun === undefined &&
          event.run > this.lastClosedProviderRun
        )
          this.turnProviderRun = event.run;
        this.setRunning(true);
        const stream: StreamingMessageEntry = {
          streamId: event.streamId,
          kind: "message",
          role: "assistant",
          content: [],
        };
        this.streaming.set(event.streamId, stream);
        // The run this message opens (or continues: a retry, a follow-up)
        // is what the running state's progress credits from here on. A run an
        // EARLIER running state credited stays theirs.
        if (
          event.run !== undefined &&
          (event.run > this.lastProgressRun || event.run === this.progressRun)
        ) {
          this.progressRun = event.run;
          this.lastProgressRun = event.run;
        }
        this.emit({ type: "messageStarted", streamId: event.streamId });
        return;
      }
      case "messageDelta": {
        const stream = this.streaming.get(event.streamId);
        if (stream && stream.kind === "message")
          appendDelta(stream.content, event.delta.kind, event.delta.text);
        if (this.creditsProgress(event.run) && event.delta.text.length > 0)
          this.progress.modelOutput();
        this.emit({
          type: "messageDelta",
          streamId: event.streamId,
          delta: event.delta,
        });
        return;
      }
      case "messageCompleted": {
        // A failed turn's error entry is the first anyone hears of the failure,
        // so the failure is recorded before it is appended or announced.
        if (
          event.stopReason === "error" &&
          !this.isStaleRun(event.run, event.unowned)
        )
          this.reportRunFailure(this.openRunId(), event.error, event.failure);
        // Remove the transient stream BEFORE broadcasting the durable replacement.
        this.streaming.delete(event.streamId);
        this.emit({ type: "messageCompleted", streamId: event.streamId });
        const origin = this.pendingAssistantOrigin;
        this.pendingAssistantOrigin = undefined;
        const raw = this.log.append({
          type: "message",
          role: "assistant",
          ...(origin !== undefined ? { origin } : {}),
          content: event.content,
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.usage !== undefined ? { usage: event.usage } : {}),
          ...(event.stopReason !== undefined
            ? { stopReason: event.stopReason }
            : {}),
          ...(event.error !== undefined ? { error: event.error } : {}),
          ...(event.providerMessageId !== undefined
            ? { providerMessageId: event.providerMessageId }
            : {}),
          ...(event.startedAt !== undefined
            ? { startedAt: event.startedAt }
            : {}),
          ...(event.completedAt !== undefined
            ? { completedAt: event.completedAt }
            : {}),
        } as LogEntryDraft) as ConversationRawEntry;
        this.emit({ type: "entryAppended", entry: projectForClient(raw) });
        return;
      }
      case "toolStarted": {
        // Tool streams can also be opened by observed host-command turns that did
        // not enter through prompt(); treat them as active runtime work.
        this.setRunning(true);
        const stream: StreamingToolEntry = {
          streamId: event.streamId,
          kind: "tool",
          toolCallId: event.toolCallId,
          name: event.name,
          ...(event.input !== undefined ? { input: event.input } : {}),
        };
        this.streaming.set(event.streamId, stream);
        if (this.creditsProgress(event.run))
          this.progress.toolStarted(event.toolCallId, event.name);
        // Record the tool call in the active message stream's content IN ORDER, so
        // a mid-turn reconnect overlay renders it at its true position (the tool
        // stream above supplies live output, merged by id in the projection).
        const active = [...this.streaming.values()].find(
          (s): s is StreamingMessageEntry => s.kind === "message",
        );
        if (active)
          active.content.push({
            type: "toolCall",
            toolCallId: event.toolCallId,
            name: event.name,
            input: event.input,
          });
        this.emit({
          type: "toolStarted",
          streamId: event.streamId,
          toolCallId: event.toolCallId,
          name: event.name,
          input: event.input,
        });
        return;
      }
      case "toolUpdated": {
        const stream = this.streaming.get(event.streamId);
        if (stream && stream.kind === "tool") stream.output = event.output;
        if (this.creditsProgress(event.run))
          this.progress.toolActivity(event.streamId);
        this.emit({
          type: "toolUpdated",
          streamId: event.streamId,
          output: event.output,
        });
        return;
      }
      case "toolCompleted": {
        // Usually reported live already (the `toolEnd` passthrough below);
        // the tracker ignores a tool that is no longer running.
        if (this.creditsProgress(event.run))
          this.progress.toolEnded(event.toolCallId, event.isError === true);
        this.streaming.delete(event.streamId);
        this.emit({ type: "toolCompleted", streamId: event.streamId });
        const raw = this.log.append({
          type: "message",
          role: "toolResult",
          toolCallId: event.toolCallId,
          ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
          content: event.content,
          ...(event.isError !== undefined ? { isError: event.isError } : {}),
          ...(event.resultDiff !== undefined
            ? { resultDiff: event.resultDiff }
            : {}),
          ...(event.providerMessageId !== undefined
            ? { providerMessageId: event.providerMessageId }
            : {}),
        } as LogEntryDraft) as ConversationRawEntry;
        this.emit({ type: "entryAppended", entry: projectForClient(raw) });
        return;
      }
      case "promptAccepted": {
        // Bind the trailing unbound user entry to its native id (bookkeeping only).
        const unbound = this.log.trailingUnboundUserEntry();
        if (unbound)
          this.log.bindUserEntry(unbound.id, event.providerMessageId);
        return;
      }
      case "entriesBound": {
        // Bind the turn that just completed against the provider's post-turn scan.
        // The scan reports the provider's WHOLE transcript, so the boundary this
        // turn opened at — where it started, and which prompts the provider
        // accepted into it — is what keeps the reconciliation to that turn
        // instead of backfilling or mis-pairing the session's history.
        this.log.bindScannedEntries(event.entries, {
          fromSeq: this.turnStartSeq,
          promptEntryIds: this.turnPromptEntryIds,
        });
        return;
      }
      case "runFailing":
        // The harness is about to tell its viewers; the failure comes first.
        if (!this.isStaleRun(event.run, event.unowned))
          this.reportRunFailure(
            this.openRunId(),
            event.errorMessage,
            event.failure,
          );
        return;
      case "runCompleted": {
        // A straggler of a run that is already over neither fails nor ends
        // the turn open now.
        if (this.isStaleRun(event.run, event.unowned)) return;
        if (event.run !== undefined)
          this.lastClosedProviderRun = Math.max(
            this.lastClosedProviderRun,
            event.run,
          );
        // Ahead of everything this completion writes or tells anyone. A run
        // ended on an abort someone asked for keeps an error only as context.
        if (event.stopReason === "error" && !event.abortRequested)
          this.reportRunFailure(
            this.openRunId(),
            event.errorMessage,
            event.failure,
          );
        // Clear any streams the provider left dangling on a failed/aborted run.
        if (event.stopReason !== "end") {
          this.streaming.clear();
          this.emit({
            type: "runStatus",
            status: event.stopReason,
            ...(event.errorMessage ? { message: event.errorMessage } : {}),
          });
        }
        // Adapter-observed completion is the authoritative end for out-of-band
        // turns; prompt()'s finally also calls this, so the normal path remains
        // idempotent. This is the only end that knows HOW the run stopped.
        const origin = this.turnOrigin;
        this.endTurn(
          event.stopReason,
          undefined,
          event.abortRequested === true,
        );
        this.setRunning(false);
        emitRunCompleted(this.sessionId, event.stopReason, origin);
        return;
      }
      case "passthrough": {
        // Transport-only: forward the verbatim host-command card envelope. A
        // live toolEnd is also the only evidence that a tool completed before
        // the adapter flushes the durable toolResult entry at messageCompleted.
        // Mirror that completion into the transient stream so reconnect/session
        // switch snapshots do not resurrect a completed tool as running.
        if (event.envelope.type === "toolEnd") {
          const stream = this.streaming.get(event.envelope.toolId);
          if (stream && stream.kind === "tool") {
            stream.output = event.envelope.output;
            stream.isError = event.envelope.isError;
            stream.done = true;
          }
          if (this.creditsProgress(event.run))
            this.progress.toolEnded(
              event.envelope.toolId,
              event.envelope.isError,
            );
          emitToolCompleted(this.sessionId);
        }
        this.emit({ type: "passthrough", envelope: event.envelope });
        return;
      }
      case "providerActivity":
        if (!this.creditsProgress(event.run)) return;
        if (event.kind === "output") this.progress.modelOutput();
        else if (event.kind === "response") this.progress.responseStarted();
        else this.progress.activity();
        return;
      case "providerRetry":
        if (!this.creditsProgress(event.run)) return;
        this.progress.retry({
          attempt: event.attempt,
          ...(event.maxAttempts !== undefined
            ? { maxAttempts: event.maxAttempts }
            : {}),
          ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
          ...(event.status !== undefined ? { status: event.status } : {}),
        });
        return;
      case "providerNotice": {
        const raw = this.log.append({
          type: "provider.notice",
          severity: event.severity,
          message: event.message,
          providerError: event.providerError,
          ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
          ...(event.maxAttempts !== undefined
            ? { maxAttempts: event.maxAttempts }
            : {}),
          ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
          ...(event.phase !== undefined ? { phase: event.phase } : {}),
          ...(event.requestBytes !== undefined
            ? { requestBytes: event.requestBytes }
            : {}),
        } as LogEntryDraft) as ProviderNoticeEntry;
        this.emit({
          type: "entryAppended",
          entry: projectProviderNoticeForClient(raw),
        });
        return;
      }
      case "hostCommandDiscarded": {
        // A skipped phase (`/pr` clean commit/up-to-date push) leaves no card or
        // wrapper tool turn in the durable conversation, but it still closes
        // the boundary opened by the observed messageStarted event.
        this.streaming.clear();
        this.endTurn();
        this.setRunning(false);
        return;
      }
      case "hostCommandResult": {
        // A synthetic host-command turn finished. Drop any transient streams it
        // opened (the wrapper assistant/tool turn) WITHOUT persisting them, then
        // append the single durable card entry + emit it for the reconnect path.
        this.streaming.clear();
        const raw = this.log.append({
          type: "command.result",
          commandId: `cmd-${event.card.id}`,
          name: event.name,
          card: event.card,
        } as LogEntryDraft) as HostCommandResultEntry;
        this.emit({
          type: "hostCommandAppended",
          entry: projectHostCommandForClient(raw),
        });
        // Host-command synthetic turns end with hostCommandResult instead of a
        // provider runCompleted event. Close the boundary so the next provider
        // run opens its own origin, baseline and durable run marker.
        this.endTurn();
        this.setRunning(false);
        return;
      }
      case "sessionConfigChanged": {
        this.config = {
          ...this.config,
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.reasoning !== undefined
            ? { reasoning: event.reasoning }
            : {}),
        };
        this.emit({
          type: "sessionConfigChanged",
          config: this.snapshotConfig(),
        });
        return;
      }
    }
  }

  /* --------------------------- outward feed ------------------------------ */

  /** Whether an event of provider run `run` may move the current progress. */
  private creditsProgress(run: ProviderRunId | undefined): boolean {
    return run !== undefined && run === this.progressRun;
  }

  /** Add a subscriber. Returns an unsubscribe fn. Pair with {@link getSnapshot} via the runtime. */
  subscribe(listener: RuntimeEventListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Current snapshot: durable client entries + run state + in-flight streams. */
  getSnapshot(): SessionSnapshot {
    const progress = this.progress.snapshot();
    return {
      sessionId: this.sessionId,
      runState: this.runState,
      entries: this.log.clientEntries(),
      streaming: [...this.streaming.values()],
      ...(progress ? { progress } : {}),
    };
  }

  /** What the running run has been observed doing; undefined when idle. */
  runProgress(): RunProgress | undefined {
    return this.progress.snapshot();
  }

  /** The full client timeline (conversation + host-command cards) for the transport projection. */
  clientTimeline(opts: { lazyBodies?: boolean } = {}): ClientTimelineEntry[] {
    return this.log.clientTimeline(opts);
  }

  /** The snapshot projection: full rows only where they are used — see the log. */
  clientTimelineForSnapshot(cachedFrom?: number): {
    timeline: ClientTimelineEntry[];
    contentFromRow: number;
  } {
    return this.log.clientTimelineForSnapshot(cachedFrom);
  }

  /** The lazily-projected rows one appended entry touches, for a live `timelineDelta`. */
  clientTimelineDelta(entryId: string): ClientTimelineEntry[] {
    return this.log.clientTimelineDelta(entryId);
  }

  /** One in-flight stream by id — the authoritative live body a viewer subscribes to. */
  liveStream(streamId: string): StreamingEntry | undefined {
    return this.streaming.get(streamId);
  }

  loadTimelineBlock(
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ): unknown {
    return this.log.loadTimelineBlock(entryId, blockIndex, kind);
  }

  /** The entries before `beforeSeq` for a windowed transcript's "load earlier". */
  loadTimelineRange(
    beforeSeq: number,
    limit?: number,
  ): TimelineRangeResult | undefined {
    return this.log.clientTimelineRange(beforeSeq, limit);
  }

  /** The in-flight transient streams (the transport overlays these on the timeline). */
  streamingEntries(): StreamingEntry[] {
    return [...this.streaming.values()];
  }

  /** Normalized stats (message/tool counts + token/cost usage + live estimate). */
  contextInfo(opts: StatsOptions = {}): ContextInfo {
    return contextInfoFromSnapshot(this.getSnapshot(), opts);
  }

  /** Best-effort outward delivery — a throwing subscriber is isolated and never corrupts state. */
  private emit(event: RuntimeEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // isolate a faulty transport consumer
      }
    }
  }

  /* ------------------------------ config --------------------------------- */

  private snapshotConfig(): SessionConfig {
    return {
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.reasoning ? { reasoning: this.config.reasoning } : {}),
      ...(this.availableModels
        ? { availableModels: this.availableModels }
        : {}),
    };
  }

  /** Resolve the session config, listing models via the adapter once (memoized). */
  async getConfig(): Promise<SessionConfig> {
    if (this.availableModels === undefined && this.adapter.listModels) {
      try {
        this.availableModels = await this.adapter.listModels();
      } catch {
        this.availableModels = []; // degrade gracefully — picker just has no catalog
      }
    }
    return this.snapshotConfig();
  }

  async setModel(model: SessionConfigModel): Promise<void> {
    await this.adapter.setModel(model);
    this.config = { ...this.config, model };
    this.emit({ type: "sessionConfigChanged", config: this.snapshotConfig() });
  }

  async setReasoning(level: string): Promise<void> {
    await this.adapter.setReasoning(level);
    this.config = { ...this.config, reasoning: level };
    this.emit({ type: "sessionConfigChanged", config: this.snapshotConfig() });
  }

  /* ----------------------------- lifecycle ------------------------------- */

  /**
   * The session is going away — deleted, or its harness released — while its
   * provider may still be mid-turn. Called BEFORE anything stops observing it
   * (the harness store's own dispose, the runtime's unsubscribe), because
   * after that no completion can arrive to say how the run ended.
   *
   * An open run closes here as an end someone ASKED for: its opener and every
   * {@link subscribeSessionRunEnded} listener hear it once, and a failure the
   * run already reported keeps it a failure. A prompt still waiting on the
   * provider stops waiting, no new prompt is taken, and the idle edge offers
   * no queued work to a session that is leaving. Idempotent.
   */
  endForTeardown(): void {
    if (this.tornDown) return;
    this.tornDown = true;
    if (this.turnOpen) {
      this.streaming.clear();
      this.endTurn(this.turnFailed ? "error" : "aborted", undefined, true);
    }
    this.setRunning(false);
    for (const wake of [...this.teardownWaiters]) wake();
    this.teardownWaiters.clear();
  }

  /** `work`'s answer, or `onTeardown` if the session is torn down first. */
  private untilTeardown(
    work: Promise<AgentRunResult>,
    onTeardown: AgentRunResult,
  ): Promise<AgentRunResult> {
    let wake: () => void = () => {};
    const torn = new Promise<AgentRunResult>((resolve) => {
      wake = () => resolve(onTeardown);
    });
    this.teardownWaiters.add(wake);
    return Promise.race([work, torn]).finally(() =>
      this.teardownWaiters.delete(wake),
    );
  }

  dispose(): void | Promise<void> {
    if (this.disposed) return;
    this.endForTeardown();
    this.disposed = true;
    this.progress.dispose();
    this.unsubscribeAdapter();
    this.subscribers.clear();
    this.streaming.clear();
    return this.adapter.dispose();
  }
}

/** Append a delta to the in-flight content, merging into a trailing same-kind block. */
function appendDelta(
  content: AgentContentBlock[],
  kind: "text" | "thinking",
  text: string,
): void {
  const last = content[content.length - 1];
  if (last && last.type === kind) last.text += text;
  else content.push({ type: kind, text });
}
