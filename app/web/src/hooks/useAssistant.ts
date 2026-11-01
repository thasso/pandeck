import {
  applyPatch,
  commentTargetKey,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
  DEFAULT_HELPER_MODEL,
  DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  DEFAULT_SESSION_PEER_PROMPT_REMINDER_LIMIT,
  MAX_OPEN_COMMENT_TARGETS,
  isPersonalAssistantAgentType,
  projectSummaryOf,
  taskSummaryOf,
  workflowRunRoleSessionIds,
} from "@assistant/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  readAppShellCacheRecord,
  writeAppShellCacheRecord,
} from "../lib/appShellCacheStore.ts";
import { createClientId } from "../lib/clientId.ts";
import { createMutationLifecycle } from "../lib/mutationLifecycle.ts";
import { localStore } from "../lib/localStore.ts";
import { createIdleWriter, type IdleWriter } from "../lib/idleWriter.ts";
import { announceMessage } from "../lib/messageAnnounce.ts";
import { sessionSettleCascade } from "../lib/sessionInbox.ts";
import { collapseRequest, sameCollapsed } from "../lib/initiativeView.ts";
import {
  applyTopicMessage,
  createReplicaTransport,
  type ReplicaTransport,
  type RequestPurpose,
  revisionSidecar,
  type TopicDescriptor,
} from "../lib/stateReplica.ts";
import { wireValueEqual } from "../lib/wireValueEqual.ts";
import {
  arrivalHasHome,
  arrivalMessage,
  objectFailureFrom,
  type ObjectFailureType,
  sessionFailureFrom,
} from "../lib/messageArrival.ts";
import {
  PROJECT_ASSIGNMENT_TOAST_KEY,
  showToast,
  TOAST_DWELL_MS,
} from "../lib/toast.ts";
import {
  seedPeerPromptCardOverridesFromHistory,
  type PeerPromptCardOverrides,
} from "../lib/peerPromptCardOverrides.ts";
import type {
  AgentInfo,
  InboxPositionEntry,
  SettableSpawnOwnership,
  AgentQuestionResponse,
  AppSettings,
  ApprovalCard,
  BraveConnectionStatus,
  BraveSettingsPatch,
  BroadcastTopic,
  OpenAiCompatibleConnectionStatus,
  OpenAiCompatibleSettingsPatch,
  Context7ConnectionStatus,
  Context7SettingsPatch,
  GithubConnectionStatus,
  GithubSettingsPatch,
  ForgejoConnectionStatus,
  ForgejoSettingsPatch,
  ClientMessage,
  CommentTarget,
  CommentThread,
  ContextInfo,
  DisplayBlock,
  DisplayMessage,
  GoogleConnectionStatus,
  Harness,
  AgentType,
  GoogleSettingsPatch,
  ModelOption,
  MessageTarget,
  ProjectListRequest,
  ProjectListResponse,
  ProjectRecord,
  InitiativeDetail,
  InitiativeLayout,
  InitiativeLayoutTooLarge,
  InitiativeSummary,
  ProjectSummary,
  PullRequestCard,
  PullRequestCardAction,
  PullRequestMergeMethod,
  PromptAttachment,
  PromptQueueCommand,
  ServerMessage,
  TimelineAnchorTarget,
  StateEventsMessage,
  BackgroundWorkItemSummary,
  SlackConnectionStatus,
  SlackSettingsPatch,
  SlashCommandInfo,
  SessionListItem,
  SessionMode,
  SessionState,
  SpeechToTextStatus,
  ConfluenceConnectionStatus,
  ConfluenceSettingsPatch,
  JiraConnectionStatus,
  JiraSettingsPatch,
  TempoConnectionStatus,
  TempoSettingsPatch,
  ThinkingLevel,
  TaskItem,
  TaskListRequest,
  TaskListResponse,
  TaskProjectAssignmentUpdate,
  TaskReorderPlacement,
  TaskSaveRequest,
  TaskSummary,
  NewWorktreeCommentAnchor,
  EntryLibraryList,
  LibraryTopic,
  SkillToggles,
  CodeDeliveryWorkflowConfig,
  WorkflowRunCard,
  WorkflowRunDelivery,
  WorkflowCeilingRaise,
  WorkflowCommitCheckChoice,
  WorkflowRunLimits,
  WorkflowRunStartPhase,
  WorkflowRunSummary,
  WorktreeComment,
  WorktreeGitStatus,
  WorktreeMergePhase,
  WorktreeMergeStrategy,
  WorktreeProvisionDisplay,
  WorktreeRecord,
  WorktreeReviewSet,
} from "@assistant/shared";
import type {
  ClientRuntimeEvent,
  ClientTimelineEntry,
  HostCommandClientEntry,
} from "@assistant/shared/runtime";
import {
  describeTimelineCache,
  TIMELINE_RANGE_LIMIT,
  TIMELINE_RANGE_MAX_LIMIT,
} from "@assistant/shared/runtime";
import {
  EMPTY_TURN_STATS_SEED,
  type TurnStatsSeed,
} from "@assistant/shared/turnStats";
import type { BuildInfo } from "@assistant/shared/buildInfo";
import {
  approvalIdFromMessageId,
  approvalMessageId,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import type { UsageIndicator } from "@assistant/shared/usage";
import type { LiveRunProgress } from "../lib/runProgress.ts";
import type {
  AgentContentBlock,
  LazyBlockKind,
  LiveBodyKey,
  LiveBodyRef,
  SnapshotRunState,
  StreamingEntry,
} from "@assistant/shared/session";
import { bodyContentHash, liveBodyKeyId } from "@assistant/shared/session";
import {
  createDisplayProjectionCache,
  entriesToDisplayMessages,
} from "@assistant/shared/display";
import { placeCardRows } from "@assistant/shared/cardPlacement";
import { AssistantSocket, defaultSocketUrl } from "../lib/socket.ts";
import { sessionIdFromPathname } from "../lib/sessionRoutes.ts";
import { recordWebBuild } from "../lib/webBuild.ts";
import { nativeNotify } from "../lib/nativeShell.ts";
import { shouldRaiseAppNotification } from "../lib/apnsPush.ts";
import { perfStatsEnabled, recordSessionLoadMark } from "../lib/perfStats.ts";
import {
  cacheRecordForSnapshot,
  deleteSessionTimelineCache,
  expandTimelineSnapshot,
  loadSessionTimelineCache,
  saveSessionTimelineCache,
  type SessionTimelineCacheRecord,
} from "../lib/sessionTimelineCache.ts";
import { forgetTranscriptScrollPosition } from "../lib/transcriptScroll.ts";
import {
  cacheableWorktreeStatuses,
  NO_WORKTREE_STATUSES,
  worktreeSilhouetteKey,
} from "../lib/worktreeRowStatuses.ts";
import type { CredentialProfileProjection } from "../lib/credentialProfiles.ts";
import {
  optimisticAttachmentRef,
  rememberAttachmentPreview,
} from "../lib/attachmentPreviews.ts";
import {
  beginLoad,
  dataOf,
  failFrom,
  idle,
  isPending,
  ready,
  type LoadState,
} from "../lib/loadState.ts";

const defaultSettings: AppSettings = {
  projectsRoot: "~/projects",
  models: { hidden: [], order: [] },
  peerSpawnRuntimes: [],
  sessionPeerPromptMaxHops: DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  sessionPeerPromptReminderLimit: DEFAULT_SESSION_PEER_PROMPT_REMINDER_LIMIT,
  // Sparse and empty until the Settings page fetches the real object: every
  // skill reads OFF, which is what an unanswered settings read may claim.
  skills: {},
  permanentAssistant: {
    name: "Personal Assistant",
    workingDirectory: "",
    defaultWorkingDirectory: "",
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
    additionalInstructions: "",
  },
  sessionNaming: {
    enabled: true,
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  commitAgent: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  prAgent: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  sessionStatus: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "high",
  },
  pdfConversion: {
    fallbackEnabled: true,
    provider: "claude-sdk",
    modelId: "sonnet",
    thinkingLevel: "off",
    timeoutMs: 180000,
  },
  speechConversation: { ...DEFAULT_SPEECH_CONVERSATION_SETTINGS },
  speechSynthesis: { ...DEFAULT_SPEECH_SYNTHESIS_SETTINGS },
  speechToText: {
    enabled: true,
    modelId: "",
    numThreads: 8,
    idleShutdownSeconds: 600,
    maxUtteranceSeconds: 120,
    vocabulary: [],
  },
  promptRefinement: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  taskIntakeAgent: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
    projectId: "",
    additionalInstructions: "",
  },
  browserTools: {
    headed: false,
    rawMcpEnabled: false,
  },
  backgroundWork: DEFAULT_BACKGROUND_WORK_SETTINGS,
  jira: {
    enabled: false,
    jiraHost: "",
    atlassianEmail: "",
    atlassianTokenConfigured: false,
  },
  confluence: {
    enabled: false,
    confluenceHost: "",
    credentialsAvailable: false,
  },
  tempo: {
    enabled: false,
    apiBaseUrl: "https://api.tempo.io/4",
    redirectUri: "http://localhost:8787/api/tempo/oauth/callback",
    oauthClientConfigured: false,
    refreshTokenConfigured: false,
    authorAccountId: "",
  },
  google: {
    enabled: false,
    redirectUri: "http://localhost:8787/api/google/oauth/callback",
    accountEmail: "",
    scopes: [],
    oauthClientConfigured: false,
    refreshTokenConfigured: false,
    gmailArchiveAuthorized: false,
  },
  slack: {
    enabled: false,
    oauthClientConfigured: false,
    userTokenConfigured: false,
    botTokenConfigured: false,
    connected: false,
  },
  openAiCompatible: {
    enabled: false,
    name: "OpenAI-compatible",
    baseUrl: "",
    apiKeyConfigured: false,
    thinkingFormat: "none",
    models: [],
  },
  brave: {
    enabled: false,
    apiKeyConfigured: false,
  },
  context7: {
    enabled: false,
    apiKeyConfigured: false,
  },
  github: {
    enabled: false,
    tokenConfigured: false,
    defaultOwner: "",
    packageProxyEnabled: true,
  },
  forgejo: {
    enabled: false,
    baseUrl: "",
    tokenConfigured: false,
    defaultOwner: "",
  },
  claudeSdk: { enabled: false },
  worktrees: {
    root: "",
    namingAgent: {
      ...DEFAULT_HELPER_MODEL,
      thinkingLevel: "off" as const,
    },
    mergeAgent: {
      provider: "claude-sdk",
      modelId: "sonnet",
      thinkingLevel: "medium" as const,
    },
    defaultMergeStrategy: "squash" as const,
    remoteFetchMinutes: 10,
  },
  memory: {
    loadingEnabled: true,
    learningMode: "adaptive",
    maintenanceEnabled: true,
    maxCards: 8,
    maxRenderedChars: 1200,
    processor: {
      ...DEFAULT_HELPER_MODEL,
      thinkingLevel: "off" as const,
    },
    maxCallsPerHour: 12,
    maxCostPerDayUsd: 1,
  },
  appearance: {
    separatorBeforeFinalResponse: true,
    separatorAtTurnEnd: true,
    turnStatsRow: true,
    turnStatsPerRequest: false,
  },
  // Until the server answers, "today" is the browser's day.
  profile: {
    displayName: "",
    timeZone: "",
    effectiveTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  knowledgeBase: { enabled: true, path: "", effectivePath: "" },
  accountRouting: {
    fiveHourUsedThreshold: 90,
    weeklyUsedThreshold: 95,
    openAiResetAutoRedeemHours: 6,
  },
};

export interface ForkDraft {
  sessionId: string;
  text: string;
  token: number;
}

/** Navigation signal emitted whenever a fork completes, so the UI switches to it. */
interface ForkSwitch {
  sessionId: string;
  token: number;
}

/**
 * A jump the reader asked for, once the server has said where its target lives:
 * the session and the transcript ROW to land on, plus that row's index in the
 * session's timeline. The index is what makes the jump reliable — the transcript
 * is a windowed suffix, so anything older than the window has to be LOADED
 * before it can be scrolled to, and the index says exactly how much.
 *
 * Consumed by token, like {@link ForkSwitch}: it names a navigation the app
 * performs once, not a state it stays in.
 */
interface MessageReveal {
  sessionId: string;
  entryId: string;
  index: number;
  token: number;
}

interface DevReloadState {
  phase: "pending" | "reloading";
  runningCount?: number;
}

/**
 * An in-flight first-send worktree provision, tagged with the send it belongs
 * to so the host can re-issue exactly that prompt after a failure.
 */
type LiveWorktreeProvision = WorktreeProvisionDisplay & {
  clientRequestId: string;
};

/** One `startWorkflowRun` request's latest progress/outcome. */
interface WorkflowRunStartState {
  requestId: string;
  phase: WorkflowRunStartPhase;
  runId?: string;
  branch?: string;
  error?: string;
}

/**
 * One `initiativeDetail` answer: the graph, and the map's layout for exactly
 * that graph or why it could not be drawn (`layoutError`, with the graph kept).
 */
export interface InitiativeRead {
  item: InitiativeDetail;
  layout?: InitiativeLayout;
  layoutError?: string;
  /** Set with `layoutError` when the map is over the node limit: its size. */
  layoutTooLarge?: InitiativeLayoutTooLarge;
  /**
   * The collapsed epics this read asked for, as sent (none when absent): with
   * the graph it is the drawing's identity, so a page whose wish moved since
   * knows this read is not the one it wants.
   */
  requestedCollapsed?: readonly string[];
}

export interface UIState {
  hydrated: boolean;
  /** `cache` means the app shell rendered from browser-local data and is waiting for websocket reconciliation. */
  hydrationSource: "empty" | "cache" | "live";
  shellCachedAt: number | null;
  connected: boolean;
  models: ModelOption[];
  /**
   * The `refreshModels` in flight, so Settings can show its Refresh busy. The
   * refresh usually answers with a list identical to the one on screen, which
   * is why it needs a state of its own: without it the button is the only
   * control in the app whose success and whose failure look the same.
   */
  modelsRefreshRequestId: string | null;
  /** Agents the server offers (Workshop only in dev). */
  agents: AgentInfo[];
  /**
   * The rows every consumer reads, composed: `liveSessions` plus the archived
   * slice's rows that are not live, newest first. Never written directly; a
   * row transform goes through `updateSessionRows`.
   */
  sessions: SessionListItem[];
  /**
   * The `sessions` replica's held rows: the canonical live projection ONLY
   * (`docs/state-sync.md`, "Adopted domains"), so a `delete` for an archived
   * id can never drop a shown archived row.
   */
  liveSessions: SessionListItem[];
  /** The archived slice, replaced whole by each `archivedSessions` answer. */
  archivedSessions: SessionListItem[];
  /**
   * The `sessions` subscription's snapshot arrived in the CURRENT socket
   * episode. `hydrationSource === "live"` is NOT a substitute — it is
   * historical, and a reconnect turns `connected` back on before the new
   * snapshot lands, which would bless previous-episode rows as current.
   */
  sessionListFresh: boolean;
  /** Count of archived sessions omitted until the archived sidebar section is expanded. */
  archivedSessionCount: number;
  /** True once the archived slice was read, until a snapshot makes it stale. */
  archivedSessionsLoaded: boolean;
  /**
   * An archived re-read is due: at most one waits behind the flight
   * (`docs/session-list.md`, "Archived sessions"). The effect layer sends it.
   */
  archivedReadQueued: boolean;
  /** The `requestId` of the archived read in flight; only its answer counts. */
  archivedReadFlight: string | null;
  session: SessionState | null;
  settings: AppSettings;
  /** Deployment dictation availability from `ready`; null before first connect. */
  speechToText: SpeechToTextStatus | null;
  /**
   * Which build of the SERVER this connection reached, from `ready`; null before
   * the first connect (and while a cached shell is showing, where it would be a
   * claim about a server nobody has spoken to yet).
   */
  serverBuild: BuildInfo | null;
  slashCommands: SlashCommandInfo[];
  /** Boot-critical account/model projection, cached and silently revalidated by App. */
  credentialProfileProjection: CredentialProfileProjection | null;
  messages: DisplayMessage[];
  contextInfo: ContextInfo | null;
  historySessionId: string | null;
  /**
   * The last session the server took away from this connection — deleted (from
   * this or any other client) or archived — whether it was on show or still
   * loading. A new object per message: the route leaves an address that names
   * it (`App`), once, on arrival.
   */
  viewCleared: { sessionId: string; reason: "deleted" | "archived" } | null;
  permanentAssistantUnread: boolean;
  jiraStatus: JiraConnectionStatus | null;
  confluenceStatus: ConfluenceConnectionStatus | null;
  tempoStatus: TempoConnectionStatus | null;
  googleStatus: GoogleConnectionStatus | null;
  slackStatus: SlackConnectionStatus | null;
  openAiCompatibleStatus: OpenAiCompatibleConnectionStatus | null;
  braveStatus: BraveConnectionStatus | null;
  context7Status: Context7ConnectionStatus | null;
  githubStatus: GithubConnectionStatus | null;
  forgejoStatus: ForgejoConnectionStatus | null;
  taskList: TaskListResponse | null;
  /**
   * Last authoritative revision applied per topic and object id. Kept beside
   * wire objects so an optimistic row never differs from its echo merely
   * because the server minted a revision.
   */
  stateEventRevisions: Partial<Record<BroadcastTopic, Record<string, number>>>;
  /**
   * Live Initiative summaries from the `initiatives` topic, held only while it
   * is subscribed. The graph is a keyed `getInitiative` read.
   */
  initiatives: InitiativeSummary[];
  /**
   * An `initiativeList` snapshot answered the current subscription during this
   * socket episode.
   */
  initiativesFresh: boolean;
  /**
   * A new subscription's snapshot is out over a list an earlier one answered
   * this episode: the held list is shown as refreshing, never as ready or
   * empty. A snapshot, a failed read or a disconnect ends it.
   */
  initiativesRefreshing: boolean;
  /** The Initiative list could not be read; cleared by the next snapshot. */
  initiativeListError: string | null;
  /**
   * The inspector's last compaction-window save, by session id: busy while it
   * is unanswered, then its refusal (if any) until the next save.
   */
  compactionWindowEdits: Readonly<Record<string, CompactionWindowEdit>>;
  /**
   * Keyed Initiative reads (`getInitiative`): the graph with its map layout, or
   * `ready(null)` when it does not exist or was deleted. A newer `initiatives`
   * event or snapshot revision re-reads an entry; Task events never do.
   */
  initiativeDetails: Record<string, LoadState<InitiativeRead | null>>;
  /** The revision each held read is as of, pruned with the cache. */
  initiativeDetailRevisions: Record<string, number>;
  initiativeDetailsLru: string[];
  /** The Initiative a page is showing; its read is never pruned. */
  openInitiativeId: string | null;
  /**
   * Live consumers of a read, counted per id (`retainInitiativeDetail`): an
   * expanded browser row draws the graph, so its read is never pruned while it
   * is mounted open. Pins sit beside the idle LRU, never inside its bound.
   */
  initiativeDetailPins: Readonly<Record<string, number>>;
  /**
   * Canonical bounded background-work registry. Held only while the topic is
   * subscribed; per-session activity travels on the session row instead, so no
   * surface has to hold this list to know a session is busy.
   */
  backgroundWorkItems: BackgroundWorkItemSummary[];
  /**
   * The last snapshot was a window over a longer history. Rows this browser
   * never received are older, settled work — so a surface may say its list is
   * partial, but must never read this as "something is missing that matters
   * right now": anything that changes still arrives as an event.
   */
  backgroundWorkTruncated: boolean;
  /**
   * PENDING CONTROL STATE ONLY: item ids whose human Stop this browser has sent
   * and not yet had answered, and owner ids whose Stop-all is outstanding. It
   * makes a pressed button busy and nothing else — a row's state is never
   * derived from it, so a Stop that goes unconfirmed still reads as running.
   */
  backgroundStopPending: string[];
  backgroundStopAllPending: string[];
  /**
   * Owners whose last Stop-all left a retained host open because an ordinary
   * prompted turn is still inside its safe boundary. The wait is shown; it is
   * never rendered as a completed close.
   */
  backgroundHostCloseWaiting: string[];
  /** An authoritative Task list answered during the current socket episode. */
  taskListFresh: boolean;
  /** Failed current-episode Task list read; retained rows remain readable. */
  taskListError: string | null;
  projectList: ProjectListResponse | null;
  /** An authoritative Project list answered during the current socket episode. */
  projectListFresh: boolean;
  projectListError: string | null;
  /** Keyed full Project documents; `ready(null)` is authoritative not-found. */
  projectDetails: Record<string, LoadState<ProjectRecord | null>>;
  projectDetailRevisions: Record<string, number>;
  projectDetailsLru: string[];
  openProjectProjectionId: string | null;
  /** Pending/outcome state keyed by `projectId:operation`. */
  projectMutations: Record<string, LoadState<true>>;
  /**
   * Subscription-usage indicators per enabled account, authoritative from the
   * server cache (`usage` topic). Null until the first snapshot arrives.
   */
  usageIndicators: UsageIndicator[] | null;
  /** All known worktrees; null until first fetched. */
  worktrees: WorktreeRecord[] | null;
  /** An authoritative Worktree list answered during the current socket episode. */
  worktreesFresh: boolean;
  /** Failed current-episode Worktree refresh; retained rows remain readable. */
  worktreeListError: string | null;
  /** Live git status per worktree id (on-demand fetch + watcher pushes). */
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  /**
   * What git said about each worktree when this browser last looked, restored
   * from the shell cache so a cold list paints rows at their real height
   * instead of growing each one as its watch answers.
   *
   * DISPLAY ONLY, and never merged into {@link worktreeStatuses}: a control
   * that decides anything from a status — what may be committed or pushed, what
   * a card claims about CI — reads that record alone, where an absent
   * projection still means unknown rather than clean. Rows fall back to this
   * one through `lib/worktreeRowStatuses.ts`; nothing else may read it.
   */
  cachedWorktreeStatuses: Record<string, WorktreeGitStatus>;
  /** Latest naming-agent proposal (keyed by requestId to ignore stale replies). */
  worktreeNameProposal: { requestId: string; name: string } | null;
  /**
   * The user-owned skills library from the `skills` topic — the ONE canonical
   * skills list state. It stays a `LoadState` rather than a nullable list
   * because the server rescans the working tree on every subscribe: reopening
   * Settings → Skills keeps the rows on screen while that scan runs
   * (`refreshing`), and a scan that FAILED must be able to say so beside them
   * instead of collapsing into "no skills yet".
   */
  skillLibrary: LoadState<EntryLibraryList>;
  /**
   * The agent definitions library from the `agents` topic, held exactly like
   * {@link skillLibrary}: the Agents settings page and the new-session agent
   * picker read it.
   */
  agentLibrary: LoadState<EntryLibraryList>;
  /**
   * The skill toggle map most recently SENT, with the request it went out as,
   * or null when nothing is in flight ([Task-613](pa://task/613)).
   *
   * Never rendered — the controls read `settings.skills`, which only a server
   * echo moves. This is the BASE for the next write, and it exists because the
   * section is replaced whole: while a write is pending the echoed map still
   * lacks the change it carries, so a second toggle built on that map would
   * send a replacement that silently turns the first one back off.
   *
   * It is keyed by REQUEST because several writes can be in flight, and each
   * one is echoed as it lands. An older echo therefore describes a settings
   * file that is already behind this base, and an older answer says nothing
   * about the newer write still out there — so only the answer to THIS request
   * may clear it. Whoever clears it hands the base back to `settings.skills`,
   * which by then carries every write the server accepted.
   */
  pendingSkillToggles: { requestId: string; skills: SkillToggles } | null;
  /** Every Workflow Run, from the `workflow` topic; null until first snapshot. */
  workflowRuns: WorkflowRunSummary[] | null;
  /** Recipe-owned card projection for each non-terminal run. */
  workflowCards: Record<string, ClientWorkflowRunCard>;
  /**
   * `startWorkflowRun` progress/outcome PER REQUEST id. A map, not a
   * latest-message slot: several starts can be in flight at once (the design
   * allows multiple runs, and a backgrounded provisioning takes minutes), and
   * a single slot would let a later request's message shadow an earlier
   * request's terminal outcome. Entries persist until explicitly cleared
   * (`clearWorkflowRunStart`) by whoever consumed the outcome.
   */
  workflowRunStarts: Record<string, WorkflowRunStartState>;
  /**
   * Live "+ New worktree" provisioning for a first send that has not produced a
   * session yet. A client overlay on the chat (never timeline content) keyed by
   * the send's `clientRequestId`: it survives a failed provision, which creates
   * no session and therefore no durable card, so the prompt can be re-sent.
   */
  worktreeProvision: LiveWorktreeProvision | null;
  /** Canonical shared comment projection, keyed by `commentTargetKey`. */
  comments: Record<string, CommentThread[]>;
  /** Target descriptors retained even for authoritative empty snapshots. */
  commentTargets: Record<string, CommentTarget>;
  /** Per-target comment event revisions, separate from the wire objects. */
  commentRevisions: Record<string, Record<string, number>>;
  /** Review comments and their durable review sets per worktree id. */
  worktreeComments: Record<string, WorktreeComment[]>;
  worktreeReviewSets: Record<string, WorktreeReviewSet[]>;
  worktreeReviewSetRevisions: Record<string, Record<string, number>>;
  /** Task route whose ready detail entry is pinned in its cache. */
  openTaskProjectionId: string | null;
  /** Merge-back progress per worktree id (survives dialog close). */
  worktreeMerge: Record<
    string,
    {
      phase: WorktreeMergePhase;
      message?: string;
      conflictPaths?: string[];
      agentSessionId?: string;
    }
  >;
  /** Keyed full-body reads; `ready(null)` is authoritative not-found. */
  taskDetails: Record<string, LoadState<TaskItem | null>>;
  /**
   * The state-event revision each cached body is as of (the `taskDetail` /
   * `taskSaved` envelope). A NEWER event marks that body stale even when the
   * row's `updatedAt` did not move — a linked Task's rename or status change
   * reaches this Task's links only that way.
   */
  taskDetailRevisions: Record<string, number>;
  /** Least-recently-used order for the bounded per-Task body cache. */
  taskDetailsLru: string[];
  /**
   * Every Task this tab has read or saved: its status and pending suggestion as
   * of that read, `null` when it was not found. Kept OUTSIDE the body cache on
   * purpose — a transcript Task card asks it whether its recorded suggestion was
   * answered, and an LRU eviction there would put the answered question back.
   * Uncapped because an entry is a few fields and Task ids are finite. A record
   * is a last-known value, not a subscription: the card re-reads on mount and
   * reconnect, and leaving the live projection drops it
   * (`forgetTaskStatuses`).
   */
  taskStatuses: Record<string, TaskStatusRecord | null>;
  /** Pending/settled/error state for Task controls, keyed by Task + operation. */
  taskMutations: Record<string, LoadState<true>>;
  /* ---- runtime-native chat state (source of truth; `messages` is derived) ---- */
  /**
   * Durable conversation + host-command cards, keyed by id, sorted by seq. For a
   * long session this is the WINDOW the server sent (plus any range loaded
   * since): always the timeline's gapless suffix, anchored to the live tail.
   */
  timeline: ClientTimelineEntry[];
  /**
   * Absolute index of `timeline[0]` in the server's projection; 0 = complete.
   * Above zero it is also the ANSWER to "are there older entries": the wire's
   * `totalEntryCount` is not mirrored into state, because nothing renders a
   * total and a mirrored one would have to be maintained against every append.
   */
  timelineStart: number;
  /** Turn stats for everything before `timelineStart`; the transcript seeds with it. */
  turnStatsSeed: TurnStatsSeed;
  /** Anchor seq of the in-flight "load earlier" range request, if any. */
  timelineRangePending: number | null;
  /**
   * Counts the snapshots applied. Each one comes from a transport that starts
   * with no live-body demand (a session switch, a reconnect), so the demand
   * the mounted blocks hold is re-declared once the commit that carries the
   * snapshot has run — keyed on this, not on a microtask from the socket.
   */
  snapshotGeneration: number;
  /** In-flight streams (assistant message + open tool calls), keyed by streamId. */
  liveStreams: StreamingEntry[];
  /** Optimistic user prompts awaiting their durable entry, keyed `creq-<id>`. */
  optimistic: OptimisticTimelineEntry[];
  /**
   * Where a prompt sent to the permanent Assistant's QUEUE currently stands,
   * keyed by the transcript id of the row it is about (the optimistic echo,
   * `creq-<clientRequestId>`).
   *
   * These are conditions, not events (`docs/messaging.md`): a message IS queued,
   * then IS being worked on, until the next update replaces it. So they live on
   * the row of the message they are about and are never announced. The row
   * hands over rather than disappearing — the echo is retired by the durable
   * user entry, which the server appends only after the work has started, and
   * from there the transcript's own run state says the same thing.
   */
  promptQueueStates: Record<string, PromptQueueState>;
  /** Approval cards (client overlay; not part of the durable timeline). */
  approvals: DisplayMessage[];
  /** Live pull-request cards (client overlay; not part of the durable timeline). */
  pullRequestCards: DisplayMessage[];
  /**
   * Live peer-prompt card lifecycle patches, keyed by opaque messageKey (client
   * overlay applied at render time so a durable transition updates the SAME
   * rendered card in place instead of freezing its creation-time snapshot).
   */
  peerPromptCardOverrides: PeerPromptCardOverrides;
  /**
   * The viewed session's "Approve for session" grants, keyed by the session
   * they belong to so a list for the session just left never shows here.
   * `grants` is its own list, the one the transcript's cards revoke from;
   * `inherited` and `inheritance` are for the inspector only.
   */
  approvalGrants: ApprovalGrantsState | null;
  /** The runtime's authoritative run state (drives the working indicator). */
  runState: SnapshotRunState;
  /** Session-level "is a turn running" — derived from {@link runState}. */
  streaming: boolean;
  /**
   * What the viewed session's running run has been observed doing, from its
   * runtime snapshot and `runProgress` events, with the local time it arrived
   * (ages are read against the server's `observedAt` plus time since then).
   * Null whenever {@link runState} is idle.
   */
  runProgress: LiveRunProgress | null;
  /** Id of the one message currently streaming, or null. Derived from the projection. */
  streamingMessageId: string | null;
  /**
   * The failure each SESSION is currently carrying, keyed by session id and
   * held on the object. There is no global message slot to read it off any
   * more: what the user is TOLD is decided at the arrival
   * (`lib/messageArrival.ts`), and only what outlives that is state.
   *
   * A condition lives on its object and stays there (`docs/messaging.md`), and
   * that has to survive BOTH kinds of interference: an unrelated message (which
   * deriving it from `notice` did not), and another session failing (which a
   * single slot did not). Retirement is per-session for the same reason — a
   * dismissal or a re-send in one chat may not silence another.
   */
  sessionFailures: Record<string, string>;
  /**
   * Sessions the server said cannot be OPENED at all (`error.sessionUnavailable`),
   * keyed by id, with why. A route waiting for one stops waiting: it shows the
   * failure instead of the pending panel. Independent of `sessionFailures`, so
   * dismissing the note does not bring the spinner back. Cleared — together
   * with that session's note, while it is still this failure — when its
   * snapshot arrives after all, and on every `ready` (a fresh connection says
   * it again if it still holds).
   */
  unopenableSessions: Record<string, string>;
  /**
   * The same thing for the other objects that own a surface: the failure a
   * project, Task or Knowledge entry is carrying, keyed by id under its type and
   * rendered by that object's page (`docs/messaging.md`).
   *
   * This holds the writes NO control tracks — archiving or deleting a Task, a
   * comment on an entry — because a tracked write's failure is already rendered
   * on the control that was refused, and storing it here as well would print the
   * same sentence twice on one page. Both are in place, so both silence the
   * announcement; the split is decided at the arrival, from the request id the
   * failure carries, never from its text.
   */
  objectFailures: Record<ObjectFailureType, Record<string, string>>;
  /**
   * Bumped when the server confirms a project assignment. The Backlog's Undo
   * toast needs to know the write landed; it used to watch for a notice whose
   * TEXT it recognised, which broke the moment that notice was (correctly)
   * deleted for announcing a change the user can already see.
   */
  taskProjectsAssignedSeq: number;
  /**
   * The viewed chat's last OUTCOME — not a message that has been said. The
   * announcement for that outcome was raised once, at its arrival; this is what
   * the composer's own surfaces read afterwards, and it is retired by the next
   * send rather than by anyone having read it.
   */
  error: string | null;
  /** Draft text returned by a user-message fork, keyed so the composer applies it once. */
  forkDraft: ForkDraft | null;
  /** Navigation signal to switch to a freshly forked session, keyed by token. */
  forkSwitch: ForkSwitch | null;
  /** Where an asked-for jump lands, once resolved; consumed by token. */
  messageReveal: MessageReveal | null;
  /** The in-flight `resolveTimelineAnchor`, so a stale answer is ignored and the asking control can show it is working. */
  revealRequest: { requestId: string; target: TimelineAnchorTarget } | null;
  /** Dev-only: server is reloading to apply a code change (see devReload). */
  reloading: DevReloadState | null;
  accountLoginAlerts: Extract<
    ServerMessage,
    { type: "accountLoginAlerts" }
  >["accounts"];
  /** Compact title/route/existence metadata for resolved pa:// object links. */
  objectLinks: Record<string, PaObjectLinkResolution>;
}

const APP_SHELL_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface AppShellCache {
  version: 1;
  savedAt: number;
  models: ModelOption[];
  agents: AgentInfo[];
  sessions: SessionListItem[];
  archivedSessionCount?: number;
  archivedSessionsLoaded?: boolean;
  settings: AppSettings;
  slashCommands: SlashCommandInfo[];
  taskList?: TaskListResponse | null;
  /** Sidecar for `taskList`; absent caches fall back to a full snapshot once. */
  taskRevisions?: Record<string, number>;
  projectList?: ProjectListResponse | null;
  projectRevisions?: Record<string, number>;
  worktrees?: WorktreeRecord[] | null;
  /** Last-known git status per cached worktree; see `lib/worktreeRowStatuses.ts`. */
  worktreeStatuses?: Record<string, WorktreeGitStatus>;
  credentialProfileProjection?: CredentialProfileProjection | null;
}

/** The library topics, and the state each one's list lands in. */
const LIBRARY_STATE_FIELD = {
  skills: "skillLibrary",
  agents: "agentLibrary",
} as const satisfies Record<LibraryTopic, keyof UIState>;
const LIBRARY_TOPICS = Object.keys(LIBRARY_STATE_FIELD) as LibraryTopic[];

const emptyInitial: UIState = {
  hydrated: false,
  hydrationSource: "empty",
  shellCachedAt: null,
  connected: false,
  models: [],
  modelsRefreshRequestId: null,
  agents: [],
  sessions: [],
  liveSessions: [],
  archivedSessions: [],
  archivedSessionCount: 0,
  archivedSessionsLoaded: false,
  archivedReadQueued: false,
  archivedReadFlight: null,
  session: null,
  settings: defaultSettings,
  speechToText: null,
  serverBuild: null,
  slashCommands: [],
  credentialProfileProjection: null,
  messages: [],
  contextInfo: null,
  historySessionId: null,
  viewCleared: null,
  permanentAssistantUnread: false,
  jiraStatus: null,
  confluenceStatus: null,
  tempoStatus: null,
  googleStatus: null,
  slackStatus: null,
  openAiCompatibleStatus: null,
  braveStatus: null,
  context7Status: null,
  githubStatus: null,
  forgejoStatus: null,
  taskList: null,
  stateEventRevisions: {},
  initiatives: [],
  initiativesFresh: false,
  initiativesRefreshing: false,
  initiativeListError: null,
  compactionWindowEdits: {},
  initiativeDetails: {},
  initiativeDetailRevisions: {},
  initiativeDetailsLru: [],
  openInitiativeId: null,
  initiativeDetailPins: {},
  backgroundWorkItems: [],
  backgroundWorkTruncated: false,
  backgroundStopPending: [],
  backgroundStopAllPending: [],
  backgroundHostCloseWaiting: [],
  sessionListFresh: false,
  taskListFresh: false,
  taskListError: null,
  projectList: null,
  projectListFresh: false,
  projectListError: null,
  projectDetails: {},
  projectDetailRevisions: {},
  projectDetailsLru: [],
  openProjectProjectionId: null,
  projectMutations: {},
  usageIndicators: null,
  worktrees: null,
  worktreesFresh: false,
  worktreeListError: null,
  worktreeStatuses: {},
  cachedWorktreeStatuses: NO_WORKTREE_STATUSES,
  worktreeNameProposal: null,
  skillLibrary: idle(),
  agentLibrary: idle(),
  pendingSkillToggles: null,
  workflowRuns: null,
  workflowCards: {},
  workflowRunStarts: {},
  worktreeProvision: null,
  comments: {},
  commentTargets: {},
  commentRevisions: {},
  worktreeComments: {},
  worktreeReviewSets: {},
  worktreeReviewSetRevisions: {},
  openTaskProjectionId: null,
  worktreeMerge: {},
  taskDetails: {},
  taskDetailRevisions: {},
  taskDetailsLru: [],
  taskStatuses: {},
  taskMutations: {},
  timeline: [],
  timelineStart: 0,
  turnStatsSeed: EMPTY_TURN_STATS_SEED,
  timelineRangePending: null,
  snapshotGeneration: 0,
  liveStreams: [],
  optimistic: [],
  promptQueueStates: {},
  approvals: [],
  pullRequestCards: [],
  peerPromptCardOverrides: {},
  approvalGrants: null,
  runState: "idle",
  streaming: false,
  runProgress: null,
  streamingMessageId: null,
  sessionFailures: {},
  unopenableSessions: {},
  objectFailures: { project: {}, task: {} },
  taskProjectsAssignedSeq: 0,
  error: null,
  forkDraft: null,
  forkSwitch: null,
  messageReveal: null,
  revealRequest: null,
  reloading: null,
  accountLoginAlerts: [],
  objectLinks: {},
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isCacheableTaskList(
  list: TaskListResponse | null | undefined,
): list is TaskListResponse {
  if (!list) return false;
  const request = list.request;
  return (
    !request.status &&
    !request.projectId &&
    !request.priority &&
    !request.due &&
    !request.scheduled &&
    !request.sessionId &&
    !request.query &&
    !request.includeArchived
  );
}

function taskRevisionRecord(value: unknown): Record<string, number> | null {
  if (!isObject(value)) return null;
  const revisions: Record<string, number> = {};
  for (const [id, revision] of Object.entries(value)) {
    if (!id || !Number.isSafeInteger(revision) || (revision as number) < 0)
      return null;
    revisions[id] = revision as number;
  }
  return revisions;
}

function taskListHasRevisionSidecar(
  list: TaskListResponse,
  revisions: Record<string, number> | undefined,
): revisions is Record<string, number> {
  if (!revisions) return false;
  return list.items.every(
    (item) =>
      Number.isSafeInteger(revisions[item.id]) && revisions[item.id]! >= 0,
  );
}

/** True when the canonical cached objects can be diffed against a resubscribe digest. */
function canUseTaskDigest(state: UIState): boolean {
  return Boolean(
    state.taskList &&
    isCacheableTaskList(state.taskList) &&
    taskListHasRevisionSidecar(state.taskList, state.stateEventRevisions.tasks),
  );
}

function isCanonicalProjectList(
  list: ProjectListResponse | null | undefined,
): list is ProjectListResponse {
  return Boolean(
    list &&
    list.request.includeArchived === true &&
    Object.keys(list.request).length === 1,
  );
}

function projectListHasRevisionSidecar(
  list: ProjectListResponse,
  revisions: Record<string, number> | undefined,
): revisions is Record<string, number> {
  return Boolean(
    revisions &&
    list.projects.every(
      (project) =>
        Number.isSafeInteger(revisions[project.id]) &&
        revisions[project.id]! >= 0,
    ),
  );
}

function canUseProjectDigest(state: UIState): boolean {
  return Boolean(
    isCanonicalProjectList(state.projectList) &&
    projectListHasRevisionSidecar(
      state.projectList!,
      state.stateEventRevisions.projects,
    ),
  );
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStamp(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) >= 0;
}

/** `{ahead, behind, name?}`, the shape both tracking axes share. */
function isDivergence(value: unknown): boolean {
  return (
    isObject(value) &&
    isCount(value.ahead) &&
    isCount(value.behind) &&
    (value.name === undefined || typeof value.name === "string")
  );
}

/**
 * The cached statuses, or nothing at all if ANY entry is not a whole
 * `WorktreeGitStatus`.
 *
 * Every field is checked, not the few a row happens to read today: this record
 * is the only state in the app that arrives from disk rather than from the
 * server, and a partly-checked one reaches JSX. A branch that parsed as an
 * object throws on render ("objects are not valid as a React child") and takes
 * the whole app down — a far worse outcome than the one-line row this cache
 * exists to avoid, which is also why one bad entry drops the record rather than
 * itself. The id must match the status it is filed under for the same reason
 * the rows do: everything downstream looks a status up by worktree id.
 */
function worktreeStatusRecord(
  value: unknown,
): Record<string, WorktreeGitStatus> | undefined {
  if (!isObject(value)) return undefined;
  const statuses: Record<string, WorktreeGitStatus> = {};
  for (const [id, status] of Object.entries(value)) {
    if (
      !id ||
      !isObject(status) ||
      status.worktreeId !== id ||
      !(typeof status.branch === "string" || status.branch === null) ||
      !(typeof status.head === "string" || status.head === null) ||
      typeof status.dirty !== "boolean" ||
      typeof status.merged !== "boolean" ||
      !isCount(status.filesChanged) ||
      !isCount(status.untracked) ||
      !isCount(status.additions) ||
      !isCount(status.deletions) ||
      !isCount(status.ahead) ||
      !isCount(status.behind) ||
      !isStamp(status.updatedAt) ||
      (status.upstream !== undefined && !isDivergence(status.upstream)) ||
      (status.baseUpstream !== undefined &&
        !isDivergence(status.baseUpstream)) ||
      (status.baseUnresolved !== undefined &&
        typeof status.baseUnresolved !== "boolean") ||
      (status.fetchedAt !== undefined && !isStamp(status.fetchedAt)) ||
      (status.changedAt !== undefined && !isStamp(status.changedAt))
    )
      return undefined;
    statuses[id] = status as unknown as WorktreeGitStatus;
  }
  return statuses;
}

function normalizeCachedSessions(
  sessions: SessionListItem[],
): SessionListItem[] {
  // Every field the server derives from LIVE state is dropped here and left to
  // the websocket to re-assert: a restored sidebar must not claim an agent is
  // still running, keep counting an elapsed label up from a run that ended
  // while the tab was shut, or show "Needs your approval"/queued work that was
  // resolved meanwhile (which would also disable Settle on it). Durable state —
  // `lastError`, `settledAt`, `archived` — is kept, because it is still true.
  // The singleton Personal Assistant is dropped too: the server never sends it
  // as a session row, so a cached one is a stale row written by an older build,
  // and it would paint in the sidebar until the first list arrives.
  return sessions
    .filter((session) => !isPersonalAssistantAgentType(session.agentType))
    .map((session) => {
      const {
        runStartedAt: _runStartedAt,
        providerRetry: _providerRetry,
        awaitingInput: _awaitingInput,
        attention: _attention,
        queuedWork: _queuedWork,
        // A waiting child may have started, or its place moved, meanwhile.
        waitingForSlot: _waitingForSlot,
        // Who still owes a reply is live too: kept alone, it would read a
        // tree whose peers were working as stalled until the first list.
        awaitingRepliesFrom: _awaitingRepliesFrom,
        // And who still waits on it: a reply sent since would clear it.
        unansweredRequestsFrom: _unansweredRequestsFrom,
        ...rest
      } = session;
      return { ...rest, isStreaming: false };
    });
}

const byUpdatedAt = (a: SessionListItem, b: SessionListItem) =>
  b.updatedAt - a.updatedAt;

/** `rows` newest first; the same array when it already is. */
function sortedByUpdatedAt(rows: SessionListItem[]): SessionListItem[] {
  for (let i = 1; i < rows.length; i++)
    if (byUpdatedAt(rows[i - 1]!, rows[i]!) > 0)
      return rows.slice().sort(byUpdatedAt);
  return rows;
}

/**
 * What consumers read: the live rows plus the archived slice's rows that are
 * not live (a restore shows once), newest first. With no such archived row it
 * IS the live array, identity included.
 */
function composeSessions(
  live: SessionListItem[],
  archived: SessionListItem[],
): SessionListItem[] {
  if (archived.length === 0) return live;
  const liveIds = new Set(live.map((session) => session.id));
  const extra = archived.filter((session) => !liveIds.has(session.id));
  return extra.length === 0 ? live : [...live, ...extra].sort(byUpdatedAt);
}

function sessionSlices(
  live: SessionListItem[],
  archived: SessionListItem[],
): Pick<UIState, "liveSessions" | "archivedSessions" | "sessions"> {
  return {
    liveSessions: live,
    archivedSessions: archived,
    sessions: composeSessions(live, archived),
  };
}

/** Write both session slices and recompose; unchanged slices keep `state`. */
function withSessionSlices(
  state: UIState,
  live: SessionListItem[],
  archived: SessionListItem[],
): UIState {
  if (live === state.liveSessions && archived === state.archivedSessions)
    return state;
  return { ...state, ...sessionSlices(live, archived) };
}

/**
 * The one way a reducer branch changes session rows: `update` runs on each
 * slice separately — the live rows through the replica's `write`, so they stay
 * sorted and keep the sidecar, the archived slice directly — and the consumer
 * list is recomposed.
 */
function updateSessionRows(
  state: UIState,
  update: (rows: SessionListItem[]) => SessionListItem[],
): UIState {
  const archived = update(state.archivedSessions);
  const held = sessionReplica.read(state);
  return sessionReplica.write(
    archived === state.archivedSessions
      ? state
      : withSessionSlices(state, state.liveSessions, archived),
    { items: update(held.items), revisions: held.revisions },
  );
}

/** Due an archived re-read: only while the slice is shown. */
function queueArchivedRead(state: UIState): UIState {
  return state.archivedSessionsLoaded && !state.archivedReadQueued
    ? { ...state, archivedReadQueued: true }
    : state;
}

/** Preserve row identities across authoritative snapshots when content agrees. */
function reconcileTaskList(
  held: readonly TaskSummary[],
  incoming: TaskListResponse,
): TaskSummary[] {
  if (held.length === 0 || incoming.items.length === 0) return incoming.items;
  const heldById = new Map(held.map((item) => [item.id, item]));
  let reused = false;
  const items = incoming.items.map((item) => {
    const existing = heldById.get(item.id);
    if (!existing || !wireValueEqual(existing, item)) return item;
    reused = true;
    return existing;
  });
  return reused ? items : incoming.items;
}

function reconcileProjects(
  current: ProjectSummary[],
  incoming: ProjectSummary[],
): ProjectSummary[] {
  const byId = new Map(current.map((project) => [project.id, project]));
  let reused = false;
  const projects = incoming.map((project) => {
    const existing = byId.get(project.id);
    if (!existing || !wireValueEqual(existing, project)) return project;
    reused = true;
    return existing;
  });
  return reused ? projects : incoming;
}

function parseAppShellCache(parsed: unknown): AppShellCache | null {
  if (!isObject(parsed) || parsed.version !== 1) return null;
  const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
  if (!savedAt || Date.now() - savedAt > APP_SHELL_CACHE_MAX_AGE_MS)
    return null;
  if (
    !Array.isArray(parsed.models) ||
    !Array.isArray(parsed.agents) ||
    !Array.isArray(parsed.sessions) ||
    !Array.isArray(parsed.slashCommands)
  )
    return null;
  if (!isObject(parsed.settings)) return null;
  const taskRevisionsValue =
    taskRevisionRecord(parsed.taskRevisions) ?? undefined;
  const worktreeStatusesValue = worktreeStatusRecord(parsed.worktreeStatuses);
  const projectRevisionsValue =
    taskRevisionRecord(parsed.projectRevisions) ?? undefined;
  return {
    version: 1,
    savedAt,
    models: parsed.models as ModelOption[],
    agents: parsed.agents as AgentInfo[],
    sessions: normalizeCachedSessions(parsed.sessions as SessionListItem[]),
    archivedSessionCount:
      typeof parsed.archivedSessionCount === "number"
        ? parsed.archivedSessionCount
        : 0,
    archivedSessionsLoaded: parsed.archivedSessionsLoaded === true,
    settings: {
      ...defaultSettings,
      ...(parsed.settings as Partial<AppSettings>),
    },
    slashCommands: parsed.slashCommands as SlashCommandInfo[],
    taskList: isCacheableTaskList(
      parsed.taskList as TaskListResponse | null | undefined,
    )
      ? (parsed.taskList as TaskListResponse)
      : null,
    ...(taskRevisionsValue !== undefined
      ? { taskRevisions: taskRevisionsValue }
      : {}),
    projectList:
      isObject(parsed.projectList) &&
      Array.isArray(parsed.projectList.projects) &&
      isObject(parsed.projectList.request) &&
      parsed.projectList.request.includeArchived === true
        ? (parsed.projectList as unknown as ProjectListResponse)
        : null,
    ...(projectRevisionsValue !== undefined
      ? { projectRevisions: projectRevisionsValue }
      : {}),
    worktrees: Array.isArray(parsed.worktrees)
      ? (parsed.worktrees as WorktreeRecord[])
      : null,
    ...(worktreeStatusesValue !== undefined
      ? { worktreeStatuses: worktreeStatusesValue }
      : {}),
    credentialProfileProjection:
      isObject(parsed.credentialProfileProjection) &&
      Array.isArray(parsed.credentialProfileProjection.profiles) &&
      isObject(parsed.credentialProfileProjection.modelsByProfile)
        ? (parsed.credentialProfileProjection as unknown as CredentialProfileProjection)
        : null,
  };
}

function loadAppShellCache(): AppShellCache | null {
  if (typeof window === "undefined") return null;
  try {
    return parseAppShellCache(readAppShellCacheRecord());
  } catch {
    return null;
  }
}

export function createInitialState(): UIState {
  const cache = loadAppShellCache();
  if (!cache) return emptyInitial;
  return {
    ...emptyInitial,
    hydrated: true,
    hydrationSource: "cache",
    shellCachedAt: cache.savedAt,
    models: cache.models,
    agents: cache.agents,
    // No revisions: the first snapshot replaces the live rows.
    ...sessionSlices(
      sortedByUpdatedAt(cache.sessions.filter((session) => !session.archived)),
      cache.sessions.filter((session) => session.archived),
    ),
    archivedSessionCount: cache.archivedSessionCount ?? 0,

    archivedSessionsLoaded: cache.archivedSessionsLoaded === true,
    settings: cache.settings,
    slashCommands: cache.slashCommands,
    credentialProfileProjection: cache.credentialProfileProjection ?? null,
    taskList: cache.taskList ?? null,
    projectList: cache.projectList ?? null,
    stateEventRevisions: {
      ...(cache.taskRevisions ? { tasks: cache.taskRevisions } : {}),
      ...(cache.projectRevisions ? { projects: cache.projectRevisions } : {}),
    },
    worktrees: cache.worktrees ?? null,
    cachedWorktreeStatuses: cache.worktreeStatuses ?? NO_WORKTREE_STATUSES,
  };
}

/** A Task's status and pending suggestion as last read, without its body. */
export type TaskStatusRecord = Pick<
  TaskSummary,
  "status" | "statusSuggestion" | "updatedAt"
>;

/** `taskStatuses` after a read or save of `id`; the same object when unchanged. */
function withTaskStatus(
  statuses: Record<string, TaskStatusRecord | null>,
  id: string,
  item: TaskItem | null,
): Record<string, TaskStatusRecord | null> {
  const next: TaskStatusRecord | null = item
    ? {
        status: item.status,
        updatedAt: item.updatedAt,
        ...(item.statusSuggestion
          ? { statusSuggestion: item.statusSuggestion }
          : {}),
      }
    : null;
  return id in statuses && wireValueEqual(statuses[id], next)
    ? statuses
    : { ...statuses, [id]: next };
}

/**
 * `taskStatuses` without the Tasks that LEFT the live projection — a `delete`
 * event or a digest that no longer lists them. Archived or deleted, neither
 * can tell which, so the record is dropped rather than marked gone, and a card
 * still asking about the Task reads it again.
 */
function forgetTaskStatuses(
  statuses: Record<string, TaskStatusRecord | null>,
  ids: readonly string[],
): Record<string, TaskStatusRecord | null> {
  const known = ids.filter((id) => id in statuses);
  if (known.length === 0) return statuses;
  const next = { ...statuses };
  for (const id of known) delete next[id];
  return next;
}

/**
 * Drop cached Task bodies that a newer authoritative summary supersedes.
 *
 * Entries no source mentions are KEPT. Task list payloads carry summaries only
 * (bodies are ~350 KB of Markdown that no list surface renders), so an open
 * Task's body is fetched on demand via `getTask` and legitimately has no row in
 * the session-scoped lists that also drive this — evicting on absence would
 * throw the fetched body away and loop the fetch.
 */
function reconcileTaskDetails(
  details: Record<string, LoadState<TaskItem | null>>,
  ...sources: Array<readonly (TaskSummary | TaskItem)[] | undefined>
): Record<string, LoadState<TaskItem | null>> {
  if (Object.keys(details).length === 0) return details;
  const summaryUpdatedAt = new Map<string, number>();
  for (const source of sources) {
    for (const task of source ?? []) {
      summaryUpdatedAt.set(
        task.id,
        Math.max(summaryUpdatedAt.get(task.id) ?? 0, task.updatedAt),
      );
    }
  }
  let changed = false;
  const next = { ...details };
  for (const [id, state] of Object.entries(details)) {
    const item = dataOf(state);
    if (item && item.updatedAt < (summaryUpdatedAt.get(id) ?? 0)) {
      const stale = beginLoad(state);
      if (stale !== state) {
        next[id] = stale;
        changed = true;
      }
    }
  }
  return changed ? next : details;
}

/**
 * Cache only the canonical Task list. `TaskSummary` cannot carry Markdown; the
 * lean cacheable list measured ~141 KB on the read-only production copy on
 * 2026-08-13. `descriptionPreview` accounts for ~47 KB and stays because every
 * Backlog row renders it — dropping previews would trade the cache's correct
 * first paint for payload size.
 */
function taskListForCache(
  list: TaskListResponse | null,
): TaskListResponse | null {
  return isCacheableTaskList(list) ? list : null;
}

function saveAppShellCache(state: UIState): void {
  if (typeof window === "undefined") return;
  try {
    const candidateTaskList = taskListForCache(state.taskList);
    const taskRevisions = candidateTaskList
      ? state.stateEventRevisions.tasks
      : undefined;
    // Defense in depth beyond the pending-mutation gate: a list without a
    // revision for every object cannot be settled digest state (notably, an
    // optimistic create has no server revision yet), so do not persist it.
    const taskList =
      candidateTaskList &&
      taskListHasRevisionSidecar(candidateTaskList, taskRevisions)
        ? candidateTaskList
        : null;
    const candidateProjectList = isCanonicalProjectList(state.projectList)
      ? state.projectList
      : null;
    const projectRevisions = candidateProjectList
      ? state.stateEventRevisions.projects
      : undefined;
    const projectList =
      candidateProjectList &&
      projectListHasRevisionSidecar(candidateProjectList, projectRevisions)
        ? candidateProjectList
        : null;
    const payload: AppShellCache = {
      version: 1,
      savedAt: Date.now(),
      models: state.models,
      agents: state.agents,
      sessions: normalizeCachedSessions(state.sessions),
      archivedSessionCount: state.archivedSessionCount,
      archivedSessionsLoaded: state.archivedSessionsLoaded,
      settings: state.settings,
      slashCommands: state.slashCommands,
      taskList,
      ...(taskList && taskRevisions ? { taskRevisions } : {}),
      projectList,
      ...(projectList && projectRevisions ? { projectRevisions } : {}),
      worktrees: state.worktrees,
      worktreeStatuses: cacheableWorktreeStatuses(
        state.worktreeStatuses,
        state.cachedWorktreeStatuses,
        state.worktrees,
      ),
      credentialProfileProjection: state.credentialProfileProjection,
    };
    writeAppShellCacheRecord({ ...payload });
  } catch {
    // Best-effort cache only; quota/private-mode failures should not affect use.
  }
}

/**
 * The shell cache is a cold-start accelerator, so it may lag the live state by
 * seconds; what it may not do is serialize ~217 KB on the main thread inside a
 * broadcast burst. Writes wait for a quiet second, then for an idle callback,
 * and a sustained stream still lands one write per ceiling rather than none.
 */
const SHELL_CACHE_DELAY_MS = 1_000;
const SHELL_CACHE_MAX_DELAY_MS = 15_000;
const SHELL_CACHE_IDLE_TIMEOUT_MS = 2_000;

/**
 * How long a mutation is watched for its own outcome when the server never
 * answers. Giving up only forfeits the recovery refetch — the next authoritative
 * broadcast corrects the optimistic state anyway — while waiting forever would
 * also block the shell cache, which deliberately never persists optimistic data.
 */
const MUTATION_SETTLE_TIMEOUT_MS = 30_000;
/** An archived read with no answer by then releases its flight. */
const ARCHIVED_READ_TIMEOUT_MS = 30_000;

/**
 * Clone/remove and every remote card action (merge, update-with-main, cleanup)
 * are real long operations; their settle follows COMPLETION, so the short
 * timeout would fire while the action still runs.
 */
const LONG_MUTATION_SETTLE_TIMEOUT_MS = 15 * 60_000;
/** Full Task bodies are useful on revisit but must stay bounded. */
export const TASK_PROJECTION_CACHE_LIMIT = 16;
const PROJECT_DETAIL_CACHE_LIMIT = 12;
/** Initiative reads carry a whole graph and layout, so fewer are kept. */
const INITIATIVE_DETAIL_CACHE_LIMIT = 6;

export type ProjectMutationOperation =
  | "name"
  | "description"
  | `field:${string}`
  | "reorder"
  | "archive"
  | "delete"
  | "clone"
  | "remove";

function projectMutationKey(
  id: string | null,
  operation: ProjectMutationOperation,
): string {
  return `${id ?? "registry"}:${operation}`;
}

export function projectSaveOperation(
  patch: Partial<ProjectRecord>,
): ProjectMutationOperation {
  const keys = Object.keys(patch);
  if (keys.length === 1 && keys[0] === "name") return "name";
  if (keys.length === 1 && keys[0] === "description") return "description";
  return `field:${keys.sort().join("+") || "unknown"}`;
}

export type TaskMutationOperation =
  | "create"
  | "status"
  | "edit"
  | "rename"
  | "description"
  | "reorder"
  | "assignProjects";

export function taskMutationKey(
  taskId: string | null,
  operation: TaskMutationOperation,
): string {
  return `${taskId ?? "new"}:${operation}`;
}

function taskSaveOperation(request: TaskSaveRequest): TaskMutationOperation {
  if (!request.id) return "create";
  if (request.description !== undefined) return "description";
  if (request.title !== undefined) return "rename";
  const statusFields = new Set([
    "id",
    "status",
    "clearStatusSuggestion",
    "triaged",
  ]);
  return Object.keys(request).some((field) => !statusFields.has(field))
    ? "edit"
    : "status";
}

function touchLru(lru: readonly string[], id: string): string[] {
  return [...lru.filter((entry) => entry !== id), id];
}

function pruneProjectionCache<T>(
  cache: Record<string, LoadState<T>>,
  lru: readonly string[],
  taskMutations: Record<string, LoadState<true>>,
  openTaskId: string | null,
): { cache: Record<string, LoadState<T>>; lru: string[] } {
  if (Object.keys(cache).length <= TASK_PROJECTION_CACHE_LIMIT)
    return { cache, lru: [...lru] };
  const protectedIds = new Set<string>();
  if (openTaskId) protectedIds.add(openTaskId);
  for (const [id, state] of Object.entries(cache)) {
    if (state.status === "loading" || state.status === "refreshing")
      protectedIds.add(id);
  }
  for (const [key, state] of Object.entries(taskMutations)) {
    if (state.status !== "loading" && state.status !== "refreshing") continue;
    const id = key.split(":", 1)[0];
    if (id && id !== "new") protectedIds.add(id);
  }
  const next = { ...cache };
  const order = [...lru];
  while (Object.keys(next).length > TASK_PROJECTION_CACHE_LIMIT) {
    const index = order.findIndex((id) => !protectedIds.has(id));
    if (index < 0) break;
    const [id] = order.splice(index, 1);
    if (id) delete next[id];
  }
  return { cache: next, lru: order };
}

type PendingMutationTopic = BroadcastTopic | "sessions" | "settings";

interface PendingMutationEffect {
  topic: PendingMutationTopic;
  /** Canonical ids touched in this domain. */
  objectIds: readonly string[];
}

/** The durable correlation data for one optimistic mutation. */
interface PendingMutation extends PendingMutationEffect {
  /**
   * Further domain effects of one command. Card cleanup is the first real
   * multi-domain mutation: it removes a worktree and settles its sessions.
   */
  additionalEffects?: readonly PendingMutationEffect[];
  /** Browser-local id of an optimistic create, never sent to the server. */
  tempId?: string;
}

type MutationContext =
  | (PendingMutation & {
      pullRequestCardId?: string;
      control?: { domain: "tasks" | "projects"; key?: string };
      compactionSessionId?: never;
    })
  | {
      compactionSessionId: string;
      topic?: never;
      objectIds?: never;
      tempId?: never;
      control?: never;
      pullRequestCardId?: never;
    };

type OptimisticTimelineEntry = ClientTimelineEntry & {
  optimisticSessionId?: string;
  optimisticCanMoveSession?: boolean;
};

/**
 * The transient timeline id of one send's optimistic echo. Everything that
 * reconciles or retires an echo — the durable `timelineDelta`, a re-send under
 * the same id, a failed send — finds it by this key.
 */
function optimisticEchoId(clientRequestId: string): string {
  return `creq-${clientRequestId}`;
}

/**
 * A queued prompt's unresolved states. Only these two: `completed` and `failed`
 * RESOLVE the condition rather than being one, so they retire the entry instead
 * of writing another value into it.
 */
export type PromptQueueState = "queued" | "working";

/** Set, replace or retire one row's queue condition, keeping identity when nothing moves. */
function withPromptQueueState(
  states: Record<string, PromptQueueState>,
  rowId: string,
  state: PromptQueueState | null,
): Record<string, PromptQueueState> {
  if ((states[rowId] ?? null) === state) return states;
  const next = { ...states };
  if (state) next[rowId] = state;
  else delete next[rowId];
  return next;
}

type Action =
  | { kind: "status"; connected: boolean }
  | {
      kind: "server";
      msg: ServerMessage;
      /**
       * Set when this failure is a tracked mutation's, so the control that was
       * refused already renders it and the object must not keep a second copy.
       * Stated by the socket handler, which is where the request id is
       * correlated — the arrival, not a later reading of the store.
       */
      controlOwned?: boolean;
    }
  | {
      kind: "credentialProfileProjection";
      projection: CredentialProfileProjection;
    }
  | {
      kind: "optimisticTaskSave";
      request: TaskSaveRequest;
      tempId: string;
      now: number;
    }
  | {
      kind: "optimisticTaskProjectAssignment";
      updates: TaskProjectAssignmentUpdate[];
      now: number;
    }
  /** Archive or delete: both leave the live projection, which is one row removal. */
  | { kind: "optimisticTaskRemove"; id: string }
  | { kind: "optimisticTaskReorder"; placements: TaskReorderPlacement[] }
  | { kind: "taskDetailLoad"; id: string }
  | {
      kind: "taskDetailResult";
      id: string;
      item: TaskItem | null;
      revision?: number;
      error?: string;
    }
  | { kind: "unwatchComments"; target: CommentTarget }
  | { kind: "taskMutationStart"; key: string }
  | { kind: "taskMutationResult"; key: string; error?: string }
  | { kind: "taskMutationRelease"; key: string }
  | { kind: "setOpenTaskProjection"; id: string | null }
  /**
   * The server's direct answer to `saveTask`, carrying the temp id its pending
   * entry recorded (the wire message never does — the server has no temp ids).
   */
  | { kind: "taskSaved"; item: TaskItem; revision?: number; tempId?: string }
  | {
      kind: "optimisticProjectSave";
      id: string;
      patch: Partial<ProjectRecord>;
      now: number;
    }
  | {
      kind: "optimisticProjectReorder";
      placements: Array<{ id: string; parentId?: string | null }>;
    }
  | { kind: "projectDetailLoad"; id: string }
  | {
      kind: "projectDetailResult";
      id: string;
      item: ProjectRecord | null;
      revision?: number;
      error?: string;
    }
  | { kind: "projectSaved"; item: ProjectRecord; revision: number }
  /** A complete answer to an item fetch the replica transport opened. */
  | {
      kind: "replicaItems";
      purpose: RequestPurpose;
      msg: Extract<
        ServerMessage,
        { type: "stateItems"; topic: "tasks" | "projects" | "initiatives" }
      >;
    }
  /** A recovery that could not complete: its rows lose their held revision. */
  | {
      kind: "replicaBaselineLost";
      topic: BroadcastTopic;
      ids: readonly string[];
    }
  | { kind: "setOpenProjectProjection"; id: string | null }
  | { kind: "initiativeDetailLoad"; id: string }
  | {
      kind: "initiativeDetailResult";
      id: string;
      read: InitiativeRead | null;
      revision?: number;
      error?: string;
    }
  | { kind: "setOpenInitiative"; id: string | null }
  | { kind: "initiativeDetailPin"; id: string; delta: 1 | -1 }
  | { kind: "initiativeListRetry" }
  /** An `initiatives` subscribe went out: subscribing is the list read. */
  | { kind: "initiativeListSubscribed" }
  /** The Initiative list could not be read: a condition on that list alone. */
  | { kind: "initiativeListFailed"; message: string }
  | { kind: "projectMutationStart"; key: string }
  | { kind: "projectMutationResult"; key: string; error?: string }
  | { kind: "projectMutationRelease"; key: string }
  | { kind: "worktreeListLoad" }
  /** A library subscribe went out: the server is scanning that library now. */
  | { kind: "libraryLoad"; library: LibraryTopic }
  /** A model refresh went out; the `models` echoing this id retires it. */
  | { kind: "modelsRefreshSent"; requestId: string }
  /**
   * A skill toggle write went out carrying this whole map. Records the BASE for
   * the next one; deliberately does NOT touch `settings`, so nothing renders as
   * enabled before the echo.
   */
  | { kind: "skillTogglesSent"; requestId: string; skills: SkillToggles }
  /**
   * A skill toggle write was ANSWERED — settled, refused, or never answered at
   * all. Named by request: only the newest write's own answer retires the base.
   */
  | { kind: "skillTogglesAnswered"; requestId: string }
  | {
      kind: "optimisticSessionRename";
      sessionId: string;
      title: string;
      now: number;
    }
  /** Take over a spawned peer, or hand it back to its coordinator. */
  | {
      kind: "optimisticSpawnOwnership";
      sessionId: string;
      ownership: SettableSpawnOwnership;
    }
  /**
   * A Settle on a session: the row itself, plus — when settling — the peers it
   * still coordinates, shelved in ONE dispatch so none of them surfaces as a
   * card of its own before the authoritative list lands.
   */
  | {
      kind: "optimisticSessionSettle";
      sessionId: string;
      settled: boolean;
      /** The coordinated peers shelved with it; empty when unsettling. */
      peerSessionIds: string[];
      now: number;
    }
  /**
   * A Settle on a Workflow Run (Task-677): the run's cursor is acknowledged
   * and the role sessions it names are shelved in ONE dispatch, so the roles
   * never surface as cards of their own in the gap between the two lists the
   * server answers with.
   */
  | {
      kind: "optimisticWorkflowRunSettle";
      runId: string;
      /** The revision the click saw; the optimistic row acknowledges no more. */
      throughRevision: number;
      sessionIds: string[];
      now: number;
    }
  /** The inspector sent a compaction-window save for a session. */
  | { kind: "compactionWindowRequested"; sessionId: string; requestId: string }
  /** That save was answered: settled, refused, or left unanswered. */
  | {
      kind: "compactionWindowAnswered";
      sessionId: string;
      requestId: string;
      error?: string;
      unknown?: true;
    }
  /**
   * Sessions inbox items dragged to a new place: sessions and runs in ONE
   * dispatch, since a renumbering places both and the list must not show a
   * half-applied order.
   */
  | { kind: "optimisticInboxPositions"; positions: InboxPositionEntry[] }
  | { kind: "optimisticSessionDelete"; sessionId: string }
  /** Opening the shelf or a recovery: an archived read is due. */
  | { kind: "archivedReadRequested" }
  /** The scheduler sent the due archived read under `requestId`. */
  | { kind: "archivedReadSent"; requestId: string }
  /** That read's error or timeout: it no longer holds the flight. */
  | { kind: "archivedReadReleased"; requestId: string }

  /** A human Stop left this browser; the server's answer retires it. */
  | { kind: "backgroundStopSent"; itemId?: string; ownerSessionId?: string }
  | { kind: "optimisticWorktreeRemove"; worktreeId: string }
  | {
      kind: "optimisticPullRequestCardAction";
      cardId: string;
      action: PullRequestCardAction;
    }
  | {
      kind: "pullRequestCardActionResult";
      cardId: string;
      /** Restore a competing server action after this click lost the gate. */
      authoritativeCard?: PullRequestCard;
      error?: string;
    }
  /** A delivery control on a Workflow card was pressed; the click owns it now. */
  | {
      kind: "optimisticWorkflowDelivery";
      runId: string;
      action: WorkflowDeliveryAction;
    }
  /**
   * The server answered this browser's delivery click — with a refusal, a
   * settle, or by never answering at all. Either way the click stops owning
   * the control: what the action came to is the card's to state from here.
   */
  | { kind: "workflowDeliveryResult"; runId: string; error?: string }
  /** Drop one consumed `startWorkflowRun` entry so the map stays bounded. */
  | { kind: "clearWorkflowRunStart"; requestId: string }
  | {
      kind: "optimisticUserMessage";
      clientRequestId: string;
      text: string;
      /** File attachments, by reference: their previews are remembered apart. */
      images?: { name: string; mimeType: string; size: number; ref: string }[];
      sessionId?: string;
      canMoveSession?: boolean;
    }
  | { kind: "optimisticSettings"; patch: Partial<AppSettings> }
  | { kind: "clearChatError"; sessionId?: string }
  | { kind: "clearSessionFailure"; sessionId: string }
  | { kind: "clearObjectFailure"; type: ObjectFailureType; id: string }
  | { kind: "clearWorktreeProvision" }
  /** A "load earlier" range was asked for; the answer clears it (or is dropped). */
  | { kind: "timelineRangeRequested"; beforeSeq: number }
  /** A jump was asked for; the matching `timelineAnchor` answers it. */
  | {
      kind: "revealRequested";
      requestId: string;
      target: TimelineAnchorTarget;
    }
  /** A jump is over — landed on, or given up on. Nothing may act on it again. */
  | { kind: "revealSettled"; token: number }
  /** A staged session draft reached the composer; it must never be staged again. */
  | { kind: "sessionDraftConsumed"; token: number }
  | { kind: "sessionDraftStaged"; sessionId: string; text: string };

function shouldFrameBatchServerMessage(msg: ServerMessage): boolean {
  // Hot-path streaming events can arrive faster than the browser should paint.
  // Batch the per-token / tool-output deltas to the next animation frame so a
  // burst becomes one React commit while non-streaming state changes stay
  // immediate. (All chat deltas now ride the runtime-native `event` channel.)
  return (
    msg.type === "event" &&
    (msg.event.type === "messageDelta" ||
      msg.event.type === "liveBodyProgress" ||
      msg.event.type === "liveBody")
  );
}

function compactFrameMessages(messages: ServerMessage[]): ServerMessage[] {
  const compacted: ServerMessage[] = [];
  for (const msg of messages) {
    const last = compacted[compacted.length - 1];
    // Coalesce consecutive same-stream message deltas (and collapse tool-output
    // updates to the latest) so one frame applies a single merged delta.
    if (
      msg.type === "event" &&
      msg.event.type === "messageDelta" &&
      last?.type === "event" &&
      last.event.type === "messageDelta" &&
      msg.sessionId === last.sessionId &&
      msg.event.streamId === last.event.streamId &&
      msg.event.delta.kind === last.event.delta.kind
    ) {
      last.event = {
        ...last.event,
        delta: {
          kind: last.event.delta.kind,
          text: last.event.delta.text + msg.event.delta.text,
        },
      };
      continue;
    }
    if (
      msg.type === "event" &&
      msg.event.type === "liveBodyProgress" &&
      last?.type === "event" &&
      last.event.type === "liveBodyProgress" &&
      msg.sessionId === last.sessionId &&
      liveBodyKeyId(msg.event.ref) === liveBodyKeyId(last.event.ref)
    ) {
      last.event = msg.event;
      continue;
    }
    if (
      msg.type === "event" &&
      msg.event.type === "liveBody" &&
      msg.event.mode === "append" &&
      typeof msg.event.content === "string" &&
      last?.type === "event" &&
      last.event.type === "liveBody" &&
      typeof last.event.content === "string" &&
      msg.sessionId === last.sessionId &&
      liveBodyKeyId(msg.event.key) === liveBodyKeyId(last.event.key) &&
      msg.event.offset === last.event.length
    ) {
      last.event = {
        ...last.event,
        content: last.event.content + msg.event.content,
        length: msg.event.length,
        ...(msg.event.lineCount !== undefined
          ? { lineCount: msg.event.lineCount }
          : {}),
      };
      continue;
    }
    compacted.push(msg);
  }
  return compacted;
}

/**
 * Optimistically show the user's prompt the instant it's sent (a transient user
 * timeline entry id `creq-<clientRequestId>`); the server's durable user
 * `timelineDelta` echoes the same clientRequestId and reconciles it. File
 * attachments ride along as image blocks — their bytes are still uploading, and
 * this echo is what shows the user they are attached (an attachments-only
 * prompt echoes too). No-op only for a prompt with neither.
 */
function optimisticUserEcho(
  dispatch: (action: Action) => void,
  clientRequestId: string,
  text: string,
  sessionId?: string,
  canMoveSession = false,
  attachments: readonly PromptAttachment[] = [],
): void {
  const trimmed = text.trim();
  const images = attachments
    .filter((a) => !a.role)
    .map(({ name, mimeType, size, data }, index) => {
      const ref = optimisticAttachmentRef(clientRequestId, index);
      if (mimeType.startsWith("image/") && data)
        rememberAttachmentPreview(ref, mimeType, data);
      return { name, mimeType, size, ref };
    });
  if (!trimmed && images.length === 0) return;
  dispatch({
    kind: "optimisticUserMessage",
    clientRequestId,
    text: trimmed,
    ...(images.length ? { images } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    canMoveSession,
  });
}

/**
 * Recompute the derived chat view (`messages` + streaming flags) from the
 * runtime-native source of truth (timeline + optimistic + in-flight streams +
 * runState), via the shared projection. `messages` is never mutated directly;
 * every chat update flows through here so the keyed model stays authoritative.
 */
/**
 * Per-entry projection cache for the chat (see `@assistant/shared/display`).
 *
 * Module-level, because the reducer is a module function and this is a cache
 * rather than state: it is keyed on entry IDENTITY, so a hit can only ever
 * return an object equal to what a rebuild would produce. That makes re-running
 * the reducer idempotent (React may), and makes a stale or foreign key cost a
 * miss rather than a wrong answer — including across a session switch, whose
 * entries are pruned on the next projection anyway.
 */
const chatProjectionCache = createDisplayProjectionCache();

function withChat(
  state: UIState,
  patch: Partial<
    Pick<
      UIState,
      | "timeline"
      | "liveStreams"
      | "optimistic"
      | "approvals"
      | "pullRequestCards"
      | "runState"
      | "worktreeProvision"
    >
  >,
): UIState {
  const timeline = patch.timeline ?? state.timeline;
  const liveStreams = patch.liveStreams ?? state.liveStreams;
  const optimistic = patch.optimistic ?? state.optimistic;
  const approvals = patch.approvals ?? state.approvals;
  const pullRequestCards = patch.pullRequestCards ?? state.pullRequestCards;
  const runState = patch.runState ?? state.runState;
  const worktreeProvision =
    patch.worktreeProvision !== undefined
      ? patch.worktreeProvision
      : state.worktreeProvision;
  const base = entriesToDisplayMessages(
    [...timeline, ...optimistic],
    liveStreams,
    chatProjectionCache,
    // Fork affordances are a harness rule (see the shared projection). The
    // viewed session is already patched into `state` by every caller, so
    // this reads the session the timeline belongs to, not the previous one.
    state.session ? { harness: state.session.harness } : {},
  );
  const loadedFrom = loadedHistoryStart(base, state.timelineStart);
  const messages = mergeProvisionMessage(
    placeCardRows(base, [...approvals, ...pullRequestCards], loadedFrom),
    worktreeProvision,
  );
  const streamingMessageId = messages.find((m) => m.streaming)?.id ?? null;
  return {
    ...state,
    // Progress belongs to a running run and ends with it, however it ends.
    runProgress: runState === "idle" ? null : state.runProgress,
    timeline,
    liveStreams,
    optimistic,
    approvals,
    pullRequestCards,
    runState,
    worktreeProvision,
    messages,
    streaming: runState === "running",
    streamingMessageId,
  };
}

/**
 * Id of the live worktree-provisioning card message. Stable and exported: the
 * staged new-session transcript renders an explicit id set (this browser's own
 * optimistic rows), so it has to be able to name this one.
 */
export const WORKTREE_PROVISION_MESSAGE_ID = "worktree-provision";

/**
 * The card message for the provision it was built from, so an unrelated chat
 * update (the optimistic prompt echo landing, say) hands back the SAME object
 * and leaves the memoized transcript row alone — the same reason the per-entry
 * projection cache exists.
 */
let provisionMessageCache: {
  provision: LiveWorktreeProvision;
  message: DisplayMessage;
} | null = null;

/**
 * Put the in-flight worktree-provisioning card at the TOP of the chat: the
 * checkout precedes the session it is being created for, which is also where
 * the server's durable genesis card lands once the session exists.
 */
function mergeProvisionMessage(
  messages: DisplayMessage[],
  provision: LiveWorktreeProvision | null,
): DisplayMessage[] {
  if (!provision) return messages;
  if (provisionMessageCache?.provision !== provision) {
    const { clientRequestId: _clientRequestId, ...display } = provision;
    provisionMessageCache = {
      provision,
      message: {
        id: WORKTREE_PROVISION_MESSAGE_ID,
        role: "assistant",
        blocks: [{ kind: "worktreeProvision", provision: display }],
      },
    };
  }
  return [provisionMessageCache.message, ...messages];
}

/** Insert or replace a durable timeline entry by id, keeping the list sorted by seq. */
function upsertEntry(
  timeline: ClientTimelineEntry[],
  entry: ClientTimelineEntry,
): ClientTimelineEntry[] {
  const idx = timeline.findIndex((e) => e.id === entry.id);
  const next =
    idx >= 0
      ? timeline.map((e, i) => (i === idx ? entry : e))
      : [...timeline, entry];
  return next.slice().sort((a, b) => a.seq - b.seq);
}

/** Append a text token delta to an in-flight assistant message's content. */
function appendContentDelta(
  content: AgentContentBlock[],
  delta: { kind: "text"; text: string },
): AgentContentBlock[] {
  const last = content[content.length - 1];
  if (last && last.type === delta.kind) {
    return content.map((c, i) =>
      i === content.length - 1 && c.type === "text"
        ? { ...c, text: c.text + delta.text }
        : c,
    );
  }
  return [...content, { type: delta.kind, text: delta.text }];
}

/**
 * Record a live thinking block's ref on the in-flight message: the block is
 * created (empty) the first time its ref arrives, so the transcript renders its
 * collapsed header at its true position; its text only ever arrives through
 * `liveBody` frames the viewer asked for.
 */
function applyThinkingProgress(
  content: AgentContentBlock[],
  ref: LiveBodyRef,
): AgentContentBlock[] {
  const existing = content[ref.blockIndex];
  if (existing?.type === "thinking")
    return content.map((c, i) =>
      i === ref.blockIndex && c.type === "thinking" ? { ...c, live: ref } : c,
    );
  if (ref.blockIndex !== content.length) return content;
  return [...content, { type: "thinking", text: "", live: ref }];
}

/** Apply one `liveBody` frame to a hydrated string, or null when it does not join. */
function applyBodyFrame(
  current: string,
  frame: Extract<ClientRuntimeEvent, { type: "liveBody" }>,
): string | null {
  if (typeof frame.content !== "string") return null;
  if (frame.mode === "replace") return frame.content;
  // An append that does not continue what this viewer holds is out of sync
  // (a frame from before a resubscribe, say) and is dropped: the next
  // snapshot or resubscribe replaces the body whole.
  if (frame.offset !== current.length) return null;
  return current + frame.content;
}

function applyLiveBody(
  streams: StreamingEntry[],
  frame: Extract<ClientRuntimeEvent, { type: "liveBody" }>,
): StreamingEntry[] {
  const { key } = frame;
  return streams.map((s) => {
    if (key.kind === "thinking") {
      if (s.streamId !== key.streamId || s.kind !== "message") return s;
      const block = s.content[key.blockIndex];
      if (block?.type !== "thinking") return s;
      const text = applyBodyFrame(block.text, frame);
      if (text === null) return s;
      return {
        ...s,
        content: s.content.map((c, i) =>
          i === key.blockIndex && c.type === "thinking"
            ? {
                ...c,
                text,
                ...(c.live
                  ? {
                      live: {
                        ...c.live,
                        length: frame.length,
                        ...(frame.lineCount !== undefined
                          ? { lineCount: frame.lineCount }
                          : {}),
                      },
                    }
                  : {}),
              }
            : c,
        ),
      };
    }
    if (key.kind === "toolInput") {
      // The call is declared in the message stream AND carried by its tool
      // stream (both keyed by the call id); hydrate wherever it is summarized.
      if (s.kind === "message")
        return {
          ...s,
          content: s.content.map((c) =>
            c.type === "toolCall" &&
            c.inputLive &&
            (c.inputLive.streamId === key.streamId ||
              c.toolCallId === key.streamId)
              ? withoutLiveInput(c, frame.content)
              : c,
          ),
        };
      if (
        s.inputLive &&
        (s.streamId === key.streamId || s.toolCallId === key.streamId)
      ) {
        const { inputLive: _inputLive, inputSummary: _summary, ...rest } = s;
        return { ...rest, input: frame.content };
      }
      return s;
    }
    if (s.kind !== "tool") return s;
    if (s.streamId !== key.streamId && s.toolCallId !== key.streamId) return s;
    const output = applyBodyFrame(s.output ?? "", frame);
    return output === null
      ? s
      : {
          ...s,
          output,
          ...(s.outputLive
            ? {
                outputLive: {
                  ...s.outputLive,
                  length: frame.length,
                  ...(frame.lineCount !== undefined
                    ? { lineCount: frame.lineCount }
                    : {}),
                },
              }
            : {}),
        };
  });
}

function withoutLiveInput(
  block: Extract<AgentContentBlock, { type: "toolCall" }>,
  input: unknown,
): AgentContentBlock {
  const { inputLive: _inputLive, inputSummary: _summary, ...rest } = block;
  return { ...rest, input };
}

function jsonBodyHash(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : bodyContentHash(serialized);
  } catch {
    return undefined;
  }
}

/**
 * A declaring correction uses the SAME lazy projection a reconnect would send,
 * but this viewer may already hold an exact body from a one-shot load. Preserve
 * those bodies so an expanded block never flashes back to its preview.
 */
function carryHydratedBodies(
  entry: ClientTimelineEntry,
  existing: ClientTimelineEntry | undefined,
): ClientTimelineEntry {
  if (
    entry.type !== "message" ||
    entry.role !== "assistant" ||
    existing?.type !== "message" ||
    existing.role !== "assistant"
  )
    return entry;

  let changed = false;
  const content = entry.content.map((block, index) => {
    const previous = existing.content[index];
    if (
      block.type === "thinking" &&
      block.lazy &&
      previous?.type === "thinking" &&
      !previous.lazy &&
      block.lazy.contentHash === bodyContentHash(previous.text)
    ) {
      changed = true;
      const { lazy: _lazy, ...rest } = block;
      return { ...rest, text: previous.text };
    }
    if (block.type !== "toolCall" || !block.inputLazy) return block;
    const previousCall = existing.content.find(
      (
        candidate,
      ): candidate is Extract<AgentContentBlock, { type: "toolCall" }> =>
        candidate.type === "toolCall" &&
        candidate.toolCallId === block.toolCallId,
    );
    if (
      !previousCall ||
      previousCall.inputLazy ||
      block.inputLazy.contentHash === undefined ||
      jsonBodyHash(previousCall.input) !== block.inputLazy.contentHash
    )
      return block;
    changed = true;
    const {
      inputLazy: _inputLazy,
      inputSummary: _inputSummary,
      ...rest
    } = block;
    return { ...rest, input: previousCall.input };
  });
  return changed ? { ...entry, content } : entry;
}

/**
 * A durable entry replaces the stream it came from with the SAME lazy
 * projection a reconnect would send. Carry a hydrated live body only when the
 * durable reference verifies its content identity; otherwise the persisted
 * body remains authoritative and is loaded on demand.
 */
function carryLiveBodies(
  entry: ClientTimelineEntry,
  streams: readonly StreamingEntry[],
): ClientTimelineEntry {
  if (entry.type !== "message") return entry;
  if (entry.role === "assistant") {
    const live = streams.find((s) => s.kind === "message");
    const tools = streams.filter((s) => s.kind === "tool");
    let changed = false;
    const content = entry.content.map((block, i) => {
      if (block.type === "thinking" && block.lazy) {
        const source = live?.content[i];
        if (
          source?.type === "thinking" &&
          source.live &&
          block.lazy.contentHash !== undefined &&
          bodyContentHash(source.text) === block.lazy.contentHash
        ) {
          changed = true;
          const { lazy: _lazy, ...rest } = block;
          return { ...rest, text: source.text };
        }
      }
      if (block.type === "toolCall" && block.inputLazy) {
        // A hydrated live input IS the call's input: the summary came off it.
        const declared = live?.content.find(
          (c): c is Extract<AgentContentBlock, { type: "toolCall" }> =>
            c.type === "toolCall" && c.toolCallId === block.toolCallId,
        );
        const stream = tools.find((t) => t.toolCallId === block.toolCallId);
        const source =
          declared && !declared.inputLive
            ? declared.input
            : stream && !stream.inputLive
              ? stream.input
              : undefined;
        if (
          source !== undefined &&
          block.inputLazy.contentHash !== undefined &&
          jsonBodyHash(source) === block.inputLazy.contentHash
        ) {
          changed = true;
          const { inputLazy: _lazy, inputSummary: _summary, ...rest } = block;
          return { ...rest, input: source };
        }
      }
      return block;
    });
    return changed ? { ...entry, content } : entry;
  }
  if (entry.role === "toolResult") {
    const stream = streams.find(
      (s) => s.kind === "tool" && s.toolCallId === entry.toolCallId,
    );
    if (stream?.kind !== "tool" || stream.output === undefined) return entry;
    let changed = false;
    const content = entry.content.map((block) => {
      if (
        block.type === "text" &&
        block.lazy &&
        stream.output !== undefined &&
        block.lazy.contentHash !== undefined &&
        bodyContentHash(stream.output) === block.lazy.contentHash
      ) {
        changed = true;
        const { lazy: _lazy, ...rest } = block;
        return { ...rest, text: stream.output };
      }
      return block;
    });
    return changed ? { ...entry, content } : entry;
  }
  return entry;
}

/** Apply one runtime-native event to the keyed chat state. */
function applyRuntimeEvent(state: UIState, event: ClientRuntimeEvent): UIState {
  switch (event.type) {
    case "messageStarted":
      return withChat(state, {
        liveStreams: [
          ...state.liveStreams,
          {
            streamId: event.streamId,
            kind: "message",
            role: "assistant",
            content: [],
          },
        ],
      });
    case "messageDelta":
      return withChat(state, {
        liveStreams: state.liveStreams.map((s) =>
          s.streamId === event.streamId && s.kind === "message"
            ? { ...s, content: appendContentDelta(s.content, event.delta) }
            : s,
        ),
      });
    case "liveBodyProgress": {
      const { ref } = event;
      return withChat(state, {
        liveStreams: state.liveStreams.map((s) => {
          if (ref.kind === "thinking")
            return s.streamId === ref.streamId && s.kind === "message"
              ? { ...s, content: applyThinkingProgress(s.content, ref) }
              : s;
          if (ref.kind !== "toolOutput" || s.kind !== "tool") return s;
          return s.streamId === ref.streamId || s.toolCallId === ref.streamId
            ? { ...s, outputLive: ref }
            : s;
        }),
      });
    }
    case "liveBody":
      return withChat(state, {
        liveStreams: applyLiveBody(state.liveStreams, event),
      });
    case "messageCompleted":
      // Keep the completed assistant stream visible until the durable assistant
      // entry arrives. The server emits messageCompleted before the delta;
      // removing the stream here creates a brief vanish/reappear handoff gap.
      return state;
    case "toolStarted": {
      // Record the tool call in the active message stream's content IN ORDER so it
      // renders at its true position (e.g. a tool that precedes later text shows
      // ABOVE it, matching the durable entry — not pushed below the streamed text).
      // The separate tool stream carries live output, merged back by id in the
      // projection. Appending to the (single) open message stream is a no-op when
      // the tool opened before any message stream (then it renders as a fallback).
      const inputFields = {
        input: event.input,
        ...(event.inputSummary !== undefined
          ? { inputSummary: event.inputSummary }
          : {}),
        ...(event.inputLive !== undefined
          ? { inputLive: event.inputLive }
          : {}),
      };
      const withCall = state.liveStreams.map((s) =>
        s.kind === "message"
          ? {
              ...s,
              content: [
                ...s.content,
                {
                  type: "toolCall" as const,
                  toolCallId: event.toolCallId,
                  name: event.name,
                  ...inputFields,
                },
              ],
            }
          : s,
      );
      return withChat(state, {
        liveStreams: [
          ...withCall,
          {
            streamId: event.streamId,
            kind: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            ...inputFields,
            output: "",
            outputLive: {
              streamId: event.streamId,
              blockIndex: 0,
              kind: "toolOutput",
              length: 0,
            },
          },
        ],
      });
    }
    case "toolEnded":
      // Stop the spinner before the durable result lands. A rich-card frame is
      // authoritative inline data, so discard any subscribed body and its live
      // ref rather than retaining stale text or hydrating the same body twice.
      return withChat(state, {
        liveStreams: state.liveStreams.map((s) => {
          if (
            s.kind === "message" &&
            event.card &&
            Object.hasOwn(event, "input")
          )
            return {
              ...s,
              content: s.content.map((block) => {
                if (
                  block.type !== "toolCall" ||
                  block.toolCallId !== event.streamId
                )
                  return block;
                const {
                  inputLive: _inputLive,
                  inputSummary: _inputSummary,
                  ...call
                } = block;
                return { ...call, input: event.input };
              }),
            };
          if (
            s.kind !== "tool" ||
            (s.streamId !== event.streamId && s.toolCallId !== event.streamId)
          )
            return s;
          if (event.card) {
            const {
              outputLive: _outputLive,
              inputLive: _inputLive,
              ...inline
            } = s;
            let withInput = inline;
            if (Object.hasOwn(event, "input")) {
              const { inputSummary: _inputSummary, ...withoutSummary } = inline;
              withInput = { ...withoutSummary, input: event.input };
            }
            return {
              ...withInput,
              output: typeof event.output === "string" ? event.output : "",
              isError: event.isError,
              done: true,
            };
          }
          return {
            ...s,
            ...(typeof event.output === "string"
              ? { output: event.output }
              : { outputLive: event.output }),
            isError: event.isError,
            done: true,
          };
        }),
      });
    case "toolCompleted":
      // Keep the completed tool stream as a short-lived overlay until the durable
      // toolResult entry arrives. Otherwise the UI can briefly fall back to the
      // durable assistant tool block with done=false between the two frames,
      // making a completed tool spinner appear stuck.
      return withChat(state, {
        liveStreams: state.liveStreams.map((s) =>
          s.streamId === event.streamId && s.kind === "tool"
            ? { ...s, done: true }
            : s,
        ),
      });
    case "timelineDelta": {
      let next = state;
      let timeline = state.timeline;
      let liveStreams = state.liveStreams;
      let optimistic = state.optimistic;
      for (const entry of event.entries) {
        const reconciledEchoId =
          entry.type === "message" &&
          entry.role === "user" &&
          event.clientRequestId
            ? optimisticEchoId(event.clientRequestId)
            : null;
        if (reconciledEchoId) {
          optimistic = optimistic.filter((o) => o.id !== reconciledEchoId);
          // The echo hands its queue condition over here: the durable entry
          // only exists once the queued prompt has actually started running,
          // and from now on the transcript's own run state says so.
          next = {
            ...next,
            error: null,
            promptQueueStates: withPromptQueueState(
              next.promptQueueStates,
              reconciledEchoId,
              null,
            ),
          };
        }
        const existing = timeline.find((current) => current.id === entry.id);
        timeline = upsertEntry(
          timeline,
          carryHydratedBodies(carryLiveBodies(entry, liveStreams), existing),
        );
        if (entry.type !== "message") continue;
        if (entry.role === "toolResult") {
          const toolCallId = entry.toolCallId;
          liveStreams = liveStreams.filter(
            (s) => !(s.kind === "tool" && s.toolCallId === toolCallId),
          );
        } else if (entry.role === "assistant") {
          liveStreams = liveStreams.filter((s) => s.kind !== "message");
        }
      }
      return withChat(next, { timeline, optimistic, liveStreams });
    }
    case "hostCommandAppended":
      // The synthetic streams are replaced by the durable card; clear them. If a
      // live passthrough card was shown first, drop that transient placeholder so
      // the reconnect-stable durable entry becomes the single rendered card.
      return withChat(state, {
        timeline: upsertEntry(
          removeTransientHostCommand(state.timeline, event.entry.card.id),
          event.entry,
        ),
        liveStreams: [],
      });
    case "runProgress":
      // Not through `withChat`: progress moves no transcript row.
      if (state.runState !== "running") return state;
      return {
        ...state,
        runProgress: { progress: event.progress, receivedAt: Date.now() },
      };
    case "runStateChanged":
      return withChat(state, {
        runState: event.runState,
        ...(event.runState === "idle" ? { liveStreams: [] } : {}),
      });
    case "runStatus": {
      const message =
        event.message ??
        (event.status === "aborted" ? "Run aborted." : "Run failed.");
      // The OUTCOME only. What the user is told about it was decided when this
      // event landed (`lib/messageArrival.ts`); repeating it here as a message
      // is what made the outcome look like an announcement waiting to be made.
      const base =
        event.status === "error" ? { ...state, error: message } : state;
      return withChat(base, { liveStreams: [], runState: "idle" });
    }
    case "passthrough":
      return applyPassthrough(state, event.envelope);
    case "sessionConfigChanged":
      // Model/reasoning reach the client via the rich `state` envelope.
      return state;
  }
}

/**
 * A verbatim wire envelope forwarded inside a runtime event: the live
 * host-command result cards. (A tool's live completion is the compact
 * `toolEnded` event; the commit/compaction cards also arrive durably via
 * `hostCommandAppended`.)
 */
function applyPassthrough(state: UIState, envelope: ServerMessage): UIState {
  if (
    envelope.type === "commitResult" ||
    envelope.type === "pushResult" ||
    envelope.type === "compactionResult" ||
    envelope.type === "contextClearResult" ||
    envelope.type === "worktreeProvisionResult"
  ) {
    const entry = transientHostCommandEntry(envelope);
    return entry
      ? withChat(state, {
          timeline: upsertEntry(
            removeTransientHostCommand(state.timeline, entry.card.id),
            entry,
          ),
          liveStreams: [],
        })
      : state;
  }
  return state;
}

function transientHostCommandEntry(
  envelope: ServerMessage,
): HostCommandClientEntry | null {
  if (envelope.type === "commitResult") {
    return {
      id: `transient-command-${envelope.id}`,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "command.result",
      name: "commit",
      card: { kind: "commit", id: envelope.id, commit: envelope.commit },
    };
  }
  if (envelope.type === "pushResult") {
    return {
      id: `transient-command-${envelope.id}`,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "command.result",
      name: "push",
      card: { kind: "push", id: envelope.id, push: envelope.push },
    };
  }
  if (envelope.type === "compactionResult") {
    return {
      id: `transient-command-${envelope.id}`,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "command.result",
      name: "compaction",
      card: {
        kind: "compaction",
        id: envelope.id,
        compaction: envelope.compaction,
      },
    };
  }
  if (envelope.type === "contextClearResult") {
    return {
      id: `transient-command-${envelope.id}`,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "command.result",
      name: "contextClear",
      card: {
        kind: "contextClear",
        id: envelope.id,
        contextClear: envelope.contextClear,
      },
    };
  }
  if (envelope.type === "worktreeProvisionResult") {
    return {
      id: `transient-command-${envelope.id}`,
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "command.result",
      name: "worktree",
      card: {
        kind: "worktreeProvision",
        id: envelope.id,
        provision: envelope.provision,
      },
    };
  }
  return null;
}

function removeTransientHostCommand(
  timeline: ClientTimelineEntry[],
  cardId: string,
): ClientTimelineEntry[] {
  return timeline.filter((entry) => {
    if (entry.type !== "command.result") return true;
    return !(
      entry.id.startsWith("transient-command-") && entry.card.id === cardId
    );
  });
}

function optimisticForSnapshot(
  optimistic: OptimisticTimelineEntry[],
  snapshotSessionId: string,
  timeline: ClientTimelineEntry[],
): OptimisticTimelineEntry[] {
  if (optimistic.length === 0) return [];
  const snapshotEmpty = timeline.length === 0;
  const durableUserTexts = new Set(
    timeline
      .filter(
        (entry) =>
          entry.type !== "command.result" &&
          entry.role === "user" &&
          !entry.hidden,
      )
      .map((entry) => userEntryText(entry).trim())
      .filter(Boolean),
  );
  return optimistic.filter((entry) => {
    const sameSession =
      !entry.optimisticSessionId ||
      entry.optimisticSessionId === snapshotSessionId;
    const movedToServerMintedSession =
      snapshotEmpty && entry.optimisticCanMoveSession;
    if (!sameSession && !movedToServerMintedSession) return false;
    const text = userEntryText(entry).trim();
    return Boolean(text && !durableUserTexts.has(text));
  });
}

function userEntryText(entry: ClientTimelineEntry): string {
  if (entry.type === "command.result" || entry.role !== "user") return "";
  return entry.content
    .filter(
      (block): block is Extract<AgentContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

interface ApprovalGrantsState {
  sessionId: string;
  grants: import("@assistant/shared").ApprovalGrant[];
  inherited: import("@assistant/shared").InheritedApprovalGrant[];
  inheritance?: import("@assistant/shared").ApprovalGrantInheritance;
}

/** Whether two grant lists say the same thing, in the same order. */
function sameGrantList(
  a: readonly (import("@assistant/shared").ApprovalGrant & {
    heldBy?: string;
  })[],
  b: readonly (import("@assistant/shared").ApprovalGrant & {
    heldBy?: string;
  })[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (grant, index) =>
        grant.key === b[index]!.key &&
        grant.grantedAt === b[index]!.grantedAt &&
        grant.sourceApprovalId === b[index]!.sourceApprovalId &&
        grant.inheritable === b[index]!.inheritable &&
        grant.heldBy === b[index]!.heldBy,
    )
  );
}

/**
 * An `approvalGrants` frame applied by CONTENT: each list keeps its previous
 * array object while it says the same thing, and an identical frame returns
 * `prev` itself. The own list reaches every approval card in the transcript,
 * so a frame that only changed what an ancestor holds must not redraw them.
 */
function reconcileApprovalGrants(
  prev: ApprovalGrantsState | null,
  msg: Extract<ServerMessage, { type: "approvalGrants" }>,
): ApprovalGrantsState {
  const inherited = msg.inherited ?? [];
  if (prev?.sessionId !== msg.sessionId)
    return {
      sessionId: msg.sessionId,
      grants: msg.grants,
      inherited,
      ...(msg.inheritance ? { inheritance: msg.inheritance } : {}),
    };
  const next: ApprovalGrantsState = {
    sessionId: msg.sessionId,
    grants: sameGrantList(prev.grants, msg.grants) ? prev.grants : msg.grants,
    inherited: sameGrantList(prev.inherited, inherited)
      ? prev.inherited
      : inherited,
    ...(msg.inheritance
      ? {
          inheritance:
            prev.inheritance?.parentSessionId ===
              msg.inheritance.parentSessionId &&
            prev.inheritance.inherits === msg.inheritance.inherits
              ? prev.inheritance
              : msg.inheritance,
        }
      : {}),
  };
  return next.grants === prev.grants &&
    next.inherited === prev.inherited &&
    next.inheritance === prev.inheritance
    ? prev
    : next;
}

function upsertApproval(
  messages: DisplayMessage[],
  approval: ApprovalCard,
): DisplayMessage[] {
  const msgId = approvalMessageId(approval.id);
  const block: DisplayBlock = { kind: "approval", approval };
  const createdAt = new Date(approval.createdAt).toISOString();
  const idx = messages.findIndex((m) => m.id === msgId);
  if (idx >= 0) {
    const updated: DisplayMessage = {
      ...messages[idx],
      id: msgId,
      role: "assistant",
      blocks: [block],
      createdAt,
    };
    return [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
  }
  return [
    ...messages,
    { id: msgId, role: "assistant", blocks: [block], createdAt },
  ];
}

/**
 * A card the server could not place in its log (a legacy card whose turn it
 * cannot find) is still a row of the viewed transcript, which merges every card
 * of the session: land on that row where it is, without paging. A card older
 * than the loaded window has no row yet (`loadedHistoryStart`), so the reveal
 * pages back to the session's start, where every card is placed.
 */
function viewedApprovalReveal(
  state: UIState,
  target: TimelineAnchorTarget,
): MessageReveal | null {
  const sessionId = state.session?.sessionId;
  const entryId = viewedApprovalRowId(state, target);
  if (!sessionId || !entryId) return null;
  return {
    sessionId,
    entryId,
    index: state.messages.some((message) => message.id === entryId)
      ? state.timelineStart
      : 0,
    token: Date.now(),
  };
}

/** The viewed transcript's row for the card `target` names, if it holds one. */
function viewedApprovalRowId(
  state: UIState,
  target: TimelineAnchorTarget,
): string | null {
  if (target.kind !== "approval") return null;
  const entryId = approvalMessageId(target.approvalId);
  return state.approvals.some((message) => message.id === entryId)
    ? entryId
    : null;
}

/**
 * When the loaded part of a WINDOWED transcript begins: the time of its oldest
 * dated row, or null when the whole session is loaded.
 *
 * The card stores hold every card of the session, but the timeline is only the
 * suffix after `timelineStart`. A card issued before that suffix has no tool
 * row to follow, and its timestamp sorts it ahead of every loaded row — so a
 * long session stacked ALL its old cards on top of the window, in front of the
 * last few turns, with none of the prompts and replies they belong between. It
 * waits for "load earlier" to bring its turn in instead.
 */
function loadedHistoryStart(
  base: readonly DisplayMessage[],
  timelineStart: number,
): number | null {
  if (timelineStart <= 0) return null;
  const first = base.find((message) => message.createdAt)?.createdAt;
  const at = first ? Date.parse(first) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

export type ClientPullRequestCard = PullRequestCard & {
  /** Browser-local bridge from the click to the server's durable `busyAction`. */
  pendingAction?: PullRequestCardAction;
  /** Optimistic linked-Task projection layered over the authoritative card. */
  optimisticLinkedTask?: TaskSummary;
};

/** The two delivery controls a Workflow card offers, as an action id. */
type WorkflowDeliveryAction = Extract<
  PullRequestCardAction,
  "merge" | "cleanup"
>;

export type ClientWorkflowRunDelivery = WorkflowRunDelivery & {
  /**
   * Browser-local bridge from the click to the run's durable `busyAction`, the
   * same one the live `/pr` card's {@link ClientPullRequestCard.pendingAction}
   * covers — and needed for the same reason. The run's `busyAction` is the
   * pull-request card's, re-projected onto the run list and broadcast from
   * there, so between the click and that echo NOTHING on the card moves; a
   * control that only follows the server therefore reads as a dead button.
   */
  pendingAction?: WorkflowDeliveryAction;
};

/** A run card whose delivery may carry this browser's unanswered click. */
export type ClientWorkflowRunCard = WorkflowRunCard & {
  pullRequest?: NonNullable<WorkflowRunCard["pullRequest"]> & {
    delivery?: ClientWorkflowRunDelivery;
  };
};

/** Patch one run card's delivery, leaving every other run's card untouched. */
function updateWorkflowDelivery(
  cards: Record<string, ClientWorkflowRunCard>,
  runId: string,
  update: (delivery: ClientWorkflowRunDelivery) => ClientWorkflowRunDelivery,
): Record<string, ClientWorkflowRunCard> {
  const card = cards[runId];
  const delivery = card?.pullRequest?.delivery;
  if (!card?.pullRequest || !delivery) return cards;
  const next = update(delivery);
  if (next === delivery) return cards;
  return {
    ...cards,
    [runId]: { ...card, pullRequest: { ...card.pullRequest, delivery: next } },
  };
}

/**
 * The authoritative run cards, carrying each unanswered click's overlay over.
 *
 * The run list is broadcast whole and for reasons of its own — an agent step,
 * another run's card, a settle elsewhere — so a snapshot arriving between the
 * click and the server's `busyAction` says nothing about this click, and
 * dropping the overlay on it would put the dead button back for exactly the
 * window the overlay exists to cover. The server's own `busyAction` RETIRES it:
 * from then on every viewer, this one included, reads the same durable action.
 *
 * Nothing authoritative is edited out on the way — not even the `error`, which
 * while the click is unanswered still describes the PREVIOUS action. Hiding
 * that one is the renderer's job (`WorkflowRunCard.tsx`): the same snapshot may
 * instead be the first to carry THIS action's failure, and a reducer dropping
 * the field would lose a refusal the user has to see.
 */
function withPendingDelivery(
  cards: Record<string, WorkflowRunCard>,
  previous: Record<string, ClientWorkflowRunCard>,
): Record<string, ClientWorkflowRunCard> {
  let next: Record<string, ClientWorkflowRunCard> = cards;
  for (const [runId, card] of Object.entries(previous)) {
    const pendingAction = card.pullRequest?.delivery?.pendingAction;
    if (!pendingAction) continue;
    next = updateWorkflowDelivery(next, runId, (delivery) =>
      delivery.busyAction ? delivery : { ...delivery, pendingAction },
    );
  }
  return next;
}

/**
 * The card without the text of a PREVIOUS action's outcome. The server clears
 * `actionError`/`actionMessage` when it DEQUEUES the next action, so until then
 * both fields still describe the last one — and a click has already answered
 * them.
 */
function withoutStoredOutcome<T extends PullRequestCard>(card: T): T {
  const {
    actionError: _actionError,
    actionMessage: _actionMessage,
    ...rest
  } = card;
  return rest as T;
}

function clientPullRequestCard(
  messages: readonly DisplayMessage[],
  cardId: string,
): ClientPullRequestCard | undefined {
  return messages
    .find((message) => message.id === `pull-request-card-${cardId}`)
    ?.blocks.find(
      (block): block is Extract<DisplayBlock, { kind: "pullRequest" }> =>
        block.kind === "pullRequest",
    )?.pullRequest as ClientPullRequestCard | undefined;
}

/** Patch one browser-local card overlay without disturbing any other message. */
function updateClientPullRequestCard(
  messages: DisplayMessage[],
  cardId: string,
  update: (card: ClientPullRequestCard) => ClientPullRequestCard,
): DisplayMessage[] {
  const msgId = `pull-request-card-${cardId}`;
  const index = messages.findIndex((message) => message.id === msgId);
  if (index < 0) return messages;
  const message = messages[index]!;
  const blockIndex = message.blocks.findIndex(
    (block) => block.kind === "pullRequest",
  );
  if (blockIndex < 0) return messages;
  const block = message.blocks[blockIndex] as Extract<
    DisplayBlock,
    { kind: "pullRequest" }
  >;
  const pullRequest = update(block.pullRequest as ClientPullRequestCard);
  if (pullRequest === block.pullRequest) return messages;
  const blocks = [...message.blocks];
  blocks[blockIndex] = { kind: "pullRequest", pullRequest };
  const updated = { ...message, blocks };
  return [...messages.slice(0, index), updated, ...messages.slice(index + 1)];
}

function reconcilePullRequestCardTaskRecovery(
  messages: DisplayMessage[],
  events: TaskStateEventsMessage["events"],
): DisplayMessage[] {
  const recovered = new Map(
    events.flatMap((event) =>
      event.kind === "upsert" ? [[event.id, event.item] as const] : [],
    ),
  );
  if (recovered.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    let blocksChanged = false;
    const blocks = message.blocks.map((block): DisplayBlock => {
      if (block.kind !== "pullRequest") return block;
      const card = block.pullRequest as ClientPullRequestCard;
      const linkedTask = card.linkedTask
        ? recovered.get(card.linkedTask.id)
        : undefined;
      if (!linkedTask) return block;
      if (
        !card.optimisticLinkedTask &&
        wireValueEqual(card.linkedTask, linkedTask)
      )
        return block;
      blocksChanged = true;
      const { optimisticLinkedTask: _optimisticLinkedTask, ...authoritative } =
        card;
      return {
        kind: "pullRequest",
        pullRequest: { ...authoritative, linkedTask },
      };
    });
    if (!blocksChanged) return message;
    changed = true;
    return { ...message, blocks };
  });
  return changed ? next : messages;
}

function upsertPullRequestCard(
  messages: DisplayMessage[],
  card: PullRequestCard,
): DisplayMessage[] {
  const msgId = `pull-request-card-${card.id}`;
  const current = clientPullRequestCard(messages, card.id);
  const pendingAction = current?.pendingAction;
  const actionInFlight = pendingAction ?? card.busyAction;
  // An unrelated watcher patch must not reopen the click→busy dead zone, and
  // the card's own action fields cannot tell the two apart: the server clears
  // them only when it DEQUEUES this click (`pullRequestActions.ts`), while the
  // watcher bumps `updatedAt` on every routine CI/review poll. So while the
  // click is still local, the stored outcome is the PREVIOUS action's — the
  // steady state for any card that ever completed one — and the click owns the
  // card until the server's `busyAction` takes over. Reading that leftover text
  // as this click's answer would drop the overlay, revert the linked-Task patch
  // and re-surface an answered error, in exactly the window this bridge covers.
  const staleOutcome = pendingAction !== undefined && !card.busyAction;
  const awaitingOutcome =
    actionInFlight !== undefined &&
    (staleOutcome || (!card.actionError && !card.actionMessage));
  // Keep the linked Task patch through the server's initial busy echo too —
  // otherwise the answered button would briefly reappear while the write runs.
  const optimisticLinkedTask =
    awaitingOutcome &&
    actionInFlight === "mark-task-done" &&
    current?.optimisticLinkedTask?.status === "done" &&
    current.optimisticLinkedTask.id === card.linkedTask?.id
      ? current.optimisticLinkedTask
      : undefined;
  const nextCard: ClientPullRequestCard = awaitingOutcome
    ? {
        ...(staleOutcome ? withoutStoredOutcome(card) : card),
        ...(optimisticLinkedTask ? { optimisticLinkedTask } : {}),
        ...(pendingAction && !card.busyAction ? { pendingAction } : {}),
      }
    : card;
  const block: DisplayBlock = { kind: "pullRequest", pullRequest: nextCard };
  const createdAt = new Date(card.createdAt).toISOString();
  const idx = messages.findIndex((m) => m.id === msgId);
  if (idx >= 0) {
    const updated: DisplayMessage = {
      ...messages[idx],
      id: msgId,
      role: "assistant",
      blocks: [block],
      createdAt,
    };
    return [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
  }
  return [
    ...messages,
    { id: msgId, role: "assistant", blocks: [block], createdAt },
  ];
}

function canOptimisticallyUpdateTaskList(
  list: TaskListResponse | null,
): list is TaskListResponse {
  if (!list) return false;
  const filter = list.request;
  // Keep the first optimistic pass intentionally scoped to the core Backlog list.
  // Filtered lists need predicate-aware insert/remove handling so items do not
  // appear in views they no longer match.
  return (
    !filter.status &&
    !filter.projectId &&
    !filter.priority &&
    !filter.due &&
    !filter.sessionId &&
    !filter.query &&
    !filter.includeArchived
  );
}

/**
 * The title an optimistic save should show, or `null` when the request cannot be
 * applied locally at all. `undefined` means "leave the stored title alone" —
 * which only an update may say, and which a surface saving from a snapshot (a
 * transcript Task card) does say, so it cannot rewrite a renamed title.
 */
function optimisticSaveTitle(
  request: TaskSaveRequest,
): string | undefined | null {
  if (request.title === undefined) return request.id ? undefined : null;
  return request.title.trim() || null;
}

function descriptionPreview(text: string | undefined): string {
  const value = text?.trim() ?? "";
  return value.length > 180 ? `${value.slice(0, 179)}…` : value;
}

function optimisticTaskFromRequest(
  request: TaskSaveRequest,
  tempId: string,
  now: number,
): TaskSummary {
  const description = request.description ?? "";
  const status = request.status ?? "todo";
  return {
    id: tempId,
    title: request.title?.trim() ?? "",
    status,
    descriptionPreview: descriptionPreview(description),
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.ticket ? { ticket: request.ticket } : {}),
    ...(request.externalLinks !== undefined
      ? { externalLinks: request.externalLinks }
      : {}),
    ...(request.dueDate ? { dueDate: request.dueDate } : {}),
    priority: request.priority || "normal",
    ...(request.parentId ? { parentId: request.parentId } : {}),
    sessionRefs: [],
    source: { createdBy: "user" },
    createdAt: now,
    updatedAt: now,
    ...(status === "done" ? { completedAt: now } : {}),
  };
}

function applyOptimisticTaskProjectAssignment(
  list: TaskListResponse | null,
  updates: TaskProjectAssignmentUpdate[],
  now: number,
): TaskListResponse | null {
  if (!list || !isCacheableTaskList(list)) return list;
  const updatesById = new Map(
    updates.map((update) => [update.id, update.projectId?.trim() || null]),
  );
  if (updatesById.size === 0) return list;
  let changed = false;
  const items = list.items.map((item) => {
    if (!updatesById.has(item.id)) return item;
    const projectId = updatesById.get(item.id) || undefined;
    if ((item.projectId ?? undefined) === projectId) return item;
    changed = true;
    return applyPatch(item, { projectId, updatedAt: now });
  });
  return changed ? { ...list, items, updatedAt: now } : list;
}

/**
 * The drag the user just made, applied locally the way the server will apply it:
 * each placement takes the next index within ITS parent group, in placement
 * order (`reorderTasks` in `tasks.ts`). Rows outside the request keep their
 * identity, so a drag repaints only what moved.
 */
function applyOptimisticTaskReorder(
  list: TaskListResponse | null,
  placements: TaskReorderPlacement[],
): TaskListResponse | null {
  if (!list || !canOptimisticallyUpdateTaskList(list) || !placements.length)
    return list;
  const siblingIndex = new Map<string, number>();
  const moved = new Map<string, { parentId?: string; sortOrder: number }>();
  for (const placement of placements) {
    const parentId = placement.parentId?.trim() || undefined;
    const key = parentId ?? "";
    const index = siblingIndex.get(key) ?? 0;
    siblingIndex.set(key, index + 1);
    moved.set(placement.id, {
      ...(parentId !== undefined ? { parentId } : {}),
      sortOrder: index,
    });
  }
  let changed = false;
  const items = list.items.map((item) => {
    const next = moved.get(item.id);
    if (!next) return item;
    if (
      (item.parentId ?? undefined) === next.parentId &&
      item.sortOrder === next.sortOrder
    )
      return item;
    changed = true;
    // Rebuilt without the key rather than with an `undefined` one: an absent
    // field and a present-but-undefined one are different objects to the wire
    // comparison, and the echo of this very row has to compare EQUAL.
    const { parentId: _dropped, ...rest } = item;
    return {
      ...rest,
      ...(next.parentId ? { parentId: next.parentId } : {}),
      sortOrder: next.sortOrder,
    };
  });
  return changed ? { ...list, items } : list;
}

function applyOptimisticTaskSave(
  list: TaskListResponse | null,
  request: TaskSaveRequest,
  tempId: string,
  now: number,
): TaskListResponse | null {
  if (!canOptimisticallyUpdateTaskList(list)) return list;
  const title = optimisticSaveTitle(request);
  if (title === null) return list;

  if (!request.id) {
    if (title === undefined) return list;
    return {
      ...list,
      items: [
        optimisticTaskFromRequest({ ...request, title }, tempId, now),
        ...list.items,
      ],
      updatedAt: now,
    };
  }

  let changed = false;
  const items = list.items.map((item) => {
    if (item.id !== request.id) return item;
    changed = true;
    const status = request.status ?? item.status;
    // A save that CLEARS a field (null/"" from the form) must clear it in the
    // optimistic mirror too, exactly as the server will.
    return applyPatch(item, {
      title: title ?? item.title,
      descriptionPreview:
        request.description !== undefined
          ? descriptionPreview(request.description)
          : item.descriptionPreview,
      status,
      projectId:
        request.projectId === null || request.projectId === ""
          ? undefined
          : (request.projectId ?? item.projectId),
      ticket:
        request.ticket === null ? undefined : (request.ticket ?? item.ticket),
      externalLinks: request.externalLinks ?? item.externalLinks,
      dueDate:
        request.dueDate === null || request.dueDate === ""
          ? undefined
          : (request.dueDate ?? item.dueDate),
      priority:
        request.priority === null
          ? "normal"
          : (request.priority ?? item.priority),
      parentId:
        request.parentId === null || request.parentId === ""
          ? undefined
          : (request.parentId ?? item.parentId),
      updatedAt: now,
      completedAt: status === "done" ? (item.completedAt ?? now) : undefined,
    });
  });
  return changed ? { ...list, items, updatedAt: now } : list;
}

function applyOptimisticProjectSave(
  list: ProjectListResponse | null,
  id: string,
  patch: Partial<ProjectRecord>,
  now: number,
): ProjectListResponse | null {
  if (!list) return list;
  let changed = false;
  const projects = list.projects.map((project) => {
    if (project.id !== id) return project;
    changed = true;
    return projectSummaryOf({
      ...project,
      ...patch,
      key: patch.key !== undefined ? patch.key.toUpperCase() : project.key,
      updatedAt: new Date(now).toISOString(),
    });
  });
  return changed ? { ...list, projects, updatedAt: now } : list;
}

function applyOptimisticProjectReorder(
  list: ProjectListResponse | null,
  placements: Array<{ id: string; parentId?: string | null }>,
): ProjectListResponse | null {
  if (!list || !placements.length) return list;
  const siblingIndex = new Map<string, number>();
  const moved = new Map<string, { parentId?: string; sortOrder: number }>();
  for (const placement of placements) {
    const parentId = placement.parentId?.trim() || undefined;
    const key = parentId ?? "";
    const sortOrder = siblingIndex.get(key) ?? 0;
    siblingIndex.set(key, sortOrder + 1);
    moved.set(placement.id, {
      ...(parentId !== undefined ? { parentId } : {}),
      sortOrder,
    });
  }
  let changed = false;
  const projects = list.projects.map((project) => {
    const placement = moved.get(project.id);
    if (!placement) return project;
    if (
      (project.parentId ?? undefined) === placement.parentId &&
      project.sortOrder === placement.sortOrder
    )
      return project;
    changed = true;
    const { parentId: _parentId, ...rest } = project;
    return {
      ...rest,
      ...(placement.parentId ? { parentId: placement.parentId } : {}),
      sortOrder: placement.sortOrder,
    };
  });
  return changed ? { ...list, projects } : list;
}

function applyOptimisticSessionRename(
  sessions: SessionListItem[],
  sessionId: string,
  title: string,
  now: number,
): SessionListItem[] {
  return sessions.map((session) =>
    session.id === sessionId
      ? { ...session, title, updatedAt: Math.max(session.updatedAt, now) }
      : session,
  );
}

/**
 * Mirror a settle/unsettle instantly. Settlement is a lifecycle bit, not
 * activity, so `updatedAt` must NOT move — bumping it would re-sort the inbox
 * around a row that is on its way out of the working set.
 *
 * Settling also acknowledges the attention revision THIS ROW carries, which is
 * exactly what the command sends: the optimistic row is the one the user
 * clicked, so it can never acknowledge an outcome it does not know about, and
 * the authoritative broadcast corrects it either way.
 */
function applyOptimisticSessionSettle(
  sessions: SessionListItem[],
  sessionId: string,
  settled: boolean,
  now: number,
): SessionListItem[] {
  return sessions.map((session) => {
    if (session.id !== sessionId) return session;
    if (!settled) {
      const { settledAt: _settledAt, ...rest } = session;
      return rest;
    }
    return {
      ...session,
      settledAt: now,
      ...(session.outcomeAttention
        ? {
            outcomeAttention: {
              ...session.outcomeAttention,
              settledRevision: session.outcomeAttention.revision,
            },
          }
        : {}),
    };
  });
}

function applyOptimisticSettings(
  settings: AppSettings,
  patch: Partial<AppSettings>,
): AppSettings {
  // AppSettings update messages replace whole provided sections. Mirror that
  // contract client-side so controls feel instant but the server remains the
  // authoritative source once it echoes the persisted settings.
  return { ...settings, ...patch };
}

type TaskStateEventsMessage = StateEventsMessage<"tasks", TaskSummary>;
type ProjectStateEventsMessage = StateEventsMessage<"projects", ProjectSummary>;
type InitiativeStateEventsMessage = StateEventsMessage<
  "initiatives",
  InitiativeSummary
>;
type BackgroundStateEventsMessage = StateEventsMessage<
  "background",
  BackgroundWorkItemSummary
>;

/**
 * The `background` topic's replica lenses. A newly seen row goes FIRST, and a
 * snapshot says whether it was a window over a longer history; its rows replace
 * the held ones as given.
 */
const backgroundReplica: TopicDescriptor<
  UIState,
  BackgroundWorkItemSummary,
  Extract<ServerMessage, { type: "backgroundWorkList" }>
> = {
  read: (state) => ({
    items: state.backgroundWorkItems,
    revisions: state.stateEventRevisions.background ?? {},
  }),
  write: (state, replica) => ({
    ...state,
    backgroundWorkItems: replica.items,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      background: replica.revisions,
    },
  }),
  snapshot: (message) => ({
    items: message.items,
    revisions: message.revisions,
  }),
  place: (items, item) => [item, ...items],
  adoptSnapshot: (state, message) => ({
    ...state,
    backgroundWorkTruncated: message.truncated === true,
  }),
};

type SessionListMessage = Extract<ServerMessage, { type: "sessionList" }>;
type SessionStateEventsMessage = StateEventsMessage<
  "sessions",
  SessionListItem
>;

/**
 * Value-equal rows of `incoming` keep their held identity, and so does the
 * held array when every row is reused, in whatever order the server sent
 * them, since `write` sorts (a reconnect redraws nothing).
 */
function reconcileSessions(
  held: SessionListItem[],
  incoming: SessionListItem[],
): SessionListItem[] {
  if (held.length === 0 || incoming.length === 0) return incoming;
  const heldById = new Map(held.map((row) => [row.id, row]));
  let reused = 0;
  const rows = incoming.map((row) => {
    const existing = heldById.get(row.id);
    if (!existing || !wireValueEqual(existing, row)) return row;
    reused++;
    return existing;
  });
  return reused === held.length && rows.length === held.length ? held : rows;
}

/**
 * The `sessions` topic's replica lenses over the LIVE rows only
 * (`docs/session-list.md`). A row goes in `updatedAt` order, and `write`
 * re-sorts when an upsert moved one, keeping identity when nothing moved. An
 * archived-slice id is restored by a live upsert and re-read on a `delete`;
 * a `delete` for an id held nowhere (the hidden singleton, a zero-message
 * child) does nothing. No digest: PR3 adds one.
 */
const sessionReplica: TopicDescriptor<
  UIState,
  SessionListItem,
  SessionListMessage
> = {
  read: (state) => ({
    items: state.liveSessions,
    revisions: state.stateEventRevisions.sessions ?? {},
  }),
  write: (state, replica) => {
    const written = withSessionSlices(
      state,
      sortedByUpdatedAt(replica.items),
      state.archivedSessions,
    );
    return written.stateEventRevisions.sessions === replica.revisions
      ? written
      : {
          ...written,
          stateEventRevisions: {
            ...written.stateEventRevisions,
            sessions: replica.revisions,
          },
        };
  },
  snapshot: (message, held) => {
    const revisions = revisionSidecar(message.revisions);
    return {
      items: reconcileSessions(held.items, message.sessions),
      // A sidecar missing a row cannot vouch for the list: none is held.
      revisions:
        revisions &&
        message.sessions.every((session) => session.id in revisions)
          ? message.revisions
          : [],
    };
  },
  place: (items, item) => {
    const at = items.findIndex((row) => row.updatedAt < item.updatedAt);
    return at < 0
      ? [...items, item]
      : [...items.slice(0, at), item, ...items.slice(at)];
  },
  adoptSnapshot: (state, message) => ({
    ...state,
    sessionListFresh: true,
    archivedSessionCount: message.archivedSessionCount,
    // An open shelf re-reads the slice it shows, as after any reconnect.
    archivedSessionsLoaded: false,
  }),
  afterEvents: (state, applied) => {
    if (state.archivedSessions.length === 0) return state;
    const archivedIds = new Set(state.archivedSessions.map((row) => row.id));
    const restored = new Set<string>();
    let reread = false;
    for (const event of applied) {
      if (!archivedIds.has(event.id)) continue;
      if (event.kind === "upsert") restored.add(event.id);
      else reread = true;
    }
    const next =
      restored.size === 0
        ? state
        : withSessionSlices(
            state,
            state.liveSessions,
            state.archivedSessions.filter((row) => !restored.has(row.id)),
          );
    return reread ? queueArchivedRead(next) : next;
  },
};

type ProjectListMessage = Extract<ServerMessage, { type: "projectList" }>;
const NO_PROJECTS: ProjectSummary[] = [];

/**
 * The `projects` topic's replica lenses over the canonical registry slot. Only
 * the canonical archived-inclusive list is this topic's snapshot: a filtered
 * read is an independent one-off answer that changes nothing here. A snapshot
 * keeps value-equal rows by identity; an event before any list was read
 * advances only the sidecar; a newer revision re-reads a held detail.
 */
const projectReplica: TopicDescriptor<
  UIState,
  ProjectSummary,
  ProjectListMessage
> = {
  read: (state) => ({
    items: state.projectList?.projects ?? NO_PROJECTS,
    revisions: state.stateEventRevisions.projects ?? {},
  }),
  write: (state, replica) => ({
    ...state,
    projectList:
      state.projectList && replica.items !== state.projectList.projects
        ? { ...state.projectList, projects: replica.items }
        : state.projectList,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      projects: replica.revisions,
    },
  }),
  snapshot: (message, held) => {
    if (!isCanonicalProjectList(message.list)) return null;
    const revisions = revisionSidecar(message.revisions);
    return {
      items: reconcileProjects(held.items, message.list.projects),
      // A sidecar missing a row cannot vouch for the list: none is held.
      revisions:
        revisions && projectListHasRevisionSidecar(message.list, revisions)
          ? message.revisions
          : [],
    };
  },
  place: (items, item) => [...items, item],
  adoptSnapshot: (state, message) => {
    // A first answer had no list for `write` to put its rows in, and with
    // nothing held to reuse they are the message's own.
    const projects = state.projectList?.projects ?? message.list.projects;
    return {
      ...state,
      projectList:
        projects === message.list.projects
          ? message.list
          : { ...message.list, projects },
      projectListFresh: true,
      projectListError: null,
      error: null,
    };
  },
  afterEvents: (state, applied) => {
    let projectDetails = state.projectDetails;
    for (const event of applied) {
      const detail = projectDetails[event.id];
      const detailRevision = state.projectDetailRevisions[event.id] ?? -1;
      if (detail && dataOf(detail) && event.revision > detailRevision) {
        if (projectDetails === state.projectDetails)
          projectDetails = { ...state.projectDetails };
        projectDetails[event.id] = beginLoad(detail);
      }
    }
    return projectDetails === state.projectDetails
      ? state
      : { ...state, projectDetails };
  },
  digest: {
    baseline: canUseProjectDigest,
    adoptDigest: (state, _message, changedIds) => ({
      ...state,
      projectListFresh: changedIds.length === 0,
      projectListError: null,
      error: null,
    }),
    adoptItems: (state) => ({
      ...state,
      projectListFresh: true,
      projectListError: null,
      error: null,
    }),
  },
  resubscribeOnlyWhileHeld: true,
};

type InitiativeListMessage = Extract<ServerMessage, { type: "initiativeList" }>;

/**
 * The `initiatives` topic's replica lenses. A newly seen row goes LAST. A
 * snapshot or digest names the whole live projection, so it judges every held
 * read; an event judges the reads it names.
 */
const initiativeReplica: TopicDescriptor<
  UIState,
  InitiativeSummary,
  InitiativeListMessage
> = {
  read: (state) => ({
    items: state.initiatives,
    revisions: state.stateEventRevisions.initiatives ?? {},
  }),
  write: (state, replica) => ({
    ...state,
    initiatives: replica.items,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      initiatives: replica.revisions,
    },
  }),
  snapshot: (message) => ({
    items: message.items,
    revisions: message.revisions,
  }),
  place: (items, item) => [...items, item],
  adoptSnapshot: (state) => ({
    ...state,
    initiativesFresh: true,
    initiativesRefreshing: false,
    initiativeListError: null,
    initiativeDetails: staleInitiativeReads(
      state,
      state.stateEventRevisions.initiatives ?? {},
    ),
  }),
  afterEvents: (state, applied) => {
    let initiativeDetails = state.initiativeDetails;
    // A delete is a newer revision too: an archived Initiative's open page
    // re-reads, and a deleted one answers `null`.
    for (const event of applied)
      initiativeDetails = staleInitiativeDetail(
        initiativeDetails,
        state.initiativeDetails,
        state.initiativeDetailRevisions,
        event.id,
        event.revision,
      );
    return initiativeDetails === state.initiativeDetails
      ? state
      : { ...state, initiativeDetails };
  },
  digest: {
    // Only an answer this hook instance applied sets the sidecar; the shell
    // cache never holds Initiatives.
    baseline: (state) => {
      const revisions = state.stateEventRevisions.initiatives;
      return (
        revisions !== undefined &&
        state.initiatives.every(
          (item) =>
            Number.isSafeInteger(revisions[item.id]) &&
            revisions[item.id]! >= 0,
        )
      );
    },
    adoptDigest: (state, message, changedIds) => ({
      ...state,
      initiativesFresh: changedIds.length === 0,
      // With changes, the list stays refreshing until its catch-up answers.
      ...(changedIds.length === 0
        ? { initiativesRefreshing: false, initiativeListError: null }
        : {}),
      initiativeDetails: staleInitiativeReads(
        state,
        revisionSidecar(message.entries) ?? {},
      ),
    }),
    adoptItems: (state) => ({
      ...state,
      initiativesFresh: true,
      initiativesRefreshing: false,
      initiativeListError: null,
    }),
  },
  resubscribeOnlyWhileHeld: true,
};

type TaskListMessage = Extract<ServerMessage, { type: "taskList" }>;
const NO_TASKS: TaskSummary[] = [];

/**
 * The `tasks` topic's replica lenses over the canonical live list. Only an
 * unfiltered list is this topic's snapshot; a newly seen row goes FIRST, and an
 * event before any list was read advances only the sidecar. A snapshot or
 * digest names the whole live projection, so it forgets the statuses of the
 * held rows it leaves out (never a status an archived body recorded) and judges
 * every held body; an event judges the bodies it names.
 */
const taskReplica: TopicDescriptor<UIState, TaskSummary, TaskListMessage> = {
  read: (state) => ({
    items: state.taskList?.items ?? NO_TASKS,
    revisions: state.stateEventRevisions.tasks ?? {},
  }),
  write: (state, replica) => ({
    ...state,
    taskList:
      state.taskList && replica.items !== state.taskList.items
        ? { ...state.taskList, items: replica.items }
        : state.taskList,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      tasks: replica.revisions,
    },
  }),
  snapshot: (message, held) => {
    if (!isCacheableTaskList(message.list)) return null;
    const revisions = revisionSidecar(message.revisions);
    return {
      items: reconcileTaskList(held.items, message.list),
      // A sidecar missing a row cannot vouch for the list: none is held.
      revisions:
        revisions && taskListHasRevisionSidecar(message.list, revisions)
          ? message.revisions
          : [],
    };
  },
  place: (items, item) => [item, ...items],
  adoptSnapshot: (state, message, held) => {
    // A first answer had no list for `write` to put its rows in, and with
    // nothing held to reuse they are the message's own.
    const items = state.taskList?.items ?? message.list.items;
    const taskList =
      items === message.list.items ? message.list : { ...message.list, items };
    const revisions = revisionSidecar(message.revisions);
    const canonical =
      revisions && taskListHasRevisionSidecar(message.list, revisions)
        ? revisions
        : null;
    const byUpdatedAt = reconcileTaskDetails(state.taskDetails, taskList.items);
    return {
      ...state,
      taskList,
      // As a digest does: rows the canonical snapshot no longer lists left the
      // live projection, so their recorded statuses are dropped.
      taskStatuses: canonical
        ? forgetTaskStatuses(
            state.taskStatuses,
            held.items
              .map((item) => item.id)
              .filter((id) => !(id in canonical)),
          )
        : state.taskStatuses,
      taskListFresh: true,
      taskListError: null,
      // The snapshot advances the revision sidecar, so the events that would
      // have marked a body stale will never be applied: compare here.
      taskDetails: canonical
        ? reconcileTaskDetailRevisions(
            byUpdatedAt,
            state.taskDetailRevisions,
            canonical,
          )
        : byUpdatedAt,
      error: null,
    };
  },
  afterEvents: (state, applied, held) => {
    let taskDetails = state.taskDetails;
    let taskStatuses = state.taskStatuses;
    for (const event of applied) {
      // An event newer than the body is the only signal some body changes
      // send: a linked Task's title or status moves this Task's revision, not
      // its `updatedAt`, and often not its summary either. That includes a
      // `delete` for a Task that was already archived: the list has nothing to
      // drop, but an open body of it is stale. A body read without a revision
      // (an older server) is left to the `updatedAt` reconciliation below.
      const detail = taskDetails[event.id];
      const detailRevision = state.taskDetailRevisions[event.id];
      if (
        detail &&
        dataOf(detail) &&
        detailRevision !== undefined &&
        event.revision > detailRevision
      ) {
        if (taskDetails === state.taskDetails) taskDetails = { ...taskDetails };
        taskDetails[event.id] = beginLoad(detail);
      }
      if (event.kind === "delete")
        taskStatuses = forgetTaskStatuses(taskStatuses, [event.id]);
    }
    // A `delete` may name a Task that was ALREADY archived (its linked Task
    // changed): a no-op on the list only because `taskList` is the canonical
    // LIVE projection and never holds an archived row.
    const items = state.taskList?.items;
    if (items && items !== held.items)
      taskDetails = reconcileTaskDetails(taskDetails, items);
    return taskDetails === state.taskDetails &&
      taskStatuses === state.taskStatuses
      ? state
      : { ...state, taskDetails, taskStatuses };
  },
  digest: {
    baseline: canUseTaskDigest,
    adoptDigest: (state, message, changedIds, held) => {
      const live = new Set(message.entries.map((entry) => entry.id));
      return {
        ...state,
        // The digest names only live rows; an archived Task's open body may
        // have missed changes while this tab was away, and nothing else will
        // say so.
        taskDetails: reconcileTaskDetailRevisions(
          state.taskDetails,
          state.taskDetailRevisions,
          revisionSidecar(message.entries) ?? {},
        ),
        taskListFresh: changedIds.length === 0,
        taskStatuses: forgetTaskStatuses(
          state.taskStatuses,
          held.items
            .filter((item) => !live.has(item.id))
            .map((item) => item.id),
        ),
        error: null,
      };
    },
    adoptItems: (state) => ({
      ...state,
      taskListFresh: true,
      taskListError: null,
      error: null,
    }),
  },
  // The direct `saveTask` reply settles a create: the server has never heard
  // of the browser-local temp id, so an upsert event alone would leave the
  // optimistic row beside the real one forever. The temp row is replaced in
  // place with the shared summary projection — the same narrowing the server
  // broadcasts — so the echo that follows finds an equal row and keeps its
  // identity.
  settle: (state, { localId, id, item }) => {
    const list = state.taskList;
    // A filtered list is left to the server: an item that no longer matches
    // its predicate must not be inserted into a view it does not belong in.
    if (!list || !canOptimisticallyUpdateTaskList(list)) return state;
    const index = list.items.findIndex(
      (row) => row.id === localId || row.id === id,
    );
    if (item === null) {
      // An archived Task is no row of the live list: saving one from its page
      // (reached through a link) must not put it back.
      if (index < 0) return state;
      return {
        ...state,
        taskList: {
          ...list,
          items: list.items.filter((_, at) => at !== index),
        },
      };
    }
    if (index >= 0 && wireValueEqual(list.items[index], item)) return state;
    const items = list.items.slice();
    if (index >= 0) items[index] = item;
    else items.unshift(item);
    return { ...state, taskList: { ...list, items } };
  },
  resubscribeOnlyWhileHeld: true,
};

/** Apply one server flush atomically through its topic's replica. */
function applyEvent(
  state: UIState,
  message:
    | TaskStateEventsMessage
    | ProjectStateEventsMessage
    | InitiativeStateEventsMessage
    | BackgroundStateEventsMessage
    | SessionStateEventsMessage,
): UIState {
  if (message.topic === "sessions")
    return applyTopicMessage(sessionReplica, state, message);
  if (message.topic === "tasks")
    return applyTopicMessage(taskReplica, state, message);
  if (message.topic === "projects")
    return applyTopicMessage(projectReplica, state, message);
  if (message.topic === "initiatives")
    return applyTopicMessage(initiativeReplica, state, message);
  return applyTopicMessage(backgroundReplica, state, message);
}

/**
 * Mark a held Initiative read for a re-read when `revision` is newer than the
 * one it is as of. Only a summary revision does this — an event, a snapshot or
 * the answer to a read — and never a Task event, which recolours the map from
 * the Tasks topic without a read or a layout.
 */
function staleInitiativeDetail(
  details: UIState["initiativeDetails"],
  held: UIState["initiativeDetails"],
  detailRevisions: UIState["initiativeDetailRevisions"],
  id: string,
  revision: number | undefined,
): UIState["initiativeDetails"] {
  const detail = details[id];
  if (!detail || dataOf(detail) === undefined) return details;
  if (detail.status === "refreshing") return details;
  if (revision !== undefined && revision <= (detailRevisions[id] ?? -1))
    return details;
  const next = details === held ? { ...held } : details;
  next[id] = beginLoad(detail);
  return next;
}

/** A `getInitiative`; an empty collapsed set is left out. */
function initiativeReadMessage(
  id: string,
  requestId: string,
  collapsed: readonly string[],
): ClientMessage {
  return {
    type: "getInitiative",
    id,
    requestId,
    ...(collapsed.length > 0 ? { collapsed: [...collapsed] } : {}),
  };
}

/**
 * Judge every held Initiative read against a whole-projection answer (a
 * snapshot or a digest): one it leaves out (archived or deleted while this tab
 * was away) and one whose revision moved past its read both re-read.
 */
function staleInitiativeReads(
  state: UIState,
  revisions: Record<string, number>,
): UIState["initiativeDetails"] {
  let initiativeDetails = state.initiativeDetails;
  for (const id of Object.keys(state.initiativeDetails))
    initiativeDetails = staleInitiativeDetail(
      initiativeDetails,
      state.initiativeDetails,
      state.initiativeDetailRevisions,
      id,
      revisions[id],
    );
  return initiativeDetails;
}

function pruneInitiativeDetails(
  state: UIState,
  details: UIState["initiativeDetails"],
  revisions: UIState["initiativeDetailRevisions"],
  lru: string[],
): Pick<
  UIState,
  "initiativeDetails" | "initiativeDetailRevisions" | "initiativeDetailsLru"
> {
  // Pinned reads and the open page's are kept outside the idle bound, so
  // seven open rows never take turns evicting each other.
  const pinned = (id: string) =>
    (state.initiativeDetailPins[id] ?? 0) > 0 || id === state.openInitiativeId;
  const keep = new Set([
    ...lru.filter((id) => !pinned(id)).slice(-INITIATIVE_DETAIL_CACHE_LIMIT),
    ...lru.filter(pinned),
    ...(state.openInitiativeId ? [state.openInitiativeId] : []),
  ]);
  const kept = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => keep.has(id)));
  return {
    initiativeDetails: kept(details),
    initiativeDetailRevisions: kept(revisions),
    initiativeDetailsLru: lru.filter((id) => keep.has(id)),
  };
}

function applyProjectSaved(
  state: UIState,
  item: ProjectRecord,
  revision: number,
): UIState {
  const summary = projectSummaryOf(item);
  const projects = state.projectList?.projects;
  let projectList = state.projectList;
  if (projectList && projects) {
    const index = projects.findIndex((project) => project.id === item.id);
    const next = projects.slice();
    if (index < 0) next.push(summary);
    else
      next[index] = wireValueEqual(projects[index], summary)
        ? projects[index]!
        : summary;
    if (index < 0 || next[index] !== projects[index])
      projectList = { ...projectList, projects: next };
  }
  const lru = touchLru(state.projectDetailsLru, item.id);
  const keep = new Set([
    ...lru.slice(-PROJECT_DETAIL_CACHE_LIMIT),
    ...(state.openProjectProjectionId ? [state.openProjectProjectionId] : []),
  ]);
  const details = Object.fromEntries(
    Object.entries({ ...state.projectDetails, [item.id]: ready(item) }).filter(
      ([id]) => keep.has(id),
    ),
  );
  return {
    ...state,
    projectList,
    projectDetails: details,
    projectDetailRevisions: {
      ...state.projectDetailRevisions,
      [item.id]: revision,
    },
    projectDetailsLru: lru.filter((id) => keep.has(id)),
    error: null,
  };
}

/**
 * Record the revision a body is as of, and keep the sidecar to the bodies the
 * cache still holds — it is pruned with the cache, never on its own. A reply
 * without one (a failed read, an older server) keeps what was known:
 * forgetting it would leave the body to `updatedAt` alone.
 */
function retainedTaskDetailRevisions(
  revisions: Record<string, number>,
  cache: Record<string, unknown>,
  id: string,
  revision: number | undefined,
): Record<string, number> {
  let next = revisions;
  if (revision !== undefined && revisions[id] !== revision)
    next = { ...revisions, [id]: revision };
  const dropped = Object.keys(next).filter((key) => !(key in cache));
  if (!dropped.length) return next;
  if (next === revisions) next = { ...revisions };
  for (const key of dropped) delete next[key];
  return next;
}

/**
 * Bodies an authoritative Task SNAPSHOT or digest says are stale. Both name the
 * WHOLE live projection, so they are authoritative about absence as well:
 *  - a body of a Task the snapshot leaves out is re-read, whatever it said when
 *    it was read — the Task was archived or deleted (perhaps while this tab was
 *    away), or was archived all along, and no snapshot vouches for it;
 *  - a live body is re-read when the snapshot's revision is newer than the one
 *    it was read at. A body read without a revision (an older server) stays on
 *    the `updatedAt` rule (`reconcileTaskDetails`).
 * Only canonical lists may be passed: a filtered one leaves rows out that are
 * still live.
 */
function reconcileTaskDetailRevisions(
  details: Record<string, LoadState<TaskItem | null>>,
  detailRevisions: Record<string, number>,
  liveRevisions: Record<string, number>,
): Record<string, LoadState<TaskItem | null>> {
  let next = details;
  for (const [id, detail] of Object.entries(details)) {
    if (!dataOf(detail)) continue;
    const live = liveRevisions[id];
    const known = detailRevisions[id];
    const stale = live === undefined || (known !== undefined && live > known);
    if (!stale) continue;
    const refreshing = beginLoad(detail);
    if (refreshing === detail) continue;
    if (next === details) next = { ...details };
    next[id] = refreshing;
  }
  return next;
}

/**
 * Adopt a keyed body read (`getTask`'s answer) — the one path for the socket's
 * correlated reply and for the raw message.
 */
function applyTaskDetailAnswer(
  state: UIState,
  answer: {
    id: string;
    item: TaskItem | null;
    revision?: number | undefined;
    error?: string | undefined;
  },
): UIState {
  const current = state.taskDetails[answer.id] ?? idle<TaskItem | null>();
  const answered = answer.error
    ? failFrom(current, answer.error)
    : ready(answer.item);
  // A read that left the server before an event this tab already applied is
  // adopted (it is still the best body there is) and re-read at once.
  const next =
    !answer.error &&
    answer.revision !== undefined &&
    answer.revision < (state.stateEventRevisions.tasks?.[answer.id] ?? -1)
      ? beginLoad(answered)
      : answered;
  const lru = touchLru(state.taskDetailsLru, answer.id);
  const projection = pruneProjectionCache(
    { ...state.taskDetails, [answer.id]: next },
    lru,
    state.taskMutations,
    state.openTaskProjectionId,
  );
  return {
    ...state,
    taskDetails: projection.cache,
    taskDetailRevisions: retainedTaskDetailRevisions(
      state.taskDetailRevisions,
      projection.cache,
      answer.id,
      answer.error ? undefined : answer.revision,
    ),
    taskDetailsLru: projection.lru,
    ...(answer.error
      ? {}
      : {
          taskStatuses: withTaskStatus(
            state.taskStatuses,
            answer.id,
            answer.item,
          ),
        }),
  };
}

/**
 * The replica input for the mutator's direct reply to `saveTask`: the row it
 * settles (`taskReplica.settle`), or none for an archived Task.
 */
function taskSavedSettle(item: TaskItem, tempId?: string) {
  return {
    kind: "settled",
    ...(tempId !== undefined ? { localId: tempId } : {}),
    id: item.id,
    item: item.archivedAt !== undefined ? null : taskSummaryOf(item),
  } as const;
}

/**
 * Adopt the mutator's direct reply to `saveTask`, after its row settled.
 *
 * The one job the broadcast event cannot do besides the settle: the full
 * `item` becomes the cached body, so a detail view never pays a refetch for the
 * Task it just saved.
 */
function applyTaskSaved(
  state: UIState,
  item: TaskItem,
  revision?: number,
): UIState {
  const detailLru = touchLru(state.taskDetailsLru, item.id);
  const detailCache = pruneProjectionCache(
    { ...state.taskDetails, [item.id]: ready(item) },
    detailLru,
    state.taskMutations,
    state.openTaskProjectionId,
  );
  return {
    ...state,
    taskDetails: detailCache.cache,
    taskDetailRevisions: retainedTaskDetailRevisions(
      state.taskDetailRevisions,
      detailCache.cache,
      item.id,
      revision,
    ),
    taskDetailsLru: detailCache.lru,
    taskStatuses: withTaskStatus(state.taskStatuses, item.id, item),
    error: null,
  };
}

function worktreeCommentsOf(thread: CommentThread): WorktreeComment[] {
  const worktreeId =
    thread.target.kind === "worktree" ? thread.target.worktreeId : "";
  const root: WorktreeComment = {
    id: thread.root.id,
    worktreeId,
    author:
      thread.root.author.kind === "agent" && thread.root.author.sessionId
        ? {
            kind: "agent",
            sessionId: thread.root.author.sessionId,
            ...(thread.root.author.model
              ? { model: thread.root.author.model }
              : {}),
            ...(thread.root.author.thinkingLevel
              ? { thinkingLevel: thread.root.author.thinkingLevel }
              : {}),
          }
        : { kind: "user" },
    body: thread.root.body,
    ...(thread.severity ? { severity: thread.severity } : {}),
    ...(thread.reviewSetId ? { reviewSetId: thread.reviewSetId } : {}),
    ...(thread.resolvedAt ? { resolvedAt: thread.resolvedAt } : {}),
    ...(thread.resolvedBy
      ? { resolvedBy: thread.resolvedBy.sessionId ?? "user" }
      : {}),
    ...(thread.original && thread.target.kind === "worktree"
      ? {
          anchor: {
            path: thread.target.path,
            side: thread.target.side,
            line: thread.original.lineStart,
            commit: thread.target.revision,
            dirty: false,
            selectors: thread.selectors ?? {
              quote: { exact: "", prefix: "", suffix: "" },
              block: {
                id: String(thread.original.lineStart),
                occurrence: 1,
              },
            },
          },
        }
      : {}),
    ...(thread.current
      ? {
          current: {
            path:
              thread.current.path ??
              (thread.target.kind === "worktree" ? thread.target.path : ""),
            line: thread.current.lineStart,
          },
        }
      : {}),
    ...(thread.anchorState ? { anchorState: thread.anchorState } : {}),
    ...(thread.handoffSessionIds[0]
      ? { attachedSessionId: thread.handoffSessionIds[0] }
      : {}),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  return [
    root,
    ...thread.replies.map((reply): WorktreeComment => ({
      id: reply.id,
      worktreeId,
      parentId: thread.id,
      author:
        reply.author.kind === "agent" && reply.author.sessionId
          ? {
              kind: "agent",
              sessionId: reply.author.sessionId,
              ...(reply.author.model ? { model: reply.author.model } : {}),
              ...(reply.author.thinkingLevel
                ? { thinkingLevel: reply.author.thinkingLevel }
                : {}),
            }
          : { kind: "user" },
      body: reply.body,
      createdAt: reply.createdAt,
      updatedAt: reply.editedAt ?? reply.createdAt,
    })),
  ];
}

/**
 * The one place a server message is said out loud — raised from the ARRIVAL,
 * next to `appNotification`, which is answered here for the same reason: an
 * announcement is an event, and there is nothing about it to reduce.
 *
 * It used to be an effect over a global `notice` slot in this state, which is
 * the shape every bug in this area has had — a persistent store asked to name
 * the current event. Identity came from a counter beside the slot, suppression
 * came from comparing the slot's TEXT to whatever some surface happened to be
 * rendering, and a suppressed arrival that was not consumed came back later to
 * announce a failure that was long over. From here there is no later: the
 * message is either said now or owned by something that renders it.
 */
function announceArrival(msg: ServerMessage, state: UIState): void {
  const reveal = state.revealRequest;
  const arrival = arrivalMessage(msg, {
    viewedSessionId: state.session?.sessionId ?? null,
    // A card the viewed transcript still lands on is not a miss to report
    // (`viewedApprovalReveal`), so no jump is waiting to miss.
    revealRequestId:
      reveal && !viewedApprovalRowId(state, reveal.target)
        ? reveal.requestId
        : null,
    revealTargetKind: reveal?.target.kind ?? null,
  });
  if (!arrival || arrivalHasHome(arrival)) return;
  const resolvedName = targetTitle(arrival.target, state);
  const announcement = announceMessage({
    severity: arrival.severity,
    message: arrival.message,
    ...(arrival.target ? { target: arrival.target } : {}),
    ...(resolvedName ? { resolvedName } : {}),
  });
  showToast(announcement.message, {
    tone: announcement.tone,
    durationMs: announcement.durationMs,
    ...(announcement.key ? { key: announcement.key } : {}),
  });
}

/**
 * The human name this client already holds for the object a message names, or
 * undefined — in which case the announcement falls back to type plus id, which
 * is attribution rather than a name (`messageAnnounce.targetName`).
 *
 * A lookup in a list the client is already holding, never a fetch: an
 * announcement is decided and rendered at the arrival, so a name that would have
 * to be asked for is a name it does not have.
 */
function targetTitle(
  target: MessageTarget | undefined,
  state: UIState,
): string | undefined {
  if (!target?.id) return undefined;
  switch (target.type) {
    case "session":
      return state.sessions.find((session) => session.id === target.id)?.title;
    case "project": {
      const project = state.projectList?.projects.find(
        (item) => item.id === target.id,
      );
      return project ? `${project.key} · ${project.name}` : undefined;
    }
    case "task": {
      const task = state.taskList?.items.find((item) => item.id === target.id);
      return task ? `Task-${task.id} ${task.title}` : undefined;
    }
    case "initiative": {
      const initiative = state.initiatives.find(
        (item) => item.id === target.id,
      );
      return initiative ? initiativeName(initiative) : undefined;
    }
    default:
      return undefined;
  }
}

/** How an announcement names an Initiative. */
function initiativeName(initiative: InitiativeSummary): string {
  return `Initiative-${initiative.id} ${initiative.title}`;
}

/** One inspector save of a session's compaction window. */
export interface CompactionWindowEdit {
  requestId: string;
  busy: boolean;
  error?: string;
  /** Local outcome of a genuine connection loss, not provider applied state. */
  unknown?: true;
}

/**
 * The message of a failure about a whole COLLECTION of `type`, or null.
 *
 * A pane that could not load keeps its failure on the collection, and the wire
 * says which one (`MessageTarget` with no member id).
 */
function listFailureFor(
  msg: { message: string; target?: MessageTarget },
  type: MessageTarget["type"],
): string | null {
  return msg.target && !msg.target.id && msg.target.type === type
    ? msg.message
    : null;
}

/**
 * Retire the echo of the prompt send the wire says failed.
 *
 * The echo of a prompt that never ran does not belong in the transcript it was
 * sent to — except a STAGED first send's, which is the whole content of the
 * new-session surface. Dropping that one drops the user back to an empty page
 * with their prompt gone, where keeping it lets the surface show the failure in
 * place with a retry. It is the row that carries `optimisticCanMoveSession`: no
 * session owns it yet.
 *
 * Only the failed send's own echo goes. `failedPromptClientRequestId` is the
 * key the echo was created under, so every other send still in flight is left
 * alone — this used to recognise the sentence and then drop every non-staged
 * echo, since the text could not say which prompt it was about.
 */
function withoutFailedPromptEcho(
  optimistic: OptimisticTimelineEntry[],
  clientRequestId: string,
): OptimisticTimelineEntry[] {
  const id = optimisticEchoId(clientRequestId);
  const retired = optimistic.some(
    (entry) => entry.id === id && !entry.optimisticCanMoveSession,
  );
  return retired ? optimistic.filter((entry) => entry.id !== id) : optimistic;
}

/** Drop one session's failure, returning the same object when there is none. */
function withoutSessionFailure(
  failures: Record<string, string>,
  sessionId: string | undefined,
): Record<string, string> {
  if (!sessionId || failures[sessionId] === undefined) return failures;
  const next = { ...failures };
  delete next[sessionId];
  return next;
}

/**
 * A failure that names a session is a CONDITION on that session, so it is put
 * ON the object — derived from the ARRIVING message, in this one place, rather
 * than at each branch that could raise one: a rule written at ten call sites is
 * a rule that rots at nine, and a missed one is silent (the failure simply
 * never reaches the composer it belongs above).
 *
 * `sessionFailureFrom` is the same function the announcer asks, so the object
 * that keeps a failure and the decision not to also say it in passing can never
 * disagree about which object it was.
 */
export function reduceAssistantState(state: UIState, action: Action): UIState {
  const inner = reduceAssistantStateInner(state, action);
  if (action.kind !== "server") return inner;
  const next = withUnopenableSessions(inner, action.msg);
  const failure = sessionFailureFrom(action.msg);
  if (failure)
    return {
      ...next,
      sessionFailures: {
        ...next.sessionFailures,
        [failure.sessionId]: failure.message,
      },
    };
  // The same rule for the other objects that own a surface, minus the failures a
  // refused control already renders (`controlOwned`).
  const onObject = action.controlOwned ? null : objectFailureFrom(action.msg);
  if (!onObject) return next;
  return {
    ...next,
    objectFailures: {
      ...next.objectFailures,
      [onObject.type]: {
        ...next.objectFailures[onObject.type],
        [onObject.id]: onObject.message,
      },
    },
  };
}

/**
 * Retire the unopenable marks for `ids`, and each one's "cannot be opened"
 * note in `sessionFailures` with it — but only while that note is still the
 * unavailable one: a later, unrelated failure on the same session stays.
 */
function retireUnopenable(state: UIState, ids: readonly string[]): UIState {
  if (ids.length === 0) return state;
  const unopenableSessions = { ...state.unopenableSessions };
  const sessionFailures = { ...state.sessionFailures };
  for (const id of ids) {
    if (sessionFailures[id] === unopenableSessions[id])
      delete sessionFailures[id];
    delete unopenableSessions[id];
  }
  return { ...state, unopenableSessions, sessionFailures };
}

/** Keep {@link UIState.unopenableSessions} in step with an arriving message. */
function withUnopenableSessions(state: UIState, msg: ServerMessage): UIState {
  if (msg.type === "error") {
    const id = msg.target?.type === "session" ? msg.target.id : undefined;
    if (!msg.sessionUnavailable || !id) return state;
    return {
      ...state,
      unopenableSessions: { ...state.unopenableSessions, [id]: msg.message },
    };
  }
  // A new connection reports again whatever still cannot be opened.
  if (msg.type === "ready")
    return retireUnopenable(state, Object.keys(state.unopenableSessions));
  // It opened after all.
  if (
    msg.type === "snapshot" &&
    msg.snapshot.sessionId in state.unopenableSessions
  )
    return retireUnopenable(state, [msg.snapshot.sessionId]);
  return state;
}

function reduceAssistantStateInner(state: UIState, action: Action): UIState {
  if (action.kind === "clearChatError") {
    // An announced failure leaves `error` set on purpose — it is the chat's
    // last outcome, not just a message that has been said. This RETIRES that
    // outcome for a send about to produce a new one; the ordinary prompt path
    // clears it through its optimistic echo, and a first send with no echo of
    // its own (a review handoff) has to say so itself.
    //
    // A SESSION's failure is a different thing and is not retired wholesale: it
    // is per-object, so only the named session's goes, and a caller with no
    // session to name (a staged send, which is creating one) passes none rather
    // than guessing. Retiring a session's failure because of ITS OWN send is
    // `clearSessionFailure`, dispatched by the send — not here, and not by the
    // echo, which an attachments-only prompt never produces.
    const sessionFailures = withoutSessionFailure(
      state.sessionFailures,
      action.sessionId,
    );
    return state.error || sessionFailures !== state.sessionFailures
      ? { ...state, error: null, sessionFailures }
      : state;
  }
  if (action.kind === "clearSessionFailure") {
    // Dispatched by the SEND rather than by its echo. An attachments-only
    // prompt produces no echo, and a staged first send echoes into a session
    // that does not exist yet — both of which left a retry's own failure note
    // standing over the turn that fixed it.
    const sessionFailures = withoutSessionFailure(
      state.sessionFailures,
      action.sessionId,
    );
    return sessionFailures === state.sessionFailures
      ? state
      : { ...state, sessionFailures };
  }
  if (action.kind === "clearObjectFailure") {
    // Per object, like the session case and for the same reason: the write that
    // retires a failure is a write to THAT object, and one project's retry may
    // not silence another's. Dispatched by the write itself (or by the note's
    // dismiss), never by an authoritative broadcast — another tab saving this
    // object is the unrelated traffic a condition on an object has to survive.
    const failures = state.objectFailures[action.type];
    if (failures[action.id] === undefined) return state;
    const next = { ...failures };
    delete next[action.id];
    return {
      ...state,
      objectFailures: { ...state.objectFailures, [action.type]: next },
    };
  }
  if (action.kind === "clearWorktreeProvision") {
    return state.worktreeProvision
      ? withChat(state, { worktreeProvision: null })
      : state;
  }
  if (action.kind === "timelineRangeRequested") {
    return { ...state, timelineRangePending: action.beforeSeq };
  }
  if (action.kind === "revealRequested") {
    return {
      ...state,
      revealRequest: { requestId: action.requestId, target: action.target },
    };
  }
  if (action.kind === "revealSettled") {
    return state.messageReveal?.token === action.token
      ? { ...state, messageReveal: null }
      : state;
  }
  if (action.kind === "sessionDraftConsumed") {
    return state.forkDraft?.token === action.token
      ? { ...state, forkDraft: null }
      : state;
  }
  if (action.kind === "sessionDraftStaged") {
    // Resend reuses the fork draft's one-session handoff: the composer picks it
    // up for THIS session and the user sends it, so nothing is re-run for them.
    return {
      ...state,
      forkDraft: {
        sessionId: action.sessionId,
        text: action.text,
        token: Date.now(),
      },
    };
  }
  if (action.kind === "optimisticSettings") {
    return {
      ...state,
      settings: applyOptimisticSettings(state.settings, action.patch),
      error: null,
    };
  }
  if (action.kind === "replicaItems") {
    const { msg, purpose } = action;
    if (msg.topic === "tasks") {
      const applied = applyTopicMessage(taskReplica, state, {
        kind: "items",
        purpose,
        events: msg.events,
      });
      if (purpose !== "recovery") return applied;
      // A recovered Task also restores the pull-request card whose write
      // refused it; cross-domain, so it stays outside the replica.
      const pullRequestCards = reconcilePullRequestCardTaskRecovery(
        applied.pullRequestCards,
        msg.events,
      );
      return pullRequestCards === applied.pullRequestCards
        ? applied
        : withChat(applied, { pullRequestCards });
    }
    return msg.topic === "projects"
      ? applyTopicMessage(projectReplica, state, {
          kind: "items",
          purpose,
          events: msg.events,
        })
      : applyTopicMessage(initiativeReplica, state, {
          kind: "items",
          purpose,
          events: msg.events,
        });
  }
  if (action.kind === "replicaBaselineLost") {
    const input = { kind: "baselineLost", ids: action.ids } as const;
    if (action.topic === "tasks")
      return applyTopicMessage(taskReplica, state, input);
    if (action.topic === "projects")
      return applyTopicMessage(projectReplica, state, input);
    if (action.topic === "initiatives")
      return applyTopicMessage(initiativeReplica, state, input);
    if (action.topic === "sessions")
      return applyTopicMessage(sessionReplica, state, input);
    return state;
  }
  if (action.kind === "optimisticProjectSave") {
    const projectList = applyOptimisticProjectSave(
      state.projectList,
      action.id,
      action.patch,
      action.now,
    );
    // The editor owns its attempted draft until correlation settles. Keep the
    // full-detail cache authoritative: a rejected save emits no Project event,
    // so writing the patch here would leave false domain data on screen.
    return projectList === state.projectList
      ? state
      : { ...state, projectList, error: null };
  }
  if (action.kind === "optimisticProjectReorder") {
    const projectList = applyOptimisticProjectReorder(
      state.projectList,
      action.placements,
    );
    return projectList === state.projectList
      ? state
      : { ...state, projectList };
  }
  if (action.kind === "projectDetailLoad") {
    const current =
      state.projectDetails[action.id] ?? idle<ProjectRecord | null>();
    return {
      ...state,
      projectDetails: {
        ...state.projectDetails,
        [action.id]: beginLoad(current),
      },
      projectDetailsLru: touchLru(state.projectDetailsLru, action.id),
    };
  }
  if (action.kind === "projectDetailResult") {
    const current =
      state.projectDetails[action.id] ?? idle<ProjectRecord | null>();
    const lru = touchLru(state.projectDetailsLru, action.id);
    const keep = new Set([
      ...lru.slice(-PROJECT_DETAIL_CACHE_LIMIT),
      ...(state.openProjectProjectionId ? [state.openProjectProjectionId] : []),
    ]);
    const answered = action.error
      ? failFrom(current, action.error)
      : ready(action.item);
    const knownSummaryRevision =
      state.stateEventRevisions.projects?.[action.id] ?? -1;
    const nextDetail =
      !action.error &&
      action.revision !== undefined &&
      action.revision < knownSummaryRevision
        ? beginLoad(answered)
        : answered;
    const projectDetails = Object.fromEntries(
      Object.entries({
        ...state.projectDetails,
        [action.id]: nextDetail,
      }).filter(([id]) => keep.has(id)),
    );
    return {
      ...state,
      projectDetails,
      projectDetailRevisions:
        action.revision === undefined
          ? state.projectDetailRevisions
          : { ...state.projectDetailRevisions, [action.id]: action.revision },
      projectDetailsLru: lru.filter((id) => keep.has(id)),
    };
  }
  if (action.kind === "projectSaved")
    return applyProjectSaved(state, action.item, action.revision);
  if (action.kind === "initiativeDetailLoad") {
    const current =
      state.initiativeDetails[action.id] ?? idle<InitiativeRead | null>();
    return {
      ...state,
      initiativeDetails: {
        ...state.initiativeDetails,
        [action.id]: beginLoad(current),
      },
      initiativeDetailsLru: touchLru(state.initiativeDetailsLru, action.id),
    };
  }
  if (action.kind === "initiativeDetailResult") {
    const current =
      state.initiativeDetails[action.id] ?? idle<InitiativeRead | null>();
    const answered = action.error
      ? failFrom(current, action.error)
      : ready(action.read);
    // An answer older than a summary revision this tab already holds was read
    // before that write: show it, and read again.
    const knownSummaryRevision =
      state.stateEventRevisions.initiatives?.[action.id] ?? -1;
    const next =
      !action.error &&
      action.revision !== undefined &&
      action.revision < knownSummaryRevision
        ? beginLoad(answered)
        : answered;
    return {
      ...state,
      ...pruneInitiativeDetails(
        state,
        { ...state.initiativeDetails, [action.id]: next },
        action.revision === undefined
          ? state.initiativeDetailRevisions
          : {
              ...state.initiativeDetailRevisions,
              [action.id]: action.revision,
            },
        touchLru(state.initiativeDetailsLru, action.id),
      ),
    };
  }
  if (action.kind === "initiativeListSubscribed") {
    // Only an answered list has anything to refresh; before that it is still
    // the first read.
    return state.initiativesFresh
      ? { ...state, initiativesFresh: false, initiativesRefreshing: true }
      : state;
  }
  if (action.kind === "initiativeListFailed")
    return {
      ...state,
      initiativeListError: action.message,
      initiativesRefreshing: false,
    };
  if (action.kind === "initiativeListRetry") {
    return state.initiativeListError === null
      ? state
      : { ...state, initiativeListError: null };
  }
  if (action.kind === "setOpenInitiative") {
    return state.openInitiativeId === action.id
      ? state
      : { ...state, openInitiativeId: action.id };
  }
  if (action.kind === "initiativeDetailPin") {
    const count = (state.initiativeDetailPins[action.id] ?? 0) + action.delta;
    const { [action.id]: _released, ...others } = state.initiativeDetailPins;
    const pinned: UIState = {
      ...state,
      initiativeDetailPins:
        count > 0 ? { ...others, [action.id]: count } : others,
    };
    // A released read rejoins the idle LRU, inside its bound again.
    return action.delta < 0
      ? {
          ...pinned,
          ...pruneInitiativeDetails(
            pinned,
            pinned.initiativeDetails,
            pinned.initiativeDetailRevisions,
            pinned.initiativeDetailsLru,
          ),
        }
      : pinned;
  }
  if (action.kind === "setOpenProjectProjection") {
    return state.openProjectProjectionId === action.id
      ? state
      : { ...state, openProjectProjectionId: action.id };
  }
  if (action.kind === "projectMutationStart") {
    return {
      ...state,
      projectMutations: {
        ...state.projectMutations,
        [action.key]: beginLoad(
          state.projectMutations[action.key] ?? idle<true>(),
        ),
      },
    };
  }
  if (action.kind === "projectMutationRelease") {
    const current = state.projectMutations[action.key];
    if (!current || !isPending(current)) return state;
    return {
      ...state,
      projectMutations: {
        ...state.projectMutations,
        [action.key]: idle<true>(),
      },
    };
  }
  if (action.kind === "projectMutationResult") {
    const current = state.projectMutations[action.key] ?? idle<true>();
    return {
      ...state,
      projectMutations: {
        ...state.projectMutations,
        [action.key]: action.error
          ? failFrom(current, action.error)
          : ready(true),
      },
    };
  }
  if (action.kind === "optimisticSessionRename") {
    return {
      ...updateSessionRows(state, (rows) =>
        applyOptimisticSessionRename(
          rows,
          action.sessionId,
          action.title,
          action.now,
        ),
      ),
      error: null,
    };
  }
  if (action.kind === "optimisticSpawnOwnership") {
    return {
      ...updateSessionRows(state, (rows) =>
        rows.map((session) =>
          session.id === action.sessionId && session.spawnedBySessionId
            ? { ...session, spawnOwnership: action.ownership }
            : session,
        ),
      ),
      error: null,
    };
  }
  if (action.kind === "optimisticSessionSettle") {
    // A peer already down keeps its settled time, as the server's cascade
    // does, so it does not jump to the top of the shelf until the list lands.
    const alreadySettled = new Set(
      state.sessions
        .filter((session) => session.settledAt !== undefined)
        .map((session) => session.id),
    );
    return {
      ...updateSessionRows(state, (rows) => {
        let next = applyOptimisticSessionSettle(
          rows,
          action.sessionId,
          action.settled,
          action.now,
        );
        for (const sessionId of action.peerSessionIds)
          if (!alreadySettled.has(sessionId))
            next = applyOptimisticSessionSettle(
              next,
              sessionId,
              true,
              action.now,
            );
        return next;
      }),
      error: null,
    };
  }
  if (action.kind === "compactionWindowRequested")
    return {
      ...state,
      compactionWindowEdits: {
        ...state.compactionWindowEdits,
        [action.sessionId]: { requestId: action.requestId, busy: true },
      },
    };
  if (action.kind === "compactionWindowAnswered") {
    // Only the session's latest save speaks; an earlier one's late answer
    // must not clear a newer one's busy state.
    if (
      state.compactionWindowEdits[action.sessionId]?.requestId !==
      action.requestId
    )
      return state;
    return {
      ...state,
      compactionWindowEdits: {
        ...state.compactionWindowEdits,
        [action.sessionId]: {
          requestId: action.requestId,
          busy: false,
          ...(action.error !== undefined ? { error: action.error } : {}),
          ...(action.unknown ? { unknown: true } : {}),
        },
      },
    };
  }
  if (action.kind === "optimisticWorkflowRunSettle") {
    const settled = updateSessionRows(state, (rows) => {
      let next = rows;
      for (const sessionId of action.sessionIds)
        next = applyOptimisticSessionSettle(next, sessionId, true, action.now);
      return next;
    });
    return {
      ...settled,
      workflowRuns:
        state.workflowRuns?.map((run) =>
          run.id === action.runId && run.attention
            ? {
                ...run,
                attention: {
                  ...run.attention,
                  // The same clamp the server applies: a click that saw an
                  // older revision leaves the newer event awake here too,
                  // rather than hiding it until the authoritative list lands.
                  settledRevision: Math.max(
                    run.attention.settledRevision,
                    Math.min(run.attention.revision, action.throughRevision),
                  ),
                },
              }
            : run,
        ) ?? null,
      error: null,
    };
  }
  if (action.kind === "optimisticInboxPositions") {
    const sessionPositions = new Map<string, number>();
    const runPositions = new Map<string, number>();
    for (const entry of action.positions)
      if (entry.kind === "session")
        sessionPositions.set(entry.id, entry.position);
      else runPositions.set(entry.runId, entry.position);
    const placed =
      sessionPositions.size > 0
        ? updateSessionRows(state, (rows) =>
            rows.map((session) => {
              const inboxPosition = sessionPositions.get(session.id);
              return inboxPosition === undefined
                ? session
                : { ...session, inboxPosition };
            }),
          )
        : state;
    return {
      ...placed,
      workflowRuns:
        runPositions.size > 0 && state.workflowRuns
          ? state.workflowRuns.map((run) => {
              const inboxPosition = runPositions.get(run.id);
              return inboxPosition === undefined
                ? run
                : { ...run, inboxPosition };
            })
          : state.workflowRuns,
      error: null,
    };
  }
  if (action.kind === "optimisticSessionDelete") {
    return {
      ...updateSessionRows(state, (rows) =>
        rows.some((session) => session.id === action.sessionId)
          ? rows.filter((session) => session.id !== action.sessionId)
          : rows,
      ),
      error: null,
    };
  }
  if (action.kind === "archivedReadRequested")
    return state.archivedReadQueued
      ? state
      : { ...state, archivedReadQueued: true };
  if (action.kind === "archivedReadSent")
    return {
      ...state,
      archivedReadQueued: false,
      archivedReadFlight: action.requestId,
    };
  if (action.kind === "archivedReadReleased")
    return state.archivedReadFlight === action.requestId
      ? { ...state, archivedReadFlight: null }
      : state;

  if (action.kind === "backgroundStopSent") {
    return {
      ...state,
      ...(action.itemId
        ? {
            backgroundStopPending: state.backgroundStopPending.includes(
              action.itemId,
            )
              ? state.backgroundStopPending
              : [...state.backgroundStopPending, action.itemId],
          }
        : {}),
      ...(action.ownerSessionId
        ? {
            backgroundStopAllPending: state.backgroundStopAllPending.includes(
              action.ownerSessionId,
            )
              ? state.backgroundStopAllPending
              : [...state.backgroundStopAllPending, action.ownerSessionId],
            // A fresh Stop-all supersedes whatever the previous one waited on.
            backgroundHostCloseWaiting: state.backgroundHostCloseWaiting.filter(
              (id) => id !== action.ownerSessionId,
            ),
          }
        : {}),
    };
  }
  if (action.kind === "clearWorkflowRunStart") {
    if (!(action.requestId in state.workflowRunStarts)) return state;
    const workflowRunStarts = { ...state.workflowRunStarts };
    delete workflowRunStarts[action.requestId];
    return { ...state, workflowRunStarts };
  }
  if (action.kind === "worktreeListLoad") {
    return {
      ...state,
      worktreesFresh: false,
      worktreeListError: null,
    };
  }
  if (action.kind === "libraryLoad") {
    // Same query, so rows already on screen stay put and only the refresh
    // indicator changes; a first visit has nothing to keep and plainly loads.
    const field = LIBRARY_STATE_FIELD[action.library];
    return { ...state, [field]: beginLoad(state[field]) };
  }
  if (action.kind === "modelsRefreshSent") {
    return { ...state, modelsRefreshRequestId: action.requestId };
  }
  if (action.kind === "skillTogglesSent") {
    // `settings` is deliberately untouched: the checkbox keeps showing the last
    // echo. Only the base for the NEXT write moves, and it moves to the NEWEST
    // write — which already contains every earlier pending change.
    return {
      ...state,
      pendingSkillToggles: {
        requestId: action.requestId,
        skills: action.skills,
      },
    };
  }
  if (action.kind === "skillTogglesAnswered") {
    // Only its own answer retires a base. An earlier write's answer describes
    // settings that predate this one, so treating it as "the server has caught
    // up" would send the next toggle without the change still in flight.
    return state.pendingSkillToggles?.requestId === action.requestId
      ? { ...state, pendingSkillToggles: null }
      : state;
  }
  if (action.kind === "optimisticWorktreeRemove") {
    return {
      ...state,
      worktrees:
        state.worktrees?.filter(
          (worktree) => worktree.id !== action.worktreeId,
        ) ?? null,
      error: null,
    };
  }
  if (action.kind === "optimisticPullRequestCardAction") {
    const pullRequestCards = updateClientPullRequestCard(
      state.pullRequestCards,
      action.cardId,
      (card) => {
        return {
          ...withoutStoredOutcome(card),
          pendingAction: action.action,
          ...(action.action === "mark-task-done" && card.linkedTask
            ? {
                optimisticLinkedTask: {
                  ...card.linkedTask,
                  status: "done",
                },
              }
            : {}),
        };
      },
    );
    return pullRequestCards === state.pullRequestCards
      ? state
      : withChat(state, { pullRequestCards });
  }
  if (action.kind === "pullRequestCardActionResult") {
    const pullRequestCards = updateClientPullRequestCard(
      state.pullRequestCards,
      action.cardId,
      (card) => {
        if (action.authoritativeCard)
          return action.error
            ? { ...action.authoritativeCard, actionError: action.error }
            : action.authoritativeCard;
        if (!card.pendingAction && !card.optimisticLinkedTask && !action.error)
          return card;
        const {
          pendingAction: _pendingAction,
          optimisticLinkedTask: _optimisticLinkedTask,
          ...settled
        } = card;
        return action.error
          ? { ...settled, actionError: action.error }
          : settled;
      },
    );
    return pullRequestCards === state.pullRequestCards
      ? state
      : withChat(state, { pullRequestCards });
  }
  if (action.kind === "optimisticWorkflowDelivery") {
    const workflowCards = updateWorkflowDelivery(
      state.workflowCards,
      action.runId,
      (delivery) => ({ ...delivery, pendingAction: action.action }),
    );
    return workflowCards === state.workflowCards
      ? state
      : { ...state, workflowCards };
  }
  if (action.kind === "workflowDeliveryResult") {
    const workflowCards = updateWorkflowDelivery(
      state.workflowCards,
      action.runId,
      (delivery) => {
        if (!delivery.pendingAction && !action.error) return delivery;
        const { pendingAction: _pendingAction, ...settled } = delivery;
        return action.error
          ? { ...settled, error: action.error }
          : { ...settled };
      },
    );
    return workflowCards === state.workflowCards
      ? state
      : { ...state, workflowCards };
  }
  if (action.kind === "optimisticUserMessage") {
    // Show the user's prompt instantly as a transient user timeline entry; the
    // server's durable user `timelineDelta` (same clientRequestId) reconciles it.
    const entry: OptimisticTimelineEntry = {
      id: optimisticEchoId(action.clientRequestId),
      seq: Number.MAX_SAFE_INTEGER,
      createdAt: "",
      type: "message",
      role: "user",
      origin: { kind: "human" },
      content: [
        ...(action.text ? [{ type: "text" as const, text: action.text }] : []),
        ...(action.images ?? []).map((image) => ({
          type: "image" as const,
          mimeType: image.mimeType,
          name: image.name,
          size: image.size,
          ref: image.ref,
        })),
      ],
      ...(action.sessionId ? { optimisticSessionId: action.sessionId } : {}),
      ...(action.canMoveSession ? { optimisticCanMoveSession: true } : {}),
    };
    // Keyed by clientRequestId, so re-sending under the SAME id (a first send
    // retried after its worktree provisioning failed) replaces the echo in
    // place instead of showing the prompt twice.
    const optimistic = state.optimistic.some((o) => o.id === entry.id)
      ? state.optimistic.map((o) => (o.id === entry.id ? entry : o))
      : [...state.optimistic, entry];
    return withChat(
      {
        ...state,
        error: null,
        // A re-send under the same id is a NEW prompt in that row: it carries
        // whatever queue condition the server reports next, never the one the
        // send it replaced was left in.
        promptQueueStates: withPromptQueueState(
          state.promptQueueStates,
          entry.id,
          null,
        ),
      },
      { optimistic },
    );
  }
  if (action.kind === "optimisticTaskSave") {
    const taskList = applyOptimisticTaskSave(
      state.taskList,
      action.request,
      action.tempId,
      action.now,
    );
    return taskList === state.taskList
      ? state
      : { ...state, taskList, error: null };
  }
  if (action.kind === "optimisticTaskProjectAssignment") {
    const taskList = applyOptimisticTaskProjectAssignment(
      state.taskList,
      action.updates,
      action.now,
    );
    return taskList === state.taskList
      ? state
      : { ...state, taskList, error: null };
  }
  if (action.kind === "optimisticTaskRemove") {
    const list = state.taskList;
    if (!list || !canOptimisticallyUpdateTaskList(list)) return state;
    const items = list.items.filter((item) => item.id !== action.id);
    if (items.length === list.items.length) return state;
    return { ...state, taskList: { ...list, items }, error: null };
  }
  if (action.kind === "optimisticTaskReorder") {
    const taskList = applyOptimisticTaskReorder(
      state.taskList,
      action.placements,
    );
    return taskList === state.taskList ? state : { ...state, taskList };
  }
  if (action.kind === "taskSaved") {
    return applyTaskSaved(
      applyTopicMessage(
        taskReplica,
        state,
        taskSavedSettle(action.item, action.tempId),
      ),
      action.item,
      action.revision,
    );
  }
  if (action.kind === "taskDetailLoad") {
    const current = state.taskDetails[action.id] ?? idle<TaskItem | null>();
    return {
      ...state,
      taskDetails: {
        ...state.taskDetails,
        [action.id]: beginLoad(current),
      },
      taskDetailsLru: touchLru(state.taskDetailsLru, action.id),
    };
  }
  if (action.kind === "taskDetailResult")
    return applyTaskDetailAnswer(state, action);
  if (action.kind === "unwatchComments") {
    const key = commentTargetKey(action.target);
    const comments = { ...state.comments };
    const commentTargets = { ...state.commentTargets };
    const commentRevisions = { ...state.commentRevisions };
    delete comments[key];
    delete commentTargets[key];
    delete commentRevisions[key];
    if (action.target.kind === "worktree") {
      const worktreeComments = { ...state.worktreeComments };
      const worktreeReviewSets = { ...state.worktreeReviewSets };
      const worktreeReviewSetRevisions = {
        ...state.worktreeReviewSetRevisions,
      };
      delete worktreeComments[action.target.worktreeId];
      delete worktreeReviewSets[action.target.worktreeId];
      delete worktreeReviewSetRevisions[action.target.worktreeId];
      return {
        ...state,
        comments,
        commentTargets,
        commentRevisions,
        worktreeComments,
        worktreeReviewSets,
        worktreeReviewSetRevisions,
      };
    }
    return { ...state, comments, commentTargets, commentRevisions };
  }
  if (action.kind === "taskMutationStart") {
    return {
      ...state,
      taskMutations: {
        ...state.taskMutations,
        [action.key]: beginLoad(
          state.taskMutations[action.key] ?? idle<true>(),
        ),
      },
    };
  }
  if (action.kind === "taskMutationRelease") {
    const current = state.taskMutations[action.key];
    if (!current || !isPending(current)) return state;
    return {
      ...state,
      taskMutations: { ...state.taskMutations, [action.key]: idle<true>() },
    };
  }
  if (action.kind === "taskMutationResult") {
    const current = state.taskMutations[action.key] ?? idle<true>();
    return {
      ...state,
      taskMutations: {
        ...state.taskMutations,
        [action.key]: action.error
          ? failFrom(current, action.error)
          : ready(true),
      },
    };
  }
  if (action.kind === "setOpenTaskProjection") {
    return state.openTaskProjectionId === action.id
      ? state
      : { ...state, openTaskProjectionId: action.id };
  }
  if (action.kind === "credentialProfileProjection") {
    return { ...state, credentialProfileProjection: action.projection };
  }
  if (action.kind === "status") {
    // A cached app shell should not become interactive merely because the socket
    // opened; wait for the server's authoritative `ready` snapshot first. Once
    // we've had a live snapshot, reconnect status can update immediately.
    const connected = action.connected && state.hydrationSource === "live";
    // Reconnecting clears the reload state; a disconnect keeps it (we're likely
    // mid-reload) so it persists across the brief gap. It renders in the app
    // status slot (`AppStatus`), which is where app-wide lifecycle state lives
    // now that there is no banner channel (`docs/messaging.md`).
    return {
      ...state,
      connected,
      // Cache-seeded and previous-episode lists stay visible, but a disconnect
      // makes them due for either a subscription snapshot or one-off read.
      sessionListFresh: action.connected ? state.sessionListFresh : false,
      // A read in flight on the closed socket is never answered; the
      // reconnect snapshot marks the slice stale, so an open shelf re-reads.
      archivedReadFlight: action.connected ? state.archivedReadFlight : null,
      archivedReadQueued: action.connected ? state.archivedReadQueued : false,
      taskListFresh: action.connected ? state.taskListFresh : false,

      initiativesFresh: action.connected ? state.initiativesFresh : false,
      initiativesRefreshing: action.connected
        ? state.initiativesRefreshing
        : false,
      projectListFresh: action.connected ? state.projectListFresh : false,
      worktreesFresh: action.connected ? state.worktreesFresh : false,
      worktreeListError: action.connected ? state.worktreeListError : null,
      // A dropped socket makes an in-flight skill write unknowable, so the last
      // echo becomes the base again rather than a map that may never have been
      // received. A model refresh is the same: its reply is never coming, and a
      // spinner nothing can retire outlives the connection that started it.
      pendingSkillToggles: action.connected ? state.pendingSkillToggles : null,
      modelsRefreshRequestId: action.connected
        ? state.modelsRefreshRequestId
        : null,
      reloading: connected ? null : state.reloading,
    };
  }
  const msg = action.msg;
  if (msg.type === "permanentAssistantQueue") {
    // `queued`/`working` are the CONDITIONS one queued prompt is in, and they
    // land on its own row: the optimistic echo, keyed by the same
    // clientRequestId the send created it under. `completed` and `failed`
    // RESOLVE them, so they retire the entry rather than writing another one.
    //
    // Answered ABOVE the viewed-session guard below because it is not a
    // streamed delta of a turn: the terminal frame has to retire this row's
    // condition wherever the user is standing, or navigating away mid-queue
    // leaves a "Working" behind that nothing will ever clear.
    //
    // The FAILURE is not handled here at all. It is a session failure like any
    // other, kept by `sessionFailureFrom`, and it is retired the way every
    // other one is — the dismiss, or that session's own next send. Notably NOT
    // by a later `completed`: the producer emits completed or failed per item,
    // never both for the same one, so a completion is always some OTHER item's
    // and retiring a failure with it is precisely the unrelated traffic a
    // condition on an object has to survive.
    const rowId = optimisticEchoId(msg.clientRequestId);
    const unresolved =
      msg.state === "queued" || msg.state === "working" ? msg.state : null;
    const promptQueueStates = withPromptQueueState(
      state.promptQueueStates,
      rowId,
      unresolved,
    );
    return promptQueueStates === state.promptQueueStates
      ? state
      : { ...state, promptQueueStates };
  }
  // A session taken away while it was only LOADING here (its route pending,
  // nothing on show): there is no chat to clear, but the route must still
  // learn that its address names nothing now.
  if (
    msg.type === "sessionViewCleared" &&
    msg.sessionId !== state.session?.sessionId
  )
    return {
      ...state,
      viewCleared: { sessionId: msg.sessionId, reason: msg.reason },
    };
  // Drop streamed events addressed to a session we're no longer viewing. The
  // server tags every turn event with its sessionId; the snapshot in `history`
  // is authoritative, so late deltas from a session we switched away from (or
  // that arrived before the switch settled) are simply ignored.
  if ("sessionId" in msg && msg.sessionId !== state.session?.sessionId) {
    return state;
  }
  switch (msg.type) {
    case "ready":
      // The runtime-native `snapshot` (sent just before `ready` on load) is the
      // chat-load authority, so `ready` only sets app + session shell — it preserves
      // the timeline/streams/runState the snapshot or ordered runtime events
      // established (and ignores legacy history).
      return withChat(
        {
          ...state,
          hydrated: true,
          hydrationSource: "live",
          shellCachedAt: null,
          connected: true,
          models: msg.models,
          agents: msg.agents,
          // The session list is the `sessions` subscription's snapshot.
          session: msg.state,
          settings: { ...defaultSettings, ...msg.settings },
          speechToText: msg.speechToText,
          serverBuild: msg.serverBuild,
          slashCommands: msg.slashCommands,
          // The Task list is NOT part of `ready` any more: it is a subscribed
          // topic, so a browser that shows a Backlog surface receives the
          // authoritative snapshot when it subscribes (which happens on every
          // connection), and one that never does receives none of that traffic.
          // Any locally cached list therefore stands until that snapshot lands.
          contextInfo: msg.contextInfo,
          historySessionId: msg.state?.sessionId ?? null,
          error: null,
          reloading: null,
          peerPromptCardOverrides: seedPeerPromptCardOverridesFromHistory(
            msg.state?.peerPrompts,
          ),
        },
        {},
      );
    case "snapshot": {
      // Atomic per-session load: state + context + the runtime-native timeline/
      // streams/runState, applied together so the UI swaps the whole session at once.
      const snap = msg.snapshot;
      // Re-ATTACHING to the session already in view — a reconnect (the socket
      // URL carries the viewed session), a cache-bearing reload — is not a
      // session swap, and the store-backed card overlays have to survive it.
      // They are not IN this snapshot: the server re-emits them as separate
      // messages right after it (`connection.view`), which is a later frame, so
      // blanking them here UNMOUNTS every approval and pull-request card in the
      // transcript and remounts it a paint later. Every other row keeps its key
      // across the same frame, so what the reader sees is one card blinking on
      // its own — and the merge that refreshes a base checkout is exactly what
      // restarts a dev server, so it lands on the card being used. Neither store
      // ever drops a card, so what is kept here can only be replaced by the
      // re-emit, never left behind by it.
      const reattached = snap.sessionId === state.session?.sessionId;
      return withChat(
        {
          ...state,
          runProgress: snap.progress
            ? { progress: snap.progress, receivedAt: Date.now() }
            : null,
          session: msg.state,
          contextInfo: msg.contextInfo,
          historySessionId: msg.state.sessionId,
          // The transcript may be a WINDOW of a long session: these carry what
          // precedes it, so "load earlier" and the Session cumulative are right
          // without the entries themselves.
          timelineStart: snap.timelineStart,
          turnStatsSeed: snap.turnStatsSeed ?? EMPTY_TURN_STATS_SEED,
          timelineRangePending: null,
          snapshotGeneration: state.snapshotGeneration + 1,
          taskDetails: reconcileTaskDetails(
            state.taskDetails,
            msg.state.tasks,
            msg.state.relatedGlobalTasks,
          ),
          // Seed from the authoritative bounded history (not just {}), so
          // reopening/navigating to a session after transitions already
          // happened shows their real current state, not a frozen snapshot.
          peerPromptCardOverrides: seedPeerPromptCardOverridesFromHistory(
            msg.state.peerPrompts,
          ),
        },
        {
          timeline: snap.timeline,
          liveStreams: snap.streaming,
          optimistic: optimisticForSnapshot(
            state.optimistic,
            snap.sessionId,
            snap.timeline,
          ),
          approvals: reattached ? state.approvals : [],
          pullRequestCards: reattached ? state.pullRequestCards : [],
          runState: snap.runState,
          // Viewing a session ends any first-send provisioning overlay: a
          // succeeded one handed over to the durable genesis card, and a failed
          // one belongs to the new-session surface the user just left.
          worktreeProvision: null,
        },
      );
    }
    case "state": {
      const currentSessionId = state.session?.sessionId;
      // Session switches are loaded by an atomic `snapshot`; a `state` frame only
      // updates metadata of the ALREADY-viewed session and must never establish
      // one. Drop it unless it targets the current view — including when there is
      // no view yet (`state.session === null`), otherwise a stray frame for
      // another session would silently adopt it as the viewed session.
      if (!currentSessionId || currentSessionId !== msg.state.sessionId) {
        return state;
      }
      const taskDetails = reconcileTaskDetails(
        state.taskDetails,
        msg.state.tasks,
        msg.state.relatedGlobalTasks,
      );
      const base = {
        ...state,
        session: msg.state,
        taskDetails,
        // Defense-in-depth reconciliation: merge (not replace) so any
        // authoritative history update also refreshes overrides, even if a
        // future code path ever forgets a dedicated peerPromptCardUpdate.
        peerPromptCardOverrides: {
          ...state.peerPromptCardOverrides,
          ...seedPeerPromptCardOverridesFromHistory(msg.state.peerPrompts),
        },
      };
      return withChat(base, {});
    }
    case "sessionViewCleared":
      return withChat(
        {
          ...state,
          session: null,
          contextInfo: null,
          historySessionId: null,
          viewCleared: { sessionId: msg.sessionId, reason: msg.reason },
          timelineStart: 0,
          turnStatsSeed: EMPTY_TURN_STATS_SEED,
          timelineRangePending: null,
          peerPromptCardOverrides: {},
          error: null,
        },
        {
          timeline: [],
          liveStreams: [],
          optimistic: [],
          approvals: [],
          pullRequestCards: [],
          runState: "idle",
          worktreeProvision: null,
        },
      );
    case "contextInfo":
      if (msg.info.sessionId !== msg.sessionId) return state;
      return { ...state, contextInfo: msg.info };
    case "speechToTextStatus":
      return { ...state, speechToText: msg.status };
    case "settings":
      // Authoritative for what the controls SHOW, and nothing more: an echo
      // names no request, so it cannot say which skill write it answers. One
      // arriving while a later write is still out describes settings that are
      // already behind `pendingSkillToggles`, and retiring that base here would
      // send the next toggle without the change in flight
      // (`skillTogglesAnswered` is what retires it).
      return { ...state, settings: msg.settings, error: null };
    case "models":
      return {
        ...state,
        models: msg.models,
        // Only the answer to the refresh this client started retires the
        // button; a `models` send from any other cause leaves it spinning.
        ...(msg.requestId !== undefined &&
        msg.requestId === state.modelsRefreshRequestId
          ? { modelsRefreshRequestId: null }
          : {}),
      };
    case "permanentAssistantUnread":
      return state.permanentAssistantUnread === msg.unread
        ? state
        : { ...state, permanentAssistantUnread: msg.unread };
    case "permanentAssistantOpened": {
      // The Assistant session chat arrived via the transport `snapshot` (from the
      // server's view() switch just before this message); swap in the session
      // shell while the dedicated `/assistant` route remains stable even when
      // the singleton has no messages yet.
      return withChat(
        {
          ...state,
          session: msg.state,
          contextInfo: msg.contextInfo,
          historySessionId: msg.state.sessionId,
          error: null,
        },
        {},
      );
    }
    case "jiraStatus":
      return {
        ...state,
        settings: msg.settings,
        jiraStatus: msg.status,
        error: null,
      };
    case "confluenceStatus":
      return {
        ...state,
        settings: msg.settings,
        confluenceStatus: msg.status,
        error: null,
      };
    case "tempoStatus":
      return {
        ...state,
        settings: msg.settings,
        tempoStatus: msg.status,
        error: null,
      };
    case "googleStatus":
      return {
        ...state,
        settings: msg.settings,
        googleStatus: msg.status,
        error: null,
      };
    case "slackStatus":
      return {
        ...state,
        settings: msg.settings,
        slackStatus: msg.status,
        error: null,
      };
    case "openAiCompatibleStatus":
      return {
        ...state,
        settings: msg.settings,
        models: msg.models,
        openAiCompatibleStatus: msg.status,
        error: null,
      };
    case "braveStatus":
      return {
        ...state,
        settings: msg.settings,
        braveStatus: msg.status,
        error: null,
      };
    case "context7Status":
      return {
        ...state,
        settings: msg.settings,
        context7Status: msg.status,
        error: null,
      };
    case "githubStatus":
      return {
        ...state,
        settings: msg.settings,
        githubStatus: msg.status,
        error: null,
      };
    case "forgejoStatus":
      return {
        ...state,
        settings: msg.settings,
        forgejoStatus: msg.status,
        error: null,
      };
    case "sessionList":
      // The session list reaches every connection (not just the session's
      // viewers), but the viewed chat's runState is owned by the runtime snapshot
      // and ordered runtime events. Treat list rows as sidebar metadata only.
      return applyTopicMessage(sessionReplica, state, msg);
    case "archivedSessionCount": {
      if (msg.count === state.archivedSessionCount) return state;
      return queueArchivedRead({ ...state, archivedSessionCount: msg.count });
    }
    case "archivedSessions":
      // Only the flight's own answer: a timed-out or pre-disconnect read's
      // late answer neither releases the flight nor overwrites the slice.
      if (msg.requestId !== state.archivedReadFlight) return state;
      return {
        ...withSessionSlices(
          state,
          state.liveSessions,
          sortedByUpdatedAt(msg.sessions),
        ),
        archivedSessionCount: msg.archivedSessionCount,
        archivedSessionsLoaded: true,
        archivedReadFlight: null,
      };
    case "objectLinksResolved":
      return {
        ...state,
        objectLinks: mergeObjectLinks(state.objectLinks, msg.links),
      };
    case "stateEvents":
      return applyEvent(state, msg);
    case "stateDigest":
      return msg.topic === "tasks"
        ? applyTopicMessage(taskReplica, state, msg)
        : msg.topic === "projects"
          ? applyTopicMessage(projectReplica, state, msg)
          : applyTopicMessage(initiativeReplica, state, msg);
    case "stateItems":
      // Every answer arrives as `replicaItems`, tagged by its purpose.
      return state;
    case "backgroundWorkList":
      return applyTopicMessage(backgroundReplica, state, msg);
    case "backgroundWorkStopAnswer": {
      // Control feedback only: it retires the pending flag on the button that
      // was pressed and records a deferred host close. Nothing here writes a
      // row — those arrive as `background` state events.
      const answered = new Set(msg.items.map((entry) => entry.itemId));
      const owner = msg.ownerSessionId;
      const waiting = msg.hostCloseWaiting?.protectedTurn === true;
      return {
        ...state,
        backgroundStopPending: state.backgroundStopPending.filter(
          (id) => !answered.has(id),
        ),
        ...(owner
          ? {
              backgroundStopAllPending: state.backgroundStopAllPending.filter(
                (id) => id !== owner,
              ),
              backgroundHostCloseWaiting: waiting
                ? state.backgroundHostCloseWaiting.includes(owner)
                  ? state.backgroundHostCloseWaiting
                  : [...state.backgroundHostCloseWaiting, owner]
                : state.backgroundHostCloseWaiting.filter((id) => id !== owner),
            }
          : {}),
      };
    }
    case "initiativeList":
      return applyTopicMessage(initiativeReplica, state, msg);
    case "initiativeDetail":
      // Correlated before reducer dispatch in the socket effect.
      return state;
    case "taskList":
      // A filtered read is refused: `taskList` is only ever the canonical
      // live projection.
      return applyTopicMessage(taskReplica, state, msg);
    case "taskProjectsAssigned":
      // The assignment's rows arrive as `stateEvents`; this only confirms it,
      // and the moved rows are the receipt. The counter exists so the Backlog's
      // Undo toast — which IS earned, because it carries an action — has a
      // signal to hang on.
      return {
        ...state,
        taskProjectsAssignedSeq: state.taskProjectsAssignedSeq + 1,
        // A new outcome RETIRES the previous one. Clearing only `error` left
        // the failed attempt's notice standing on the global carrier, where a
        // later successful retry would still find it.
        error: null,
      };
    case "projectList":
      // Filtered reads are independent projections and never own the canonical
      // reducer/cache slot: the descriptor admits only the canonical list.
      return applyTopicMessage(projectReplica, state, msg);
    case "projectDetail":
    case "projectSaved":
      // Correlated before reducer dispatch in the socket effect.
      return state;
    case "usageIndicators":
      return { ...state, usageIndicators: msg.indicators };
    case "worktreeList":
      return {
        ...state,
        worktrees: msg.worktrees,
        worktreesFresh: true,
        worktreeListError: null,
      };
    case "workflowRunList":
      return {
        ...state,
        workflowRuns: msg.runs,
        workflowCards: withPendingDelivery(msg.cards, state.workflowCards),
      };
    case "libraryList": {
      // A failed scan keeps the last good library beside its error (R2); it
      // never becomes an empty library, which would be a claim about authored
      // content that this message cannot make.
      const field = LIBRARY_STATE_FIELD[msg.library];
      return {
        ...state,
        [field]: msg.list ? ready(msg.list) : failFrom(state[field], msg.error),
      };
    }
    case "workflowRunStart":
      return {
        ...state,
        workflowRunStarts: {
          ...state.workflowRunStarts,
          [msg.requestId]: {
            requestId: msg.requestId,
            phase: msg.phase,
            ...(msg.runId ? { runId: msg.runId } : {}),
            ...(msg.branch ? { branch: msg.branch } : {}),
            ...(msg.error ? { error: msg.error } : {}),
          },
        },
      };
    case "worktreeStatus": {
      const current = state.worktreeStatuses[msg.status.worktreeId];
      if (current && wireValueEqual(current, msg.status)) return state;
      return {
        ...state,
        worktreeStatuses: {
          ...state.worktreeStatuses,
          [msg.status.worktreeId]: msg.status,
        },
      };
    }
    case "worktreeNameProposal":
      return {
        ...state,
        worktreeNameProposal: { requestId: msg.requestId, name: msg.name },
      };
    case "worktreeProvision":
      // A client overlay, not timeline content: the live card belongs to the
      // SEND (keyed by its clientRequestId), which outlives a failed provision
      // that never produced a session at all. `created` hands over to the
      // server's durable genesis card, which arrives with the session.
      return withChat(state, {
        worktreeProvision:
          msg.provision.state === "created"
            ? null
            : { clientRequestId: msg.clientRequestId, ...msg.provision },
      });
    case "worktreeChanges":
      // The worktree detail page refetches off the paired `worktreeStatus`
      // push (its updatedAt is the refresh key); the change list itself is
      // fetched over HTTP, so nothing is stored here.
      return state;
    case "commentsSnapshot": {
      const targetKey = commentTargetKey(msg.target);
      const comments = { ...state.comments, [targetKey]: msg.threads };
      const commentTargets = {
        ...state.commentTargets,
        [targetKey]: msg.target,
      };
      const commentRevisions = {
        ...state.commentRevisions,
        [targetKey]: Object.fromEntries(
          msg.revisions.map((entry) => [entry.id, entry.revision]),
        ),
      };
      if (msg.target.kind === "worktree")
        return {
          ...state,
          comments,
          commentTargets,
          commentRevisions,
          worktreeComments: {
            ...state.worktreeComments,
            [msg.target.worktreeId]: msg.threads.flatMap(worktreeCommentsOf),
          },
          worktreeReviewSets: {
            ...state.worktreeReviewSets,
            [msg.target.worktreeId]: msg.reviewSets ?? [],
          },
          worktreeReviewSetRevisions: {
            ...state.worktreeReviewSetRevisions,
            [msg.target.worktreeId]: Object.fromEntries(
              (msg.reviewSetRevisions ?? []).map((entry) => [
                entry.id,
                entry.revision,
              ]),
            ),
          },
        };
      return { ...state, comments, commentTargets, commentRevisions };
    }
    case "commentEvents": {
      const targetKey = commentTargetKey(msg.target);
      const before = state.commentRevisions[targetKey] ?? {};
      const events = msg.events.filter(
        (event) => event.revision > (before[event.id] ?? 0),
      );
      const reviewSetBefore =
        msg.target.kind === "worktree"
          ? (state.worktreeReviewSetRevisions[msg.target.worktreeId] ?? {})
          : {};
      const reviewSetEvents = (msg.reviewSetEvents ?? []).filter(
        (event) => event.revision > (reviewSetBefore[event.id] ?? 0),
      );
      if (events.length === 0 && reviewSetEvents.length === 0) return state;

      let worktreeReviewSets = state.worktreeReviewSets;
      let worktreeReviewSetRevisions = state.worktreeReviewSetRevisions;
      if (msg.target.kind === "worktree" && reviewSetEvents.length) {
        const sets = [
          ...(state.worktreeReviewSets[msg.target.worktreeId] ?? []),
        ];
        const setRevisions = { ...reviewSetBefore };
        for (const event of reviewSetEvents) {
          setRevisions[event.id] = event.revision;
          const index = sets.findIndex((set) => set.id === event.id);
          if (event.kind === "delete") {
            if (index >= 0) sets.splice(index, 1);
          } else if (index >= 0) sets[index] = event.item;
          else sets.push(event.item);
        }
        worktreeReviewSets = {
          ...state.worktreeReviewSets,
          [msg.target.worktreeId]: sets,
        };
        worktreeReviewSetRevisions = {
          ...state.worktreeReviewSetRevisions,
          [msg.target.worktreeId]: setRevisions,
        };
      }
      if (events.length === 0)
        return {
          ...state,
          worktreeReviewSets,
          worktreeReviewSetRevisions,
        };

      const targetRevisions = { ...before };
      for (const event of events) targetRevisions[event.id] = event.revision;
      const commentRevisions = {
        ...state.commentRevisions,
        [targetKey]: targetRevisions,
      };
      const threads = [...(state.comments[targetKey] ?? [])];
      for (const event of events) {
        const index = threads.findIndex((thread) => thread.id === event.id);
        if (event.kind === "delete") {
          if (index >= 0) threads.splice(index, 1);
        } else if (index >= 0) threads[index] = event.item;
        else threads.push(event.item);
      }
      const comments = { ...state.comments, [targetKey]: threads };
      const commentTargets = {
        ...state.commentTargets,
        [targetKey]: state.commentTargets[targetKey] ?? msg.target,
      };
      if (msg.target.kind === "worktree")
        return {
          ...state,
          comments,
          commentTargets,
          commentRevisions,
          worktreeComments: {
            ...state.worktreeComments,
            [msg.target.worktreeId]: threads.flatMap(worktreeCommentsOf),
          },
          worktreeReviewSets,
          worktreeReviewSetRevisions,
        };
      return { ...state, comments, commentTargets, commentRevisions };
    }
    case "worktreeMergeUpdate":
      return {
        ...state,
        worktreeMerge: {
          ...state.worktreeMerge,
          [msg.worktreeId]: {
            phase: msg.phase,
            ...(msg.message !== undefined ? { message: msg.message } : {}),
            ...(msg.conflictPaths !== undefined
              ? { conflictPaths: msg.conflictPaths }
              : {}),
            ...(msg.agentSessionId !== undefined
              ? { agentSessionId: msg.agentSessionId }
              : {}),
          },
        },
      };
    case "taskSaved":
      // The socket handler routes every `taskSaved` through the `taskSaved`
      // ACTION instead, because only it can look up the create's temp id. This
      // is the same adoption without one, for any other dispatcher of the raw
      // message (tests, a replayed transcript of frames).
      return applyTaskSaved(
        applyTopicMessage(taskReplica, state, taskSavedSettle(msg.item)),
        msg.item,
        msg.revision,
      );
    case "taskDetail":
      return applyTaskDetailAnswer(state, msg);
    case "forkedSession": {
      // The new session's chat arrived via the transport `snapshot` (sent by the
      // server's view() switch just before this message); we only update session
      // shell + navigation here, preserving that timeline.
      const token = Date.now();
      return withChat(
        {
          ...state,
          session: msg.state,
          contextInfo: msg.contextInfo,
          historySessionId: msg.state.sessionId,
          error: null,
          forkSwitch: { sessionId: msg.state.sessionId, token },
          forkDraft: msg.selectedText
            ? { sessionId: msg.state.sessionId, text: msg.selectedText, token }
            : null,
        },
        {},
      );
    }
    case "draftSession":
      return withChat(
        {
          ...state,
          session: msg.state,

          contextInfo: msg.contextInfo,
          historySessionId: msg.state.sessionId,
          error: null,
          forkDraft: {
            sessionId: msg.state.sessionId,
            text: msg.draftText,
            token: Date.now(),
          },
        },
        {},
      );
    case "event":
      if (msg.sessionId !== state.session?.sessionId) return state;
      return applyRuntimeEvent(state, msg.event);
    case "timelineRange": {
      // A late or racing answer is DROPPED, never spliced: it is only applied
      // when it joins the rendered suffix exactly — same session, anchored at
      // the current first entry, and ending where that entry begins.
      if (msg.sessionId !== state.session?.sessionId) return state;
      const first = state.timeline[0];
      if (
        !first ||
        first.seq !== msg.beforeSeq ||
        msg.entries.length === 0 ||
        msg.timelineStart + msg.entries.length !== state.timelineStart ||
        msg.entries.at(-1)!.seq >= first.seq
      )
        return {
          ...state,
          timelineRangePending:
            state.timelineRangePending === msg.beforeSeq
              ? null
              : state.timelineRangePending,
        };
      return withChat(
        {
          ...state,
          timelineStart: msg.timelineStart,
          // The seed moves back with the window, so every turn row already on
          // screen keeps the cumulative it was rendered with.
          turnStatsSeed: msg.turnStatsSeed ?? EMPTY_TURN_STATS_SEED,
          timelineRangePending: null,
        },
        { timeline: [...msg.entries, ...state.timeline] },
      );
    }
    case "timelineBlockLoaded":
      if (msg.sessionId !== state.session?.sessionId) return state;
      return withChat(state, {
        timeline: applyTimelineBlockLoaded(
          state.timeline,
          msg.entryId,
          msg.blockIndex,
          msg.kind,
          msg.content,
        ),
      });
    case "notice":
      // Said at its arrival; what remains is the viewed chat's outcome.
      return { ...state, error: msg.severity === "error" ? msg.message : null };
    case "accountHealthChanged":
      return state;
    case "accountLoginAlerts":
      return { ...state, accountLoginAlerts: msg.accounts };
    case "devReload":
      return {
        ...state,
        reloading: {
          phase: msg.phase,
          ...(msg.runningCount !== undefined
            ? { runningCount: msg.runningCount }
            : {}),
        },
      };
    case "error":
      return withChat(
        {
          ...state,
          // A list that could not be read is a CONDITION on the collection, and
          // the server now says which collection: this used to recognise the
          // sentence, which put the failure in the wrong pane — or in none —
          // the moment anyone reworded it.
          projectListError:
            listFailureFor(msg, "project") ?? state.projectListError,
          taskListError: listFailureFor(msg, "task") ?? state.taskListError,
          initiativeListError:
            listFailureFor(msg, "initiative") ?? state.initiativeListError,
          worktreeListError:
            listFailureFor(msg, "worktree") ?? state.worktreeListError,
          error: msg.message,
        },
        {
          liveStreams: [],
          runState: "idle",
          // A prompt that never ran says so on the wire, naming the send it
          // was: the reducer retires that one echo and reads no sentences.
          ...(msg.failedPromptClientRequestId
            ? {
                optimistic: withoutFailedPromptEcho(
                  state.optimistic,
                  msg.failedPromptClientRequestId,
                ),
              }
            : {}),
        },
      );
    case "approvalUpdate":
      if (msg.sessionId !== state.session?.sessionId) return state;
      return withChat(state, {
        approvals: upsertApproval(state.approvals, msg.approval),
      });
    case "approvalGrants": {
      if (msg.sessionId !== state.session?.sessionId) return state;
      const approvalGrants = reconcileApprovalGrants(state.approvalGrants, msg);
      return approvalGrants === state.approvalGrants
        ? state
        : { ...state, approvalGrants };
    }
    case "pullRequestCardUpdate":
      if (msg.sessionId !== state.session?.sessionId) return state;
      return withChat(state, {
        pullRequestCards: upsertPullRequestCard(
          state.pullRequestCards,
          msg.card,
        ),
      });
    case "promptQueue": {
      // A queue change arrives on its own; the next `state` frame carries the
      // same value, so this only patches the session already in view.
      const viewed = state.session;
      if (!viewed || viewed.sessionId !== msg.sessionId) return state;
      const { promptQueue: _previous, ...rest } = viewed;
      return {
        ...state,
        session:
          msg.queue.items.length > 0 || msg.queue.automaticTurnsHeld
            ? { ...rest, promptQueue: msg.queue }
            : rest,
      };
    }
    case "peerPromptQueue": {
      // Like `promptQueue`: the next `state` frame carries the same list.
      const viewed = state.session;
      if (!viewed || viewed.sessionId !== msg.sessionId) return state;
      const { queuedPeerPrompts: _previous, ...rest } = viewed;
      return {
        ...state,
        session:
          msg.items.length > 0
            ? { ...rest, queuedPeerPrompts: msg.items }
            : rest,
      };
    }
    case "backgroundUpdateQueue": {
      // Like `promptQueue`: the next `state` frame carries the same count.
      const viewed = state.session;
      if (!viewed || viewed.sessionId !== msg.sessionId) return state;
      const unhandled = msg.unhandled ?? 0;
      const batch = msg.unhandledBatch ?? [];
      if (
        (viewed.queuedBackgroundUpdates ?? 0) === msg.count &&
        (viewed.unhandledBackgroundUpdates ?? 0) === unhandled &&
        JSON.stringify(viewed.unhandledBackgroundBatch ?? []) ===
          JSON.stringify(batch)
      )
        return state;
      const {
        queuedBackgroundUpdates: _previous,
        unhandledBackgroundUpdates: _previousUnhandled,
        unhandledBackgroundBatch: _previousBatch,
        ...rest
      } = viewed;
      return {
        ...state,
        session: {
          ...rest,
          ...(msg.count > 0 ? { queuedBackgroundUpdates: msg.count } : {}),
          ...(unhandled > 0
            ? {
                unhandledBackgroundUpdates: unhandled,
                unhandledBackgroundBatch: batch,
              }
            : {}),
        },
      };
    }
    case "peerPromptCardUpdate":
      if (msg.sessionId !== state.session?.sessionId) return state;
      // Store-backed reconciliation: patch the card sharing this messageKey in
      // place (sender tool card and recipient transcript block both read this
      // overlay at render time) rather than freezing the creation-time snapshot.
      return {
        ...state,
        peerPromptCardOverrides: {
          ...state.peerPromptCardOverrides,
          [msg.messageKey]: {
            state: msg.state,
            ...(msg.failureReason !== undefined
              ? { failureReason: msg.failureReason }
              : {}),
            ...(msg.interruption !== undefined
              ? { interruption: msg.interruption }
              : {}),
            ...(msg.settledReason !== undefined
              ? { settledReason: msg.settledReason }
              : {}),
          },
        },
      };
    case "timelineAnchor": {
      // Only the jump still being waited on: an answer to a superseded request
      // would send the reader somewhere they already navigated away from.
      if (state.revealRequest?.requestId !== msg.requestId) return state;
      // A miss is said once at the arrival and leaves nothing behind: the jump
      // is simply no longer pending.
      if (!msg.anchor) {
        const fallback = viewedApprovalReveal(
          state,
          state.revealRequest.target,
        );
        return fallback
          ? { ...state, revealRequest: null, messageReveal: fallback }
          : { ...state, revealRequest: null };
      }
      return {
        ...state,
        revealRequest: null,
        messageReveal: { ...msg.anchor, token: Date.now() },
      };
    }
    default:
      return state;
  }
}

function mergeObjectLinks(
  current: Record<string, PaObjectLinkResolution>,
  links: PaObjectLinkResolution[],
): Record<string, PaObjectLinkResolution> {
  if (links.length === 0) return current;
  const next = { ...current };
  for (const link of links) next[link.uri] = link;
  return next;
}

function lazyBlockCacheKey(
  sessionId: string,
  entryId: string,
  blockIndex: number,
  kind: LazyBlockKind,
): string {
  return `${sessionId}:${entryId}:${blockIndex}:${kind}`;
}

interface PendingLazyBlockLoad {
  sessionId: string;
  entryId: string;
  blockIndex: number;
  kind: LazyBlockKind;
  /** Reads issued for this key since it was last answered; bounds the retry. */
  attempts: number;
}

/** A failed durable-body read is retried this many times, after this pause. */
const LAZY_BLOCK_MAX_ATTEMPTS = 2;
const LAZY_BLOCK_RETRY_MS = 1_500;

function applyTimelineBlockLoaded(
  timeline: ClientTimelineEntry[],
  entryId: string,
  blockIndex: number,
  kind: LazyBlockKind,
  content: unknown,
): ClientTimelineEntry[] {
  return timeline.map((entry) => {
    if (
      entry.id !== entryId ||
      entry.type === "command.result" ||
      !Array.isArray(entry.content)
    )
      return entry;
    const block = entry.content[blockIndex];
    if (!block) return entry;
    const nextContent = [...entry.content];
    if (kind === "toolInput" && block.type === "toolCall") {
      const {
        inputLazy: _inputLazy,
        inputSummary: _inputSummary,
        ...rest
      } = block;
      nextContent[blockIndex] = { ...rest, input: content };
    } else if (
      kind === "thinking" &&
      block.type === "thinking" &&
      typeof content === "string"
    ) {
      const { lazy: _lazy, ...rest } = block;
      nextContent[blockIndex] = { ...rest, text: content };
    } else if (
      kind === "toolOutput" &&
      block.type === "text" &&
      typeof content === "string"
    ) {
      const { lazy: _lazy, ...rest } = block;
      nextContent[blockIndex] = { ...rest, text: content };
    } else {
      return entry;
    }
    return { ...entry, content: nextContent } as ClientTimelineEntry;
  });
}

/**
 * Everything the FIRST prompt of a staged session carries. Named (and one
 * object rather than a positional list) because the host has to be able to hold
 * one and re-issue it verbatim when worktree provisioning failed.
 */
export interface HarnessSendInput {
  id: string;
  harness: Harness;
  agentType: AgentType;
  text: string;
  attachments?: PromptAttachment[];
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  /** Start the session in this {@link SessionMode} (absent = Build). */
  mode?: SessionMode;
  /** The explicit account; absent means Automatic (the server's router picks). */
  credentialProfileId?: string;
  /** Only enterprise accounts may run the session, at start and on any switch. */
  requiresEnterprise?: boolean;
  attachTaskId?: string;
  projectId?: string;
  worktreeId?: string;
  /** "+ New worktree": provision one in this project before creating the session. */
  createWorktreeInProjectId?: string;
  /** A document staged as context, as its canonical viewer route. */
  fileContext?: string;
  /** Start the session as this agent definition; the server resolves it again. */
  agent?: string;
  /**
   * Reuse a previous send's id when re-issuing it (a first send retried after
   * its worktree provisioning failed), so the optimistic echo is replaced
   * rather than duplicated. Omitted for a fresh send, which mints one.
   */
  clientRequestId?: string;
}

export interface AssistantActions {
  prompt: (
    text: string,
    attachments?: PromptAttachment[],
    attachTaskId?: string,
    projectId?: string,
    fileContext?: string,
  ) => void;
  runSlashCommand: (name: string, rawArgs: string) => void;
  /**
   * Send a typed `/<skill> args` line as a user skill invocation
   * (`docs/skills.md`). `text` is the line as typed and is what the transcript
   * keeps; the server translates it to the harness's native command.
   */
  promptSkill: (text: string, skill: string) => void;
  /** Edit a session's prompt queue; the server answers with its new state. */
  promptQueue: (command: PromptQueueCommand) => void;
  acceptCommitDryRun: (entryId: string) => void;
  respondToQuestion: (response: AgentQuestionResponse) => void;
  abort: () => void;
  loadTimelineBlock: (
    entryId: string,
    blockIndex: number,
    kind: LazyBlockKind,
  ) => void;
  /**
   * A rendered block starts (`true`) or stops (`false`) showing a live body.
   * The server streams text for exactly the bodies in demand; everything else
   * arrives as compact refs.
   */
  setLiveBodyDemand: (
    sessionId: string,
    key: LiveBodyKey,
    wanted: boolean,
  ) => void;
  /**
   * Ask for the entries before the windowed transcript's first one. A no-op when
   * the transcript already starts at the session start or a request is pending.
   */
  loadOlderTimeline: () => void;
  setModel: (provider: string, id: string) => void;
  setThinkingLevel: (level: ThinkingLevel) => void;
  /** Switch the viewed session between Build and Plan (any point in its life). */
  setSessionMode: (mode: SessionMode) => void;
  refreshModels: () => void;
  /** Keep the boot-critical account/model projection in the shell cache. */
  setCredentialProfileProjection: (
    projection: CredentialProfileProjection,
  ) => void;
  /** Fetch the full settings object on demand for the Settings page. */
  requestSettings: () => void;
  /** Create a fresh pi bootstrap session of the given agent type (assistant/workshop). */
  newSession: (
    agentType: AgentType,
    model?: { provider: string; id: string },
    thinkingLevel?: ThinkingLevel,
  ) => void;
  /**
   * Create a staged session on its first prompt (Claude-SDK keeps the client
   * id; pi is server-minted). Returns the `clientRequestId` used, so the caller
   * can key first-send feedback (worktree provisioning) to its own send.
   */
  harnessSend: (input: HarnessSendInput) => string;
  /**
   * Start the IndexedDB read of a session's cached timeline prefix before the
   * navigation to it commits (a tap on its row). `loadSession` then finds the
   * answer in memory instead of waiting for it; calling both reads once.
   */
  warmSessionTimeline: (id: string) => void;
  /** View a session addressed by OUR id. */
  loadSession: (id: string) => void;
  openPermanentAssistant: () => void;
  releasePermanentAssistant: (sessionId: string) => void;
  /** Fetch archived session rows after the archived sidebar section is expanded. */
  loadArchivedSessions: () => void;
  deleteSession: (id: string) => void;
  /** Hide a session from the default list (reversible). Pass archived=false to restore. */
  archiveSession: (id: string, archived?: boolean) => void;
  /**
   * Move a session out of the Sessions inbox working set (reversible with
   * `settled=false`). Unlike archive it stays in the list, and the server
   * brings it back when the session's next run completes or fails — a peer a
   * coordinator still owns only on a failure, its completion being the
   * coordinator's to act on. The settle
   * acknowledges the attention revision the current row carries, so it cannot
   * hide an outcome that landed after the row was rendered. Settling also
   * shelves the peers the session still coordinates, exactly as the server
   * settles them with it.
   */
  settleSession: (id: string, settled?: boolean) => void;
  /**
   * Dismiss the failure a session's row shows, without settling it: the
   * session stays in the working set and its peers and queue are untouched.
   * Sends the failure the current row carries, so a newer one is never
   * dismissed by it; the authoritative list broadcast is the only update.
   */
  dismissSessionFailure: (
    id: string,
    errorAt: number | undefined,
    outcomeRevision: number,
  ) => void;
  /**
   * Settle a formal Workflow Run out of the Sessions inbox (Task-677): the
   * command acknowledges `throughRevision` — the attention revision the
   * CLICKED item rendered, captured by the caller at the click — and the
   * server settles the run's role sessions with it.
   */
  settleWorkflowRun: (runId: string, throughRevision: number) => void;
  /**
   * Place Sessions inbox items where the user dragged them
   * (`planInboxDrop`). Optimistic: the cards stay where they were dropped,
   * and a refusal re-reads the lists.
   */
  setInboxPositions: (positions: InboxPositionEntry[]) => void;
  renameSession: (id: string, title: string) => void;
  /** `/rename`: the naming agent retitles the session from its recent turns. */
  regenerateSessionTitle: (id: string, guidance: string) => void;
  /**
   * Take a spawned peer over, or hand it back to the coordinator that spawned
   * it — the user's explicit word on ownership; messaging a peer never moves
   * it. Optimistic, like a Settle: the inbox re-folds at once, and a refusal
   * (carrying this requestId) triggers the recovery refetch.
   */
  setSpawnOwnership: (id: string, ownership: SettableSpawnOwnership) => void;
  setSessionPeerTurnCap: (sessionId: string, cap: number | null) => void;
  /**
   * Stop one background item, or everything one session owns, under HUMAN
   * authorization. The server calls the supervisor's Stop service directly; the
   * browser only marks its own control pending and waits for the events.
   */
  stopBackgroundWork: (itemId: string) => void;
  stopAllBackgroundWork: (ownerSessionId: string) => void;
  /**
   * Accept running a session in the app working directory after the worktree it
   * ran in disappeared. The server answers with a fresh session state/list that
   * clears `worktreeMissing`, so nothing is applied optimistically.
   */
  acknowledgeMissingWorktree: (id: string) => void;
  forkSession: (id: string, entryId: string, position: "before" | "at") => void;
  createDraftSession: (
    agentType: AgentType,
    draftText: string,
    notice?: string,
  ) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  /**
   * Turn ONE skill on or off ([Task-613](pa://task/613)). Named per skill
   * rather than taking a map because the outbound map is this layer's to build:
   * the section is replaced whole, and only here is the map that was last sent
   * known, so consecutive toggles accumulate instead of overwriting each other.
   * Nothing changes on screen until the settings echo arrives.
   */
  setSkillEnabled: (name: string, on: boolean) => void;
  updateJiraSettings: (patch: JiraSettingsPatch) => void;
  saveAndTestJiraSettings: (patch: JiraSettingsPatch) => void;
  testJiraSettings: () => void;
  updateConfluenceSettings: (patch: ConfluenceSettingsPatch) => void;
  saveAndTestConfluenceSettings: (patch: ConfluenceSettingsPatch) => void;
  testConfluenceSettings: () => void;
  updateTempoSettings: (patch: TempoSettingsPatch) => void;
  saveAndTestTempoSettings: (patch: TempoSettingsPatch) => void;
  testTempoSettings: () => void;
  updateGoogleSettings: (patch: GoogleSettingsPatch) => void;
  saveAndTestGoogleSettings: (patch: GoogleSettingsPatch) => void;
  testGoogleSettings: () => void;
  updateSlackSettings: (patch: SlackSettingsPatch) => void;
  saveAndTestSlackSettings: (patch: SlackSettingsPatch) => void;
  testSlackSettings: () => void;
  updateOpenAiCompatibleSettings: (
    patch: OpenAiCompatibleSettingsPatch,
  ) => void;
  saveAndTestOpenAiCompatibleSettings: (
    patch: OpenAiCompatibleSettingsPatch,
  ) => void;
  testOpenAiCompatibleSettings: () => void;
  updateBraveSettings: (patch: BraveSettingsPatch) => void;
  saveAndTestBraveSettings: (patch: BraveSettingsPatch) => void;
  testBraveSettings: () => void;
  updateContext7Settings: (patch: Context7SettingsPatch) => void;
  saveAndTestContext7Settings: (patch: Context7SettingsPatch) => void;
  testContext7Settings: () => void;
  updateGithubSettings: (patch: GithubSettingsPatch) => void;
  saveAndTestGithubSettings: (patch: GithubSettingsPatch) => void;
  testGithubSettings: () => void;
  updateForgejoSettings: (patch: ForgejoSettingsPatch) => void;
  saveAndTestForgejoSettings: (patch: ForgejoSettingsPatch) => void;
  testForgejoSettings: () => void;
  /**
   * Declare which domain lists this browser is showing (see `BroadcastTopic`).
   * Idempotent: only the difference is sent, and subscribing delivers that
   * topic's authoritative snapshot.
   */
  setTopics: (topics: readonly BroadcastTopic[]) => void;
  /**
   * Ask the server to revalidate stale subscription-usage numbers. A hint the
   * cache is free to ignore, so a visible page may ping it on a heartbeat.
   */
  refreshUsage: () => void;
  listTasks: (request: TaskListRequest) => void;
  saveTask: (
    request: TaskSaveRequest,
    operation?: TaskMutationOperation,
  ) => void;
  assignTaskProjects: (updates: TaskProjectAssignmentUpdate[]) => void;
  listProjects: (request?: ProjectListRequest) => void;
  requestProjectDetail: (id: string) => void;
  setOpenProjectProjection: (id: string | null) => void;
  /**
   * Read one Initiative's graph and the layout with `collapsed` drawn as one
   * node each. One read per Initiative is in flight: asked again for the same
   * set it sends nothing, and for another set it sends the newest one when the
   * read in flight answers, dropping that answer.
   */
  requestInitiativeDetail: (id: string, collapsed?: readonly string[]) => void;
  /**
   * Hold `id`'s read in the cache while a surface draws it; call the returned
   * release on collapse or unmount. Counted, so two holders need two releases.
   */
  retainInitiativeDetail: (id: string) => () => void;
  setOpenInitiative: (id: string | null) => void;
  /**
   * Ask for the Initiative list again after it failed: the subscription is
   * already held, so it is dropped and taken again for a fresh snapshot, as a
   * sequence gap does. Does nothing while no surface holds the topic.
   */
  retryInitiatives: () => void;
  saveProject: (id: string, patch: Partial<ProjectRecord>) => void;
  provisionProjectRepo: (id: string) => void;
  removeProjectRepo: (id: string) => void;
  reorderProjects: (
    orderedIds: string[],
    placements?: { id: string; parentId?: string | null }[],
  ) => void;
  archiveProject: (id: string) => void;
  deleteProject: (id: string) => void;
  /** Hide a Task from the Backlog; `archived=false` restores it (the archive Undo). */
  archiveTask: (id: string, archived?: boolean) => void;
  deleteTask: (id: string) => void;
  /** Pin/unpin the Task route's keyed detail entry in its LRU cache. */
  setOpenTaskProjection: (id: string | null) => void;
  /** Request the full task body for the Task surface; same-id reads are correlated. */
  requestTaskDetail: (id: string) => void;
  reorderTasks: (
    orderedIds: string[],
    placements?: { id: string; parentId?: string | null }[],
  ) => void;
  cancelPostReloadContinuation: () => void;
  /**
   * Jump to the OTHER party's copy of one peer-prompt message, addressed by the
   * key its card carries here. Answered as a {@link MessageReveal}: where the
   * message lives is the server's to say, since it is in another session's log.
   */
  revealPeerPromptMessage: (messageKey: string) => void;
  /** Jump to one entry of any session by our own durable entry id (fork origins, `#m-` deep links). */
  revealTimelineEntry: (sessionId: string, entryId: string) => void;
  /**
   * Jump to one approval card, wherever it has scrolled to: the composer's
   * pending-approval strip and `pa://approval/<id>` links. The server names the
   * session and how far back the proposing turn sits.
   */
  revealApproval: (approvalId: string) => void;
  /**
   * The jump landed: retire it. A reveal that outlives its landing is a jump
   * waiting to happen again — the next visit to that session arrives on a fresh
   * tail, and the walk back to the old anchor would start over.
   */
  retireMessageReveal: (token: number) => void;
  /**
   * The composer took the staged draft: retire it. From here the text is the
   * composer's own — editable, sendable, and persisted browser-locally under the
   * session's draft key. A staged draft that outlives that hand-off is text the
   * composer stages again on every remount, so clearing the field or sending it
   * would not stick: navigating back would bring the old draft with it.
   */
  retireSessionDraft: (token: number) => void;
  /** Put text into the composer for one session (prompt resend, fork handoff). */
  stageSessionDraft: (sessionId: string, text: string) => void;
  /** Resolve compact metadata for pa:// app object links. */
  resolveObjectLinks: (requestId: string, uris: string[]) => void;
  /**
   * Retire the chat's last failure before a send that will produce a new one.
   * An announced failure leaves `state.error` set on purpose, so a surface that
   * renders that error in place has to be able to clear it.
   */
  clearChatError: (sessionId?: string) => void;
  /**
   * Retire the failure a project, Task or Knowledge entry is carrying — the
   * dismiss on its in-place note. The object's own next write retires it too, so
   * a retry never leaves the failure it fixed standing over the fix.
   */
  dismissObjectFailure: (type: ObjectFailureType, id: string) => void;
  /**
   * Approve or reject a pending approval card (executes the action server-side
   * on approve). `edits` carries the user's per-row changes to an editable body
   * — they are applied as part of the approval, never patched onto the stored
   * card beforehand.
   */
  resolveApproval: (
    approvalId: string,
    decision: import("@assistant/shared").ApprovalDecision,
    edits?: import("@assistant/shared").ApprovalResolutionEdits,
    forSession?: boolean,
    grantInheritable?: boolean,
  ) => void;
  /** Withdraw one of a session's "Approve for session" grants. */
  revokeApprovalGrant: (sessionId: string, key: string) => void;
  /**
   * Grant one operation for the rest of a session, from the inspector;
   * `inheritable` also covers the sessions it starts.
   */
  grantApprovalForSession: (
    sessionId: string,
    key: string,
    inheritable?: boolean,
  ) => void;
  /** Set the scope of a session's own grants named in `keys`. */
  setApprovalGrantScope: (
    sessionId: string,
    keys: string[],
    inheritable: boolean,
  ) => void;
  /** Set (`tokens`) or clear (`null`) a session's compaction window. */
  setCompactionWindow: (sessionId: string, tokens: number | null) => string;
  /** Answer a `choosing-task` pull-request card's Task-disambiguation prompt. */
  choosePullRequestTask: (cardId: string, taskId: string | null) => void;
  /**
   * Run a modelled pull-request card mutation. The initiating card reacts
   * locally until the server's durable `busyAction`/outcome takes over; linked
   * Task and cleanup effects are applied through their canonical reducers.
   */
  runPullRequestCardAction: (
    cardId: string,
    action: import("@assistant/shared").PullRequestCardAction,
    options?: import("@assistant/shared").PullRequestCardActionOptions,
  ) => void;
  /** Fetch the worktree list (all projects, or one). */
  listWorktrees: (projectId?: string) => void;
  /** Start/stop live change watching for a worktree (view open/closed). */
  watchWorktree: (worktreeId: string) => void;
  unwatchWorktree: (worktreeId: string) => void;
  /** Fetch a worktree's review comments. */
  listWorktreeComments: (worktreeId: string) => void;
  unwatchWorktreeComments: (worktreeId: string) => void;
  /** Add a thread root (with anchor) or a reply (with parentId). */
  addWorktreeComment: (input: {
    worktreeId: string;
    body: string;
    anchor?: NewWorktreeCommentAnchor;
    parentId?: string;
  }) => void;
  resolveWorktreeComment: (commentId: string, resolved: boolean) => void;
  deleteWorktreeComment: (commentId: string) => void;
  /** Merge the worktree branch back into its base branch. */
  mergeWorktree: (worktreeId: string, strategy?: WorktreeMergeStrategy) => void;
  /** Hand selected comment threads to an agent session as review context. */
  attachWorktreeComments: (input: {
    worktreeId: string;
    commentIds: string[];
    target:
      | { kind: "existing"; sessionId: string; additionalPrompt?: string }
      | {
          kind: "new";
          harness: Harness;
          agentType: AgentType;
          modelProvider?: string;
          modelId?: string;
          thinkingLevel?: ThinkingLevel;
          /** Build/Plan the draft was staged in (absent = Build). */
          mode?: SessionMode;
          /** The explicit account; absent means Automatic. */
          credentialProfileId?: string;
          /** Only enterprise accounts may run the session. */
          requiresEnterprise?: boolean;
          additionalPrompt: string;
          attachments?: PromptAttachment[];
        };
  }) => void;
  /** Ask the naming agent for a suffix proposal; the reply echoes `requestId`. */
  proposeWorktreeName: (input: {
    projectId: string;
    requestId: string;
    taskId?: string;
    context?: string;
  }) => void;
  createWorktree: (input: {
    projectId: string;
    name: string;
    taskId?: string;
    sessionId?: string;
  }) => void;
  removeWorktree: (input: {
    worktreeId: string;
    deleteBranch?: boolean;
    force?: boolean;
  }) => void;
  /**
   * Start a code-delivery Workflow Run for a Task. Progress and the outcome
   * arrive in `state.workflowRunStarts[requestId]`.
   */
  startWorkflowRun: (input: {
    taskId: string;
    config: CodeDeliveryWorkflowConfig;
    baseBranch?: string;
    limits?: WorkflowRunLimits;
    requestId: string;
  }) => void;
  pauseWorkflowRun: (runId: string, reason?: string) => void;
  resumeWorkflowRun: (runId: string) => void;
  cancelWorkflowRun: (runId: string) => void;
  deleteWorkflowRun: (
    runId: string,
    options: { deleteWorktree: boolean; archiveSessions: boolean },
  ) => void;
  retryWorkflowRun: (runId: string) => void;
  answerWorkflowCeiling: (
    runId: string,
    choice: "raise" | "deliver" | "re-evaluate" | "cancel",
    raise?: WorkflowCeilingRaise,
  ) => void;
  answerWorkflowCommitCheck: (
    runId: string,
    choice: WorkflowCommitCheckChoice,
  ) => void;
  rebaseAndReviewWorkflowRun: (runId: string) => void;
  /**
   * The run's two delivery controls. Both write the pull-request card the run
   * names, and that card's `delivery` projection — outcome and failure — comes
   * back on the authoritative run list, so neither is guessed at here.
   *
   * What IS local is the click itself: the card's write, its asynchronous
   * broadcast and a whole run-list rebuild stand between the press and the
   * server's `busyAction`, and a button that does nothing until all of that
   * lands is a button the user presses again. The overlay says only that this
   * browser asked, it is dropped the moment the server states the action, and
   * nothing else about the run is moved with it.
   */
  mergeWorkflowRun: (
    runId: string,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch: boolean },
  ) => void;
  cleanUpWorkflowRun: (runId: string) => void;
  /** Drop one consumed `startWorkflowRun` entry from the map. */
  clearWorkflowRunStart: (requestId: string) => void;
}

export function useAssistant({
  isolated = false,
}: {
  /** A second, self-contained session view; it must not read/write the app shell cache. */
  isolated?: boolean;
} = {}): {
  state: UIState;
  actions: AssistantActions;
  socket: AssistantSocket;
} {
  const [state, dispatch] = useReducer(
    reduceAssistantState,
    isolated,
    (isIsolated) => (isIsolated ? emptyInitial : createInitialState()),
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  // Dev HUD: when the viewed transcript commits, and when that commit paints.
  // Only the first commit after a load's snapshot is recorded (`perfStats`).
  const viewedSessionId = state.session?.sessionId;
  const viewedTimeline = state.timeline;
  useEffect(() => {
    if (!viewedSessionId || !perfStatsEnabled()) return;
    recordSessionLoadMark("committed", viewedSessionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(
        () => recordSessionLoadMark("painted", viewedSessionId),
        0,
      );
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [viewedSessionId, viewedTimeline]);
  /**
   * Optimistic mutations still waiting for their own outcome, keyed by the
   * `requestId` the command carried. Correlation is explicit because these
   * domains also receive UNSOLICITED authoritative broadcasts (an agent editing
   * a Task, another tab saving a project): resolving against "the next list
   * that arrives" consumed the wrong snapshot and left a genuine failure with
   * nothing to restore.
   */
  const mutationLifecycleRef = useRef(
    createMutationLifecycle<
      MutationContext,
      Extract<
        ServerMessage,
        { type: "workflowRunList" | "pullRequestCardUpdate" }
      >
    >(),
  );
  /** Latest in-flight keyed reads; a superseded same-id answer is ignored. */
  const taskDetailRequestsRef = useRef(new Map<string, string>());
  const projectDetailRequestsRef = useRef(new Map<string, string>());
  /**
   * The one live `getInitiative` per id, with the collapsed set it asked for
   * and the newer set wished for since (`next`); an older answer is dropped.
   */
  const initiativeDetailRequestsRef = useRef(
    new Map<
      string,
      { requestId: string; collapsed: string[]; next?: string[] }
    >(),
  );
  /** Latest list generation for every comment target. */
  const commentRequestsRef = useRef(new Map<string, string>());
  /** Immediate surface ownership, independent of asynchronous reducer updates. */
  const heldCommentTargetsRef = useRef(new Map<string, CommentTarget>());
  /** Per-target reconnect snapshots already requested by the socket episode. */
  const commentResyncRef = useRef(new Set<string>());
  const lazyBlockCacheRef = useRef(new Map<string, unknown>());
  /**
   * Durable-body reads in flight, by cache key. A read leaves this map when
   * it is answered — loaded, or failed by name (`timelineBlockFailed`) — and is
   * REISSUED by the next snapshot of its session: a reconnect or reload
   * attaches a fresh transport, and a read lost with the old one would
   * otherwise stay "pending" forever, which is what kept an expanded block a
   * preview until a full page load. Reads for another session are dropped by
   * that snapshot instead. A failed read gets one more bounded attempt after a
   * pause; a block the server says is gone is not asked for again until a
   * snapshot says otherwise.
   */
  const pendingLazyBlockLoadsRef = useRef(
    new Map<string, PendingLazyBlockLoad>(),
  );
  /**
   * Reads the server answered `unavailable`, by key, with what was asked: not
   * asked again while the transport lasts, and asked ONCE more by the next
   * snapshot of their session — the snapshot is the server's new word, and the
   * block's own effect will not re-fire when a cache-hit snapshot keeps its
   * entry and ref objects by identity.
   */
  const unavailableLazyBlocksRef = useRef(
    new Map<string, PendingLazyBlockLoad>(),
  );
  /**
   * Live bodies the transcript is rendering expanded and near the viewport,
   * ref-counted per SESSION and key (a call's input is declared in two places;
   * two sessions can reuse a stream id). The COMPLETE set for the viewed
   * session is what the server is told: on the next microtask after any
   * change, and again after every snapshot commit — a session switch or a
   * reconnect attaches a fresh transport that starts with no demand. Demand
   * under any other session id is a block that has not unmounted yet; it is
   * never sent and is dropped at the next send.
   */
  const liveBodyDemandRef = useRef(
    new Map<string, { sessionId: string; key: LiveBodyKey; count: number }>(),
  );
  const liveBodySendPendingRef = useRef(false);
  const timelineCacheRef = useRef(
    new Map<string, SessionTimelineCacheRecord>(),
  );
  const sessionLoadGenerationRef = useRef(0);
  /** IndexedDB reads already running, so a warm and a load never read twice. */
  const timelineReadsRef = useRef(
    new Map<string, Promise<SessionTimelineCacheRecord | undefined>>(),
  );
  /**
   * Read a session's cached timeline prefix into memory, joining the read that
   * is already running for it.
   *
   * Everything that needs the prefix needs it as an ANSWER, not as a callback:
   * the socket URL and `loadSession` both carry the cache descriptor, and
   * sending either without it forfeits the server's tail-only delta. What can be
   * overlapped is WHEN the read starts — a session row's tap warms it, and the
   * boot read starts with the first render — so the await below is usually
   * already settled by the time it is reached.
   */
  const readTimelineCache = useCallback(
    (sessionId: string): Promise<SessionTimelineCacheRecord | undefined> => {
      const cached = timelineCacheRef.current.get(sessionId);
      if (cached) return Promise.resolve(cached);
      const running = timelineReadsRef.current.get(sessionId);
      if (running) return running;
      const read = loadSessionTimelineCache(sessionId)
        .catch(() => undefined)
        .then((loaded: SessionTimelineCacheRecord | undefined) => {
          timelineReadsRef.current.delete(sessionId);
          if (loaded) timelineCacheRef.current.set(sessionId, loaded);
          return loaded;
        });
      timelineReadsRef.current.set(sessionId, read);
      return read;
    },
    [],
  );
  // Boot: the connection's URL carries the descriptor, so `socket.connect()`
  // cannot start before this answers. Starting it here — during the first
  // render, not in the socket effect — overlaps the read with the app's whole
  // hydrating render instead of queueing it behind one.
  const bootTimelineReadRef = useRef<Promise<unknown> | null>(null);
  if (!bootTimelineReadRef.current) {
    const bootSessionId = sessionIdFromPathname(location.pathname);
    bootTimelineReadRef.current = bootSessionId
      ? readTimelineCache(bootSessionId)
      : Promise.resolve(undefined);
  }
  // Created eagerly (not in the effect) so it's available to child effects —
  // which run before the parent's effect — e.g. the Claude terminal subscribing
  // to raw terminal messages on first mount.
  const socketRef = useRef<AssistantSocket | null>(null);
  if (!socketRef.current) {
    socketRef.current = new AssistantSocket(() => {
      const sessionId = sessionIdFromPathname(location.pathname);
      return defaultSocketUrl(
        sessionId
          ? timelineCacheRef.current.get(sessionId)?.descriptor
          : undefined,
      );
    });
  }
  const socket = socketRef.current;
  const sendLiveBodySubscriptions = useCallback(() => {
    liveBodySendPendingRef.current = false;
    const sessionId = stateRef.current.session?.sessionId;
    if (!sessionId) return;
    const demand = liveBodyDemandRef.current;
    const bodies: LiveBodyKey[] = [];
    for (const [id, held] of demand) {
      if (held.sessionId === sessionId) bodies.push(held.key);
      else demand.delete(id);
    }
    socket.send({ type: "setLiveBodySubscriptions", sessionId, bodies });
  }, [socket]);
  const scheduleLiveBodySubscriptions = useCallback(() => {
    if (liveBodySendPendingRef.current) return;
    liveBodySendPendingRef.current = true;
    queueMicrotask(sendLiveBodySubscriptions);
  }, [sendLiveBodySubscriptions]);
  // The transport behind a snapshot starts with no demand. Re-declare from the
  // commit that carries the snapshot: the blocks' own effects (children) have
  // run before this one, so the set is complete, keyed on the session the
  // snapshot switched to, and any block that stayed mounted across the switch
  // has re-registered under the new id (`AssistantMessage` keys its demand
  // effects on the session). A microtask from the socket listener ran too
  // early for both: before the reducer had applied the new session.
  const snapshotGeneration = state.snapshotGeneration;
  const viewedSessionForDemand = state.session?.sessionId;
  useEffect(() => {
    if (snapshotGeneration === 0 || !viewedSessionForDemand) return;
    const demand = liveBodyDemandRef.current;
    let wanted = false;
    for (const [id, held] of demand) {
      if (held.sessionId === viewedSessionForDemand) wanted = true;
      else demand.delete(id);
    }
    // A block that re-registered in this commit already queued a send that
    // will run after this effect with the same state; one declaration is enough.
    if (wanted && !liveBodySendPendingRef.current) sendLiveBodySubscriptions();
  }, [snapshotGeneration, viewedSessionForDemand, sendLiveBodySubscriptions]);
  /** Broadcast topics this browser currently shows; re-declared on every reconnect. */
  const topicsRef = useRef(new Set<BroadcastTopic>());
  /**
   * The replica transport for migrated topics, built once per hook instance:
   * their seqs, open item requests and due snapshots outlive every socket
   * episode and effect run.
   */
  const replicaTransportRef = useRef<ReplicaTransport<UIState> | null>(null);
  replicaTransportRef.current ??= createReplicaTransport<UIState>({
    topics: {
      background: backgroundReplica,
      tasks: taskReplica,
      projects: projectReplica,
      initiatives: initiativeReplica,
      sessions: sessionReplica,
    },
    send: (message) => socketRef.current?.send(message),
    holds: (topic) => topicsRef.current.has(topic),
    // Subscribing is the Initiative list's read, so a held list refreshes.
    onResubscribe: (topic) => {
      if (topic === "initiatives")
        dispatch({ kind: "initiativeListSubscribed" });
    },
    onBaselineLost: (topic, ids) =>
      dispatch({ kind: "replicaBaselineLost", topic, ids }),
  });
  const replicaTransport = replicaTransportRef.current;

  // The archived slice's one scheduler (`docs/session-list.md`, "Archived
  // sessions"): the reducer queues a read, and this sends it once the flight
  // is free, under a fresh `requestId` only its own answer or error matches.
  useEffect(() => {
    if (
      !state.connected ||
      !state.archivedReadQueued ||
      state.archivedReadFlight !== null
    )
      return;
    const requestId = createClientId();
    dispatch({ kind: "archivedReadSent", requestId });
    socketRef.current?.send({ type: "loadArchivedSessions", requestId });
  }, [state.connected, state.archivedReadQueued, state.archivedReadFlight]);
  // A lost answer releases its flight; a late one is then ignored.
  useEffect(() => {
    const flight = state.archivedReadFlight;
    if (flight === null) return;
    const timer = setTimeout(
      () => dispatch({ kind: "archivedReadReleased", requestId: flight }),
      ARCHIVED_READ_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [state.archivedReadFlight]);
  const transportHasConnectedRef = useRef(false);
  /** Canonical one-off list reads already requested in this socket episode. */
  const episodeListReadsRef = useRef({
    tasks: false,
    projects: false,
    worktrees: false,
  });

  const shellCacheWriterRef = useRef<IdleWriter<UIState> | null>(null);
  if (!shellCacheWriterRef.current) {
    shellCacheWriterRef.current = createIdleWriter(saveAppShellCache, {
      delayMs: SHELL_CACHE_DELAY_MS,
      maxDelayMs: SHELL_CACHE_MAX_DELAY_MS,
      idleTimeoutMs: SHELL_CACHE_IDLE_TIMEOUT_MS,
    });
  }
  const shellCacheWriter = shellCacheWriterRef.current;

  // What the Projects rows would DRAW from the statuses, not what any of them
  // says: the deciding slice for a record the watcher rewrites several times a
  // second, and the one that has to move for a remembered row silhouette to be
  // rewritten at all (`lib/worktreeRowStatuses.ts`).
  const worktreeSilhouettes = worktreeSilhouetteKey(state.worktreeStatuses);

  useEffect(() => {
    if (isolated || state.hydrationSource !== "live") return;
    if (mutationLifecycleRef.current.pendingTopics().size > 0) return;
    // Scheduled through the ref on purpose: the whole `state` is what gets
    // cached, but the slices listed below are what should DECIDE to cache it.
    // Depending on `state` itself would schedule a write on every reducer
    // action, streamed token included.
    shellCacheWriter.schedule(stateRef.current);
  }, [
    shellCacheWriter,
    isolated,
    state.hydrationSource,
    state.models,
    state.agents,
    state.sessions,
    state.archivedSessionCount,
    state.archivedSessionsLoaded,
    state.settings,
    state.slashCommands,
    state.taskList,
    state.stateEventRevisions,
    state.projectList,
    state.worktrees,
    worktreeSilhouettes,
    state.credentialProfileProjection,
  ]);

  useEffect(() => {
    // A deferred cache write must still survive the tab going away — `pagehide`
    // and the hidden transition are the last points a phone reliably runs code.
    const flush = () => shellCacheWriter.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [shellCacheWriter]);

  useEffect(() => {
    const mutationLifecycle = mutationLifecycleRef.current;
    let disposed = false;
    let socketConnected = false;
    let frame: number | null = null;
    let pendingFrameMessages: ServerMessage[] = [];

    const flushFrameMessages = () => {
      frame = null;
      if (disposed || pendingFrameMessages.length === 0) return;
      const messages = compactFrameMessages(pendingFrameMessages);
      pendingFrameMessages = [];
      for (const msg of messages) dispatch({ kind: "server", msg });
    };

    const flushFrameMessagesNow = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      flushFrameMessages();
    };

    /** Retries scheduled by failed durable-body reads; torn down with the socket. */
    const lazyBlockRetryTimers = new Set<ReturnType<typeof setTimeout>>();
    const offMsg = socket.onMessage((incoming) => {
      // A production tab can survive a deployment and reconnect with its OLD JS
      // bundle. If that bundle speaks an earlier protocol (for example, before
      // topic subscriptions), mutations appear to succeed but their broadcasts
      // are never delivered. The server identifies the currently served web
      // build; remember it and reload exactly once when it changes.
      const incomingWebBuildId =
        incoming.type === "webBuild"
          ? incoming.webBuildId
          : incoming.type === "ready"
            ? incoming.webBuildId
            : undefined;
      if (import.meta.env.PROD && incomingWebBuildId) {
        try {
          if (recordWebBuild(localStore, incomingWebBuildId)) {
            window.location.reload();
            return;
          }
        } catch {
          // Storage can be unavailable in hardened/private browser modes. The
          // socket remains usable; ordinary authoritative snapshots still apply.
        }
      }
      // The build preflight is control-only; `ready` carries app state.
      if (incoming.type === "webBuild") return;
      if (incoming.type === "commentsSnapshot") {
        const key = commentTargetKey(incoming.target);
        if (incoming.requestId) {
          if (commentRequestsRef.current.get(key) !== incoming.requestId)
            return;
          commentRequestsRef.current.delete(key);
        }
        commentResyncRef.current.delete(key);
      }
      // Advisory, and never state — there is nothing to reduce, so it is
      // answered here rather than in the reducer. Exactly ONE runtime acts on
      // it, and `shouldRaiseAppNotification` is where that is decided: a browser
      // already has its own Web Push subscription for the same alert, and an iOS
      // shell has an APNs registration once it takes. Whether the alert is worth
      // showing while the app is in front is the OS's call, and duplicates across
      // several open windows are collapsed by the shell.
      if (incoming.type === "appNotification") {
        if (shouldRaiseAppNotification())
          void nativeNotify(
            incoming.title,
            incoming.body,
            // Where a click lands. The same path Web Push navigates to, so the
            // browser and the shell answer a click identically.
            incoming.navigatePath,
          );
        return;
      }
      let msg = incoming;
      if (msg.type === "error" && msg.requestId) {
        for (const [key, requestId] of commentRequestsRef.current) {
          if (requestId !== msg.requestId) continue;
          commentRequestsRef.current.delete(key);
          commentResyncRef.current.delete(key);
          break;
        }
      }
      if (msg.type === "commentEvents") {
        const key = commentTargetKey(msg.target);
        const heldTarget = heldCommentTargetsRef.current.get(key);
        // An event already queued when a surface closes must not recreate the
        // descriptor that teardown just removed.
        if (!heldTarget) return;
        msg = { ...msg, target: heldTarget };
      }
      if (msg.type === "snapshot") {
        const expanded = expandTimelineSnapshot(
          msg.snapshot,
          timelineCacheRef.current.get(msg.snapshot.sessionId),
        );
        if (!expanded) {
          // The server validated the anchor it received, but the matching local
          // prefix is unavailable/corrupt — or the splice would render NOTHING
          // (Task 450). Reattach with an explicit empty cache descriptor; offset
          // zero is an authoritative full snapshot.
          timelineCacheRef.current.delete(msg.snapshot.sessionId);
          void deleteSessionTimelineCache(msg.snapshot.sessionId);
          socket.send({
            type: "loadSession",
            id: msg.snapshot.sessionId,
            timelineCache: describeTimelineCache([]),
          });
          return;
        }
        const record = cacheRecordForSnapshot(expanded);
        if (record) {
          timelineCacheRef.current.set(record.sessionId, record);
          void saveSessionTimelineCache(record);
        }
        msg = { ...msg, snapshot: expanded };
        // This snapshot comes from a fresh transport: whatever this session
        // was still waiting to read is asked for again, as a fresh attempt;
        // reads for any other session belong to a view that is gone.
        for (const [key, pending] of pendingLazyBlockLoadsRef.current) {
          if (pending.sessionId !== msg.snapshot.sessionId) {
            pendingLazyBlockLoadsRef.current.delete(key);
            continue;
          }
          pendingLazyBlockLoadsRef.current.set(key, {
            ...pending,
            attempts: 1,
          });
          socket.send({
            type: "loadTimelineBlock",
            entryId: pending.entryId,
            blockIndex: pending.blockIndex,
            kind: pending.kind,
          });
        }
        for (const [key, read] of unavailableLazyBlocksRef.current) {
          if (read.sessionId !== msg.snapshot.sessionId) continue;
          unavailableLazyBlocksRef.current.delete(key);
          if (
            lazyBlockCacheRef.current.has(key) ||
            pendingLazyBlockLoadsRef.current.has(key)
          )
            continue;
          pendingLazyBlockLoadsRef.current.set(key, { ...read, attempts: 1 });
          socket.send({
            type: "loadTimelineBlock",
            entryId: read.entryId,
            blockIndex: read.blockIndex,
            kind: read.kind,
          });
        }
      }
      if (shouldFrameBatchServerMessage(msg)) {
        pendingFrameMessages.push(msg);
        frame ??= window.requestAnimationFrame(flushFrameMessages);
        return;
      }
      // Preserve protocol order: a terminal frame must see all queued deltas first,
      // even if it lands before the next paint.
      flushFrameMessagesNow();
      if (msg.type === "taskList" && isCacheableTaskList(msg.list))
        replicaTransport.snapshotReceived("tasks", msg.seq);
      if (msg.type === "projectList" && isCanonicalProjectList(msg.list))
        replicaTransport.snapshotReceived("projects", msg.seq);
      if (msg.type === "backgroundWorkList")
        replicaTransport.snapshotReceived("background", msg.seq);
      if (msg.type === "initiativeList")
        replicaTransport.snapshotReceived("initiatives", msg.seq);
      if (msg.type === "sessionList")
        replicaTransport.snapshotReceived("sessions", msg.seq);
      if (msg.type === "stateDigest") {
        // A digest the transport fell back from never reaches the reducer.
        const answer = replicaTransport.digestReceived(msg, stateRef.current);
        for (const out of answer.send) socket.send(out);
        if (!answer.apply) return;
      }
      if (msg.type === "stateItems") {
        const purpose = replicaTransport.itemsReceived(msg);
        if (purpose) dispatch({ kind: "replicaItems", purpose, msg });
        return;
      }
      // A replica request's failure is consumed by its own fallback, never
      // shown as the app's error.
      if (msg.type === "error" && replicaTransport.errorReceived(msg)) return;
      if (msg.type === "taskDetail" && msg.requestId) {
        if (taskDetailRequestsRef.current.get(msg.id) !== msg.requestId) return;
        taskDetailRequestsRef.current.delete(msg.id);
        dispatch({
          kind: "taskDetailResult",
          id: msg.id,
          item: msg.item,
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
        return;
      }
      if (msg.type === "initiativeDetail") {
        const asked = initiativeDetailRequestsRef.current.get(msg.id);
        if (asked?.requestId !== msg.requestId) return;
        if (asked.next) {
          // The page asked for another drawing while this one was read. This
          // answer would put the older drawing back over the user's newer
          // choice, so it is dropped, and the newest choice is read instead;
          // the held data stays on screen, refreshing, until that answers.
          const requestId = createClientId();
          initiativeDetailRequestsRef.current.set(msg.id, {
            requestId,
            collapsed: asked.next,
          });
          socket.send(initiativeReadMessage(msg.id, requestId, asked.next));
          return;
        }
        initiativeDetailRequestsRef.current.delete(msg.id);
        dispatch({
          kind: "initiativeDetailResult",
          id: msg.id,
          read: msg.item
            ? {
                item: msg.item,
                ...(msg.layout ? { layout: msg.layout } : {}),
                ...(msg.layoutError !== undefined
                  ? { layoutError: msg.layoutError }
                  : {}),
                ...(msg.layoutTooLarge
                  ? { layoutTooLarge: msg.layoutTooLarge }
                  : {}),
                requestedCollapsed: asked.collapsed,
              }
            : null,
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
        return;
      }
      if (msg.type === "projectDetail") {
        if (projectDetailRequestsRef.current.get(msg.id) !== msg.requestId)
          return;
        projectDetailRequestsRef.current.delete(msg.id);
        dispatch({
          kind: "projectDetailResult",
          id: msg.id,
          item: msg.item,
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
          ...(msg.error ? { error: msg.error } : {}),
        });
        return;
      }
      if (msg.type === "accountHealthChanged") {
        window.dispatchEvent(new Event("credentialProfilesChanged"));
        window.dispatchEvent(new Event("accountHealthChanged"));
        return;
      }
      if (msg.type === "projectSaved") {
        dispatch({
          kind: "projectSaved",
          item: msg.item,
          revision: msg.revision,
        });
        return;
      }
      // A delivery click is answered by the RUN LIST, so its overlay is retired
      // here rather than on the generic settle. Two ways out, and both are the
      // list's: the server states an action on that card — durable, seen by
      // every viewer, whether or not it is this click's — and the local claim
      // becomes redundant; or the settle has already been seen and this list is
      // the outcome. Any list will do for the second: each one is built from
      // the stores as they stand when it is sent, so its CAUSE does not matter,
      // and the settle asks for one rather than trusting a broadcast to arrive.
      if (msg.type === "workflowRunList")
        mutationLifecycleRef.current.observe(msg);
      if (msg.type === "pullRequestCardUpdate")
        mutationLifecycleRef.current.observeFirst(
          msg,
          (context) => context.pullRequestCardId === msg.card.id,
        );
      if (msg.type === "mutationSettled") {
        mutationLifecycleRef.current.settle(msg.requestId);
        // A skill write is answered HERE, not by its settings echo: the settle
        // is the only message that names the request, and by now that echo has
        // been applied (the server sends it first). A settle for anything else,
        // or for a write a later one has already superseded, changes nothing.
        dispatch({ kind: "skillTogglesAnswered", requestId: msg.requestId });
        return;
      }
      // The once-per-episode worktree read did not land, so the next surface
      // that needs the list may ask again. Recognised by the failure's TARGET,
      // like every other routing decision about a message.
      if (
        msg.type === "error" &&
        msg.target?.type === "worktree" &&
        !msg.target.id
      )
        episodeListReadsRef.current.worktrees = false;
      // Same for the Task list, so the Backlog's retry on that condition is a
      // real read rather than a no-op behind the once-per-episode gate. Unstamped,
      // it is also how a resubscribe's snapshot read fails: the awaited answer
      // will not come. It still reaches the reducer as `taskListError`.
      if (
        msg.type === "error" &&
        msg.target?.type === "task" &&
        !msg.target.id
      ) {
        episodeListReadsRef.current.tasks = false;
        if (!msg.requestId) replicaTransport.snapshotFailed("tasks");
      }
      // The session collection's failures: unstamped, the `sessions` snapshot
      // read (the awaited answer will not come); stamped with the archived
      // flight's id, that read, whose flight it releases. A stale flight's
      // late error releases nothing.
      if (
        msg.type === "error" &&
        msg.target?.type === "session" &&
        !msg.target.id
      ) {
        if (!msg.requestId) replicaTransport.snapshotFailed("sessions");
        else
          dispatch({ kind: "archivedReadReleased", requestId: msg.requestId });
      }

      // And the project list: the Projects pane's note offers the same Retry,
      // and every collection whose note does has to reopen its gate — otherwise
      // the button calls a loader that returns early and the note is permanent
      // for the socket episode.
      if (
        msg.type === "error" &&
        msg.target?.type === "project" &&
        !msg.target.id
      )
        episodeListReadsRef.current.projects = false;
      // Whether a REFUSED CONTROL already renders this failure. Answered from
      // the request id the failure carries, at the arrival — the one place that
      // knows which write it was — and handed to both decisions below: the
      // object does not keep a second copy of it, and the announcement is
      // suppressed only where the object's surface is on screen to draw it.
      let controlOwned = false;
      if (msg.type === "error" && msg.requestId) {
        // The failure's announcement is raised at the arrival below; this only
        // re-reads the domain the optimistic change touched.
        const mutation = mutationLifecycleRef.current.finish(msg.requestId, {
          type: "error",
          message: msg.message,
        });
        if (mutation?.pullRequestCardId) {
          // The card is this failure's R5 home. If it is still on screen, do
          // not also turn the same refusal into the chat's global error. The
          // store holds cards the loaded window has not placed, so a row is
          // what counts (`loadedHistoryStart`).
          if (
            clientPullRequestCard(
              stateRef.current.messages,
              mutation.pullRequestCardId,
            )
          )
            return;
        }
        // A delivery refusal raised BEFORE the pull-request card was touched:
        // the server states it on the Task, because nothing else will, and the
        // announcement below is left to do that. Here the click only stops
        // owning the control — writing the same sentence onto the delivery
        // block as well would be the duplicate `docs/messaging.md` forbids.
        // A compaction-window refusal belongs to the inspector control that
        // sent it, never to the viewed chat's generic error.
        if (mutation?.compactionSessionId !== undefined) {
          announceArrival(msg, stateRef.current);
          return;
        }
        const key =
          mutation?.control?.domain === "tasks"
            ? mutation.control.key
            : undefined;
        if (key) {
          // A project assignment is the one tracked Task write with no control
          // to report on: its receipt IS a toast, and the failure REPLACES that
          // receipt under the same key rather than being announced beside it.
          if (key === taskMutationKey(null, "assignProjects")) {
            showToast(msg.message, {
              key: PROJECT_ASSIGNMENT_TOAST_KEY,
              tone: "error",
              durationMs: TOAST_DWELL_MS,
            });
            return;
          }
          // Every other tracked Task write renders its failure on the control
          // that was refused — but only while that control is on screen, so the
          // arrival still has to be judged against the claims. It used to return
          // here unconditionally, which silenced a write the user had already
          // navigated away from: neither in place nor announced.
          //
          // No `controlOwned` to set: the return below means this message never
          // reaches the reducer, so the object store never sees it either.
          announceArrival(msg, stateRef.current);
          return;
        }
        if (mutation?.control?.domain === "projects" && mutation.control.key)
          controlOwned = true;
      }
      // A failed Initiative LIST read is a condition on that list, kept
      // for its panes to render with their Retry — and nothing else. It
      // must not reach the reducer's generic `error`, which is the VIEWED
      // chat's outcome: that would end a turn still streaming there. Its
      // announcement is owned by the condition (`CONDITION_COLLECTIONS`).
      if (
        msg.type === "error" &&
        msg.target?.type === "initiative" &&
        !msg.target.id
      ) {
        dispatch({ kind: "initiativeListFailed", message: msg.message });
        return;
      }
      if (msg.type === "taskSaved") {
        // The temp id lives in the pending queue, never on the wire: the server
        // has no idea a browser-local row exists, so only this correlation can
        // retire it (see `applyTaskSaved`).
        const tempId = msg.requestId
          ? mutationLifecycleRef.current.get(msg.requestId)?.tempId
          : undefined;
        dispatch({
          kind: "taskSaved",
          item: msg.item,
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
          ...(tempId !== undefined ? { tempId } : {}),
        });
        return;
      }
      // The gap tripwire is transport bookkeeping, and it lives in a ref rather
      // than in reducer state on purpose: two batches can arrive before React
      // re-renders, and comparing both against the same rendered `seq` would
      // report a gap that never happened.
      if (msg.type === "stateEvents" && replicaTransport.owns(msg.topic)) {
        for (const out of replicaTransport.eventsReceived(msg))
          socket.send(out);
      }
      if (msg.type === "timelineBlockLoaded") {
        const key = lazyBlockCacheKey(
          msg.sessionId,
          msg.entryId,
          msg.blockIndex,
          msg.kind,
        );
        pendingLazyBlockLoadsRef.current.delete(key);
        unavailableLazyBlocksRef.current.delete(key);
        lazyBlockCacheRef.current.set(key, msg.content);
      }
      if (msg.type === "timelineBlockFailed") {
        const key = lazyBlockCacheKey(
          msg.sessionId,
          msg.entryId,
          msg.blockIndex,
          msg.kind,
        );
        const pending = pendingLazyBlockLoadsRef.current.get(key);
        pendingLazyBlockLoadsRef.current.delete(key);
        if (msg.reason === "unavailable") {
          unavailableLazyBlocksRef.current.set(
            key,
            pending ?? {
              sessionId: msg.sessionId,
              entryId: msg.entryId,
              blockIndex: msg.blockIndex,
              kind: msg.kind,
              attempts: 1,
            },
          );
        } else if (pending && pending.attempts < LAZY_BLOCK_MAX_ATTEMPTS) {
          // One more try, later: the block is still what the reader is looking
          // at, and a transient read failure is not an answer.
          const retry = { ...pending, attempts: pending.attempts + 1 };
          const timer = setTimeout(() => {
            lazyBlockRetryTimers.delete(timer);
            if (stateRef.current.session?.sessionId !== retry.sessionId) return;
            if (lazyBlockCacheRef.current.has(key)) return;
            if (pendingLazyBlockLoadsRef.current.has(key)) return;
            if (unavailableLazyBlocksRef.current.has(key)) return;
            pendingLazyBlockLoadsRef.current.set(key, retry);
            socket.send({
              type: "loadTimelineBlock",
              entryId: retry.entryId,
              blockIndex: retry.blockIndex,
              kind: retry.kind,
            });
          }, LAZY_BLOCK_RETRY_MS);
          lazyBlockRetryTimers.add(timer);
        }
        return;
      }
      // Before the dispatch, so what is said is decided by the message and the
      // state it ARRIVED into — never by the state it leaves behind.
      if (msg.type === "accountLoginAlerts")
        window.dispatchEvent(new Event("accountHealthChanged"));
      announceArrival(msg, stateRef.current);
      dispatch({
        kind: "server",
        msg,
        ...(controlOwned ? { controlOwned } : {}),
      });
    });
    const offStatus = socket.onStatus((connected) => {
      const lostConnection = socketConnected && !connected;
      socketConnected = connected;
      flushFrameMessagesNow();
      // Subscriptions live on the connection, so a RECONNECT re-declares them
      // and receives a fresh snapshot. The first connection does not: setTopics
      // has already queued its declaration (or sends it after a very fast open),
      // and re-declaring here would put the same request on the wire twice.
      if (connected) {
        const topics = [...topicsRef.current];
        if (topics.includes("tasks")) episodeListReadsRef.current.tasks = true;
        if (topics.includes("projects"))
          episodeListReadsRef.current.projects = true;
        if (topics.includes("worktrees"))
          episodeListReadsRef.current.worktrees = true;
        if (transportHasConnectedRef.current) {
          if (topics.length > 0) {
            if (
              topics.includes("tasks") &&
              mutationLifecycleRef.current.recoveryTopics().has("tasks")
            )
              replicaTransport.snapshotRequested("tasks");
            // Sessions never asks for a digest: its subscribe is always
            // answered by a snapshot, which a recovery's resync joins.
            if (topics.includes("sessions"))
              replicaTransport.snapshotRequested("sessions");
            socket.send(
              replicaTransport.subscribeRequest(
                topics,
                stateRef.current,
                mutationLifecycleRef.current.pendingTopics(),
              ),
            );
          }
          mutationLifecycleRef.current.reconnect();
          // The re-declared skills subscription re-scans on the server, and the
          // rows already on screen are the ones that scan may correct.
          for (const library of LIBRARY_TOPICS)
            if (topics.includes(library))
              dispatch({ kind: "libraryLoad", library });
          // Comment subscriptions are per connection, just like topic
          // subscriptions. Re-read every cached target so a restarted server
          // rebuilds ownership and this connection resumes addressed pushes.
          for (const [key, target] of Object.entries(
            stateRef.current.commentTargets,
          ).slice(-MAX_OPEN_COMMENT_TARGETS)) {
            const requestId = createClientId();
            heldCommentTargetsRef.current.set(key, target);
            commentResyncRef.current.add(key);
            commentRequestsRef.current.set(key, requestId);
            socket.send({ type: "listComments", target, requestId });
          }
        }
        transportHasConnectedRef.current = true;
      } else {
        replicaTransport.dropRequests();
        // Failed connection attempts also emit false. Writes still queued —
        // theirs, or held by a liveness probe that replaced a dead socket —
        // were never sent, so they keep their claims and deadlines and go out
        // on the next socket; only the writes a lost socket carried are
        // unknown.
        if (lostConnection)
          mutationLifecycleRef.current.disconnect(socket.unsentRequestIds());
        commentResyncRef.current.clear();
        commentRequestsRef.current.clear();
        for (const id of taskDetailRequestsRef.current.keys())
          dispatch({
            kind: "taskDetailResult",
            id,
            item: null,
            error: "Connection lost while loading this Task.",
          });
        taskDetailRequestsRef.current.clear();
        for (const id of projectDetailRequestsRef.current.keys())
          dispatch({
            kind: "projectDetailResult",
            id,
            item: null,
            error: "Connection lost while loading this Project.",
          });
        projectDetailRequestsRef.current.clear();
        // A map read lost with its socket is answered now, so its page says so
        // and offers a retry instead of waiting forever; the snapshot on the
        // next subscribe marks held reads stale by revision.
        for (const id of initiativeDetailRequestsRef.current.keys())
          dispatch({
            kind: "initiativeDetailResult",
            id,
            read: null,
            error: "Connection lost while loading this Initiative.",
          });
        initiativeDetailRequestsRef.current.clear();
        episodeListReadsRef.current = {
          tasks: false,
          projects: false,
          worktrees: false,
        };
      }
      dispatch({ kind: "status", connected });
    });
    // The read was started with the first render (see `readTimelineCache`); this
    // only joins it, because the descriptor has to be on the connection's URL.
    void bootTimelineReadRef.current!.then(() => {
      if (!disposed) socket.connect();
    });
    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      pendingFrameMessages = [];
      replicaTransport.dropRequests();
      mutationLifecycle.cleanup();
      for (const timer of lazyBlockRetryTimers) clearTimeout(timer);
      lazyBlockRetryTimers.clear();
      offMsg();
      offStatus();
      socket.dispose();
    };
  }, [replicaTransport, socket]);

  const actions = useMemo<AssistantActions>(() => {
    const send = (msg: ClientMessage) => socketRef.current?.send(msg);
    /** Mint the id this mutation will be answered with, and hold its recovery. */
    const trackMutation = (
      mutation: PendingMutation,
      recover: (mutation: PendingMutation) => void,
      timeoutMs = MUTATION_SETTLE_TIMEOUT_MS,
    ): string => {
      return mutationLifecycleRef.current.start({
        context: mutation,
        recover: (entry) => {
          if (entry.topic) recover(entry);
        },
        timeoutMs,
        terminal: () => {},
      });
    };
    /** Ask where a jump target lives; the answer arrives as a `timelineAnchor`. */
    const requestReveal = (target: TimelineAnchorTarget) => {
      const requestId = createClientId();
      dispatch({ kind: "revealRequested", requestId, target });
      send({ type: "resolveTimelineAnchor", requestId, target });
    };
    /**
     * The authoritative re-read after a failed optimistic session mutation:
     * the transport's silent `sessions` resubscribe (forgetting the ids'
     * revisions), and an archived re-read while the slice is shown.
     */
    const resyncSessions = (mutation?: PendingMutation) => {
      const ids =
        mutation?.topic === "sessions" ? [...new Set(mutation.objectIds)] : [];
      for (const message of replicaTransport.resync("sessions", ids))
        send(message);
      if (stateRef.current.archivedSessionsLoaded)
        dispatch({ kind: "archivedReadRequested" });
    };
    // There is no list command for runs: a resubscribe answers with the run
    // list as the stores hold it (the same resync a delivery settle uses). A
    // surface not holding the topic holds no run list to correct.
    const refetchWorkflowRuns = () => {
      if (!topicsRef.current.has("workflow")) return;
      send({ type: "unsubscribe", topics: ["workflow"] });
      send(
        replicaTransport.subscribeRequest(
          ["workflow"],
          stateRef.current,
          mutationLifecycleRef.current.pendingTopics(),
        ),
      );
    };
    // A failed Task mutation re-reads through the transport's resync: one
    // silent snapshot resubscribe while held, joined by later failures.
    const resyncTasks = (mutation: PendingMutation) => {
      const ids = [...new Set(mutation.objectIds)];
      for (const message of replicaTransport.resync("tasks", ids))
        send(message);
    };
    const recoverTasks = (mutation: PendingMutation) => {
      const ids = [...new Set(mutation.objectIds)];
      if (ids.length > 0) send(replicaTransport.recoveryRequest("tasks", ids));
    };
    const recoverProjects = (mutation: PendingMutation) => {
      const ids = [...new Set(mutation.objectIds)];
      if (ids.length > 0)
        send(replicaTransport.recoveryRequest("projects", ids));
      const openId = stateRef.current.openProjectProjectionId;
      if (!openId || !ids.includes(openId)) return;
      const requestId = createClientId();
      projectDetailRequestsRef.current.set(openId, requestId);
      dispatch({ kind: "projectDetailLoad", id: openId });
      send({ type: "getProject", id: openId, requestId });
    };
    const trackDomainMutation = (
      mutation: PendingMutation,
      domain: "tasks" | "projects",
      key?: string,
      timeoutMs = MUTATION_SETTLE_TIMEOUT_MS,
    ) => {
      const recover = domain === "tasks" ? resyncTasks : recoverProjects;
      const context: MutationContext = {
        ...mutation,
        objectIds: [...mutation.objectIds],
        control: { domain, ...(key ? { key } : {}) },
      };
      return mutationLifecycleRef.current.start({
        context,
        timeoutMs,
        recover: (entry) => {
          if (entry.topic) recover(entry);
        },
        disconnected: () =>
          replicaTransport.invalidate(domain, context.objectIds),
        terminal: (outcome) => {
          if (!key) return;
          if (outcome.type === "unknown") {
            dispatch({
              kind:
                domain === "tasks"
                  ? "taskMutationRelease"
                  : "projectMutationRelease",
              key,
            });
            return;
          }
          const error =
            outcome.type === "error"
              ? outcome.message
              : outcome.type === "timeout"
                ? `The server did not answer this ${domain === "tasks" ? "Task" : "Project"} change. Try again.`
                : undefined;
          dispatch({
            kind:
              domain === "tasks"
                ? "taskMutationResult"
                : "projectMutationResult",
            key,
            ...(error ? { error } : {}),
          });
          const taskId = mutation.objectIds[0];
          if (
            outcome.type === "timeout" &&
            domain === "tasks" &&
            taskId &&
            key.startsWith(`${taskId}:`)
          )
            announceArrival(
              {
                type: "error",
                message: error!,
                target: { type: "task", id: taskId },
              },
              stateRef.current,
            );
        },
      });
    };
    const startProjectMutation = (
      id: string | null,
      operation: ProjectMutationOperation,
      objectIds: string[],
      timeoutMs = MUTATION_SETTLE_TIMEOUT_MS,
    ): string | undefined => {
      const key = projectMutationKey(id, operation);
      const current = stateRef.current.projectMutations[key];
      if (current?.status === "loading" || current?.status === "refreshing")
        return undefined;
      const requestId = trackDomainMutation(
        { topic: "projects", objectIds },
        "projects",
        key,
        timeoutMs,
      );
      dispatch({ kind: "projectMutationStart", key });
      // This project's own next write retires the failure it is carrying — the
      // retry, not someone else's traffic about it. A registry-wide write (a
      // reorder) names no project and so retires none.
      if (id) dispatch({ kind: "clearObjectFailure", type: "project", id });
      return requestId;
    };
    const refetchWorktrees = () => send({ type: "listWorktrees" });
    /**
     * Take ownership of one of a run's two delivery controls for this click, or
     * refuse it because an action is already running on that card.
     *
     * The guard is the same one the live `/pr` card applies, and it is the same
     * guard the SERVER applies to the pull-request card underneath: a second
     * click while one is in flight is refused there, so offering it here would
     * only produce a refusal the user cannot act on.
     *
     * Nothing is recovered when this fails. The optimism is a spinner and
     * nothing else — no domain row is moved, no list is patched — and the run
     * list the server re-broadcasts with every outcome, refusal included, is
     * already the authoritative answer for the control.
     */
    const startWorkflowDelivery = (
      runId: string,
      action: WorkflowDeliveryAction,
    ): string | undefined => {
      const delivery =
        stateRef.current.workflowCards[runId]?.pullRequest?.delivery;
      if (!delivery || delivery.busyAction || delivery.pendingAction)
        return undefined;
      const requestId = mutationLifecycleRef.current.start({
        context: {
          topic: "workflow",
          objectIds: [runId],
        },
        timeoutMs: LONG_MUTATION_SETTLE_TIMEOUT_MS,
        // Reconnect already subscribes to authority. Release belongs ONLY to
        // terminal, never recovery: a newer offline click may own this run.
        recover: () => {},
        disconnected: () => {},
        firstSettled: refetchWorkflowRuns,
        done: (settled, list) =>
          list
            ? list.type === "workflowRunList" &&
              (Boolean(list.cards[runId]?.pullRequest?.delivery?.busyAction) ||
                settled)
            : settled && !topicsRef.current.has("workflow"),
        terminal: (outcome, _context, _requestId, list) => {
          // Busy authority itself discards the overlay in the list reducer.
          if (
            list?.type === "workflowRunList" &&
            list.cards[runId]?.pullRequest?.delivery?.busyAction
          )
            return;
          dispatch({
            kind: "workflowDeliveryResult",
            runId,
            ...(outcome.type === "timeout"
              ? {
                  error:
                    "The server did not answer this delivery action. Try again.",
                }
              : {}),
          });
        },
      });
      dispatch({ kind: "optimisticWorkflowDelivery", runId, action });
      return requestId;
    };
    const refetchSettings = () => send({ type: "requestSettings" });
    return {
      prompt: (text, attachments, attachTaskId, projectId, fileContext) => {
        const clientRequestId = createClientId();
        // Every outgoing send retires the target session's last failure, echo
        // or no echo: an attachments-only prompt has no text to echo.
        const target = stateRef.current.session?.sessionId;
        if (target)
          dispatch({ kind: "clearSessionFailure", sessionId: target });
        optimisticUserEcho(
          dispatch,
          clientRequestId,
          text,
          target,
          false,
          attachments,
        );
        send({
          type: "prompt",
          text,
          ...(attachments !== undefined ? { attachments } : {}),
          ...(attachTaskId !== undefined ? { attachTaskId } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(fileContext !== undefined ? { fileContext } : {}),
          clientRequestId,
        });
      },
      runSlashCommand: (name, rawArgs) =>
        send({ type: "runSlashCommand", name, rawArgs }),
      promptSkill: (text, skill) => {
        const clientRequestId = createClientId();
        const target = stateRef.current.session?.sessionId;
        if (target)
          dispatch({ kind: "clearSessionFailure", sessionId: target });
        optimisticUserEcho(dispatch, clientRequestId, text, target, false);
        send({ type: "prompt", text, skill, clientRequestId });
      },
      promptQueue: (command) => send(command),
      acceptCommitDryRun: (entryId) =>
        send({ type: "acceptCommitDryRun", entryId }),
      respondToQuestion: (response) =>
        send({ type: "respondToQuestion", response }),
      abort: () => send({ type: "abort" }),
      loadTimelineBlock: (entryId, blockIndex, kind) => {
        const sessionId = stateRef.current.session?.sessionId;
        if (!sessionId) return;
        const key = lazyBlockCacheKey(sessionId, entryId, blockIndex, kind);
        if (lazyBlockCacheRef.current.has(key)) {
          dispatch({
            kind: "server",
            msg: {
              type: "timelineBlockLoaded",
              sessionId,
              entryId,
              blockIndex,
              kind,
              content: lazyBlockCacheRef.current.get(key),
            },
          });
          return;
        }
        if (pendingLazyBlockLoadsRef.current.has(key)) return;
        if (unavailableLazyBlocksRef.current.has(key)) return;
        pendingLazyBlockLoadsRef.current.set(key, {
          sessionId,
          entryId,
          blockIndex,
          kind,
          attempts: 1,
        });
        send({ type: "loadTimelineBlock", entryId, blockIndex, kind });
      },
      setLiveBodyDemand: (sessionId, key, wanted) => {
        const demand = liveBodyDemandRef.current;
        const id = `${sessionId}|${liveBodyKeyId(key)}`;
        const held = demand.get(id);
        if (wanted) {
          if (held) held.count += 1;
          else demand.set(id, { sessionId, key, count: 1 });
          if (held) return;
        } else {
          if (!held) return;
          held.count -= 1;
          if (held.count > 0) return;
          demand.delete(id);
        }
        scheduleLiveBodySubscriptions();
      },
      loadOlderTimeline: () => {
        const current = stateRef.current;
        const sessionId = current.session?.sessionId;
        const first = current.timeline[0];
        if (
          !sessionId ||
          !first ||
          current.timelineStart <= 0 ||
          current.timelineRangePending !== null
        )
          return;
        dispatch({ kind: "timelineRangeRequested", beforeSeq: first.seq });
        send({
          type: "loadTimelineRange",
          sessionId,
          beforeSeq: first.seq,
          limit: TIMELINE_RANGE_LIMIT,
        });
      },
      revealPeerPromptMessage: (messageKey) =>
        requestReveal({ kind: "peerPrompt", messageKey }),
      revealTimelineEntry: (sessionId, entryId) => {
        // A card's row id is not a log entry, so a `#m-` address naming one
        // (a reload on a card jump) asks for the card instead.
        const approvalId = approvalIdFromMessageId(entryId);
        requestReveal(
          approvalId
            ? { kind: "approval", approvalId }
            : { kind: "entry", sessionId, entryId },
        );
      },
      revealApproval: (approvalId) =>
        requestReveal({ kind: "approval", approvalId }),
      retireMessageReveal: (token) =>
        dispatch({ kind: "revealSettled", token }),
      retireSessionDraft: (token) =>
        dispatch({ kind: "sessionDraftConsumed", token }),
      stageSessionDraft: (sessionId, text) =>
        dispatch({ kind: "sessionDraftStaged", sessionId, text }),
      setModel: (provider, id) => send({ type: "setModel", provider, id }),
      setThinkingLevel: (level) => send({ type: "setThinkingLevel", level }),
      setSessionMode: (mode) => send({ type: "setSessionMode", mode }),
      refreshModels: () => {
        // One refresh at a time: the button is busy while this is out, and a
        // second id would orphan the first request's reply.
        if (stateRef.current.modelsRefreshRequestId) return;
        const requestId = createClientId();
        dispatch({ kind: "modelsRefreshSent", requestId });
        send({ type: "refreshModels", requestId });
      },
      requestSettings: () => send({ type: "requestSettings" }),
      resolveObjectLinks: (requestId, uris) =>
        send({ type: "resolveObjectLinks", requestId, uris }),
      newSession: (agentType, model, thinkingLevel) =>
        send({
          type: "newSession",
          agentType,
          ...(model !== undefined ? { model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        }),
      harnessSend: (input) => {
        const clientRequestId = input.clientRequestId ?? createClientId();
        // A previous send's failed provisioning card belongs to that send only.
        dispatch({ kind: "clearWorktreeProvision" });
        // Named by the SEND's own target. A staged first send names a session
        // that does not exist yet, where this is simply a no-op — which is the
        // point: it must never retire whichever session happened to be viewed.
        if (input.id)
          dispatch({ kind: "clearSessionFailure", sessionId: input.id });
        optimisticUserEcho(
          dispatch,
          clientRequestId,
          input.text,
          input.id,
          true,
          input.attachments,
        );
        send({ type: "harnessSend", ...input, clientRequestId });
        return clientRequestId;
      },
      warmSessionTimeline: (id) => {
        void readTimelineCache(id);
      },
      loadSession: (id) => {
        const generation = ++sessionLoadGenerationRef.current;
        recordSessionLoadMark("request", id);
        const cached = timelineCacheRef.current.get(id);
        if (cached) {
          send({ type: "loadSession", id, timelineCache: cached.descriptor });
          return;
        }
        // A tap on the row usually warmed this read already, so the promise is
        // settled and the load leaves on the same task as the navigation.
        void readTimelineCache(id).then((loaded) => {
          if (
            generation !== sessionLoadGenerationRef.current ||
            sessionIdFromPathname(location.pathname) !== id
          )
            return;
          send({
            type: "loadSession",
            id,
            ...(loaded ? { timelineCache: loaded.descriptor } : {}),
          });
        });
      },
      openPermanentAssistant: () => {
        const current = stateRef.current;
        const sessionId =
          current.session?.agentType === "personal-assistant"
            ? current.session.sessionId
            : undefined;
        // Reopening a retained panel asks for the delta after its whole loaded
        // range, not a fresh tail that would discard older history.
        if (sessionId && current.historySessionId === sessionId) {
          const descriptor = describeTimelineCache(
            current.timeline,
            current.timelineStart,
          );
          timelineCacheRef.current.set(sessionId, {
            version: 2,
            sessionId,
            timeline: current.timeline,
            descriptor,
            savedAt: Date.now(),
          });
          send({ type: "openPermanentAssistant", timelineCache: descriptor });
        } else send({ type: "openPermanentAssistant" });
      },
      releasePermanentAssistant: (sessionId) =>
        send({ type: "releasePermanentAssistant", sessionId }),
      loadArchivedSessions: () => dispatch({ kind: "archivedReadRequested" }),
      deleteSession: (id) => {
        timelineCacheRef.current.delete(id);
        void deleteSessionTimelineCache(id);
        forgetTranscriptScrollPosition(id);
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          resyncSessions,
        );
        dispatch({ kind: "optimisticSessionDelete", sessionId: id });
        send({ type: "deleteSession", id, requestId });
      },
      archiveSession: (id, archived = true) => {
        // Archived sessions are dropped from the default list; mirror that
        // immediately. The server resends the session flagged archived, which the
        // client filters out anyway, so the optimistic removal stays consistent.
        if (!archived) {
          send({ type: "archiveSession", id, archived });
          return;
        }
        timelineCacheRef.current.delete(id);
        void deleteSessionTimelineCache(id);
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          resyncSessions,
        );
        dispatch({ kind: "optimisticSessionDelete", sessionId: id });
        send({ type: "archiveSession", id, archived, requestId });
      },
      settleSession: (id, settled = true) => {
        // Settling shelves the peers this session still coordinates with it
        // (the server settles them through their current revisions), so they
        // are shelved here too rather than surfacing as cards of their own
        // until the authoritative list lands. Unsettling touches one row.
        const rows = stateRef.current.sessions;
        const peers = settled
          ? sessionSettleCascade(
              id,
              rows,
              stateRef.current.workflowRuns,
              stateRef.current.workflowCards,
            ).peerIds
          : [];
        // Optimistic, because the shelf is a browsing decision the user should
        // see land instantly; the server refuses ineligible work, and its `error`
        // (carrying this requestId) triggers the recovery refetch below.
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id, ...peers] },
          resyncSessions,
        );
        // What the user actually SAW when they clicked, read from the current
        // rows rather than passed in by the caller, so every surface that
        // settles — card, swipe, inspector — acknowledges the same observed
        // revision. A row with no attention observed revision 0, which is the
        // fail-closed answer: an outcome that arrived since stays visible.
        const observed =
          rows.find((session) => session.id === id)?.outcomeAttention
            ?.revision ?? 0;
        dispatch({
          kind: "optimisticSessionSettle",
          sessionId: id,
          settled,
          peerSessionIds: peers,
          now: Date.now(),
        });
        send({
          type: "settleSession",
          id,
          settled,
          throughRevision: observed,
          requestId,
        });
      },
      dismissSessionFailure: (id, errorAt, outcomeRevision) => {
        // The rendered control supplies the identity it displayed. Never
        // replace it with a newer row from stateRef: that would turn a stale
        // click into an acknowledgement of a failure the user did not see.
        send({
          type: "dismissSessionFailure",
          id,
          ...(errorAt === undefined ? {} : { errorAt }),
          outcomeRevision,
        });
      },
      settleWorkflowRun: (runId, throughRevision) => {
        // Optimistic for the same reason a session settle is; the server's
        // `error` (carrying this requestId) triggers the recovery refetch, and
        // the authoritative `workflowRunList` corrects the run either way.
        // The roles were shelved optimistically too, so the recovery re-reads
        // the session list; the server re-sends the run list itself with any
        // refusal.
        const requestId = trackMutation(
          { topic: "workflow", objectIds: [runId] },
          resyncSessions,
        );
        const card = stateRef.current.workflowCards[runId];
        const observed = Math.max(0, Math.trunc(throughRevision));
        dispatch({
          kind: "optimisticWorkflowRunSettle",
          runId,
          throughRevision: observed,
          sessionIds: card ? workflowRunRoleSessionIds(card) : [],
          now: Date.now(),
        });
        send({
          type: "settleWorkflowRun",
          runId,
          // What the user actually SAW. Passed in from the click rather than
          // read from the store here, deliberately: the inbox sends this after
          // its exit animation, and a newer event landing in that window must
          // stay awake rather than be acknowledged by a click that never saw
          // it.
          throughRevision: observed,
          requestId,
        });
      },
      setInboxPositions: (positions) => {
        // Both domains, because one renumbering can place sessions and runs.
        const requestId = trackMutation(
          {
            topic: "sessions",
            objectIds: positions.flatMap((entry) =>
              entry.kind === "session" ? [entry.id] : [],
            ),
            additionalEffects: [
              {
                topic: "workflow",
                objectIds: positions.flatMap((entry) =>
                  entry.kind === "run" ? [entry.runId] : [],
                ),
              },
            ],
          },
          // A refusal re-reads BOTH lists rather than undoing the drop
          // locally: an undo cannot tell its own guess from an authoritative
          // list that has since confirmed the same number (a success whose
          // settle was lost to a reconnect), and the server's lists are right
          // either way.
          () => {
            resyncSessions();
            refetchWorkflowRuns();
          },
        );
        dispatch({ kind: "optimisticInboxPositions", positions });
        send({ type: "setInboxPositions", positions, requestId });
      },
      stopBackgroundWork: (itemId) => {
        dispatch({ kind: "backgroundStopSent", itemId });
        send({
          type: "stopBackgroundWork",
          itemId,
          requestId: createClientId(),
        });
      },
      stopAllBackgroundWork: (ownerSessionId) => {
        dispatch({ kind: "backgroundStopSent", ownerSessionId });
        send({
          type: "stopAllBackgroundWork",
          ownerSessionId,
          requestId: createClientId(),
        });
      },
      setSessionPeerTurnCap: (sessionId, cap) => {
        send({ type: "setSessionPeerTurnCap", sessionId, cap });
      },
      setSpawnOwnership: (id, ownership) => {
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          resyncSessions,
        );
        dispatch({
          kind: "optimisticSpawnOwnership",
          sessionId: id,
          ownership,
        });
        send({ type: "setSpawnOwnership", id, ownership, requestId });
      },
      renameSession: (id, title) => {
        const trimmed = title.trim();
        if (!trimmed) {
          send({ type: "renameSession", id, title });
          return;
        }
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          resyncSessions,
        );
        dispatch({
          kind: "optimisticSessionRename",
          sessionId: id,
          title: trimmed,
          now: Date.now(),
        });
        send({ type: "renameSession", id, title, requestId });
      },
      regenerateSessionTitle: (id, guidance) =>
        send({
          type: "regenerateSessionTitle",
          id,
          ...(guidance.trim() ? { guidance: guidance.trim() } : {}),
        }),
      acknowledgeMissingWorktree: (id) =>
        send({ type: "acknowledgeMissingWorktree", id }),
      forkSession: (id, entryId, position) =>
        send({ type: "forkSession", id, entryId, position }),
      createDraftSession: (agentType, draftText, notice) =>
        send({
          type: "createDraftSession",
          agentType,
          draftText,
          ...(notice !== undefined ? { notice } : {}),
        }),
      updateSettings: (patch) => {
        const requestId = trackMutation(
          { topic: "settings", objectIds: Object.keys(patch) },
          refetchSettings,
        );
        dispatch({ kind: "optimisticSettings", patch });
        send({ type: "updateSettings", patch, requestId });
      },
      setSkillEnabled: (name, on) => {
        // Build on what was last SENT when a write is still in flight. Its echo
        // may not have arrived, and even if it has, a LATER write may be out
        // too — `settings.skills` reflects only what the server has already
        // stored. This patch REPLACES the whole section, so basing it on the
        // echo would drop every in-flight toggle and turn those skills back
        // off.
        const state = stateRef.current;
        const skills: SkillToggles = {
          ...(state.pendingSkillToggles?.skills ?? state.settings.skills),
          [name]: on ? "on" : "off",
        };
        // Assigned by `trackMutation` below, before anything can answer: the
        // recovery has to name its OWN request, since by the time it runs a
        // newer write may hold the base and must keep it.
        let requestId = "";
        requestId = trackMutation(
          { topic: "settings", objectIds: ["skills"] },
          () => {
            // Refused or never answered: this write is not in flight any more,
            // so it may not stay the base — it would re-assert a change the
            // server never took. The re-read says what is actually stored.
            refetchSettings();
            dispatch({ kind: "skillTogglesAnswered", requestId });
          },
        );
        // No optimistic settings patch: only the server's echo may enable a
        // skill. The dispatch records the outbound map, nothing the UI reads.
        dispatch({ kind: "skillTogglesSent", requestId, skills });
        send({ type: "updateSettings", patch: { skills }, requestId });
      },
      updateJiraSettings: (patch) =>
        send({ type: "updateJiraSettings", patch }),
      saveAndTestJiraSettings: (patch) =>
        send({ type: "saveAndTestJiraSettings", patch }),
      testJiraSettings: () => send({ type: "testJiraSettings" }),
      updateConfluenceSettings: (patch) =>
        send({ type: "updateConfluenceSettings", patch }),
      saveAndTestConfluenceSettings: (patch) =>
        send({ type: "saveAndTestConfluenceSettings", patch }),
      testConfluenceSettings: () => send({ type: "testConfluenceSettings" }),
      updateTempoSettings: (patch) =>
        send({ type: "updateTempoSettings", patch }),
      saveAndTestTempoSettings: (patch) =>
        send({ type: "saveAndTestTempoSettings", patch }),
      testTempoSettings: () => send({ type: "testTempoSettings" }),
      updateGoogleSettings: (patch) =>
        send({ type: "updateGoogleSettings", patch }),
      saveAndTestGoogleSettings: (patch) =>
        send({ type: "saveAndTestGoogleSettings", patch }),
      testGoogleSettings: () => send({ type: "testGoogleSettings" }),
      updateSlackSettings: (patch) =>
        send({ type: "updateSlackSettings", patch }),
      saveAndTestSlackSettings: (patch) =>
        send({ type: "saveAndTestSlackSettings", patch }),
      testSlackSettings: () => send({ type: "testSlackSettings" }),
      updateOpenAiCompatibleSettings: (patch) =>
        send({ type: "updateOpenAiCompatibleSettings", patch }),
      saveAndTestOpenAiCompatibleSettings: (patch) =>
        send({ type: "saveAndTestOpenAiCompatibleSettings", patch }),
      testOpenAiCompatibleSettings: () =>
        send({ type: "testOpenAiCompatibleSettings" }),
      updateBraveSettings: (patch) =>
        send({ type: "updateBraveSettings", patch }),
      saveAndTestBraveSettings: (patch) =>
        send({ type: "saveAndTestBraveSettings", patch }),
      testBraveSettings: () => send({ type: "testBraveSettings" }),
      updateContext7Settings: (patch) =>
        send({ type: "updateContext7Settings", patch }),
      saveAndTestContext7Settings: (patch) =>
        send({ type: "saveAndTestContext7Settings", patch }),
      testContext7Settings: () => send({ type: "testContext7Settings" }),
      updateGithubSettings: (patch) =>
        send({ type: "updateGithubSettings", patch }),
      saveAndTestGithubSettings: (patch) =>
        send({ type: "saveAndTestGithubSettings", patch }),
      testGithubSettings: () => send({ type: "testGithubSettings" }),
      updateForgejoSettings: (patch) =>
        send({ type: "updateForgejoSettings", patch }),
      saveAndTestForgejoSettings: (patch) =>
        send({ type: "saveAndTestForgejoSettings", patch }),
      testForgejoSettings: () => send({ type: "testForgejoSettings" }),
      setTopics: (topics) => {
        const next = new Set(topics);
        const added = [...next].filter(
          (topic) => !topicsRef.current.has(topic),
        );
        const removed = [...topicsRef.current].filter(
          (topic) => !next.has(topic),
        );
        topicsRef.current = next;
        if (added.includes("tasks")) episodeListReadsRef.current.tasks = true;
        if (added.includes("projects"))
          episodeListReadsRef.current.projects = true;
        if (added.includes("worktrees"))
          episodeListReadsRef.current.worktrees = true;
        // Subscribing IS the library read, so the pane is pending from here.
        for (const library of LIBRARY_TOPICS)
          if (added.includes(library))
            dispatch({ kind: "libraryLoad", library });
        // The same for the Initiative list, which a surface coming back
        // reads anew even when this episode answered it before.
        if (added.includes("initiatives"))
          dispatch({ kind: "initiativeListSubscribed" });
        if (added.length > 0)
          send(
            replicaTransport.subscribeRequest(
              added,
              stateRef.current,
              mutationLifecycleRef.current.pendingTopics(),
            ),
          );
        if (removed.length > 0) send({ type: "unsubscribe", topics: removed });
      },
      refreshUsage: () => send({ type: "refreshUsage" }),
      setCredentialProfileProjection: (projection) =>
        dispatch({ kind: "credentialProfileProjection", projection }),
      listTasks: (request) => {
        const canonical = Object.keys(request).length === 0;
        if (canonical && episodeListReadsRef.current.tasks) return;
        if (canonical) episodeListReadsRef.current.tasks = true;
        send({ type: "listTasks", request });
      },
      saveTask: (request, operation) => {
        const key = taskMutationKey(
          request.id ?? null,
          operation ?? taskSaveOperation(request),
        );
        const current = stateRef.current.taskMutations[key];
        if (current?.status === "loading" || current?.status === "refreshing")
          return;
        const optimistic =
          canOptimisticallyUpdateTaskList(stateRef.current.taskList) &&
          optimisticSaveTitle(request) !== null;
        const tempId =
          optimistic && !request.id
            ? `optimistic-${createClientId()}`
            : undefined;
        const requestId = trackDomainMutation(
          {
            topic: "tasks",
            objectIds: request.id ? [request.id] : [],
            ...(tempId ? { tempId } : {}),
          },
          "tasks",
          key,
        );
        dispatch({ kind: "taskMutationStart", key });
        // This Task's own next write retires the failure it is carrying.
        if (request.id)
          dispatch({
            kind: "clearObjectFailure",
            type: "task",
            id: request.id,
          });
        if (optimistic)
          dispatch({
            kind: "optimisticTaskSave",
            request,
            tempId: tempId ?? "",
            now: Date.now(),
          });
        send({ type: "saveTask", request, requestId });
      },
      assignTaskProjects: (updates) => {
        if (!stateRef.current.taskList || updates.length === 0) {
          send({ type: "assignTaskProjects", updates });
          return;
        }
        const requestId = trackDomainMutation(
          { topic: "tasks", objectIds: updates.map((update) => update.id) },
          "tasks",
          taskMutationKey(null, "assignProjects"),
        );
        // The request is what carries the answer back, so the Backlog learns
        // that AN ASSIGNMENT failed instead of recognising the server's
        // sentence for it — the wording is not an interface, and a receipt torn
        // down by a message about something else is worse than no receipt.
        //
        // The record it lands in is keyed by OPERATION, not by request: every
        // assignment shares `new:assignProjects`, so this separates assignments
        // from everything else, not one attempt from the next. That matches the
        // receipt it feeds, which is a single pending snapshot the newer
        // assignment has already overwritten — two overlapping assignments
        // share one receipt either way, and giving them separate ones is a
        // redesign of the receipt rather than of this correlation.
        dispatch({
          kind: "taskMutationStart",
          key: taskMutationKey(null, "assignProjects"),
        });
        dispatch({
          kind: "optimisticTaskProjectAssignment",
          updates,
          now: Date.now(),
        });
        send({ type: "assignTaskProjects", updates, requestId });
      },
      archiveTask: (id, archived = true) => {
        const requestId = trackDomainMutation(
          { topic: "tasks", objectIds: [id] },
          "tasks",
        );
        // Membership in the live projection is what the list shows: archiving
        // removes the row, restoring brings it back through the server event
        // (the browser holds no archived row to put back optimistically).
        if (archived) dispatch({ kind: "optimisticTaskRemove", id });
        dispatch({ kind: "clearObjectFailure", type: "task", id });
        send({ type: "archiveTask", id, archived, requestId });
      },
      deleteTask: (id) => {
        const requestId = trackDomainMutation(
          { topic: "tasks", objectIds: [id] },
          "tasks",
        );
        dispatch({ kind: "optimisticTaskRemove", id });
        dispatch({ kind: "clearObjectFailure", type: "task", id });
        send({ type: "deleteTask", id, requestId });
      },
      setOpenTaskProjection: (id) =>
        dispatch({ kind: "setOpenTaskProjection", id }),
      requestTaskDetail: (id) => {
        if (taskDetailRequestsRef.current.has(id)) return;
        const requestId = createClientId();
        taskDetailRequestsRef.current.set(id, requestId);
        dispatch({ kind: "taskDetailLoad", id });
        send({ type: "getTask", id, requestId });
      },
      reorderTasks: (orderedIds, placements) => {
        const key = taskMutationKey(null, "reorder");
        const current = stateRef.current.taskMutations[key];
        if (current?.status === "loading" || current?.status === "refreshing")
          return;
        const requestId = trackDomainMutation(
          {
            topic: "tasks",
            objectIds: placements?.map((p) => p.id) ?? orderedIds,
          },
          "tasks",
          key,
        );
        dispatch({ kind: "taskMutationStart", key });
        if (placements?.length)
          dispatch({ kind: "optimisticTaskReorder", placements });
        send({
          type: "reorderTasks",
          orderedIds,
          ...(placements !== undefined ? { placements } : {}),
          requestId,
        });
      },
      listProjects: (request) => {
        const canonical =
          request?.includeArchived === true &&
          Object.keys(request).length === 1;
        if (canonical && episodeListReadsRef.current.projects) return;
        if (canonical) episodeListReadsRef.current.projects = true;
        send({
          type: "listProjects",
          ...(request !== undefined ? { request } : {}),
        });
      },
      requestProjectDetail: (id) => {
        if (projectDetailRequestsRef.current.has(id)) return;
        const requestId = createClientId();
        projectDetailRequestsRef.current.set(id, requestId);
        dispatch({ kind: "projectDetailLoad", id });
        send({ type: "getProject", id, requestId });
      },
      setOpenProjectProjection: (id) =>
        dispatch({ kind: "setOpenProjectProjection", id }),
      requestInitiativeDetail: (id, collapsed = []) => {
        const wish = collapseRequest(collapsed);
        const inFlight = initiativeDetailRequestsRef.current.get(id);
        if (inFlight) {
          const { next: _next, ...asked } = inFlight;
          initiativeDetailRequestsRef.current.set(
            id,
            sameCollapsed(asked.collapsed, wish)
              ? asked
              : { ...asked, next: wish },
          );
          return;
        }
        const requestId = createClientId();
        initiativeDetailRequestsRef.current.set(id, {
          requestId,
          collapsed: wish,
        });
        dispatch({ kind: "initiativeDetailLoad", id });
        send(initiativeReadMessage(id, requestId, wish));
      },
      retainInitiativeDetail: (id) => {
        dispatch({ kind: "initiativeDetailPin", id, delta: 1 });
        let held = true;
        return () => {
          if (!held) return;
          held = false;
          dispatch({ kind: "initiativeDetailPin", id, delta: -1 });
        };
      },
      setOpenInitiative: (id) => dispatch({ kind: "setOpenInitiative", id }),
      retryInitiatives: () => {
        if (!topicsRef.current.has("initiatives")) return;
        dispatch({ kind: "initiativeListRetry" });
        send({ type: "unsubscribe", topics: ["initiatives"] });
        send(
          replicaTransport.subscribeRequest(
            ["initiatives"],
            stateRef.current,
            mutationLifecycleRef.current.pendingTopics(),
          ),
        );
      },
      saveProject: (id, patch) => {
        const requestId = startProjectMutation(
          id,
          projectSaveOperation(patch),
          [id],
        );
        if (!requestId) return;
        dispatch({ kind: "optimisticProjectSave", id, patch, now: Date.now() });
        send({ type: "saveProject", id, patch, requestId });
      },
      provisionProjectRepo: (id) => {
        const requestId = startProjectMutation(
          id,
          "clone",
          [id],
          LONG_MUTATION_SETTLE_TIMEOUT_MS,
        );
        if (!requestId) return;
        send({ type: "provisionProjectRepo", id, requestId });
      },
      removeProjectRepo: (id) => {
        const requestId = startProjectMutation(
          id,
          "remove",
          [id],
          LONG_MUTATION_SETTLE_TIMEOUT_MS,
        );
        if (!requestId) return;
        send({ type: "removeProjectRepo", id, requestId });
      },
      reorderProjects: (orderedIds, placements) => {
        const touched = placements?.map((p) => p.id) ?? orderedIds;
        const requestId = startProjectMutation(null, "reorder", touched);
        if (!requestId) return;
        if (placements?.length)
          dispatch({ kind: "optimisticProjectReorder", placements });
        send({
          type: "reorderProjects",
          orderedIds,
          ...(placements !== undefined ? { placements } : {}),
          requestId,
        });
      },
      archiveProject: (id) => {
        const requestId = startProjectMutation(id, "archive", [id]);
        if (!requestId) return;
        send({ type: "archiveProject", id, requestId });
      },
      deleteProject: (id) => {
        const requestId = startProjectMutation(id, "delete", [id]);
        if (!requestId) return;
        send({ type: "deleteProject", id, requestId });
      },
      cancelPostReloadContinuation: () =>
        send({ type: "cancelPostReloadContinuation" }),
      clearChatError: (sessionId?: string) =>
        dispatch({
          kind: "clearChatError",
          ...(sessionId !== undefined ? { sessionId } : {}),
        }),
      dismissObjectFailure: (type, id) =>
        dispatch({ kind: "clearObjectFailure", type, id }),
      resolveApproval: (
        approvalId,
        decision,
        edits,
        forSession,
        grantInheritable,
      ) =>
        send({
          type: "resolveApproval",
          approvalId,
          decision,
          ...(edits ? { edits } : {}),
          ...(forSession ? { forSession: true } : {}),
          ...(forSession && grantInheritable ? { grantInheritable: true } : {}),
        }),
      revokeApprovalGrant: (sessionId, key) =>
        send({ type: "revokeApprovalGrant", sessionId, key }),
      grantApprovalForSession: (sessionId, key, inheritable) =>
        send({
          type: "grantApprovalForSession",
          sessionId,
          key,
          ...(inheritable ? { inheritable: true } : {}),
        }),
      setApprovalGrantScope: (sessionId, keys, inheritable) =>
        send({ type: "setApprovalGrantScope", sessionId, keys, inheritable }),
      setCompactionWindow: (sessionId, tokens) => {
        const requestId = mutationLifecycleRef.current.start({
          context: { compactionSessionId: sessionId },
          timeoutMs: MUTATION_SETTLE_TIMEOUT_MS,
          recover: () => {},
          disconnected: () => {},
          terminal: (outcome, _context, id) =>
            dispatch({
              kind: "compactionWindowAnswered",
              sessionId,
              requestId: id,
              ...(outcome.type === "unknown" ? { unknown: true } : {}),
              ...(outcome.type === "error"
                ? { error: outcome.message }
                : outcome.type === "timeout"
                  ? { error: "The server did not answer. Try again." }
                  : {}),
            }),
        });
        dispatch({ kind: "compactionWindowRequested", sessionId, requestId });
        send({ type: "setCompactionWindow", sessionId, tokens, requestId });
        return requestId;
      },
      choosePullRequestTask: (cardId, taskId) =>
        send({ type: "resolvePullRequestCardTask", cardId, taskId }),
      runPullRequestCardAction: (cardId, action, options) => {
        const current = stateRef.current;
        const card = clientPullRequestCard(current.pullRequestCards, cardId);
        if (!card || card.busyAction || card.pendingAction) return;
        const linkedTaskId = card.linkedTask?.id;
        const worktreeId =
          card.worktreeId ??
          (current.session?.sessionId === card.sessionId
            ? current.session.worktreeId
            : undefined) ??
          current.sessions.find((session) => session.id === card.sessionId)
            ?.worktreeId;
        const settledSessionIds = worktreeId
          ? [
              ...new Set([
                card.sessionId,
                ...current.sessions
                  .filter((session) => session.worktreeId === worktreeId)
                  .map((session) => session.id),
              ]),
            ]
          : [card.sessionId];
        const mutation: PendingMutation =
          action === "mark-task-done" && linkedTaskId
            ? { topic: "tasks", objectIds: [linkedTaskId] }
            : action === "cleanup" && worktreeId
              ? {
                  topic: "worktrees",
                  objectIds: [worktreeId],
                  additionalEffects: [
                    { topic: "sessions", objectIds: settledSessionIds },
                  ],
                }
              : { topic: "sessions", objectIds: [card.sessionId] };
        const recover = (pending: PendingMutation) => {
          if (pending.topic === "tasks") recoverTasks(pending);
          if (pending.topic === "worktrees") {
            refetchWorktrees();
            resyncSessions();
          }
        };
        // Domain evidence survives either signal order; the core alone owns
        // settled state, identity and the original deadline.
        let serverBusySeen = false;
        let outcomeSeen = false;
        let competingCard: PullRequestCard | undefined;
        const requestId = mutationLifecycleRef.current.start({
          context: { ...mutation, pullRequestCardId: cardId },
          timeoutMs:
            action === "mark-task-done"
              ? MUTATION_SETTLE_TIMEOUT_MS
              : LONG_MUTATION_SETTLE_TIMEOUT_MS,
          recover: () => recover(mutation),
          disconnected: () => {
            if (mutation.topic === "tasks")
              replicaTransport.invalidate("tasks", mutation.objectIds);
          },
          done: (settled, observation) => {
            if (observation) {
              if (
                observation.type !== "pullRequestCardUpdate" ||
                observation.card.id !== cardId
              )
                return false;
              const observed = observation.card;
              if (observed.busyAction === action) {
                serverBusySeen = true;
                competingCard = undefined;
              } else if (observed.busyAction) {
                if (serverBusySeen) outcomeSeen = true;
                else competingCard = observed;
              } else if (serverBusySeen) outcomeSeen = true;
              // A watcher still carrying a previous result is not evidence.
              // Own dequeue followed by a fieldless clear IS an outcome.
              if (outcomeSeen && observed.actionError) return true;
            }
            return settled && (outcomeSeen || competingCard !== undefined);
          },
          terminal: (outcome, _context, _id, observation) => {
            const durableError =
              outcome.type === "settled" &&
              outcomeSeen &&
              observation?.type === "pullRequestCardUpdate"
                ? observation.card.actionError
                : undefined;
            if (outcome.type === "settled" && (durableError || competingCard))
              recover(mutation);
            const error =
              outcome.type === "error"
                ? outcome.message
                : outcome.type === "timeout"
                  ? "The server did not answer this pull request action. Try again."
                  : durableError;
            // Unknown release happens now, never in deferred recovery, which
            // could otherwise release a newer offline click on this card.
            dispatch({
              kind: "pullRequestCardActionResult",
              cardId,
              ...(error ? { error } : {}),
              ...(outcome.type === "settled" && competingCard
                ? { authoritativeCard: competingCard }
                : {}),
            });
          },
        });
        dispatch({ kind: "optimisticPullRequestCardAction", cardId, action });
        if (action === "mark-task-done" && linkedTaskId)
          dispatch({
            kind: "optimisticTaskSave",
            request: { id: linkedTaskId, status: "done" },
            tempId: "",
            now: Date.now(),
          });
        if (action === "cleanup" && worktreeId)
          dispatch({ kind: "optimisticWorktreeRemove", worktreeId });
        send({
          type: "pullRequestCardAction",
          cardId,
          action,
          ...(options?.mergeMethod ? { mergeMethod: options.mergeMethod } : {}),
          // Only the opt-out is sent: deleting the remote branch is the default
          // and stays unstated on the wire.
          ...(options?.deleteBranch === false ? { deleteBranch: false } : {}),
          ...(options?.expectedBaseBranch
            ? { baseBranch: options.expectedBaseBranch }
            : {}),
          requestId,
        });
      },
      listWorktrees: (projectId) => {
        const canonical = projectId === undefined;
        if (canonical && episodeListReadsRef.current.worktrees) return;
        if (canonical) episodeListReadsRef.current.worktrees = true;
        dispatch({ kind: "worktreeListLoad" });
        send({
          type: "listWorktrees",
          ...(projectId !== undefined ? { projectId } : {}),
        });
      },
      watchWorktree: (worktreeId) =>
        send({ type: "watchWorktree", worktreeId }),
      unwatchWorktree: (worktreeId) =>
        send({ type: "unwatchWorktree", worktreeId }),
      listWorktreeComments: (worktreeId) => {
        const target: CommentTarget = {
          kind: "worktree",
          worktreeId,
          path: "",
          side: "new",
          revision: "",
        };
        const key = commentTargetKey(target);
        if (commentResyncRef.current.has(key)) return;
        const requestId = createClientId();
        heldCommentTargetsRef.current.set(key, target);
        commentRequestsRef.current.set(key, requestId);
        send({ type: "listComments", target, requestId });
      },
      unwatchWorktreeComments: (worktreeId) => {
        const target: CommentTarget = {
          kind: "worktree",
          worktreeId,
          path: "",
          side: "new",
          revision: "",
        };
        heldCommentTargetsRef.current.delete(commentTargetKey(target));
        commentRequestsRef.current.delete(commentTargetKey(target));
        commentResyncRef.current.delete(commentTargetKey(target));
        dispatch({ kind: "unwatchComments", target });
        send({ type: "unwatchComments", target });
      },
      addWorktreeComment: ({ worktreeId, body, anchor, parentId }) => {
        if (parentId) {
          send({ type: "replyComment", threadId: parentId, body });
          return;
        }
        if (!anchor) return;
        send({
          type: "addComment",
          target: {
            kind: "worktree",
            worktreeId,
            path: anchor.path,
            side: anchor.side,
            revision: anchor.ref ?? "",
          },
          body,
          selectors: anchor.selectors ?? {
            quote: { exact: "", prefix: "", suffix: "" },
            block: { id: String(anchor.line), occurrence: 1 },
          },
        });
      },
      resolveWorktreeComment: (commentId, resolved) =>
        send({ type: "resolveComment", threadId: commentId, resolved }),
      deleteWorktreeComment: (commentId) =>
        send({ type: "deleteComment", threadId: commentId }),
      attachWorktreeComments: ({ commentIds, target }) =>
        send({
          type: "attachComments",
          threadIds: commentIds,
          session: target,
        }),
      mergeWorktree: (worktreeId, strategy) =>
        send({
          type: "mergeWorktree",
          worktreeId,
          ...(strategy !== undefined ? { strategy } : {}),
        }),
      proposeWorktreeName: ({ projectId, requestId, taskId, context }) =>
        send({
          type: "proposeWorktreeName",
          projectId,
          requestId,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(context !== undefined ? { context } : {}),
        }),
      createWorktree: ({ projectId, name, taskId, sessionId }) =>
        send({
          type: "createWorktree",
          projectId,
          name,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        }),
      startWorkflowRun: ({ taskId, config, baseBranch, limits, requestId }) =>
        send({
          type: "startWorkflowRun",
          taskId,
          config,
          requestId,
          ...(baseBranch !== undefined ? { baseBranch } : {}),
          ...(limits ? { limits } : {}),
        }),
      pauseWorkflowRun: (runId, reason) =>
        send({
          type: "pauseWorkflowRun",
          runId,
          ...(reason !== undefined ? { reason } : {}),
        }),
      resumeWorkflowRun: (runId) => send({ type: "resumeWorkflowRun", runId }),
      cancelWorkflowRun: (runId) => send({ type: "cancelWorkflowRun", runId }),
      deleteWorkflowRun: (runId, options) =>
        send({ type: "deleteWorkflowRun", runId, ...options }),
      retryWorkflowRun: (runId) => send({ type: "retryWorkflowRun", runId }),
      answerWorkflowCeiling: (runId, choice, raise) =>
        send({
          type: "answerWorkflowCeiling",
          runId,
          choice,
          ...(raise ? { raise } : {}),
        }),
      answerWorkflowCommitCheck: (runId, choice) =>
        send({ type: "answerWorkflowCommitCheck", runId, choice }),
      rebaseAndReviewWorkflowRun: (runId) =>
        send({ type: "rebaseAndReviewWorkflowRun", runId }),
      mergeWorkflowRun: (runId, { mergeMethod, deleteBranch }) => {
        const requestId = startWorkflowDelivery(runId, "merge");
        if (!requestId) return;
        send({
          type: "mergeWorkflowRun",
          runId,
          mergeMethod,
          // Deleting the remote branch is the default, so only the opt-out
          // travels — the same shape the live card's merge sends.
          ...(deleteBranch ? {} : { deleteBranch: false }),
          requestId,
        });
      },
      cleanUpWorkflowRun: (runId) => {
        const requestId = startWorkflowDelivery(runId, "cleanup");
        if (!requestId) return;
        send({ type: "cleanUpWorkflowRun", runId, requestId });
      },
      clearWorkflowRunStart: (requestId) =>
        dispatch({ kind: "clearWorkflowRunStart", requestId }),
      removeWorktree: ({ worktreeId, deleteBranch, force }) => {
        const requestId = trackMutation(
          { topic: "worktrees", objectIds: [worktreeId] },
          refetchWorktrees,
        );
        dispatch({ kind: "optimisticWorktreeRemove", worktreeId });
        send({
          type: "removeWorktree",
          worktreeId,
          ...(deleteBranch !== undefined ? { deleteBranch } : {}),
          ...(force !== undefined ? { force } : {}),
          requestId,
        });
      },
    };
  }, [readTimelineCache, replicaTransport, scheduleLiveBodySubscriptions]);

  /**
   * Load a reveal's target INTO the window. The transcript is a windowed suffix,
   * and a peer prompt or fork origin is usually old, so the row a jump names is
   * routinely behind it — without this the reader lands in the right session at
   * the wrong place, which is the same as not jumping at all.
   *
   * `index` says exactly how far back the row sits, so this asks for that many
   * entries instead of paging blindly; the answer is still bounded by bytes, so
   * a very long stretch takes more than one pass. Every pass must MOVE the
   * window: one that does not (the session start, or an anchor the server can no
   * longer place) ends the walk rather than repeating forever.
   */
  const revealPagingRef = useRef<{ token: number; start: number } | null>(null);
  const reveal = state.messageReveal;
  const revealSessionMatches = state.session?.sessionId === reveal?.sessionId;
  useEffect(() => {
    if (!reveal || !revealSessionMatches) return;
    if (state.timelineStart <= reveal.index) return;
    if (state.timelineRangePending !== null) return;
    const first = state.timeline[0];
    if (!first) return;
    const walked = revealPagingRef.current;
    if (walked?.token === reveal.token && walked.start <= state.timelineStart) {
      // The last pass moved nothing, so no further pass can. Retire the jump
      // rather than leaving it live: a later visit to this session opens on a
      // fresh tail, and an un-retired reveal would page all the way back to an
      // anchor nobody is waiting for any more.
      dispatch({ kind: "revealSettled", token: reveal.token });
      return;
    }
    revealPagingRef.current = {
      token: reveal.token,
      start: state.timelineStart,
    };
    dispatch({ kind: "timelineRangeRequested", beforeSeq: first.seq });
    socketRef.current?.send({
      type: "loadTimelineRange",
      sessionId: reveal.sessionId,
      beforeSeq: first.seq,
      limit: Math.min(
        TIMELINE_RANGE_MAX_LIMIT,
        Math.max(TIMELINE_RANGE_LIMIT, state.timelineStart - reveal.index),
      ),
    });
  }, [
    reveal,
    revealSessionMatches,
    state.timeline,
    state.timelineStart,
    state.timelineRangePending,
  ]);

  return { state, actions, socket };
}
