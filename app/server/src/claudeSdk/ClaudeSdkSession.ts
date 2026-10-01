/**
 * An in-process Claude session driven by the Claude Agent SDK.
 *
 * This session owns the conversation: it drives `seam.query(...)`, consumes the
 * SDK message stream, and emits this repo's websocket envelopes directly. Raw
 * prompting is private; app code drives it through the normalized runtime
 * adapter/facade.
 *
 * STREAMING STRATEGY (avoids double-counting):
 *   - TEXT and THINKING blocks of the live turn are built ONLY from `stream_event`
 *     deltas (text_delta → appendText("text") + textDelta; thinking_delta →
 *     appendText("thinking") + thinkingDelta). The committed `assistant` message is
 *     NOT used to append text/thinking.
 *   - The committed `assistant` message is used ONLY to open tool blocks with their
 *     FULL `input` as `args` (toolStart) for any tool_use not already started, and
 *     to capture message id / model / usage.
 *   - `tool_result` `user` messages finalize tools (updateTool done + toolEnd).
 *   - The `result` message ends the turn: commit the live turn, assistantEnd →
 *     history → state, persist, maybeAutoName.
 *
 * SUB-MESSAGE IDENTITY:
 *   One provider turn emits thinking/text/tool blocks as SEPARATE `assistant`
 *   messages sharing the turn's `message.id`, interleaved with stream deltas. We
 *   track `#streamMessageId` (from message_start) and a per-block tool-id map so
 *   that thinking-then-text produce separate blocks in order, and `input_json_delta`
 *   events (which lack a tool id) are attributed to the right tool block.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentKind,
  BrowserRuntimeInfo,
  CommitDisplay,
  CompactionDisplay,
  ContextClearDisplay,
  ContextInfo,
  DisplayBlock,
  DisplayMessage,
  Harness,
  ModelOption,
  PromptAttachment,
  PushDisplay,
  SessionForkOrigin,
  SessionMode,
  SessionNamingSettings,
  SessionState,
  SessionSkillInvocation,
  SessionToolExposure,
  SessionToolLoadEvent,
  ThinkingLevel,
  WorktreeProvisionDisplay,
} from "@assistant/shared";
import {
  isCodingAgentType,
  sessionModeOrDefault,
  UNLABELED_SESSION_TITLE,
} from "@assistant/shared";
import {
  displayMessageCount,
  entriesToDisplayMessages,
} from "@assistant/shared/display";
import type {
  AgentContentBlock,
  AgentUsage,
  PromptDelivery,
} from "@assistant/shared/session";
import type {
  ClientTimelineEntry,
  HostCommandCard,
} from "@assistant/shared/runtime";
import { createClaudeSessionToolServer } from "./toolServer.ts";
import type { SessionToolServer } from "../mcp/sessionToolServer.ts";
import {
  closeToolGroupSession,
  hasToolGroupSession,
  getPendingPostReloadContinuation,
} from "../mcp/toolGroups/registry.ts";
import {
  listSessionArtifacts,
  removeSessionArtifact,
} from "../mcp/toolGroups/packRuntime.ts";
import { buildCommitSessionManager } from "../claudeCommitContext.ts";
import {
  buildModelPromptWithAttachments,
  type ImageContentLike,
} from "../promptAttachments.ts";
import { removeAgentTempTree } from "../agentTempTree.ts";
import type { AgentType } from "../agentTypes.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import {
  integrationGatedActiveToolNames,
  eagerToolNamesFor,
  modeGatedActiveToolNames,
} from "../tools/catalog.ts";
import { externalToolName, MCP_SERVER_NAME } from "../mcp/names.ts";
import {
  buildToolExposure,
  toolDefinitionChars,
} from "../tools/toolExposure.ts";
import {
  sessionPromptConditions,
  type PromptConditions,
} from "../promptConditions.ts";
import { activeSkillsForSession } from "../sessionSkills.ts";
import {
  skillInvocationTrail,
  type SkillInvocationToolCall,
  type SkillInvocationTranscript,
} from "../skills/skillInvocations.ts";
import {
  fallbackSessionTitle,
  generateSessionTitle,
} from "../sessionNaming.ts";
import { getSettings } from "../settings.ts";
import { childProcessEnv } from "../subprocessEnv.ts";
import { CWD } from "../config.ts";
import { claudeProfileEnvironment } from "../credentialProfiles.ts";
import {
  getAnsweredAgentQuestions,
  getPendingAgentQuestion,
  relinkAgentQuestionToolCallId,
  subscribeAgentQuestionChanges,
} from "../tools/core/questionTool.ts";
import { HARNESS_IDLE_EVICT_MS, type Viewer } from "../harness.ts";
import type {
  HostClearOutcome,
  HostCompactionOutcome,
} from "../hostSlashCommands.ts";
import { resetMemorySessionContext } from "../memory/memoryRuntime.ts";
import { memoryScheduler } from "../memory/memoryScheduler.ts";
import {
  createClaudeSdkAdapter,
  type ClaudeSdkAdapterDriver,
} from "../session/adapters/claudeSdk.ts";
import type { PromptableAdapter } from "../session/adapters/contract.ts";
import {
  NativeAdapterEventSource,
  perTurnUsage,
  type AdapterEventListener,
  type CumulativeUsageTotals,
} from "../session/adapters/nativeEvents.ts";
import type {
  ClaudeSdkRecord,
  ClaudeSdkRecordMeta,
  ClaudeSdkUsageRecord,
} from "./claudeSdkRecords.ts";
import { worktreeIdForSession } from "../db/worktreeStore.ts";
import { sessionWorktreeMissing } from "../worktrees/sessionCwd.ts";
import {
  approvalsForSession,
  hasPendingApproval,
  subscribePendingApprovalChanges,
  withApprovalBlocks,
} from "../pendingApprovals.ts";
import {
  cardsForSession,
  hasChoosingTaskCard,
  subscribeChoosingTaskCardChanges,
  withPullRequestCardBlocks,
} from "../pullRequestCards.ts";
import { sessionRunStartedAt } from "../sessionActivity.ts";
import { drainRecipient, peerPromptThreadsFor } from "../peerPrompt.ts";
import { promptQueueField } from "../promptQueue.ts";
import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";
import { captureTaskOutputArtifact } from "../outputPolicy.ts";
import { peerPromptStore } from "../db/peerPromptStore.ts";
import {
  beginRuntimeProviderTurn,
  type RuntimePromptDriver,
} from "../session/runtimePrompt.ts";
import { SessionBusyError } from "../session/runtime/errors.ts";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";
import {
  backgroundWorkDescription,
  backgroundWorkTitle,
} from "../backgroundWork/title.ts";
import { analyzeProviderError } from "../providerErrors.ts";
import {
  claudeBackgroundWorkBackend,
  registerClaudeBackgroundWorkBackend,
} from "./backgroundWorkBackend.ts";
import {
  assistantMessageId,
  assistantModel,
  assistantProviderError,
  assistantUsage,
  captureSessionId,
  type ClaudeUsage,
  type CompactBoundary,
  compactBoundaryMetadata,
  contextSizeFromUsage,
  isToolResultUserMessage,
  mapAssistantBlocks,
  mapResultMeta,
  mapResultEpochUsage,
  mapToolResults,
  resultProviderError,
} from "./messageMapper.ts";
import { buildClaudeSdkQueryOptions } from "./options.ts";
import { prepareClaudeSkillRuntime } from "./skillInjection.ts";
import {
  claudeSdkModelAlias,
  claudeSdkModelId,
  claudeSdkModelOption,
  reasoningToThinking,
  knownClaudeSdkModelAlias,
} from "./modelSettings.ts";
import type {
  ClaudeQuery,
  ClaudeSdkMessage,
  ClaudeSdkSeam,
  ClaudeSdkUserMessage,
} from "./sdkSeam.ts";
import {
  mapStreamEvent,
  streamBlockIndex,
  streamMessageStartId,
  streamMessageStartUsage,
  streamToolBlockId,
} from "./streamMapper.ts";

const DEFAULT_TITLE = "New Claude SDK";
/** How long a Stop waits for the CLI to confirm it dropped queued steers. */
const STEER_CANCEL_TIMEOUT_MS = 2_000;

interface ClaudeTaskOutputTemp {
  tmpDir: string;
  outputRoot: string;
}

/** Give Claude one private temp tree per process epoch. */
function createClaudeTaskOutputTemp(): ClaudeTaskOutputTemp {
  const tmpDir = mkdtempSync(join(tmpdir(), `pa-claude-${process.pid}-`));
  try {
    chmodSync(tmpDir, 0o700);
    const uid = process.getuid?.();
    const outputRoot =
      uid === undefined ? tmpDir : join(tmpDir, `claude-${uid}`);
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    chmodSync(outputRoot, 0o700);
    const rootStat = lstatSync(outputRoot);
    if (
      !rootStat.isDirectory() ||
      (uid !== undefined && rootStat.uid !== uid) ||
      (rootStat.mode & 0o777) !== 0o700
    )
      throw new Error("Claude task output root failed its ownership check");
    return { tmpDir, outputRoot };
  } catch (error) {
    // Never let cleanup mask the ownership failure that brought us here.
    removeAgentTempTree(tmpDir);
    throw error;
  }
}

/* ----------------------------- block helpers ----------------------------- */
// Copied (not exported from hub) per the module contract.

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

/** Fast, provider-agnostic live token estimate (mirrors the pi harness). */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function textFromContent(content: readonly AgentContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<AgentContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("")
    .trim();
}

function normalizedToolName(name: string | undefined): string {
  const value = (name ?? "").trim();
  const parts = value.split("__");
  return parts[0] === "mcp" && parts.length >= 3
    ? parts.slice(2).join("__")
    : value;
}

function questionRequestIdFromOutput(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const requestId = (parsed as Record<string, unknown>).requestId;
    return typeof requestId === "string" && requestId ? requestId : undefined;
  } catch {
    return undefined;
  }
}

function cloneTimelineEntry(entry: ClientTimelineEntry): ClientTimelineEntry {
  if (entry.type === "command.result")
    return { ...entry, card: cloneHostCommandCard(entry.card) };
  if (entry.role === "user")
    return {
      ...entry,
      origin: { ...entry.origin },
      content: entry.content.map(cloneContentBlock),
    };
  if (entry.role === "assistant")
    return {
      ...entry,
      content: entry.content.map(cloneContentBlock),
      ...(entry.usage ? { usage: { ...entry.usage } } : {}),
    };
  return { ...entry, content: entry.content.map(cloneContentBlock) };
}

function cloneHostCommandCard(card: HostCommandCard): HostCommandCard {
  switch (card.kind) {
    case "commit":
      return { ...card, commit: { ...card.commit } };
    case "push":
      return { ...card, push: { ...card.push } };
    case "compaction":
      return { ...card, compaction: { ...card.compaction } };
    case "contextClear":
      return { ...card, contextClear: { ...card.contextClear } };
    case "worktreeProvision":
      return { ...card, provision: { ...card.provision } };
    default:
      // A legacy persisted card kind this build no longer recognizes (e.g. the
      // superseded stage-1 `pullRequest` terminal card). `card.kind` is trusted
      // by its TYPE to be exhaustive here, but a real disk record predates this
      // union shrinking, so fall back to returning it AS-IS rather than
      // silently producing `undefined` and crashing the projector downstream.
      return card;
  }
}

function cloneContentBlock(block: AgentContentBlock): AgentContentBlock {
  return { ...block };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
    settled: false,
  };
  return result;
}

/** One closeable input iterable for one Claude process epoch. */
class CloseableInputQueue implements AsyncIterable<ClaudeSdkUserMessage> {
  private readonly values: ClaudeSdkUserMessage[] = [];
  private readonly waiters: Array<
    (result: IteratorResult<ClaudeSdkUserMessage>) => void
  > = [];
  private closed = false;
  private iteratorClaimed = false;

  push(value: ClaudeSdkUserMessage): void {
    if (this.closed) throw new Error("the Claude input queue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
    if (this.iteratorClaimed)
      throw new Error(
        "a Claude process epoch may consume its input queue only once",
      );
    this.iteratorClaimed = true;
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * What became of a steer: taken (`steer`/`followUp`), never sent (`refused`),
 * dropped before the CLI read it (`withdrawn`), or dropped with no answer that
 * says whether it had been read (`uncertain`).
 */
type SteerOutcome = PromptDelivery | "refused" | "withdrawn" | "uncertain";

/** A message handed to the running CLI turn that the CLI has not yet taken. */
interface PendingSteer {
  text: string;
  hidden: boolean;
  attachments: PromptAttachment[];
  onAccepted: ((delivery: PromptDelivery) => void) | undefined;
  outcome: Deferred<SteerOutcome>;
}

interface CompactOperation {
  summary?: string;
  boundary?: CompactBoundary;
  resultText?: string;
  completion: Deferred<void>;
}

/** A provider failure observed inside one turn, before it becomes the turn error. */
interface ProviderFailure {
  /** Short machine-ish reason (`rate_limit`, `error_during_execution`, `HTTP 429`). */
  reason: string;
  /** The wording the provider gave the user; may be empty. */
  text: string;
}

/**
 * The message a failed turn shows. The provider's own wording stands alone when
 * it has one: it is the only text that says WHICH limit or fault was hit, and
 * `analyzeProviderError` classifies that prose — mixing the machine reason into
 * it would classify the label instead of the failure.
 */
function providerFailureMessage(failure: ProviderFailure): string {
  return failure.text.trim() || `Claude returned an error (${failure.reason}).`;
}

export interface ClaudeSdkSessionDeps {
  /** Lazily resolves the SDK seam (real or fake). */
  seam: () => Promise<ClaudeSdkSeam>;
  createdAt?: number;
  /**
   * Last-activity timestamp of a RESTORED session. Without it a restart would
   * regress `updatedAt` to `createdAt` until the session's next mutation, which
   * back-dates the session list's ordering/unread check and every metadata row
   * written from this record (`session_index`, `session_usage_totals`).
   */
  updatedAt?: number;
  title?: string;
  providerSessionId?: string;
  entries?: ClientTimelineEntry[];
  /** Provenance when this session was branched off another one. */
  forkOrigin?: SessionForkOrigin;
  /**
   * A fork that carries its parent's title only until its own first prompt
   * names it. Without this a title would mark the session as already named, so
   * the child would keep the parent's title forever — or be stranded on the
   * default one if the parent never got a real title either.
   */
  forkAutoRenamePending?: boolean;
  modelId?: string;
  thinkingLevel?: string;
  /** Build/Plan for this session; unknown or absent restores `build`. */
  mode?: string;
  /** Persisted cumulative usage/cost to restore across a restart. */
  usage?: ClaudeSdkUsageRecord;
  /**
   * The agentType this session applies (system prompt + MCP toolset). Defaults
   * to `"workshop"` — today's only claude-sdk behavior. Routed through
   * `AGENT_TYPES` so the SDK harness can apply any agentType.
   */
  agentType?: AgentType;
  /** Session-specific instructions appended to the persona system prompt. */
  additionalSystemPrompt?: string;
  /** Where the session executes (its worktree path); defaults to the app CWD. */
  cwd?: string;
  /** Test seam for the provider task-output root; production derives one from TMPDIR. */
  backgroundOutputRoot?: string;
  credentialProfileId?: string;
  /** Test seam for generated frozen-skill runtime preparation. */
  prepareSkillRuntime?: (frozenSkillNames: readonly string[]) => Promise<void>;
  /** Test seam for bounding a closing SDK process before forced abort. */
  processCloseTimeoutMs?: number;
}

export class ClaudeSdkSession {
  /**
   * The persona this session runs as. `AgentKind` is persona-only now, so this
   * mirrors {@link agentType} (a claude-sdk session may be `assistant` or
   * `workshop`); the {@link harness} is what marks it as claude-sdk.
   */
  readonly kind: AgentKind;
  /** The in-process SDK harness. */
  readonly harness: Harness = "claude-sdk";
  readonly key: string;
  readonly viewers = new Set<Viewer>();
  private readonly adapterEvents = new NativeAdapterEventSource();

  /**
   * APPEND-ONLY: an entry is never edited or removed once pushed. The store
   * persists this as an append-only log and writes only the entries past what
   * it already holds (`claudeSdkRecords.ts`), so breaking this loses history.
   */
  private committed: ClientTimelineEntry[] = [];
  private nextSeq = 0;
  private liveTurn: DisplayMessage | undefined;
  private liveTurnId: string | undefined;
  private running = false;
  title: string;
  /** True only while the dedicated naming agent is running. */
  private titleGenerationPending = false;
  private readonly createdAt: number;
  private updatedAt: number;

  private providerSessionId: string | undefined;
  /** Set once, when this session was created as a fork of another. */
  private readonly forkOrigin: SessionForkOrigin | undefined;
  /** True until a forked session's own first prompt renames it. */
  private forkAutoRenamePending = false;
  /**
   * The uuid of the newest native transcript message of the turn now streaming.
   * It rides the turn's `messageCompleted` into the app log as that assistant
   * entry's `providerMessageId` — the anchor the SDK's `forkSession` accepts.
   *
   * Taking the turn's LAST native message matters: one of our assistant entries
   * aggregates several native messages (thinking, text, each tool_use), and only
   * the last one slices a fork AFTER the whole turn.
   */
  private pendingNativeMessageId: string | undefined;
  private modelId: string;
  private thinkingLevel: ThinkingLevel;
  /**
   * Build vs Plan. Deliberately NOT covered by {@link configurationLocked}:
   * model and thinking are frozen by the first prompt because the SDK fixes
   * them at query time, but the mode is only a tool policy, and every turn
   * builds a fresh `query()` from it.
   */
  private mode: SessionMode;
  /** The agentType applied to this session (default workshop). */
  readonly agentType: AgentType;
  private readonly additionalSystemPrompt: string | undefined;
  /** Memoized frozen prompt conditions — see {@link promptConditions}. */
  private frozenPromptConditions: PromptConditions | undefined;
  /** Where this session executes: its worktree path, else the app CWD. */
  readonly cwd: string;
  /**
   * Cumulative token/cost usage across the whole session, surviving a reload via
   * the persisted record. A `result` reports the RUNNING TOTAL for its `query()`
   * epoch, so `applyResultTotals` rebases each report onto `epochUsageBase`
   * rather than adding it.
   */
  private cumulative: CumulativeUsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  /**
   * What `cumulative` held when the current `query()` epoch started, which
   * `beginUsageEpoch` snapshots before `seam.query` at every call site. The
   * epoch's running totals are billed on top of it.
   */
  private epochUsageBase: CumulativeUsageTotals | undefined;
  /**
   * `cumulative` sampled when the current turn opened, so the completed turn's
   * durable entry usage is THIS run's delta (`result` accumulates into
   * `cumulative` before `finishTurn` runs).
   */
  private turnStartTotals: CumulativeUsageTotals | undefined;
  /**
   * Current context-window occupancy (tokens) = the input side of the most
   * recent request (input + cache_read + cache_creation). A SNAPSHOT, not a sum:
   * updated from `message_start` / each `assistant` message, NOT from `result`
   * (whose usage is the turn aggregate and would over-count the live context).
   */
  private contextTokens: number | undefined;
  /** Real model context window learned from `result.modelUsage` (e.g. 1M for Sonnet[1m]). */
  private contextWindowTokens: number | undefined;
  /** Throttle for streaming `contextInfo` broadcasts (see broadcastContextInfo). */
  private lastContextBroadcastAt = 0;
  private autoNameTried = false;

  readonly credentialProfileId: string | undefined;
  private readonly seamFactory: () => Promise<ClaudeSdkSeam>;
  private readonly prepareSkillRuntime: (
    frozenSkillNames: readonly string[],
  ) => Promise<void>;
  private readonly processCloseTimeoutMs: number;
  private readonly backgroundOutputRoot: string | undefined;
  private epochTaskOutputTemp: ClaudeTaskOutputTemp | undefined;
  private abortController: AbortController | undefined;
  private activeQuery: ClaudeQuery | undefined;
  private queryLoop: Promise<void> | undefined;
  private inputQueue: CloseableInputQueue | undefined;
  /**
   * Steers written into the live input queue, by the uuid stamped on them, until
   * the CLI takes one (folded in at a tool step, or run after the reply) or it
   * is withdrawn. Only a prompted turn owns them; every exit settles them.
   */
  private readonly pendingSteers = new Map<string, PendingSteer>();
  /**
   * Follow-ups already recorded whose CLI turn has not reported them consumed.
   * The CLI may run several late messages as one turn or as one turn each, so
   * the run continues until every one of them is accounted for.
   */
  private readonly followUpsOwed = new Set<string>();
  /** A Stop's interrupt (or kill) still waiting on the CLI's drop answers. */
  private stopInterrupt: Promise<void> | undefined;
  /** The ordinary epoch a Stop is killing once those answers are in. */
  private stoppingEpochKey: string | undefined;
  private queryEpochKey: string | undefined;
  /**
   * Query epoch that owns the currently open prompted/provider turn.
   *
   * A new prompt can open while the previous ordinary query is still closing:
   * `finishTurn()` publishes idle before that query's iterator reaches `finally`.
   * The old finalizer must not mistake the new turn's global `running` flag for
   * work it owns and finish the new turn empty.
   */
  private activeTurnEpochKey: string | undefined;
  private retainedEpochKey: string | undefined;
  private retainedEmptyGraceMs = 0;
  private readonly missingProviderTasks = new Set<string>();
  /** Item ids for which terminal output capture has already been attempted. */
  private readonly capturedTaskOutput = new Set<string>();
  private unregisterBackgroundHost: (() => void) | undefined;
  private processClosing = false;
  private processCloseReason: string | undefined;
  /**
   * The provider failure seen during the live turn (synthetic assistant message
   * and/or `result`), which `finishTurn` turns into the turn's error. Cleared
   * when a turn opens.
   */
  private pendingProviderError: ProviderFailure | undefined;
  private foreignProviderResultsToDiscard = 0;
  private providerResultBlocksCompact = false;
  private providerResultResetTimer: ReturnType<typeof setTimeout> | undefined;
  private quietCloseTimer: ReturnType<typeof setTimeout> | undefined;
  private turnCompletion: Deferred<void> | undefined;
  private providerTurnRelease: (() => void) | undefined;
  private providerTurnEpochKey: string | undefined;
  private providerTurnInterrupted = false;
  private compactOperation: CompactOperation | undefined;
  private compactOperationEpochKey: string | undefined;
  private abortingTurn = false;
  /**
   * In-process session tool server exposing this session's custom tools,
   * mounted on every query as `mcpServers.pa`. Built lazily on first prompt and
   * kept for the session's life (its handlers resolve tools/context fresh per
   * call), closed on dispose.
   */
  private toolServer: SessionToolServer | undefined;
  /** Per-tool loaded/token state from the CLI's tool search (getContextUsage). */
  private toolLoadState = new Map<
    string,
    { loaded: boolean; tokens: number }
  >();
  private toolLoadEvents: SessionToolLoadEvent[] = [];

  // Sub-message identity (see class doc).
  private streamMessageId: string | undefined;
  private streamSubIndex = 0;
  /** block index → toolId, so input_json_delta (no id) maps to the right tool. */
  private readonly toolIdsByBlock = new Map<string, string>();
  /** tool_use ids already opened (toolStart broadcast) this turn. */
  private readonly startedTools = new Set<string>();
  private turnCounter = 0;
  /**
   * Set while a host-driven ("synthetic") turn is open. Such a turn's teardown is
   * owned by the `finishSynthetic*` path that started it, so {@link abort} must
   * cancel the in-flight work WITHOUT calling `finishTurn` (which would commit the
   * synthetic turn as an ordinary assistant turn and leave the finish path a no-op).
   */
  private syntheticTurn = false;
  /** clientRequestIds already handled, for prompt idempotency (in-memory). */
  private readonly handledRequestIds = new Set<string>();
  private readonly unsubscribeQuestions: () => void;
  private unsubscribeApprovals: () => void = () => {};
  private unsubscribeTaskChoices: () => void = () => {};

  /** Notify the store (→ hub) that the list entry changed (title, running). */
  onChange: () => void = () => {};
  /** Ask the store to persist this session's record. */
  onPersist: () => void = () => {};
  /**
   * Ask the store to release this idle session from memory; answers whether it
   * did. Unset (a session no store holds) means the idle clock never runs.
   */
  onEvict: (() => boolean) | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once disposed: nothing may drive this instance again. */
  private disposed = false;
  /** Notify the hub that the working tree may have changed (→ refresh workspace info). */
  /** Browser runtimes visible to this session, provided by the hub. */
  browserRuntimesFor: (sessionId: string) => BrowserRuntimeInfo[] = () => [];

  constructor(
    readonly id: string,
    deps: ClaudeSdkSessionDeps,
  ) {
    registerClaudeBackgroundWorkBackend();
    this.agentType = deps.agentType ?? "workshop";
    this.additionalSystemPrompt =
      deps.additionalSystemPrompt?.trim() || undefined;
    this.cwd = deps.cwd ?? CWD;
    this.credentialProfileId = deps.credentialProfileId;
    this.kind = this.agentType;
    this.key = id;
    this.seamFactory = deps.seam;
    this.prepareSkillRuntime =
      deps.prepareSkillRuntime ?? prepareClaudeSkillRuntime;
    this.processCloseTimeoutMs = deps.processCloseTimeoutMs ?? 5_000;
    this.backgroundOutputRoot = deps.backgroundOutputRoot;
    this.createdAt = deps.createdAt ?? Date.now();
    this.updatedAt = deps.updatedAt ?? this.createdAt;
    this.title = deps.title ?? DEFAULT_TITLE;
    if (deps.title && !deps.forkAutoRenamePending) this.autoNameTried = true;
    this.forkAutoRenamePending = deps.forkAutoRenamePending === true;
    this.providerSessionId = deps.providerSessionId;
    this.forkOrigin = deps.forkOrigin;
    this.committed = deps.entries ? deps.entries.map(cloneTimelineEntry) : [];
    this.nextSeq = this.committed.reduce(
      (next, entry) => Math.max(next, entry.seq + 1),
      0,
    );
    this.modelId = claudeSdkModelAlias(deps.modelId);
    this.thinkingLevel = normalizeThinkingLevel(deps.thinkingLevel);
    this.mode = sessionModeOrDefault(deps.mode);
    if (deps.usage) {
      this.cumulative = {
        input: deps.usage.input,
        output: deps.usage.output,
        cacheRead: deps.usage.cacheRead,
        cacheWrite: deps.usage.cacheWrite,
        cost: deps.usage.cost,
      };
      this.contextTokens = deps.usage.contextTokens;
      this.contextWindowTokens = deps.usage.contextWindow;
    }
    this.unsubscribeQuestions = subscribeAgentQuestionChanges((sessionId) => {
      if (sessionId !== this.sessionId) return;
      this.broadcastState();
      this.onChange();
    });
    this.unsubscribeApprovals = subscribePendingApprovalChanges((sessionId) => {
      if (sessionId !== this.sessionId) return;
      this.broadcastState();
      this.onChange();
    });
    this.unsubscribeTaskChoices = subscribeChoosingTaskCardChanges(
      (sessionId) => {
        if (sessionId !== this.sessionId) return;
        this.broadcastState();
        this.onChange();
      },
    );
    this.repairQuestionToolCallIdsFromTimeline();
  }

  get sessionId(): string {
    return this.id;
  }

  /** No pi session file; the id is the handle. */
  get sessionFile(): string | undefined {
    return this.id;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * A host-command turn and a provider-initiated background turn take no
   * input; every other turn does. The finer conditions (a live input queue, no
   * compaction or discarded result in flight) are the driver's to check at
   * send time, where `steer` refuses instead.
   */
  get canSteer(): boolean {
    return !this.syntheticTurn && this.providerTurnRelease === undefined;
  }

  /* --------------------------------- views --------------------------------- */

  addViewer(v: Viewer): void {
    this.cancelIdle();
    this.viewers.add(v);
  }

  removeViewer(v: Viewer): void {
    this.viewers.delete(v);
    this.armIdle();
  }

  /* ------------------------------ residency ------------------------------- */

  /**
   * Start the idle clock if nobody views this session: the store calls it on
   * every acquisition, so a session opened by a peer message, a rename or a
   * superseded load idles out, and a caller that just acquired it gets a full
   * grace before it can be released under them.
   */
  armIdleIfUnviewed(): void {
    this.armIdle();
  }

  /**
   * Release this session after {@link HARNESS_IDLE_EVICT_MS} unviewed, the same
   * clock the pi harness runs. A session found busy then is not idle: the clock
   * starts again rather than stopping, so work that ends without a turn
   * boundary (a retained process exiting, a naming agent) is still collected.
   */
  private armIdle(): void {
    this.cancelIdle();
    if (!this.onEvict || this.disposed || this.viewers.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.disposed || this.viewers.size > 0) return;
      if (!this.isQuiescent || !this.onEvict?.()) this.armIdle();
    }, HARNESS_IDLE_EVICT_MS);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  /**
   * Nothing in flight that lives only in this object: no turn, no Claude
   * process (a retained one hosts background work), no compaction, Stop,
   * provider-initiated turn, queued steer or owed follow-up, no naming agent
   * whose title would land on a released instance, and no browser runtime the
   * agent keeps between turns, which disposing would close.
   */
  get isQuiescent(): boolean {
    return (
      !this.running &&
      !this.activeQuery &&
      !this.compactOperation &&
      !this.stopInterrupt &&
      !this.providerTurnRelease &&
      !this.titleGenerationPending &&
      this.pendingSteers.size === 0 &&
      this.followUpsOwed.size === 0 &&
      !hasToolGroupSession(this.id)
    );
  }

  /** Disposed — released for being idle, or removed — so never driven again. */
  get released(): boolean {
    return this.disposed;
  }

  /** Refuse to drive an instance its store has released; a new send acquires a live one. */
  private assertNotDisposed(): void {
    if (this.disposed)
      throw new Error(
        "This Claude session was released from memory; send it again.",
      );
  }

  private broadcast(message: Parameters<Viewer["send"]>[0]): void {
    for (const v of this.viewers) v.send(message);
  }

  subscribeAdapterEvents(listener: AdapterEventListener): () => void {
    return this.adapterEvents.subscribe(listener);
  }

  broadcastState(): void {
    if (this.viewers.size === 0) return;
    this.broadcast({ type: "state", state: this.state() });
  }

  /**
   * Push fresh context/usage to viewers so the UI's context meter updates as the
   * turn progresses and lands its final figures. Mirrors {@link LiveSession}'s
   * `broadcastContextInfo`; throttled to ~250ms during streaming, `force` on
   * turn end. Without this the meter would only refresh on session (re)load.
   */
  private broadcastContextInfo(force = false): void {
    if (this.viewers.size === 0) return;
    const now = Date.now();
    if (!force && now - this.lastContextBroadcastAt < 250) return;
    this.lastContextBroadcastAt = now;
    this.broadcast({
      type: "contextInfo",
      sessionId: this.id,
      info: this.contextInfo(),
    });
  }

  private liveMessages(): DisplayMessage[] {
    return this.liveTurn
      ? [
          {
            ...this.liveTurn,
            blocks: this.liveTurn.blocks.map((block) => ({ ...block })),
          },
        ]
      : [];
  }

  timelineEntries(): ClientTimelineEntry[] {
    return this.committed.map(cloneTimelineEntry);
  }

  /**
   * The committed timeline itself, not a copy, for a caller that only reads it
   * synchronously (the store serializing what it has not persisted yet).
   */
  committedTimeline(): readonly ClientTimelineEntry[] {
    return this.committed;
  }

  /**
   * Committed display messages, counted up to `length`. The timeline only grows
   * and the count is additive, so a new tail is counted on its own.
   */
  private committedDisplayCount = { length: 0, count: 0 };

  /**
   * `snapshot().length` without building the snapshot: the approval and card
   * merges only insert, so the count is a sum. The session list asks this for
   * every Claude row on every rebuild, and projecting a long transcript each
   * time just to count it was most of that rebuild.
   */
  private messageCount(): number {
    const counted = this.committedDisplayCount;
    if (counted.length !== this.committed.length)
      this.committedDisplayCount = {
        length: this.committed.length,
        count:
          counted.count +
          displayMessageCount(this.committed.slice(counted.length)),
      };
    return (
      this.committedDisplayCount.count +
      (this.liveTurn ? 1 : 0) +
      approvalsForSession(this.id).length +
      cardsForSession(this.id).length
    );
  }

  snapshot(): DisplayMessage[] {
    return withPullRequestCardBlocks(
      withApprovalBlocks(
        [...entriesToDisplayMessages(this.committed), ...this.liveMessages()],
        this.id,
      ),
      this.id,
    );
  }

  private modelOption(): ModelOption {
    return claudeSdkModelOption(this.modelId, this.contextWindowTokens);
  }

  state(): SessionState {
    const idleReasonValue = getPendingAgentQuestion(this.sessionId)
      ? "awaiting_question"
      : hasPendingApproval(this.sessionId)
        ? "awaiting_approval"
        : hasChoosingTaskCard(this.sessionId)
          ? "awaiting_task_choice"
          : undefined;
    const pendingQuestionValue = getPendingAgentQuestion(this.sessionId);
    const pendingPostReloadContinuationValue = getPendingPostReloadContinuation(
      this.id,
    );
    const activeSkillsValue = activeSkillsForSession(this.id, this.agentType);
    const worktreeIdValue = this.safeWorktreeId();
    return {
      sessionId: this.id,
      ...(this.sessionFile !== undefined
        ? { sessionFile: this.sessionFile }
        : {}),
      harness: this.harness,
      agentType: this.agentType,
      model: this.modelOption(),
      thinkingLevel: this.thinkingLevel,
      mode: this.mode,
      canSteer: this.canSteer,
      ...(this.forkOrigin ? { forkOrigin: this.forkOrigin } : {}),
      ...(idleReasonValue !== undefined ? { idleReason: idleReasonValue } : {}),
      ...(pendingQuestionValue !== undefined
        ? { pendingQuestion: pendingQuestionValue }
        : {}),
      answeredQuestions: getAnsweredAgentQuestions(this.sessionId),
      toolExposure: this.toolExposure(),
      ...(activeSkillsValue !== undefined
        ? {
            activeSkills: activeSkillsValue,
            skillInvocations: this.skillInvocations(activeSkillsValue),
          }
        : {}),
      ...(isCodingAgentType(this.agentType)
        ? { artifacts: listSessionArtifacts(this.id) }
        : {}),
      // Dev-supervisor reload continuation is a Workshop-only (local dev) concept.
      ...(this.agentType === "workshop"
        ? {
            ...(pendingPostReloadContinuationValue !== undefined
              ? {
                  pendingPostReloadContinuation:
                    pendingPostReloadContinuationValue,
                }
              : {}),
          }
        : {}),
      ...(isCodingAgentType(this.agentType)
        ? { browserRuntimes: this.browserRuntimesFor(this.id) }
        : {}),
      peerPrompts: peerPromptThreadsFor(this.id),
      ...promptQueueField(this.id),
      ...(worktreeIdValue !== undefined ? { worktreeId: worktreeIdValue } : {}),
      ...(this.safeWorktreeMissing() ? { worktreeMissing: true } : {}),
    };
  }

  private safeWorktreeId(): string | undefined {
    try {
      return worktreeIdForSession(this.id);
    } catch {
      return undefined;
    }
  }

  /** The linked worktree is gone and the user has not acknowledged it (Task 321). */
  private safeWorktreeMissing(): boolean {
    try {
      return sessionWorktreeMissing(this.id);
    } catch {
      return false;
    }
  }

  contextInfo(): ContextInfo {
    let user = 0;
    let assistant = 0;
    let toolCalls = 0;
    let toolResults = 0;
    for (const entry of this.committed) {
      if (entry.type === "command.result") continue;
      if (entry.role === "user") user++;
      else if (entry.role === "assistant") {
        assistant++;
        for (const block of entry.content)
          if (block.type === "toolCall") toolCalls++;
      } else {
        toolResults++;
      }
    }
    if (this.liveTurn) {
      assistant++;
      for (const block of this.liveTurn.blocks)
        if (block.kind === "tool") toolCalls++;
    }
    const { input, output, cacheRead, cacheWrite, cost } = this.cumulative;
    const window = this.modelOption().contextWindow;
    const ctx = this.contextTokens ?? null;
    const currentTurnValue = this.currentTurnEstimate();
    return {
      sessionId: this.id,
      updatedAt: this.updatedAt,
      messageCounts: {
        user,
        assistant,
        toolCalls,
        toolResults,
        total: user + assistant,
      },
      tokenUsage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        total: input + output + cacheRead + cacheWrite,
      },
      cost,
      context: {
        tokens: ctx,
        contextWindow: window,
        percent: ctx != null ? Math.min(100, (ctx / window) * 100) : null,
      },
      ...(currentTurnValue !== undefined
        ? { currentTurn: currentTurnValue }
        : {}),
    };
  }

  /**
   * Live token estimate for the in-flight turn (pi-style length/4 heuristic) so
   * the context meter shows a "Live ~N" reading while streaming. Actual usage
   * lands from the `result` message when the turn finishes.
   */
  private currentTurnEstimate(): ContextInfo["currentTurn"] {
    if (!this.liveTurn) return undefined;
    let text = "";
    let thinking = "";
    let toolCalls = 0;
    for (const b of this.liveTurn.blocks) {
      if (b.kind === "text") text += b.text;
      else if (b.kind === "thinking") thinking += b.text;
      else if (b.kind === "tool") toolCalls++;
    }
    return {
      output: estimateTokens(text),
      thinking: estimateTokens(thinking),
      toolCalls,
    };
  }

  private appendUserEntry(
    text: string,
    options: { hidden?: boolean; attachments?: PromptAttachment[] } = {},
    id = `csu-${this.turnCounter}`,
  ): ClientTimelineEntry {
    const content: AgentContentBlock[] =
      text.length > 0 ? [{ type: "text", text }] : [{ type: "text", text: "" }];
    for (const a of options.attachments ?? []) {
      content.push({
        type: "image",
        mimeType: a.mimeType,
        name: a.name,
        ref: a.id,
        size: a.size,
        ...(a.role ? { role: a.role } : {}),
      });
    }
    return this.appendTimelineEntry({
      id,
      type: "message",
      role: "user",
      origin: { kind: "human" },
      ...(options.hidden ? { hidden: true } : {}),
      content,
    });
  }

  private appendAssistantTurn(turn: DisplayMessage, usage?: AgentUsage): void {
    const content: AgentContentBlock[] = [];
    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      text: string;
      isError?: boolean;
    }> = [];
    for (const block of turn.blocks) {
      if (block.kind === "text")
        content.push({ type: "text", text: block.text });
      else if (block.kind === "thinking")
        content.push({ type: "thinking", text: block.text });
      else if (block.kind === "tool") {
        content.push({
          type: "toolCall",
          toolCallId: block.toolId,
          name: block.name,
          input: block.args,
        });
        if (block.done)
          toolResults.push({
            toolCallId: block.toolId,
            toolName: block.name,
            text: block.output,
            ...(block.isError ? { isError: true } : {}),
          });
      }
    }
    if (content.length > 0) {
      this.appendTimelineEntry({
        id: turn.id,
        type: "message",
        role: "assistant",
        content,
        model: this.modelId,
        ...(usage ? { usage } : {}),
        ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
      });
    }
    for (const result of toolResults) {
      this.appendTimelineEntry({
        id: `${turn.id}-tool-${result.toolCallId}`,
        type: "message",
        role: "toolResult",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        content: [{ type: "text", text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      });
    }
  }

  private appendHostCommandEntry(name: string, card: HostCommandCard): void {
    this.appendTimelineEntry({
      id: `cmd-${card.id}`,
      type: "command.result",
      name,
      card,
    });
  }

  private appendTimelineEntry<
    T extends Omit<ClientTimelineEntry, "seq" | "createdAt">,
  >(draft: T): T & { seq: number; createdAt: string } {
    const entry = {
      ...draft,
      seq: this.nextSeq++,
      createdAt: new Date().toISOString(),
    } as T & { seq: number; createdAt: string };
    this.committed.push(entry as unknown as ClientTimelineEntry);
    return entry;
  }

  /* ------------------------------- configure ------------------------------- */

  get configurationLocked(): boolean {
    return this.committed.length > 0 || Boolean(this.liveTurn) || this.running;
  }

  configure(modelId?: string, thinkingLevel?: ThinkingLevel): void {
    if (this.configurationLocked)
      throw new Error(
        "Model and thinking level are locked after the first prompt.",
      );
    if (modelId) this.modelId = claudeSdkModelAlias(modelId);
    if (thinkingLevel) this.thinkingLevel = thinkingLevel;
    this.broadcastState();
  }

  /**
   * Select the model. Mirrors the {@link LiveSession.setModel} surface the
   * connection drives; model/thinking are locked once a turn has run (the SDK
   * fixes them at query time), so this throws after the first prompt.
   */
  async setModel(modelId: string): Promise<void> {
    if (
      this.activeQuery &&
      this.retainedEpochKey !== undefined &&
      this.retainedEpochKey === this.queryEpochKey &&
      this.activeQuery.setModel
    ) {
      const alias = claudeSdkModelAlias(modelId);
      await this.activeQuery.setModel(claudeSdkModelId(alias));
      this.modelId = alias;
      this.broadcastState();
      this.onPersist();
      return;
    }
    this.configure(modelId, undefined);
  }

  /** Select thinking for later turns on a retained process through controls. */
  async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
    if (
      this.activeQuery &&
      this.retainedEpochKey !== undefined &&
      this.retainedEpochKey === this.queryEpochKey
    ) {
      const controls = reasoningToThinking(thinkingLevel, this.modelId);
      const thinking = controls.thinking;
      if (this.activeQuery.setMaxThinkingTokens) {
        const tokens =
          thinking?.type === "disabled"
            ? 0
            : thinking?.type === "enabled"
              ? (thinking.budgetTokens ?? null)
              : null;
        await this.activeQuery.setMaxThinkingTokens(tokens);
      }
      if (this.activeQuery.applyFlagSettings)
        await this.activeQuery.applyFlagSettings({
          effortLevel: controls.effort ?? null,
        });
      this.thinkingLevel = thinkingLevel;
      this.broadcastState();
      this.onPersist();
      return;
    }
    this.configure(undefined, thinkingLevel);
  }

  get sessionMode(): SessionMode {
    return this.mode;
  }

  /**
   * Switch Build/Plan. Accepted at ANY point — mid-conversation is the whole
   * point — and takes effect on the NEXT turn, which recomputes the query's
   * tool policy from it. Persisted immediately so the switch survives a restart
   * even if no turn follows it.
   */
  setMode(mode: SessionMode): void {
    if (this.mode === mode) return;
    if (
      mode === "build" &&
      this.mode === "plan" &&
      this.retainedEpochKey !== undefined &&
      this.retainedEpochKey === this.queryEpochKey
    )
      throw new Error(
        "Build mode cannot restore native edit tools until retained background work finishes.",
      );
    this.mode = mode;
    // The mounted server resolves policy lazily; notify a connected SDK client
    // so its cached tools/list projection drops/restores side-effecting tools.
    this.toolServer?.notifyToolsChanged();
    this.broadcastState();
    this.onPersist();
    this.onChange();
  }

  /* --------------------------------- prompt -------------------------------- */

  createRuntimeAdapter(): PromptableAdapter {
    const driver: ClaudeSdkAdapterDriver = {
      subscribeAdapterEvents: (listener) =>
        this.subscribeAdapterEvents(listener),
      prompt: (text, options) => this.#promptRaw(text, options),
      steer: (text, options) => this.steer(text, options),
      abort: () => this.abort(),
      setModel: (modelId) => this.setModel(modelId),
      setThinkingLevel: (level) => this.setThinkingLevel(level),
    };
    return createClaudeSdkAdapter(this.id, driver, {
      ...(this.providerSessionId
        ? { providerSessionId: this.providerSessionId }
        : {}),
    });
  }

  async #promptRaw(
    text: string,
    options: {
      clientRequestId?: string;
      hidden?: boolean;
      attachments?: PromptAttachment[];
    } = {},
  ): Promise<void> {
    this.assertNotDisposed();
    // Idempotent on clientRequestId: a duplicate submit is a no-op (so it can't
    // open a second turn or echo a second user bubble).
    if (options.clientRequestId) {
      if (this.handledRequestIds.has(options.clientRequestId)) return;
      this.handledRequestIds.add(options.clientRequestId);
    }
    if (this.running) throw new Error("A Claude SDK turn is already running.");
    const trimmed = text;
    // Attachments (persisted + threaded to the model): images ride along as image
    // content blocks; every other file is saved to the session attachment store
    // and referenced/inlined through the prompt suffix. The runtime records the
    // display chips on the durable user entry from the structured attachment list.
    const attachments = options.attachments ?? [];
    const modelPromptText =
      trimmed.trim().length > 0
        ? trimmed
        : attachments.length
          ? "Please analyze the attached file(s)."
          : trimmed;
    const { promptWithFiles, images } = buildModelPromptWithAttachments(
      this.id,
      modelPromptText,
      attachments,
    );
    this.running = true;
    this.providerTurnInterrupted = false;
    this.turnCounter += 1;

    // Claim the stable unnamed state before the acceptance broadcast. The list
    // must never expose a provider default or prompt-derived guess while the
    // dedicated naming agent is still working.
    const namingSettings = options.hidden
      ? undefined
      : this.beginAutoName(modelPromptText, attachments);

    // User message. Hidden resume prompts (for example answers submitted from
    // the question panel) are sent to Claude but represented by their UI card,
    // so they must not add a visible user bubble to the transcript.
    const userEntry = this.appendUserEntry(trimmed, {
      ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
      attachments,
    });
    // Persist + announce at ACCEPTANCE, not only after naming or turn end. A
    // first turn can run for minutes, and zero-message sessions are deliberately
    // absent from the list; without this edge a newly prompted Claude session
    // stays invisible until the model finishes (or a best-effort title lands).
    this.updatedAt = Date.now();
    this.onPersist();
    this.onChange();
    if (!options.hidden) {
      const userMessage = entriesToDisplayMessages([userEntry])[0];
      if (userMessage)
        this.broadcast({
          type: "userMessage",
          sessionId: this.id,
          message: userMessage,
          ...(options.clientRequestId !== undefined
            ? { clientRequestId: options.clientRequestId }
            : {}),
        });
      if (namingSettings)
        void this.autoName(modelPromptText, attachments, namingSettings);
    }

    // Live assistant turn (opened before broadcasting running state, so the
    // envelope order is userMessage → assistantStart → state for visible prompts).
    this.liveTurnId = `csa-${this.turnCounter}`;
    this.turnStartTotals = { ...this.cumulative };
    this.liveTurn = {
      id: this.liveTurnId,
      role: "assistant",
      blocks: [],
      streaming: true,
    };
    this.broadcast({
      type: "assistantStart",
      sessionId: this.id,
      id: this.liveTurnId,
    });
    this.adapterEvents.messageStarted(this.liveTurnId);
    this.broadcastState();

    // Reset per-turn sub-message identity.
    this.streamMessageId = undefined;
    this.streamSubIndex = 0;
    this.toolIdsByBlock.clear();
    this.startedTools.clear();
    this.resetTurnFailureState();

    this.abortingTurn = false;
    const completion = deferred<void>();
    this.turnCompletion = completion;
    try {
      const frozenSkillNames = this.frozenSkillNames();
      if (frozenSkillNames.length > 0)
        await this.prepareSkillRuntime(frozenSkillNames);
      await this.sendPromptToProcess(
        sdkUserMessage(promptWithFiles, images),
        frozenSkillNames,
      );
      await completion.promise;
    } catch (error) {
      if (this.running)
        this.finishTurn({
          stopReason: this.abortingTurn ? "aborted" : "error",
          ...(this.abortingTurn
            ? {}
            : {
                errorMessage:
                  error instanceof Error ? error.message : String(error),
              }),
        });
    }
  }

  /**
   * Write a message into the RUNNING turn's input queue, stamped with a uuid the
   * CLI reports back. The CLI folds a queued message in at the next tool step;
   * one that arrives after the final reply runs as the next turn instead, which
   * this session carries as a continuation of the same run
   * ({@link continueWithFollowUps}). Nothing is recorded until the CLI decides.
   */
  private steer(
    text: string,
    options: {
      clientRequestId?: string;
      hidden?: boolean;
      attachments?: PromptAttachment[];
      onAccepted?: (delivery: PromptDelivery) => void;
    } = {},
  ): Promise<SteerOutcome> {
    const epochKey = this.queryEpochKey;
    if (
      !this.running ||
      this.syntheticTurn ||
      this.abortingTurn ||
      !this.turnCompletion ||
      !this.liveTurn ||
      !this.activeQuery ||
      !this.inputQueue ||
      this.processClosing ||
      this.stopInterrupt ||
      this.compactOperation ||
      this.foreignProviderResultsToDiscard > 0 ||
      !epochKey ||
      this.activeTurnEpochKey !== epochKey
    )
      return Promise.resolve("refused");
    if (options.clientRequestId) {
      if (this.handledRequestIds.has(options.clientRequestId))
        return Promise.resolve("refused");
      this.handledRequestIds.add(options.clientRequestId);
    }
    const attachments = options.attachments ?? [];
    const modelPromptText =
      text.trim().length > 0
        ? text
        : attachments.length
          ? "Please analyze the attached file(s)."
          : text;
    const { promptWithFiles, images } = buildModelPromptWithAttachments(
      this.id,
      modelPromptText,
      attachments,
    );
    const uuid = randomUUID();
    const outcome = deferred<SteerOutcome>();
    this.pendingSteers.set(uuid, {
      text,
      hidden: options.hidden === true,
      attachments,
      onAccepted: options.onAccepted,
      outcome,
    });
    try {
      this.inputQueue.push({
        ...sdkUserMessage(promptWithFiles, images),
        uuid,
      } as ClaudeSdkUserMessage);
    } catch {
      this.pendingSteers.delete(uuid);
      return Promise.resolve("refused");
    }
    this.cancelQuietClose();
    return outcome.promise;
  }

  /**
   * Wait until a Stop's delayed interrupt has reached the retained query, so
   * the next input cannot be the turn it interrupts. Bounded like the drops it
   * waits behind: a CLI that never answers must not wedge the session.
   */
  private async stopInterruptSent(): Promise<void> {
    if (this.stopInterrupt)
      await settlesWithin(this.stopInterrupt, 2 * STEER_CANCEL_TIMEOUT_MS);
  }

  /**
   * Record a steer the CLI took and answer its sender — synchronously first, so
   * the runtime's entry lands here, before whatever this session commits next.
   */
  private acceptSteer(uuid: string, delivery: PromptDelivery): void {
    const steer = this.pendingSteers.get(uuid);
    if (!steer) return;
    this.pendingSteers.delete(uuid);
    try {
      steer.onAccepted?.(delivery);
    } catch (err) {
      console.warn("[claude] recording an accepted steer failed:", err);
    }
    this.appendUserEntry(
      steer.text,
      {
        ...(steer.hidden ? { hidden: true } : {}),
        attachments: steer.attachments,
      },
      `csu-${this.turnCounter}-${uuid}`,
    );
    steer.outcome.resolve(delivery);
  }

  /**
   * Answer every steer still waiting with "nothing was sent", asking the CLI
   * to drop each one first. A drop that loses the race only means the CLI
   * starts that message as a turn nobody admitted, and the provider-turn gate
   * interrupts that.
   */
  private withdrawPendingSteers(): Promise<void> {
    const query = this.activeQuery;
    const steers = [...this.pendingSteers.values()];
    const uuids = [...this.pendingSteers.keys()];
    this.pendingSteers.clear();
    this.followUpsOwed.clear();
    if (steers.length === 0) return Promise.resolve();
    // Each sender hears only what the CLI ANSWERED: a confirmed drop is safe to
    // hand back as unread, while a refused, failed or unanswered one may have
    // been folded into the turn already, and handing it back as unread would
    // let it be sent twice. Settled within a bound, so a CLI that never answers
    // cannot keep a Stop from finishing.
    return Promise.all(
      steers.map((steer, index) =>
        dropQueuedMessage(query, uuids[index]!).then((dropped) =>
          steer.outcome.resolve(dropped ? "withdrawn" : "uncertain"),
        ),
      ),
    ).then(() => undefined);
  }

  /**
   * The turn's `result` names every queued message it consumed: a pending steer
   * among them joined it, an owed follow-up among them has had its turn. A
   * result that names none (an older CLI) cannot say, so no follow-up is kept
   * waiting on it.
   */
  private settleConsumedSteers(message: ClaudeSdkMessage): void {
    if (message.type !== "result") return;
    const consumed = (message as { user_message_uuids?: unknown })
      .user_message_uuids;
    if (!Array.isArray(consumed)) {
      this.followUpsOwed.clear();
      return;
    }
    for (const uuid of consumed) {
      if (typeof uuid !== "string") continue;
      this.followUpsOwed.delete(uuid);
      this.acceptSteer(uuid, "steer");
    }
  }

  /**
   * The turn replied before reading the steers still queued, so the CLI is
   * already starting them as its next turn (or a follow-up recorded earlier has
   * not had its own turn yet). Commit this reply, record the new ones after it —
   * where the model first reads them — and open the next assistant message
   * inside the SAME run: the prompt that started it is still awaiting, and a run
   * boundary here would publish an idle that is not true.
   */
  private continueWithFollowUps(): void {
    const id = this.liveTurnId;
    const turn = this.liveTurn;
    if (!id || !turn) return;
    turn.streaming = false;
    const usage = perTurnUsage(this.turnStartTotals, this.cumulative, {
      ...(this.contextTokens !== undefined
        ? { tokens: this.contextTokens }
        : {}),
      window: this.modelOption().contextWindow,
    });
    this.broadcast({ type: "assistantEnd", sessionId: this.id, id });
    this.adapterEvents.messageAttemptCompleted(id, {
      model: this.modelId,
      ...(usage ? { usage } : {}),
      ...(this.pendingNativeMessageId
        ? { providerMessageId: this.pendingNativeMessageId }
        : {}),
    });
    this.pendingNativeMessageId = undefined;
    this.appendAssistantTurn(turn, usage);
    for (const uuid of [...this.pendingSteers.keys()]) {
      this.acceptSteer(uuid, "followUp");
      this.followUpsOwed.add(uuid);
    }

    this.turnCounter += 1;
    this.liveTurnId = `csa-${this.turnCounter}`;
    this.turnStartTotals = { ...this.cumulative };
    this.liveTurn = {
      id: this.liveTurnId,
      role: "assistant",
      blocks: [],
      streaming: true,
    };
    this.streamMessageId = undefined;
    this.streamSubIndex = 0;
    this.toolIdsByBlock.clear();
    this.startedTools.clear();
    this.resetTurnFailureState();
    this.broadcast({
      type: "assistantStart",
      sessionId: this.id,
      id: this.liveTurnId,
    });
    this.adapterEvents.messageStarted(this.liveTurnId);
    this.updatedAt = Date.now();
    this.broadcastState();
    this.onPersist();
    this.onChange();
  }

  private async sendPromptToProcess(
    message: ClaudeSdkUserMessage,
    frozenSkillNames: readonly string[],
  ): Promise<void> {
    this.cancelQuietClose();
    await this.stopInterruptSent();
    if (this.activeQuery && this.processClosing && this.queryLoop) {
      const closingLoop = this.queryLoop;
      if (!(await settlesWithin(closingLoop, this.processCloseTimeoutMs))) {
        this.abortController?.abort();
        if (!(await settlesWithin(closingLoop, this.processCloseTimeoutMs)))
          throw new Error(
            `Claude process did not exit after ${this.processCloseReason ?? "it was closed"}.`,
          );
      }
    }
    if (this.activeQuery && this.inputQueue) {
      const epochKey = this.queryEpochKey;
      if (!epochKey)
        throw new Error("The active Claude query has no owning epoch.");
      this.activeTurnEpochKey = epochKey;
      this.inputQueue.push(message);
      return;
    }

    const seam = await this.seamFactory();
    if (!this.toolServer) this.toolServer = createClaudeSessionToolServer(this);
    const epochKey = `claude-${randomUUID()}`;
    const queue = new CloseableInputQueue();
    queue.push(message);
    const abortController = new AbortController();
    this.abortController = abortController;
    if (this.epochTaskOutputTemp) {
      removeAgentTempTree(this.epochTaskOutputTemp.tmpDir);
      this.epochTaskOutputTemp = undefined;
    }
    this.inputQueue = queue;
    this.queryEpochKey = epochKey;
    this.activeTurnEpochKey = epochKey;
    this.beginUsageEpoch();
    this.processClosing = false;
    const taskOutputTemp = createClaudeTaskOutputTemp();
    this.epochTaskOutputTemp = taskOutputTemp;
    this.unregisterBackgroundHost = claudeBackgroundWorkBackend.registerHost({
      ownerSessionId: this.id,
      hostEpochKey: epochKey,
      outputRoot: this.backgroundOutputRoot ?? taskOutputTemp.outputRoot,
      stopProviderTask: async (providerTaskId) => {
        if (!this.activeQuery?.stopTask)
          throw new Error(
            "the retained Claude query cannot stop provider tasks",
          );
        await this.activeQuery.stopTask(providerTaskId);
      },
      interruptBackgroundTurn: async () => {
        if (this.providerTurnRelease && this.activeQuery?.interrupt) {
          this.providerTurnInterrupted = true;
          await this.activeQuery.interrupt();
        }
      },
      close: async (reason) => this.closeProcess(reason),
    });
    let query: ClaudeQuery;
    try {
      query = seam.query({
        prompt: queue,
        options: buildClaudeSdkQueryOptions({
          cwd: this.cwd,
          abortController,
          modelId: this.modelId,
          thinkingLevel: this.thinkingLevel,
          mode: this.mode,
          ...(this.providerSessionId !== undefined
            ? { providerSessionId: this.providerSessionId }
            : {}),
          mcpServer: this.toolServer.server,
          agentType: this.agentType,
          ...(this.additionalSystemPrompt !== undefined
            ? { additionalSystemPrompt: this.additionalSystemPrompt }
            : {}),
          promptConditions: this.promptConditions(),
          frozenSkillNames,
          outputPolicySessionId: this.id,
          lifecycleHooks: {
            preToolUse: (input) =>
              this.admitNativeBackgroundTool(epochKey, input),
            stop: (tasks) => this.reconcileStopTasks(epochKey, tasks),
            postCompact: (summary) => {
              if (
                this.compactOperation &&
                this.compactOperationEpochKey === epochKey
              )
                this.compactOperation.summary = summary;
            },
          },
          env: {
            ...(this.credentialProfileId
              ? claudeProfileEnvironment(this.credentialProfileId)
              : childProcessEnv()),
            TMPDIR: taskOutputTemp.tmpDir,
            CLAUDE_CODE_TMPDIR: taskOutputTemp.tmpDir,
          },
        }),
      });
    } catch (error) {
      this.unregisterBackgroundHost?.();
      this.unregisterBackgroundHost = undefined;
      removeAgentTempTree(taskOutputTemp.tmpDir);
      this.epochTaskOutputTemp = undefined;
      this.abortController = undefined;
      this.inputQueue = undefined;
      this.queryEpochKey = undefined;
      this.processClosing = false;
      this.processCloseReason = undefined;
      throw error;
    }
    this.activeQuery = query;
    this.queryLoop = this.consumeQuery(query, epochKey);
  }

  private async consumeQuery(
    query: ClaudeQuery,
    epochKey: string,
  ): Promise<void> {
    let fatalError: string | undefined;
    try {
      for await (const message of query) {
        if (this.stoppingEpochKey === epochKey) continue;
        const lifecycle = commandLifecycle(message);
        if (lifecycle) {
          // The CLI dequeued a command. While a prompted turn of this epoch is
          // still open, a steer dequeued now is folded into it at this step.
          if (
            lifecycle.started &&
            this.running &&
            this.liveTurn &&
            this.activeTurnEpochKey === epochKey
          )
            this.acceptSteer(lifecycle.started, "steer");
          continue;
        }
        if (
          message.type === "result" &&
          this.foreignProviderResultsToDiscard > 0
        ) {
          this.consumeForeignProviderResult();
          continue;
        }
        if (this.foreignProviderResultsToDiscard > 0) {
          if (this.running && isClaudeTurnStart(message)) {
            // Opportunistic early retirement only: the SDK guarantees `idle` as
            // turn-over, not `running` as turn-start. The bounded timer below is
            // the contract when this hint is absent; content never substitutes.
            this.consumeForeignProviderResult();
          } else {
            if (message.type === "system") {
              const boundary = compactBoundaryMetadata(message);
              if (boundary) this.handleAutoCompaction(boundary);
              else this.handleBackgroundSystemMessage(message);
            }
            continue;
          }
        }
        if (
          this.compactOperation &&
          this.compactOperationEpochKey === epochKey &&
          this.handleInBandCompactMessage(message)
        )
          continue;
        if (this.isProviderTurnContent(message) && !this.running) {
          const admitted = await this.beginProviderInitiatedTurn(epochKey);
          if (!admitted) continue;
        }
        this.handleSdkMessage(message);
        if (message.type !== "result") continue;
        await this.refreshToolLoadState(query);
        const ownsTurn =
          this.running &&
          !this.syntheticTurn &&
          this.activeTurnEpochKey === epochKey;
        if (ownsTurn) {
          this.settleConsumedSteers(message);
          if (
            this.pendingSteers.size + this.followUpsOwed.size > 0 &&
            !this.providerTurnInterrupted &&
            this.turnOutcome().stopReason === "end"
          ) {
            // The process must outlive this result: its next turn is theirs.
            this.continueWithFollowUps();
            continue;
          }
        }
        if (ownsTurn)
          this.finishTurn(
            this.providerTurnInterrupted
              ? { stopReason: "aborted" }
              : this.turnOutcome(),
          );
        if (this.retainedEpochKey !== epochKey)
          await this.closeProcess("ordinary Claude turn completed");
        else this.scheduleQuietCloseIfEmpty(epochKey);
      }
    } catch (error) {
      if (!this.processClosing && !this.abortingTurn)
        fatalError = error instanceof Error ? error.message : String(error);
    } finally {
      const retained = this.retainedEpochKey === epochKey;
      if (retained && !this.processClosing && !fatalError)
        fatalError = "the retained Claude process exited unexpectedly";
      if (fatalError)
        console.warn(`[background] Claude process failed: ${fatalError}`);
      const ownsOpenTurn = this.activeTurnEpochKey === epochKey;
      if (fatalError && this.running && !this.syntheticTurn && ownsOpenTurn)
        // A provider rejection seen this turn already said WHICH limit or fault
        // was hit; what the iterator then throws is the SDK's generic wrapper
        // around that same failure, and it would only blur the classification.
        this.finishTurn({
          stopReason: "error",
          errorMessage: this.pendingProviderError
            ? providerFailureMessage(this.pendingProviderError)
            : fatalError,
        });
      else if (
        this.abortingTurn &&
        this.running &&
        !this.syntheticTurn &&
        ownsOpenTurn
      )
        this.finishTurn({ stopReason: "aborted" });
      else if (!retained && this.running && !this.syntheticTurn && ownsOpenTurn)
        this.finishTurn({ stopReason: "end" });
      if (this.compactOperationEpochKey === epochKey) {
        this.compactOperation?.completion.reject(
          new Error(
            fatalError ?? "the Claude process closed during compaction",
          ),
        );
        this.compactOperation = undefined;
        this.compactOperationEpochKey = undefined;
      }
      if (this.providerTurnEpochKey === epochKey) {
        this.providerTurnRelease?.();
        this.providerTurnRelease = undefined;
        this.providerTurnEpochKey = undefined;
      }
      if (retained && !this.processClosing)
        backgroundWorkSupervisor.hostLost(
          this.id,
          epochKey,
          (
            fatalError ?? "the retained Claude process exited unexpectedly"
          ).slice(0, 500),
        );
      if (this.stoppingEpochKey === epochKey) this.stoppingEpochKey = undefined;
      if (this.queryEpochKey === epochKey) {
        void this.withdrawPendingSteers();
        this.activeQuery = undefined;
        this.abortController = undefined;
        this.inputQueue = undefined;
        this.queryEpochKey = undefined;
        this.retainedEpochKey = undefined;
        this.missingProviderTasks.clear();
        this.unregisterBackgroundHost?.();
        this.unregisterBackgroundHost = undefined;
        const taskOutputTemp = this.epochTaskOutputTemp;
        if (taskOutputTemp) removeAgentTempTree(taskOutputTemp.tmpDir);
        this.epochTaskOutputTemp = undefined;
        this.processClosing = false;
        this.processCloseReason = undefined;
        this.resetProviderResultTracking();
      }
    }
  }

  private isProviderTurnContent(
    message: import("./sdkSeam.ts").ClaudeSdkMessage,
  ): boolean {
    return (
      message.type === "assistant" ||
      message.type === "stream_event" ||
      (message.type === "system" &&
        message.subtype === "session_state_changed" &&
        message.state === "running")
    );
  }

  private async beginProviderInitiatedTurn(epochKey: string): Promise<boolean> {
    const itemId = claudeBackgroundWorkBackend.firstActiveItemId(
      this.id,
      epochKey,
    );
    const denied = backgroundWorkSupervisor.isDraining
      ? "the server is draining"
      : claudeBackgroundWorkBackend.stopAllWasRequested(this.id, epochKey)
        ? "Stop-all was requested for this retained host"
        : !itemId
          ? "the retained host has no governed background task"
          : peerPromptStore.listPendingForRecipient(this.id).length > 0
            ? "a queued peer prompt has priority"
            : undefined;
    if (denied) {
      this.markProviderResultForDiscard();
      console.warn(`[background] denied Claude provider turn: ${denied}`);
      await this.activeQuery?.interrupt?.().catch(() => undefined);
      if (denied.includes("peer prompt")) void drainRecipient(this.id);
      return false;
    }
    try {
      this.cancelQuietClose();
      this.providerTurnRelease = await beginRuntimeProviderTurn(
        this as RuntimePromptDriver,
        { kind: "system", source: `claude-background:${itemId}` },
      );
      this.providerTurnEpochKey = epochKey;
    } catch (error) {
      this.markProviderResultForDiscard();
      console.warn(
        "[background] denied Claude provider turn:",
        error instanceof Error ? error.message.slice(0, 500) : String(error),
      );
      await this.activeQuery?.interrupt?.().catch(() => undefined);
      return false;
    }
    this.openProviderTurn(epochKey);
    return true;
  }

  private openProviderTurn(epochKey: string): void {
    this.running = true;
    this.activeTurnEpochKey = epochKey;
    this.providerTurnInterrupted = false;
    this.turnCounter += 1;
    this.liveTurnId = `csbg-${this.turnCounter}`;
    this.turnStartTotals = { ...this.cumulative };
    this.liveTurn = {
      id: this.liveTurnId,
      role: "assistant",
      blocks: [],
      streaming: true,
    };
    this.streamMessageId = undefined;
    this.streamSubIndex = 0;
    this.toolIdsByBlock.clear();
    this.startedTools.clear();
    this.resetTurnFailureState();
    this.broadcast({
      type: "assistantStart",
      sessionId: this.id,
      id: this.liveTurnId,
    });
    this.adapterEvents.messageStarted(this.liveTurnId);
    this.broadcastState();
  }

  private async admitNativeBackgroundTool(
    epochKey: string,
    input: {
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    },
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    if (
      this.mode === "plan" &&
      ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(input.toolName)
    )
      return {
        allowed: false,
        reason: `${input.toolName} is unavailable while this session is in Plan mode.`,
      };
    const isBackgroundBash =
      input.toolName === "Bash" && input.toolInput.run_in_background === true;
    const isMonitor = input.toolName === "Monitor";
    if (!isBackgroundBash && !isMonitor) return { allowed: true };
    const kind = isBackgroundBash
      ? "shell"
      : input.toolInput.ws
        ? "monitor-websocket"
        : "monitor-command";
    // What the card can say about the job comes from the tool input itself:
    // the provider's task events only ever repeat the description.
    const command = toolInputCommand(input.toolInput);
    const description = backgroundWorkDescription(
      typeof input.toolInput.description === "string"
        ? input.toolInput.description
        : undefined,
    );
    const admission = backgroundWorkSupervisor.admit({
      ownerSessionId: this.id,
      backend: "claude-query",
      kind,
      label: backgroundWorkTitle({
        description,
        command,
        fallback: isBackgroundBash
          ? "Claude background shell"
          : "Claude background monitor",
      }),
      ...(description ? { description } : {}),
      ...(command ? { command } : {}),
      sourceRequestId: input.toolUseId,
      hostEpochKey: epochKey,
    });
    if (!admission.admitted)
      return { allowed: false, reason: admission.message.slice(0, 500) };
    try {
      claudeBackgroundWorkBackend.reserveItem(
        this.id,
        epochKey,
        admission.item.id,
        input.toolUseId,
      );
      const launched = await backgroundWorkSupervisor.launch(admission);
      if (!launched || launched.state !== "running") {
        claudeBackgroundWorkBackend.completeItem(
          this.id,
          epochKey,
          admission.item.id,
        );
        return {
          allowed: false,
          reason: "the retained Claude host could not reserve this launch",
        };
      }
      this.retainedEpochKey = epochKey;
      this.retainedEmptyGraceMs = admission.frozen.claudeEmptyHostGraceMs ?? 0;
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        reason: (error instanceof Error
          ? error.message
          : "background admission failed"
        ).slice(0, 500),
      };
    }
  }

  private reconcileStopTasks(
    epochKey: string,
    tasks: Array<{
      id: string;
      type: string;
      status: string;
      description: string;
      command?: string;
    }>,
  ): void {
    this.replaceProviderMembership(
      epochKey,
      tasks.map((task) => ({
        taskId: task.id,
        taskType: task.type,
        description: task.description,
      })),
    );
    for (const task of tasks) {
      if (
        claudeBackgroundWorkBackend.providerTaskWasCompleted(
          this.id,
          epochKey,
          task.id,
        )
      )
        continue;
      const itemId = claudeBackgroundWorkBackend.itemForProviderTask(
        this.id,
        epochKey,
        task.id,
      );
      const terminalState = terminalStateFromProviderStatus(task.status);
      // Stop is the recovery snapshot when task_notification is missing. If its
      // terminal evidence arrives first, first-terminal-wins keeps this status
      // sentence; a later authoritative notification dedupes rather than
      // rewriting durable outcome history. The snapshot's description is what
      // the job IS, not how it ended, so it never stands in as the outcome.
      if (itemId && terminalState) {
        backgroundWorkSupervisor.completed({
          itemId,
          state: terminalState,
          outcomeSummary: `Claude reported the task as ${task.status}`.slice(
            0,
            2_000,
          ),
          eventId: `stop-snapshot:${epochKey}:${task.id}:${task.status}`,
        });
        this.missingProviderTasks.delete(task.id);
        claudeBackgroundWorkBackend.completeItem(this.id, epochKey, itemId);
        continue;
      }
      if (itemId) continue;
      this.observeProviderTask(epochKey, {
        taskId: task.id,
        taskType: task.type,
        description: task.description,
        ...(task.command ? { command: task.command } : {}),
      });
    }
    this.scheduleQuietCloseIfEmpty(epochKey);
  }

  private observeProviderTask(
    epochKey: string,
    task: {
      taskId: string;
      taskType: string;
      description: string;
      command?: string;
    },
  ): string | undefined {
    const existing = claudeBackgroundWorkBackend.itemForProviderTask(
      this.id,
      epochKey,
      task.taskId,
    );
    if (existing) return existing;
    const monitor = task.taskType.toLowerCase().includes("monitor");
    const description = backgroundWorkDescription(task.description);
    const admission = backgroundWorkSupervisor.admit({
      ownerSessionId: this.id,
      backend: "claude-query",
      kind: monitor ? "monitor-command" : "shell",
      label: backgroundWorkTitle({
        description,
        command: task.command,
        fallback: monitor
          ? "Observed Claude monitor"
          : "Observed Claude background shell",
      }),
      ...(description ? { description } : {}),
      ...(task.command ? { command: task.command } : {}),
      sourceRequestId: `observed:${epochKey}:${task.taskId}`,
      hostEpochKey: epochKey,
      observed: true,
    });
    if (!admission.admitted || isTerminalBackgroundState(admission.item.state))
      return undefined;
    claudeBackgroundWorkBackend.observeItem(
      this.id,
      epochKey,
      admission.item.id,
      task.taskId,
    );
    this.retainedEpochKey = epochKey;
    this.retainedEmptyGraceMs = admission.frozen.claudeEmptyHostGraceMs ?? 0;
    backgroundWorkSupervisor.providerBound({
      itemId: admission.item.id,
      providerTaskId: task.taskId,
      providerTaskType: task.taskType,
    });
    return admission.item.id;
  }

  private replaceProviderMembership(
    epochKey: string,
    tasks: Array<{ taskId: string; taskType: string; description: string }>,
  ): void {
    claudeBackgroundWorkBackend.replaceAnnouncedTasks(this.id, epochKey, tasks);
    const present = new Set(tasks.map((task) => task.taskId));
    for (const binding of claudeBackgroundWorkBackend.activeBindings(
      this.id,
      epochKey,
    )) {
      if (!binding.providerTaskId) continue;
      if (present.has(binding.providerTaskId))
        this.missingProviderTasks.delete(binding.providerTaskId);
      else this.missingProviderTasks.add(binding.providerTaskId);
    }
  }

  private allActiveProviderTasksMissing(epochKey: string): boolean {
    const bindings = claudeBackgroundWorkBackend.activeBindings(
      this.id,
      epochKey,
    );
    return (
      bindings.length > 0 &&
      bindings.every(
        (binding) =>
          binding.providerTaskId !== undefined &&
          this.missingProviderTasks.has(binding.providerTaskId),
      )
    );
  }

  private reconcileMissingProviderTasks(epochKey: string): void {
    for (const binding of claudeBackgroundWorkBackend.activeBindings(
      this.id,
      epochKey,
    )) {
      const providerTaskId = binding.providerTaskId;
      if (!providerTaskId || !this.missingProviderTasks.delete(providerTaskId))
        continue;
      backgroundWorkSupervisor.completed({
        itemId: binding.itemId,
        state: "completed",
        outcomeSummary:
          "Claude no longer reports this task; its final status notification was not received.",
        eventId: `membership-absent:${providerTaskId}`,
      });
      claudeBackgroundWorkBackend.completeItem(
        this.id,
        epochKey,
        binding.itemId,
      );
    }
  }

  private scheduleQuietCloseIfEmpty(epochKey: string): void {
    if (
      this.retainedEpochKey !== epochKey ||
      this.running ||
      this.compactOperation ||
      (claudeBackgroundWorkBackend.activeItemCount(this.id, epochKey) > 0 &&
        !this.allActiveProviderTasksMissing(epochKey))
    )
      return;
    this.cancelQuietClose();
    this.quietCloseTimer = setTimeout(() => {
      this.quietCloseTimer = undefined;
      if (this.running || this.compactOperation) return;
      this.reconcileMissingProviderTasks(epochKey);
      if (claudeBackgroundWorkBackend.activeItemCount(this.id, epochKey) > 0)
        return;
      void backgroundWorkSupervisor.closeIdleHost(
        this.id,
        epochKey,
        "the retained Claude host reached its frozen empty quiet grace",
      );
    }, this.retainedEmptyGraceMs);
    this.quietCloseTimer.unref?.();
  }

  private cancelQuietClose(): void {
    if (this.quietCloseTimer) clearTimeout(this.quietCloseTimer);
    this.quietCloseTimer = undefined;
  }

  private markProviderResultForDiscard(timeoutOwnerTurnCounter?: number): void {
    // Today's unconditional foreign-result gate prevents a second denial before
    // this one reaches a result or opportunistic turn-start hint. Keep a count,
    // not a boolean, because
    // result ownership is multiplicity-safe if the CLI later permits overlap.
    //
    // Proper identity-based follow-up: uuid-stamp PA's submitted user messages
    // and correlate results using the CLI's interrupt_receipt_v1/still_queued
    // capability advertised on system/init. Until then, only explicit provider
    // turn boundaries may retire an absent result; content arrival never may.
    this.foreignProviderResultsToDiscard += 1;
    this.providerResultBlocksCompact = true;
    if (this.providerResultResetTimer)
      clearTimeout(this.providerResultResetTimer);
    this.providerResultResetTimer = setTimeout(() => {
      this.providerResultResetTimer = undefined;
      // Timeout never assigns result ownership or unblocks compaction: both stay
      // tied to the counter. It only releases a PA runtime/drain lease loudly if
      // neither a result nor the optional running hint arrived; the counter
      // remains armed for any foreign result that arrives even later.
      if (
        this.running &&
        this.turnCompletion &&
        (timeoutOwnerTurnCounter === undefined ||
          this.turnCounter === timeoutOwnerTurnCounter)
      )
        this.finishTurn({
          stopReason: "error",
          errorMessage:
            "Claude did not establish a new turn after an interrupted background response.",
        });
    }, this.processCloseTimeoutMs);
    this.providerResultResetTimer.unref?.();
  }

  private consumeForeignProviderResult(): void {
    if (this.foreignProviderResultsToDiscard > 0)
      this.foreignProviderResultsToDiscard -= 1;
    if (this.foreignProviderResultsToDiscard > 0) return;
    if (this.providerResultResetTimer)
      clearTimeout(this.providerResultResetTimer);
    this.providerResultResetTimer = undefined;
    this.providerResultBlocksCompact = false;
  }

  private resetProviderResultTracking(): void {
    if (this.providerResultResetTimer)
      clearTimeout(this.providerResultResetTimer);
    this.providerResultResetTimer = undefined;
    this.foreignProviderResultsToDiscard = 0;
    this.providerResultBlocksCompact = false;
  }

  private async closeProcess(reason: string): Promise<void> {
    if (this.processClosing) return;
    this.processClosing = true;
    this.processCloseReason = reason.slice(0, 500);
    this.cancelQuietClose();
    this.inputQueue?.close();
    this.activeQuery?.close?.();
  }

  private handleInBandCompactMessage(
    message: import("./sdkSeam.ts").ClaudeSdkMessage,
  ): boolean {
    const operation = this.compactOperation;
    if (!operation) return false;
    if (
      message.type === "system" &&
      [
        "task_started",
        "task_updated",
        "task_notification",
        "background_tasks_changed",
      ].includes(message.subtype)
    )
      return false;
    const sessionId = captureSessionId(message);
    if (sessionId) this.providerSessionId = sessionId;
    const boundary = compactBoundaryMetadata(message);
    if (boundary) operation.boundary = boundary;
    if (message.type === "result") {
      this.handleSdkMessage(message);
      if ("result" in message && typeof message.result === "string")
        operation.resultText = message.result.trim();
      operation.completion.resolve(undefined);
    }
    return true;
  }

  private async refreshToolLoadState(query: ClaudeQuery): Promise<void> {
    if (!query.getContextUsage) return;
    try {
      const usage = await query.getContextUsage();
      const prefix = externalToolName("");
      const eager = eagerToolNamesFor(this.agentType, this.promptConditions());
      const newlyLoaded: string[] = [];
      for (const tool of usage.mcpTools) {
        if (tool.serverName !== MCP_SERVER_NAME) continue;
        const name = tool.name.startsWith(prefix)
          ? tool.name.slice(prefix.length)
          : tool.name;
        const previous = this.toolLoadState.get(name);
        const loaded = tool.isLoaded ?? false;
        if (loaded && !previous?.loaded && !eager.has(name))
          newlyLoaded.push(name);
        this.toolLoadState.set(name, { loaded, tokens: tool.tokens });
      }
      if (newlyLoaded.length > 0) {
        this.toolLoadEvents.push({
          at: Date.now(),
          via: "tool_search",
          names: newlyLoaded,
        });
        if (this.toolLoadEvents.length > 50)
          this.toolLoadEvents.splice(0, this.toolLoadEvents.length - 50);
      }
    } catch {
      // Query already closed (single-turn exit race) — keep the previous state.
    }
  }

  /**
   * This session's frozen session-start prompt conditions (Task 287): which
   * conditional prompt sections and eager tool groups it was assembled with.
   * Read (never recomputed) on every resumed query so the system prompt stays
   * byte-identical and the provider's cache prefix holds.
   *
   * Cached in memory after the first read: the record is frozen for the life of
   * the session by construction, and this is called on paths that would
   * otherwise hit SQLite repeatedly (the per-tool load-state refresh).
   */
  private promptConditions(): PromptConditions {
    return (this.frozenPromptConditions ??= sessionPromptConditions(
      this.id,
      this.agentType,
    ));
  }

  /** Read the insert-only skill row; no live settings participate here. */
  private frozenSkillNames(): string[] {
    if (!isCodingAgentType(this.agentType)) return [];
    return activeSkillsForSession(this.id, this.agentType) ?? [];
  }

  /** Library-skill loads in the committed transcript (Skill calls, SKILL.md reads). */
  private skillInvocations(frozenNames: string[]): SessionSkillInvocation[] {
    return skillInvocationTrail(frozenNames, this.committedToolCalls());
  }

  /** Raw native tool names: the Skill/Read contract is the CLI's, not an MCP namespace. */
  private committedToolCalls(): SkillInvocationTranscript {
    const calls: SkillInvocationToolCall[] = [];
    const succeeded = new Set<string>();
    for (const entry of this.committed) {
      if (entry.type !== "message") continue;
      if (entry.role === "toolResult") {
        if (!entry.isError) succeeded.add(entry.toolCallId);
        continue;
      }
      if (entry.role !== "assistant") continue;
      const at = Date.parse(entry.createdAt);
      for (const block of entry.content)
        if (block.type === "toolCall")
          calls.push({
            toolCallId: block.toolCallId,
            toolName: block.name,
            input: block.input,
            at: Number.isNaN(at) ? 0 : at,
          });
    }
    return { calls, succeeded };
  }

  /** The Tools-inspector projection: catalog universe + CLI tool-search load state. */
  private toolExposure(): SessionToolExposure {
    const tools = AGENT_TYPES[this.agentType].tools();
    const integrationActive = integrationGatedActiveToolNames(
      this.agentType,
      tools,
      new Set(tools.map((tool) => tool.name)),
    );
    const usable = modeGatedActiveToolNames(
      this.mode,
      tools,
      integrationActive,
    );
    const eager = eagerToolNamesFor(this.agentType, this.promptConditions());
    // Before the first getContextUsage refresh, assume the eager tier is loaded
    // (alwaysLoad) and everything deferred is not.
    const loaded = new Set<string>();
    const tokensByName = new Map<string, number>();
    const definitionCharsByName = new Map(
      tools.map((tool) => [
        tool.name,
        toolDefinitionChars(tool, externalToolName(tool.name)),
      ]),
    );
    const used = new Set<string>();
    for (const entry of this.committed) {
      if (entry.type !== "message" || entry.role !== "assistant") continue;
      for (const block of entry.content)
        if (block.type === "toolCall") used.add(normalizedToolName(block.name));
    }
    for (const name of usable) {
      const state = this.toolLoadState.get(name);
      if (state ? state.loaded : eager.has(name)) loaded.add(name);
      if (state) tokensByName.set(name, state.tokens);
    }
    return buildToolExposure({
      agentType: this.agentType,
      usableToolNames: usable,
      loadedToolNames: loaded,
      usedToolNames: used,
      definitionCharsByName,
      tokensByName,
      loadEvents: this.toolLoadEvents,
    });
  }

  abort(): void {
    if (!this.running) return;
    this.abortingTurn = true;
    // A plain interrupt keeps queued commands and runs them next, so the
    // steers go first and the interrupt waits for the CLI to answer the drops.
    // An ordinary process waits for the same answers before it is killed:
    // killing first would leave a steer it had just taken unknown.
    const hadSteers = this.pendingSteers.size > 0;
    const withdrawn = this.withdrawPendingSteers();
    if (
      this.retainedEpochKey &&
      this.retainedEpochKey === this.queryEpochKey &&
      this.activeQuery?.interrupt
    ) {
      // interrupt() returns before the retained query emits its terminal result.
      // That result belongs to this aborted turn even if another prompt opens on
      // the same query epoch in the meantime.
      this.markProviderResultForDiscard(this.turnCounter);
      const query = this.activeQuery;
      const interrupted = withdrawn
        .then(() => query.interrupt?.())
        .then(
          () => undefined,
          () => undefined,
        );
      // The run ends below, before this interrupt is sent. Until it is, nothing
      // new may enter this query: the interrupt would land on that turn instead.
      this.stopInterrupt = interrupted;
      void interrupted.then(() => {
        if (this.stopInterrupt === interrupted) this.stopInterrupt = undefined;
      });
      this.compactOperation?.completion.reject(
        new Error("Compaction was stopped."),
      );
      this.compactOperation = undefined;
      this.compactOperationEpochKey = undefined;
    } else if (!hadSteers) {
      this.abortController?.abort();
      void this.closeProcess("the active Claude turn was stopped");
    } else {
      const controller = this.abortController;
      const kill = (): void => {
        controller?.abort();
        void this.closeProcess("the active Claude turn was stopped");
      };
      // Until it dies, what the stopped turn still streams is nobody's turn,
      // and nothing new may be written to the process being killed.
      this.stoppingEpochKey = this.queryEpochKey;
      const killed = withdrawn.then(kill, kill);
      this.stopInterrupt = killed;
      void killed.then(() => {
        if (this.stopInterrupt === killed) this.stopInterrupt = undefined;
      });
    }
    // A host-driven turn owns its own rendered teardown.
    if (this.syntheticTurn) return;
    if (this.running) this.finishTurn({ stopReason: "aborted" });
  }

  /** Clear the per-turn failure bookkeeping as a turn opens. */
  private resetTurnFailureState(): void {
    this.pendingProviderError = undefined;
  }

  /** How the live turn ends now that a `result` arrived. */
  private turnOutcome(): {
    stopReason: "end" | "error";
    errorMessage?: string;
  } {
    const failure = this.pendingProviderError;
    return failure
      ? {
          stopReason: "error",
          errorMessage: providerFailureMessage(failure),
        }
      : { stopReason: "end" };
  }

  /** Commit the live turn and broadcast the turn-end envelopes (idempotent). */
  private finishTurn(result: {
    stopReason: "end" | "error" | "aborted";
    errorMessage?: string;
  }): void {
    if (!this.running && !this.liveTurn) return;
    // A run that ends — failed, stopped or with a steer the turn never read —
    // took nothing more: whatever is still queued goes back to its sender.
    void this.withdrawPendingSteers();
    this.running = false;
    const id = this.liveTurnId;
    const turn = this.liveTurn;
    const aborted = result.stopReason === "aborted";
    const errorMessage =
      result.stopReason === "error" ? result.errorMessage : undefined;
    // Classify for the client the way the pi harness does, so a quota/auth/rate
    // failure reads as that rather than as raw provider prose.
    const errorInfo = errorMessage
      ? analyzeProviderError(errorMessage, {
          provider: "anthropic",
          model: this.modelId,
          // A credential profile is a CLI OAuth login with the inherited
          // credential variables scrubbed; without one an API key in the
          // environment could still be what answered.
          authMode: this.credentialProfileId ? "subscription" : "unknown",
        })
      : undefined;
    if (turn) {
      turn.streaming = false;
      if (errorMessage) {
        turn.error = errorMessage;
        // The interrupted provider turn may have emitted no content. Keep a
        // bounded, truthful marker in the durable timeline so a reload does
        // not show the user's prompt with no explanation.
        if (turn.blocks.length === 0)
          turn.blocks.push({ kind: "text", text: errorMessage.slice(0, 500) });
      }
      if (aborted) turn.stopReason = "aborted";
    }
    this.liveTurn = undefined;
    this.liveTurnId = undefined;
    this.activeTurnEpochKey = undefined;
    this.abortingTurn = false;
    const usage = perTurnUsage(this.turnStartTotals, this.cumulative, {
      ...(this.contextTokens !== undefined
        ? { tokens: this.contextTokens }
        : {}),
      window: this.modelOption().contextWindow,
    });
    this.turnStartTotals = undefined;
    if (id) {
      this.broadcast({
        type: "assistantEnd",
        sessionId: this.id,
        id,
        ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        ...(errorInfo !== undefined ? { errorInfo } : {}),
        ...(aborted ? { aborted: true } : {}),
      });
      this.adapterEvents.messageCompleted(id, {
        model: this.modelId,
        ...(usage ? { usage } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...(this.pendingNativeMessageId
          ? { providerMessageId: this.pendingNativeMessageId }
          : {}),
      });
    }
    this.pendingNativeMessageId = undefined;
    if (turn) this.appendAssistantTurn(turn, usage);
    this.updatedAt = Date.now();
    // No post-turn `history` broadcast: turn completion + reconnect are covered
    // by the runtime's durable entryAppended deltas + snapshot timeline.
    this.broadcastState();
    this.broadcastContextInfo(true);
    this.onPersist();
    this.onChange();
    this.turnCompletion?.resolve(undefined);
    this.turnCompletion = undefined;
    this.providerTurnRelease?.();
    this.providerTurnRelease = undefined;
    this.providerTurnEpochKey = undefined;
    this.armIdle();
    if (this.retainedEpochKey) {
      if (
        claudeBackgroundWorkBackend.stopAllWasRequested(
          this.id,
          this.retainedEpochKey,
        )
      )
        void backgroundWorkSupervisor.closeStopAllHost(
          this.id,
          this.retainedEpochKey,
          "background Stop-all reached the provider turn boundary",
        );
      else this.scheduleQuietCloseIfEmpty(this.retainedEpochKey);
    }
  }

  /* ----------------------------- slash commands ---------------------------- */
  // Synthetic tool turns let connection-level slash commands (e.g. /commit) run
  // against this session and render through the normal tool / commit-card UI —
  // the same host surface every harness exposes, so the dispatch in connection.ts
  // is harness-independent.

  /** Open a synthetic assistant turn carrying a single in-progress tool block. */
  beginSyntheticTool(
    name: string,
    args: unknown,
  ): { assistantId: string; toolId: string } {
    this.assertNotDisposed();
    if (this.running)
      throw new SessionBusyError(
        this.id,
        "Cannot run a slash command while Claude is streaming.",
      );
    this.turnCounter += 1;
    this.running = true;
    this.syntheticTurn = true;
    this.liveTurnId = `cssyn-${this.turnCounter}`;
    const toolId = `slash-${Date.now()}-${this.turnCounter}`;
    this.liveTurn = {
      id: this.liveTurnId,
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
      sessionId: this.id,
      id: this.liveTurnId,
    });
    this.adapterEvents.messageStarted(this.liveTurnId);
    this.broadcast({
      type: "toolStart",
      sessionId: this.id,
      id: this.liveTurnId,
      toolId,
      name,
      args,
    });
    this.adapterEvents.toolStarted(toolId, name, args);
    this.broadcast({
      type: "toolUpdate",
      sessionId: this.id,
      id: this.liveTurnId,
      toolId,
      output: "Starting…",
    });
    this.adapterEvents.toolUpdated(toolId, "Starting…");
    this.broadcastState();
    return { assistantId: this.liveTurnId, toolId };
  }

  /** Stream progress text into the in-flight synthetic tool block. */
  updateSyntheticTool(output: string): void {
    if (!this.liveTurn || !this.liveTurnId) return;
    const block = this.liveTurn.blocks.find((b) => b.kind === "tool");
    if (!block || block.kind !== "tool") return;
    block.output = output;
    this.broadcast({
      type: "toolUpdate",
      sessionId: this.id,
      id: this.liveTurnId,
      toolId: block.toolId,
      output,
    });
    this.adapterEvents.toolUpdated(block.toolId, output);
  }

  /** Minimal session context the commit workflow needs (normalized-timeline duck). */
  commitWorkflowContext(): { sessionManager: unknown; cwd?: string } {
    return {
      sessionManager: buildCommitSessionManager(() => this.timelineEntries()),
      cwd: this.cwd,
    };
  }

  discardSyntheticTool(): void {
    const assistantId = this.liveTurnId;
    if (!this.liveTurn || !assistantId) return;
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.hostCommandDiscarded();
    this.discardSyntheticTurn();
  }

  /** Finish a synthetic tool turn with plain tool output. */
  finishSyntheticTool(toolId: string, output: string, isError = false): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    const block = turn.blocks.find(
      (b) => b.kind === "tool" && b.toolId === toolId,
    );
    if (block && block.kind === "tool") {
      block.output = output;
      block.isError = isError;
      block.done = true;
    }
    turn.streaming = false;
    const toolEnd = {
      type: "toolEnd" as const,
      sessionId: this.id,
      id: assistantId,
      toolId,
      output,
      isError,
    };
    this.broadcast(toolEnd);
    this.adapterEvents.toolCompleted(toolEnd);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
      ...(isError ? { error: output } : {}),
    });
    this.adapterEvents.messageCompleted(assistantId, {
      ...(isError ? { errorMessage: output } : {}),
    });
    this.commitSyntheticTurn(turn);
  }

  /**
   * Finish a synthetic `/commit` turn with a rich commit card (the same
   * `{ kind: "commit" }` block pi workshop emits), so the result is visible
   * regardless of the chat's "show tools" setting.
   */
  finishSyntheticCommit(commit: CommitDisplay): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    turn.blocks = [{ kind: "commit", commit }];
    turn.streaming = false;
    const envelope = {
      type: "commitResult" as const,
      sessionId: this.id,
      id: assistantId,
      commit,
    };
    this.broadcast(envelope);
    const card: HostCommandCard = { kind: "commit", id: assistantId, commit };
    this.adapterEvents.hostCommandCard("commit", card, envelope);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.commitSyntheticTurn(turn, { name: "commit", card });
  }

  /** Finish a synthetic `/push` turn with a rich push-result card (mirrors {@link finishSyntheticCommit}). */
  finishSyntheticPush(push: PushDisplay): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    turn.blocks = [{ kind: "push", push }];
    turn.streaming = false;
    const envelope = {
      type: "pushResult" as const,
      sessionId: this.id,
      id: assistantId,
      push,
    };
    this.broadcast(envelope);
    const card: HostCommandCard = { kind: "push", id: assistantId, push };
    this.adapterEvents.hostCommandCard("push", card, envelope);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.commitSyntheticTurn(turn, { name: "push", card });
  }

  /** Finish a synthetic turn with the worktree-provisioning genesis card. */
  finishSyntheticWorktreeProvision(provision: WorktreeProvisionDisplay): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    turn.blocks = [{ kind: "worktreeProvision", provision }];
    turn.streaming = false;
    const envelope = {
      type: "worktreeProvisionResult" as const,
      sessionId: this.id,
      id: assistantId,
      provision,
    };
    this.broadcast(envelope);
    const card: HostCommandCard = {
      kind: "worktreeProvision",
      id: assistantId,
      provision,
    };
    this.adapterEvents.hostCommandCard("worktree", card, envelope);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.commitSyntheticTurn(turn, { name: "worktree", card });
  }

  /** Finish a synthetic `/compact` turn with a rich compaction card. */
  finishSyntheticCompaction(compaction: CompactionDisplay): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    turn.blocks = [{ kind: "compaction", compaction }];
    turn.streaming = false;
    const envelope = {
      type: "compactionResult" as const,
      sessionId: this.id,
      id: assistantId,
      compaction,
    };
    this.broadcast(envelope);
    const card: HostCommandCard = {
      kind: "compaction",
      id: assistantId,
      compaction,
    };
    this.adapterEvents.hostCommandCard("compaction", card, envelope);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.commitSyntheticTurn(turn, { name: "compaction", card });
  }

  /** Finish a synthetic `/clear` turn with the context boundary card. */
  finishSyntheticContextClear(contextClear: ContextClearDisplay): void {
    const turn = this.liveTurn;
    const assistantId = this.liveTurnId;
    if (!turn || !assistantId) return;
    turn.blocks = [{ kind: "contextClear", contextClear }];
    turn.streaming = false;
    const envelope = {
      type: "contextClearResult" as const,
      sessionId: this.id,
      id: assistantId,
      contextClear,
    };
    this.broadcast(envelope);
    const card: HostCommandCard = {
      kind: "contextClear",
      id: assistantId,
      contextClear,
    };
    this.adapterEvents.hostCommandCard("contextClear", card, envelope);
    this.broadcast({
      type: "assistantEnd",
      sessionId: this.id,
      id: assistantId,
    });
    this.adapterEvents.messageCompleted(assistantId);
    this.commitSyntheticTurn(turn, { name: "contextClear", card });
  }

  /**
   * The {@link SyntheticToolHost} compaction step for this harness: the CLI owns
   * this session's context, so we drive ITS manual compaction by sending the
   * literal `/compact` command as the turn's user message. The CLI handles it
   * locally (no model turn runs; verified live), summarizes the transcript in the
   * resumed session file and reports a `compact_boundary` system message; the
   * summary text itself only reaches us through the `PostCompact` hook.
   *
   * Deliberately NOT routed through `handleSdkMessage`: after the boundary the CLI
   * REPLAYS the preserved messages as ordinary user/assistant messages, which
   * would otherwise be appended to the transcript a second time. Only the boundary,
   * the captured session id and the run's usage are taken from this stream.
   */
  async compactContext(
    customInstructions?: string,
  ): Promise<HostCompactionOutcome> {
    if (!this.providerSessionId)
      return {
        kind: "skipped",
        reason: "Nothing to compact yet — this session has no Claude history.",
      };
    if (
      this.activeQuery &&
      this.inputQueue &&
      this.retainedEpochKey === this.queryEpochKey
    )
      return this.compactRetainedQuery(customInstructions);

    let summary: string | undefined;
    let boundary: CompactBoundary | undefined;
    // The CLI's own answer when it declines (e.g. "Not enough messages to
    // compact."), reported as the run result rather than an error.
    let resultText: string | undefined;

    const abortController = new AbortController();
    this.abortController = abortController;
    this.abortingTurn = false;
    try {
      const seam = await this.seamFactory();
      // A standalone compaction is its own query epoch, so its usage rebases onto
      // the session rather than onto whatever the previous epoch had reported.
      this.beginUsageEpoch();
      const query = seam.query({
        prompt: promptIterable(
          `/compact${customInstructions ? ` ${customInstructions}` : ""}`,
        ),
        options: {
          ...buildClaudeSdkQueryOptions({
            cwd: this.cwd,
            abortController,
            modelId: this.modelId,
            thinkingLevel: this.thinkingLevel,
            providerSessionId: this.providerSessionId,
            // Compaction is a CLI-local summarization pass, not an agent turn.
            // Carry the frozen list through option construction for continuity,
            // but explicitly suppress every native/system tool and library
            // plugin; there is nothing to invoke and no runtime to recreate.
            nativeTools: [],
            disableTools: true,
            agentType: this.agentType,
            promptConditions: this.promptConditions(),
            frozenSkillNames: this.frozenSkillNames(),
            ...(this.additionalSystemPrompt
              ? { additionalSystemPrompt: this.additionalSystemPrompt }
              : {}),
            ...(this.credentialProfileId
              ? { env: claudeProfileEnvironment(this.credentialProfileId) }
              : {}),
          }),
          hooks: {
            PostCompact: [
              {
                hooks: [
                  async (input) => {
                    if (
                      "compact_summary" in input &&
                      typeof input.compact_summary === "string"
                    )
                      summary = input.compact_summary;
                    return { continue: true };
                  },
                ],
              },
            ],
          },
        },
      });
      this.activeQuery = query;
      for await (const message of query) {
        const sessionId = captureSessionId(message);
        if (sessionId) this.providerSessionId = sessionId;
        const meta = compactBoundaryMetadata(message);
        if (meta) boundary = meta;
        if (message.type === "result") {
          // Keep session-cumulative usage honest: summarizing costs tokens.
          this.handleSdkMessage(message);
          resultText =
            "result" in message && typeof message.result === "string"
              ? message.result.trim()
              : undefined;
        }
      }
    } finally {
      this.activeQuery = undefined;
      this.abortController = undefined;
    }

    if (abortController.signal.aborted || this.abortingTurn)
      throw new Error("Compaction was stopped.");
    if (!boundary) {
      return {
        kind: "skipped",
        reason: resultText || "Claude did not compact this session.",
      };
    }
    // The post-compaction context size is authoritative and immediately visible;
    // the next request's `message_start` would otherwise be the first correction.
    if (boundary.post !== undefined) {
      this.contextTokens = boundary.post;
      this.broadcastContextInfo(true);
    }
    return {
      kind: "compacted",
      summary:
        summary?.trim() ||
        "Claude compacted this conversation. It did not report the summary text.",
      tokensBefore: boundary.pre,
      ...(boundary.post !== undefined ? { tokensAfter: boundary.post } : {}),
      ...(boundary.firstKept ? { firstKeptEntryId: boundary.firstKept } : {}),
    };
  }

  /**
   * The {@link SyntheticToolHost} clear step for this harness. The CLI owns this
   * session's context and reaches it through the resume id, so forgetting that
   * id IS the clear: the next turn opens a fresh provider session with the same
   * options (system prompt, frozen skills, tools), while the transcript we own
   * keeps every message. The old CLI session file is left alone.
   *
   * A retained query holds the conversation open in a live process, so it has to
   * go first — and only the supervisor may decide that, since background work
   * running under that host would lose its home.
   */
  async clearContext(): Promise<HostClearOutcome> {
    if (this.compactOperation)
      throw new Error("Claude compaction is running; clear after it finishes.");
    if (!this.providerSessionId)
      return {
        kind: "skipped",
        reason: "Nothing to clear — this session has no Claude context yet.",
      };
    const retained = this.retainedEpochKey;
    if (retained) {
      const closed = await backgroundWorkSupervisor.closeIdleHost(
        this.id,
        retained,
        "the session's context was cleared",
      );
      if (!closed)
        throw new Error(
          "Background work still holds this session's Claude host. Stop it, then clear.",
        );
    }
    const tokensBefore = this.contextTokens;
    this.providerSessionId = undefined;
    this.contextTokens = undefined;
    // Persisted immediately: a record that still carried the resume id would
    // hand the cleared context straight back after a restart.
    this.onPersist();
    this.broadcastContextInfo(true);
    return {
      kind: "cleared",
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    };
  }

  private async compactRetainedQuery(
    customInstructions?: string,
  ): Promise<HostCompactionOutcome> {
    if (!this.inputQueue)
      return {
        kind: "skipped",
        reason: "The retained Claude host is unavailable.",
      };
    if (this.compactOperation)
      throw new Error("Claude compaction is already running.");
    if (this.providerResultBlocksCompact)
      throw new Error(
        "Claude is still settling an interrupted background turn; compact after it finishes.",
      );
    const epochKey = this.queryEpochKey;
    if (!epochKey)
      return {
        kind: "skipped",
        reason: "The retained Claude host has no owning query epoch.",
      };
    this.cancelQuietClose();
    await this.stopInterruptSent();
    const operation: CompactOperation = { completion: deferred<void>() };
    this.compactOperation = operation;
    this.compactOperationEpochKey = epochKey;
    this.inputQueue.push(
      sdkUserMessage(
        `/compact${customInstructions ? ` ${customInstructions}` : ""}`,
        [],
      ),
    );
    try {
      await operation.completion.promise;
    } finally {
      if (this.compactOperation === operation) {
        this.compactOperation = undefined;
        this.compactOperationEpochKey = undefined;
      }
    }
    const boundary = operation.boundary;
    if (!boundary)
      return {
        kind: "skipped",
        reason: operation.resultText || "Claude did not compact this session.",
      };
    if (boundary.post !== undefined) {
      this.contextTokens = boundary.post;
      this.broadcastContextInfo(true);
    }
    return {
      kind: "compacted",
      summary:
        operation.summary?.trim() ||
        "Claude compacted this conversation. It did not report the summary text.",
      tokensBefore: boundary.pre,
      ...(boundary.post !== undefined ? { tokensAfter: boundary.post } : {}),
      ...(boundary.firstKept ? { firstKeptEntryId: boundary.firstKept } : {}),
    };
  }

  private discardSyntheticTurn(): void {
    this.liveTurn = undefined;
    this.liveTurnId = undefined;
    this.syntheticTurn = false;
    this.running = false;
    this.updatedAt = Date.now();
    this.broadcastState();
    this.onPersist();
    this.onChange();
    this.armIdle();
    if (this.retainedEpochKey)
      this.scheduleQuietCloseIfEmpty(this.retainedEpochKey);
  }

  /**
   * Commit a finished synthetic turn: clear the live turn FIRST (so `snapshot()`
   * doesn't list it twice — once from normalized history, once from `liveMessages()`),
   * then persist + refresh git/workspace state.
   */
  private commitSyntheticTurn(
    turn: DisplayMessage,
    hostCommand?: { name: string; card: HostCommandCard },
  ): void {
    this.liveTurn = undefined;
    this.liveTurnId = undefined;
    this.syntheticTurn = false;
    if (hostCommand)
      this.appendHostCommandEntry(hostCommand.name, hostCommand.card);
    else this.appendAssistantTurn(turn);
    this.running = false;
    this.updatedAt = Date.now();
    // Durable card converges on the runtime path via the adapter's
    // hostCommandResult → the runtime's durable entry; no `history` broadcast.
    this.broadcastState();
    this.onPersist();
    this.onChange();
    this.armIdle();
    if (this.retainedEpochKey)
      this.scheduleQuietCloseIfEmpty(this.retainedEpochKey);
  }

  /* ------------------------------ SDK messages ----------------------------- */

  /**
   * Record a provider failure seen inside the live turn. The FIRST one wins: the
   * synthetic assistant message names the fault ("monthly spend limit") while the
   * `result` that follows only restates it generically.
   */
  private noteProviderFailure(failure: ProviderFailure): void {
    if (this.pendingProviderError) return;
    this.pendingProviderError = failure;
  }

  /**
   * Open a usage epoch for a `query()` that is about to start. Every `seam.query`
   * call site must do this, ordinary turn and standalone compaction alike: the
   * epoch base is what the session had billed BEFORE this process reported
   * anything, and a missing one silently attributes the epoch's work to nobody.
   */
  private beginUsageEpoch(): void {
    this.epochUsageBase = { ...this.cumulative };
  }

  /**
   * Fold one `result` message's totals into the session's.
   *
   * Per the SDK: `modelUsage`/`total_cost_usd` are "cumulative across turns in
   * streaming-input sessions — each result carries the running total so far, so
   * read the latest result rather than summing across results", and a resumed
   * session starts fresh. So a result is the running total for its `query()`
   * epoch, and the session's is that epoch's base plus it. PA used to ADD each
   * result, which on a retained process (background work keeps one query serving
   * many turns) re-billed every earlier turn of the epoch on every turn: one real
   * session reported 2.45B cache-read tokens where the CLI's own per-request
   * transcript had 143.9M.
   *
   * Magnitude says nothing about which reading applies — a fresh epoch whose one
   * turn costs more than all previous history looks exactly like a running total —
   * so the epoch boundary, not the number, is what decides.
   */
  private applyResultTotals(totals: ClaudeUsage, cost: number): void {
    const reported: CumulativeUsageTotals = {
      input: totals.inputTokens ?? 0,
      output: totals.outputTokens ?? 0,
      cacheRead: totals.cacheReadTokens ?? 0,
      cacheWrite: totals.cacheWriteTokens ?? 0,
      cost,
    };
    // "Crash/startup-error results may carry zeroed usage": a rejected request
    // reports nothing. Rebasing onto its zeroes would erase what this epoch has
    // already billed, so it is not a running total and is ignored.
    if (
      reported.cost === 0 &&
      reported.input +
        reported.output +
        reported.cacheRead +
        reported.cacheWrite ===
        0
    )
      return;
    // A query that reported before its epoch was opened would otherwise be billed
    // from zero and wipe the session's history.
    const base = (this.epochUsageBase ??= { ...this.cumulative });
    this.cumulative = {
      input: base.input + reported.input,
      output: base.output + reported.output,
      cacheRead: base.cacheRead + reported.cacheRead,
      cacheWrite: base.cacheWrite + reported.cacheWrite,
      cost: base.cost + reported.cost,
    };
  }

  private handleSdkMessage(
    message: import("./sdkSeam.ts").ClaudeSdkMessage,
  ): void {
    const sessionId = captureSessionId(message);
    if (sessionId) this.providerSessionId = sessionId;

    switch (message.type) {
      case "stream_event":
        this.handleStreamEvent(message);
        return;
      case "assistant":
        this.handleAssistantMessage(message);
        return;
      case "user":
        this.handleUserMessage(message);
        return;
      case "result": {
        const failure = resultProviderError(message);
        if (failure) this.noteProviderFailure(failure);
        // Read the epoch's TRUE per-model running total (summed from
        // `modelUsage`) — NOT the top-level `result.usage`, which is only the
        // final request's snapshot and misses every intermediate tool-loop
        // request and helper/subagent model (see mapResultEpochUsage).
        const meta = mapResultMeta(message);
        this.applyResultTotals(mapResultEpochUsage(message), meta.cost);
        if (meta.contextWindow) this.contextWindowTokens = meta.contextWindow;
        return;
      }
      default: {
        if (
          message.type === "system" &&
          this.handleBackgroundSystemMessage(message)
        )
          return;
        // The CLI compacted this session's context on its own (threshold/overflow)
        // in the middle of a turn. Nothing in the transcript changes on our side,
        // but the memory system and the context reading must follow it.
        const boundary = compactBoundaryMetadata(message);
        if (boundary) this.handleAutoCompaction(boundary);
        return;
      }
    }
  }

  private handleBackgroundSystemMessage(
    message: Extract<
      import("./sdkSeam.ts").ClaudeSdkMessage,
      { type: "system" }
    >,
  ): boolean {
    const epochKey = this.queryEpochKey;
    if (!epochKey) return false;
    switch (message.subtype) {
      case "background_tasks_changed":
        this.replaceProviderMembership(
          epochKey,
          message.tasks.map((task) => ({
            taskId: task.task_id,
            taskType: task.task_type,
            description: task.description,
          })),
        );
        // This level signal precedes task_started and carries no tool_use_id.
        // Do not manufacture an observed row from it. Missing bound ids settle
        // only after quiet grace, giving the terminal notification precedence.
        this.scheduleQuietCloseIfEmpty(epochKey);
        return true;
      case "task_started": {
        if (
          claudeBackgroundWorkBackend.providerTaskWasCompleted(
            this.id,
            epochKey,
            message.task_id,
          )
        )
          return true;
        let itemId = claudeBackgroundWorkBackend.bindProviderTask(
          this.id,
          epochKey,
          message.task_id,
          message.tool_use_id,
        );
        if (!itemId) {
          const announced = claudeBackgroundWorkBackend.announcedTask(
            this.id,
            epochKey,
            message.task_id,
          );
          const taskType = message.task_type ?? announced?.taskType;
          if (!taskType || (!announced && !isGovernedClaudeTaskType(taskType)))
            return true;
          itemId = this.observeProviderTask(epochKey, {
            taskId: message.task_id,
            taskType,
            description: message.description,
          });
        }
        if (itemId)
          backgroundWorkSupervisor.providerBound({
            itemId,
            providerTaskId: message.task_id,
            ...(message.task_type
              ? { providerTaskType: message.task_type }
              : {}),
          });
        return true;
      }
      case "task_updated":
        // A delta may precede the terminal notification. Keep it as ordering
        // evidence only; task_notification supplies the terminal outcome.
        return true;
      case "task_notification": {
        if (
          claudeBackgroundWorkBackend.providerTaskWasCompleted(
            this.id,
            epochKey,
            message.task_id,
          )
        ) {
          this.missingProviderTasks.delete(message.task_id);
          this.scheduleQuietCloseIfEmpty(epochKey);
          return true;
        }
        let itemId = claudeBackgroundWorkBackend.itemForProviderTask(
          this.id,
          epochKey,
          message.task_id,
        );
        if (!itemId && message.tool_use_id) {
          itemId = claudeBackgroundWorkBackend.bindProviderTask(
            this.id,
            epochKey,
            message.task_id,
            message.tool_use_id,
          );
          if (itemId)
            backgroundWorkSupervisor.providerBound({
              itemId,
              providerTaskId: message.task_id,
            });
        }
        if (!itemId) {
          const announced = claudeBackgroundWorkBackend.announcedTask(
            this.id,
            epochKey,
            message.task_id,
          );
          if (!announced) return true;
          itemId = this.observeProviderTask(epochKey, {
            taskId: message.task_id,
            taskType: announced.taskType,
            description: announced.description,
          });
        }
        if (!itemId) return true;
        this.missingProviderTasks.delete(message.task_id);
        const summary = [
          message.summary.trim(),
          message.output_file ? "Claude reported separate task output." : "",
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 2_000);
        if (message.output_file && !this.capturedTaskOutput.has(itemId)) {
          this.capturedTaskOutput.add(itemId);
          const outputRoot = claudeBackgroundWorkBackend.outputRoot(
            this.id,
            epochKey,
          );
          const evidence = outputRoot
            ? captureTaskOutputArtifact({
                sessionId: this.id,
                outputFile: message.output_file,
                trustedRoot: outputRoot,
                sourceTool: "Claude background task",
              })
            : {
                capturedBytes: 0,
                text: false,
                truncated: false,
                refusalReason: "trusted-output-root-unavailable",
              };
          try {
            const recorded = backgroundWorkStore.recordEvidence({
              itemId,
              eventId: `evidence:${String(message.uuid)}`,
              evidence,
            });
            // recordEvidence deliberately no-ops for a terminal or stale row.
            // Do not leave the generated artifact orphaned in that case.
            if (
              evidence.artifactId &&
              recorded.evidence?.artifactId !== evidence.artifactId
            )
              removeSessionArtifact(this.id, evidence.artifactId);
          } catch {
            // A concurrent terminal transition must not leave an unpinned
            // generated artifact behind.
            if (evidence.artifactId)
              removeSessionArtifact(this.id, evidence.artifactId);
          }
        }
        backgroundWorkSupervisor.completed({
          itemId,
          state: message.status,
          outcomeSummary: summary,
          eventId: String(message.uuid),
        });
        claudeBackgroundWorkBackend.completeItem(this.id, epochKey, itemId);
        this.scheduleQuietCloseIfEmpty(epochKey);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * React to a compaction the CLI performed by itself: correct the context
   * reading, tell the viewer, and reset the memory session context so the next
   * turn re-injects the `<memory>` snapshot the compaction just dropped (the same
   * consequence the pi harness draws from `compaction_end`). The manual `/compact`
   * path handles its own boundary; it never routes through here.
   */
  private handleAutoCompaction(boundary: CompactBoundary): void {
    if (boundary.post !== undefined) {
      this.contextTokens = boundary.post;
      this.broadcastContextInfo(true);
    }
    // No `notice`: automatic compaction is session state, and the corrected
    // context reading pushed above IS the session's own surface saying it — the
    // meter drops. An `info` notice would be an announcement to whoever happens
    // to be viewing, which is what `docs/messaging.md` keeps it out of.
    resetMemorySessionContext(this.id);
    // Learn from the real conversation before the summary is all that is left.
    // Single-flight and independent of the reset above, so it can run detached.
    void memoryScheduler.flushBeforeReset(this.id).catch(() => {});
  }

  private handleStreamEvent(
    message: Extract<
      import("./sdkSeam.ts").ClaudeSdkMessage,
      { type: "stream_event" }
    >,
  ): void {
    if (!this.liveTurn || !this.liveTurnId) return;
    const startId = streamMessageStartId(message);
    if (startId) {
      this.streamMessageId = startId;
      this.streamSubIndex = 0;
    }
    // message_start reports the request's input-side tokens up front → live
    // context-size reading before the committed assistant message lands.
    const startUsage = streamMessageStartUsage(message);
    if (startUsage) {
      const ctx = contextSizeFromUsage(startUsage);
      if (ctx > 0) {
        this.contextTokens = ctx;
        this.broadcastContextInfo();
      }
    }
    // Remember a tool block's id keyed by its block index, so later
    // input_json_delta events (which carry no id) attribute to the right tool.
    const toolId = streamToolBlockId(message);
    if (toolId) this.toolIdsByBlock.set(this.blockKey(message), toolId);

    for (const delta of mapStreamEvent(message)) {
      switch (delta.type) {
        case "text":
          appendText(this.liveTurn.blocks, "text", delta.text);
          this.broadcast({
            type: "textDelta",
            sessionId: this.id,
            id: this.liveTurnId,
            delta: delta.text,
          });
          this.adapterEvents.messageDelta(this.liveTurnId, "text", delta.text);
          this.broadcastContextInfo();
          break;
        case "thinking":
          appendText(this.liveTurn.blocks, "thinking", delta.text);
          this.broadcast({
            type: "thinkingDelta",
            sessionId: this.id,
            id: this.liveTurnId,
            delta: delta.text,
          });
          this.adapterEvents.messageDelta(
            this.liveTurnId,
            "thinking",
            delta.text,
          );
          break;
        case "toolInputDelta": {
          const resolvedId =
            delta.toolCallId || this.toolIdsByBlock.get(this.blockKey(message));
          if (!resolvedId) break;
          // Args stream as they accumulate; the authoritative full args come from
          // the committed assistant message's tool_use input. We broadcast a
          // toolUpdate only when the block is already open.
          const block = this.liveTurn.blocks.find(
            (b) => b.kind === "tool" && b.toolId === resolvedId,
          );
          if (block && block.kind === "tool") {
            this.broadcast({
              type: "toolUpdate",
              sessionId: this.id,
              id: this.liveTurnId,
              toolId: resolvedId,
              output: block.output,
            });
            this.adapterEvents.toolUpdated(resolvedId, block.output);
          }
          break;
        }
        case "toolEnd":
          // Tool completion is driven by the tool_result user message, not here.
          break;
      }
    }
  }

  private blockKey(
    message: Extract<
      import("./sdkSeam.ts").ClaudeSdkMessage,
      { type: "stream_event" }
    >,
  ): string {
    return `${this.streamMessageId ?? String(message.uuid)}#${this.streamSubIndex}:${streamBlockIndex(message)}`;
  }

  private handleAssistantMessage(
    message: Extract<
      import("./sdkSeam.ts").ClaudeSdkMessage,
      { type: "assistant" }
    >,
  ): void {
    if (!this.liveTurn || !this.liveTurnId) return;
    // Provider errors can arrive as assistant messages with a sentinel model
    // such as "<synthetic>". Only reconcile a concrete curated Claude model;
    // feeding an unknown value through the configuration fallback would silently
    // turn it into Sonnet and persist an unintended model switch.
    const model = knownClaudeSdkModelAlias(assistantModel(message));
    if (model) this.modelId = model;
    // Each assistant step's usage reports that request's input-side tokens; the
    // last one before `result` is the current context size. Snapshot, don't sum.
    const ctx = contextSizeFromUsage(assistantUsage(message));
    if (ctx > 0) this.contextTokens = ctx;
    // Keep the newest native uuid of this turn as its fork anchor. Each
    // assistant sub-message overwrites the previous one, so what survives to
    // commit is the LAST native message of the turn. A synthetic error message is
    // a real transcript entry, so it anchors like any other and this has to
    // happen before the failure branch returns.
    if (message.uuid) this.pendingNativeMessageId = String(message.uuid);
    // A provider failure arrives as a synthetic assistant message whose text the
    // CLI never streams. Capture it as the turn's error rather than as turn text:
    // visible text belongs to the live-delta path, and this wording is the only
    // statement of WHICH limit or fault was hit.
    const failure = assistantProviderError(message);
    if (failure) {
      this.noteProviderFailure({ reason: failure.kind, text: failure.text });
      this.streamSubIndex += 1;
      return;
    }
    // Use the committed assistant message ONLY to open tool blocks with full args.
    for (const block of mapAssistantBlocks(message)) {
      if (block.type !== "toolUse") continue;
      if (this.startedTools.has(block.id)) {
        // Already started (e.g. via a prior stream): refresh args authoritatively.
        updateTool(this.liveTurn.blocks, block.id, { args: block.input });
        continue;
      }
      this.startedTools.add(block.id);
      this.liveTurn.blocks.push({
        kind: "tool",
        toolId: block.id,
        name: block.name,
        args: block.input,
        output: "",
        isError: false,
        done: false,
      });
      this.broadcast({
        type: "toolStart",
        sessionId: this.id,
        id: this.liveTurnId,
        toolId: block.id,
        name: block.name,
        args: block.input,
      });
      this.adapterEvents.toolStarted(block.id, block.name, block.input);
    }
    // Advance the sub-message index: the next assistant sub-message (e.g. text
    // following a thinking block) keys on a fresh sub-stream.
    void assistantMessageId(message);
    this.streamSubIndex += 1;
  }

  private handleUserMessage(
    message: Extract<import("./sdkSeam.ts").ClaudeSdkMessage, { type: "user" }>,
  ): void {
    if (!this.liveTurn || !this.liveTurnId) return;
    if (!isToolResultUserMessage(message)) return;
    for (const result of mapToolResults(message)) {
      const toolBlock = this.liveTurn.blocks.find(
        (block) => block.kind === "tool" && block.toolId === result.toolCallId,
      );
      updateTool(this.liveTurn.blocks, result.toolCallId, {
        output: result.content,
        isError: result.isError,
        done: true,
      });
      this.maybeRelinkQuestionToolCallId(
        result.toolCallId,
        toolBlock?.kind === "tool" ? toolBlock.name : undefined,
        result.content,
      );
      const envelope = {
        type: "toolEnd" as const,
        sessionId: this.id,
        id: this.liveTurnId,
        toolId: result.toolCallId,
        output: result.content,
        isError: result.isError,
      };
      this.broadcast(envelope);
      this.adapterEvents.toolCompleted(envelope);
    }
  }

  private repairQuestionToolCallIdsFromTimeline(): void {
    const toolNames = new Map<string, string>();
    for (const entry of this.committed) {
      if (entry.type === "command.result") continue;
      if (entry.role === "assistant") {
        for (const block of entry.content) {
          if (block.type === "toolCall")
            toolNames.set(block.toolCallId, block.name);
        }
      } else if (entry.role === "toolResult") {
        this.maybeRelinkQuestionToolCallId(
          entry.toolCallId,
          toolNames.get(entry.toolCallId),
          textFromContent(entry.content),
        );
      }
    }
  }

  private maybeRelinkQuestionToolCallId(
    toolCallId: string,
    toolName: string | undefined,
    output: string,
  ): void {
    if (normalizedToolName(toolName) !== "ask_questions") return;
    const requestId = questionRequestIdFromOutput(output);
    if (!requestId) return;
    relinkAgentQuestionToolCallId(this.id, requestId, toolCallId);
  }

  /* -------------------------------- naming --------------------------------- */

  setTitle(title: string): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    this.autoNameTried = true;
    this.forkAutoRenamePending = false;
    this.titleGenerationPending = false;
    this.title = trimmed;
    this.updatedAt = Date.now();
    this.onPersist();
    this.onChange();
  }

  private beginAutoName(
    prompt: string,
    attachments: PromptAttachment[],
  ): SessionNamingSettings | undefined {
    if (this.autoNameTried || !prompt.trim()) return undefined;
    this.autoNameTried = true;
    this.forkAutoRenamePending = false;
    const settings = getSettings().sessionNaming;
    // Forks keep their recognizable inherited title while it is refreshed. A
    // genuinely new session has no identity to preserve, so it gets the one
    // honest placeholder rather than the provider default. With naming disabled
    // there is no async phase, so settle directly on the deterministic fallback.
    if (!this.forkOrigin)
      this.title = settings.enabled
        ? UNLABELED_SESSION_TITLE
        : fallbackSessionTitle(prompt, attachments);
    this.titleGenerationPending = settings.enabled;
    return settings.enabled ? settings : undefined;
  }

  private async autoName(
    prompt: string,
    attachments: PromptAttachment[],
    settings: SessionNamingSettings,
  ): Promise<void> {
    const expectedTitle = this.title;
    let titleChanged = false;
    try {
      const title = await generateSessionTitle(prompt, settings, {
        parentSessionId: this.id,
        attachments,
      });
      // A manual rename spends the pending state and must win a race with the
      // naming agent, including when the user chose the placeholder text itself.
      if (!this.titleGenerationPending || this.title !== expectedTitle) return;
      this.title = title ?? fallbackSessionTitle(prompt, attachments);
      this.updatedAt = Date.now();
      titleChanged = true;
    } catch (err) {
      console.warn(
        "Failed to auto-name Claude SDK session:",
        err instanceof Error ? err.message : String(err),
      );
      if (this.titleGenerationPending && this.title === expectedTitle) {
        this.title = fallbackSessionTitle(prompt, attachments);
        this.updatedAt = Date.now();
        titleChanged = true;
      }
    } finally {
      const pendingChanged = this.titleGenerationPending;
      this.titleGenerationPending = false;
      if (titleChanged) this.onPersist();
      if (titleChanged || pendingChanged) this.onChange();
    }
  }

  /* --------------------------------- list ---------------------------------- */

  /**
   * `approvals` and `taskChoices` are the per-list-build sets of
   * approval-blocked and Task-pick-blocked sessions. They are parameters rather
   * than lookups because both stores are FILE reads: asking them per row would
   * re-read and re-parse a store for every SDK session of every broadcast (see
   * `sessions.ts`'s one-pass contract).
   */
  listItem(
    readAt: number,
    approvals?: Set<string>,
    taskChoices?: Set<string>,
  ): import("../sessions.ts").InternalSessionListItem {
    const approvalBlocked = approvals
      ? approvals.has(this.id)
      : hasPendingApproval(this.id);
    const taskChoiceBlocked = taskChoices
      ? taskChoices.has(this.id)
      : hasChoosingTaskCard(this.id);
    const attention = getPendingAgentQuestion(this.id)
      ? "question"
      : approvalBlocked
        ? "approval"
        : taskChoiceBlocked
          ? "task-choice"
          : undefined;
    const runStartedAt = this.running
      ? sessionRunStartedAt(this.id)
      : undefined;
    return {
      id: this.id,
      file: this.id,
      harness: this.harness,
      agentType: this.agentType,
      title: this.title,
      ...(this.titleGenerationPending ? { titleGenerationPending: true } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messageCount: this.messageCount(),
      model: this.modelOption(),
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.running,
      ...(runStartedAt !== undefined ? { runStartedAt } : {}),
      awaitingInput: Boolean(attention),
      ...(attention ? { attention } : {}),
      unread: this.updatedAt > readAt,
      ...(this.forkOrigin ? { forkOrigin: this.forkOrigin } : {}),
      ...(this.forkAutoRenamePending ? { forkAutoRenamePending: true } : {}),
    };
  }

  toRecord(): ClaudeSdkRecord {
    return { ...this.toRecordMeta(), entries: this.timelineEntries() };
  }

  /** {@link toRecord} without the timeline: what a persist writes whole. */
  toRecordMeta(): ClaudeSdkRecordMeta {
    return {
      id: this.id,
      title: this.title,
      ...(this.providerSessionId !== undefined
        ? { providerSessionId: this.providerSessionId }
        : {}),
      ...(this.forkOrigin ? { forkOrigin: this.forkOrigin } : {}),
      ...(this.forkAutoRenamePending ? { forkAutoRenamePending: true } : {}),
      modelId: this.modelId,
      thinkingLevel: this.thinkingLevel,
      mode: this.mode,
      agentType: this.agentType,
      ...(this.additionalSystemPrompt
        ? { additionalSystemPrompt: this.additionalSystemPrompt }
        : {}),
      ...(this.cwd !== CWD ? { cwd: this.cwd } : {}),
      ...(this.credentialProfileId
        ? { credentialProfileId: this.credentialProfileId }
        : {}),
      usage: {
        ...this.cumulative,
        ...(this.contextTokens !== undefined
          ? { contextTokens: this.contextTokens }
          : {}),
        ...(this.contextWindowTokens !== undefined
          ? { contextWindow: this.contextWindowTokens }
          : {}),
      },
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.cancelIdle();
    this.abortController?.abort();
    if (this.retainedEpochKey && !backgroundWorkSupervisor.isDraining)
      backgroundWorkSupervisor.hostLost(
        this.id,
        this.retainedEpochKey,
        "the retained Claude session was disposed",
      );
    void this.closeProcess("the Claude session was disposed");
    this.providerTurnRelease?.();
    this.providerTurnRelease = undefined;
    this.providerTurnEpochKey = undefined;
    this.cancelQuietClose();
    void this.toolServer?.close();
    this.toolServer = undefined;
    closeToolGroupSession(this.id);
    this.unsubscribeQuestions();
    this.unsubscribeApprovals();
    this.unsubscribeTaskChoices();
    this.adapterEvents.clear();
    this.viewers.clear();
  }
}

function normalizeThinkingLevel(level: string | undefined): ThinkingLevel {
  switch (level) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return level;
    default:
      return "medium";
  }
}

function sdkUserMessage(
  text: string,
  images: ImageContentLike[],
): ClaudeSdkUserMessage {
  const content =
    images.length === 0
      ? text
      : [
          ...images.map((image) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: image.mimeType,
              data: image.data,
            },
          })),
          { type: "text" as const, text },
        ];
  return {
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content },
  } as unknown as ClaudeSdkUserMessage;
}

/** A single-prompt iterable used only when no retained process is alive. */
async function* promptIterable(
  text: string,
): AsyncIterable<ClaudeSdkUserMessage> {
  yield sdkUserMessage(text, []);
}

/**
 * A `command_lifecycle` frame, with the uuid of the command it reports the CLI
 * just dequeued. These frames come with the CLI's `msg_lifecycle_v1` capability
 * but are not in the SDK's typed message union, so they are read structurally;
 * the turn's `result` listing the consumed uuids stays the authoritative record
 * when one is missing.
 */
function commandLifecycle(
  message: ClaudeSdkMessage,
): { started: string | undefined } | undefined {
  const frame = message as {
    type?: unknown;
    state?: unknown;
    command_uuid?: unknown;
  };
  if (frame.type !== "command_lifecycle") return undefined;
  return {
    started:
      frame.state === "started" && typeof frame.command_uuid === "string"
        ? frame.command_uuid
        : undefined,
  };
}

/**
 * Ask the CLI to drop one queued message: `true` only when it confirms the
 * drop, within {@link STEER_CANCEL_TIMEOUT_MS}. No method, a failure, a
 * refusal or silence are all "cannot say".
 */
async function dropQueuedMessage(
  query: ClaudeQuery | undefined,
  uuid: string,
): Promise<boolean> {
  const cancel = query?.cancelAsyncMessage?.(uuid);
  if (!cancel) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), STEER_CANCEL_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      cancel.then(
        (dropped) => dropped === true,
        () => false,
      ),
      silence,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isClaudeTurnStart(message: ClaudeSdkMessage): boolean {
  return (
    message.type === "system" &&
    message.subtype === "session_state_changed" &&
    message.state === "running"
  );
}

/**
 * The command a governed tool call carries: Bash's `command`, a Monitor's
 * `command`, or the Monitor's WebSocket URL when it watches a socket instead.
 */
function toolInputCommand(
  toolInput: Record<string, unknown>,
): string | undefined {
  if (typeof toolInput.command === "string" && toolInput.command.trim())
    return toolInput.command;
  const ws = toolInput.ws;
  if (
    ws &&
    typeof ws === "object" &&
    typeof (ws as { url?: unknown }).url === "string"
  )
    return (ws as { url: string }).url;
  return undefined;
}

function isGovernedClaudeTaskType(taskType: string): boolean {
  const normalized = taskType.toLowerCase();
  return (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("monitor")
  );
}

function isTerminalBackgroundState(state: string): boolean {
  return ["completed", "failed", "not-started", "stopped", "lost"].includes(
    state,
  );
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    timer.unref?.();
  });
  const settled = promise.then(
    () => true as const,
    () => true as const,
  );
  try {
    return await Promise.race([settled, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function terminalStateFromProviderStatus(
  status: string,
): "completed" | "failed" | "stopped" | undefined {
  switch (status.toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}
