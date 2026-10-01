/**
 * The pi-backed live session: one long-lived pi agent run decoupled from any
 * socket, with its event mapping, synthetic tool turns, accept flows, and
 * snapshot/state projections. Extracted from hub.ts; the few hub callbacks it
 * needs are inverted behind {@link PiSessionHost}, so this module must never
 * import hub.ts.
 */
import type {
  AgentSession,
  AgentSessionEvent,
  CompactionResult,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentKind,
  CommitDisplay,
  CompactionDisplay,
  ContextClearDisplay,
  PushDisplay,
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
  SessionSkillInvocation,
  SessionState,
  ThinkingLevel,
  WorktreeProvisionDisplay,
} from "@assistant/shared";
import { isCodingAgentType, UNLABELED_SESSION_TITLE } from "@assistant/shared";
import {
  skillInvocationTrail,
  type SkillInvocationToolCall,
  type SkillInvocationTranscript,
} from "../skills/skillInvocations.ts";
import type { AgentUsage } from "@assistant/shared/session";
import { CWD } from "../config.ts";
import { resetMemorySessionContext } from "../memory/memoryRuntime.ts";
import { memoryScheduler } from "../memory/memoryScheduler.ts";
import { buildModelPromptWithAttachments } from "../promptAttachments.ts";
import {
  findModel,
  modelRegistry,
  toModelOption,
  type PiModel,
} from "./models.ts";
import {
  analyzeProviderError,
  providerErrorDisplayText,
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
import { activeSkillsForSession } from "../sessionSkills.ts";
import { worktreeIdForSession } from "../db/worktreeStore.ts";
import { sessionWorktreeMissing } from "../worktrees/sessionCwd.ts";
import type { AgentType } from "../agentTypes.ts";
import {
  HARNESS_IDLE_EVICT_MS,
  type PromptableDriver,
  type Viewer,
} from "../harness.ts";
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
  NativeAdapterEventSource,
  perTurnUsage,
  type AdapterEventListener,
  type CumulativeUsageTotals,
} from "../session/adapters/nativeEvents.ts";
import {
  getAnsweredAgentQuestions,
  getPendingAgentQuestion,
  QUESTION_ANSWERS_MARKER,
  subscribeAgentQuestionChanges,
} from "../tools/core/questionTool.ts";
import { getSettings } from "../settings.ts";
import {
  fallbackSessionTitle,
  generateSessionTitle,
} from "../sessionNaming.ts";
import {
  acceptCommitDryRun,
  formatCommitWorkflowResult,
  toCommitDisplay,
} from "../commitWorkflow.ts";
import { isForkAutoRenamePending, readForkOrigin } from "./forkOrigin.ts";
import {
  prepareToolsForUserTurn,
  toolExposureForSession,
} from "./toolActivation.ts";
import { restorePiLiveTitle, shouldAutoNamePiSession } from "./titleState.ts";
import {
  findOriginTask,
  listRelatedGlobalTasks,
  listSessionTasks,
} from "../tasks.ts";
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
import { peerPromptThreadsFor } from "../peerPrompt.ts";
import { promptQueueField } from "../promptQueue.ts";
import {
  closeToolGroupSession,
  getPendingPostReloadContinuation,
  listBrowserRuntimes,
} from "../mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "../mcp/toolGroups/packRuntime.ts";
import { errorText } from "../errors.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";

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

function forkTitleContext(sm: SessionManager): string {
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

function terminalAssistantError(message: unknown): string | undefined {
  const m = message as
    | { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
    | null
    | undefined;
  if (!m || m.role !== "assistant") return undefined;
  const errorMessage =
    typeof m.errorMessage === "string" ? m.errorMessage : undefined;
  if (m.stopReason === "error") return errorMessage || "Unknown provider error";
  return undefined;
}

function assistantErrorMetadata(message: unknown): {
  api?: string;
  provider?: string;
  model?: string;
  responseId?: string;
} {
  const m = message as
    | {
        api?: unknown;
        provider?: unknown;
        model?: unknown;
        responseId?: unknown;
      }
    | null
    | undefined;
  return {
    ...(typeof m?.api === "string" ? { api: m.api } : {}),
    ...(typeof m?.provider === "string" ? { provider: m.provider } : {}),
    ...(typeof m?.model === "string" ? { model: m.model } : {}),
    ...(typeof m?.responseId === "string" ? { responseId: m.responseId } : {}),
  };
}

/* ----------------------------- block helpers ----------------------------- */

function appendText(
  blocks: DisplayBlock[],
  kind: "text" | "thinking",
  delta: string,
): void {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind) last.text += delta;
  else blocks.push({ kind, text: delta });
}

function updateTool(
  blocks: DisplayBlock[],
  toolId: string,
  patch: Partial<Extract<DisplayBlock, { kind: "tool" }>>,
): void {
  for (const b of blocks)
    if (b.kind === "tool" && b.toolId === toolId) Object.assign(b, patch);
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  // Fast, provider-agnostic live estimate. Completed turns use pi's real provider usage.
  return Math.max(1, Math.ceil(text.length / 4));
}

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
 * The hub-side callbacks a {@link PiLiveSession} needs: session-list
 * broadcasting, dev-reload gating, and workshop git-info refreshes. hub.ts
 * implements it with an object literal closing over the hub instance, keeping
 * this module free of any hub import.
 */
export interface PiSessionHost {
  /** Recompute the merged session list and push it to every connected tab. */
  broadcastSessions(): Promise<void>;
  /** A run just started; cancel any idle-settle countdown for a queued reload. */
  noteRunStarted(): void;
  /** Re-check after a run ends whether a deferred dev reload can now proceed. */
  checkPendingReload(): void;
  /** True while a requested dev reload is pending or already exiting. */
  isReloadQueued(): boolean;
  /** Browser runtimes visible to `sessionId`, for workshop session state. */
  browserRuntimesFor(sessionId: string): ReturnType<typeof listBrowserRuntimes>;
}

/**
 * One long-lived agent run, decoupled from any socket. Multiple {@link Viewer}s
 * (browser tabs) can attach; events are broadcast to all of them, and an
 * atomic {@link snapshot} lets a (re)connecting viewer catch up with no data
 * loss. The underlying {@link AgentSession} keeps running across detach so a run
 * survives a tab close or reconnect.
 */
export class PiLiveSession implements PromptableDriver {
  readonly key: string;
  readonly viewers = new Set<Viewer>();
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
  private retrySettingsBeforeSuppression:
    ReturnType<AgentSession["settingsManager"]["getRetrySettings"]> | undefined;
  /**
   * Cumulative session totals sampled at `agent_start`, so the completed turn's
   * durable usage is THIS run's delta (pi only exposes session-cumulative stats).
   */
  private turnStartTotals: CumulativeUsageTotals | undefined;
  private idCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** Live title; a new conversation uses the stable placeholder until naming settles. */
  title: string | undefined;
  /** True only while the dedicated naming agent is running. */
  private titleGenerationPending = false;
  /** Newest in-memory activity, so a not-yet-persisted session can sort/appear. */
  updatedAt = 0;

  constructor(
    readonly kind: AgentKind,
    readonly session: AgentSession,
    private readonly host: PiSessionHost,
    private readonly onEvict: (key: string) => void,
    private initialNotices: Array<{
      severity: NoticeSeverity;
      message: string;
    }> = [],
    /** Where this session executes: its worktree path, else the app CWD. */
    readonly cwd: string = CWD,
    private mode: SessionMode = "build",
    private readonly onModeChange: (mode: SessionMode) => void = () => {},
  ) {
    this.key = session.sessionId;
    this.unsubscribe = session.subscribe((event) => this.onAgentEvent(event));
    this.unsubscribeQuestions = subscribeAgentQuestionChanges((sessionId) => {
      if (sessionId !== this.session.sessionId) return;
      this.broadcastState();
    });
    this.unsubscribeApprovals = subscribePendingApprovalChanges((sessionId) => {
      if (sessionId !== this.session.sessionId) return;
      this.broadcastState();
    });
    this.unsubscribeTaskChoices = subscribeChoosingTaskCardChanges(
      (sessionId) => {
        if (sessionId !== this.session.sessionId) return;
        this.broadcastState();
      },
    );
    // Hydrate the app-side title from durable native/session-index state before
    // the first registry sync. Reopened sessions start with a fresh PiLiveSession
    // wrapper, so leaving this.title undefined would let the next prompt become
    // the live title and then get persisted back into the session index.
    this.title = restorePiLiveTitle(
      this.session.sessionName,
      sessionStore.get(this.session.sessionId)?.title,
    );
    // Registry sync: record a clean per-session metadata entry. Covers every pi
    // create path (acquireNew / acquireExisting / fork all run through track →
    // the constructor).
    this.syncRegistry();
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** Our session id (= the pi session id; pi sessions are not re-id'd). */
  get id(): string {
    return this.session.sessionId;
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
      const stats = this.session.getSessionStats();
      if (stats.totalMessages === 0) return;
      const model = this.session.model as unknown as PiModel | undefined;
      const thinkingLevelValue = this.session.thinkingLevel as
        string | undefined;
      sessionStore.upsert({
        id: this.session.sessionId,
        harness: "pi",
        agentType: this.kind,
        ...(model?.provider !== undefined ? { provider: model?.provider } : {}),
        providerSessionId: this.session.sessionId,
        ...(model?.id !== undefined ? { model: model?.id } : {}),
        ...(thinkingLevelValue !== undefined
          ? { thinkingLevel: thinkingLevelValue }
          : {}),
        mode: this.mode,
        title: this.title ?? this.session.sessionName ?? "New session",
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
    return this.session.sessionFile;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get canSteer(): boolean {
    return true;
  }

  /* --------------------------------- views --------------------------------- */

  addViewer(v: Viewer): void {
    this.cancelIdle();
    this.viewers.add(v);
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
    this.viewers.delete(v);
    this.armIdle();
  }

  /**
   * Put a session nobody views and nothing runs under the same idle clock a
   * viewer's departure would: the store calls this when it registers a session,
   * so one acquired for a load that was superseded (or a socket that closed)
   * before it could be viewed is evicted like any other idle session instead
   * of staying resident for the process lifetime. It calls it again on every
   * acquisition of a resident session, so a caller about to drive it gets a
   * full grace.
   */
  armIdleIfUnviewed(): void {
    this.armIdle();
  }

  /** Disposed — idled out or removed — so the prompt door refuses it. */
  get released(): boolean {
    return this.disposed;
  }

  broadcastState(): void {
    if (this.viewers.size === 0) return;
    this.broadcast({ type: "state", state: this.state() });
  }

  broadcast(message: ServerMessage): void {
    for (const v of this.viewers) v.send(message);
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
    const model = this.session.model as unknown as PiModel | undefined;
    const metadata = assistantErrorMetadata(message);
    let authMode: ProviderErrorInfo["authMode"] = "unknown";
    try {
      if (model)
        authMode = modelRegistry.isUsingOAuth(model as any)
          ? "subscription"
          : "api_key";
    } catch {
      authMode = "unknown";
    }
    const providerValue = metadata.provider ?? model?.provider;
    const modelValue = metadata.model ?? model?.id;
    return analyzeProviderError(error, {
      ...(providerValue !== undefined ? { provider: providerValue } : {}),
      ...(modelValue !== undefined ? { model: modelValue } : {}),
      ...(metadata.api !== undefined ? { api: metadata.api } : {}),
      ...(metadata.responseId !== undefined
        ? { responseId: metadata.responseId }
        : {}),
      authMode,
    });
  }

  private broadcastContextInfo(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastContextBroadcastAt < 250) return;
    this.lastContextBroadcastAt = now;
    this.broadcast({
      type: "contextInfo",
      sessionId: this.session.sessionId,
      info: this.contextInfo(),
    });
  }

  /* --------------------------------- events -------------------------------- */

  private onAgentEvent(event: AgentSessionEvent): void {
    const sessionId = this.session.sessionId;
    switch (event.type) {
      case "agent_start": {
        this.cancelIdle();
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
        if (this.retrySettingsBeforeSuppression) {
          this.session.settingsManager.applyOverrides({
            retry: this.retrySettingsBeforeSuppression,
          });
          this.retrySettingsBeforeSuppression = undefined;
        }
        this.currentAssistantError = undefined;
        this.currentAssistantErrorInfo = undefined;
        this.currentAssistantAborted = false;
        this.explicitAbortRequested = false;
        this.providerTransportFailure = {};
        this.broadcastContextInfo(true);
        // Surface the running indicator in every tab's sidebar.
        void this.host.broadcastSessions();
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
        }
        break;
      }
      case "message_end": {
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
          if (shouldSuppressProviderRetry(this.currentAssistantErrorInfo)) {
            if (!this.retrySettingsBeforeSuppression)
              this.retrySettingsBeforeSuppression =
                this.session.settingsManager.getRetrySettings();
            this.session.settingsManager.applyOverrides({
              retry: { ...this.retrySettingsBeforeSuppression, maxRetries: 0 },
            });
          }
          console.error(this.currentAssistantError);
        }
        break;
      }
      case "auto_retry_start": {
        const retryError = this.providerErrorInfo(event.errorMessage);
        if (this.awaitingRetryContinuation && !this.retryAttemptError)
          this.retryAttemptError = providerErrorDisplayText(retryError);
        if (shouldSuppressProviderRetry(retryError)) {
          this.session.abortRetry();
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
        void memoryScheduler.flushBeforeReset(this.session.sessionId);
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
          resetMemorySessionContext(this.session.sessionId);
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
          void this.host.broadcastSessions();
        }
        break;
      }
      case "agent_end": {
        // The maxRetries=0 suppression override should already make willRetry
        // false; retain the settings guard defensively for SDK event snapshots.
        const retryContinues =
          event.willRetry && !this.retrySettingsBeforeSuppression;
        if (!retryContinues) break;
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
          const model = (this.session.model as unknown as PiModel | undefined)
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
        void this.host.broadcastSessions();
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
        if (id) {
          this.broadcast({
            type: "assistantEnd",
            sessionId,
            id,
            ...(error !== undefined ? { error } : {}),
            ...(errorInfo !== undefined ? { errorInfo } : {}),
            ...(aborted ? { aborted: true } : {}),
          });
          const model = (this.session.model as unknown as PiModel | undefined)
            ?.id;
          const usage = this.turnUsage();
          this.adapterEvents.messageCompleted(id, {
            ...(model ? { model } : {}),
            ...(usage ? { usage } : {}),
            ...(error ? { errorMessage: error } : {}),
            ...(aborted ? { aborted: true } : {}),
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
        this.armIdle();
        void this.host.broadcastSessions();
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
        void this.host.broadcastSessions();
        break;
      }
      default:
        break;
    }
  }

  /* -------------------------------- commands ------------------------------- */

  /**
   * Open a host-driven ("synthetic") assistant turn carrying one in-progress tool
   * block — the shared primitive behind every slash command. The matching
   * `finish*` method ends the turn. See {@link SyntheticToolHost}.
   */
  beginSyntheticTool(
    name: string,
    args: unknown,
  ): { assistantId: string; toolId: string } {
    if (this.running)
      throw new SessionBusyError(
        this.session.sessionId,
        "Cannot run a slash command while the agent is streaming.",
      );
    if (this.host.isReloadQueued()) throw new Error(RELOAD_QUEUED_MESSAGE);

    this.cancelIdle();
    this.running = true;
    this.host.noteRunStarted();
    const assistantId = `a${++this.idCounter}`;
    const toolId = `slash-${Date.now()}-${this.idCounter}`;
    this.currentAssistantId = assistantId;
    this.syntheticToolId = toolId;
    this.liveTurn = {
      id: assistantId,
      role: "assistant",
      blocks: [
        {
          kind: "tool",
          toolId,
          name,
          args,
          output: "Starting…",
          isError: false,
          done: false,
        },
      ],
      streaming: true,
    };
    this.updatedAt = Date.now();
    this.broadcast({
      type: "assistantStart",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageStarted(assistantId);
    this.broadcast({
      type: "toolStart",
      sessionId: this.session.sessionId,
      id: assistantId,
      toolId,
      name,
      args,
    });
    this.adapterEvents.toolStarted(toolId, name, args);
    this.broadcast({
      type: "toolUpdate",
      sessionId: this.session.sessionId,
      id: assistantId,
      toolId,
      output: "Starting…",
    });
    this.adapterEvents.toolUpdated(toolId, "Starting…");
    this.broadcastState();
    this.broadcastContextInfo(true);
    void this.host.broadcastSessions();
    return { assistantId, toolId };
  }

  updateSyntheticTool(output: string): void {
    const id = this.currentAssistantId;
    const toolId = this.syntheticToolId;
    if (!id || !toolId || !this.liveTurn) return;
    updateTool(this.liveTurn.blocks, toolId, { output });
    this.broadcast({
      type: "toolUpdate",
      sessionId: this.session.sessionId,
      id,
      toolId,
      output,
    });
    this.adapterEvents.toolUpdated(toolId, output);
  }

  discardSyntheticTool(): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.hostCommandDiscarded();
    this.endSyntheticTurn();
  }

  finishSyntheticTool(toolId: string, output: string, isError = false): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    updateTool(this.liveTurn.blocks, toolId, { output, isError, done: true });
    const toolEnd = {
      type: "toolEnd" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      toolId,
      output,
      isError,
    };
    this.broadcast(toolEnd);
    this.adapterEvents.toolCompleted(toolEnd);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
      ...(isError ? { error: output } : {}),
    });
    this.adapterEvents.messageCompleted(assistantId, {
      ...(isError ? { errorMessage: output } : {}),
    });
    this.endSyntheticTurn();
  }

  finishSyntheticCommit(commit: CommitDisplay): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.liveTurn.blocks = [{ kind: "commit", commit }];
    const envelope = {
      type: "commitResult" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      commit,
    };
    this.broadcast(envelope);
    this.adapterEvents.hostCommandCard(
      "commit",
      { kind: "commit", id: assistantId, commit },
      envelope,
    );
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    // The working tree changed (or was inspected); refresh the workspace badge.
    this.endSyntheticTurn();
  }

  finishSyntheticPush(push: PushDisplay): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.liveTurn.blocks = [{ kind: "push", push }];
    const envelope = {
      type: "pushResult" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      push,
    };
    this.broadcast(envelope);
    this.adapterEvents.hostCommandCard(
      "push",
      { kind: "push", id: assistantId, push },
      envelope,
    );
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.endSyntheticTurn();
  }

  finishSyntheticWorktreeProvision(provision: WorktreeProvisionDisplay): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.liveTurn.blocks = [{ kind: "worktreeProvision", provision }];
    const envelope = {
      type: "worktreeProvisionResult" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      provision,
    };
    this.broadcast(envelope);
    this.adapterEvents.hostCommandCard(
      "worktree",
      { kind: "worktreeProvision", id: assistantId, provision },
      envelope,
    );
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.endSyntheticTurn();
  }

  finishSyntheticContextClear(contextClear: ContextClearDisplay): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.liveTurn.blocks = [{ kind: "contextClear", contextClear }];
    const envelope = {
      type: "contextClearResult" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      contextClear,
    };
    this.broadcast(envelope);
    this.adapterEvents.hostCommandCard(
      "contextClear",
      { kind: "contextClear", id: assistantId, contextClear },
      envelope,
    );
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.endSyntheticTurn();
  }

  finishSyntheticCompaction(compaction: CompactionDisplay): void {
    const assistantId = this.currentAssistantId;
    if (!assistantId || !this.liveTurn) return;
    this.liveTurn.blocks = [{ kind: "compaction", compaction }];
    const envelope = {
      type: "compactionResult" as const,
      sessionId: this.session.sessionId,
      id: assistantId,
      compaction,
    };
    this.broadcast(envelope);
    this.adapterEvents.hostCommandCard(
      "compaction",
      { kind: "compaction", id: assistantId, compaction },
      envelope,
    );
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.session.sessionId,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
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
    this.armIdle();
    void this.host.broadcastSessions();
    this.host.checkPendingReload();
  }

  /** Minimal session context the commit workflow needs (its real sessionManager). */
  commitWorkflowContext(): { sessionManager: unknown; cwd?: string } {
    return { sessionManager: this.session.sessionManager, cwd: this.cwd };
  }

  async acceptCommitDryRun(entryId: string): Promise<void> {
    if (this.running)
      throw new Error(
        "Cannot accept a commit dry run while the agent is streaming.",
      );
    if (this.host.isReloadQueued()) throw new Error(RELOAD_QUEUED_MESSAGE);
    this.cancelIdle();
    this.running = true;
    this.host.noteRunStarted();
    this.currentAssistantId = `a${++this.idCounter}`;
    this.syntheticToolId = `accept-${Date.now()}-${this.idCounter}`;
    this.liveTurn = {
      id: this.currentAssistantId,
      role: "assistant",
      blocks: [
        {
          kind: "tool",
          toolId: this.syntheticToolId,
          name: "/commit accept",
          args: { entryId },
          output: "Starting…",
          isError: false,
          done: false,
        },
      ],
      streaming: true,
    };
    this.updatedAt = Date.now();
    this.broadcast({
      type: "assistantStart",
      sessionId: this.session.sessionId,
      id: this.currentAssistantId,
    });
    this.adapterEvents.messageStarted(this.currentAssistantId);
    this.broadcast({
      type: "toolStart",
      sessionId: this.session.sessionId,
      id: this.currentAssistantId,
      toolId: this.syntheticToolId,
      name: "/commit accept",
      args: { entryId },
    });
    this.adapterEvents.toolStarted(this.syntheticToolId, "/commit accept", {
      entryId,
    });
    this.broadcastState();
    void this.host.broadcastSessions();

    let output = "";
    let isError = false;
    try {
      const result = await acceptCommitDryRun({
        session: this.session,
        entryId,
        cwd: this.cwd,
        onProgress: (message) => this.updateSyntheticTool(message),
      });
      output = formatCommitWorkflowResult(result);
      const commit = toCommitDisplay(result);
      if (this.liveTurn) this.liveTurn.blocks = [{ kind: "commit", commit }];
      if (this.currentAssistantId) {
        const envelope = {
          type: "commitResult" as const,
          sessionId: this.session.sessionId,
          id: this.currentAssistantId,
          commit,
        };
        this.broadcast(envelope);
        this.adapterEvents.hostCommandCard(
          "commit",
          { kind: "commit", id: this.currentAssistantId, commit },
          envelope,
        );
      }
      if (isCodingAgentType(this.kind) && result.status === "committed") {
        this.broadcastState();
      }
    } catch (err) {
      isError = true;
      output = errorText(err);
    }

    const assistantId = this.currentAssistantId;
    const toolId = this.syntheticToolId;
    if (assistantId && toolId && this.liveTurn) {
      if (isError) {
        updateTool(this.liveTurn.blocks, toolId, {
          output,
          isError,
          done: true,
        });
        const toolEnd = {
          type: "toolEnd" as const,
          sessionId: this.session.sessionId,
          id: assistantId,
          toolId,
          output,
          isError,
        };
        this.broadcast(toolEnd);
        this.adapterEvents.toolCompleted(toolEnd);
      }
      this.broadcast({
        type: "assistantEnd",
        sessionId: this.session.sessionId,
        id: assistantId,
        ...(isError ? { error: output } : {}),
      });
      this.adapterEvents.messageCompleted(assistantId, {
        ...(isError ? { errorMessage: output } : {}),
      });
    }

    this.running = false;
    this.currentAssistantId = undefined;
    this.syntheticToolId = undefined;
    this.liveTurn = undefined;
    this.updatedAt = Date.now();
    this.broadcastState();
    this.broadcastContextInfo(true);
    if (this.viewers.size > 0) sessionStore.markRead(this.key, this.updatedAt);
    this.armIdle();
    void this.host.broadcastSessions();
    this.host.checkPendingReload();
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
      setModel: (model) =>
        this.setModel(model as Parameters<AgentSession["setModel"]>[0]),
      setThinkingLevel: (level) =>
        this.setThinkingLevel(level as ThinkingLevel),
      completionMetadata: () => {
        const model = (this.session.model as unknown as PiModel | undefined)
          ?.id;
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

  #promptRaw(
    text: string,
    attachments: PromptAttachment[] = [],
    options: {
      hidden?: boolean;
      clientRequestId?: string;
      steerOnly?: boolean;
    } = {},
  ): PiPromptResponse {
    const trimmedInput = text.trim();
    if (!trimmedInput && attachments.length === 0) return "ignored";

    // The authoritative streaming read and the decision it drives happen HERE,
    // with nothing in between. A caller that asked to steer and only steer gets
    // "ignored" rather than a turn it never asked to start — the runtime's own
    // `runState` check ran earlier and may already be stale by now.
    if (options.steerOnly && !this.session.isStreaming) return "ignored";

    // Idempotent on clientRequestId: a duplicate submit (double-click, reconnect
    // resend) is a no-op so it can't open a second turn or echo a second bubble.
    if (options.clientRequestId) {
      if (this.handledRequestIds.has(options.clientRequestId)) return "ignored";
      this.handledRequestIds.add(options.clientRequestId);
    }

    if (this.host.isReloadQueued() && !this.session.isStreaming) {
      this.notice("warning", RELOAD_QUEUED_MESSAGE);
      return "ignored";
    }

    const promptText = trimmedInput || "Please analyze the attached file(s).";
    const { promptWithFiles, images } = buildModelPromptWithAttachments(
      this.session.sessionId,
      promptText,
      attachments,
    );

    const storedTitle =
      this.title ?? sessionStore.get(this.session.sessionId)?.title;
    const shouldAutoName = shouldAutoNamePiSession({
      sessionManager: this.session.sessionManager,
      ...(this.session.sessionName !== undefined
        ? { nativeSessionName: this.session.sessionName }
        : {}),
      ...(storedTitle !== undefined ? { storedTitle } : {}),
    });
    const namingSettings = shouldAutoName
      ? getSettings().sessionNaming
      : undefined;
    const shouldAutoNameFork =
      !this.session.isStreaming &&
      isForkAutoRenamePending(this.session.sessionManager);
    const forkNamingContext = shouldAutoNameFork
      ? forkTitleContext(this.session.sessionManager)
      : undefined;
    const forkOriginalName = shouldAutoNameFork
      ? this.session.sessionName
      : undefined;
    this.title ??= restorePiLiveTitle(this.session.sessionName, storedTitle);
    if (shouldAutoName) {
      this.title ??= namingSettings?.enabled
        ? UNLABELED_SESSION_TITLE
        : fallbackSessionTitle(promptText, attachments);
      this.titleGenerationPending = Boolean(namingSettings?.enabled);
    }
    const now = Date.now();
    prepareToolsForUserTurn(
      this.session.sessionId,
      this.updatedAt > 0 ? now - this.updatedAt : 0,
    );
    this.updatedAt = now;
    const blocks: DisplayBlock[] = [{ kind: "text", text: promptText }];
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
        sessionId: this.session.sessionId,
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
    const wasRunning = this.running || this.session.isStreaming;
    if (!wasRunning) {
      this.cancelIdle();
      this.running = true;
      this.host.noteRunStarted();
    }
    const run = this.session.isStreaming
      ? this.session.steer(promptWithFiles, images)
      : this.session.prompt(promptWithFiles, { images });
    if (options.steerOnly) {
      // A refused `steerOnly` is expected control flow, not a provider failure:
      // the adapter reports it as `steered: false` and delivery retries. Routing
      // it through `finishPromptError` would post an error banner and — once the
      // original turn has cleared — manufacture a synthetic assistant error turn
      // and adapter events for a message that was never meant to be sent.
      void run.then(emitUserMessage, () => {});
    } else run.catch((err: unknown) => this.finishPromptError(err, wasRunning));
    // The chat should appear in every tab the moment its first prompt is sent.
    if (this.viewers.size > 0) sessionStore.markRead(this.key, this.updatedAt);
    void this.host.broadcastSessions();
    if (shouldAutoName && namingSettings?.enabled)
      void this.autoNameFromFirstPrompt(
        promptText,
        attachments,
        namingSettings,
      );
    if (shouldAutoNameFork)
      void this.autoNameForkFromFirstPrompt(
        promptText,
        forkNamingContext,
        forkOriginalName,
        attachments,
      );
    return { outcome: wasRunning ? "steered" : "started", completed: run };
  }

  private finishPromptError(err: unknown, wasRunning: boolean): void {
    const message = `Failed to send prompt: ${errorText(err)}`;
    this.notice("error", message);

    // If this was a queued steer/follow-up while the agent is already running,
    // keep the active turn intact and only surface the banner above.
    if (wasRunning && this.running && this.currentAssistantId) return;

    this.running = false;
    const sessionId = this.session.sessionId;
    const retryEndedBetweenAttempts =
      !this.currentAssistantId && this.awaitingRetryContinuation;
    if (retryEndedBetweenAttempts) {
      this.adapterEvents.runCompleted("error", message);
    } else {
      const id = this.currentAssistantId ?? `a${++this.idCounter}`;
      if (!this.currentAssistantId) {
        this.broadcast({ type: "assistantStart", sessionId, id });
        this.adapterEvents.messageStarted(id);
      }
      this.broadcast({ type: "assistantEnd", sessionId, id, error: message });
      this.adapterEvents.messageCompleted(id, { errorMessage: message });
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
    this.armIdle();
    void this.host.broadcastSessions();
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
      if (this.session.sessionName) return;
      this.rename(generatedTitle ?? fallbackSessionTitle(prompt, attachments));
      await this.host.broadcastSessions();
    } finally {
      // A manual rename may have spent this already; every other exit must stop
      // looking like naming work is still happening.
      if (this.titleGenerationPending) {
        this.titleGenerationPending = false;
        await this.host.broadcastSessions();
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
      if (!title || this.session.sessionName !== originalName) return;
      this.rename(title);
      await this.host.broadcastSessions();
    } catch (err) {
      console.warn("Failed to auto-name forked session:", errorText(err));
    }
  }

  async abort(): Promise<void> {
    if (this.running) {
      this.currentAssistantAborted = true;
      this.explicitAbortRequested = true;
    }
    await this.session.abort();
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
      await this.session.compact(customInstructions);
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
    if (this.session.messages.length === 0)
      return {
        kind: "skipped",
        reason: "Nothing to clear — this session has no context yet.",
      };
    const tokensBefore = this.session.getSessionStats().contextUsage?.tokens;
    this.session.sessionManager.resetLeaf();
    this.session.state.messages = [];
    this.broadcastContextInfo(true);
    return {
      kind: "cleared",
      ...(tokensBefore != null ? { tokensBefore } : {}),
    };
  }

  async setModel(
    model: Parameters<AgentSession["setModel"]>[0],
  ): Promise<void> {
    await this.session.setModel(model);
    this.broadcastState();
    this.broadcastContextInfo(true);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.session.setThinkingLevel(level);
    this.broadcastState();
    this.broadcastContextInfo(true);
  }

  get sessionMode(): SessionMode {
    return this.mode;
  }

  /** Apply + persist the per-turn tool policy immediately for the next turn. */
  setMode(mode: SessionMode): void {
    if (this.mode === mode) return;
    this.onModeChange(mode);
    this.mode = mode;
    sessionStore.upsert({
      id: this.sessionId,
      harness: "pi",
      agentType: this.kind,
      mode,
    });
    this.broadcastState();
  }

  rename(title: string): void {
    // `setSessionName` may emit synchronously; spend the working state first so
    // no broadcast ever shows a final title with the pending treatment.
    this.titleGenerationPending = false;
    this.session.setSessionName(title);
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
    const branch = this.session.sessionManager.getBranch() as Parameters<
      typeof serializeSessionBranch
    >[0];
    const ctx = { kind: this.kind, sessionId: this.session.sessionId };
    if (!this.liveTurn)
      return withPullRequestCardBlocks(
        withApprovalBlocks(
          hideMarkedMessages(serializeSessionBranch(branch, ctx)),
          this.session.sessionId,
        ),
        this.session.sessionId,
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
        this.session.sessionId,
      ),
      this.session.sessionId,
    );
  }

  /**
   * Library-skill loads in the persisted branch: pi's prompt asks the model to
   * `read` a skill's SKILL.md, so that read is the invocation. The branch, not
   * `state.messages`, is walked — a context clear empties the latter.
   */
  private skillInvocations(frozenNames: string[]): SessionSkillInvocation[] {
    return skillInvocationTrail(frozenNames, this.branchToolCalls());
  }

  private branchToolCalls(): SkillInvocationTranscript {
    const calls: SkillInvocationToolCall[] = [];
    const succeeded = new Set<string>();
    for (const entry of this.session.sessionManager.getBranch()) {
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
      if (message?.role !== "assistant" || !Array.isArray(message.content))
        continue;
      const at = typeof message.timestamp === "number" ? message.timestamp : 0;
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
          });
      }
    }
    return { calls, succeeded };
  }

  state(): SessionState {
    const model = this.session.model as unknown as PiModel | undefined;
    const forkOriginValue = readForkOrigin(
      this.kind,
      this.session.sessionManager,
    );
    const idleReasonValue = getPendingAgentQuestion(this.session.sessionId)
      ? "awaiting_question"
      : hasPendingApproval(this.session.sessionId)
        ? "awaiting_approval"
        : hasChoosingTaskCard(this.session.sessionId)
          ? "awaiting_task_choice"
          : undefined;
    const pendingQuestionValue = getPendingAgentQuestion(
      this.session.sessionId,
    );
    const originTaskValue = this.safeOriginTask();
    const toolExposureValue = toolExposureForSession(this.session.sessionId);
    const activeSkillsValue = activeSkillsForSession(
      this.session.sessionId,
      this.kind,
    );
    const pendingPostReloadContinuationValue = getPendingPostReloadContinuation(
      this.session.sessionId,
    );
    const worktreeIdValue = this.safeWorktreeId();
    return {
      sessionId: this.session.sessionId,
      harness: this.harness,
      agentType: this.agentType,
      ...(forkOriginValue !== undefined ? { forkOrigin: forkOriginValue } : {}),
      ...(model ? { model: toModelOption(model) as ModelOption } : {}),
      thinkingLevel: this.session.thinkingLevel as ThinkingLevel,
      mode: this.mode,
      canSteer: this.canSteer,
      ...(idleReasonValue !== undefined ? { idleReason: idleReasonValue } : {}),
      ...(pendingQuestionValue !== undefined
        ? { pendingQuestion: pendingQuestionValue }
        : {}),
      answeredQuestions: getAnsweredAgentQuestions(this.session.sessionId),
      tasks: this.safeSessionTasks(),
      relatedGlobalTasks: this.safeRelatedGlobalTasks(),
      ...(originTaskValue !== undefined ? { originTask: originTaskValue } : {}),
      ...(toolExposureValue !== undefined
        ? { toolExposure: toolExposureValue }
        : {}),
      ...(activeSkillsValue !== undefined
        ? {
            activeSkills: activeSkillsValue,
            skillInvocations: this.skillInvocations(activeSkillsValue),
          }
        : {}),
      ...(isCodingAgentType(this.kind)
        ? { artifacts: listSessionArtifacts(this.session.sessionId) }
        : {}),
      // Dev-supervisor reload continuation is a Workshop-only (local dev) concept.
      ...(this.kind === "workshop"
        ? {
            ...(pendingPostReloadContinuationValue !== undefined
              ? {
                  pendingPostReloadContinuation:
                    pendingPostReloadContinuationValue,
                }
              : {}),
          }
        : {}),
      ...(isCodingAgentType(this.kind)
        ? {
            browserRuntimes: this.host.browserRuntimesFor(
              this.session.sessionId,
            ),
          }
        : {}),
      peerPrompts: peerPromptThreadsFor(this.session.sessionId),
      ...promptQueueField(this.session.sessionId),
      ...(worktreeIdValue !== undefined ? { worktreeId: worktreeIdValue } : {}),
      ...(this.safeWorktreeMissing() ? { worktreeMissing: true } : {}),
    };
  }

  private safeWorktreeId(): string | undefined {
    try {
      return worktreeIdForSession(this.session.sessionId);
    } catch (err) {
      console.warn("Failed to read session worktree link:", errorText(err));
      return undefined;
    }
  }

  /** The linked worktree is gone and the user has not acknowledged it (Task 321). */
  private safeWorktreeMissing(): boolean {
    try {
      return sessionWorktreeMissing(this.session.sessionId);
    } catch (err) {
      console.warn("Failed to check session worktree:", errorText(err));
      return false;
    }
  }

  private safeSessionTasks(): ReturnType<typeof listSessionTasks> {
    try {
      return listSessionTasks(this.kind, this.session.sessionId);
    } catch (err) {
      console.warn("Failed to read Session Tasks:", errorText(err));
      return [];
    }
  }

  private safeRelatedGlobalTasks(): ReturnType<typeof listRelatedGlobalTasks> {
    try {
      return listRelatedGlobalTasks(this.kind, this.session.sessionId);
    } catch (err) {
      console.warn("Failed to read related Tasks:", errorText(err));
      return [];
    }
  }

  private safeOriginTask(): ReturnType<typeof findOriginTask> {
    try {
      return findOriginTask(this.session.sessionId);
    } catch (err) {
      console.warn("Failed to read origin Task:", errorText(err));
      return undefined;
    }
  }

  /** Cumulative billed totals across the whole session, from pi's native stats. */
  private cumulativeTotals(): CumulativeUsageTotals {
    const stats = this.session.getSessionStats();
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
    const stats = this.session.getSessionStats();
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
    const stats = this.session.getSessionStats();
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
      sessionId: this.session.sessionId,
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
      return sessionProjectContextInfo(this.session.sessionId);
    } catch (err) {
      console.warn("Failed to read session Project context:", errorText(err));
      return undefined;
    }
  }

  listInfo(): LiveListInfo {
    const model = this.session.model as unknown as PiModel | undefined;
    const forkOriginValue = readForkOrigin(
      this.kind,
      this.session.sessionManager,
    );
    return {
      kind: this.kind,
      harness: this.harness,
      agentType: this.agentType,
      sessionId: this.session.sessionId,
      file: this.session.sessionFile,
      title: this.title,
      ...(this.titleGenerationPending ? { titleGenerationPending: true } : {}),
      messageCount: this.session.getSessionStats().totalMessages,
      isStreaming: this.running,
      awaitingInput:
        Boolean(getPendingAgentQuestion(this.session.sessionId)) ||
        hasPendingApproval(this.session.sessionId) ||
        hasChoosingTaskCard(this.session.sessionId),
      updatedAt: this.updatedAt,
      model: model
        ? { provider: model.provider, id: model.id, name: model.name }
        : undefined,
      thinkingLevel: this.session.thinkingLevel as ThinkingLevel | undefined,
      ...(forkOriginValue !== undefined ? { forkOrigin: forkOriginValue } : {}),
      forkAutoRenamePending: isForkAutoRenamePending(
        this.session.sessionManager,
      ),
    };
  }

  /* ------------------------------- lifecycle ------------------------------- */

  private armIdle(): void {
    this.cancelIdle();
    if (this.disposed || this.viewers.size > 0 || this.running) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.viewers.size > 0 || this.running) return;
      // A prompt admitted at the door but not yet running is activity too, and
      // nothing re-arms the clock if it fails before it runs: look again later.
      if (sessionRuntime.isBusy(this.key)) {
        this.armIdle();
        return;
      }
      this.dispose();
      this.onEvict(this.key);
    }, HARNESS_IDLE_EVICT_MS);
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelIdle();
    this.unsubscribe();
    this.unsubscribeQuestions();
    this.unsubscribeApprovals();
    this.unsubscribeTaskChoices();
    this.adapterEvents.clear();
    closeToolGroupSession(this.session.sessionId);
    this.session.dispose();
  }
}
