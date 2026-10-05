import type { WebSocket } from "ws";
import {
  SESSION_READ_DWELL_MS,
  WORKTREE_MISSING_BLOCKED_REASON,
  backgroundWorkBlockedReason,
  slashCommandApplies,
  isOrdinarilyCreatableAgentType,
  CLAUDE_SDK_PROVIDER,
  isClaudeSdkModel,
  SESSION_MODES,
  projectSummaryOf,
  type AgentType,
  type AgentQuestionResponse,
  type BroadcastTopic,
  type AppSettings,
  type BraveSettingsPatch,
  type ClientMessage,
  type ConfluenceSettingsPatch,
  type Context7SettingsPatch,
  type ForgejoSettingsPatch,
  type GithubSettingsPatch,
  type GoogleSettingsPatch,
  type JiraSettingsPatch,
  type OpenAiCompatibleSettingsPatch,
  type SlackSettingsPatch,
  type TempoSettingsPatch,
  type PromptQueueCommand,
  type CodeDeliveryWorkflowConfig,
  type CommentTarget,
  commentTargetKey,
  MAX_OPEN_COMMENT_TARGETS,
  type Harness,
  type MessageTarget,
  type SettableSpawnOwnership,
  messageTargetForComment,
  type WorktreeMergeStrategy,
  type WorktreeProvisionDisplay,
  type ProjectListRequest,
  type ProjectListResponse,
  type ProjectRecord,
  type ServerMessage,
  type SelectorBundle,
  type SessionMode,
  type ThinkingLevel,
  type TimelineCacheDescriptor,
  type TaskListRequest,
  type TaskListResponse,
  type TaskProjectAssignmentUpdate,
  type TaskReorderPlacement,
  type TaskSaveRequest,
  type TaskSessionRef,
  type TaskStatus,
  type TimelineAnchor,
  type TimelineAnchorTarget,
  type WorkflowRunLimits,
  type PromptAttachment,
} from "@assistant/shared";
import { TIMELINE_RANGE_MAX_LIMIT } from "@assistant/shared/runtime";
import {
  drainRecipient,
  HISTORY_EXPANSION_MAX_MESSAGES,
  peerPromptAnchorFor,
  peerPromptThreadsFor,
} from "./peerPrompt.ts";
import {
  availableAgents,
  isAgentAvailable,
  isAgentSessionAvailable,
} from "./agents.ts";
import { testBraveSettings } from "./braveSettings.ts";
import { testOpenAiCompatibleSettings } from "./openAiCompatibleSettings.ts";
import { testContext7Settings } from "./context7Settings.ts";
import { testForgejoSettings } from "./forgejoSettings.ts";
import { testGithubSettings } from "./githubSettings.ts";
import { testGoogleSettings } from "./googleSettings.ts";
import { getSettings } from "./settings.ts";
import {
  announceSettingsWritten,
  saveSettings,
  type SettingsChange,
} from "./settingsService.ts";
import { describeSttAvailability } from "./speech/sttConfig.ts";
import { testSlackHuddleSettings, testSlackSettings } from "./slackSettings.ts";
import { testTempoSettings } from "./tempoSettings.ts";
import { testConfluenceSettings } from "./confluenceSettings.ts";
import { testJiraSettings } from "./jiraSettings.ts";
import { hub } from "./hub.ts";
import {
  isLiveSession,
  type HarnessDriver,
  type LiveSession,
  type Viewer,
} from "./harness.ts";
import { randomUUID } from "node:crypto";
import { createSession } from "./harnesses/create.ts";
import { existingSessionRefusal } from "./harnesses/availability.ts";
import { prepareFork } from "./harnesses/fork.ts";
import { handoffEngine } from "./harnesses/handoffSession.ts";
import { harnessRegistry } from "./harnesses/registry.ts";
import { sessionRefFile } from "./harnesses/storage.ts";
import {
  pickerModels,
  piModel,
  piModelForAccount,
  refreshPiModels,
} from "./harnesses/models.ts";
import {
  firstSendEngine,
  type FirstSendRefusal,
  type FirstSendRequest,
  type PersonaGate,
} from "./harnesses/firstSend.ts";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import {
  attachRuntimeView as attachRuntimeViewToTransport,
  type RuntimeBackedView,
} from "./session/attach.ts";
import {
  ensureRuntimeSessionWithRuntime as ensureRuntimeSession,
  promptRuntimeSession,
  promptRuntimeSessionAndCaptureText,
} from "./session/runtimePrompt.ts";
import { deliverAgentHandoff } from "./agentHandoffs.ts";
import { forgetPlanHintState } from "./session/planHint.ts";
import { assertValidDate } from "./dayScan/dayState.ts";
import { runDayCollection } from "./dayScan/collectionRun.ts";
import { runDaySynthesis } from "./dayScan/synthesisRunner.ts";
import { writeDayBriefingNarrative } from "./dayScan/synthesisApply.ts";
import {
  buildDaySynthesisDigest,
  renderDayBriefingPrompt,
  renderLogMyTimePrompt,
} from "./dayScan/digest.ts";
import {
  beginDayScanProgress,
  endDayScanProgress,
  reportDayScanStep,
} from "./dayScan/scanProgress.ts";
import {
  clearDaySession,
  daySessionTitle,
  getDaySessionId,
  setDaySessionId,
} from "./calendarDaySessions.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { getRun as getWorkflowRun } from "./db/workflowStore.ts";
import { subagentStore } from "./db/subagentStore.ts";
import {
  BackgroundWorkValidationError,
  backgroundWorkStore,
} from "./db/backgroundWorkStore.ts";
import { backgroundWorkSnapshot } from "./backgroundWorkRegistry.ts";
import {
  backgroundWorkHumanStopDeps,
  stopAllBackgroundWorkForHuman,
  stopBackgroundWorkForHuman,
} from "./backgroundWorkHumanStop.ts";
import { backgroundCompletionTurns } from "./backgroundWork/completionDelivery.ts";
import {
  subagentRunRevisionDigest,
  subagentRunStateItems,
  subagentThreadRunDetail,
  subagentThreadRevisionDigest,
  subagentThreadStateItems,
} from "./subagentRegistry.ts";
import { defaultOpenAiProfileId } from "./credentialProfiles.ts";
import { revalidateUsage, usageIndicators } from "./usageCache.ts";
import {
  broadcastWorkflowRuns,
  workflowRunCardFor,
  workflowRunListMessage,
} from "./workflowRuns.ts";
import { settleWorkflowRun } from "./workflow/runSettlement.ts";
import {
  cleanUpWorkflowRunCheckout,
  mergeWorkflowRunPullRequest,
} from "./workflow/deliveryActions.ts";
import { startCodeDeliveryRun } from "./workflow/runStart.ts";
import {
  answerCeilingDecision,
  cancelRun,
  pauseRun,
  rebaseAndReviewRun,
  resumeRun,
  retryRun,
} from "./workflow/engine.ts";
import { deleteCancelledWorkflowRun } from "./workflow/runCleanup.ts";
import { accountForSlot } from "./settingsModelSlots.ts";
import {
  applySessionContext,
  resolveSessionContext,
  sessionContextEvidence,
  type SessionContextRequest,
} from "./sessionContext.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import { publishSkillLibrary } from "./skills/skillLibrary.ts";
import { projectStore } from "./db/projectStore.ts";
import { findSlashCommand, slashCommands } from "./slashCommands.ts";
import { SteerWithdrawnError } from "./session/runtime/index.ts";

/** A held message whose provider never confirmed it was dropped unread. */
const STEER_MAY_HAVE_BEEN_READ =
  "Send it again only if the response did not pick it up.";
import {
  clearPromptQueue,
  deleteSessionPromptQueue,
  moveQueuedPrompt,
  pausePromptQueueForStop,
  queuePrompt,
  removeQueuedPrompt,
  resumePromptQueue,
  resumePromptQueueForHumanPrompt,
  sendQueuedPromptNow,
  updateQueuedPrompt,
} from "./promptQueue.ts";
import { settleSessionWithPeers } from "./sessionActivity.ts";
import {
  setSpawnOwnership,
  type SpawnOwnershipResult,
} from "./spawnOwnership.ts";
import {
  CONTEXT_ONLY_SLASH_COMMANDS,
  hostSlashCommandRunner,
  recordWorktreeProvisionForHost,
} from "./hostSlashCommands.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  listTasks,
  markTaskProcessed,
  readTask,
  taskRevisionDigest,
  taskStateItems,
  reorderTasks,
  unarchiveTask,
  unlinkSessionEverywhere,
  updateTask,
} from "./tasks.ts";
import {
  coerceMemoryListFilter,
  coerceMemoryMutateOperation,
  getMemoryLineage,
  listMemory,
  mutateMemory,
  recentMemoryLoads,
} from "./memory/memoryApi.ts";
import { processorConfigStatus } from "./memory/memoryProcessor.ts";
import {
  clearPendingQuestion,
  submitAgentQuestionResponse,
} from "./tools/core/questionTool.ts";
import {
  cancelPostReloadContinuation,
  deleteToolGroupSessionData,
} from "./mcp/toolGroups/registry.ts";
import {
  archiveProject,
  deleteProject,
  getProject,
  listProjects,
  reorderProjects,
  updateProject,
  projectRevision,
  projectRevisionDigest,
  projectStateItems,
} from "./projectRegistry.ts";
import {
  cloneAndRegisterProjectRepo,
  deleteProjectRepoFolder,
  isManagedRepoDir,
} from "./projectProvision.ts";
import {
  broadcastWorktreeList,
  createWorktree,
  listWorktreeRecords,
} from "./worktrees/worktrees.ts";
import {
  canonicalWorktreeId,
  invalidateMainRepo,
  isMainWorktreeId,
  mainCheckoutPathForProject,
  resolveWorktreeRow,
} from "./worktrees/worktreeResolve.ts";
import {
  generateWorktreeSuffix,
  sanitizeWorktreeSuffix,
  taskWorktreeName,
} from "./worktrees/worktreeNaming.ts";
import { worktreeIdForSession } from "./db/worktreeStore.ts";
import { removeWorktreeAndSettleSessions } from "./worktreeRemoval.ts";
import {
  acknowledgeMissingSessionWorktree,
  sessionWorktreeMissing,
} from "./worktrees/sessionCwd.ts";
import { computeWorktreeStatus } from "./worktrees/worktreeStatus.ts";
import {
  addWorktreeViewer,
  removeWorktreeViewer,
} from "./worktrees/worktreeWatcher.ts";
import { markCommentsAttached } from "./worktrees/worktreeComments.ts";
import { buildReviewHandoffPrompt } from "./worktrees/reviewHandoff.ts";
import { mergeWorktree } from "./worktrees/worktreeMerge.ts";
import { existsSync } from "node:fs";
import {
  approvalForId,
  approvalGrantsForSession,
  approvalsForSession,
  resolveApproval,
  revokeApprovalGrant,
} from "./pendingApprovals.ts";
import { approvalAnchorFor } from "./approvalAnchor.ts";
import { cardsForSession, pullRequestCardById } from "./pullRequestCards.ts";
import {
  finalizePullRequestCard,
  pullRequestOutcomePrompt,
} from "./prWorkflow.ts";
import {
  PULL_REQUEST_REBASE_OUTCOME,
  recordRebaseHandoff,
  runPullRequestCardAction,
} from "./pullRequestActions.ts";
import { errorText } from "./errors.ts";
import { serverBuildInfo } from "./buildInfo.ts";
import { resolvePaObjectLinks } from "./objectLinkResolver.ts";
import {
  enqueuePermanentAssistant,
  isPermanentAssistantSession,
  permanentAssistantSessionId,
  permanentAssistantViewableId,
  sessionListHiddenProbe,
  subscribePermanentAssistant,
} from "./permanentAssistant.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { commentStoreFor } from "./comments/commentStores.ts";
import {
  commentOwnership,
  commentsSnapshot,
  rememberCommentOwnership,
} from "./comments/commentEvents.ts";

/**
 * How many Tasks' activity traces one connection stays subscribed to. Generous
 * for real use (you do not have dozens of Task pages open) and bounded so a
 * long-lived tab cannot accumulate subscriptions indefinitely.
 */
/**
 * The mutation a connection is currently answering, carried in async context.
 *
 * Correlated commands interleave (the socket does not await `handle`), so this
 * cannot be connection state: each `handle` runs its dispatch inside its own
 * scope, and `send` reads whichever scope its call stack belongs to. `failed`
 * makes the outcome exactly one message — an error carrying the id, or a
 * settle.
 */
interface MutationScope {
  connection: Connection;
  /** Absent for an uncorrelated command: nothing to stamp, but still an outcome. */
  requestId?: string;
  failed: boolean;
}

const mutationScope = new AsyncLocalStorage<MutationScope>();

/** Bounds one untrusted digest catch-up read without forcing per-row requests. */
const MAX_STATE_ITEM_IDS = 2_000;

/** Conservative id allow-list for session ids before any side effect. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/**
 * Whether a value can be awaited, by SHAPE. A `void | Promise<void>` seam is a
 * declaration about the contract, not about the object that arrives, so an
 * `instanceof Promise` test would miss a thenable minted in another realm or
 * returned by a wrapped SDK client — and a missed rejection here is an
 * unhandled one. See {@link Connection.applySessionConfig}.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Which Task(s) a browser command means the user has PROCESSED.
 *
 * This is the ONE place the "any user decision triages" invariant lives, and it
 * is deliberately a total switch over every Task-related client message rather
 * than a call sprinkled through each handler: threading an actor by hand kept
 * producing holes (assigning a project, archiving, commenting), each of which is
 * plainly a user decision and each of which silently left the Task waiting in
 * the Inbox.
 *
 * `connection.ts` applies it centrally after a command SUCCEEDS, so a new Task
 * command is covered by adding its case here — and `taskTriageCoverage.test.ts`
 * fails if one is added without a decision either way.
 *
 * The `[]` cases are the deliberate exclusions:
 *  - reads (`listTasks`, `getTask`, `listTaskComments`) — an inbox that empties
 *    itself when you glance at a row cannot track what you owe an answer to;
 *  - `deleteTask` — the Task is gone, there is nothing to triage;
 *  - `reorderTasks` — a drop renumbers every sibling, so `tasks.ts`
 *    `reorderTasks(..., byUser)` triages only the Tasks whose PARENT moved.
 */
export function tasksProcessedByUserCommand(msg: ClientMessage): string[] {
  switch (msg.type) {
    case "saveTask":
      // An explicit state choice outranks the implicit "any edit processes it"
      // rule: `triaged: false` IS the put-it-back operation, so processing the
      // Task afterwards would undo the only thing the save asked for.
      if (msg.request.triaged === false) return [];
      // A create is typed straight into the Backlog and triaged at birth; an
      // update is the user acting on an existing Task.
      return msg.request.id ? [msg.request.id] : [];
    case "assignTaskProjects":
      return msg.updates.map((update) => update.id);
    case "archiveTask":
      return [msg.id];
    case "addComment":
      return msg.target.kind === "task" ? [msg.target.taskId] : [];
    case "listTasks":
    case "getTask":
    case "listComments":
    case "deleteTask":
    case "reorderTasks":
      return [];
    default:
      return [];
  }
}

function markProcessedTasksFor(msg: ClientMessage): void {
  for (const id of tasksProcessedByUserCommand(msg)) {
    try {
      markTaskProcessed(id);
    } catch {
      // Triage is bookkeeping ABOUT a command that already succeeded; it must
      // never turn a completed user action into a reported failure.
    }
  }
}

export function isRunStartingMessage(msg: ClientMessage): boolean {
  switch (msg.type) {
    case "prompt":
    case "harnessSend":
    case "newSession":
    case "createDraftSession":
    case "runSlashCommand":
    case "acceptCommitDryRun":
    // Resolving an approval executes server-side and then resumes the idle
    // session with a hidden outcome prompt — a fresh run, like a question answer.
    case "resolveApproval":
    // Answering a `choosing-task` pull-request card drafts and creates the PR,
    // then resumes the idle session the same way.
    case "resolvePullRequestCardTask":
    // A card action can resume the session too (a conflicted update-with-main
    // hands the rebase to the agent), and the rest — merging, removing a
    // worktree — is precisely the work a drain must not start either.
    case "pullRequestCardAction":
    // The run-level aliases for two of those same card actions.
    case "mergeWorkflowRun":
    case "cleanUpWorkflowRun":
    // Answering a pending question resumes the session with a fresh (hidden) run.
    // During a reload/shutdown drain that would push runningCount back above zero
    // and reset the settle timer, so the deploy hangs until the force timeout.
    // Reject it like any other run-starting message; the pending question persists
    // across the restart, so the card reappears and the user re-answers on reconnect.
    case "respondToQuestion":
      return true;
    default:
      return false;
  }
}

/**
 * One WebSocket connection: a thin *view* onto a `LiveSession` (`harness.ts`)
 * owned by the {@link hub}. Switching, closing or reconnecting only
 * attaches/detaches — the underlying agent run lives on in the hub, so no
 * in-flight work is lost.
 */
interface InitialSessionRoute {
  /** OUR session id from a deep link `/sessions/<id>`. */
  sessionId: string;
  timelineCache?: TimelineCacheDescriptor;
}

/**
 * The context a send asks for, in the shared request shape.
 *
 * `worktree` is passed only by the FIRST-SEND paths: a session born in a
 * checkout adopts that checkout's Project, while a later send into a running
 * session attaches only what the composer staged.
 */
function sessionContextRequest(
  msg: {
    attachTaskId?: string;
    projectId?: string;
    knowledgeEntryId?: string;
  },
  worktree?: { projectId?: string } | null,
): SessionContextRequest {
  return {
    ...(msg.attachTaskId ? { taskId: msg.attachTaskId } : {}),
    ...(msg.projectId ? { projectId: msg.projectId } : {}),
    ...(msg.knowledgeEntryId ? { knowledgeEntryId: msg.knowledgeEntryId } : {}),
    ...(worktree?.projectId ? { worktreeProjectId: worktree.projectId } : {}),
  };
}

/** Day-session creations under way, by date, shared by every connection. */
const dayCreations = new Map<string, Promise<LiveSession>>();

/**
 * Create `date`'s day session once however many activations ask at the same
 * time, and bind it. Creation yields before the binding is written, so two
 * overlapping activations would each create one, and the later binding would
 * hide the earlier conversation from the day panel. An activation that read
 * the binding before another's creation settled finds that session here.
 */
function createDaySessionOnce(
  date: string,
  create: () => Promise<LiveSession>,
): Promise<LiveSession> {
  let pending = dayCreations.get(date);
  if (!pending) {
    pending = (async () => {
      const boundId = getDaySessionId(date);
      // A failed look-up is a stale binding, as for the activation itself:
      // it must not fail every activation sharing this creation.
      const bound = boundId
        ? await hub.acquireById(boundId).catch(() => undefined)
        : undefined;
      if (isLiveSession(bound)) return bound;
      const created = await create();
      setDaySessionId(date, created.sessionId);
      return created;
    })().finally(() => dayCreations.delete(date));
    dayCreations.set(date, pending);
  }
  return pending;
}

export class Connection implements Viewer {
  /** The session this connection is currently displaying (pi or Claude SDK). */
  private viewing: HarnessDriver | undefined;
  /**
   * The connection renders viewed sessions through the normalized runtime +
   * transport. Holds the prompt/abort/model handle for the active view.
   */
  private runtimeView: RuntimeBackedView | undefined;
  /**
   * The newest intent about what this connection views, as a ticket. Socket
   * messages are handled concurrently, and a view request acquires its session
   * asynchronously: in a rapid A→B→A a slow B acquisition can finish LAST, and
   * without this it would attach B, send B's snapshot and route every later
   * command to B while the address bar names A. A request claims a ticket
   * before it awaits and attaches only if no newer intent — another request,
   * or a session created/forked and viewed meanwhile — has claimed one since.
   */
  private viewRequestSeq = 0;
  /**
   * The session the newest claim is for, when its claimant knows it: a load,
   * the deep link, a send into an existing session, and every attach. A
   * creation or fork has no id yet and claims for no session. A leave
   * (`clearSessionView`) supersedes the newest claim only when it is for the
   * session being left.
   */
  private viewRequestTarget: string | undefined;
  /**
   * On the runtime path the connection is NOT a direct engine viewer, so the
   * engine's non-chat `broadcastState`/`contextInfo`/`notice` envelopes would not
   * reach the client through adapter-native events. This filtered viewer forwards
   * exactly those — so live `SessionState` changes the runtime doesn't drive
   * (pendingQuestion cleared, tasks/toolGroups, the live token meter, notices)
   * still update the UI. Detached on session switch / close.
   */
  private engineStateViewer:
    { live: HarnessDriver; viewer: Viewer } | undefined;
  private disposed = false;
  private archivedSessionsLoaded = false;
  /** Bounded per-object comment subscriptions. */
  private readonly openComments = new Map<string, CommentTarget>();
  /** Latest list generation per target; unwatch cancels an in-flight read. */
  private readonly commentListGenerations = new Map<string, string>();
  /**
   * Domain lists this connection is currently showing. Empty until the client
   * subscribes, so a browser sitting in a conversation receives no list traffic
   * at all (see `BroadcastTopic`).
   */
  private readonly topics = new Set<BroadcastTopic>();
  /** Authorized run-detail topics held by this connection. */
  private readonly heldSubagentThreads = new Set<string>();
  /** Worktrees this connection is live-watching (refcounted in the watcher). */
  private readonly watchedWorktrees = new Set<string>();
  /**
   * The pending read mark for the session this connection is viewing (see
   * {@link armReadDwell}). At most one: viewing another session replaces it, and
   * the session it was armed for stays unread.
   */
  private readDwell:
    { sessionId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  private permanentAssistantOff: (() => void) | undefined;
  /**
   * Server-minted identity for THIS connection instance — never client-supplied,
   * unlike the WebSocket message `requestId`. Combined with `requestId` and a hash
   * of the validated operation to form a trusted memory-mutation idempotency key
   * (see `onMemoryMutate`): a bare client `requestId` alone is tab-local and
   * caller-chosen, so it could collide across connections or be crafted to replay
   * an unrelated operation's cached ledger result.
   */
  private readonly connectionId = randomUUID();

  constructor(
    private readonly ws: WebSocket,
    private readonly initialRoute?: InitialSessionRoute,
    private readonly publicBaseUrl?: string,
    private readonly webBuildId?: string,
  ) {}

  private settings(): AppSettings {
    return getSettings(this.publicBaseUrl);
  }

  wantsArchivedSessions(): boolean {
    return this.archivedSessionsLoaded;
  }

  viewingSessionId(): string | undefined {
    return this.viewing?.id;
  }

  wantsTopic(topic: BroadcastTopic): boolean {
    return this.topics.has(topic);
  }

  wantsSubagentThread(threadId: string): boolean {
    return this.heldSubagentThreads.has(threadId);
  }

  wantsComments(target: CommentTarget): boolean {
    return this.openComments.has(commentTargetKey(target));
  }

  wantsWorktree(worktreeId: string): boolean {
    return this.watchedWorktrees.has(canonicalWorktreeId(worktreeId));
  }

  async init(): Promise<void> {
    hub.register(this);
    // This must be the FIRST production frame. A tab can remain open across a
    // deploy; detecting the new browser build before snapshots/events prevents
    // its old reducer from consuming a newer wire shape before it reloads.
    if (this.webBuildId)
      this.send({ type: "webBuild", webBuildId: this.webBuildId });
    this.permanentAssistantOff = subscribePermanentAssistant((delivery) => {
      if (delivery.item.source !== "web") return;
      const requestId = delivery.item.sourceMetadata.clientRequestId;
      const sessionId = delivery.item.sourceMetadata.sessionId;
      if (
        typeof requestId !== "string" ||
        typeof sessionId !== "string" ||
        sessionId !== this.viewing?.id
      )
        return;
      this.send({
        type: "permanentAssistantQueue",
        sessionId,
        clientRequestId: requestId,
        state: delivery.state,
        ...(delivery.error ? { error: delivery.error } : {}),
      });
    });
    // The deep link is this connection's FIRST view intent, and it acquires
    // asynchronously like any other: a client that paints its sidebar from the
    // shell cache can send `loadSession` before `ready`, and that newer intent
    // must win over a slow deep-link reopen (or the route would stick on the
    // row the reader left). Same ticket discipline as `onLoadSession`.
    const ticket = this.claimViewRequest(this.initialRoute?.sessionId);
    const initial = await this.initialView();
    if (initial.view && this.viewRequestIsCurrent(ticket)) {
      this.view(initial.view, this.initialRoute?.timelineCache);
      this.armReadDwell(initial.view);
    }
    // Everything `ready` awaits is gathered BEFORE the viewed session is read:
    // a load can attach another session during any await here, and `state`
    // and `contextInfo` must describe the same session as the snapshot the
    // client already holds — captured together, synchronously, at send time.
    const archivedSessionCount = await hub.archivedSessionCount();
    const viewing = this.viewing;
    this.send({
      type: "ready",
      ...(this.webBuildId ? { webBuildId: this.webBuildId } : {}),
      state: viewing?.state() ?? null,
      models: pickerModels(),
      agents: availableAgents(),
      sessions: initial.sessions,
      archivedSessionCount,
      archivedSessionsLoaded: false,
      settings: readySettings(this.settings()),
      serverBuild: serverBuildInfo(),
      speechToText: describeSttAvailability(this.settings().speechToText),
      slashCommands,
      contextInfo: viewing?.contextInfo() ?? null,
    });
    if (initial.unavailable) this.send(initial.unavailable);
    hub.sendReloadStateTo(this);
    await this.deliverInitialPendingAgentRelays();
    await this.maybeStartPostReloadContinuation();
  }

  private async initialView(): Promise<{
    view?: HarnessDriver;
    sessions: Awaited<ReturnType<typeof hub.listSessions>>;
    /** The error for a deep-linked session that exists but cannot be shown. */
    unavailable?: Extract<ServerMessage, { type: "error" }>;
  }> {
    const sessions = await hub.listSessions();
    const route = this.initialRoute;
    if (route?.sessionId) {
      // Deep link `/sessions/<id>`: resolve by OUR id against the metadata
      // store. Honor each Claude harness's settings gate, then SHOW it —
      // reading a session opens no harness (`viewSession.ts`), so a reload onto
      // a long conversation paints as fast as a short one. A brand-new
      // optimistic id with no record resolves to nothing and falls through.
      const ref = this.resolveSessionRef(route.sessionId);
      // Gate the deep-linked session by harness (claude-sdk → setting; pi →
      // persona availability). `guardSessionRef` also emits an error message, but
      // on the initial load we stay silent and simply fall through, so inline the
      // predicate instead.
      const gated =
        ref !== undefined &&
        existingSessionRefusal(ref.harness, ref.kind) !== undefined;
      if (!gated) {
        const view = hub.viewById(route.sessionId);
        // Deep-linked too: the read mark waits for the dwell (armed in `init`
        // once the view is attached), so the listed row is still unread here.
        if (view) return { view, sessions };
        // Nothing to show. The connection still becomes ready; a record that
        // exists but cannot be read is reported after `ready`, below.
        const unreadable = this.unopenableSession(route.sessionId, ref);
        if (unreadable) return { sessions, unavailable: unreadable };
      }
    }

    // New-session routes are client-staged: do not create an empty server
    // session, attach a runtime, or send an empty chat snapshot until the first
    // prompt arrives via harnessSend.
    return { sessions };
  }

  private async deliverInitialPendingAgentRelays(): Promise<void> {
    const viewing = this.viewing;
    if (viewing) await this.deliverPendingAgentRelays(viewing.sessionId);
  }

  /* -------------------------------- commands ------------------------------- */

  /**
   * Answer a `requestId`-carrying mutation exactly once, so an optimistic
   * client knows which of its pending changes this outcome belongs to.
   *
   * Handlers stay untouched: every `error` they send while one is in flight is
   * stamped with its id (see {@link send}), and a command that produced no
   * error settles when its handler resolves. Correlating on the authoritative
   * broadcast instead would consume the wrong pending change the moment an
   * agent or another tab touched the same domain.
   *
   * The scope is carried in async CONTEXT, not in a field on this connection:
   * the socket does not await `handle`, so two correlated commands overlap
   * freely (both of them await the coalesced session broadcast, for one real
   * example). A saved-and-restored field would let the first to finish clear the
   * second's id and leave its errors unstamped or stamped with the wrong
   * request. The scope also records the connection it belongs to, since a
   * mutation can synchronously drive sends to OTHER connections through the hub.
   */
  async handle(msg: ClientMessage): Promise<void> {
    const requestId =
      "requestId" in msg && typeof msg.requestId === "string"
        ? msg.requestId
        : undefined;
    // EVERY command runs in a scope, not just a correlated one. The scope has
    // two jobs and only the first needs an id: stamping a failure so the client
    // can recover that exact change, and recording THAT it failed. Triage reads
    // the second — and most Task commands carry no `requestId` at all, so
    // dispatching those outside a scope meant a refused command (the reload
    // gate, or any handler that reports by sending an `error`) still processed
    // the Task out of the Inbox.
    const scope: MutationScope = {
      connection: this,
      ...(requestId !== undefined ? { requestId } : {}),
      failed: false,
    };
    await mutationScope.run(scope, () => this.dispatch(msg));
    // A command that FAILED processed nothing, so it must not triage: a refused
    // save is not a decision about the Task.
    if (scope.failed) return;
    markProcessedTasksFor(msg);
    if (requestId !== undefined)
      this.send({ type: "mutationSettled", requestId });
  }

  private async dispatch(msg: ClientMessage): Promise<void> {
    if (hub.isReloadQueued() && isRunStartingMessage(msg)) {
      this.send({
        type: "error",
        message:
          "The server is restarting. Wait for the reconnect before starting another run.",
      });
      return;
    }
    switch (msg.type) {
      case "prompt": {
        // Every viewed session is runtime-backed: drive the run through the
        // runtime (run gate + log + ingest). The adapter (pi and claude-sdk) saves +
        // forwards attachments and the runtime records attachment blocks on the
        // durable user entry. Task/project links are recorded so back-links work.
        const driver = await this.ensureViewingDriver();
        if (!driver) return;
        // A session whose worktree is gone would run in the app CWD — the wrong
        // repository. Refuse before anything is linked, attached or appended.
        if (!this.guardMissingWorktree(driver.sessionId)) return;
        if (isPermanentAssistantSession(driver.sessionId)) {
          if (msg.attachments?.length) {
            this.send({
              type: "notice",
              severity: "warning",
              message:
                "Attachments are not supported in the permanent Assistant queue yet.",
            });
          }
          enqueuePermanentAssistant({
            dedupeKey: `web:${msg.clientRequestId ?? crypto.randomUUID()}`,
            source: "web",
            sourceMetadata: {
              sessionId: driver.sessionId,
              clientRequestId: msg.clientRequestId,
            },
            text: msg.text,
          });
          return;
        }
        const attachments = msg.attachments ? [...msg.attachments] : [];
        // A send into a RUNNING session attaches only what the user staged —
        // no worktree fallback: the session already has its checkout, and
        // adopting its Project mid-conversation is not what the composer asked.
        const stagedContext = resolveSessionContext(sessionContextRequest(msg));
        const staged = await applySessionContext(stagedContext, {
          harness: driver.harness,
          agentType: driver.agentType,
          sessionId: driver.sessionId,
          ...(driver.sessionFile !== undefined
            ? { sessionFile: driver.sessionFile }
            : {}),
        });
        attachments.push(...staged.attachments);
        if (stagedContext.kind === "task" && staged.taskId) {
          this.viewing?.broadcastState();
          void hub.broadcastSessions();
        }
        if (stagedContext.kind === "knowledge") void hub.broadcastSessions();
        if (stagedContext.kind === "project")
          this.send({
            type: "contextInfo",
            sessionId: driver.sessionId,
            info: driver.contextInfo(),
          });
        // Queued peer prompts drain via the runtime running→idle hook (see
        // index.ts setSessionIdleHook), so no browser-dependent drain is needed here.
        // A message of the user's own lifts a Stop's hold on their queue.
        resumePromptQueueForHumanPrompt(driver.sessionId);
        void promptRuntimeSession(driver, msg.text, {
          ...(msg.clientRequestId !== undefined
            ? { clientRequestId: msg.clientRequestId }
            : {}),
          attachments,
          ...(driver.isRunning && driver.canSteer ? { steer: true } : {}),
        }).catch((err: unknown) => {
          // A steer the turn ended before reading is the user's own words: it
          // goes back to them, held in their queue, rather than being lost.
          // Held either way; one the CLI never confirmed dropping says it may
          // have been read, so sending it again is the user's call.
          const withdrawn =
            err instanceof SteerWithdrawnError ? err : undefined;
          if (withdrawn)
            queuePrompt(
              driver.sessionId,
              {
                text: msg.text,
                ...(attachments.length ? { attachments } : {}),
              },
              {
                paused: true,
                ...(withdrawn.uncertain
                  ? { note: STEER_MAY_HAVE_BEEN_READ }
                  : {}),
              },
            );
          this.send({
            type: "error",
            message: withdrawn
              ? withdrawn.uncertain
                ? `The response stopped, and Claude may already have read your message. It is held in your queue: ${STEER_MAY_HAVE_BEEN_READ.toLowerCase()}`
                : "The response ended before it read your message. It is waiting in your queue."
              : `Failed to send prompt: ${errorText(err)}`,
            target: { type: "session", id: driver.id },
            ...(msg.clientRequestId !== undefined
              ? { failedPromptClientRequestId: msg.clientRequestId }
              : {}),
          });
        });
        return;
      }
      case "runSlashCommand":
        return this.onRunSlashCommand(msg.name, msg.rawArgs);
      case "acceptCommitDryRun":
        return this.onAcceptCommitDryRun(msg.entryId);
      case "respondToQuestion":
        return this.onRespondToQuestion(msg.response);
      case "abort":
        // Aborting needs the harness this view may not have opened yet; a
        // detached session has nothing running, so the upgrade is what makes
        // the abort meaningful at all. A Stop holds the user's queue BEFORE the
        // turn ends, so the idle edge it produces sends nothing from it.
        return this.withViewedSession((driver, view) => {
          if (driver.isRunning) pausePromptQueueForStop(driver.sessionId);
          return view?.abort();
        });
      case "queuePrompt":
      case "updateQueuedPrompt":
      case "removeQueuedPrompt":
      case "moveQueuedPrompt":
      case "clearPromptQueue":
      case "sendQueuedPromptNow":
      case "resumePromptQueue":
        return this.onPromptQueueCommand(msg);
      case "loadTimelineBlock":
        return this.onLoadTimelineBlock(msg.entryId, msg.blockIndex, msg.kind);
      case "setLiveBodySubscriptions":
        // Scoped to the VIEWED session: a set that names another one is a
        // stale send from before a switch, and the new view starts with none.
        if (this.viewing?.id === msg.sessionId)
          this.runtimeView?.setLiveBodySubscriptions(msg.bodies);
        return;
      case "loadTimelineRange":
        return this.onLoadTimelineRange(
          msg.sessionId,
          msg.beforeSeq,
          msg.limit,
        );
      case "setModel":
        return this.onSetModel(msg.provider, msg.id);
      case "setThinkingLevel":
        return this.withViewedSession((_driver, view) => {
          if (view) this.applySessionConfig(() => view.setReasoning(msg.level));
        });
      case "setSessionMode":
        return this.onSetSessionMode(msg.mode);
      case "refreshModels":
        return this.onRefreshModels(msg.requestId);
      case "newSession":
        return this.onNewSession(
          msg.agentType,
          msg.model,
          msg.thinkingLevel,
          msg.mode,
          msg.worktreeId,
        );
      case "loadSession":
        return this.onLoadSession(msg.id, msg.timelineCache);
      case "openPermanentAssistant":
        return this.onOpenPermanentAssistant();
      case "loadArchivedSessions":
        return this.onLoadArchivedSessions();
      case "resolveObjectLinks":
        return this.onResolveObjectLinks(msg.requestId, msg.uris);
      case "deleteSession":
        return this.onDeleteSession(msg.id);
      case "archiveSession":
        return this.onArchiveSession(msg.id, msg.archived ?? true);
      case "settleSession":
        return this.onSettleSession(
          msg.id,
          msg.settled ?? true,
          msg.throughRevision,
        );
      case "settleWorkflowRun":
        return this.onSettleWorkflowRun(msg.runId, msg.throughRevision);
      case "renameSession":
        return this.onRenameSession(msg.id, msg.title);
      case "setSpawnOwnership":
        return this.onSetSpawnOwnership(msg.id, msg.ownership);
      case "acknowledgeMissingWorktree":
        return this.onAcknowledgeMissingWorktree(msg.id);
      case "calendarDayActivate":
        return this.onCalendarDayActivate(msg.date, {
          scan: msg.scan === true,
          logTime: msg.logTime === true,
          ...(msg.text !== undefined ? { text: msg.text } : {}),
          ...(msg.modelProvider && msg.modelId
            ? { model: { provider: msg.modelProvider, id: msg.modelId } }
            : {}),
          ...(msg.thinkingLevel !== undefined
            ? { thinkingLevel: msg.thinkingLevel }
            : {}),
        });
      case "forkSession":
        return this.onForkSession(msg.id, msg.entryId, msg.position);
      case "createDraftSession":
        return this.onCreateDraftSession(
          msg.agentType,
          msg.draftText,
          msg.notice,
        );
      case "listSessions":
        this.send({
          type: "sessions",
          sessions: await hub.listSessions(),
          archivedSessionCount: await hub.archivedSessionCount(),
          archivedSessionsLoaded: false,
        });
        return;
      case "requestPeerPromptHistory": {
        const sessionId = this.viewing?.sessionId;
        if (!sessionId) return;
        this.send({
          type: "peerPromptHistoryExpanded",
          sessionId,
          projection: peerPromptThreadsFor(
            sessionId,
            msg.limit ?? HISTORY_EXPANSION_MAX_MESSAGES,
          ),
        });
        return;
      }
      case "resolveTimelineAnchor":
        return this.onResolveTimelineAnchor(msg.requestId, msg.target);
      case "requestSettings":
        this.send({ type: "settings", settings: this.settings() });
        return;
      case "updateSettings":
        return this.onUpdateSettings(msg.patch);
      case "updateJiraSettings":
        return this.onUpdateJiraSettings(msg.patch);
      case "saveAndTestJiraSettings":
        return this.onSaveAndTestJiraSettings(msg.patch);
      case "testJiraSettings":
        return this.onTestJiraSettings();
      case "updateConfluenceSettings":
        return this.onUpdateConfluenceSettings(msg.patch);
      case "saveAndTestConfluenceSettings":
        return this.onSaveAndTestConfluenceSettings(msg.patch);
      case "testConfluenceSettings":
        return this.onTestConfluenceSettings();
      case "updateTempoSettings":
        return this.onUpdateTempoSettings(msg.patch);
      case "saveAndTestTempoSettings":
        return this.onSaveAndTestTempoSettings(msg.patch);
      case "testTempoSettings":
        return this.onTestTempoSettings();
      case "updateGoogleSettings":
        return this.onUpdateGoogleSettings(msg.patch);
      case "saveAndTestGoogleSettings":
        return this.onSaveAndTestGoogleSettings(msg.patch);
      case "testGoogleSettings":
        return this.onTestGoogleSettings();
      case "updateSlackSettings":
        return this.onUpdateSlackSettings(msg.patch);
      case "saveAndTestSlackSettings":
        return this.onSaveAndTestSlackSettings(msg.patch);
      case "testSlackSettings":
        return this.onTestSlackSettings();
      case "saveAndTestSlackHuddleSettings":
        return this.onSaveAndTestSlackHuddleSettings(msg.patch);
      case "testSlackHuddleSettings":
        return this.onTestSlackHuddleSettings();
      case "updateOpenAiCompatibleSettings":
        return this.onUpdateOpenAiCompatibleSettings(msg.patch);
      case "saveAndTestOpenAiCompatibleSettings":
        return this.onSaveAndTestOpenAiCompatibleSettings(msg.patch);
      case "testOpenAiCompatibleSettings":
        return this.onTestOpenAiCompatibleSettings();
      case "updateBraveSettings":
        return this.onUpdateBraveSettings(msg.patch);
      case "saveAndTestBraveSettings":
        return this.onSaveAndTestBraveSettings(msg.patch);
      case "testBraveSettings":
        return this.onTestBraveSettings();
      case "updateContext7Settings":
        return this.onUpdateContext7Settings(msg.patch);
      case "saveAndTestContext7Settings":
        return this.onSaveAndTestContext7Settings(msg.patch);
      case "testContext7Settings":
        return this.onTestContext7Settings();
      case "updateGithubSettings":
        return this.onUpdateGithubSettings(msg.patch);
      case "saveAndTestGithubSettings":
        return this.onSaveAndTestGithubSettings(msg.patch);
      case "testGithubSettings":
        return this.onTestGithubSettings();
      case "updateForgejoSettings":
        return this.onUpdateForgejoSettings(msg.patch);
      case "saveAndTestForgejoSettings":
        return this.onSaveAndTestForgejoSettings(msg.patch);
      case "testForgejoSettings":
        return this.onTestForgejoSettings();
      case "memoryList":
        return this.onMemoryList(msg.requestId, msg.filter);
      case "memoryGet":
        return this.onMemoryGet(msg.requestId, msg.id);
      case "memoryMutate":
        return this.onMemoryMutate(msg.requestId, msg.operation);
      case "memoryLoads":
        return this.onMemoryLoads(msg.requestId, msg.sessionId, msg.limit);
      case "memoryStatus":
        return this.onMemoryStatus(msg.requestId);
      case "subscribe":
        return this.onSubscribe(msg.topics, msg.digests);
      case "stopBackgroundWork":
        return this.onStopBackgroundWork(msg.itemId, msg.requestId);
      case "stopAllBackgroundWork":
        return this.onStopAllBackgroundWork(msg.ownerSessionId, msg.requestId);
      case "subscribeSubagentThread":
        return this.onSubscribeSubagentThread(
          msg.threadId,
          msg.limit,
          msg.beforeSequence,
          msg.digest,
        );
      case "unsubscribeSubagentThread":
        this.heldSubagentThreads.delete(msg.threadId);
        hub.releaseSubagentRunTopic(msg.threadId);
        return;
      case "getSubagentRunItems":
        return this.onGetSubagentRunItems(msg.threadId, msg.ids, msg.requestId);
      case "unsubscribe": {
        for (const topic of msg.topics) this.topics.delete(topic);
        return;
      }
      case "refreshUsage":
        return revalidateUsage();
      case "listTasks":
        return this.onListTasks(msg.request);
      case "getStateItems":
        return this.onGetStateItems(msg.topic, msg.ids, msg.requestId);
      case "saveTask":
        return this.onSaveTask(msg.request, msg.requestId);
      case "assignTaskProjects":
        return this.onAssignTaskProjects(msg.updates);
      case "listProjects":
        return this.onListProjects(msg.request ?? {});
      case "getProject":
        return this.onGetProject(msg.id, msg.requestId);
      case "saveProject":
        return this.onSaveProject(msg.id, msg.patch, msg.requestId);
      case "provisionProjectRepo":
        return this.onProvisionProjectRepo(msg.id);
      case "removeProjectRepo":
        return this.onRemoveProjectRepo(msg.id);
      case "archiveProject":
        return this.onArchiveProject(msg.id);
      case "deleteProject":
        return this.onDeleteProject(msg.id);
      case "reorderProjects":
        return this.onReorderProjects(msg.orderedIds, msg.placements);
      case "archiveTask":
        return this.onArchiveTask(msg.id, msg.archived ?? true);
      case "deleteTask":
        return this.onDeleteTask(msg.id);
      case "getTask":
        return this.onGetTask(msg.id, msg.requestId);
      case "listComments":
        return this.onListComments(msg.target, msg.requestId);
      case "unwatchComments": {
        const key = commentTargetKey(msg.target);
        this.commentListGenerations.delete(key);
        this.openComments.delete(key);
        return;
      }
      case "addComment":
        return this.onAddComment(msg.target, msg.body, msg.selectors);
      case "replyComment":
        return this.onReplyComment(msg.threadId, msg.body, msg.parentId);
      case "resolveComment":
        return this.onResolveComment(msg.threadId, msg.resolved);
      case "editComment":
        return this.onEditComment(msg.commentId, msg.body);
      case "deleteComment":
        return this.onDeleteComment(msg.threadId, msg.commentId);
      case "attachComments":
        return this.onAttachComments(msg.threadIds, msg.sessionId, msg.session);
      case "reorderTasks":
        return this.onReorderTasks(msg.orderedIds, msg.placements);
      case "cancelPostReloadContinuation":
        // The pending-continuation card disappearing IS the receipt.
        cancelPostReloadContinuation();
        return;
      case "harnessSend":
        return this.handleFirstSend(msg);
      case "resolveApproval":
        return this.onResolveApproval(
          msg.approvalId,
          msg.decision,
          msg.edits,
          msg.forSession === true,
        );
      case "revokeApprovalGrant":
        revokeApprovalGrant(msg.sessionId, msg.key);
        return;
      case "resolvePullRequestCardTask":
        return this.onResolvePullRequestCardTask(msg.cardId, msg.taskId);
      case "pullRequestCardAction":
        return this.onPullRequestCardAction(msg.cardId, msg.action, {
          ...(msg.mergeMethod ? { mergeMethod: msg.mergeMethod } : {}),
          ...(msg.deleteBranch === false ? { deleteBranch: false } : {}),
        });
      case "listWorktrees":
        return this.onListWorktrees(msg.projectId);
      case "proposeWorktreeName":
        return this.onProposeWorktreeName(
          msg.projectId,
          msg.requestId,
          msg.taskId,
          msg.context,
        );
      case "createWorktree":
        return this.onCreateWorktree(
          msg.projectId,
          msg.name,
          msg.taskId,
          msg.sessionId,
        );
      case "startWorkflowRun":
        return this.onStartWorkflowRun(
          msg.taskId,
          msg.config,
          msg.baseBranch,
          msg.limits,
          msg.requestId,
        );
      case "answerWorkflowCeiling":
        return this.onWorkflowRunControl(msg.runId, () =>
          answerCeilingDecision(
            Number(msg.runId),
            msg.choice === "raise"
              ? { choice: "raise", adjustment: msg.raise! }
              : msg.choice === "deliver"
                ? { choice: "deliver" }
                : msg.choice === "re-evaluate"
                  ? { choice: "re-evaluate" }
                  : { choice: "cancel" },
            { kind: "user" },
          ),
        );
      case "pauseWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          pauseRun(Number(msg.runId), msg.reason?.trim() || "paused by user", {
            kind: "user",
          }),
        );
      case "resumeWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          resumeRun(Number(msg.runId), { kind: "user" }),
        );
      case "cancelWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          cancelRun(Number(msg.runId), { kind: "user" }),
        );
      case "deleteWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          deleteCancelledWorkflowRun(Number(msg.runId), {
            deleteWorktree: msg.deleteWorktree,
            archiveSessions: msg.archiveSessions,
          }),
        );
      case "retryWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          retryRun(Number(msg.runId), { kind: "user" }),
        );
      case "rebaseAndReviewWorkflowRun":
        return this.onWorkflowRunControl(msg.runId, () =>
          rebaseAndReviewRun(Number(msg.runId), { kind: "user" }),
        );
      // The two delivery controls the Task's Workflow card carries. Their
      // outcomes — including their failures — are written to the pull-request
      // card the run names and reach the Task on the run list, so this path
      // says nothing the card already says ({@link onWorkflowDeliveryAction}).
      case "mergeWorkflowRun":
        return this.onWorkflowDeliveryAction(msg.runId, () =>
          mergeWorkflowRunPullRequest(
            Number(msg.runId),
            {
              mergeMethod: msg.mergeMethod,
              ...(msg.deleteBranch === false ? { deleteBranch: false } : {}),
            },
            { kind: "user" },
          ),
        );
      case "cleanUpWorkflowRun":
        return this.onWorkflowDeliveryAction(msg.runId, () =>
          cleanUpWorkflowRunCheckout(Number(msg.runId), { kind: "user" }),
        );
      case "removeWorktree":
        return this.onRemoveWorktree(
          msg.worktreeId,
          msg.deleteBranch,
          msg.force,
        );
      case "watchWorktree": {
        // Canonicalize so aliased ids (`main:PROJ` vs `main:proj`) dedupe onto
        // one refcount for this connection.
        const watchId = canonicalWorktreeId(msg.worktreeId);
        if (!this.watchedWorktrees.has(watchId)) {
          this.watchedWorktrees.add(watchId);
          void (async () => {
            await addWorktreeViewer(watchId);
            if (!this.watchedWorktrees.has(watchId)) return;
            const row = await resolveWorktreeRow(watchId);
            if (!row || row.status !== "active") return;
            const status = await computeWorktreeStatus(row);
            if (this.watchedWorktrees.has(watchId))
              this.send({ type: "worktreeStatus", status });
          })().catch(() => undefined);
        }
        return;
      }
      case "unwatchWorktree": {
        const watchId = canonicalWorktreeId(msg.worktreeId);
        if (this.watchedWorktrees.delete(watchId))
          removeWorktreeViewer(watchId);
        return;
      }
      case "mergeWorktree":
        return this.onMergeWorktree(msg.worktreeId, msg.strategy);
    }
  }

  /** Reject a client message whose session/attachment id failed {@link isSafeId},
   *  before any filesystem, tmux, or task-link side effect. */
  private rejectBadId(): void {
    this.send({
      type: "notice",
      severity: "warning",
      message: "Rejected request: invalid session id.",
    });
  }

  /**
   * Answer a windowed transcript's "load earlier" with the entries preceding the
   * reader's current first one. Scoped to the VIEWED session: an answer for any
   * other id would splice foreign rows into the open transcript.
   */
  private onLoadTimelineRange(
    sessionId: string,
    beforeSeq: number,
    limit?: number,
  ): void {
    if (!this.viewing || this.viewing.id !== sessionId) return;
    if (
      !Number.isInteger(beforeSeq) ||
      beforeSeq < 0 ||
      (limit !== undefined &&
        (!Number.isInteger(limit) ||
          limit < 1 ||
          limit > TIMELINE_RANGE_MAX_LIMIT))
    ) {
      this.rejectBadId();
      return;
    }
    try {
      const range = sessionRuntime.loadTimelineRange(
        sessionId,
        beforeSeq,
        limit,
      );
      // An anchor that is not in this timeline is a stale request (the entry was
      // forked away, or the client is a step behind). Answer with NO entries
      // rather than a slice that would not join up: the client drops it, and the
      // echoed anchor is what releases its pending request.
      this.send({
        type: "timelineRange",
        sessionId,
        beforeSeq,
        entries: range?.entries ?? [],
        timelineStart: range?.timelineStart ?? 0,
        totalEntryCount: range?.totalEntryCount ?? 0,
        ...(range?.turnStatsSeed ? { turnStatsSeed: range.turnStatsSeed } : {}),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to load earlier messages: ${errorText(err)}`,
        target: { type: "session", id: sessionId },
      });
    }
  }

  /**
   * Answer where a jump target lives (see {@link TimelineAnchorTarget}). Both
   * kinds address a session the client is NOT viewing yet — that is the point of
   * the jump — so the lookup goes through the runtime's log-store read rather
   * than the viewed session. An unknown target is answered with no anchor, never
   * with an error the UI would have to translate.
   */
  private onResolveTimelineAnchor(
    requestId: string,
    target: TimelineAnchorTarget,
  ): void {
    const answer = (anchor?: TimelineAnchor): void => {
      this.send({
        type: "timelineAnchor",
        requestId,
        ...(anchor ? { anchor } : {}),
      });
    };
    if (target.kind === "peerPrompt") {
      const sessionId = this.viewing?.sessionId;
      if (!sessionId || !isSafeId(target.messageKey)) {
        answer();
        return;
      }
      answer(peerPromptAnchorFor(sessionId, target.messageKey));
      return;
    }
    if (target.kind === "approval") {
      if (!isSafeId(target.approvalId)) {
        this.rejectBadId();
        return;
      }
      answer(approvalAnchorFor(target.approvalId));
      return;
    }
    if (!isSafeId(target.sessionId) || !isSafeId(target.entryId)) {
      this.rejectBadId();
      return;
    }
    const located = sessionRuntime.locateAnchor(
      target.sessionId,
      (entry) => entry.id === target.entryId,
    );
    answer(
      located
        ? {
            sessionId: target.sessionId,
            entryId: located.entryId,
            index: located.index,
          }
        : undefined,
    );
  }

  private onLoadTimelineBlock(
    entryId: string,
    blockIndex: number,
    kind: import("@assistant/shared/session").LazyBlockKind,
  ): void {
    if (!this.viewing) return;
    if (!isSafeId(entryId) || !Number.isInteger(blockIndex) || blockIndex < 0) {
      this.rejectBadId();
      return;
    }
    // Captured once: nothing here awaits today, so `this.viewing` cannot move
    // under it, but the target must name the session the READ was for whatever
    // this method grows into.
    const viewedSessionId = this.viewing.sessionId;
    try {
      const content = sessionRuntime.loadTimelineBlock(
        viewedSessionId,
        entryId,
        blockIndex,
        kind,
      );
      if (content === undefined) {
        this.send({
          type: "timelineBlockFailed",
          sessionId: viewedSessionId,
          entryId,
          blockIndex,
          kind,
          reason: "unavailable",
          message: "That timeline block is no longer available.",
        });
        this.send({
          type: "notice",
          severity: "warning",
          message: "That timeline block is no longer available.",
        });
        return;
      }
      this.send({
        type: "timelineBlockLoaded",
        sessionId: viewedSessionId,
        entryId,
        blockIndex,
        kind,
        content,
      });
    } catch (err) {
      this.send({
        type: "timelineBlockFailed",
        sessionId: viewedSessionId,
        entryId,
        blockIndex,
        kind,
        reason: "error",
        message: errorText(err),
      });
      this.send({
        type: "error",
        message: `Failed to load timeline block: ${errorText(err)}`,
        target: { type: "session", id: viewedSessionId },
      });
    }
  }

  private async onResolveObjectLinks(
    requestId: string,
    uris: string[],
  ): Promise<void> {
    try {
      this.send({
        type: "objectLinksResolved",
        requestId,
        links: await resolvePaObjectLinks(uris),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to resolve object links: ${errorText(err)}`,
      });
    }
  }

  /**
   * A session's first send: it creates the session and prompts it, for either
   * engine. The flow is one, the persona guard included; the session's engine
   * answers only what differs (`harnesses/firstSend.ts`): whether it is
   * switched off, whether the send's id is the session's and may be taken,
   * which persona gate applies, the account, what it resolves before a
   * worktree is provisioned, and how it brings the session live. The
   * session comes into existence with its first prompt, so model, thinking and
   * mode are fixed exactly when the conversation starts.
   */
  private async handleFirstSend(msg: FirstSendRequest): Promise<void> {
    const engine = firstSendEngine(msg.harness);
    if (engine.disabled()) return;
    // Reject a bad id before ANY side effect, even where the engine mints the
    // session's own: the message shape stays constrained.
    if (!isSafeId(msg.id)) {
      this.rejectBadId();
      return;
    }
    const heldId = engine.admitId(msg);
    if (heldId) {
      this.refuseFirstSend(msg, heldId);
      return;
    }
    if (!this.guardFirstSendPersona(msg.agentType, engine.personaGate)) return;
    const admitted = engine.account(msg);
    if ("refusal" in admitted) {
      this.refuseFirstSend(msg, admitted.refusal);
      return;
    }
    // The client is already on this session's surface: the send commits this
    // connection to viewing it, in arrival order — claimed before the FIRST
    // await (the model lookup included), never after one.
    const ticket = this.claimViewRequest(
      engine.takesClientId ? msg.id : undefined,
    );
    const prepared = await engine.prepare(msg, admitted.profileId);
    if ("refusal" in prepared) {
      this.refuseFirstSend(msg, prepared.refusal);
      return;
    }
    const staged = await this.resolveWorktreeContext(msg.worktreeId);
    if (staged === undefined) return;
    // "+ New worktree": provision BEFORE creating the session, so the session is
    // born with the right cwd. A failure ends the send here — no session, no turn.
    const provisioned = staged
      ? null
      : await this.provisionFirstSendWorktree(msg);
    if (provisioned === undefined) return;
    const worktree = staged ?? provisioned?.worktree ?? null;
    if (!this.guardDeveloperWorktree(msg.agentType, worktree)) return;
    // Resolved BEFORE creation and applied after: the frozen evidence and the
    // attachments it promises then come from one resolution (`sessionContext.ts`).
    const firstSendContext = resolveSessionContext(
      sessionContextRequest(msg, worktree),
    );
    const created = await prepared.create({
      worktree,
      evidence: sessionContextEvidence(firstSendContext, {
        hasAttachments: Boolean(msg.attachments?.length),
      }),
    });
    if ("refusal" in created) {
      this.refuseFirstSend(msg, created.refusal);
      return;
    }
    const { live, ref } = created;
    // The prompt below runs whether or not this connection still views the
    // session: a newer navigation keeps its view, the send is not lost.
    this.viewIfCurrent(ticket, live);
    // The genesis card goes in before the first prompt: the checkout really did
    // precede the session, and live + durable then render the same order.
    if (provisioned)
      recordWorktreeProvisionForHost(live, provisioned.provision);
    // The staged Task/Project/knowledge context: its links, and what the agent
    // sees of it.
    const attachments = msg.attachments ? [...msg.attachments] : [];
    const started = await applySessionContext(firstSendContext, ref);
    attachments.push(...started.attachments);
    if (firstSendContext.kind === "task" && started.taskId) {
      this.viewing?.broadcastState();
      void hub.broadcastSessions();
    }
    if (firstSendContext.kind === "project") {
      live.broadcastState();
      this.send({
        type: "contextInfo",
        sessionId: live.sessionId,
        info: live.contextInfo(),
      });
    }
    // Driven through the runtime so the user entry is appended to the log. The
    // human's own text is what the log keeps: user files AND started context
    // both ride to the model as attachments, never spliced into the prompt.
    await promptRuntimeSession(live, msg.text, {
      ...(msg.clientRequestId !== undefined
        ? { clientRequestId: msg.clientRequestId }
        : {}),
      attachments,
    }).catch((err) =>
      this.send({
        type: "error",
        message: `Failed to send prompt: ${errorText(err)}`,
        target: { type: "session", id: live.id },
        ...(msg.clientRequestId !== undefined
          ? { failedPromptClientRequestId: msg.clientRequestId }
          : {}),
      }),
    );
    // Now that the session has a turn, refresh the sidebar so it appears.
    await hub.broadcastSessions();
  }

  /**
   * The persona creation guard of a first send, by the gate its engine names
   * (`harnesses/firstSend.ts`): pi's environment availability, or, for a
   * Claude session, only the server-owned personas refused, which a crafted
   * send must not be able to create.
   */
  private guardFirstSendPersona(
    agentType: AgentType,
    gate: PersonaGate,
  ): boolean {
    if (gate === "available") return this.guardKind(agentType);
    if (isOrdinarilyCreatableAgentType(agentType)) return true;
    this.send({
      type: "error",
      message: `The "${String(agentType)}" agent cannot be created.`,
    });
    return false;
  }

  /**
   * Tell the client why its first send was refused: on the session it named
   * when the refusal is about that id, retiring the optimistic prompt.
   */
  private refuseFirstSend(
    msg: FirstSendRequest,
    refusal: FirstSendRefusal,
  ): void {
    this.send({
      type: "error",
      message: refusal.message,
      ...(refusal.onSession
        ? {
            target: { type: "session" as const, id: msg.id },
            ...(msg.clientRequestId !== undefined
              ? { failedPromptClientRequestId: msg.clientRequestId }
              : {}),
          }
        : {}),
    });
  }

  private async maybeStartPostReloadContinuation(): Promise<void> {
    const continuation = hub.consumePostReloadContinuation();
    if (!continuation) return;
    if (!this.guardExistingKind(continuation.kind)) return;
    // The continuation views its session, but a navigation the client made
    // while it reopened is newer and keeps the view; the prompt runs either way.
    const ticket = this.claimViewRequest();
    try {
      const live = await harnessRegistry.reopenTranscript(
        continuation.kind,
        continuation.sessionFile,
      );
      this.viewIfCurrent(ticket, live);
      // Drive through the runtime view so run-state + the durable log are updated.
      // This is an agent/self continuation, not a human prompt; provenance is
      // rendered distinctly in the transcript.
      void promptRuntimeSession(live, continuation.message, {
        origin: { kind: "agent", agentId: "post-reload-continuation" },
      }).catch((err) =>
        this.send({
          type: "error",
          message: `Failed to run continuation: ${errorText(err)}`,
        }),
      );
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to start post-reload continuation: ${errorText(err)}`,
      });
    }
  }

  /**
   * Subscribing is also the authoritative read: a warm migrated topic receives
   * its digest while cold and non-migrated topics receive a snapshot, so first
   * visit and reconnect converge through one path and `ready` no longer carries
   * every domain list to every browser. Worktrees are read as the complete app
   * list here: the web
   * client only uses that shape, and a snapshot is required after reconnecting
   * or re-subscribing because broadcasts intentionally go only to active
   * subscribers. Purely event-shaped Knowledge invalidations and calendar scan
   * progress have no snapshot here; their mounted surfaces issue HTTP reads.
   */
  private onSubscribe(
    topics: BroadcastTopic[],
    digests: BroadcastTopic[] = [],
  ): void {
    const digestTopics = new Set(digests);
    for (const topic of topics) {
      const fresh = !this.topics.has(topic);
      this.topics.add(topic);
      if (!fresh) continue;
      if (topic === "tasks") {
        if (digestTopics.has(topic)) {
          this.send({
            type: "stateDigest",
            topic,
            seq: hub.taskEventSeq(),
            entries: taskRevisionDigest(),
          });
        } else {
          this.onListTasks({});
        }
      }
      // One reducer slot gets one canonical shape. Archived rows are needed for
      // durable name/color lookups even when pickers display active projects.
      if (topic === "projects") {
        if (digestTopics.has(topic)) {
          this.send({
            type: "stateDigest",
            topic,
            seq: hub.projectEventSeq(),
            entries: projectRevisionDigest(),
          });
        } else {
          this.onListProjects({ includeArchived: true });
        }
      }
      if (topic === "subagents") {
        // The registry is deliberately snapshot-only until a consumer needs
        // digest catch-up. Held run detail has its own digest-capable topic.
        const entries = subagentThreadRevisionDigest();
        const index = new Map(
          entries.map((entry) => [
            entry.id,
            { revision: entry.revision, live: true },
          ]),
        );
        this.send({
          type: "subagentThreadList",
          threads: subagentThreadStateItems(
            entries.map((entry) => entry.id),
            index,
          )
            .filter((event) => event.kind === "upsert")
            .map((event) => event.item),
          seq: hub.subagentEventSeq(),
          revisions: entries,
        });
      }
      if (topic === "background") {
        // Snapshot-only for now, exactly like the subagent registry: the
        // sidecar revisions still seed the client's digest, so adopting one
        // later needs no wire change. The snapshot is a BOUNDED window over a
        // registry that keeps its terminal history, so the answer's size is a
        // constant rather than a function of this install's age.
        const snapshot = backgroundWorkSnapshot();
        this.send({
          type: "backgroundWorkList",
          items: snapshot.items,
          seq: hub.backgroundEventSeq(),
          revisions: snapshot.revisions,
          ...(snapshot.truncated ? { truncated: true } : {}),
        });
      }
      if (topic === "worktrees") void this.onListWorktrees();
      // The skills library is hand-authored on disk, so a subscribe is a fresh
      // SCAN, never a cached index. It answers through the topic broadcast: the
      // scan is authoritative for everyone already showing the library too, and
      // a second shape addressed at this one connection is exactly how browse
      // and injection start disagreeing.
      if (topic === "skills") void publishSkillLibrary();
      if (topic === "workflow") this.send(workflowRunListMessage());
      if (topic === "usage") {
        // Page open = subscribe: the cached numbers render immediately and a
        // background refresh (if the cache is not fresh) pushes to every
        // subscriber later. Nothing here blocks on a provider.
        this.send({ type: "usageIndicators", indicators: usageIndicators() });
        revalidateUsage();
      }
    }
  }

  private onListTasks(request: TaskListRequest): void {
    try {
      this.send({
        type: "taskList",
        list: this.taskListResponse(request),
        seq: hub.taskEventSeq(),
        // Only the canonical live snapshot can seed digest resubscribe. Filtered
        // and archived reads remain explicit request/response projections.
        revisions:
          Object.keys(request).length === 0 ? taskRevisionDigest() : [],
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to list tasks: ${errorText(err)}`,
        // The COLLECTION, not a member: the Backlog that could not load owns
        // this and renders it in place, the same way the project and worktree
        // lists already do.
        target: { type: "task" },
      });
    }
  }

  private onGetStateItems(
    topic: "tasks" | "projects",
    ids: string[],
    requestId: string,
  ): void {
    try {
      if (ids.length > MAX_STATE_ITEM_IDS)
        throw new Error(`Too many state item ids (max ${MAX_STATE_ITEM_IDS})`);
      if (topic === "tasks") {
        this.send({
          type: "stateItems",
          topic,
          requestId,
          events: taskStateItems(ids),
        });
      } else if (topic === "projects") {
        this.send({
          type: "stateItems",
          topic,
          requestId,
          events: projectStateItems(ids),
        });
      }
    } catch (err) {
      this.send({
        type: "error",
        requestId,
        message: `Failed to fetch ${topic === "tasks" ? "Task" : "Project"} state items: ${errorText(err)}`,
      });
    }
  }

  private canHoldSubagentThread(threadId: string): boolean {
    if (!isSafeId(threadId)) return false;
    const thread = subagentStore.getThread(threadId);
    // Interim authorization until Task-477 provides the shared policy seam:
    // require the connection to view the owning parent session. Task-460's
    // registry UI will replace this local gate with that policy.
    return Boolean(thread && this.viewing?.id === thread.parentSessionId);
  }

  private onSubscribeSubagentThread(
    threadId: string,
    limit?: number,
    beforeSequence?: number,
    digest = false,
  ): void {
    if (!this.canHoldSubagentThread(threadId)) {
      this.send({ type: "error", message: "Unauthorized subagent thread" });
      return;
    }
    this.heldSubagentThreads.add(threadId);
    if (digest) {
      this.send({
        type: "subagentRunDigest",
        threadId,
        seq: hub.subagentRunEventSeq(threadId),
        entries: subagentRunRevisionDigest(threadId),
      });
      return;
    }
    const detail = subagentThreadRunDetail(threadId, {
      ...(limit !== undefined ? { limit } : {}),
      ...(beforeSequence !== undefined ? { beforeSequence } : {}),
    });
    if (!detail) {
      this.heldSubagentThreads.delete(threadId);
      hub.releaseSubagentRunTopic(threadId);
      this.send({ type: "error", message: "Subagent thread not found" });
      return;
    }
    this.send({
      type: "subagentThreadRunSnapshot",
      threadId,
      detail,
      seq: hub.subagentRunEventSeq(threadId),
      revisions: subagentRunRevisionDigest(threadId),
    });
  }

  private onGetSubagentRunItems(
    threadId: string,
    ids: string[],
    requestId: string,
  ): void {
    if (
      !this.canHoldSubagentThread(threadId) ||
      !this.heldSubagentThreads.has(threadId)
    ) {
      this.send({
        type: "error",
        requestId,
        message: "Unauthorized subagent thread",
      });
      return;
    }
    if (ids.length > MAX_STATE_ITEM_IDS || ids.some((id) => !isSafeId(id))) {
      this.rejectBadId();
      return;
    }
    const events = subagentRunStateItems(ids).filter((event) => {
      const run = subagentStore.getRun(event.id, true);
      return run?.threadId === threadId;
    });
    this.send({ type: "subagentRunItems", threadId, requestId, events });
  }

  private onMemoryList(requestId: string, filter: unknown): void {
    try {
      this.send({
        type: "memoryListResult",
        requestId,
        result: listMemory(coerceMemoryListFilter(filter)),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to list memory: ${errorText(err)}`,
      });
    }
  }

  private onMemoryGet(requestId: string, id: string): void {
    try {
      this.send({
        type: "memoryGetResult",
        requestId,
        lineage: getMemoryLineage(id),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to read memory: ${errorText(err)}`,
      });
    }
  }

  private onMemoryMutate(requestId: string, operation: unknown): void {
    const coerced = coerceMemoryMutateOperation(operation);
    if (!coerced) {
      this.send({
        type: "memoryMutateResult",
        requestId,
        result: {
          ok: false,
          error: "invalid",
          message: "malformed memory operation",
        },
      });
      return;
    }
    try {
      // The lifecycle change event broadcasts a targeted `memoryInvalidated` to
      // every client (via memoryEvents), so concurrent tabs/agents converge. The
      // connection identity + requestId thread trusted idempotency so a retried
      // browser mutation is a no-op (see `connectionId` and `mutateMemory`).
      this.send({
        type: "memoryMutateResult",
        requestId,
        result: mutateMemory(coerced, {
          connectionId: this.connectionId,
          requestId,
        }),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to update memory: ${errorText(err)}`,
      });
    }
  }

  private onMemoryLoads(
    requestId: string,
    sessionId: string,
    limit?: number,
  ): void {
    try {
      this.send({
        type: "memoryLoadsResult",
        requestId,
        sessionId,
        batches: recentMemoryLoads(sessionId, limit ?? 20),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to read memory loads: ${errorText(err)}`,
      });
    }
  }

  private async onMemoryStatus(requestId: string): Promise<void> {
    try {
      this.send({
        type: "memoryStatusResult",
        requestId,
        processor: await processorConfigStatus(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to read memory status: ${errorText(err)}`,
      });
    }
  }

  private onListProjects(request: ProjectListRequest): void {
    try {
      const queryValue = cleanOptional(request.query);
      const tagValue = cleanOptional(request.tag);
      const response: ProjectListResponse = {
        request,
        projects: listProjects({
          ...(queryValue !== undefined ? { query: queryValue } : {}),
          ...(tagValue !== undefined ? { tag: tagValue } : {}),
          ...(request.status !== undefined ? { status: request.status } : {}),
          includeArchived: Boolean(request.includeArchived),
        }).map(projectSummaryOf),
        updatedAt: Date.now(),
      };
      const canonical =
        request.includeArchived === true && Object.keys(request).length === 1;
      this.send({
        type: "projectList",
        list: response,
        seq: hub.projectEventSeq(),
        revisions: canonical ? projectRevisionDigest() : [],
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to list projects: ${errorText(err)}`,
        // The COLLECTION, not a member: the pane that could not load owns this
        // and renders it in place, and saying which collection is what lets the
        // client route it there without reading the sentence.
        target: { type: "project" },
      });
    }
  }

  private onGetProject(id: string, requestId: string): void {
    try {
      this.send({
        type: "projectDetail",
        id,
        item: getProject(id),
        revision: projectRevision(id),
        requestId,
      });
    } catch (err) {
      this.send({
        type: "projectDetail",
        id,
        item: null,
        requestId,
        error: `Failed to read Project: ${errorText(err)}`,
      });
    }
  }

  private onSaveProject(
    id: string,
    patch: Partial<ProjectRecord>,
    requestId?: string,
  ): void {
    try {
      const result = updateProject(id, patch);
      // localPaths / worktreeRoot edits change main-checkout resolution — drop
      // the cached probe so the next Worktrees list reflects it immediately.
      invalidateMainRepo(result.project.id);
      this.send({
        type: "projectSaved",
        item: result.project,
        revision: projectRevision(result.project.id),
        ...(requestId ? { requestId } : {}),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save project: ${errorText(err)}`,
        // The id is this handler's own parameter, so it names the project that
        // failed however long the write took. Reading `this.viewing` in a catch
        // is what named the wrong object once already.
        target: { type: "project", id },
      });
    }
  }

  /**
   * Clone + register the project's managed checkout. Setup only: KEEPING a
   * checkout up to date is the worktree surface's job (that is where a working
   * copy, its branch and its dirty state live), so there is no pull here.
   */
  private async onProvisionProjectRepo(id: string): Promise<void> {
    try {
      const project = getProject(id);
      if (!project) {
        this.send({
          type: "error",
          message: `Unknown project: ${id}`,
          target: { type: "project", id },
        });
        return;
      }
      if (!project.repoUrl?.trim()) {
        this.send({
          type: "error",
          message: "Set a repository URL on the project first.",
          target: { type: "project", id },
        });
        return;
      }
      await cloneAndRegisterProjectRepo(id);
      invalidateMainRepo(id);
      void broadcastWorktreeList();
    } catch (err) {
      console.error(
        `[provisionProjectRepo] clone failed for project ${id}:`,
        err,
      );
      this.send({
        type: "error",
        message: `Failed to clone project repo: ${errorText(err)}`,
        target: { type: "project", id },
      });
    }
  }

  /**
   * Delete the project's managed clone: unregister it and remove the folder.
   * This is the ONE destructive repository action, and it refuses while spawned
   * worktrees exist — it used to force-remove them for you, which made "remove
   * the checkout" quietly the most destructive button on the page. Removing a
   * worktree is a worktree-level decision (it may hold unmerged work), so the
   * order is explicit: clean up the worktrees, then drop the clone.
   */
  private async onRemoveProjectRepo(id: string): Promise<void> {
    try {
      const project = getProject(id);
      if (!project) {
        this.send({
          type: "error",
          message: `Unknown project: ${id}`,
          target: { type: "project", id },
        });
        return;
      }
      const spawned = (await listWorktreeRecords(id)).filter(
        (record) => !record.isMain,
      );
      if (spawned.length > 0) {
        this.send({
          type: "error",
          message: `Remove this project's ${spawned.length} worktree${spawned.length === 1 ? "" : "s"} first, then remove the clone.`,
          target: { type: "project", id },
        });
        return;
      }
      // Unregister only the managed clone local path; leave external paths alone.
      const localPaths = project.localPaths ?? [];
      const remaining = localPaths.filter(
        (p) => !p.path || !isManagedRepoDir(id, p.path),
      );
      const unregistered = remaining.length !== localPaths.length;
      if (unregistered) updateProject(id, { localPaths: remaining });
      const deleted = await deleteProjectRepoFolder(id);
      if (!unregistered && !deleted) {
        this.send({
          type: "error",
          message:
            "This project's checkout is not a managed clone. Remove its path in Local paths instead.",
          target: { type: "project", id },
        });
        return;
      }
      invalidateMainRepo(id);
      void broadcastWorktreeList();
    } catch (err) {
      console.error(`[removeProjectRepo] failed for project ${id}:`, err);
      this.send({
        type: "error",
        message: `Failed to remove project repo: ${errorText(err)}`,
        target: { type: "project", id },
      });
    }
  }

  private onArchiveProject(id: string): void {
    try {
      archiveProject(id);
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to archive project: ${errorText(err)}`,
        target: { type: "project", id },
      });
    }
  }

  private onDeleteProject(id: string): void {
    try {
      deleteProject(id);
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to delete project: ${errorText(err)}`,
        target: { type: "project", id },
      });
    }
  }

  private async onListWorktrees(projectId?: string): Promise<void> {
    try {
      const worktrees = await listWorktreeRecords(cleanOptional(projectId));
      this.send({ type: "worktreeList", worktrees, updatedAt: Date.now() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to list worktrees: ${errorText(err)}`,
        target: { type: "worktree" },
      });
    }
  }

  private async onProposeWorktreeName(
    projectId: string,
    requestId: string,
    taskId?: string,
    context?: string,
  ): Promise<void> {
    try {
      const name = await generateWorktreeSuffix(
        this.worktreeNamingContext(taskId, context, projectId),
        getSettings().worktrees.namingAgent,
      );
      this.send({ type: "worktreeNameProposal", requestId, name });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to propose a worktree name: ${errorText(err)}`,
      });
    }
  }

  private async onCreateWorktree(
    projectId: string,
    name: string,
    taskId?: string,
    sessionId?: string,
  ): Promise<void> {
    try {
      const suffix = sanitizeWorktreeSuffix(name);
      if (!suffix)
        throw new Error("Worktree name must contain letters or digits.");
      if (sessionId && !isSafeId(sessionId)) {
        this.rejectBadId();
        return;
      }
      const task = taskId ? readTask(taskId) : undefined;
      const finalName = taskId
        ? taskWorktreeName(task ?? { id: taskId }, suffix)
        : suffix;
      await createWorktree({
        projectId,
        name: finalName,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to create worktree: ${errorText(err)}`,
      });
    }
  }

  /**
   * Start a code-delivery Workflow Run for a Task (`workflow/runStart.ts`).
   * Progress streams back as `workflowRunStart` phases keyed by `requestId`;
   * a refusal BEFORE the run row exists arrives as a `failed` phase with no
   * `runId`, meaning nothing was created.
   */
  private async onStartWorkflowRun(
    taskId: string,
    config: CodeDeliveryWorkflowConfig,
    baseBranch: string | undefined,
    limits: WorkflowRunLimits | undefined,
    requestId: string,
  ): Promise<void> {
    try {
      await startCodeDeliveryRun({
        taskId,
        config,
        ...(baseBranch !== undefined ? { baseBranch } : {}),
        ...(limits ? { limits } : {}),
        actor: { kind: "user" },
        report: ({ phase, runId, branch, error }) =>
          this.send({
            type: "workflowRunStart",
            requestId,
            phase,
            ...(runId !== undefined ? { runId: String(runId) } : {}),
            ...(branch ? { branch } : {}),
            ...(error ? { error } : {}),
          }),
      });
    } catch (err) {
      this.send({
        type: "workflowRunStart",
        requestId,
        phase: "failed",
        error: errorText(err),
      });
    }
  }

  /** Validate an untrusted wire id before any Workflow Run control side effect. */
  /**
   * Settle a formal Workflow Run (Task-677): the run's own acknowledgement,
   * cascading to the role sessions it structurally owns. Refused with the
   * shared reason while the run waits on an unresolved user decision, so the
   * item's disabled Settle and this error say the same thing.
   */
  private async onSettleWorkflowRun(
    rawRunId: string,
    throughRevision: number,
  ): Promise<void> {
    const runId = Number(rawRunId);
    const run =
      Number.isSafeInteger(runId) && runId > 0 ? getWorkflowRun(runId) : null;
    if (!run) {
      this.send({
        type: "error",
        message: `Failed to settle workflow run: run ${JSON.stringify(rawRunId)} does not exist.`,
      });
      return;
    }
    try {
      await settleWorkflowRun(runId, throughRevision);
    } catch (err) {
      // Re-send the authoritative list first, so a stale client cannot stay on
      // a false settled state after its optimistic update is rejected.
      broadcastWorkflowRuns();
      this.send({
        type: "error",
        target: { type: "task", id: String(run.taskId) },
        message: `Failed to settle workflow run: ${errorText(err)}`,
      });
    }
  }

  /**
   * One of the run's two DELIVERY controls (merge, cleanup).
   *
   * Not `onWorkflowRunControl`, because these two do not own their own failure:
   * they delegate to the live pull-request card, which persists what went wrong
   * as `actionError` and broadcasts it, and the Task's Workflow card renders
   * exactly that beside the button that failed. A Task-targeted error here as
   * well would put the SAME sentence in the page's failure note too — the
   * duplicate the `/pr` handler already refuses to produce (`docs/messaging.md`).
   *
   * So the divergence decides: a failure the card is now carrying is left to
   * the card, and anything else — a stale gate this seam refused before
   * touching the card, a card that is missing or already busy — is said here,
   * because nothing else will say it. Either way the run list goes out first,
   * so a client that rendered an offer the server refused sees why.
   *
   * "The card is carrying it" means a failure THIS attempt wrote, not merely
   * that the card carries some failure. A card keeps the last action's
   * `actionError` until the next action dequeues it, so a click refused at the
   * gate — which never reaches the card, and so never clears that sentence —
   * would otherwise be answered with silence, and the previous failure standing
   * on the Task would read as this click's explanation.
   *
   * Which is why the sentence is read BEFORE the attempt as well as after: the
   * card has to be carrying this failure AND have changed to it. The seam
   * cannot be told directly — the card action throws the same way whether it
   * refused before touching the card or failed at the provider — so this is the
   * one honest signal available, and it errs towards speaking: two identical
   * failures in a row (a retry of something that fails the same way) are
   * reported here as well as on the card, which repeats a sentence rather than
   * swallowing one.
   */
  private async onWorkflowDeliveryAction(
    rawRunId: string,
    action: () => Promise<string>,
  ): Promise<void> {
    const runId = Number(rawRunId);
    const run =
      Number.isSafeInteger(runId) && runId > 0 ? getWorkflowRun(runId) : null;
    if (!run) {
      this.send({
        type: "error",
        message: `Workflow run ${JSON.stringify(rawRunId)} does not exist.`,
      });
      return;
    }
    const failureBefore = this.workflowDeliveryFailure(runId);
    try {
      await action();
    } catch (err) {
      broadcastWorkflowRuns();
      const message = errorText(err);
      const failure = this.workflowDeliveryFailure(runId);
      if (failure === message && failure !== failureBefore) return;
      this.send({
        type: "error",
        target: { type: "task", id: String(run.taskId) },
        message: `Workflow delivery failed: ${message}`,
      });
    }
  }

  /** What the run's delivery projection currently states as its failure. */
  private workflowDeliveryFailure(runId: number): string | undefined {
    const run = getWorkflowRun(runId);
    const card = run ? workflowRunCardFor(run) : undefined;
    return card?.pullRequest?.delivery?.error;
  }

  private async onWorkflowRunControl(
    rawRunId: string,
    control: () => void | Promise<void>,
  ): Promise<void> {
    const runId = Number(rawRunId);
    const run =
      Number.isSafeInteger(runId) && runId > 0 ? getWorkflowRun(runId) : null;
    if (!run) {
      this.send({
        type: "error",
        message: `Workflow run ${JSON.stringify(rawRunId)} does not exist.`,
      });
      return;
    }
    try {
      await control();
    } catch (err) {
      this.send({
        type: "error",
        // A run has no object type of its own; its card is drawn by the Task
        // page, so the Task is where this belongs. Read BEFORE the control is
        // awaited, so it names the run that failed.
        target: { type: "task", id: String(run.taskId) },
        message: `Failed to control workflow run ${runId}: ${errorText(err)}`,
      });
    }
  }

  private async onMergeWorktree(
    worktreeId: string,
    strategy?: WorktreeMergeStrategy,
  ): Promise<void> {
    try {
      const valid =
        strategy === undefined ||
        strategy === "squash" ||
        strategy === "merge" ||
        strategy === "rebase";
      if (!valid) throw new Error("Unknown merge strategy.");
      await mergeWorktree(worktreeId, strategy);
    } catch (err) {
      this.send({
        type: "error",
        target: { type: "worktree", id: worktreeId },
        message: `Failed to merge worktree: ${errorText(err)}`,
      });
    }
  }

  private async onRemoveWorktree(
    worktreeId: string,
    deleteBranch?: boolean,
    force?: boolean,
  ): Promise<void> {
    try {
      // Gates, hold, removal and settlement in one place, so this surface and
      // the `/pr` card's cleanup cannot answer "what happens to the sessions
      // working in this checkout" differently. A refusal is the user's to read;
      // git's own guards (dirty tree, unmerged commits) still throw below.
      const refused = await removeWorktreeAndSettleSessions(worktreeId, {
        ...(deleteBranch !== undefined ? { deleteBranch } : {}),
        ...(force !== undefined ? { force } : {}),
      });
      if (refused) {
        this.send({
          type: "error",
          target: { type: "worktree", id: worktreeId },
          message: refused,
        });
        return;
      }
    } catch (err) {
      this.send({
        type: "error",
        target: { type: "worktree", id: worktreeId },
        message: `Failed to remove worktree: ${errorText(err)}`,
      });
    }
  }

  private holdComments(target: CommentTarget): void {
    const key = commentTargetKey(target);
    this.openComments.delete(key);
    this.openComments.set(key, target);
    while (this.openComments.size > MAX_OPEN_COMMENT_TARGETS) {
      const oldest = this.openComments.keys().next().value;
      if (oldest) this.openComments.delete(oldest);
    }
  }

  private ownershipForComment(commentId: string) {
    const ownership = commentOwnership(commentId);
    if (!ownership) throw new Error("Unknown comment.");
    return ownership;
  }

  private async onListComments(
    target: CommentTarget,
    requestId?: string,
  ): Promise<void> {
    const key = commentTargetKey(target);
    const generation = requestId ?? randomUUID();
    this.commentListGenerations.set(key, generation);
    try {
      const message = await commentsSnapshot(target, requestId);
      if (this.commentListGenerations.get(key) !== generation) return;
      this.commentListGenerations.delete(key);
      this.holdComments(target);
      this.send(message);
    } catch (err) {
      if (this.commentListGenerations.get(key) !== generation) return;
      this.commentListGenerations.delete(key);
      this.send({
        type: "commentsSnapshot",
        target,
        threads: [],
        revisions: [],
        ...(requestId ? { requestId } : {}),
        error: `Failed to list comments: ${errorText(err)}`,
      });
    }
  }

  private async onAddComment(
    target: CommentTarget,
    body: string,
    selectors?: SelectorBundle,
  ): Promise<void> {
    try {
      this.holdComments(target);
      const result = await commentStoreFor(target).add({
        target,
        body,
        ...(selectors !== undefined ? { selectors } : {}),
      });
      for (const threadId of result.threadIds)
        rememberCommentOwnership(target, threadId);
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to add comment: ${errorText(err)}`,
        target: messageTargetForComment(target),
      });
    }
  }

  /**
   * The object a comment write names when it fails: the one the thread hangs
   * off, resolved from the thread id BEFORE the write is attempted.
   *
   * Held in a local for the catch rather than re-derived there — the ownership
   * record can be evicted while the write is in flight, and a catch that has to
   * look it up again would report an unnamed failure exactly when the store is
   * the thing that went wrong.
   */
  private async writeComment(
    threadId: string,
    describe: (message: string) => string,
    write: (
      ownership: ReturnType<Connection["ownershipForComment"]>,
    ) => Promise<unknown>,
  ): Promise<void> {
    let named: MessageTarget | undefined;
    try {
      const ownership = this.ownershipForComment(threadId);
      named = messageTargetForComment(ownership.target);
      await write(ownership);
    } catch (err) {
      this.send({
        type: "error",
        message: describe(errorText(err)),
        ...(named ? { target: named } : {}),
      });
    }
  }

  private async onReplyComment(
    threadId: string,
    body: string,
    parentId?: string,
  ): Promise<void> {
    await this.writeComment(
      threadId,
      (reason) => `Failed to reply to comment: ${reason}`,
      ({ target, threadId: rootId }) =>
        commentStoreFor(target).reply({
          target,
          threadId: rootId,
          body,
          ...(parentId ? { parentId } : {}),
        }),
    );
  }

  private async onResolveComment(
    threadId: string,
    resolved: boolean,
  ): Promise<void> {
    await this.writeComment(
      threadId,
      (reason) => `Failed to update comment: ${reason}`,
      ({ target, threadId: rootId }) =>
        commentStoreFor(target).resolve({ target, threadId: rootId, resolved }),
    );
  }

  private async onEditComment(commentId: string, body: string): Promise<void> {
    await this.writeComment(
      commentId,
      (reason) => `Failed to edit comment: ${reason}`,
      ({ target, threadId }) =>
        commentStoreFor(target).edit({ target, threadId, commentId, body }),
    );
  }

  private async onDeleteComment(
    threadId: string,
    commentId?: string,
  ): Promise<void> {
    await this.writeComment(
      threadId,
      (reason) => `Failed to delete comment: ${reason}`,
      ({ target, threadId: rootId }) =>
        commentStoreFor(target).delete({
          target,
          threadId: rootId,
          ...(commentId ? { commentId } : {}),
        }),
    );
  }

  private async onAttachComments(
    threadIds: string[],
    sessionId?: string,
    session?:
      | { kind: "existing"; sessionId: string; additionalPrompt?: string }
      | {
          kind: "new";
          harness: Harness;
          agentType?: AgentType;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: ThinkingLevel;
          mode?: SessionMode;
          credentialProfileId?: string;
          additionalPrompt?: string;
          attachments?: PromptAttachment[];
        },
  ): Promise<void> {
    if (!threadIds.length) {
      this.send({ type: "error", message: "Select at least one comment." });
      return;
    }
    // The object the selected threads hang off, captured before the handoff so
    // the catch names it whatever happened to the ownership record meanwhile.
    // Set only once EVERY selection has resolved to that same object: a mixed or
    // unresolvable selection is explicitly not about one object, so naming the
    // first thread's would be the ambiguous target this rule exists to refuse.
    let named: MessageTarget | undefined;
    try {
      const target = this.ownershipForComment(threadIds[0]!).target;
      if (
        !threadIds.every(
          (id) =>
            commentTargetKey(this.ownershipForComment(id).target) ===
            commentTargetKey(target),
        )
      )
        throw new Error("All comments must belong to one target.");
      named = messageTargetForComment(target);
      const sessionTarget =
        session ??
        (sessionId ? { kind: "existing" as const, sessionId } : undefined);
      if (!sessionTarget) throw new Error("A session is required.");
      if (target.kind === "worktree") {
        await this.onAttachWorktreeComments(
          target.worktreeId,
          threadIds,
          sessionTarget as Parameters<
            Connection["onAttachWorktreeComments"]
          >[2],
        );
      } else {
        throw new Error("This comment target cannot be attached.");
      }
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to attach comments: ${errorText(err)}`,
        ...(named ? { target: named } : {}),
      });
    }
  }

  private async onAttachWorktreeComments(
    worktreeId: string,
    commentIds: string[],
    target:
      | { kind: "existing"; sessionId: string; additionalPrompt?: string }
      | {
          kind: "new";
          harness: Harness;
          agentType: AgentType;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: ThinkingLevel;
          mode?: SessionMode;
          credentialProfileId?: string;
          additionalPrompt: string;
          attachments?: PromptAttachment[];
        },
  ): Promise<void> {
    // A handoff views the session it prompts: claimed on arrival (see
    // `onAttachComments`).
    const ticket = this.claimViewRequest(
      target.kind === "existing" ? target.sessionId : undefined,
    );
    try {
      const row = await resolveWorktreeRow(worktreeId);
      if (!row || row.status !== "active" || !existsSync(row.path))
        throw new Error("That worktree is no longer available.");
      if (commentIds.length === 0)
        throw new Error("Select at least one comment.");
      // Canonical id (spawned id, or `main:<canonical projectId>`): comments and
      // edges must key off it, not the possibly-aliased client-supplied id.
      const canonicalId = row.id;
      const prompt = await buildReviewHandoffPrompt({
        worktreeId: canonicalId,
        commentIds,
      });
      if (!prompt) throw new Error("Those comments are no longer available.");

      let driver: LiveSession | undefined;
      if (target.kind === "existing") {
        // The socket is untrusted: only sessions actually linked to THIS
        // worktree may receive its comments (the review tools resolve the
        // worktree from that edge, so a mismatched target could not act on
        // them anyway).
        if (worktreeIdForSession(target.sessionId) !== canonicalId) {
          throw new Error("That session does not run in this worktree.");
        }
        const view = await hub.acquireById(target.sessionId);
        driver = view ? this.asRuntimePromptDriver(view) : undefined;
        if (!driver) throw new Error("That session is not available.");
      } else {
        if (!isOrdinarilyCreatableAgentType(target.agentType))
          throw new Error(
            `The "${String(target.agentType)}" agent cannot be created.`,
          );
        if (!this.guardDeveloperWorktree(target.agentType, row)) return;
        const engine = handoffEngine(target.harness);
        if (engine.guardsPersona && !this.guardKind(target.agentType)) return;
        driver = await engine.create(target, {
          id: canonicalId,
          path: row.path,
        });
      }

      markCommentsAttached(commentIds, driver.sessionId);
      this.viewIfCurrent(ticket, driver);
      // The generic dispatcher emits the selected threads as comment events.
      const additionalPrompt = target.additionalPrompt?.trim();
      // Same split as the Knowledge handoff above: a new session takes the
      // prompt (and attachments) directly, an existing one takes it through the
      // queue so a running turn delays the comments instead of refusing them.
      void (
        target.kind === "new"
          ? promptRuntimeSession(
              driver,
              additionalPrompt ?? prompt,
              additionalPrompt
                ? {
                    contextBlock: prompt,
                    ...(target.attachments?.length
                      ? { attachments: target.attachments }
                      : {}),
                  }
                : { origin: { kind: "system", source: "worktree-review" } },
            )
          : deliverAgentHandoff({
              sessionId: driver.sessionId,
              driver,
              text: additionalPrompt ?? prompt,
              ...(additionalPrompt
                ? {
                    origin: { kind: "human" as const },
                    contextBlock: prompt,
                    visible: true,
                  }
                : {
                    origin: {
                      kind: "system" as const,
                      source: "worktree-review",
                    },
                    visible: true,
                  }),
            })
      ).catch((err) =>
        this.send({
          type: "error",
          message: `Failed to send review comments: ${errorText(err)}`,
          target: { type: "session", id: driver.sessionId },
        }),
      );
      await hub.broadcastSessions();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to attach comments: ${errorText(err)}`,
        target: { type: "worktree", id: worktreeId },
      });
    }
  }

  private onReorderProjects(
    orderedIds: string[],
    placements?: Array<{ id: string; parentId?: string | null }>,
  ): void {
    try {
      reorderProjects(orderedIds, placements);
    } catch (err) {
      // No target: a reorder is about the ARRANGEMENT of many projects, so no
      // one of them is the object that failed — and the collection target means
      // "the list could not be read", which is a different condition with a
      // different repair. The drag's own surface reports this one.
      this.send({
        type: "error",
        message: `Failed to reorder projects: ${errorText(err)}`,
      });
    }
  }

  private onReorderTasks(
    orderedIds: string[],
    placements?: TaskReorderPlacement[],
  ): void {
    try {
      // As with projects: an arrangement of many Tasks has no single object to
      // name, so this failure carries no target and the drag's surface says it.
      reorderTasks(orderedIds, placements, true);
      // The moved rows reach every subscriber (this connection included) as the
      // broadcast event batch; a reply carrying the list would be the snapshot
      // this model exists to remove.
      if (this.viewing) this.viewing.broadcastState();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to reorder tasks: ${errorText(err)}`,
      });
    }
  }

  private onAssignTaskProjects(updates: TaskProjectAssignmentUpdate[]): void {
    try {
      if (!Array.isArray(updates) || updates.length === 0)
        throw new Error("At least one task update is required.");
      const normalized = new Map<string, string | null>();
      for (const update of updates) {
        if (!update || typeof update.id !== "string" || !update.id.trim())
          throw new Error("Each update needs a task id.");
        const id = update.id.trim();
        const projectId =
          typeof update.projectId === "string" && update.projectId.trim()
            ? update.projectId.trim()
            : null;
        const existing = normalized.get(id);
        if (normalized.has(id) && existing !== projectId)
          throw new Error(`Conflicting project updates for task ${id}.`);
        normalized.set(id, projectId);
      }
      for (const id of normalized.keys()) {
        const item = readTask(id);
        if (!item) throw new Error(`Task not found: ${id}`);
      }
      for (const [id, projectId] of normalized.entries()) {
        updateTask(id, { projectId, actor: { kind: "user" } });
      }
      this.send({ type: "taskProjectsAssigned" });
      if (this.viewing) this.viewing.broadcastState();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to assign task projects: ${errorText(err)}`,
      });
    }
  }

  private onSaveTask(request: TaskSaveRequest, requestId?: string): void {
    try {
      // An update may omit the title entirely, which leaves the stored one
      // alone; a save that carries one must still carry a real one, and a
      // create has nothing to fall back to.
      const title = request.title?.trim();
      if (title === "" || (!request.id && !title))
        throw new Error("Title is required.");
      const shouldLinkCurrentSession = request.linkCurrentSession === true;
      const sessionRef =
        shouldLinkCurrentSession && this.viewing
          ? [
              {
                harness: this.viewing.harness,
                agentType: this.viewing.agentType,
                sessionId: this.viewing.sessionId,
              },
            ]
          : [];
      const sourceSession = shouldLinkCurrentSession ? this.viewing : undefined;
      const item = request.id
        ? updateTask(request.id, {
            ...(title !== undefined ? { title } : {}),
            ...(request.description !== undefined
              ? { description: request.description }
              : {}),
            status: normalizeTaskStatus(request.status),
            actor: { kind: "user" },
            ...(request.projectId !== undefined
              ? {
                  projectId:
                    request.projectId === "" ? null : request.projectId,
                }
              : {}),
            ...(request.jiraIssueKeys !== undefined
              ? { jiraIssueKeys: request.jiraIssueKeys }
              : {}),
            ...(request.githubIssues !== undefined
              ? { githubIssues: request.githubIssues }
              : {}),
            ...(request.externalLinks !== undefined
              ? { externalLinks: request.externalLinks }
              : {}),
            ...taskSchedulingForUpdate(request),
            clearStatusSuggestion: request.clearStatusSuggestion === true,
            ...(request.triaged !== undefined
              ? { triaged: request.triaged }
              : {}),
            ...(request.parentId !== undefined
              ? { parentId: request.parentId === "" ? null : request.parentId }
              : {}),
            ...(request.linkCurrentSession
              ? {
                  sessionRefs: mergeSessionRefs(
                    readTask(request.id)?.sessionRefs,
                    sessionRef,
                  ),
                }
              : {}),
          })
        : createTask({
            title: title ?? "",
            description: request.description ?? "",
            status: normalizeTaskStatus(request.status),
            ...(request.projectId != null
              ? { projectId: request.projectId }
              : {}),
            ...(request.jiraIssueKeys !== undefined
              ? { jiraIssueKeys: request.jiraIssueKeys }
              : {}),
            ...(request.githubIssues !== undefined
              ? { githubIssues: request.githubIssues }
              : {}),
            ...(request.externalLinks !== undefined
              ? { externalLinks: request.externalLinks }
              : {}),
            ...taskSchedulingForCreate(request),
            ...(request.parentId ? { parentId: request.parentId } : {}),
            sessionRefs: sessionRef,
            // Typed here, so there is nothing to triage. Every OTHER creation
            // path (agent tools, Slack intake, the day scanner) is an arrival
            // and lands in the Inbox.
            triaged: true,
            source: {
              createdBy: "user",
              ...(sourceSession?.agentType !== undefined
                ? { agentType: sourceSession?.agentType }
                : {}),
              ...(sourceSession?.sessionId !== undefined
                ? { sessionId: sourceSession?.sessionId }
                : {}),
            },
          });
      // The FULL item, and only it: the detail view adopts the stored body from
      // here, and a create settles its optimistic row against it (`requestId`).
      this.send({
        type: "taskSaved",
        item,
        ...(requestId ? { requestId } : {}),
      });
      if (this.viewing) this.viewing.broadcastState();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save task: ${errorText(err)}`,
        // Only an UPDATE has an object to name. A create's Task does not exist
        // yet, so naming the id the request carried (there is none) or the one
        // it would have got (unknown) would both be inventions; that failure
        // belongs to the control that was refused.
        ...(request.id
          ? { target: { type: "task" as const, id: request.id } }
          : {}),
      });
    }
  }

  private onArchiveTask(id: string, archived: boolean): void {
    try {
      if (archived) archiveTask(id, { kind: "user" });
      else unarchiveTask(id, { kind: "user" });
      if (this.viewing) this.viewing.broadcastState();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to ${archived ? "archive" : "restore"} task: ${errorText(err)}`,
        target: { type: "task", id },
      });
    }
  }

  private onDeleteTask(id: string): void {
    try {
      deleteTask(id);
      if (this.viewing) this.viewing.broadcastState();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to delete task: ${errorText(err)}`,
        target: { type: "task", id },
      });
    }
  }

  private onGetTask(id: string, requestId: string): void {
    try {
      const item = readTask(id);
      this.send({ type: "taskDetail", id, item, requestId });
    } catch (err) {
      this.send({
        type: "taskDetail",
        id,
        item: null,
        requestId,
        error: `Failed to load Task: ${errorText(err)}`,
      });
    }
  }

  /**
   * Record that this session was started from a Task (origin link + metadata)
   * and return the Task AS IT NOW STANDS — after the `doing` nudge below.
   *
   * The caller builds the context attachment from what comes back, so the
   * injected status can never contradict the stored one: building it from a
   * pre-nudge read is what used to open a Task-attached session on a stale
   * `Status: todo`.
   */
  private taskListResponse(request: TaskListRequest): TaskListResponse {
    const session =
      request.sessionId && this.viewing
        ? { kind: this.viewing.kind, sessionId: request.sessionId }
        : undefined;
    const projectIdValue = cleanOptional(request.projectId);
    const queryValue = cleanOptional(request.query);
    const items = listTasks({
      ...(request.status !== undefined ? { status: request.status } : {}),
      ...(projectIdValue !== undefined ? { projectId: projectIdValue } : {}),
      ...(request.priority !== undefined ? { priority: request.priority } : {}),
      ...(request.due !== undefined ? { due: request.due } : {}),
      ...(session !== undefined ? { session } : {}),
      ...(queryValue !== undefined ? { query: queryValue } : {}),
      includeArchived: Boolean(request.includeArchived),
    });
    return { request, items, updatedAt: Date.now() };
  }

  /**
   * Approve/reject a pending approval card. The action executes server-side in
   * the store; then the decision is handed to the agent as a hidden outcome
   * prompt (mirrors the question flow). A session that is mid-turn behind a
   * provider that cannot be steered does not lose it: `agentHandoffs.ts` queues
   * the handoff and delivers it on that session's next idle edge.
   */
  private async onResolveApproval(
    approvalId: string,
    decision: import("@assistant/shared").ApprovalDecision,
    edits: import("@assistant/shared").ApprovalResolutionEdits | undefined,
    forSession: boolean,
  ): Promise<void> {
    try {
      const { card, outcomePrompt } = await resolveApproval(
        approvalId,
        decision,
        edits,
        { forSession },
      );
      const live = this.viewing;
      const driver =
        live && live.sessionId === card.sessionId
          ? this.asRuntimePromptDriver(live)
          : undefined;
      if (outcomePrompt) {
        void deliverAgentHandoff({
          sessionId: card.sessionId,
          text: outcomePrompt,
          origin: { kind: "system", source: "approval-decision" },
          ...(driver ? { driver } : {}),
        }).catch((err) =>
          this.send({
            type: "error",
            // The card's own session, not the viewed one: it was captured
            // before the resolve was awaited, so it still names the session
            // this handoff was about.
            target: { type: "session", id: card.sessionId },
            message: `Failed to notify the agent of the approval decision: ${errorText(err)}`,
          }),
        );
      }
    } catch (err) {
      // A reconnecting/stale client may re-submit a decision for a card the
      // server already resolved. Re-send its authoritative state so the card
      // leaves "pending" and its local button spinner can recover.
      const current = approvalForId(approvalId);
      if (current)
        this.send({
          type: "approvalUpdate",
          sessionId: current.sessionId,
          approval: current,
        });
      this.send({
        type: "error",
        // Named where the card is still readable; a card the server no longer
        // knows leaves nothing unambiguous to name, so it names nothing.
        ...(current
          ? { target: { type: "session" as const, id: current.sessionId } }
          : {}),
        message: `Failed to resolve approval: ${errorText(err)}`,
      });
    }
  }

  /**
   * Answer a `choosing-task` pull-request card's disambiguation prompt: draft
   * and create the pull request against the chosen Task (or none), then hand
   * the outcome back as a hidden prompt — queued behind a running turn when it
   * has to be, exactly like {@link onResolveApproval}.
   */
  private async onResolvePullRequestCardTask(
    cardId: string,
    taskId: string | null,
  ): Promise<void> {
    try {
      const before = pullRequestCardById(cardId);
      if (!before)
        throw new Error("Pull request card not found or already resolved.");
      if (before.status !== "choosing-task")
        throw new Error(`This pull request card is already ${before.status}.`);
      const updated = await finalizePullRequestCard(cardId, taskId);
      const live = this.viewing;
      const driver =
        live && live.sessionId === updated.sessionId
          ? this.asRuntimePromptDriver(live)
          : undefined;
      void deliverAgentHandoff({
        sessionId: updated.sessionId,
        text: pullRequestOutcomePrompt(updated),
        origin: { kind: "system", source: "pull-request-task-decision" },
        ...(driver ? { driver } : {}),
      }).catch((err) =>
        this.send({
          type: "error",
          // The card's own session, resolved before the prompt was issued —
          // the same shape as the approval-decision notify above, and nothing
          // else records this failure.
          target: { type: "session", id: updated.sessionId },
          message: `Failed to notify the agent of the pull request outcome: ${errorText(err)}`,
        }),
      );
    } catch (err) {
      // A reconnecting/stale client may re-submit a decision for a card the
      // server already resolved; re-send its authoritative state so the local
      // button spinner can recover.
      //
      // The send below STAYS, unlike the one in `onPullRequestCardAction`: a
      // creation failure never reaches here (`finalizePullRequestCard` returns
      // a `failed` card with `error` on it), so everything that does is a
      // stale-resubmit refusal that writes nothing to the card. This send is
      // their only report.
      const current = pullRequestCardById(cardId);
      if (current)
        this.send({
          type: "pullRequestCardUpdate",
          sessionId: current.sessionId,
          card: current,
        });
      this.send({
        type: "error",
        message: `Failed to create the pull request: ${errorText(err)}`,
      });
    }
  }

  /**
   * Run one of a live pull-request card's actions (merge, update-with-main,
   * cleanup, mark the linked Task done). The action itself, with its refusals
   * and its ordering, lives in `pullRequestActions.ts`; this layer only decides
   * WHERE a resulting agent prompt goes.
   *
   * The conflict handoff targets the CARD's session rather than the viewed one:
   * the rebase was asked for on that session's work, so the prompt belongs
   * there even if the user has since switched tabs. Its outcome — accepted or
   * refused — is written back onto the card, because that is the copy the user
   * still has tomorrow.
   */
  private async onPullRequestCardAction(
    cardId: string,
    action: import("@assistant/shared").PullRequestCardAction,
    options: import("@assistant/shared").PullRequestCardActionOptions,
  ): Promise<void> {
    try {
      const { card, agentPrompt, actionToken } = await runPullRequestCardAction(
        cardId,
        action,
        options,
      );
      if (!agentPrompt) return;
      // Every outcome of the handoff is written back to the CARD, not only to
      // this socket: a session that cannot be reached or a rejected prompt
      // would otherwise leave a durable card claiming the agent took the
      // rebase, with the truth in a toast the user may never see.
      //
      // The action's own token correlates that late write with the action it
      // belongs to. Success lands when the prompt is APPENDED (`onUserEntry`),
      // not when the turn ends minutes later, and an outcome for an action the
      // card has since moved past is dropped rather than overwriting the newer
      // one.
      // The card IS the home, so this says nothing else: `actionError` on a
      // broadcast, persisted card is an in-place condition found by going to the
      // object, on screen or not (`docs/messaging.md`), and it survives a reload
      // in a way a composer note or a toast does not. A second copy would also
      // be the worse-written one — the card's reason names both branches.
      const fail = (reason: string) => {
        recordRebaseHandoff(cardId, { ok: false, reason }, actionToken);
      };
      const view = await hub.acquireById(card.sessionId);
      const driver = view ? this.asRuntimePromptDriver(view) : undefined;
      if (!driver) {
        fail("that session is not available.");
        return;
      }
      // No separate worktree probe here: `promptRuntimeSession` runs the same
      // check at the run boundary and REJECTS, which routes through `fail`
      // below — one code path, and no way for a throwing probe to skip the
      // durable record.
      //
      // A session that is mid-turn does not refuse the rebase, it waits for it
      // (`agentHandoffs.ts`); the card records the handoff when the prompt is
      // appended, whether that happens now or at the next idle edge.
      void deliverAgentHandoff({
        sessionId: card.sessionId,
        driver,
        text: agentPrompt,
        origin: { kind: "system", source: "pull-request-rebase" },
        visible: true,
        // The CARD is told what became of this, by the handler registered
        // beside `recordRebaseHandoff` — durably, because a queued rebase may
        // land after a restart and a card still offering an action the agent is
        // already carrying out invites a second click.
        outcomeRef: {
          kind: PULL_REQUEST_REBASE_OUTCOME,
          id: cardId,
          token: actionToken,
        },
      }).catch((err) => fail(errorText(err)));
    } catch (err) {
      // The card already carries the failure (`actionError`) and was broadcast;
      // re-send its authoritative state so a stale client's local spinner
      // recovers. That card is the failure's home, so nothing is said beside it.
      const current = pullRequestCardById(cardId);
      if (current) {
        this.send({
          type: "pullRequestCardUpdate",
          sessionId: current.sessionId,
          card: current,
        });
        return;
      }
      // No card left to render it and no id to name: this is the one shape that
      // has to be said bare, and it belongs to the known divergence rather than
      // to a home it does not have.
      this.send({
        type: "error",
        message: `Pull request ${action} failed: ${errorText(err)}`,
      });
    }
  }

  /**
   * Run a slash command. Slash commands are a UNIVERSAL concept: they are always
   * intercepted and handled here (never forwarded to the model), independent of
   * the session's harness/provider. Applicability is validated against the
   * command registry (agentType + harness); inapplicable commands surface a clear
   * error rather than being sent on as a prompt.
   */
  private async onRunSlashCommand(
    name: string,
    rawArgs: string,
  ): Promise<void> {
    // Captured BEFORE the runner is awaited: `this.viewing` is mutable, and
    // /commit, /push and /pr take long enough for the user to switch sessions
    // underneath them. Reading it in the catch would name whichever session is
    // in view when the failure lands, and a failure rendered above the WRONG
    // session's composer is worse than one with no object at all.
    const commandSessionId = this.viewing?.sessionId;
    try {
      // Nothing in view is a stale or foreign client and is told so; a reader
      // who navigated away mid-command is not, which is why that case is the
      // silent one below.
      if (!this.viewing) throw new Error("No active session for this command.");
      // A host command opens a synthetic TURN in the session, so it needs the
      // harness a storage-backed view has not opened yet — and it runs against
      // the session it was ISSUED against, or not at all: a reader who
      // navigated away while that harness opened is not running /commit here.
      await this.withViewedSession(async (viewing) => {
        // Same hazard as an ordinary prompt: /commit, /push, /pr and /compact
        // act on the session's cwd. /pr chains /commit and /push through this
        // same runner seam (Task 325), so it is covered here too, not just
        // incidentally. A context-only command is exempt — see the set.
        if (
          !CONTEXT_ONLY_SLASH_COMMANDS.has(name) &&
          !this.guardMissingWorktree(viewing.sessionId)
        )
          return;

        const cmd = findSlashCommand(name);
        if (!cmd) throw new Error(`Unknown slash command: /${name}`);
        // Client-executed commands (e.g. /review) are handled entirely in the
        // web app; a dispatch that reaches here is a stale or foreign client.
        if (cmd.execution === "client") {
          throw new Error(`/${name} runs in the web app, not on the server.`);
        }
        if (!slashCommandApplies(cmd, viewing.agentType, viewing.harness)) {
          throw new Error(`/${name} is not available for this session.`);
        }

        // Host-driven commands share one harness-neutral runner inventory. The
        // viewed pi/Claude session IS the SyntheticToolHost; `/pr` chains three
        // separate synthetic turns through that same seam.
        const runner = hostSlashCommandRunner(name);
        if (!runner)
          throw new Error(`/${name} is not available for this session.`);
        await runner(viewing, rawArgs);
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to run /${name}: ${errorText(err)}`,
        ...(commandSessionId
          ? { target: { type: "session" as const, id: commandSessionId } }
          : {}),
      });
    }
  }

  /**
   * The user's own queue for one session (`promptQueue.ts`). Addressed by id,
   * not by the view, so a phone and a desktop edit the same queue; the
   * permanent Assistant has its own intake queue and takes none of these.
   */
  private async onPromptQueueCommand(msg: PromptQueueCommand): Promise<void> {
    const { sessionId } = msg;
    const target = { type: "session" as const, id: sessionId };
    if (!this.resolveSessionRef(sessionId)) {
      this.send({ type: "error", message: "Unknown session.", target });
      return;
    }
    if (isPermanentAssistantSession(sessionId)) {
      this.send({
        type: "error",
        message: "The Assistant queues messages on its own.",
        target,
      });
      return;
    }
    try {
      switch (msg.type) {
        case "queuePrompt":
          return queuePrompt(sessionId, {
            text: msg.text,
            ...(msg.attachments?.length
              ? { attachments: msg.attachments }
              : {}),
            ...(msg.command ? { command: msg.command } : {}),
          });
        case "updateQueuedPrompt":
          return updateQueuedPrompt(sessionId, msg.id, msg.text);
        case "removeQueuedPrompt":
          return removeQueuedPrompt(sessionId, msg.id);
        case "moveQueuedPrompt":
          return moveQueuedPrompt(sessionId, msg.id, msg.toIndex);
        case "clearPromptQueue":
          return clearPromptQueue(sessionId);
        case "sendQueuedPromptNow":
          return await sendQueuedPromptNow(sessionId, msg.id);
        case "resumePromptQueue":
          return resumePromptQueue(sessionId);
      }
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to update the queue: ${errorText(err)}`,
        target,
      });
    }
  }

  private async onAcceptCommitDryRun(entryId: string): Promise<void> {
    // The dry-run card is accepted INTO the session, so it needs the harness;
    // only pi produces dry-run cards.
    return this.withViewedSession(async (driver) => {
      // Named from the driver this ran against, not from `this.viewing`: the
      // accept runs a commit, which is long enough for the user to switch
      // sessions underneath it, and the failure belongs to THIS session.
      if (!isLiveSession(driver) || !driver.acceptCommitDryRun) return;
      try {
        await driver.acceptCommitDryRun(entryId);
      } catch (err) {
        this.send({
          type: "error",
          target: { type: "session" as const, id: driver.sessionId },
          message: `Failed to accept dry-run commit: ${errorText(err)}`,
        });
      }
    });
  }

  /**
   * Record the user's answers and resume the session with them.
   *
   * Answering used to be REFUSED while the session was running behind a
   * provider that cannot be steered ("stop the response or wait"), which asked
   * the user to babysit a panel they had already filled in. The answers are
   * recorded either way now, and the resume they produce is a handoff like any
   * other: delivered mid-turn where the provider takes it, queued for the next
   * idle edge where it does not.
   */
  private async onRespondToQuestion(
    response: AgentQuestionResponse,
  ): Promise<void> {
    try {
      if (!this.viewing)
        throw new Error("No active session for question response.");
      const driver = await this.ensureViewingDriver();
      if (!driver) throw new Error("Active session cannot be prompted.");
      const id = this.viewing.sessionId;
      const { resumePrompt } = submitAgentQuestionResponse(id, response);
      this.viewing.broadcastState();
      if (resumePrompt) {
        void deliverAgentHandoff({
          sessionId: id,
          driver,
          text: resumePrompt,
          origin: { kind: "system", source: "agent-question-response" },
        }).catch((err) =>
          this.send({
            type: "error",
            // `id` is the session the answers were submitted to, captured
            // above; the resume settles long after the user may have moved on.
            target: { type: "session", id },
            message: `Failed to resume session with answers: ${errorText(err)}`,
          }),
        );
      }
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to submit question responses: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateSettings(patch: Partial<AppSettings>): Promise<void> {
    try {
      // Every client, this one included, receives the result through
      // `settingsChanged` once it is safely on disk.
      await saveSettings(patch);
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save settings: ${errorText(err)}`,
      });
    }
  }

  /** Any settings write, from any client or agent, lands here for every connection. */
  settingsChanged(change: SettingsChange): void {
    const settings = this.settings();
    this.send({ type: "settings", settings });
    if (
      change.sections.includes("claudeSdk") ||
      change.sections.includes("openAiCompatible")
    )
      this.send({ type: "models", models: pickerModels(settings) });
    // Availability depends on the settings just saved (`modelId` selects among
    // installed models), so recompute it — otherwise the Settings health line
    // and the mic button's reason keep reporting the pre-save answer until the
    // next reconnect.
    if (change.sections.includes("speechToText"))
      this.send({
        type: "speechToTextStatus",
        status: describeSttAvailability(settings.speechToText),
      });
  }

  private async onUpdateJiraSettings(patch: JiraSettingsPatch): Promise<void> {
    try {
      await saveSettings({ jira: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Jira settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestJiraSettings(
    patch: JiraSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ jira: patch });
      this.send({
        type: "jiraStatus",
        status: await testJiraSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Jira settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestJiraSettings(): Promise<void> {
    try {
      this.send({
        type: "jiraStatus",
        status: await testJiraSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Jira settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateConfluenceSettings(
    patch: ConfluenceSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ confluence: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Confluence settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestConfluenceSettings(
    patch: ConfluenceSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ confluence: patch });
      this.send({
        type: "confluenceStatus",
        status: await testConfluenceSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Confluence settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestConfluenceSettings(): Promise<void> {
    try {
      this.send({
        type: "confluenceStatus",
        status: await testConfluenceSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Confluence settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateTempoSettings(
    patch: TempoSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ tempo: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Tempo settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestTempoSettings(
    patch: TempoSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ tempo: patch });
      this.send({
        type: "tempoStatus",
        status: await testTempoSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Tempo settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestTempoSettings(): Promise<void> {
    try {
      this.send({
        type: "tempoStatus",
        status: await testTempoSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Tempo settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateGoogleSettings(
    patch: GoogleSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ google: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Google Workspace settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestGoogleSettings(
    patch: GoogleSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ google: patch });
      this.send({
        type: "googleStatus",
        status: await testGoogleSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Google Workspace settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestGoogleSettings(): Promise<void> {
    try {
      this.send({
        type: "googleStatus",
        status: await testGoogleSettings(),
        settings: this.settings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Google Workspace settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateSlackSettings(
    patch: SlackSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ slack: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Slack settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestSlackSettings(
    patch: SlackSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ slack: patch });
      this.send({
        type: "slackStatus",
        status: await testSlackSettings(),
        settings: getSettings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Slack settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestSlackSettings(): Promise<void> {
    try {
      this.send({
        type: "slackStatus",
        status: await testSlackSettings(),
        settings: getSettings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Slack settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestSlackHuddleSettings(
    patch: SlackSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ slack: patch });
      this.send({
        type: "slackHuddleStatus",
        status: await testSlackHuddleSettings(),
        settings: getSettings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Slack Huddle settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestSlackHuddleSettings(): Promise<void> {
    try {
      this.send({
        type: "slackHuddleStatus",
        status: await testSlackHuddleSettings(),
        settings: getSettings(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Slack Huddle settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateOpenAiCompatibleSettings(
    patch: OpenAiCompatibleSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ openAiCompatible: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save OpenAI-compatible provider settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestOpenAiCompatibleSettings(
    patch: OpenAiCompatibleSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ openAiCompatible: patch });
      const status = await testOpenAiCompatibleSettings();
      // A test stores the models it discovered: every client hears about them.
      await announceSettingsWritten(["openAiCompatible"]);
      this.send({
        type: "openAiCompatibleStatus",
        status,
        settings: getSettings(),
        models: pickerModels(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test OpenAI-compatible provider settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestOpenAiCompatibleSettings(): Promise<void> {
    try {
      const status = await testOpenAiCompatibleSettings();
      // A test stores the models it discovered: every client hears about them.
      await announceSettingsWritten(["openAiCompatible"]);
      this.send({
        type: "openAiCompatibleStatus",
        status,
        settings: getSettings(),
        models: pickerModels(),
      });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test OpenAI-compatible provider settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateBraveSettings(
    patch: BraveSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ brave: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save web search settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestBraveSettings(
    patch: BraveSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ brave: patch });
      const status = await testBraveSettings();
      this.send({ type: "braveStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test web search settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestBraveSettings(): Promise<void> {
    try {
      const status = await testBraveSettings();
      this.send({ type: "braveStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test web search settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateContext7Settings(
    patch: Context7SettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ context7: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Context7 settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestContext7Settings(
    patch: Context7SettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ context7: patch });
      const status = await testContext7Settings();
      this.send({ type: "context7Status", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Context7 settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestContext7Settings(): Promise<void> {
    try {
      const status = await testContext7Settings();
      this.send({ type: "context7Status", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Context7 settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateGithubSettings(
    patch: GithubSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ github: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save GitHub settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestGithubSettings(
    patch: GithubSettingsPatch,
  ): Promise<void> {
    try {
      // Saving settles the package proxy first, so the status line reports its
      // real state.
      await saveSettings({ github: patch });
      const status = await testGithubSettings();
      this.send({ type: "githubStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test GitHub settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestGithubSettings(): Promise<void> {
    try {
      const status = await testGithubSettings();
      this.send({ type: "githubStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test GitHub settings: ${errorText(err)}`,
      });
    }
  }

  private async onUpdateForgejoSettings(
    patch: ForgejoSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ forgejo: patch });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save Forgejo settings: ${errorText(err)}`,
      });
    }
  }

  private async onSaveAndTestForgejoSettings(
    patch: ForgejoSettingsPatch,
  ): Promise<void> {
    try {
      await saveSettings({ forgejo: patch });
      const status = await testForgejoSettings();
      this.send({ type: "forgejoStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to save/test Forgejo settings: ${errorText(err)}`,
      });
    }
  }

  private async onTestForgejoSettings(): Promise<void> {
    try {
      const status = await testForgejoSettings();
      this.send({ type: "forgejoStatus", status, settings: getSettings() });
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to test Forgejo settings: ${errorText(err)}`,
      });
    }
  }

  private async onRefreshModels(requestId: string): Promise<void> {
    try {
      const { error } = await refreshPiModels();
      const models = pickerModels();
      this.send({ type: "models", models, requestId });
      // The refreshed list is the receipt; only a broken models.json or an
      // account whose catalog could not be fetched is worth saying out loud,
      // and that is a CONDITION rather than an outcome.
      if (error)
        this.send({
          type: "notice",
          severity: "warning",
          message: `Reloaded ${models.length} available models, but a provider catalog has an error: ${error}`,
        });
    } catch (err) {
      // The reply is what retires the client's busy state, so it goes out even
      // when the refresh threw — with the list the client already had.
      this.send({ type: "models", models: pickerModels(), requestId });
      this.send({
        type: "error",
        message: `Failed to refresh models: ${errorText(err)}`,
      });
    }
  }

  private async onSetModel(provider: string, id: string): Promise<void> {
    // Route model changes through the runtime view (the pi adapter resolves the
    // model via the profile registry; the claude-sdk adapter takes the alias).
    // The harness owns the selection, so a storage-backed view opens it first.
    return this.withViewedSession((_driver, view) => {
      if (view) this.applySessionConfig(() => view.setModel({ provider, id }));
    });
  }

  /**
   * Apply a session-config change (`setModel`, `setReasoning`) and report its
   * refusal to the user. Both seams answer synchronously on one adapter and
   * with a promise on another, so a bare try/catch would miss half the
   * refusals — and the missed rejection is not merely lost: unhandled, it
   * reaches `index.ts`'s `uncaughtException` guard and exits the process.
   *
   * That is not hypothetical. `PiAdapter.setModel` throws for a model the
   * profile registry cannot resolve, inside the async `LiveRuntimeSession.setModel`,
   * so picking an unavailable model in a pi session took the whole server down
   * instead of drawing "model is not available" on that session's picker.
   */
  private applySessionConfig(apply: () => void | PromiseLike<void>): void {
    // Read before the call, and nothing here awaits before `report` closes over
    // it: the refusal is about the session whose picker was used, not whichever
    // is in view when it lands.
    const sessionId = this.viewing?.sessionId;
    const report = (err: unknown): void => {
      this.send({
        type: "error",
        ...(sessionId
          ? { target: { type: "session" as const, id: sessionId } }
          : {}),
        message: errorText(err),
      });
    };
    try {
      // Duck-typed, not `instanceof Promise`: the declared return is the seam's
      // CONTRACT, not a guarantee about the object — a thenable that is not a
      // native Promise (another realm, a wrapped SDK client) would slip past an
      // identity check and float again, which is the crash this exists to stop.
      const settled: unknown = apply();
      if (isThenable(settled)) settled.then(undefined, report);
    } catch (err) {
      report(err);
    }
  }

  /**
   * Switch the viewed session between Build and Plan. The mode is a HARNESS
   * capability, not a runtime-adapter one (it is the next turn's tool policy),
   * so it goes straight to the live harness session rather than through
   * `runtimeView.setReasoning`'s config seam.
   */
  private async onSetSessionMode(mode: SessionMode): Promise<void> {
    if (!SESSION_MODES.includes(mode)) {
      this.send({ type: "error", message: `Unknown session mode "${mode}".` });
      return;
    }
    // Mode is the next turn's tool policy, which only the harness can hold.
    return this.withViewedSession((driver) => {
      const session = isLiveSession(driver) ? driver : undefined;
      if (!session) return;
      try {
        session.setMode(mode);
      } catch (err) {
        this.send({
          type: "error",
          target: { type: "session", id: session.sessionId },
          message: errorText(err),
        });
      }
    });
  }

  /**
   * Calendar per-day session. Ensures a normal assistant (pi) session bound to
   * the day exists (creating it with the configured Calendar-day model and a
   * fixed "Calendar · <date>" name that suppresses auto-rename), views it so the
   * calendar's right panel can embed its live chat, and optionally runs the
   * one-click day scan in it.
   */
  private async onCalendarDayActivate(
    date: string,
    opts: {
      scan?: boolean;
      logTime?: boolean;
      text?: string;
      model?: { provider: string; id: string };
      thinkingLevel?: ThinkingLevel;
    },
  ): Promise<void> {
    try {
      assertValidDate(date);
      if (!this.guardKind("assistant")) return;
      // Activating a day views its session: claimed after the synchronous
      // checks (an invalid or guarded activation views nothing, so it must not
      // cancel a load still acquiring) and before the first await, so a
      // navigation the client makes while the session is resolved stays the
      // view.
      const boundId = getDaySessionId(date);
      const ticket = this.claimViewRequest(boundId ?? undefined);
      const settings = getSettings().calendarDaySession;
      // Model/thinking come from the pre-session composer's picker when present,
      // else the configured Calendar-day defaults.
      const provider = opts.model?.provider ?? settings.provider;
      const modelId = opts.model?.id ?? settings.modelId;
      const thinkingLevel = opts.thinkingLevel ?? settings.thinkingLevel;
      const useClaudeSdk =
        provider === CLAUDE_SDK_PROVIDER && getSettings().claudeSdk.enabled;
      // The composer picker may override provider/model; a pin for another
      // provider then degrades to automatic inside resolveSlotAccount.
      const credentialProfileId = accountForSlot({
        provider,
        modelId,
        ...(settings.credentialProfileId
          ? { credentialProfileId: settings.credentialProfileId }
          : {}),
      });
      // Whether this activation will DRIVE the day session or merely show it.
      // Opening the day panel is a read: it must not pay for the provider
      // transcript (`viewSession.ts`), which is what embedding the day chat did
      // on every calendar navigation.
      const driving = Boolean(opts.text?.trim() || opts.scan || opts.logTime);
      let driver: LiveSession | undefined;
      let view: HarnessDriver | undefined;
      if (boundId) {
        if (!driving) view = hub.viewById(boundId);
        if (!view) {
          try {
            driver = this.asRuntimePromptDriver(await hub.acquireById(boundId));
          } catch {
            driver = undefined;
          }
          // A bound id that can no longer be acquired is a stale binding (e.g. a
          // day session that was never persisted); clear it so the panel falls
          // back to the pre-session composer instead of spinning on a ghost.
          // Asked of the ACQUIRE, not of the storage-backed view: a legacy
          // binding with a transcript but no metadata row is reopenable, and
          // treating it as stale would drop a day the user still has.
          // Only the binding this activation read: another one may have
          // replaced it meanwhile with the day's new session.
          if (!driver && getDaySessionId(date) === boundId)
            clearDaySession(date);
          view = driver;
        }
      }

      // Create a day session on real chat intent (text) OR on a scan (Task 162:
      // the user wants a watchable session to follow up in alongside the live
      // scan workflow). A bare open just views an existing bound session and
      // never mints an empty one.
      if (!driver && (opts.text?.trim() || opts.scan || opts.logTime)) {
        driver = await createDaySessionOnce(date, async () => {
          const start = {
            agentType: "assistant",
            thinkingLevel,
            credentialProfileId,
            title: daySessionTitle(date),
          } as const;
          // Chat runs in-process on the Claude SDK with the assistant persona
          // so it gets the Google Calendar/Drive/Gmail and Tasks tools.
          if (useClaudeSdk)
            return createSession({ harness: "claude-sdk", modelId, ...start });
          const model =
            (await piModelForAccount(credentialProfileId, provider, modelId)) ??
            undefined;
          return createSession({ harness: "pi", model, ...start });
        });
      }

      if (driver && !view) view = driver;
      if (view) {
        this.viewIfCurrent(ticket, view);
        sessionStore.markRead(view.key, Date.now());
        await hub.broadcastSessions();
      }

      if (opts.scan) {
        // Deterministic collection + session-driven synthesis, with live step
        // progress broadcast to the day panel. The day session itself produces
        // the report (durable + watchable); committed state read via day-state.
        void this.runDayScanWithProgress(date, driver ?? null);
      } else if (driver && opts.logTime) {
        // Seed the (preferably existing) day session with the user's OWN work so
        // time-logging is grounded in what they did — not inbound/attention items.
        const digest = await buildDaySynthesisDigest(
          new KnowledgeBaseStore(),
          date,
        );
        await promptRuntimeSession(driver, renderLogMyTimePrompt(digest));
      } else if (driver && opts.text?.trim()) {
        await promptRuntimeSession(driver, opts.text);
      }
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to open the calendar day session: ${errorText(err)}`,
      });
    }
  }

  /**
   * Run one day scan and broadcast live step progress (Task 162). Collection is
   * deterministic and commits atomically. Synthesis is FOLDED into the day chat
   * session: when a day session is bound, the session itself is the synthesizer —
   * its visible Markdown briefing turn (grounded in the committed digest) becomes
   * the durable day report (written as the `day-synthesis` actor), so the user
   * watches one session do the work and can follow up in it. Without a session
   * (headless), it falls back to the structured one-shot synthesis; the session
   * path also falls back to it if the turn yields no text (report never empty).
   */
  private async runDayScanWithProgress(
    date: string,
    driver: LiveSession | null,
  ): Promise<void> {
    beginDayScanProgress(date, driver?.sessionId ?? null);
    const store = new KnowledgeBaseStore();
    try {
      const result = await runDayCollection(date, {
        onProgress: (ev) => {
          if (ev.kind === "collect") {
            reportDayScanStep(
              date,
              "collect",
              ev.done >= ev.total ? "done" : "running",
              `${ev.done}/${ev.total} sources`,
            );
          } else if (ev.kind === "minutes") {
            const detail =
              ev.state === "done" && ev.processed !== undefined
                ? `${ev.processed} processed`
                : undefined;
            reportDayScanStep(
              date,
              "minutes",
              ev.state === "done" ? "done" : "running",
              detail,
            );
          }
        },
      });
      if (!result.commit) {
        // No committed run. A freshly-bound session must still get a turn so it
        // persists (an unprompted session is a non-resumable ghost).
        if (driver)
          await promptRuntimeSession(
            driver,
            `I ran a day scan for ${date} but it produced no committed report. Tell me it did not complete and offer to re-run it or help another way.`,
          ).catch(() => {});
        endDayScanProgress(date);
        return;
      }
      reportDayScanStep(date, "synthesize", "running");
      let synthesized = false;
      if (driver) {
        // The visible session IS the synthesizer (single pass).
        const digest = await buildDaySynthesisDigest(store, date);
        const briefing = await promptRuntimeSessionAndCaptureText(
          driver,
          renderDayBriefingPrompt(digest),
        );
        if (briefing && briefing.trim()) {
          await writeDayBriefingNarrative(store, date, briefing);
          reportDayScanStep(date, "synthesize", "done");
          synthesized = true;
        }
      }
      if (!synthesized) {
        // Headless, or the session produced no text: structured one-shot so the
        // report is never left empty (also keeps threads/task-proposals).
        const synth = await runDaySynthesis(date);
        if (!synth.ok)
          console.error(
            `[calendar-day-scan] synthesis rejected for ${date}:`,
            synth.errors.join("; "),
          );
        reportDayScanStep(
          date,
          "synthesize",
          synth.ok ? "done" : "failed",
          synth.ok ? undefined : synth.errors[0],
        );
      }
      endDayScanProgress(date);
    } catch (err) {
      console.error(
        "[calendar-day-scan] server-side scan failed:",
        errorText(err),
      );
      endDayScanProgress(date, { error: errorText(err) });
    }
  }

  /** Narrow a resolved driver to one that can be prompted through the runtime. */
  private asRuntimePromptDriver(
    view: HarnessDriver | undefined,
  ): LiveSession | undefined {
    return isLiveSession(view) ? view : undefined;
  }

  private async onNewSession(
    agentType: AgentType,
    selectedModel?: { provider: string; id: string },
    selectedThinkingLevel?: ThinkingLevel,
    mode?: SessionMode,
    worktreeId?: string,
  ): Promise<void> {
    // newSession is the pi bootstrap only. Claude harnesses are created on
    // first prompt via harnessSend, never here.
    const kind = agentType;
    if (!this.guardKind(kind)) return;
    // Carry the current model/thinking level into the fresh session (pi only),
    // unless the client is explicitly creating a fresh runtime with a picked
    // model. That keeps model selection scoped to the new session instead of
    // briefly mutating whichever older session is still active while routing
    // catches up.
    const carried = this.viewedModelSelection();
    let thinkingLevel = carried.thinkingLevel;
    const credentialProfileId =
      sessionStore.get(this.viewing?.sessionId ?? "")?.credentialProfileId ??
      defaultOpenAiProfileId();
    // Committed to viewing the new session: intent order is this arrival,
    // claimed before the FIRST await (the model lookup and the worktree
    // resolution included), never after one.
    const ticket = this.claimViewRequest();
    let model = selectedModel
      ? undefined
      : await this.resolveViewedModel(carried);
    if (selectedModel) {
      const found = await piModelForAccount(
        credentialProfileId,
        selectedModel.provider,
        selectedModel.id,
      );
      if (!found) {
        this.send({
          type: "error",
          message: `Model ${selectedModel.provider}/${selectedModel.id} is not available.`,
        });
        return;
      }
      model = found;
      thinkingLevel = selectedThinkingLevel;
    }
    const worktree = await this.resolveWorktreeContext(worktreeId);
    if (worktree === undefined) return;
    if (!this.guardDeveloperWorktree(agentType, worktree)) return;
    // view() attaches the runtime transport, which sends the atomic native
    // snapshot (state + empty timeline + context) for the fresh session.
    const live = await createSession({
      harness: "pi",
      agentType: kind,
      model,
      thinkingLevel,
      mode,
      ...(worktree
        ? { worktree: { id: worktree.id, path: worktree.path } }
        : {}),
      credentialProfileId,
    });
    if (worktree)
      projectStore.setSessionProject(live.sessionId, worktree.projectId);
    if (this.viewIfCurrent(ticket, live) && worktree)
      this.send({
        type: "contextInfo",
        sessionId: live.sessionId,
        info: live.contextInfo(),
      });
    await hub.broadcastSessions();
  }

  /**
   * Developer sessions must run in a worktree (the main checkout counts): with
   * no `in_worktree` edge, `sessionCwd` would silently fall back to the app CWD
   * — the server's home directory in production. Workshop stays exempt: running
   * in the app CWD is its purpose, and it is dev-only. Returns false (after
   * reporting) when session creation must be rejected.
   */
  private guardDeveloperWorktree(
    agentType: AgentType,
    worktree: { id: string } | null,
  ): boolean {
    if (agentType !== "developer" || worktree) return true;
    this.send({
      type: "error",
      message:
        "Developer sessions run in a worktree — pick a worktree and try again.",
    });
    return false;
  }

  /**
   * The resume half of {@link guardDeveloperWorktree} (Task 321): a session
   * whose `in_worktree` worktree was REMOVED would resume in the app CWD — a
   * different repository than every earlier turn in its transcript ran against.
   * Creating such a session is already rejected; running one must be too.
   *
   * Refuses every run-starting path (prompt, host slash command) until the user
   * acknowledges it from the session view's banner. Viewing/loading such a
   * session stays allowed on purpose: the banner that offers the
   * acknowledgement lives there, and reading a transcript starts no turn.
   */
  private guardMissingWorktree(sessionId: string): boolean {
    let missing = false;
    try {
      missing = sessionWorktreeMissing(sessionId);
    } catch (err) {
      console.warn("Failed to check session worktree:", errorText(err));
    }
    if (!missing) return true;
    this.send({
      type: "error",
      message: `${WORKTREE_MISSING_BLOCKED_REASON} Acknowledge the banner to run it there anyway.`,
    });
    return false;
  }

  /**
   * Take a spawned peer over, or hand it back to its coordinator, on the
   * user's explicit word (`spawnOwnership.ts`). Every refusal — a session the
   * user cannot act on, one with no spawn edge, any store failure, including
   * the first read — is an error targeted at the session, so the browser
   * recovers its optimistic change; a request that changes nothing broadcasts
   * nothing. It changes metadata only and never starts the agent, so the
   * harness/persona availability guard of run-starting commands does not
   * apply: a disabled harness must not stop the user taking a peer over.
   */
  private async onSetSpawnOwnership(
    id: string,
    ownership: SettableSpawnOwnership,
  ): Promise<void> {
    const target: MessageTarget = { type: "session", id };
    let result: SpawnOwnershipResult;
    try {
      result = setSpawnOwnership(id, ownership);
    } catch (err) {
      console.warn(`[spawn] failed to set ownership of ${id}:`, errorText(err));
      this.send({
        type: "error",
        message: "Could not change who runs this session. Try again.",
        target,
      });
      return;
    }
    if (result !== "changed" && result !== "unchanged") {
      this.send({
        type: "error",
        message:
          result === "unavailable"
            ? "That session is not available."
            : result === "not-spawned"
              ? "Only a spawned session has an owner to change."
              : "Its coordinator was deleted, so there is no one to hand it back to.",
        target,
      });
      return;
    }
    if (result === "unchanged") return;
    await hub.broadcastSessions();
  }

  /**
   * The user accepted running a session in the app CWD after its worktree
   * disappeared. Re-broadcast the session state and list so the banner clears
   * and `worktreeMissing` drops everywhere, not just in this browser.
   */
  private async onAcknowledgeMissingWorktree(id: string): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (ref && !this.guardSessionRef(ref)) return;
    if (!acknowledgeMissingSessionWorktree(id)) return; // nothing to acknowledge
    if (this.viewing?.sessionId === id) this.viewing.broadcastState();
    await hub.broadcastSessions();
  }

  /**
   * Resolve an optional client-supplied worktree id for session creation.
   * Returns `null` when no worktree was requested, the active row when it is
   * usable, and `undefined` (after reporting) when it is unknown or gone.
   */
  private async resolveWorktreeContext(
    worktreeId?: string,
  ): Promise<
    { id: string; path: string; projectId: string } | null | undefined
  > {
    const id = worktreeId?.trim();
    if (!id) return null;
    // resolveWorktreeRow canonicalizes a `main:<projectId>` id AND proves the
    // project actually resolves to a git checkout (no phantom mains); it exact-
    // matches spawned rows. row.id is therefore the canonical edge target.
    const row = await resolveWorktreeRow(id);
    if (!row || row.status !== "active" || !existsSync(row.path)) {
      this.send({
        type: "error",
        message: "That worktree is no longer available.",
      });
      return undefined;
    }
    // Main runs in the sync-resolved checkout path (matches reopen cwd
    // resolution in sessionCwd); spawned worktrees run in the worktree folder.
    const path = isMainWorktreeId(row.id)
      ? mainCheckoutPathForProject(row.projectId)
      : row.path;
    if (!path || !existsSync(path)) {
      this.send({
        type: "error",
        message: "That worktree is no longer available.",
      });
      return undefined;
    }
    return { id: row.id, path, projectId: row.projectId };
  }

  /**
   * Provision the worktree a first send staged with "+ New worktree", BEFORE the
   * session is created: a session's cwd is fixed at construction in both
   * harnesses, so the checkout has to exist first. Returns the same shape as
   * {@link resolveWorktreeContext} plus the card the session records as its
   * genesis entry — `null` when nothing was requested, `undefined` (after
   * reporting the blocker) when provisioning failed, in which case the caller
   * creates no session and runs no turn.
   *
   * The naming agent gets the best context this app has: the user's actual first
   * prompt AND the staged Task. A Task also puts its primary Jira key, or its
   * internal id as fallback, in front of the branch name.
   */
  private async provisionFirstSendWorktree(msg: {
    createWorktreeInProjectId?: string;
    text: string;
    attachTaskId?: string;
    clientRequestId?: string;
  }): Promise<
    | {
        worktree: { id: string; path: string; projectId: string };
        provision: WorktreeProvisionDisplay;
      }
    | null
    | undefined
  > {
    const projectId = msg.createWorktreeInProjectId?.trim();
    if (!projectId) return null;
    const taskId = msg.attachTaskId?.trim() || undefined;
    const report = (provision: WorktreeProvisionDisplay) => {
      if (msg.clientRequestId)
        this.send({
          type: "worktreeProvision",
          clientRequestId: msg.clientRequestId,
          provision,
        });
      return provision;
    };
    const base: WorktreeProvisionDisplay = {
      state: "naming",
      projectId,
      ...(taskId ? { taskId } : {}),
    };
    try {
      // `createWorktree` checks the project too; this one runs FIRST so a
      // hopeless request fails before the naming agent, instead of flashing a
      // naming phase the user cannot act on. Keep it.
      if (!getProject(projectId))
        throw new Error(`Unknown project: ${projectId}`);
      report(base);
      // Naming never blocks creation (worktrees/CLAUDE.md): generateWorktreeSuffix
      // falls back to a timestamp suffix on every failure path.
      const proposed = await generateWorktreeSuffix(
        this.worktreeNamingContext(taskId, msg.text),
        getSettings().worktrees.namingAgent,
      );
      const task = taskId ? readTask(taskId) : undefined;
      const name = taskId
        ? taskWorktreeName(task ?? { id: taskId }, proposed)
        : proposed;
      report({ ...base, state: "creating", branch: name });
      const record = await createWorktree({
        projectId,
        name,
        ...(taskId !== undefined ? { taskId } : {}),
        // The submodule clone is network-bound and can take minutes; report it
        // rather than leaving "creating…" on screen for the whole checkout.
        onSubmodules: () =>
          void report({ ...base, state: "submodules", branch: name }),
      });
      const provision = report({
        ...base,
        state: "created",
        branch: record.branch,
        baseBranch: record.baseBranch,
        worktreeId: record.id,
      });
      return {
        worktree: {
          id: record.id,
          path: record.path,
          projectId: record.projectId,
        },
        provision,
      };
    } catch (err) {
      report({ ...base, state: "failed", error: errorText(err) });
      // The card carries the blocker, but only a send that asked to be tracked
      // gets one. Without a clientRequestId this path would otherwise end in
      // silence — no session, no turn, no message — unlike every other early
      // return in the send handlers.
      if (!msg.clientRequestId)
        this.send({
          type: "error",
          message: `Failed to create the worktree: ${errorText(err)}`,
        });
      return undefined;
    }
  }

  /**
   * Free-text context for the worktree naming agent, shared by the dialog's
   * `proposeWorktreeName` and the first-send provisioning path so both name from
   * the same evidence: the caller's text, the staged Task's title + body, and
   * the project name as the last resort.
   */
  private worktreeNamingContext(
    taskId?: string,
    context?: string,
    projectId?: string,
  ): string {
    const parts: string[] = [];
    if (context?.trim()) parts.push(context.trim());
    if (taskId) {
      const task = readTask(taskId);
      if (task)
        parts.push(
          `Task: ${task.title}`,
          task.description?.slice(0, 2000) ?? "",
        );
    }
    if (!parts.length && projectId) {
      const project = getProject(projectId);
      if (project) parts.push(`Project: ${project.name}`);
    }
    return parts.filter(Boolean).join("\n");
  }

  /**
   * Load (view) a session addressed by OUR session id only. The metadata-backed
   * {@link hub.acquireById} reopens/acquires the right backing (pi reopen from
   * its canonical id-derived path, or Claude SDK) — view-if-exists, so a
   * brand-new optimistic id with no record simply no-ops (the client keeps its
   * optimistic placeholder until the first prompt creates it via harnessSend).
   */
  private async onLoadArchivedSessions(): Promise<void> {
    this.archivedSessionsLoaded = true;
    this.send({
      type: "sessions",
      sessions: await hub.listSessions({ includeArchived: true }),
      archivedSessionCount: await hub.archivedSessionCount(),
      archivedSessionsLoaded: true,
    });
  }

  private async onLoadSession(
    id: string,
    timelineCache?: TimelineCacheDescriptor,
  ): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (ref && !this.guardSessionRef(ref)) return;
    this.claimViewRequest(id);
    // SYNCHRONOUS: reading a session needs its log and its metadata row, not
    // its harness (`viewSession.ts`). Nothing is awaited between the claim and
    // the attach, so no newer navigation can be overtaken here — and the reader
    // waits for storage rather than for a provider transcript to be parsed.
    const view = hub.viewById(id);
    if (!view) {
      // An optimistic/unknown id has nothing to view yet. A record that is
      // there but cannot be read says so, on that session.
      const unreadable = this.unopenableSession(id, ref);
      if (unreadable) this.send(unreadable);
      return;
    }
    // view() attaches the runtime transport, which sends one atomic snapshot
    // (state + history + context) so the client swaps in the whole session at once.
    this.view(view, timelineCache);
    // Viewing it marks it read only when there is actually an unread response to
    // clear, and only once the user has STAYED here (see `armReadDwell`). Avoid
    // rebroadcasting the whole session list on ordinary navigation.
    this.armReadDwell(view);
    await this.deliverPendingAgentRelays(view.sessionId);
  }

  /**
   * Open the server-owned singleton Personal Assistant: resolve (creating if
   * needed) its session, view it, then tell the client to switch to it. Mirrors
   * {@link onStartTaskRole} — the view() snapshot carries the timeline while the
   * `permanentAssistantOpened` message carries state/sessions and drives client
   * navigation, so the address bar follows the switch instead of reloading the
   * previously-viewed session.
   */
  private async onOpenPermanentAssistant(): Promise<void> {
    const ticket = this.claimViewRequest();
    // Reading the singleton is a read: when it already exists as a stored
    // Personal Assistant session, show it from storage instead of waiting for
    // its harness to open (`viewSession.ts`). Only creation and legacy-binding
    // repair take the slow path.
    const viewableId = permanentAssistantViewableId();
    const view = viewableId
      ? hub.viewById(viewableId)
      : await hub.acquireById(await permanentAssistantSessionId());
    if (!this.viewRequestIsCurrent(ticket)) return;
    if (!view) {
      this.send({
        type: "error",
        message: "The Personal Assistant session is not available.",
      });
      return;
    }
    // Everything the route message needs is gathered BEFORE attaching, so the
    // snapshot and the message that moves the client to it leave back to back
    // with no await between them: a competing load completing in such a gap
    // would put its own snapshot between the two, and the client would wear
    // this session's state over that session's timeline.
    const sessions = await hub.listSessions();
    if (!this.viewRequestIsCurrent(ticket)) return;
    this.view(view);
    this.send({
      type: "permanentAssistantOpened",
      state: view.state(),
      sessions,
      contextInfo: view.contextInfo(),
    });
  }

  private async deliverPendingAgentRelays(sessionId: string): Promise<void> {
    // Draining is durable/self-broadcasting; delivery no longer emits a notice.
    // It takes an ID, not a driver: a session opened for READING has none, and
    // the drain acquires one itself only when something is actually queued.
    try {
      await drainRecipient(sessionId);
    } catch (err) {
      console.warn(
        "[peer-prompt] drain on session open failed:",
        errorText(err),
      );
    }
  }

  private async onCreateDraftSession(
    agentType: AgentType,
    draftText: string,
    notice?: string,
  ): Promise<void> {
    // Draft sessions are always pi: the pi kind IS the persona.
    const kind: AgentType = agentType;
    if (!this.guardKind(kind)) return;
    // Drafts carry no worktree, so a developer draft would run in the app CWD.
    if (!this.guardDeveloperWorktree(agentType, null)) return;
    const text = draftText.trim();
    if (!text) {
      this.send({ type: "error", message: "Draft prompt cannot be empty." });
      return;
    }
    // Committed to viewing the draft: intent order is this arrival, not the
    // moment creation completes.
    const ticket = this.claimViewRequest();
    try {
      const carried = this.viewedModelSelection();
      const thinkingLevel = carried.thinkingLevel;
      const credentialProfileId = this.viewing
        ? (sessionStore.get(this.viewing.sessionId)?.credentialProfileId ??
          defaultOpenAiProfileId())
        : defaultOpenAiProfileId();
      const model = await this.resolveViewedModel(carried);
      const live = await createSession({
        harness: "pi",
        agentType: kind,
        model,
        thinkingLevel,
        credentialProfileId,
        purpose: "draft",
      });
      // Listed before attaching: snapshot and route message leave together
      // (see `onOpenPermanentAssistant`). A newer navigation meanwhile keeps
      // the draft unviewed: it exists, and the client is where it went.
      const sessions = await hub.listSessions();
      if (!this.viewIfCurrent(ticket, live)) return;
      this.send({
        type: "draftSession",
        state: live.state(),
        sessions,
        contextInfo: live.contextInfo(),
        draftText: text,
        notice:
          notice?.trim() ||
          "Draft session created — review model/thinking and edit the prompt before sending.",
      });
      if (sessionStore.markRead(live.key, Date.now()))
        await hub.broadcastSessions();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to create draft session: ${errorText(err)}`,
      });
    }
  }

  private async onDeleteSession(id: string): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (!ref) return; // unknown/optimistic id — nothing persisted to delete.
    // Deleting the viewed session is a leave, but one that claims nothing until
    // the delete is known to happen (`hub.clearSessionViews` below): a blocked
    // or no-op delete views nothing, and a load acquiring meanwhile — arrived
    // before or during the blocker check — is the newer intent either way.
    // Deleting a session with live background work would leave a real process
    // or retained query running with no owner to show or stop it, so this one
    // blocker is checked before any destructive step. It is the SAME predicate
    // settlement uses, and unlike settlement's other reasons it is not a
    // judgement about tidiness: the user is told to stop the work first.
    const projected = (await hub.listSessions({ includeArchived: true })).find(
      (item) => item.id === id,
    );
    const backgroundBlocked = backgroundWorkBlockedReason(
      projected?.backgroundActivity,
    );
    const refuseForBackgroundWork = async (reason: string): Promise<void> => {
      await hub.broadcastSessionUpdated(id);
      this.send({
        type: "error",
        message: `Failed to delete session: ${reason} Stop it first.`,
        target: { type: "session", id },
      });
    };
    if (backgroundBlocked) return refuseForBackgroundWork(backgroundBlocked);
    // SECURITY: never `rm` a client-supplied path verbatim. The session file is
    // derived server-side from the id's canonical path — a WS client only
    // supplies the id. Resolved before the delete below, from which on nothing
    // awaits until every viewer has left and the harness is evicted.
    const resolved =
      ref.file ??
      (await hub.listSessions()).find((item) => item.id === id)?.file;
    // The delete itself is ONE store transaction, run before any other
    // destructive step: it rechecks live work (closing the window the
    // projection above was read in), marks the session deleted and tombstones
    // its background history, which broadcasts a delete for exactly those rows.
    // Once it commits no work can be admitted for the owner. If any of it fails
    // none of it happened, so the delete stops here and says so.
    try {
      backgroundWorkStore.deleteOwnerSession(id);
    } catch (err) {
      if (err instanceof BackgroundWorkValidationError)
        return refuseForBackgroundWork("its background work is still running.");
      await hub.broadcastSessionUpdated(id);
      this.send({
        type: "error",
        message: `Failed to delete session: ${errorText(err)}`,
        target: { type: "session", id },
      });
      return;
    }
    // A deleted session owes no Plan clearing line to anyone.
    forgetPlanHintState(id);
    // Drop every Task reference to this session so nothing links to (or tries to
    // resume) a session that no longer exists.
    try {
      unlinkSessionEverywhere(id);
    } catch (err) {
      console.warn(
        "[delete] failed to unlink session from tasks:",
        err instanceof Error ? err.message : String(err),
      );
    }
    // Every connection viewing or loading the session leaves it NOW, in the
    // same synchronous run as the tombstone above and the eviction below: the driver they
    // share is about to be disposed, and a viewer left on it would keep routing
    // commands into it. This connection first (registered or not), then every
    // registered one — a second pass over this one is a no-op. A load of it
    // still acquiring anywhere is refused after this (`onLoadSession`,
    // `piStore.acquireExisting`).
    this.sessionRemoved(id);
    hub.clearSessionViews(id);
    // The engine disposes its session (aborting any in-flight turn) before its
    // first await, still in this synchronous run. What is awaited, after the
    // cleanup below, is pi's transcript removal; Claude deletes its record at
    // once and its native transcript in the background.
    const removal = harnessRegistry.remove({
      harness: ref.harness,
      id,
      agentType: ref.kind,
      file: resolved,
    });
    // The cleanup below is keyed by session id and runs whichever engine held
    // the session. The metadata row is already tombstoned above, so a delete
    // cannot be retried: each step is best-effort, and one that fails (an
    // artifact folder that cannot be removed) leaves the rest to run.
    for (const cleanup of [
      clearPendingQuestion,
      deleteSessionPromptQueue,
      deleteToolGroupSessionData,
      (sessionId: string) => projectStore.forgetSessionProject(sessionId),
    ]) {
      try {
        cleanup(id);
      } catch (err) {
        console.warn("[delete] session cleanup failed:", errorText(err));
      }
    }
    await removal;
    await hub.broadcastSessions();
  }

  private async onArchiveSession(id: string, archived: boolean): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (!ref) return;
    const key = id;
    sessionStore.setArchived(key, archived);
    // Restoring from the archive brings the session back into the WORKING
    // SET, not onto the Settled shelf: a settled row's age is what automatic
    // retention (`sessionRetention.ts`) archives on, so a restore that left
    // the old settlement in place would be undone by the next hourly sweep.
    if (!archived) sessionStore.setSettled(key, false);
    // Archiving the viewed session removes that view — and supersedes a load
    // of it this connection still has in flight, which would otherwise attach
    // the archived session once it completes — but must not manufacture a
    // prompt-less replacement. `/sessions/create` is client-staged and the
    // first real send creates its durable session. Another connection viewing
    // the session keeps it: an archived session can be viewed on purpose.
    if (archived) this.clearSessionView(id, "archived");
    await hub.broadcastSessions();
  }

  /**
   * The predicate the supervisor itself was configured with (`index.ts`), read
   * here only to EXPLAIN a deferred host close — never to decide one. Both
   * sides share the one turn tracker, so they cannot disagree about which turn
   * belongs to the user.
   */
  private humanStopDeps() {
    return backgroundWorkHumanStopDeps((ownerSessionId) =>
      backgroundCompletionTurns.protectsOrdinaryTurn(
        ownerSessionId,
        Boolean(hub.getLiveById(ownerSessionId)?.isRunning),
      ),
    );
  }

  /** Human Stop for one background item; the row itself answers as an event. */
  private async onStopBackgroundWork(
    itemId: string,
    requestId: string,
  ): Promise<void> {
    const answer = await stopBackgroundWorkForHuman(
      itemId,
      typeof requestId === "string" ? requestId : "",
      this.humanStopDeps(),
    );
    this.send({ type: "backgroundWorkStopAnswer", ...answer });
  }

  /** Human Stop-all for one owning session, including its retained host. */
  private async onStopAllBackgroundWork(
    ownerSessionId: string,
    requestId: string,
  ): Promise<void> {
    const answer = await stopAllBackgroundWorkForHuman(
      ownerSessionId,
      typeof requestId === "string" ? requestId : "",
      this.humanStopDeps(),
    );
    this.send({ type: "backgroundWorkStopAnswer", ...answer });
  }

  /**
   * Settle a session out of the Sessions inbox working set (or bring it back).
   * The invariants live HERE as well as in the browser: work that is running,
   * queued, or blocked on a human decision is never "done enough to leave", and
   * an optimistic client must be corrected rather than trusted. Unsettling is
   * always allowed — it only ever adds work back to the visible set.
   *
   * Settling acknowledges the attention revision the CLICKED ROW carried
   * (`throughRevision`, required by the validator), never the current one: a
   * completion or failure that landed between the render and the click is a
   * newer event the user has not seen, and this command must leave it visible
   * instead of hiding it. Only a server-side settlement may omit the revision.
   *
   * One such settlement rides on this command: the peers this session still
   * COORDINATES leave the inbox with it, through their current revisions,
   * exactly as a Workflow Run's roles leave with the run — the coordinator is
   * the attention owner, its peers are evidence. Membership, refusal and the
   * all-or-nothing write are `settleSessionWithPeers`'s; this handler only
   * turns its answer into the wire's error or silence.
   */
  private async onSettleSession(
    id: string,
    settled: boolean,
    throughRevision: number,
  ): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (!ref) {
      this.send({
        type: "error",
        message: "Failed to settle session: session not found.",
        target: { type: "session", id },
      });
      return;
    }
    if (!settled) {
      // A store write that changes nothing (tombstoned row, DB trouble) must
      // not read as success: the client is holding an optimistic row that only
      // this error will roll back.
      if (!sessionStore.setSettled(id, false)) {
        this.send({
          type: "error",
          message: "Failed to settle session: it could not be updated.",
          target: { type: "session", id },
        });
        return;
      }
      await hub.broadcastSessions();
      return;
    }
    const answer = await settleSessionWithPeers(id, throughRevision);
    if ("blocked" in answer) {
      // Re-send the authoritative row first, so a stale client cannot stay on
      // a false settled state after its optimistic update is rejected.
      await hub.broadcastSessionUpdated(id);
      this.send({
        type: "error",
        message: `Failed to settle session: ${answer.blocked}`,
        target: { type: "session", id },
      });
      return;
    }
    if (!answer.written) {
      this.send({
        type: "error",
        message: "Failed to settle session: it could not be updated.",
        target: { type: "session", id },
      });
    }
  }

  private async onForkSession(
    id: string,
    entryId: string,
    position: "before" | "at",
  ): Promise<void> {
    // `entryId` is OUR log entry id — the only anchor a client ever holds. Each
    // harness branches at its own native id, so it is translated below.
    const ref = this.resolveSessionRef(id);
    if (!ref) {
      this.send({
        type: "error",
        message: "Cannot fork: session is not available.",
        target: { type: "session", id },
      });
      return;
    }
    const { harness, kind, file } = ref;
    if (!this.guardSessionRef(ref)) return;
    // Forking creates a new session with the parent's persona. Existing
    // server-owned sessions may be viewed, but only their dedicated runtime
    // paths may create another one.
    if (!this.guardKind(kind)) return;
    if (!file) {
      this.send({
        type: "error",
        message: "Cannot fork: this session type cannot be forked.",
        target: { type: "session", id },
      });
      return;
    }
    const anchors = sessionRuntime.forkAnchors(id, entryId);
    if (!anchors.entryFound) {
      this.send({
        type: "error",
        message: "Cannot fork: selected message is no longer available.",
        target: { type: "session", id },
      });
      return;
    }
    const prepared = prepareFork(harness, {
      id,
      kind,
      file,
      entryId,
      position,
      anchors,
    });
    if ("refusal" in prepared) {
      this.send({
        type: "error",
        message: prepared.refusal,
        target: { type: "session", id },
      });
      return;
    }
    // Committed to viewing the fork: intent order is this arrival.
    const ticket = this.claimViewRequest();
    try {
      // The editable prompt always comes from OUR clean log. A pi native prompt
      // also contains model-only memory and structured context, so reading its
      // text would expose that enrichment in the composer.
      const selectedText =
        position === "before"
          ? sessionRuntime.entryText(id, entryId)
          : undefined;
      const live = await prepared.fork();
      // Listed before attaching: snapshot and route message leave together
      // (see `onOpenPermanentAssistant`). A newer navigation meanwhile keeps
      // the fork unviewed: it exists, and the client is where it went.
      const sessions = await hub.listSessions();
      if (!this.viewIfCurrent(ticket, live)) return;
      const state = live.state();
      this.send({
        type: "forkedSession",
        state,
        sessions,
        contextInfo: live.contextInfo(),
        ...(selectedText ? { selectedText } : {}),
      });
      if (sessionStore.markRead(live.key, Date.now()))
        await hub.broadcastSessions();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to fork session: ${errorText(err)}`,
        target: { type: "session", id },
      });
    }
  }

  private async onRenameSession(id: string, title: string): Promise<void> {
    const ref = this.resolveSessionRef(id);
    if (!ref) {
      this.send({
        type: "error",
        message: "Failed to rename session: session not found.",
        target: { type: "session", id },
      });
      return;
    }
    if (!this.guardSessionRef(ref)) return;
    try {
      await harnessRegistry.rename(
        { harness: ref.harness, id, agentType: ref.kind, file: ref.file },
        title,
      );
      await hub.broadcastSessions();
    } catch (err) {
      this.send({
        type: "error",
        message: `Failed to rename session: ${errorText(err)}`,
        target: { type: "session", id },
      });
    }
  }

  /**
   * Resolve OUR session id to the `{harness, kind, file?}` ref used by the
   * per-kind handlers. The metadata store is the id-only routing source; its
   * agentType is the kind. For pi, the log path is derived from the canonical
   * id for delete/fork operations. Falls back to a currently-resident live
   * driver so a not-yet-persisted session (e.g. a pi bootstrap before its first
   * prompt) still resolves.
   */
  private resolveSessionRef(
    id: string,
  ): { harness: Harness; kind: AgentType; file?: string } | undefined {
    const record = sessionStore.get(id);
    if (record) {
      const kind: AgentType = record.agentType;
      return {
        harness: record.harness,
        kind,
        file: sessionRefFile(record.harness, id),
      };
    }
    const live = hub.getLiveById(id);
    if (live)
      return {
        harness: live.harness,
        kind: live.kind,
        ...(live.sessionFile !== undefined ? { file: live.sessionFile } : {}),
      };
    // A session an engine has on disk without a row: a Claude record that
    // predates the id registry or lost its metadata, or a pi transcript whose
    // row was rejected before the DB accepted developer sessions. Its engine
    // can prove it exists, so load/delete/archive must not silently no-op.
    const rowless = harnessRegistry.rowlessRef(id);
    return rowless
      ? {
          harness: rowless.harness,
          kind: rowless.agentType,
          file: rowless.file,
        }
      : undefined;
  }

  /**
   * The error for a session that resolved to a PRESENT Claude record but has
   * no view — so a deep link or `loadSession` to it never ends with neither a
   * view nor an error. The reason is the record's read error when it has one
   * (its metadata or its log), and otherwise that there is nothing to show it
   * from. Undefined for an id with no record (an optimistic one, or one
   * deleted), which has nothing to report. Never throws: one damaged session
   * must not fail a connection's `init`, only report itself.
   */
  private unopenableSession(
    id: string,
    ref: { harness: Harness } | undefined,
  ): Extract<ServerMessage, { type: "error" }> | undefined {
    if (!ref) return undefined;
    let reason: string | undefined;
    try {
      reason = harnessRegistry.unopenableReason(ref.harness, id);
      if (reason === undefined) return undefined;
    } catch (err) {
      reason = (err as Error).message;
    }
    return {
      type: "error",
      message: `This session cannot be opened: ${reason}`,
      target: { type: "session", id },
      sessionUnavailable: true,
    };
  }

  /** Refuse a kind that isn't available (e.g. Workshop in production). */
  private guardKind(kind: AgentType): boolean {
    if (isAgentAvailable(kind)) return true;
    this.send({
      type: "error",
      message: `The "${kind}" agent is not available.`,
    });
    return false;
  }

  /** Refuse loading a session whose persona is environment-gated. */
  private guardExistingKind(kind: AgentType): boolean {
    if (isAgentSessionAvailable(kind)) return true;
    this.send({
      type: "error",
      message: `The "${kind}" agent is not available.`,
    });
    return false;
  }

  /**
   * Guard a resolved session by its harness. A claude-sdk session is gated on the
   * Claude SDK setting (independent of the persona's dev-only flag — a claude-sdk
   * workshop session must stay loadable in prod); a pi session is gated on its
   * existing-session availability. Internal personas remain loadable even though
   * ordinary client creation rejects them.
   */
  private guardSessionRef(ref: { harness: Harness; kind: AgentType }): boolean {
    const refusal = existingSessionRefusal(ref.harness, ref.kind);
    if (!refusal) return true;
    this.send({ type: "error", message: refusal });
    return false;
  }

  /**
   * Mark the viewed session read once it has actually been OPEN for
   * `SESSION_READ_DWELL_MS` — the mail-client rule. Clearing "unread" on the
   * click itself re-sorted the Sessions inbox out from under the card the user
   * had just aimed at, and a session opened by mistake should still be waiting
   * afterwards. Viewing anything else (or closing the socket) disarms it, so
   * only a session you stayed in is read. Sending a prompt or answering is a
   * different matter and still marks read immediately, wherever it already did.
   */
  private armReadDwell(live: HarnessDriver): void {
    this.clearReadDwell();
    const sessionId = live.sessionId;
    const record = sessionStore.get(sessionId);
    // Nothing unread to clear: no timer, and no needless broadcast later.
    if (!record || record.updatedAt <= record.readAt) return;
    const key = live.key;
    const timer = setTimeout(() => {
      this.readDwell = undefined;
      if (this.disposed || this.viewing?.sessionId !== sessionId) return;
      void (async () => {
        if (sessionStore.markRead(key, Date.now()))
          await hub.broadcastSessionUpdated(sessionId);
      })();
    }, SESSION_READ_DWELL_MS);
    timer.unref?.();
    this.readDwell = { sessionId, timer };
  }

  private clearReadDwell(): void {
    if (this.readDwell) clearTimeout(this.readDwell.timer);
    this.readDwell = undefined;
  }

  /** A session is being deleted, by this connection or another (`hub.clearSessionViews`). */
  sessionRemoved(sessionId: string): void {
    this.clearSessionView(sessionId, "deleted");
  }

  /**
   * Leave a session that is being archived or deleted, without replacing it.
   * The client that asked navigates to the client-staged new-session surface
   * before sending its mutation, so creating another runtime here would strand
   * a zero-message row; any other client learns from `sessionViewCleared`.
   *
   * Leaving is an intent too — one that supersedes only claims for THIS
   * session, whether it is on show or still acquiring: the attach itself, a
   * reload of it (the client's snapshot fallback re-requests the viewed
   * session), or a cold load of it from elsewhere, any of which would
   * otherwise bring the session back once it completes. A newer claim for
   * anything else — a load of another session that arrived while the delete
   * or archive was in flight, a creation — keeps its claim: the detach still
   * happens (the session is gone) and that intent attaches when it completes.
   * Claiming over it would strand the client on its route with nothing
   * attached and nothing left to re-request it. A later, deliberate open of an
   * archived session is a new claim and attaches as ever.
   */
  private clearSessionView(
    sessionId: string,
    reason: "deleted" | "archived",
  ): void {
    const superseded = this.viewRequestTarget === sessionId;
    if (superseded) this.claimViewRequest();
    const shown = this.viewing?.sessionId === sessionId;
    if (!superseded && !shown) return;
    if (shown) {
      for (const threadId of this.heldSubagentThreads) {
        this.heldSubagentThreads.delete(threadId);
        hub.releaseSubagentRunTopic(threadId);
      }
      this.clearReadDwell();
      this.detachRuntimeView();
      this.viewing?.removeViewer(this);
      this.viewing = undefined;
    }
    // Told either way: a client whose route names a session it was only
    // still loading would otherwise wait for it forever.
    this.send({ type: "sessionViewCleared", sessionId, reason });
  }

  /**
   * The viewed session's DRIVER, opening its harness if it is only being
   * rendered from storage (`ViewSession`, `viewSession.ts`).
   *
   * This is the door every command that drives the viewed session goes through
   * — prompt, abort, model/thinking/mode change, fork, host slash command.
   * Reading a session deliberately does not open its harness (that open costs
   * seconds on a long transcript), so anything that needs one asks here, and
   * the answer re-attaches this view to the real driver before returning it.
   *
   * Undefined means the session cannot be driven at all: its record is gone, or
   * its backing could not be reopened. Callers must treat that as a refusal
   * rather than prompting something else.
   */
  private async ensureViewingDriver(): Promise<LiveSession | undefined> {
    const viewing = this.viewing;
    if (!viewing) return undefined;
    const ready = this.asRuntimePromptDriver(viewing);
    if (ready) return ready;
    return this.openHarnessFor(viewing.sessionId);
  }

  /**
   * Open `sessionId`'s harness, hand it to that session's RUNTIME, and upgrade
   * this connection's view to it if the reader is still there.
   *
   * The two halves are deliberately independent. The harness belongs to the
   * SESSION, so it is opened and bound whatever the reader does next; the view
   * upgrade belongs to this connection, so `upgradeViewingDriver` applies it
   * only while the storage-backed view of that same session is still on show.
   * What comes back is the driver for the session ASKED FOR — never whichever
   * session happens to be in view when the open finishes, which is how a prompt
   * typed into one session ended up running in another.
   */
  private async openHarnessFor(
    sessionId: string,
  ): Promise<LiveSession | undefined> {
    const live = await hub.acquireById(sessionId);
    const driver = live ? this.asRuntimePromptDriver(live) : undefined;
    // The RUNTIME session has to take the harness too, not just this view: the
    // transport drives abort/model/thinking through it, and one still bound to
    // the detached adapter refuses them all. Prompting reaches the same seam
    // through the prompt facade; every other command reaches it here.
    if (driver) ensureRuntimeSession(sessionRuntime, driver);
    if (live) this.upgradeViewingDriver(live);
    return driver;
  }

  /**
   * Run `act` against the VIEWED session — its transport controls and its
   * driver — opening its harness first when the view is storage-backed.
   *
   * The identity check and the use are ONE synchronous step, and that is the
   * whole point. Socket frames that arrive together are dispatched in the same
   * tick, so a `loadSession` queued behind this command runs while it is
   * suspended on ANY await, including an already-settled one: a handler that
   * checked, awaited, and then read `this.runtimeView` would apply an abort, a
   * model or thinking choice, a mode switch or a slash command to whatever
   * session the reader moved to. Nothing runs here unless the session this was
   * issued against is still the one on show.
   *
   * An acquisition that FAILS (a metadata row whose provider transcript is
   * gone) is a refusal too: the runtime is still bound to the detached adapter,
   * so half these commands would throw and the other half do nothing.
   */
  private async withViewedSession(
    act: (
      driver: HarnessDriver,
      view: RuntimeBackedView | undefined,
    ) => void | Promise<void>,
  ): Promise<void> {
    const viewing = this.viewing;
    if (!viewing) return;
    const sessionId = viewing.sessionId;
    if (!viewing.live && !(await this.openHarnessFor(sessionId))) return;
    const driver = this.viewing;
    if (!driver || driver.sessionId !== sessionId) return;
    await act(driver, this.runtimeView);
  }

  /**
   * Another owner opened the harness for the session this connection is showing
   * from storage. Re-attach so live state reaches this reader too.
   */
  sessionHarnessOpened(driver: HarnessDriver): void {
    this.upgradeViewingDriver(driver);
  }

  /**
   * Swap a storage-backed view onto the harness that has just been opened for
   * it, WITHOUT re-attaching the transport.
   *
   * The runtime session is the same object either way — opening the harness
   * rebinds its adapter, it does not replace it — so the transcript stream the
   * browser is reading stays live across the swap. Re-attaching would instead
   * re-send the whole window, which a reader who just pressed Enter would see
   * as their transcript being rebuilt under the prompt they are sending. Only
   * the engine-state viewer moves, and the client is told the state the real
   * driver reports (steering, model, context).
   */
  private upgradeViewingDriver(driver: HarnessDriver): void {
    const viewing = this.viewing;
    if (!viewing || viewing.live) return;
    if (viewing.sessionId !== driver.sessionId || this.disposed) return;
    if (this.engineStateViewer)
      this.engineStateViewer.live.removeViewer(this.engineStateViewer.viewer);
    this.engineStateViewer = undefined;
    this.viewing = driver;
    this.attachEngineStateViewer(driver);
    this.send({ type: "state", state: driver.state() });
    this.send({
      type: "contextInfo",
      sessionId: driver.sessionId,
      info: driver.contextInfo(),
    });
  }

  /** Detach from the previous session and attach to a new one (pi or Claude). */
  private view(
    live: HarnessDriver,
    timelineCache?: TimelineCacheDescriptor,
  ): void {
    // An attach IS the newest intent: a session created or forked and viewed
    // synchronously here supersedes any load still acquiring.
    this.claimViewRequest(live.sessionId);
    // Nothing attaches to a closed socket (see `dispose`).
    if (this.disposed) return;
    // A cache-bearing request for the already-viewed session intentionally
    // reattaches: it is also the client's full-snapshot fallback if local cache
    // reconstruction fails. Ordinary duplicate view requests stay no-ops.
    if (this.viewing === live && !timelineCache) return;
    // Run-detail authorization is tied to the currently viewed parent session;
    // navigation releases held child topics before the new view is attached.
    for (const threadId of this.heldSubagentThreads) {
      this.heldSubagentThreads.delete(threadId);
      hub.releaseSubagentRunTopic(threadId);
    }
    this.detachRuntimeView();
    this.viewing?.removeViewer(this);
    const runtimeView = this.attachRuntimeView(live, timelineCache);
    this.viewing = live;
    this.runtimeView = runtimeView;
    // Re-emit any approval cards for this session AFTER the atomic snapshot
    // (which carries only the durable timeline), so the store-driven cards
    // reappear on reload/navigation, not just on live broadcast.
    for (const approval of approvalsForSession(live.sessionId)) {
      this.send({
        type: "approvalUpdate",
        sessionId: live.sessionId,
        approval,
      });
    }
    // Always, even empty: the client keeps the last list it saw for this
    // session, and a revoke made while it looked elsewhere must replace it.
    this.send({
      type: "approvalGrants",
      sessionId: live.sessionId,
      grants: approvalGrantsForSession(live.sessionId),
    });
    // Same reasoning for pull-request cards: store-driven, so they must be
    // re-emitted after the atomic snapshot rather than assumed to be in it.
    for (const card of cardsForSession(live.sessionId)) {
      this.send({
        type: "pullRequestCardUpdate",
        sessionId: live.sessionId,
        card,
      });
    }
  }

  /**
   * Forward the engine's non-chat session envelopes to the client. The
   * RuntimeTransport owns the chat stream and run-state events, so without this
   * bridge engine metadata (`state`/`contextInfo`/`notice`) and store-backed
   * overlay updates (approval, peer-prompt cards) would be lost on the
   * runtime path. Viewed-chat run state remains on the runtime snapshot/event
   * stream.
   */
  private attachEngineStateViewer(live: HarnessDriver): void {
    const viewer: Viewer = {
      send: (m: ServerMessage) => {
        if (
          m.type === "state" ||
          m.type === "contextInfo" ||
          m.type === "notice" ||
          m.type === "approvalUpdate" ||
          m.type === "approvalGrants" ||
          m.type === "pullRequestCardUpdate" ||
          m.type === "peerPromptCardUpdate"
        )
          this.send(m);
      },
    };
    live.addViewer(viewer);
    this.engineStateViewer = { live, viewer };
  }

  /**
   * Build a runtime-backed view.
   *
   * A storage-backed view (`viewSession.ts`) attaches with NO driver: the
   * transport renders the durable log through the runtime's detached adapter,
   * and the first thing that needs the provider upgrades the view
   * ({@link ensureViewingDriver}).
   */
  private attachRuntimeView(
    live: HarnessDriver,
    timelineCache?: TimelineCacheDescriptor,
  ): RuntimeBackedView {
    const driver = this.asRuntimePromptDriver(live);
    const viewer = { send: (m: ServerMessage) => this.send(m) };
    this.attachEngineStateViewer(live);
    // Viewed-chat running state is runtime-owned and travels on the snapshot/event
    // stream, not on SessionState. The state shell remains pure session metadata.
    return attachRuntimeViewToTransport(
      sessionRuntime,
      live.id,
      driver,
      viewer,
      {
        // Resolved per call, not captured: a storage-backed view is upgraded to
        // its real driver in place (`upgradeViewingDriver`), and the transport
        // must then report what THAT driver says.
        buildState: () => this.viewSource(live).state(),
        buildContextInfo: () => this.viewSource(live).contextInfo(),
        ...(timelineCache !== undefined ? { timelineCache } : {}),
      },
    );
  }

  /** The driver currently backing `attached`'s session — itself until upgraded. */
  private viewSource(attached: HarnessDriver): HarnessDriver {
    return this.viewing?.sessionId === attached.sessionId
      ? this.viewing
      : attached;
  }

  private claimViewRequest(target?: string): number {
    this.viewRequestSeq += 1;
    this.viewRequestTarget = target;
    return this.viewRequestSeq;
  }

  /**
   * Attach `live` for the request holding `ticket` — unless a newer intent
   * has claimed since, in which case nothing attaches and the caller must not
   * send the route message that would move the client to it either.
   *
   * THE RULE for every handler that ends in a view: claim the ticket after its
   * synchronous validation and before its FIRST `await` — not before the
   * acquisition, not before this call — and never claim again on the way.
   * Any await ahead of the claim (a model lookup, a worktree resolution, a
   * prompt build) is a window in which a newer `loadSession` completes, after
   * which the older operation would claim a later ticket and take the view
   * back. `sessionViewRace.test.ts` pins that window for each class of path.
   */
  private viewIfCurrent(
    ticket: number,
    live: HarnessDriver,
    timelineCache?: TimelineCacheDescriptor,
  ): boolean {
    if (!this.viewRequestIsCurrent(ticket)) return false;
    this.view(live, timelineCache);
    return true;
  }

  private viewRequestIsCurrent(ticket: number): boolean {
    return ticket === this.viewRequestSeq;
  }

  private detachRuntimeView(): void {
    this.runtimeView?.detach();
    this.runtimeView = undefined;
    if (this.engineStateViewer) {
      this.engineStateViewer.live.removeViewer(this.engineStateViewer.viewer);
      this.engineStateViewer = undefined;
    }
  }

  /**
   * Model + thinking level a session created from this view should start with.
   *
   * Read off the resident session when one is open, and off the viewed
   * session's metadata row otherwise: a session opened for READING has no
   * harness to ask (`viewSession.ts`), and falling back to the app default
   * there would silently change which model the next new session runs on — a
   * regression the reader would only notice after the first turn. Only a pi
   * model is carried, since the new session runs on pi. Synchronous, so a
   * caller can read it before claiming its view; {@link resolveViewedModel}
   * turns it into a model handle afterwards.
   */
  private viewedModelSelection(): ViewedModelSelection {
    if (isLiveSession(this.viewing)) {
      const { model, thinkingLevel } = this.viewing.modelSelection();
      const account = this.viewing.credentialProfileId;
      return {
        ...(model && !isClaudeSdkModel(model)
          ? { model: { ...model, ...(account ? { account } : {}) } }
          : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      };
    }
    const meta = this.viewing
      ? sessionStore.get(this.viewing.sessionId)
      : undefined;
    return {
      ...(meta?.provider && meta.model
        ? {
            model: { provider: meta.provider, id: meta.model },
          }
        : {}),
      ...(meta?.thinkingLevel
        ? { thinkingLevel: meta.thinkingLevel as ThinkingLevel }
        : {}),
    };
  }

  /**
   * The model handle a carried selection names. A resident session's model
   * resolves on the account that session runs on, the registry its own handle
   * came from; a model that account no longer offers falls back to the
   * default, like a stored row's. A stored row's resolves as it always has.
   */
  private async resolveViewedModel(
    selection: ViewedModelSelection,
  ): Promise<ReturnType<typeof piModel>> {
    const model = selection.model;
    if (!model) return undefined;
    return model.account
      ? piModelForAccount(model.account, model.provider, model.id)
      : piModel(model.provider, model.id);
  }

  /* --------------------------------- viewer -------------------------------- */

  send(message: ServerMessage): void {
    if (this.disposed) return;
    // Stamp the in-flight mutation's id onto its failure, so the client recovers
    // that exact change rather than whichever one is oldest.
    const scope = mutationScope.getStore();
    if (
      message.type === "error" &&
      scope?.connection === this &&
      message.requestId === undefined
    ) {
      // Recording the FAILURE is independent of stamping it. An uncorrelated
      // command has no id to carry, but it still refused — and triage reads
      // this outcome, so skipping the flag here silently processed a Task on
      // the error path.
      scope.failed = true;
      if (scope.requestId !== undefined)
        message = { ...message, requestId: scope.requestId };
    }
    const wireMessage = publicServerMessage(message);
    // The only message that is dropped outright: a one-row update about a
    // session no list may show has nothing left to say.
    if (!wireMessage) return;
    if (this.ws.readyState === this.ws.OPEN)
      this.ws.send(JSON.stringify(wireMessage));
  }

  /** Socket closed: detach only. The hub keeps the run alive and may evict it later. */
  dispose(): void {
    this.disposed = true;
    // A load still acquiring for this socket must not attach once it is gone:
    // a ghost transport would project every later event for nobody, and its
    // viewer would keep a pi session from idling out and mark it read on
    // every update. `view()` refuses after disposal too, for any caller that
    // claimed no ticket.
    this.claimViewRequest();
    this.permanentAssistantOff?.();
    this.permanentAssistantOff = undefined;
    hub.unregister(this);
    for (const threadId of this.heldSubagentThreads) {
      this.heldSubagentThreads.delete(threadId);
      hub.releaseSubagentRunTopic(threadId);
    }
    this.clearReadDwell();
    this.detachRuntimeView();
    this.viewing?.removeViewer(this);
    this.viewing = undefined;
    // Release this connection's worktree watch refcounts.
    for (const worktreeId of this.watchedWorktrees)
      removeWorktreeViewer(worktreeId);
    this.watchedWorktrees.clear();
  }
}

/** The model a new session should carry from the viewed one, before it resolves. */
interface ViewedModelSelection {
  /** `account`: the resident session's account, where its model resolves. */
  model?: { provider: string; id: string; account?: string };
  thinkingLevel?: ThinkingLevel;
}

function readySettings(settings: AppSettings): Partial<AppSettings> {
  return {
    models: settings.models,
    calendarDaySession: settings.calendarDaySession,
    // The composer's mic button renders from this, so the shell needs it on connect.
    speechToText: settings.speechToText,
    // The Session inspector must not guess whether Memory is enabled from the
    // web fallback; the full Settings snapshot is fetched only on that route.
    memory: settings.memory,
    // Right-panel availability must reflect persisted settings without a visit
    // to Settings; the client fallback only covers the connection gap.
    appearance: settings.appearance,
  };
}

/**
 * The ONE wire projection for session rows, with two rules: the server-internal
 * `file` handle never leaves the process, and the singleton Personal Assistant
 * is not an ordinary session — it lives behind its own entry point, so no list
 * a client renders may carry it.
 *
 * Structural on purpose — every message with a `sessions` array, plus the
 * one-row `sessionUpdated` — rather than an enumeration of message types: the
 * leak that put the singleton back in the sidebar was exactly a later
 * sessions-carrying message (`permanentAssistantOpened`, and `forkedSession` /
 * `draftSession` beside it) that a per-type list had never been extended for.
 * A new one is covered the day it is added. It assumes what is true of every
 * such message today: a top-level `sessions` array IS a list of session rows.
 *
 * `undefined` means "send nothing at all"; only a hidden single row can produce
 * it, since a list simply loses that row.
 *
 * The binding lookup happens only for a message that actually carries rows —
 * every frame of a streaming run passes through here.
 */
function publicServerMessage(
  message: ServerMessage,
): ServerMessage | undefined {
  if ("sessions" in message && Array.isArray(message.sessions)) {
    const hidden = sessionListHiddenProbe();
    return {
      ...message,
      sessions: message.sessions
        .filter((session) => !hidden(session))
        .map(publicSessionListItem),
    };
  }
  if (message.type === "sessionUpdated") {
    if (sessionListHiddenProbe()(message.session)) return undefined;
    return { ...message, session: publicSessionListItem(message.session) };
  }
  return message;
}

function publicSessionListItem<T extends object>(item: T): Omit<T, "file"> {
  const { file: _file, ...publicItem } = item as T & { file?: unknown };
  return publicItem;
}

function cleanOptional(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeTaskStatus(status: unknown): TaskStatus {
  return status === "doing" || status === "done" ? status : "todo";
}

function taskSchedulingForCreate(request: TaskSaveRequest) {
  const dueDate = cleanOptional(request.dueDate);
  const scheduledFor = cleanOptional(request.scheduledFor);
  return {
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    ...(request.priority != null ? { priority: request.priority } : {}),
  };
}

function taskSchedulingForUpdate(request: TaskSaveRequest) {
  // `null` CLEARS the field, an absent key leaves it alone — so a value that
  // resolves to undefined must omit its key rather than carry undefined.
  const dueDate =
    request.dueDate === "" || request.dueDate === null
      ? null
      : cleanOptional(request.dueDate);
  const scheduledFor =
    request.scheduledFor === "" || request.scheduledFor === null
      ? null
      : cleanOptional(request.scheduledFor);
  return {
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    ...(request.priority === null
      ? { priority: null }
      : request.priority !== undefined
        ? { priority: request.priority }
        : {}),
  };
}

function mergeSessionRefs(
  existing: TaskSessionRef[] | undefined,
  refs: TaskSessionRef[],
): TaskSessionRef[] {
  const merged: TaskSessionRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(existing ?? []), ...refs]) {
    if (!ref.sessionId) continue;
    const key = ref.sessionId;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}
