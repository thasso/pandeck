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
  RunFailedError,
  SessionBusyError,
  SteerNotTakenError,
  SteerWithdrawnError,
} from "./errors.ts";
import type { RuntimeEvent, RuntimeEventListener } from "./events.ts";

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
  /** Sanitized peer-prompt card recorded on the durable user entry for rendering. */
  peerPrompt?: import("@assistant/shared").PeerPromptCard;
  /** Durable admission keys for every peer message combined into this entry (server-only). */
  peerMessageIds?: string[];
}

/** What a human-origin prompt was, for consumers that treat kinds differently. */
export interface HumanPromptSignal {
  /**
   * A durable-but-not-rendered prompt (rebuild/fork provenance). It still resets
   * peer chains, but it is not the user speaking, so it is no evidence of the
   * user taking a session over.
   */
  hidden: boolean;
}

/**
 * Notified when a human-origin prompt is appended to a session, so peer-prompt
 * loop chains can reset (Task 105) and a spawned child can record that the user
 * took it over (Task 637). Fires only after the durable user entry exists, and
 * only for the seam BOTH harnesses prompt through — a rejected or deduplicated
 * send appends nothing and never reaches it. Registered at boot; kept as a seam
 * so the runtime layer does not depend on the peer-prompt engine.
 */
let humanPromptHook:
  ((sessionId: string, signal: HumanPromptSignal) => void) | undefined;
export function setHumanPromptHook(
  fn: ((sessionId: string, signal: HumanPromptSignal) => void) | undefined,
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
  /**
   * Why the open turn is running. A visible human steer takes precedence over
   * its earlier trigger: once the user joins a turn, its result is theirs.
   */
  private turnOrigin: PromptOrigin | undefined;
  /** Provenance waiting for the next provider-initiated assistant entry. */
  private pendingAssistantOrigin: PromptOrigin | undefined;

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
   * `turnOpen` guard is what keeps the closing marker single when both fire.
   */
  private endTurn(outcome: "ended" | "aborted" = "ended"): void {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const runId = this.turnRunId;
    this.turnRunId = undefined;
    if (runId)
      this.log.append({
        type: outcome === "aborted" ? "run.aborted" : "run.ended",
        runId,
      });
  }

  /* ------------------------------ run state ------------------------------ */

  get isRunning(): boolean {
    return this.runState === "running";
  }

  private setRunning(running: boolean): void {
    const next: SnapshotRunState = running ? "running" : "idle";
    if (this.runState === next) return;
    this.runState = next;
    this.emit({ type: "runStateChanged", runState: next });
    // A running→idle transition is the browser-independent trigger to drain any
    // peer prompts queued behind this turn, whatever drove it.
    if (next === "idle") {
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
      peerPrompt: _peerPrompt,
      peerMessageIds: _peerMessageIds,
      ...adapterOpts
    } = options;
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
      const record = (delivery: PromptDelivery): void => {
        if (recorded) return;
        recorded = true;
        const entryId = this.appendUserEntry(text, options, delivery);
        if (onUserEntry) onUserEntry(entryId);
        if (this.turnOpen) this.turnPromptEntryIds.add(entryId);
      };
      let result: AgentRunResult;
      try {
        result = await this.adapter.prompt(modelText, {
          ...(clientRequestId !== undefined ? { clientRequestId } : {}),
          ...adapterOpts,
          steer: true,
          onSteerAccepted: record,
        });
      } catch (error) {
        if (!recorded) releaseKey();
        throw error;
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
        throw result.steerWithdrawn
          ? new SteerWithdrawnError(
              this.sessionId,
              result.steerUncertain === true,
            )
          : new SessionBusyError(this.sessionId);
      }
      return;
    }

    // The durable app log + client projection get ONLY the clean human text;
    // model-only memory and structured context are prepended only to provider
    // input so the visible transcript never presents them as user-authored.
    this.beginTurn(turnOrigin);
    const entryId = this.appendUserEntry(
      text,
      options,
      steering ? "steer" : undefined,
    );
    if (onUserEntry) onUserEntry(entryId);

    if (steering) {
      // Only a steering prompt the provider TOOK belongs to the running turn:
      // this call rejects (or reports an error) when it did not, and the durable
      // entry then stays out of the turn's prompt set so no post-turn scan can
      // pair it with a native prompt that belongs to an earlier turn.
      const result = await this.adapter.prompt(modelText, {
        ...(clientRequestId !== undefined ? { clientRequestId } : {}),
        ...adapterOpts,
        steer: true,
      });
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
    this.setRunning(true);
    try {
      const result = await this.adapter.prompt(modelText, {
        ...(clientRequestId !== undefined ? { clientRequestId } : {}),
        ...adapterOpts,
      });
      if (result.stopReason === "error") {
        throw new RunFailedError(
          result.errorMessage ?? "Unknown provider error",
          result.code,
        );
      }
    } finally {
      this.endTurn();
      this.setRunning(false);
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
    // A real human turn resets peer-prompt loop chains for this session, and a
    // VISIBLE one is also the user taking a spawned child over.
    const promptOrigin = origin ?? { kind: "human" as const };
    this.noteTurnOrigin(promptOrigin, options.hidden === true);
    if (promptOrigin.kind === "human")
      humanPromptHook?.(this.sessionId, { hidden: options.hidden === true });
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
    return this.adapter.abort();
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
        this.setRunning(true);
        const stream: StreamingMessageEntry = {
          streamId: event.streamId,
          kind: "message",
          role: "assistant",
          content: [],
        };
        this.streaming.set(event.streamId, stream);
        this.emit({ type: "messageStarted", streamId: event.streamId });
        return;
      }
      case "messageDelta": {
        const stream = this.streaming.get(event.streamId);
        if (stream && stream.kind === "message")
          appendDelta(stream.content, event.delta.kind, event.delta.text);
        this.emit({
          type: "messageDelta",
          streamId: event.streamId,
          delta: event.delta,
        });
        return;
      }
      case "messageCompleted": {
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
        this.emit({
          type: "toolUpdated",
          streamId: event.streamId,
          output: event.output,
        });
        return;
      }
      case "toolCompleted": {
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
      case "runCompleted": {
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
        this.endTurn(event.stopReason === "aborted" ? "aborted" : "ended");
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
          emitToolCompleted(this.sessionId);
        }
        this.emit({ type: "passthrough", envelope: event.envelope });
        return;
      }
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

  /** Add a subscriber. Returns an unsubscribe fn. Pair with {@link getSnapshot} via the runtime. */
  subscribe(listener: RuntimeEventListener): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Current snapshot: durable client entries + run state + in-flight streams. */
  getSnapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      runState: this.runState,
      entries: this.log.clientEntries(),
      streaming: [...this.streaming.values()],
    };
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

  dispose(): void | Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
