/**
 * The pi-backed live session: one long-lived pi agent run decoupled from any
 * socket, with its event mapping, synthetic tool turns, accept flows, and
 * snapshot/state projections. Extracted from hub.ts; the few hub callbacks it
 * needs are inverted behind {@link HarnessHost}, so this module must never
 * import hub.ts.
 */
import type {
  AgentSessionEvent,
  CompactionResult,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentType,
  DisplayAttachment,
  DisplayBlock,
  ContextInfo,
  DisplayMessage,
  Harness,
  ModelOption,
  NoticeSeverity,
  PromptAttachment,
  ProviderErrorInfo,
  ServerMessage,
  SessionMode,
  SessionNamingSettings,
  ThinkingLevel,
} from "@assistant/shared";
import { UNLABELED_SESSION_TITLE } from "@assistant/shared";
import {
  piSkillCommandName,
  type SkillInvocationCommand,
  type SkillInvocationToolCall,
  type SkillInvocationTranscript,
} from "../skills/skillInvocations.ts";
import { piSkillDispatch } from "./skillDispatch.ts";
import type { AgentUsage } from "@assistant/shared/session";
import { CWD } from "../config.ts";
import { resetMemorySessionContext } from "../memory/memoryRuntime.ts";
import { memoryScheduler } from "../memory/memoryScheduler.ts";
import { buildModelPromptWithAttachments } from "../promptAttachments.ts";
import { findModel, toModelOption, type PiModel } from "./models.ts";
import {
  providerErrorDisplayText,
  runFailureFacts,
  shouldSuppressProviderRetry,
} from "../providerErrors.ts";
import {
  providerTransportDetails,
  unexpectedProviderAbortError,
} from "./providerDiagnostics.ts";
import {
  type AnyMessage,
  formatToolResult,
  serializeSessionBranch,
  toolResultDisplayDiff,
} from "../serialize.ts";
import { deriveTitle, type LiveListInfo } from "../sessions.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { assertSessionAccountSwitch } from "../sessionAccount.ts";
import { activeSkillsForSession } from "../sessionSkills.ts";
import type {
  CompactionWindowApplyResult,
  CompactionWindowHarnessStatus,
  CompactionWindowLowerResult,
  HarnessHost,
  SessionNativeFacts,
  LiveSession,
  Viewer,
} from "../harness.ts";
import {
  piProviderErrorInfo,
  terminalAssistantError,
  type PiEngineHandle,
  type PiEngineModel,
  type PiTranscriptView,
} from "./piEngine.ts";
import { SessionResidency } from "../sessionKit/residency.ts";
import {
  discardHostCommandTurn,
  finishHostCommandCard,
  finishHostCommandTool,
  hostCommandTurn,
  openHostCommandTurn,
  updateHostCommandTool,
  type HostCommandResult,
  type HostCommandTurnTarget,
} from "../sessionKit/hostCommandTurn.ts";
import type {
  HostClearOutcome,
  HostCompactionOutcome,
} from "../hostSlashCommands.ts";
import {
  createPiAdapter,
  type PiDriver,
  type PiPromptResponse,
} from "../session/adapters/pi.ts";
import type { PromptableAdapter } from "../session/adapters/contract.ts";
import {
  appendText,
  estimateTokens,
  updateTool,
} from "../session/runtime/liveBlocks.ts";
import {
  NativeAdapterEventSource,
  perTurnUsage,
  type AdapterEventListener,
  type CumulativeUsageTotals,
} from "../session/adapters/nativeEvents.ts";
import {
  hasPendingAgentQuestion,
  QUESTION_ANSWERS_MARKER,
  subscribeAgentQuestionChanges,
} from "../tools/core/questionTool.ts";
import { getSettings } from "../settings.ts";
import {
  fallbackSessionTitle,
  generateSessionTitle,
} from "../sessionNaming.ts";
import { acceptCommitDryRun, toCommitDisplay } from "../commitWorkflow.ts";
import { isForkAutoRenamePending, readForkOrigin } from "./forkOrigin.ts";
import { toolLoadingForSession } from "./toolActivation.ts";
import { restorePiLiveTitle, shouldAutoNamePiSession } from "./titleState.ts";
import {
  hasPendingApproval,
  subscribePendingApprovalChanges,
  withApprovalBlocks,
} from "../pendingApprovals.ts";
import {
  hasChoosingTaskCard,
  subscribeChoosingTaskCardChanges,
  withPullRequestCardBlocks,
} from "../pullRequestCards.ts";
import { sessionProjectContextInfo } from "../sessionProjectContext.ts";
import { closeToolGroupSession } from "../mcp/toolGroups/registry.ts";
import { errorText } from "../errors.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";
import { assertAccountRecoveryAdmission } from "../session/runtime/accountRecoveryAdmission.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { sessionCheckoutSide } from "../workers/placement.ts";

const RELOAD_QUEUED_MESSAGE =
  "A server restart is queued to apply code changes. Please wait for the reconnect before starting another run.";

/** Drop messages that carry a hide marker (e.g. a question-answers resume prompt). */
function hideMarkedMessages(messages: DisplayMessage[]): DisplayMessage[] {
  return messages.filter(
    (m) =>
      !(
        m.role === "user" &&
        m.blocks.some(
          (b) => b.kind === "text" && b.text.includes(QUESTION_ANSWERS_MARKER),
        )
      ),
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (c): c is { type: string; text: string } =>
        Boolean(c) &&
        typeof c === "object" &&
        (c as { type?: unknown }).type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text)
    .join("\n");
}

function forkTitleContext(sm: Pick<PiTranscriptView, "getBranch">): string {
  const entries = sm.getBranch() as Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }>;
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextContent(message.content).trim();
    if (!text) continue;
    lines.push(`${role}: ${text}`);
  }
  const context = lines.slice(-8).join("\n\n");
  return context.length > 6000 ? `…${context.slice(-6000)}` : context;
}

/* -------------------------------- helpers -------------------------------- */

function attachmentDisplay(a: PromptAttachment): DisplayAttachment {
  return {
    id: a.id,
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    ...(a.mimeType.startsWith("image/") ? { data: a.data } : {}),
    ...(a.role !== undefined ? { role: a.role } : {}),
  };
}

/**
 * One long-lived agent run, decoupled from any socket. Multiple {@link Viewer}s
 * (browser tabs) can attach; events are broadcast to all of them, and an
 * atomic {@link snapshot} lets a (re)connecting viewer catch up with no data
 * loss. The underlying engine keeps running across detach so a run survives a
 * tab close or reconnect.
 */
/** A replacement engine prepared without changing the live wrapper or its tools. */
export interface PiAccountSession {
  engine: PiEngineHandle;
  /** Publish its tools; called in the swap's own synchronous span. */
  commit(): Promise<void>;
  dispose(): Promise<void>;
}

export class PiLiveSession implements LiveSession {
  readonly live = true;
  readonly key: string;
  /** Viewers and the idle clock; a prompt admitted but not yet running is activity too. */
  private readonly residency = new SessionResidency(
    () => !this.running && !sessionRuntime.isBusy(this.key),
  );
  private unsubscribe: () => void;
  private unsubscribeQuestions: () => void;
  private unsubscribeApprovals: () => void = () => {};
  private unsubscribeTaskChoices: () => void = () => {};
  private readonly adapterEvents = new NativeAdapterEventSource();
  /** id of the assistant turn currently streaming (one per agent run). */
  private currentAssistantId: string | undefined;
  /** The in-flight assistant turn, rebuilt from deltas so attach can replay it. */
  private liveTurn: DisplayMessage | undefined;
  /** Tool id for a slash-command run rendered through the normal tool UI. */
  private syntheticToolId: string | undefined;
  /** Provider/agent terminal error captured from the final assistant message. */
  private currentAssistantError: string | undefined;
  private currentAssistantErrorInfo: ProviderErrorInfo | undefined;
  private currentAssistantAborted = false;
  /** A retry attempt was persisted, but pi still owns the enclosing run. */
  private awaitingRetryContinuation = false;
  private retryAttemptError: string | undefined;
  /** True only when the browser/runtime explicitly asked this harness to stop. */
  private explicitAbortRequested = false;
  /** Transport detail from the failed message that initiated the current retry chain. */
  private providerTransportFailure: {
    phase?: string;
    requestBytes?: number;
  } = {};
  /**
   * Cumulative session totals sampled at `agent_start`, so the completed turn's
   * durable usage is THIS run's delta (pi only exposes session-cumulative stats).
   */
  private turnStartTotals: CumulativeUsageTotals | undefined;
  private idCounter = 0;
  /** Set once disposed: nothing may drive this instance again. */
  private disposed = false;
  private lastContextBroadcastAt = 0;
  /** clientRequestIds already handled, for prompt idempotency (in-memory). */
  private readonly handledRequestIds = new Set<string>();
  /**
   * Whether an agent run is active. Tracked explicitly rather than read from
   * `session.isStreaming`, which stays true throughout the `agent_end` handler
   * (it only settles afterwards) and so can't tell "running" from "just ended".
   */
  private running = false;
  /** A continuation was handed to the engine and has not reported back yet. */
  private continuing = false;
  private driveCompletion: Promise<unknown> | undefined;
  /** Mode operations run one at a time; each link continues past a failure. */
  private modeOperations: Promise<void> = Promise.resolve();

  /** The only way this wrapper reaches its pi engine (`piEngine.ts`). */
  get engine(): PiEngineHandle {
    return this.currentEngine;
  }

  get credentialProfileId(): string | undefined {
    return this.profileId;
  }

  /** Live title; a new conversation uses the stable placeholder until naming settles. */
  title: string | undefined;
  /** True only while the dedicated naming agent is running. */
  private titleGenerationPending = false;
  /** Newest in-memory activity, so a not-yet-persisted session can sort/appear. */
  updatedAt = 0;

  constructor(
    readonly kind: AgentType,
    private currentEngine: PiEngineHandle,
    private readonly host: HarnessHost,
    private readonly onEvict: (key: string) => void,
    private initialNotices: Array<{
      severity: NoticeSeverity;
      message: string;
    }> = [],
    /** Where this session executes: its worktree path, else the app CWD. */
    readonly cwd: string = CWD,
    private mode: SessionMode = "build",
    private readonly onModeChange: (
      mode: SessionMode,
    ) => void | Promise<void> = () => {},
    /** The account the session runs on; its model resolves in that registry. */
    private profileId: string | undefined = undefined,
    private readonly reopenForAccount?: (
      profileId: string,
    ) => Promise<PiAccountSession>,
  ) {
    const engine = currentEngine;
    this.key = engine.sessionId;
    // Registered by its store (`track`) as soon as it is built.
    this.residency.hold(() => {
      this.dispose();
      this.onEvict(this.key);
      return true;
    });
    this.unsubscribe = engine.subscribe((event) => this.onAgentEvent(event));
    this.unsubscribeQuestions = subscribeAgentQuestionChanges((sessionId) => {
      if (sessionId !== this.engine.sessionId) return;
      this.broadcastState();
    });
    this.unsubscribeApprovals = subscribePendingApprovalChanges((sessionId) => {
      if (sessionId !== this.engine.sessionId) return;
      this.broadcastState();
    });
    this.unsubscribeTaskChoices = subscribeChoosingTaskCardChanges(
      (sessionId) => {
        if (sessionId !== this.engine.sessionId) return;
        this.broadcastState();
      },
    );
    // Hydrate the app-side title from durable native/session-index state before
    // the first registry sync. Reopened sessions start with a fresh PiLiveSession
    // wrapper, so leaving this.title undefined would let the next prompt become
    // the live title and then get persisted back into the session index.
    this.title = restorePiLiveTitle(
      this.engine.sessionName,
      sessionStore.get(this.engine.sessionId)?.title,
    );
    // Registry sync: record a clean per-session metadata entry. Covers every pi
    // create path (acquireNew / acquireExisting / fork all run through track →
    // the constructor).
    this.syncRegistry();
  }

  get sessionId(): string {
    return this.engine.sessionId;
  }

  /** Our session id (= the pi session id; pi sessions are not re-id'd). */
  get id(): string {
    return this.engine.sessionId;
  }

  /** Which engine runs this session — pi, for every {@link PiLiveSession}. */
  get harness(): Harness {
    return "pi";
  }

  /** The persona/toolset this session emulates, derived from its pi kind. */
  get agentType(): AgentType {
    return this.kind;
  }

  /**
   * Write/refresh this pi session's metadata row. For pi our id IS the provider
   * session id, and the log path is derived from the id (never stored). Only
   * meaningful once the session has messages. Best-effort — a metadata-store
   * hiccup must never affect the run.
   */
  private syncRegistry(): void {
    try {
      const stats = this.engine.stats();
      if (stats.totalMessages === 0) return;
      const model = this.engine.model as unknown as PiModel | undefined;
      const thinkingLevelValue = this.engine.thinkingLevel as
        string | undefined;
      sessionStore.upsert({
        id: this.engine.sessionId,
        harness: "pi",
        agentType: this.kind,
        ...(model?.provider !== undefined ? { provider: model?.provider } : {}),
        providerSessionId: this.engine.sessionId,
        ...(model?.id !== undefined ? { model: model?.id } : {}),
        ...(thinkingLevelValue !== undefined
          ? { thinkingLevel: thinkingLevelValue }
          : {}),
        mode: this.mode,
        title: this.title ?? this.engine.sessionName ?? "New session",
        createdAt: Date.now(),
        // Only real in-memory activity (prompts, turns, renames) may advance
        // updatedAt. Opening/restoring a session (constructor sync) passes
        // undefined so the stored value is preserved and viewing never bumps
        // the session in the list.
        ...(this.updatedAt ? { updatedAt: this.updatedAt } : {}),
        messageCount: stats.totalMessages,
      });
    } catch {
      // Best-effort metadata write; never break a run on store trouble.
    }
  }

  get sessionFile(): string | undefined {
    return this.engine.sessionFile;
  }

  /** The live title, else the name pi itself gave the session. */
  get sessionTitle(): string | undefined {
    return this.title ?? this.engine.sessionName;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get canSteer(): boolean {
    return true;
  }

  /* --------------------------------- views --------------------------------- */

  get viewers(): ReadonlySet<Viewer> {
    return this.residency.viewers;
  }

  addViewer(v: Viewer): void {
    this.residency.addViewer(v);
    if (this.initialNotices.length) {
      // Let the caller send ready/state/history first, then show creation diagnostics.
      setTimeout(() => this.flushInitialNotices(), 0);
    }
  }

  private flushInitialNotices(): void {
    if (!this.initialNotices.length || this.viewers.size === 0) return;
    for (const notice of this.initialNotices)
      this.notice(notice.severity, notice.message);
    this.initialNotices = [];
  }

  removeViewer(v: Viewer): void {
    this.residency.removeViewer(v);
  }

  /**
   * Start the idle clock if nobody views the session, as a viewer's departure
   * would; a run in progress when it runs out restarts it rather than releasing
   * the session. The store calls this when it registers a session, so one
   * acquired for a load that was superseded (or a socket that closed) before it
   * could be viewed is evicted like any other idle session instead of staying
   * resident for the process lifetime. It calls it again on every acquisition
   * of a resident session, so a caller about to drive it gets a full grace.
   */
  armIdleIfUnviewed(): void {
    this.residency.arm();
  }

  /** Disposed — idled out or removed — so the prompt door refuses it. */
  get released(): boolean {
    return this.disposed;
  }

  broadcastState(): void {
    if (this.viewers.size === 0) return;
    this.broadcast({
      type: "state",
      state: this.host.buildSessionState(this.sessionId, this.nativeFacts()),
    });
  }

  broadcast(message: ServerMessage): void {
    this.residency.broadcast(message);
  }

  subscribeAdapterEvents(listener: AdapterEventListener): () => void {
    return this.adapterEvents.subscribe(listener);
  }

  private notice(severity: NoticeSeverity, message: string): void {
    if (severity === "error") console.error(message);
    else if (severity === "warning") console.warn(message);
    this.broadcast({ type: "notice", severity, message });
  }

  private providerNotice(
    severity: "warning" | "error",
    message: string,
    providerError: ProviderErrorInfo,
    details: {
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      phase?: string;
      requestBytes?: number;
    } = {},
  ): void {
    // Deliberately NOT broadcast as a `notice`: a provider retry is session
    // state, and the durable `provider.notice` entry appended below is already
    // projected into that session's transcript (`docs/messaging.md`). The
    // ephemeral copy only ever reached the same viewers, one row above.
    if (severity === "error") console.error(message);
    else console.warn(message);
    this.adapterEvents.providerNotice({
      type: "providerNotice",
      severity,
      message,
      providerError,
      ...details,
    });
  }

  private providerErrorInfo(
    error: string,
    message?: unknown,
  ): ProviderErrorInfo {
    return piProviderErrorInfo(this.engine.model, error, message);
  }

  private broadcastContextInfo(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastContextBroadcastAt < 250) return;
    this.lastContextBroadcastAt = now;
    this.broadcast({
      type: "contextInfo",
      sessionId: this.engine.sessionId,
      info: this.contextInfo(),
    });
  }

  /* --------------------------------- events -------------------------------- */

  private onAgentEvent(event: AgentSessionEvent): void {
    const sessionId = this.engine.sessionId;
    switch (event.type) {
      case "agent_start": {
        this.residency.cancel();
        this.running = true;
        const continuingRun =
          Boolean(this.currentAssistantId) || this.awaitingRetryContinuation;
        if (!continuingRun) this.host.noteRunStarted();
        if (!this.currentAssistantId) {
          this.currentAssistantId = `a${++this.idCounter}`;
          this.turnStartTotals = this.cumulativeTotals();
          this.liveTurn = {
            id: this.currentAssistantId,
            role: "assistant",
            blocks: [],
            streaming: true,
          };
          this.broadcast({
            type: "assistantStart",
            sessionId,
            id: this.currentAssistantId,
          });
          this.adapterEvents.messageStarted(this.currentAssistantId);
        }
        this.awaitingRetryContinuation = false;
        this.retryAttemptError = undefined;
        this.currentAssistantError = undefined;
        this.currentAssistantErrorInfo = undefined;
        this.currentAssistantAborted = false;
        this.explicitAbortRequested = false;
        this.providerTransportFailure = {};
        this.broadcastContextInfo(true);
        // Surface the running indicator in every tab's sidebar.
        this.host.sessionRowsChanged([this.key]);
        break;
      }
      case "message_update": {
        const id = this.currentAssistantId;
        if (!id || !this.liveTurn) break;
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          appendText(this.liveTurn.blocks, "text", ev.delta);
          this.broadcast({ type: "textDelta", sessionId, id, delta: ev.delta });
          this.adapterEvents.messageDelta(id, "text", ev.delta);
          this.broadcastContextInfo();
        } else if (ev.type === "thinking_delta") {
          appendText(this.liveTurn.blocks, "thinking", ev.delta);
          this.broadcast({
            type: "thinkingDelta",
            sessionId,
            id,
            delta: ev.delta,
          });
          this.adapterEvents.messageDelta(id, "thinking", ev.delta);
          this.broadcastContextInfo();
        } else if (
          ev.type === "toolcall_start" ||
          ev.type === "toolcall_delta"
        ) {
          // A tool call chosen and its arguments being written: output, with
          // no delta event of its own.
          this.adapterEvents.providerActivity("output");
        } else if (ev.type === "start") {
          this.adapterEvents.providerActivity("response");
        } else if (ev.type !== "error") {
          // Block starts and ends, `done`: the provider is alive, but nothing
          // here is output — an empty response must not read as one.
          this.adapterEvents.providerActivity("lifecycle");
        }
        break;
      }
      case "message_end": {
        // The SDK persists this message synchronously after delivering the
        // callback. Report within that span, before the next native step.
        this.host.sessionRowsChanged([this.key]);
        this.providerTransportFailure = {
          ...this.providerTransportFailure,
          ...providerTransportDetails(event.message),
        };
        const stopReason = (event.message as { stopReason?: unknown })
          .stopReason;
        if (stopReason === "aborted") {
          this.currentAssistantAborted = true;
          // Providers also report transport AbortErrors as "aborted". Only an
          // abort requested through our runtime is a quiet user stop.
          if (!this.explicitAbortRequested) {
            const error = unexpectedProviderAbortError(
              event.message,
              this.explicitAbortRequested,
            );
            if (error) {
              this.currentAssistantErrorInfo = this.providerErrorInfo(
                error,
                event.message,
              );
              this.currentAssistantError = providerErrorDisplayText(
                this.currentAssistantErrorInfo,
              );
            }
          }
          break;
        }
        const error = terminalAssistantError(event.message);
        if (error) {
          this.currentAssistantErrorInfo = this.providerErrorInfo(
            error,
            event.message,
          );
          this.currentAssistantError = providerErrorDisplayText(
            this.currentAssistantErrorInfo,
          );
          console.error(this.currentAssistantError);
        }
        break;
      }
      case "auto_retry_start": {
        const retryError = this.providerErrorInfo(event.errorMessage);
        if (this.awaitingRetryContinuation && !this.retryAttemptError)
          this.retryAttemptError = providerErrorDisplayText(retryError);
        // The engine has already aborted the retry (`piEngine.ts`).
        if (shouldSuppressProviderRetry(retryError)) {
          this.providerNotice(
            "warning",
            `${providerErrorDisplayText(retryError)} Retries were skipped because this error is not expected to recover automatically.`,
            retryError,
            {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              ...this.providerTransportFailure,
            },
          );
          break;
        }
        this.adapterEvents.providerRetry({
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          ...(retryError.statusCode !== undefined
            ? { status: retryError.statusCode }
            : {}),
        });
        this.providerNotice(
          "warning",
          `${providerErrorDisplayText(retryError)} Retrying ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s…`,
          retryError,
          {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            ...this.providerTransportFailure,
          },
        );
        break;
      }
      case "auto_retry_end": {
        if (!event.success && event.finalError) {
          const finalError = this.providerErrorInfo(event.finalError);
          if (this.awaitingRetryContinuation)
            this.retryAttemptError = providerErrorDisplayText(finalError);
          // Retries are exhausted: the run has failed, and the runtime records
          // that before the notice below tells anyone.
          if (!this.explicitAbortRequested)
            this.adapterEvents.runFailing(
              providerErrorDisplayText(finalError),
              runFailureFacts(finalError),
            );
          this.providerNotice(
            "error",
            `Provider retry failed. ${providerErrorDisplayText(finalError)}`,
            finalError,
            this.providerTransportFailure,
          );
        }
        break;
      }
      case "compaction_start": {
        // Automatic (threshold/overflow) compaction gives no external pre-hook, so
        // coalesce a pending-observation flush here before context is reset. The
        // manual `/compact` path already awaits its own pre-flush; flushSession is
        // single-flight, so a redundant trigger is harmless.
        void memoryScheduler.flushBeforeReset(this.engine.sessionId);
        break;
      }
      case "compaction_end": {
        if (event.errorMessage) this.notice("warning", event.errorMessage);
        // Reset whenever compaction actually applied a result: not aborted, and a
        // result was produced. `willRetry` does NOT gate this — pi saves/applies the
        // compacted context BEFORE retrying the failed prompt, so `willRetry: true` is
        // still a successful compaction, and the provider-native context is already
        // reset either way. Drop the delivered snapshot + cumulative diagnostic so the
        // next turn re-injects (Task 96). Idempotent, so a double reset from the
        // explicit /compact path is harmless.
        if (!event.aborted && event.result) {
          resetMemorySessionContext(this.engine.sessionId);
        }
        break;
      }
      case "tool_execution_start": {
        const id = this.currentAssistantId;
        if (!id || !this.liveTurn) break;
        this.liveTurn.blocks.push({
          kind: "tool",
          toolId: event.toolCallId,
          name: event.toolName,
          args: event.args,
          output: "",
          isError: false,
          done: false,
        });
        this.broadcast({
          type: "toolStart",
          sessionId,
          id,
          toolId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        });
        this.adapterEvents.toolStarted(
          event.toolCallId,
          event.toolName,
          event.args,
        );
        this.broadcastContextInfo(true);
        break;
      }
      case "tool_execution_update": {
        const id = this.currentAssistantId;
        if (!id || !this.liveTurn) break;
        const output = formatToolResult(event.partialResult);
        updateTool(this.liveTurn.blocks, event.toolCallId, { output });
        this.broadcast({
          type: "toolUpdate",
          sessionId,
          id,
          toolId: event.toolCallId,
          output,
        });
        this.adapterEvents.toolUpdated(event.toolCallId, output);
        this.broadcastContextInfo(true);
        break;
      }
      case "tool_execution_end": {
        const id = this.currentAssistantId;
        if (!id || !this.liveTurn) break;
        const output = formatToolResult(event.result);
        const resultDiff = toolResultDisplayDiff(event.result);
        updateTool(this.liveTurn.blocks, event.toolCallId, {
          output,
          isError: event.isError,
          done: true,
          ...(resultDiff !== undefined ? { resultDiff } : {}),
        });
        const envelope = {
          type: "toolEnd" as const,
          sessionId,
          id,
          toolId: event.toolCallId,
          output,
          isError: event.isError,
          ...(resultDiff !== undefined ? { resultDiff } : {}),
        };
        this.broadcast(envelope);
        this.adapterEvents.toolCompleted(envelope);
        this.broadcastContextInfo(true);
        if (event.toolName === "task_manage") {
          this.broadcastState();
          this.host.sessionRowsChanged([this.key]);
        }
        break;
      }
      case "agent_end": {
        // Under retry suppression the engine reports `willRetry: false`.
        if (!event.willRetry) break;
        const id = this.currentAssistantId;
        this.awaitingRetryContinuation = true;
        this.retryAttemptError = this.currentAssistantError;
        this.currentAssistantId = undefined;
        this.currentAssistantError = undefined;
        this.currentAssistantErrorInfo = undefined;
        this.currentAssistantAborted = false;
        this.liveTurn = undefined;
        this.updatedAt = Date.now();
        this.syncRegistry();
        if (id) {
          this.broadcast({ type: "assistantEnd", sessionId, id });
          const model = (this.engine.model as unknown as PiModel | undefined)
            ?.id;
          const usage = this.turnUsage();
          // Preserve the old one-entry-per-attempt transcript shape, but do not
          // emit runCompleted: pi still owns an automatic retry/compaction or
          // queued continuation, so neither runtime idle nor peer delivery may
          // happen until agent_settled.
          this.adapterEvents.messageAttemptCompleted(id, {
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
          });
        }
        this.broadcastContextInfo(true);
        if (this.viewers.size > 0)
          sessionStore.markRead(this.key, this.updatedAt);
        this.host.sessionRowsChanged([this.key]);
        break;
      }
      case "agent_settled": {
        const id = this.currentAssistantId;
        const retryEndedBetweenAttempts = this.awaitingRetryContinuation;
        const error =
          this.currentAssistantError ??
          (retryEndedBetweenAttempts ? this.retryAttemptError : undefined);
        const errorInfo = this.currentAssistantErrorInfo;
        const aborted =
          this.currentAssistantAborted || this.explicitAbortRequested;
        const abortRequested = this.explicitAbortRequested;
        this.running = false;
        this.currentAssistantId = undefined;
        this.currentAssistantError = undefined;
        this.currentAssistantErrorInfo = undefined;
        this.currentAssistantAborted = false;
        this.awaitingRetryContinuation = false;
        this.retryAttemptError = undefined;
        this.explicitAbortRequested = false;
        this.liveTurn = undefined;
        this.updatedAt = Date.now();
        this.syncRegistry();
        // A failed run is recorded before anyone hears of it — not one whose
        // abort was asked for, whose error is an earlier attempt's.
        if (error && !abortRequested && (id || retryEndedBetweenAttempts))
          this.adapterEvents.runFailing(
            error,
            errorInfo ? runFailureFacts(errorInfo) : undefined,
          );
        if (id) {
          this.broadcast({
            type: "assistantEnd",
            sessionId,
            id,
            ...(error !== undefined ? { error } : {}),
            ...(errorInfo !== undefined ? { errorInfo } : {}),
            ...(aborted ? { aborted: true } : {}),
          });
          const model = (this.engine.model as unknown as PiModel | undefined)
            ?.id;
          const usage = this.turnUsage();
          this.adapterEvents.messageCompleted(id, {
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(error ? { errorMessage: error } : {}),
            ...(error && errorInfo
              ? { failure: runFailureFacts(errorInfo) }
              : {}),
            ...(aborted ? { aborted: true } : {}),
            ...(abortRequested ? { abortRequested: true } : {}),
          });
        } else if (retryEndedBetweenAttempts) {
          // A Stop or retry-preparation failure can settle without another
          // agent_start. Close only the enclosing run: its last attempt was
          // already persisted by messageAttemptCompleted.
          this.adapterEvents.runCompleted(
            aborted ? "aborted" : "error",
            aborted
              ? undefined
              : (error ?? "Pi retry ended before another attempt started."),
            !aborted && errorInfo ? runFailureFacts(errorInfo) : undefined,
          );
        }
        this.broadcastState();
        // No post-turn history reconciliation: the runtime consumes native
        // adapter events and re-emits the client-facing stream, so turn completion
        // + reconnect are covered by durable entryAppended deltas + the native
        // snapshot timeline.
        this.broadcastContextInfo(true);
        // A response the user is watching is read; otherwise it remains unread.
        if (this.viewers.size > 0) {
          sessionStore.markRead(this.key, this.updatedAt);
        }
        this.residency.arm();
        this.host.sessionRowsChanged([this.key]);
        // A deferred reload waits for the last run to finish — check now.
        this.host.checkPendingReload();
        break;
      }
      case "session_info_changed": {
        if (event.name) {
          this.title = deriveTitle(event.name, "");
          this.titleGenerationPending = false;
        }
        this.updatedAt = Date.now();
        this.syncRegistry();
        this.host.sessionRowsChanged([this.key]);
        break;
      }
      default:
        break;
    }
  }

  /* -------------------------------- commands ------------------------------- */

  /** Where this session's host-command turns are shown (`sessionKit/hostCommandTurn.ts`). */
  private get hostCommandTarget(): HostCommandTurnTarget {
    return {
      sessionId: this.engine.sessionId,
      broadcast: (message) => this.broadcast(message),
      adapterEvents: this.adapterEvents,
    };
  }

  /**
   * Open a host-driven ("synthetic") assistant turn carrying one in-progress tool
   * block — the shared primitive behind every slash command. The matching
   * `finish*` method ends the turn. See {@link SyntheticToolHost}.
   */
  beginSyntheticTool(
    name: string,
    args: unknown,
  ): { assistantId: string; toolId: string } {
    assertAccountRecoveryAdmission(this.sessionId);
    if (this.running)
      throw new SessionBusyError(
        this.engine.sessionId,
        "Cannot run a slash command while the agent is streaming.",
      );
    if (this.host.isReloadQueued()) throw new Error(RELOAD_QUEUED_MESSAGE);
    return this.openSyntheticTurn("slash", name, args);
  }

  /** Start a synthetic turn the caller has already cleared to run. */
  private openSyntheticTurn(
    toolIdPrefix: string,
    name: string,
    args: unknown,
  ): { assistantId: string; toolId: string } {
    assertAccountRecoveryAdmission(this.sessionId);
    this.residency.cancel();
    this.running = true;
    this.host.noteRunStarted();
    const assistantId = `a${++this.idCounter}`;
    const toolId = `${toolIdPrefix}-${Date.now()}-${this.idCounter}`;
    this.currentAssistantId = assistantId;
    this.syntheticToolId = toolId;
    this.liveTurn = hostCommandTurn(assistantId, toolId, name, args);
    this.updatedAt = Date.now();
    openHostCommandTurn(this.hostCommandTarget, this.liveTurn);
    this.broadcastState();
    this.broadcastContextInfo(true);
    this.host.sessionRowsChanged([this.key]);
    return { assistantId, toolId };
  }

  updateSyntheticTool(output: string): void {
    const toolId = this.syntheticToolId;
    if (!this.currentAssistantId || !toolId || !this.liveTurn) return;
    updateHostCommandTool(
      this.hostCommandTarget,
      this.liveTurn,
      toolId,
      output,
    );
  }

  discardSyntheticTool(): void {
    if (!this.currentAssistantId || !this.liveTurn) return;
    discardHostCommandTurn(this.hostCommandTarget, this.liveTurn);
    this.endSyntheticTurn();
  }

  finishSyntheticTool(toolId: string, output: string, isError = false): void {
    if (!this.currentAssistantId || !this.liveTurn) return;
    finishHostCommandTool(
      this.hostCommandTarget,
      this.liveTurn,
      toolId,
      output,
      isError,
    );
    this.endSyntheticTurn();
  }

  finishSyntheticCard(result: HostCommandResult): void {
    if (!this.currentAssistantId || !this.liveTurn) return;
    finishHostCommandCard(this.hostCommandTarget, this.liveTurn, result);
    this.endSyntheticTurn();
  }

  /**
   * Tear down a finished synthetic turn (shared by every finish* path). Durable
   * results (commit custom entry, compaction) converge on the runtime path via
   * the adapter's `hostCommandResult` → the runtime's durable card entry, so no
   * post-turn `history` broadcast is needed here (the adapter would drop it).
   */
  private endSyntheticTurn(): void {
    this.running = false;
    this.currentAssistantId = undefined;
    this.syntheticToolId = undefined;
    this.liveTurn = undefined;
    this.updatedAt = Date.now();
    this.broadcastState();
    this.broadcastContextInfo(true);
    if (this.viewers.size > 0) sessionStore.markRead(this.key, this.updatedAt);
    this.residency.arm();
    this.host.sessionRowsChanged([this.key]);
    this.host.checkPendingReload();
  }

  /** Minimal session context the commit workflow needs (the engine's transcript). */
  commitWorkflowContext(): { sessionManager: unknown; cwd?: string } {
    return { sessionManager: this.engine.toolSessionManager(), cwd: this.cwd };
  }

  /**
   * Accept a `/commit` dry run as a synthetic turn: progress streams into its
   * tool block and the commit card ends it, or the failure does. The turn's
   * teardown refreshes the state the commit changed.
   */
  async acceptCommitDryRun(entryId: string): Promise<void> {
    assertAccountRecoveryAdmission(this.sessionId);
    if (this.running)
      throw new Error(
        "Cannot accept a commit dry run while the agent is streaming.",
      );
    if (this.host.isReloadQueued()) throw new Error(RELOAD_QUEUED_MESSAGE);
    const { toolId } = this.openSyntheticTurn("accept", "/commit accept", {
      entryId,
    });
    try {
      const result = await acceptCommitDryRun({
        sessionManager: this.engine.toolSessionManager(),
        entryId,
        cwd: this.cwd,
        side: sessionCheckoutSide(this.sessionId),
        onProgress: (message) => this.updateSyntheticTool(message),
      });
      this.finishSyntheticCard({
        kind: "commit",
        commit: toCommitDisplay(result),
      });
    } catch (err) {
      this.finishSyntheticTool(toolId, errorText(err), true);
    }
  }

  createRuntimeAdapter(): PromptableAdapter {
    // `sessionFile` must stay a getter (it is read lazily, per access), and a
    // getter is not an arrow, so it needs the enclosing `this` handed to it.
    const sessionFileOf = () => this.sessionFile;
    const driver: PiDriver = {
      subscribeAdapterEvents: (listener) =>
        this.subscribeAdapterEvents(listener),
      prompt: (text, attachments, options) =>
        this.#promptRaw(
          text,
          (attachments as PromptAttachment[] | undefined) ?? [],
          options,
        ),
      abort: () => this.abort(),
      skillDispatch: (name) =>
        piSkillDispatch(
          { getSkills: () => ({ skills: this.engine.skills() }) },
          activeSkillsForSession(this.engine.sessionId, this.kind) ?? [],
          name,
        ),
      setModel: (model) => this.setModel(model as PiEngineModel),
      setThinkingLevel: (level) =>
        this.setThinkingLevel(level as ThinkingLevel),
      modelProvider: () => this.engine.model?.provider,
      modelId: () => this.engine.model?.id,
      completionMetadata: () => {
        const model = (this.engine.model as unknown as PiModel | undefined)?.id;
        const usage = this.turnUsage();
        return { ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
      },
      get sessionFile() {
        return sessionFileOf();
      },
    };
    return createPiAdapter(this.id, driver, {
      resolveModel: (model) => findModel(model.provider, model.id),
    });
  }

  /** Rebuild on the new login only after the old SDK operation has settled. */
  async switchAccount(profileId: string, admit: () => void): Promise<void> {
    const previous = this.profileId;
    if (!previous || !this.reopenForAccount)
      throw new Error("This pi session cannot switch accounts.");
    const check = () => {
      admit();
      if (
        this.disposed ||
        this.running ||
        this.engine.isStreaming ||
        this.profileId !== previous
      )
        throw new Error("The pi session changed during its account switch.");
      assertSessionAccountSwitch(this.id, previous, profileId, "openai-codex");
    };
    await this.driveCompletion?.catch(() => {});
    check();
    const transcript = this.engine.transcript;
    const leaf = transcript.getLeafId();
    const replacement = await this.reopenForAccount(profileId);
    let committed = false;
    try {
      check();
      if (replacement.engine.sessionId !== this.id)
        throw new Error("The reopened pi session has a different id.");
      if (
        transcript.getLeafId() !== leaf ||
        replacement.engine.transcript.getLeafId() !== leaf
      )
        throw new Error("The pi transcript changed during its account switch.");
      sessionStore.switchCredentialProfile(this.id, previous, profileId);
      committed = true;
      const old = this.engine;
      this.unsubscribe();
      this.currentEngine = replacement.engine;
      this.profileId = profileId;
      this.unsubscribe = this.engine.subscribe((event) =>
        this.onAgentEvent(event),
      );
      await replacement.commit();
      void old.dispose();
      this.broadcastState();
      this.host.sessionRowsChanged([this.key]);
    } catch (error) {
      if (!committed) void replacement.dispose();
      throw error;
    }
  }

  #promptRaw(
    text: string,
    attachments: PromptAttachment[] = [],
    options: {
      hidden?: boolean;
      clientRequestId?: string;
      steerOnly?: boolean;
      continuation?: boolean;
      titleText?: string;
    } = {},
  ): PiPromptResponse {
    if (options.continuation) return this.continueFailedTurn(text);
    const trimmedInput = text.trim();
    if (!trimmedInput && attachments.length === 0) return "ignored";

    // The authoritative streaming read and the decision it drives happen HERE,
    // with nothing in between. A caller that asked to steer and only steer gets
    // "ignored" rather than a turn it never asked to start — the runtime's own
    // `runState` check ran earlier and may already be stale by now.
    if (options.steerOnly && !this.engine.isStreaming) return "ignored";

    // Idempotent on clientRequestId: a duplicate submit (double-click, reconnect
    // resend) is a no-op so it can't open a second turn or echo a second bubble.
    if (options.clientRequestId) {
      if (this.handledRequestIds.has(options.clientRequestId)) return "ignored";
      this.handledRequestIds.add(options.clientRequestId);
    }

    if (this.host.isReloadQueued() && !this.engine.isStreaming) {
      this.notice("warning", RELOAD_QUEUED_MESSAGE);
      return "ignored";
    }

    const promptText = trimmedInput || "Please analyze the attached file(s).";
    // A skill command is named and shown as typed, never as the native
    // `/skill:` token and context pi is sent.
    const titleText = options.titleText ?? promptText;
    const { promptWithFiles, images } = buildModelPromptWithAttachments(
      this.engine.sessionId,
      promptText,
      attachments,
    );

    const storedTitle =
      this.title ?? sessionStore.get(this.engine.sessionId)?.title;
    const shouldAutoName = shouldAutoNamePiSession({
      sessionManager: this.engine.transcript,
      ...(this.engine.sessionName !== undefined
        ? { nativeSessionName: this.engine.sessionName }
        : {}),
      ...(storedTitle !== undefined ? { storedTitle } : {}),
    });
    const namingSettings = shouldAutoName
      ? getSettings().sessionNaming
      : undefined;
    const shouldAutoNameFork =
      !this.engine.isStreaming &&
      isForkAutoRenamePending(this.engine.transcript);
    const forkNamingContext = shouldAutoNameFork
      ? forkTitleContext(this.engine.transcript)
      : undefined;
    const forkOriginalName = shouldAutoNameFork
      ? this.engine.sessionName
      : undefined;
    this.title ??= restorePiLiveTitle(this.engine.sessionName, storedTitle);
    if (shouldAutoName) {
      this.title ??= namingSettings?.enabled
        ? UNLABELED_SESSION_TITLE
        : fallbackSessionTitle(titleText, attachments);
      this.titleGenerationPending = Boolean(namingSettings?.enabled);
    }
    const now = Date.now();
    const userTurnIdleMs = this.updatedAt > 0 ? now - this.updatedAt : 0;
    this.updatedAt = now;
    const blocks: DisplayBlock[] = [{ kind: "text", text: titleText }];
    blocks.push(
      ...attachments.map((a): DisplayBlock => ({
        kind: "attachment",
        attachment: attachmentDisplay(a),
      })),
    );
    const message: DisplayMessage = {
      id: `u${++this.idCounter}`,
      role: "user",
      blocks,
    };
    // Hidden prompts (e.g. resuming a session with question answers) run through
    // the agent but aren't shown as a user bubble — the question card represents
    // them. snapshot() drops the persisted copy by its marker.
    const emitUserMessage = (): void => {
      if (options.hidden) return;
      this.broadcast({
        type: "userMessage",
        sessionId: this.engine.sessionId,
        message,
        ...(options.clientRequestId !== undefined
          ? { clientRequestId: options.clientRequestId }
          : {}),
      });
    };
    // A `steerOnly` caller has explicitly said "nothing at all" is an acceptable
    // outcome, so the bubble waits for pi to accept the message. Showing it up
    // front leaves a phantom the viewer cannot clear: the runtime appends no
    // durable entry for a refused steer, and the fallback delivery carries a
    // different request id, so it renders a second bubble instead of replacing
    // the first. Every other prompt keeps showing immediately — the user's own
    // words belong on screen the moment they are sent, failure or not.
    if (!options.steerOnly) emitUserMessage();
    this.broadcastContextInfo(true);
    const wasRunning = this.running || this.engine.isStreaming;
    if (!wasRunning) {
      this.residency.cancel();
      this.running = true;
      this.host.noteRunStarted();
    }
    const steer = this.engine.isStreaming;
    const run = this.engine.submit(promptWithFiles, images, {
      steer,
      steerOnly: Boolean(options.steerOnly),
      userTurnIdleMs,
    });
    if (!wasRunning) this.driveCompletion = run.settled;
    // An engine that found itself idle runs a steer as a prompt and reports
    // it "started": a new turn, never labelled a steer. Its `agent_start`,
    // which the disposition precedes, marks the run; a failure fails it as a
    // new run, not a queued steer. A local engine always does as asked.
    const newTurn = run.disposition.then(
      (disposition) => steer && disposition === "started",
      () => false,
    );
    const accepted = newTurn.then((isNew): "steered" | "started" => {
      if (!isNew) return wasRunning ? "steered" : "started";
      this.driveCompletion = run.settled;
      return "started";
    });
    if (options.steerOnly) {
      // A refused `steerOnly` is expected control flow, not a provider failure:
      // the adapter reports it as `steered: false` and delivery retries. Routing
      // it through `finishPromptError` would post an error banner and — once the
      // original turn has cleared — manufacture a synthetic assistant error turn
      // and adapter events for a message that was never meant to be sent. The
      // refusal also frees the request id, so the retry is not a duplicate.
      void run.settled.then(emitUserMessage, () => {
        if (options.clientRequestId)
          this.handledRequestIds.delete(options.clientRequestId);
      });
    } else
      run.settled.catch((err: unknown) =>
        newTurn.then((isNew) =>
          this.finishPromptError(err, isNew ? false : wasRunning),
        ),
      );
    // The chat should appear in every tab the moment its first prompt is sent.
    if (this.viewers.size > 0) sessionStore.markRead(this.key, this.updatedAt);
    this.host.sessionRowsChanged([this.key]);
    if (shouldAutoName && namingSettings?.enabled)
      void this.autoNameFromFirstPrompt(titleText, attachments, namingSettings);
    if (shouldAutoNameFork)
      void this.autoNameForkFromFirstPrompt(
        titleText,
        forkNamingContext,
        forkOriginalName,
        attachments,
      );
    // A failed submit fails through `finishPromptError` as before, so the
    // adapter's acceptance never rejects here.
    return {
      outcome: wasRunning ? "steered" : "started",
      accepted,
      completed: run.settled,
    };
  }

  /** Only after explicit rejection: omit opaque OpenAI reasoning, not text/tools/history. */
  async dropEncryptedReasoning(admit: () => void): Promise<boolean> {
    await this.driveCompletion?.catch(() => undefined);
    admit();
    // The engine refuses while it streams.
    if (this.running || this.disposed) return false;
    return this.engine.dropEncryptedReasoning();
  }

  /** SDK-owned continuation: model-only custom input, never another user message. */
  private continueFailedTurn(context: string): PiPromptResponse {
    if (
      this.disposed ||
      this.running ||
      this.continuing ||
      this.engine.isStreaming
    )
      throw new Error("Cannot continue a running or released pi session.");
    // The run is marked only once the engine reports it started. A failed
    // transcript write rejects the disposition instead: nothing is marked and
    // nothing fails, so the adapter's rejection is the whole outcome, with no
    // banner and no synthetic turn.
    const run = this.engine.continueFailedTurn(context);
    this.continuing = true;
    const accepted = run.disposition.then(
      (disposition) => {
        this.continuing = false;
        this.residency.cancel();
        this.running = true;
        this.host.noteRunStarted();
        this.driveCompletion = run.settled;
        void run.settled.catch((error: unknown) =>
          this.finishPromptError(error, false),
        );
        return disposition;
      },
      (error: unknown) => {
        this.continuing = false;
        throw error;
      },
    );
    return { outcome: "started", accepted, completed: run.settled };
  }

  private finishPromptError(err: unknown, wasRunning: boolean): void {
    const raw = errorText(err);
    const message = `Failed to send prompt: ${raw}`;
    const failure = runFailureFacts(this.providerErrorInfo(raw));

    // If this was a queued steer/follow-up while the agent is already running,
    // keep the active turn intact and only surface the banner.
    if (wasRunning && this.running && this.currentAssistantId) {
      this.notice("error", message);
      return;
    }

    this.running = false;
    const sessionId = this.engine.sessionId;
    const retryEndedBetweenAttempts =
      !this.currentAssistantId && this.awaitingRetryContinuation;
    const id = retryEndedBetweenAttempts
      ? undefined
      : (this.currentAssistantId ?? `a${++this.idCounter}`);
    if (id && !this.currentAssistantId) {
      this.broadcast({ type: "assistantStart", sessionId, id });
      this.adapterEvents.messageStarted(id);
    }
    // The run is open now; it is recorded as failed before the banner or the
    // turn's end tells anyone.
    this.adapterEvents.runFailing(message, failure);
    this.notice("error", message);
    if (!id) {
      this.adapterEvents.runCompleted("error", message, failure);
    } else {
      this.broadcast({ type: "assistantEnd", sessionId, id, error: message });
      this.adapterEvents.messageCompleted(id, {
        errorMessage: message,
        failure,
      });
    }
    this.currentAssistantId = undefined;
    this.currentAssistantError = undefined;
    this.currentAssistantErrorInfo = undefined;
    this.currentAssistantAborted = false;
    this.awaitingRetryContinuation = false;
    this.retryAttemptError = undefined;
    this.explicitAbortRequested = false;
    this.liveTurn = undefined;
    this.updatedAt = Date.now();
    this.broadcastState();
    this.broadcastContextInfo(true);
    if (this.viewers.size > 0) sessionStore.markRead(this.key, this.updatedAt);
    this.residency.arm();
    this.host.sessionRowsChanged([this.key]);
    this.host.checkPendingReload();
  }

  private async autoNameFromFirstPrompt(
    prompt: string,
    attachments: PromptAttachment[],
    settings: SessionNamingSettings,
  ): Promise<void> {
    let generatedTitle: string | undefined;
    try {
      generatedTitle = await generateSessionTitle(prompt, settings, {
        parentSessionId: this.sessionId,
        attachments,
      });
    } catch (err) {
      console.warn("Failed to auto-name session:", errorText(err));
    }
    try {
      // Do not overwrite a user/manual rename that happened while generation ran.
      if (this.engine.sessionName) return;
      await this.rename(
        generatedTitle ?? fallbackSessionTitle(prompt, attachments),
      );
      this.host.sessionRowsChanged([this.key]);
    } catch (err) {
      console.warn("Failed to apply automatic session title:", errorText(err));
    } finally {
      // A manual rename may have spent this already; every other exit must stop
      // looking like naming work is still happening.
      if (this.titleGenerationPending) {
        this.titleGenerationPending = false;
        this.host.sessionRowsChanged([this.key]);
      }
    }
  }

  private async autoNameForkFromFirstPrompt(
    prompt: string,
    priorContext: string | undefined,
    originalName: string | undefined,
    attachments: PromptAttachment[],
  ): Promise<void> {
    try {
      const title = await generateSessionTitle(
        prompt,
        getSettings().sessionNaming,
        {
          ...(priorContext !== undefined ? { priorContext } : {}),
          focusPrompt: prompt,
          parentSessionId: this.sessionId,
          attachments,
        },
      );
      // Do not overwrite a user/manual rename that happened while generation ran.
      if (!title || this.engine.sessionName !== originalName) return;
      await this.rename(title);
      this.host.sessionRowsChanged([this.key]);
    } catch (err) {
      console.warn("Failed to auto-name forked session:", errorText(err));
    }
  }

  async abort(): Promise<void> {
    if (this.running) {
      this.currentAssistantAborted = true;
      this.explicitAbortRequested = true;
    }
    await this.engine.abort();
  }

  /**
   * The {@link SyntheticToolHost} compaction step: pi's own `AgentSession`
   * compaction. pi never declines, so this always reports `compacted`; its
   * `compaction_end` event handles the memory reset for automatic compaction,
   * and the host command path resets again (idempotent) for this manual one.
   */
  async compactContext(
    customInstructions?: string,
  ): Promise<HostCompactionOutcome> {
    const result: CompactionResult =
      await this.engine.compact(customInstructions);
    return {
      kind: "compacted",
      summary: result.summary,
      tokensBefore: result.tokensBefore,
      firstKeptEntryId: result.firstKeptEntryId,
    };
  }

  /**
   * The {@link SyntheticToolHost} clear step for pi. Two halves, both needed:
   * `resetLeaf()` moves the session file's leaf pointer before its first entry
   * (the next append starts a new root branch, and nothing is deleted — pi's own
   * re-edit flow works exactly this way), while `state.messages` is the live
   * context the agent actually sends, which pi rebuilds from the branch after
   * its compactions and which we empty here for the same reason.
   *
   * The system prompt, tools and model live on the agent, not in the branch, so
   * they survive; our own transcript is a separate log and keeps every message.
   */
  async clearContext(): Promise<HostClearOutcome> {
    const result = await this.engine.clearContext();
    if (result.kind === "skipped")
      return {
        kind: "skipped",
        reason: "Nothing to clear — this session has no context yet.",
      };
    this.broadcastContextInfo(true);
    return {
      kind: "cleared",
      ...(result.tokensBefore != null
        ? { tokensBefore: result.tokensBefore }
        : {}),
    };
  }

  async setModel(model: PiEngineModel): Promise<void> {
    // The engine rewrites the compaction window for the new model.
    await this.engine.setModel(model);
    this.broadcastState();
    this.broadcastContextInfo(true);
    this.host.sessionRowsChanged([this.key]);
  }

  /** Broadcasts only once the engine has applied it; a rejection reaches the caller. */
  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.engine.setThinkingLevel(level);
    this.broadcastState();
    this.broadcastContextInfo(true);
    this.host.sessionRowsChanged([this.key]);
  }

  /* ---------------------------- compaction window --------------------------- */

  compactionWindowStatus(): CompactionWindowHarnessStatus {
    return this.engine.compactionWindowStatus();
  }

  async applyCompactionWindow(
    tokens: number | null,
  ): Promise<CompactionWindowApplyResult> {
    return this.engine.applyCompactionWindow(tokens);
  }

  async lowerCompactionWindow(
    tokens: number,
    persist: (tokens: number) => void,
  ): Promise<CompactionWindowLowerResult> {
    // The engine checks and applies; persisting is this consumer's, and a
    // failed save puts the previous window back, never the stored row.
    const result = await this.engine.lowerCompactionWindow(tokens);
    if (!result.ok) return result;
    try {
      persist(tokens);
    } catch (error) {
      return this.engine.restoreCompactionWindow(
        result.previous,
        `Saving the compaction window failed: ${errorText(error)}`,
      );
    }
    return result;
  }

  modelSelection(): {
    model?: { provider: string; id: string };
    thinkingLevel?: ThinkingLevel;
  } {
    const model = this.engine.model;
    return {
      ...(model ? { model: { provider: model.provider, id: model.id } } : {}),
      ...(this.engine.thinkingLevel
        ? { thinkingLevel: this.engine.thinkingLevel as ThinkingLevel }
        : {}),
    };
  }

  get sessionMode(): SessionMode {
    return this.mode;
  }

  /**
   * Apply + persist the per-turn tool policy for the next turn. Nothing is
   * persisted or broadcast unless the engine applied it. A session's flips run
   * one at a time, each checking the mode current when its turn comes: the
   * engine's apply is awaited, so an overlapping flip would otherwise compare
   * against a mode about to change.
   */
  setMode(mode: SessionMode): Promise<void> {
    const operation = this.modeOperations.then(() => this.applyMode(mode));
    this.modeOperations = operation.catch(() => {});
    return operation;
  }

  private async applyMode(mode: SessionMode): Promise<void> {
    if (this.mode === mode) return;
    await this.onModeChange(mode);
    this.mode = mode;
    sessionStore.upsert({
      id: this.sessionId,
      harness: "pi",
      agentType: this.kind,
      mode,
    });
    this.broadcastState();
  }

  async rename(title: string): Promise<void> {
    // `setSessionName` may emit synchronously; spend the working state first so
    // no broadcast ever shows a final title with the pending treatment.
    if (this.titleGenerationPending) {
      this.titleGenerationPending = false;
      this.host.sessionRowsChanged([this.key]);
    }
    await this.engine.setSessionName(title);
    this.title = deriveTitle(title, "");
    this.updatedAt = Date.now();
    this.syncRegistry();
  }

  /* -------------------------------- snapshot ------------------------------- */

  /**
   * The full conversation as display messages: persisted history plus the
   * in-flight turn (if any). The current run starts at the last user message,
   * so everything after it is represented by {@link liveTurn} — this avoids
   * double-rendering the run's already-committed sub-messages regardless of
   * when the SDK commits them.
   */
  snapshot(): DisplayMessage[] {
    const branch = this.engine.transcript.getBranch() as Parameters<
      typeof serializeSessionBranch
    >[0];
    const ctx = { kind: this.kind, sessionId: this.engine.sessionId };
    if (!this.liveTurn)
      return withPullRequestCardBlocks(
        withApprovalBlocks(
          hideMarkedMessages(serializeSessionBranch(branch, ctx)),
          this.engine.sessionId,
        ),
        this.engine.sessionId,
      );
    let cut = branch.length;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as
        { type?: string; message?: AnyMessage } | undefined;
      if (entry?.type === "message" && entry.message?.role === "user") {
        cut = i + 1;
        break;
      }
    }
    return withPullRequestCardBlocks(
      withApprovalBlocks(
        [
          ...hideMarkedMessages(
            serializeSessionBranch(branch.slice(0, cut), ctx),
          ),
          this.liveTurn,
        ],
        this.engine.sessionId,
      ),
      this.engine.sessionId,
    );
  }

  /**
   * Library-skill loads in the persisted branch: pi's prompt asks the model to
   * `read` a skill's SKILL.md, so that read is the invocation, and a user
   * `/skill:` command leaves its expanded skill block as the user message. The
   * branch, not `state.messages`, is walked — a context clear empties the
   * latter.
   */
  private branchToolCalls(
    frozenNames: readonly string[],
  ): SkillInvocationTranscript {
    const calls: SkillInvocationToolCall[] = [];
    const commands: SkillInvocationCommand[] = [];
    const succeeded = new Set<string>();
    // Each user message opens the turn the calls after it belong to.
    let turn = 0;
    for (const entry of this.engine.transcript.getBranch()) {
      const record = entry as { type?: unknown; message?: unknown };
      if (record.type !== "message") continue;
      const message = record.message as
        | {
            role?: unknown;
            content?: unknown;
            timestamp?: unknown;
            toolCallId?: unknown;
            isError?: unknown;
          }
        | undefined;
      if (message?.role === "toolResult") {
        if (typeof message.toolCallId === "string" && !message.isError)
          succeeded.add(message.toolCallId);
        continue;
      }
      const at = typeof message?.timestamp === "number" ? message.timestamp : 0;
      if (message?.role === "user") {
        turn += 1;
        const name = piSkillCommandName(
          frozenNames,
          extractTextContent(message.content),
        );
        if (name) commands.push({ name, at, turn: String(turn) });
        continue;
      }
      if (message?.role !== "assistant" || !Array.isArray(message.content))
        continue;
      for (const block of message.content) {
        const call = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
        };
        if (
          call.type === "toolCall" &&
          typeof call.id === "string" &&
          typeof call.name === "string"
        )
          calls.push({
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
            at,
            turn: String(turn),
          });
      }
    }
    return { calls, succeeded, commands };
  }

  nativeFacts(): SessionNativeFacts {
    const model = this.engine.model as unknown as PiModel | undefined;
    return {
      harness: this.harness,
      agentType: this.agentType,
      kind: this.kind,
      sessionFile: this.sessionFile,
      forkOrigin: readForkOrigin(this.kind, this.engine.transcript),
      model: model ? (toModelOption(model) as ModelOption) : undefined,
      thinkingLevel: this.engine.thinkingLevel as ThinkingLevel,
      mode: this.mode,
      live: {
        canSteer: this.canSteer,
        compactionWindow: this.compactionWindowStatus(),
        skillInvocationTranscript: (names) => this.branchToolCalls(names),
        toolLoading: toolLoadingForSession(this.sessionId),
      },
    };
  }

  /** Cumulative billed totals across the whole session, from pi's native stats. */
  private cumulativeTotals(): CumulativeUsageTotals {
    const stats = this.engine.stats();
    return {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
    };
  }

  /**
   * Durable usage for the run that just completed: the growth of pi's cumulative
   * session stats since `agent_start`, plus the current real context size.
   * `turnStartTotals` is intentionally NOT cleared here — the adapter's
   * driver-completion fallback may ask again before the next run re-samples it.
   */
  private turnUsage(): AgentUsage | undefined {
    const stats = this.engine.stats();
    const after: CumulativeUsageTotals = {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cost: stats.cost,
    };
    return perTurnUsage(this.turnStartTotals, after, {
      ...(stats.contextUsage?.tokens !== undefined
        ? { tokens: stats.contextUsage?.tokens }
        : {}),
      ...(stats.contextUsage?.contextWindow !== undefined
        ? { window: stats.contextUsage?.contextWindow }
        : {}),
    });
  }

  contextInfo(): ContextInfo {
    const stats = this.engine.stats();
    const text =
      this.liveTurn?.blocks
        .filter(
          (b): b is Extract<DisplayBlock, { kind: "text" }> =>
            b.kind === "text",
        )
        .map((b) => b.text)
        .join("") ?? "";
    const thinking =
      this.liveTurn?.blocks
        .filter(
          (b): b is Extract<DisplayBlock, { kind: "thinking" }> =>
            b.kind === "thinking",
        )
        .map((b) => b.text)
        .join("") ?? "";
    const toolCalls =
      this.liveTurn?.blocks.filter((b) => b.kind === "tool").length ?? 0;
    const currentTurn = this.liveTurn
      ? {
          output: estimateTokens(text),
          thinking: estimateTokens(thinking),
          toolCalls,
        }
      : undefined;

    const projectValue = this.safeProjectContextInfo();
    return {
      sessionId: this.engine.sessionId,
      updatedAt: Date.now(),
      messageCounts: {
        user: stats.userMessages,
        assistant: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        toolResults: stats.toolResults,
        total: stats.totalMessages,
      },
      tokenUsage: stats.tokens,
      cost: stats.cost,
      ...(stats.contextUsage !== undefined
        ? { context: stats.contextUsage }
        : {}),
      ...(currentTurn !== undefined ? { currentTurn } : {}),
      ...(projectValue !== undefined ? { project: projectValue } : {}),
    };
  }

  private safeProjectContextInfo(): ContextInfo["project"] {
    try {
      return sessionProjectContextInfo(this.engine.sessionId);
    } catch (err) {
      console.warn("Failed to read session Project context:", errorText(err));
      return undefined;
    }
  }

  listInfo(): LiveListInfo {
    const model = this.engine.model as unknown as PiModel | undefined;
    const forkOriginValue = readForkOrigin(this.kind, this.engine.transcript);
    return {
      kind: this.kind,
      harness: this.harness,
      agentType: this.agentType,
      sessionId: this.engine.sessionId,
      file: this.engine.sessionFile,
      title: this.title,
      ...(this.titleGenerationPending ? { titleGenerationPending: true } : {}),
      messageCount: this.engine.stats().totalMessages,
      isStreaming: this.running,
      awaitingInput:
        hasPendingAgentQuestion(this.engine.sessionId) ||
        hasPendingApproval(this.engine.sessionId) ||
        hasChoosingTaskCard(this.engine.sessionId),
      updatedAt: this.updatedAt,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name }
        : undefined,
      thinkingLevel: this.engine.thinkingLevel as ThinkingLevel | undefined,
      ...(forkOriginValue !== undefined ? { forkOrigin: forkOriginValue } : {}),
      forkAutoRenamePending: isForkAutoRenamePending(this.engine.transcript),
    };
  }

  /* ------------------------------- lifecycle ------------------------------- */

  dispose(): void {
    this.disposed = true;
    this.residency.close();
    this.unsubscribe();
    this.unsubscribeQuestions();
    this.unsubscribeApprovals();
    this.unsubscribeTaskChoices();
    this.adapterEvents.clear();
    closeToolGroupSession(this.engine.sessionId);
    void this.engine.dispose();
  }
}
