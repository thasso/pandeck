import {
  applyPatch,
  commentTargetKey,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  DEFAULT_HELPER_MODEL,
  DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  MAX_OPEN_COMMENT_TARGETS,
  isPersonalAssistantAgentType,
  projectSummaryOf,
  taskSummaryOf,
  workflowRunRoleSessionIds,
} from "@assistant/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createClientId } from "../lib/clientId.ts";
import { createIdleWriter, type IdleWriter } from "../lib/idleWriter.ts";
import { announceMessage } from "../lib/messageAnnounce.ts";
import { sessionSettleCascade } from "../lib/sessionInbox.ts";
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
  PeerPromptThreadsProjection,
  ProjectListRequest,
  ProjectListResponse,
  ProjectRecord,
  ProjectSummary,
  PullRequestCard,
  PullRequestCardAction,
  PullRequestMergeMethod,
  PromptAttachment,
  PromptQueueCommand,
  ServerMessage,
  StateDigestEntry,
  TimelineAnchorTarget,
  StateDigestMessage,
  StateEvent,
  StateEventsMessage,
  SubagentRunSummary,
  SubagentThreadRunDetail,
  SubagentThreadSummary,
  BackgroundWorkItemSummary,
  SlackConnectionStatus,
  SlackHuddleConnectionStatus,
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
  TaskComment,
  TaskItem,
  TaskListRequest,
  TaskListResponse,
  TaskProjectAssignmentUpdate,
  TaskReorderPlacement,
  TaskSaveRequest,
  TaskSummary,
  NewWorktreeCommentAnchor,
  SkillLibraryList,
  SkillToggles,
  CodeDeliveryWorkflowConfig,
  WorkflowRunCard,
  WorkflowRunDelivery,
  WorkflowCeilingRaise,
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
  beginLoad,
  dataOf,
  failFrom,
  idle,
  ready,
  type LoadState,
} from "../lib/loadState.ts";

const defaultSettings: AppSettings = {
  projectsRoot: "~/projects",
  models: { hidden: [], order: [] },
  peerSpawnRuntimes: [],
  sessionPeerPromptMaxHops: DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  // Sparse and empty until the Settings page fetches the real object: every
  // skill reads OFF, which is what an unanswered settings read may claim.
  skills: {},
  permanentAssistant: {
    name: "Personal Assistant",
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
  pdfConversion: {
    fallbackEnabled: true,
    provider: "claude-sdk",
    modelId: "sonnet",
    thinkingLevel: "off",
    timeoutMs: 180000,
  },
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
    huddlesEnabled: false,
    clientTokenConfigured: false,
    clientCookieConfigured: false,
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
  sessions: SessionListItem[];
  /**
   * An authoritative session list arrived in the CURRENT socket episode.
   *
   * The sibling of `taskListFresh` for a list that is not a subscription: it
   * arrives whole with `ready`, so that is the only step that may set this.
   * `hydrationSource === "live"` is NOT a substitute — it is historical, and a
   * reconnect turns `connected` back on before the new `ready` lands, which
   * would bless previous-episode rows as current.
   */
  sessionListFresh: boolean;
  /** Count of archived sessions omitted until the archived sidebar section is expanded. */
  archivedSessionCount: number;
  /** True once archived session rows have been loaded into `sessions`. */
  archivedSessionsLoaded: boolean;
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
  jiraStatus: JiraConnectionStatus | null;
  confluenceStatus: ConfluenceConnectionStatus | null;
  tempoStatus: TempoConnectionStatus | null;
  googleStatus: GoogleConnectionStatus | null;
  slackStatus: SlackConnectionStatus | null;
  slackHuddleStatus: SlackHuddleConnectionStatus | null;
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
  /** Canonical bounded subagent registry; detail/transcript state stays keyed. */
  subagentThreads: SubagentThreadSummary[];
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
  /** Held-thread run details and their revision sidecars, keyed by thread id. */
  subagentRunDetails: Record<
    string,
    {
      detail: SubagentThreadRunDetail;
      revisions: Record<string, number>;
      seq: number;
    }
  >;
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
  skillLibrary: LoadState<SkillLibraryList>;
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
  /** Keyed activity projections; unanswered and authoritative empty stay distinct. */
  taskComments: Record<string, LoadState<TaskComment[]>>;
  /** Least-recently-used order for the bounded per-Task comments cache. */
  taskCommentsLru: string[];
  /** Task route whose ready detail/activity entries are pinned in both caches. */
  openTaskProjectionId: string | null;
  /** Authoritative re-anchored Knowledge comment threads per entry id. */
  /** Latest committed invalidation timestamp per Knowledge entry. */
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
  /** Least-recently-used order for the bounded per-Task body cache. */
  taskDetailsLru: string[];
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
  /** Explicitly requested expanded Peer prompts history for the current session, if any. */
  peerPromptHistoryExpanded: PeerPromptThreadsProjection | null;
  /**
   * The viewed session's "Approve for session" grants, keyed by the session
   * they belong to so a list for the session just left never shows here.
   */
  approvalGrants: {
    sessionId: string;
    grants: import("@assistant/shared").ApprovalGrant[];
  } | null;
  /** The runtime's authoritative run state (drives the working indicator). */
  runState: SnapshotRunState;
  /** Session-level "is a turn running" — derived from {@link runState}. */
  streaming: boolean;
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
  /** Compact title/route/existence metadata for resolved pa:// object links. */
  objectLinks: Record<string, PaObjectLinkResolution>;
}

const APP_SHELL_CACHE_KEY = "assistant.appShellCache.v1";
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

const emptyInitial: UIState = {
  hydrated: false,
  hydrationSource: "empty",
  shellCachedAt: null,
  connected: false,
  models: [],
  modelsRefreshRequestId: null,
  agents: [],
  sessions: [],
  archivedSessionCount: 0,
  archivedSessionsLoaded: false,
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
  jiraStatus: null,
  confluenceStatus: null,
  tempoStatus: null,
  googleStatus: null,
  slackStatus: null,
  slackHuddleStatus: null,
  openAiCompatibleStatus: null,
  braveStatus: null,
  context7Status: null,
  githubStatus: null,
  forgejoStatus: null,
  taskList: null,
  stateEventRevisions: {},
  subagentThreads: [],
  backgroundWorkItems: [],
  backgroundWorkTruncated: false,
  backgroundStopPending: [],
  backgroundStopAllPending: [],
  backgroundHostCloseWaiting: [],
  subagentRunDetails: {},
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
  taskComments: {},
  taskCommentsLru: [],
  openTaskProjectionId: null,
  worktreeMerge: {},
  taskDetails: {},
  taskDetailsLru: [],
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
  peerPromptHistoryExpanded: null,
  approvalGrants: null,
  runState: "idle",
  streaming: false,
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

function taskDigestRecord(
  entries: readonly StateDigestEntry[],
): Record<string, number> | null {
  const revisions: Record<string, number> = {};
  for (const entry of entries) {
    if (
      !entry.id ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      entry.id in revisions
    )
      return null;
    revisions[entry.id] = entry.revision;
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
        awaitingInput: _awaitingInput,
        attention: _attention,
        queuedWork: _queuedWork,
        delegation: _delegation,
        // Who still owes a reply is live too: kept alone, it would read a
        // tree whose peers were working as stalled until the first list.
        awaitingRepliesFrom: _awaitingRepliesFrom,
        ...rest
      } = session;
      return { ...rest, isStreaming: false };
    });
}

function mergeSessionList(
  current: SessionListItem[],
  incoming: SessionListItem[],
  archivedSessionsLoaded: boolean,
): SessionListItem[] {
  if (archivedSessionsLoaded) return incoming;
  // Default session broadcasts intentionally omit archived rows. If the user has
  // already expanded and loaded the archive, preserve those rows locally while
  // replacing active rows with the authoritative fresh list.
  const incomingIds = new Set(incoming.map((session) => session.id));
  const preservedArchived = current.filter(
    (session) => session.archived && !incomingIds.has(session.id),
  );
  return [...incoming, ...preservedArchived].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

function upsertSessionListItem(
  current: SessionListItem[],
  incoming: SessionListItem,
): SessionListItem[] {
  const idx = current.findIndex((session) => session.id === incoming.id);
  if (idx < 0)
    return [incoming, ...current].sort((a, b) => b.updatedAt - a.updatedAt);
  const next = current.slice();
  next[idx] = incoming;
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Structural equality for JSON wire values; Task summaries contain no cycles.
 *
 * A property whose value is `undefined` counts as ABSENT, because that is what
 * it is on the wire: `JSON.stringify` drops it. Optimistic projections are built
 * with spreads that leave such keys behind (`completedAt: undefined` when a Task
 * leaves `done`), and treating them as a difference would make the authoritative
 * echo of an unchanged row replace it — the one thing this comparison exists to
 * prevent.
 */
function wireValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null) return false;
  if (typeof right !== "object" || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => wireValueEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = definedKeys(leftRecord);
  return (
    keys.length === definedKeys(rightRecord).length &&
    keys.every((key) => wireValueEqual(leftRecord[key], rightRecord[key]))
  );
}

function definedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => record[key] !== undefined);
}

/** Preserve row identities across authoritative snapshots when content agrees. */
function reconcileTaskList(
  current: TaskListResponse | null,
  incoming: TaskListResponse,
): TaskListResponse {
  if (!current || current.items.length === 0 || incoming.items.length === 0)
    return incoming;
  const currentById = new Map(current.items.map((item) => [item.id, item]));
  let reused = false;
  const items = incoming.items.map((item) => {
    const existing = currentById.get(item.id);
    if (!existing || !wireValueEqual(existing, item)) return item;
    reused = true;
    return existing;
  });
  return reused ? { ...incoming, items } : incoming;
}

function reconcileProjectList(
  current: ProjectListResponse | null,
  incoming: ProjectListResponse,
): ProjectListResponse {
  if (!current) return incoming;
  const byId = new Map(
    current.projects.map((project) => [project.id, project]),
  );
  let reused = false;
  const projects = incoming.projects.map((project) => {
    const existing = byId.get(project.id);
    if (!existing || !wireValueEqual(existing, project)) return project;
    reused = true;
    return existing;
  });
  return reused ? { ...incoming, projects } : incoming;
}

function parseAppShellCache(raw: string | null): AppShellCache | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
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
    return parseAppShellCache(window.localStorage.getItem(APP_SHELL_CACHE_KEY));
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
    sessions: cache.sessions,
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
    window.localStorage.setItem(APP_SHELL_CACHE_KEY, JSON.stringify(payload));
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
/**
 * Clone/remove and every remote card action (merge, update-with-main, cleanup)
 * are real long operations; their settle follows COMPLETION, so the short
 * timeout would fire while the action still runs.
 */
const LONG_MUTATION_SETTLE_TIMEOUT_MS = 15 * 60_000;
/** Full Task bodies and comment traces are useful on revisit but must stay bounded. */
export const TASK_PROJECTION_CACHE_LIMIT = 16;
const PROJECT_DETAIL_CACHE_LIMIT = 12;
/** Digest catch-up degrades to the full snapshot instead of hanging stale. */
const TASK_DIGEST_TIMEOUT_MS = 10_000;

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
  | "assignProjects"
  | "comment";

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

interface TaskDigestSync {
  requestId: string;
  expectedIds: ReadonlySet<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface SubagentRunDigestSync {
  threadId: string;
  requestId: string;
  expectedIds: ReadonlySet<string>;
  timer: ReturnType<typeof setTimeout>;
}

interface TrackedPendingMutation extends PendingMutation {
  /**
   * Re-read the recorded objects from the authoritative source after failure.
   * Never restore an inverse: a concurrent writer may have changed them since
   * the optimistic apply. Snapshot transports remain until their domains
   * migrate, but the queue already retains the per-object recovery boundary.
   */
  recover: (mutation: PendingMutation) => void;
  timer: ReturnType<typeof setTimeout>;
}

function taskSubscribeMessage(
  topics: BroadcastTopic[],
  state: UIState,
  pending: ReadonlyMap<string, TrackedPendingMutation>,
): Extract<ClientMessage, { type: "subscribe" }> {
  const pendingTopics = new Set(
    [...pending.values()].flatMap((entry) => [
      entry.topic,
      ...(entry.additionalEffects?.map((effect) => effect.topic) ?? []),
    ]),
  );
  const digests: BroadcastTopic[] = [];
  if (
    topics.includes("tasks") &&
    !pendingTopics.has("tasks") &&
    canUseTaskDigest(state)
  )
    digests.push("tasks");
  if (
    topics.includes("projects") &&
    !pendingTopics.has("projects") &&
    canUseProjectDigest(state)
  )
    digests.push("projects");
  return {
    type: "subscribe",
    topics,
    ...(digests.length ? { digests } : {}),
  };
}

function settleMutation(
  pending: Map<string, TrackedPendingMutation>,
  requestId: string,
): TrackedPendingMutation | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  return entry;
}

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
      error?: string;
    }
  | { kind: "taskCommentsLoad"; taskId: string }
  | { kind: "unwatchComments"; target: CommentTarget }
  | {
      kind: "taskCommentsResult";
      taskId: string;
      comments: TaskComment[];
      error?: string;
    }
  | { kind: "taskMutationStart"; key: string }
  | { kind: "taskMutationResult"; key: string; error?: string }
  | { kind: "setOpenTaskProjection"; id: string | null }
  /**
   * The server's direct answer to `saveTask`, carrying the temp id its pending
   * entry recorded (the wire message never does — the server has no temp ids).
   */
  | { kind: "taskSaved"; item: TaskItem; tempId?: string }
  | {
      kind: "taskRecoveryItems";
      events: TaskStateEventsMessage["events"];
    }
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
  | {
      kind: "projectRecoveryItems";
      events: ProjectStateEventsMessage["events"];
    }
  | { kind: "setOpenProjectProjection"; id: string | null }
  | { kind: "projectMutationStart"; key: string }
  | { kind: "projectMutationResult"; key: string; error?: string }
  | { kind: "worktreeListLoad" }
  /** A `skills` subscribe went out: the server is scanning the library now. */
  | { kind: "skillLibraryLoad" }
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
  | { kind: "optimisticSessionDelete"; sessionId: string }
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
 * `timelineDelta` echoes the same clientRequestId and reconciles it. No-op for an
 * empty prompt (attachments-only) — the server entry carries the chips.
 */
function optimisticUserEcho(
  dispatch: (action: Action) => void,
  clientRequestId: string,
  text: string,
  sessionId?: string,
  canMoveSession = false,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  dispatch({
    kind: "optimisticUserMessage",
    clientRequestId,
    text: trimmed,
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
    mergePullRequestCardMessages(
      mergeApprovalMessages(base, approvals, loadedFrom),
      pullRequestCards,
      loadedFrom,
    ),
    worktreeProvision,
  );
  const streamingMessageId = messages.find((m) => m.streaming)?.id ?? null;
  return {
    ...state,
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

/** Restore store-backed approval cards to the turn/tool position where they were issued. */
function mergeApprovalMessages(
  base: DisplayMessage[],
  approvals: DisplayMessage[],
  loadedFrom: number | null,
): DisplayMessage[] {
  const result = [...base];
  const ordered = [...approvals].sort(
    (a, b) => approvalCreatedAt(a) - approvalCreatedAt(b),
  );
  for (const message of ordered) {
    const approval = message.blocks.find(
      (block): block is Extract<DisplayBlock, { kind: "approval" }> =>
        block.kind === "approval",
    )?.approval;
    const sourceToolCallId = approval?.sourceToolCallId;
    let insertAt = -1;
    if (sourceToolCallId) {
      const anchor = result.findIndex((candidate) =>
        candidate.blocks.some(
          (block) => block.kind === "tool" && block.toolId === sourceToolCallId,
        ),
      );
      if (anchor >= 0) {
        insertAt = anchor + 1;
        while (
          insertAt < result.length &&
          approvalSourceToolCallId(result[insertAt]!) === sourceToolCallId
        )
          insertAt += 1;
      }
    }
    if (insertAt < 0) {
      const createdAt = approvalCreatedAt(message);
      if (loadedFrom !== null && createdAt < loadedFrom) continue;
      insertAt = result.findIndex((candidate) => {
        const candidateAt = candidate.createdAt
          ? Date.parse(candidate.createdAt)
          : Number.NaN;
        return Number.isFinite(candidateAt) && candidateAt > createdAt;
      });
      if (insertAt < 0) {
        // Keep trailing undated live/store overlays after the last durable
        // message; an unrelated undated card earlier in history must not pull
        // this approval ahead of its timestamp.
        let lastDated = -1;
        for (let index = 0; index < result.length; index += 1)
          if (result[index]!.createdAt) lastDated = index;
        insertAt = lastDated >= 0 ? lastDated + 1 : result.length;
      }
    }
    result.splice(insertAt, 0, message);
  }
  return result;
}

function approvalCreatedAt(message: DisplayMessage): number {
  const card = message.blocks.find(
    (block): block is Extract<DisplayBlock, { kind: "approval" }> =>
      block.kind === "approval",
  )?.approval;
  return (
    card?.createdAt ?? (message.createdAt ? Date.parse(message.createdAt) : 0)
  );
}

function approvalSourceToolCallId(message: DisplayMessage): string | undefined {
  return message.blocks.find(
    (block): block is Extract<DisplayBlock, { kind: "approval" }> =>
      block.kind === "approval",
  )?.approval.sourceToolCallId;
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

/** Restore store-backed pull-request cards to the turn/tool position where they were issued (mirrors `mergeApprovalMessages`). */
function mergePullRequestCardMessages(
  base: DisplayMessage[],
  cards: DisplayMessage[],
  loadedFrom: number | null,
): DisplayMessage[] {
  const result = [...base];
  const ordered = [...cards].sort(
    (a, b) => pullRequestCardCreatedAt(a) - pullRequestCardCreatedAt(b),
  );
  for (const message of ordered) {
    const card = message.blocks.find(
      (block): block is Extract<DisplayBlock, { kind: "pullRequest" }> =>
        block.kind === "pullRequest",
    )?.pullRequest;
    const sourceToolCallId = card?.sourceToolCallId;
    let insertAt = -1;
    if (sourceToolCallId) {
      const anchor = result.findIndex((candidate) =>
        candidate.blocks.some(
          (block) => block.kind === "tool" && block.toolId === sourceToolCallId,
        ),
      );
      if (anchor >= 0) {
        insertAt = anchor + 1;
        while (
          insertAt < result.length &&
          pullRequestCardSourceToolCallId(result[insertAt]!) ===
            sourceToolCallId
        )
          insertAt += 1;
      }
    }
    if (insertAt < 0) {
      const createdAt = pullRequestCardCreatedAt(message);
      if (loadedFrom !== null && createdAt < loadedFrom) continue;
      insertAt = result.findIndex((candidate) => {
        const candidateAt = candidate.createdAt
          ? Date.parse(candidate.createdAt)
          : Number.NaN;
        return Number.isFinite(candidateAt) && candidateAt > createdAt;
      });
      if (insertAt < 0) {
        let lastDated = -1;
        for (let index = 0; index < result.length; index += 1)
          if (result[index]!.createdAt) lastDated = index;
        insertAt = lastDated >= 0 ? lastDated + 1 : result.length;
      }
    }
    result.splice(insertAt, 0, message);
  }
  return result;
}

function pullRequestCardCreatedAt(message: DisplayMessage): number {
  const card = message.blocks.find(
    (block): block is Extract<DisplayBlock, { kind: "pullRequest" }> =>
      block.kind === "pullRequest",
  )?.pullRequest;
  return (
    card?.createdAt ?? (message.createdAt ? Date.parse(message.createdAt) : 0)
  );
}

function pullRequestCardSourceToolCallId(
  message: DisplayMessage,
): string | undefined {
  return message.blocks.find(
    (block): block is Extract<DisplayBlock, { kind: "pullRequest" }> =>
      block.kind === "pullRequest",
  )?.pullRequest.sourceToolCallId;
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
    ...(request.jiraIssueKeys !== undefined
      ? { jiraIssueKeys: request.jiraIssueKeys }
      : {}),
    ...(request.githubIssues !== undefined
      ? { githubIssues: request.githubIssues }
      : {}),
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
      jiraIssueKeys: request.jiraIssueKeys ?? item.jiraIssueKeys,
      githubIssues: request.githubIssues ?? item.githubIssues,
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
type SubagentStateEventsMessage = StateEventsMessage<
  "subagents",
  SubagentThreadSummary
>;
type BackgroundStateEventsMessage = StateEventsMessage<
  "background",
  BackgroundWorkItemSummary
>;
type TaskDigestMessage = StateDigestMessage<"tasks">;
type ProjectDigestMessage = StateDigestMessage<"projects">;

/**
 * Diff an authoritative live-projection digest against settled cached objects.
 * `null` means the cache cannot safely drive a digest and needs a full snapshot.
 */
function changedTaskIdsForDigest(
  state: UIState,
  message: TaskDigestMessage,
): string[] | null {
  if (!canUseTaskDigest(state) || !state.taskList) return null;
  const digest = taskDigestRecord(message.entries);
  if (!digest) return null;
  const objectIds = new Set(state.taskList.items.map((item) => item.id));
  const revisions = state.stateEventRevisions.tasks!;
  return message.entries
    .filter(
      (entry) =>
        !objectIds.has(entry.id) || revisions[entry.id] !== entry.revision,
    )
    .map((entry) => entry.id);
}

/** Prune objects absent from a digest while stale changed rows remain visible. */
function applyTaskDigest(state: UIState, message: TaskDigestMessage): UIState {
  const changedIds = changedTaskIdsForDigest(state, message);
  if (!changedIds || !state.taskList) return state;
  const liveIds = new Set(message.entries.map((entry) => entry.id));
  const items = state.taskList.items.filter((item) => liveIds.has(item.id));
  const currentRevisions = state.stateEventRevisions.tasks!;
  const revisions: Record<string, number> = {};
  for (const entry of message.entries) {
    const current = currentRevisions[entry.id];
    // Do not advance changed rows to the digest revision before their item is
    // fetched: the ordinary event carrying that same revision must still apply.
    if (current !== undefined) revisions[entry.id] = current;
  }
  return {
    ...state,
    taskList:
      items.length === state.taskList.items.length
        ? state.taskList
        : { ...state.taskList, items },
    stateEventRevisions: { ...state.stateEventRevisions, tasks: revisions },
    taskListFresh: changedIds.length === 0,
    error: null,
  };
}

function changedProjectIdsForDigest(
  state: UIState,
  message: ProjectDigestMessage,
): string[] | null {
  if (!canUseProjectDigest(state) || !state.projectList) return null;
  const digest = taskDigestRecord(message.entries);
  if (!digest) return null;
  const ids = new Set(state.projectList.projects.map((project) => project.id));
  const revisions = state.stateEventRevisions.projects!;
  return message.entries
    .filter(
      (entry) => !ids.has(entry.id) || revisions[entry.id] !== entry.revision,
    )
    .map((entry) => entry.id);
}

function applyProjectDigest(
  state: UIState,
  message: ProjectDigestMessage,
): UIState {
  const changedIds = changedProjectIdsForDigest(state, message);
  if (!changedIds || !state.projectList) return state;
  const liveIds = new Set(message.entries.map((entry) => entry.id));
  const projects = state.projectList.projects.filter((project) =>
    liveIds.has(project.id),
  );
  const current = state.stateEventRevisions.projects!;
  const revisions: Record<string, number> = {};
  for (const entry of message.entries) {
    if (current[entry.id] !== undefined)
      revisions[entry.id] = current[entry.id]!;
  }
  return {
    ...state,
    projectList:
      projects.length === state.projectList.projects.length
        ? state.projectList
        : { ...state.projectList, projects },
    stateEventRevisions: { ...state.stateEventRevisions, projects: revisions },
    projectListFresh: changedIds.length === 0,
    projectListError: null,
    error: null,
  };
}

/**
 * Apply one server flush atomically through the state engine. A stale batch is
 * an exact no-op; a newer echo advances only the revision sidecar when its wire
 * value already matches, preserving both the list and row identities.
 */
function applyEvent(
  state: UIState,
  message:
    | TaskStateEventsMessage
    | ProjectStateEventsMessage
    | SubagentStateEventsMessage
    | BackgroundStateEventsMessage,
): UIState {
  if (message.topic === "projects") return applyProjectEvent(state, message);
  if (message.topic === "subagents") return applySubagentEvent(state, message);
  if (message.topic === "background")
    return applyBackgroundEvent(state, message);
  const currentRevisions = state.stateEventRevisions[message.topic] ?? {};
  let revisions: Record<string, number> | null = null;
  let items = state.taskList?.items;

  for (const event of message.events) {
    const knownRevision =
      revisions?.[event.id] ?? currentRevisions[event.id] ?? -1;
    if (event.revision <= knownRevision) continue;

    revisions ??= { ...currentRevisions };
    revisions[event.id] = event.revision;
    if (!items) continue;

    const index = items.findIndex((item) => item.id === event.id);
    if (event.kind === "delete") {
      if (index >= 0) items = items.filter((item) => item.id !== event.id);
      continue;
    }
    if (index < 0) {
      items = [event.item, ...items];
      continue;
    }
    if (wireValueEqual(items[index], event.item)) continue;
    const next = items.slice();
    next[index] = event.item;
    items = next;
  }

  // A batch whose events were all stale is an exact no-op here; whether it
  // ARRIVED is the tripwire's business, and the tripwire is transport state.
  if (!revisions) return state;
  const taskList =
    state.taskList && items !== undefined && items !== state.taskList.items
      ? { ...state.taskList, items }
      : state.taskList;
  return {
    ...state,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      [message.topic]: revisions,
    },
    taskList,
    taskDetails:
      taskList === state.taskList
        ? state.taskDetails
        : reconcileTaskDetails(state.taskDetails, taskList?.items),
  };
}

function applySubagentEvent(
  state: UIState,
  message: SubagentStateEventsMessage,
): UIState {
  const current = state.stateEventRevisions.subagents ?? {};
  let revisions: Record<string, number> | null = null;
  let threads = state.subagentThreads;
  for (const event of message.events) {
    const known = revisions?.[event.id] ?? current[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...current };
    revisions[event.id] = event.revision;
    const index = threads.findIndex((thread) => thread.id === event.id);
    if (event.kind === "delete") {
      if (index >= 0)
        threads = threads.filter((thread) => thread.id !== event.id);
    } else if (index < 0) {
      threads = [event.item, ...threads];
    } else if (!wireValueEqual(threads[index], event.item)) {
      const next = threads.slice();
      next[index] = event.item;
      threads = next;
    }
  }
  if (!revisions) return state;
  return {
    ...state,
    subagentThreads: threads,
    stateEventRevisions: { ...state.stateEventRevisions, subagents: revisions },
  };
}

function applyBackgroundEvent(
  state: UIState,
  message: BackgroundStateEventsMessage,
): UIState {
  const current = state.stateEventRevisions.background ?? {};
  let revisions: Record<string, number> | null = null;
  let items = state.backgroundWorkItems;
  for (const event of message.events) {
    const known = revisions?.[event.id] ?? current[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...current };
    revisions[event.id] = event.revision;
    const index = items.findIndex((item) => item.id === event.id);
    if (event.kind === "delete") {
      if (index >= 0) items = items.filter((item) => item.id !== event.id);
    } else if (index < 0) {
      items = [event.item, ...items];
    } else if (!wireValueEqual(items[index], event.item)) {
      const next = items.slice();
      next[index] = event.item;
      items = next;
    }
  }
  if (!revisions) return state;
  return {
    ...state,
    backgroundWorkItems: items,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      background: revisions,
    },
  };
}

type SubagentRunItemEvent = StateEvent<SubagentRunSummary>;

function applySubagentRunEvents(
  state: UIState,
  threadId: string,
  events: readonly SubagentRunItemEvent[],
  seq: number,
): UIState {
  const held = state.subagentRunDetails[threadId];
  if (!held) return state;
  let revisions: Record<string, number> | null = null;
  let runs = held.detail.runs;
  for (const event of events) {
    const known = revisions?.[event.id] ?? held.revisions[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...held.revisions };
    revisions[event.id] = event.revision;
    const index = runs.findIndex((run) => run.id === event.id);
    if (event.kind === "delete") {
      if (index >= 0) runs = runs.filter((run) => run.id !== event.id);
    } else if (index < 0) {
      runs = [event.item, ...runs];
    } else if (!wireValueEqual(runs[index], event.item)) {
      const next = runs.slice();
      next[index] = event.item;
      runs = next;
    }
  }
  if (!revisions) return state;
  return {
    ...state,
    subagentRunDetails: {
      ...state.subagentRunDetails,
      [threadId]: {
        ...held,
        detail:
          runs === held.detail.runs ? held.detail : { ...held.detail, runs },
        revisions,
        seq,
      },
    },
  };
}

function applyProjectEvent(
  state: UIState,
  message: ProjectStateEventsMessage,
): UIState {
  const currentRevisions = state.stateEventRevisions.projects ?? {};
  let revisions: Record<string, number> | null = null;
  let projects = state.projectList?.projects;
  let projectDetails = state.projectDetails;

  for (const event of message.events) {
    const known = revisions?.[event.id] ?? currentRevisions[event.id] ?? -1;
    if (event.revision <= known) continue;
    revisions ??= { ...currentRevisions };
    revisions[event.id] = event.revision;
    if (projects) {
      const index = projects.findIndex((project) => project.id === event.id);
      if (event.kind === "delete") {
        if (index >= 0)
          projects = projects.filter((project) => project.id !== event.id);
      } else if (index < 0) {
        projects = [...projects, event.item];
      } else if (!wireValueEqual(projects[index], event.item)) {
        const next = projects.slice();
        next[index] = event.item;
        projects = next;
      }
    }
    const detail = projectDetails[event.id];
    const detailRevision = state.projectDetailRevisions[event.id] ?? -1;
    if (detail && dataOf(detail) && event.revision > detailRevision) {
      if (projectDetails === state.projectDetails)
        projectDetails = { ...state.projectDetails };
      projectDetails[event.id] = beginLoad(detail!);
    }
  }
  if (!revisions) return state;
  const projectList =
    state.projectList && projects && projects !== state.projectList.projects
      ? { ...state.projectList, projects }
      : state.projectList;
  return {
    ...state,
    projectList,
    projectDetails,
    stateEventRevisions: {
      ...state.stateEventRevisions,
      projects: revisions,
    },
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
 * Adopt the mutator's direct reply to `saveTask`.
 *
 * Two jobs the broadcast event cannot do. The full `item` becomes the cached
 * body, so a detail view never pays a refetch for the Task it just saved. And a
 * create SETTLES: the server has never heard of the browser-local temp id, so
 * an upsert event alone would leave the optimistic row beside the real one
 * forever. The temp row is replaced in place with the shared summary projection
 * — the same narrowing the server broadcasts — so the echo that follows finds an
 * equal row and keeps its identity.
 */
function applyTaskSaved(
  state: UIState,
  item: TaskItem,
  tempId?: string,
): UIState {
  const list = state.taskList;
  const summary = taskSummaryOf(item);
  let taskList = list;
  // A filtered list is left to the server: an item that no longer matches its
  // predicate must not be inserted into a view it does not belong in.
  if (list && canOptimisticallyUpdateTaskList(list)) {
    const index = list.items.findIndex(
      (row) => row.id === tempId || row.id === item.id,
    );
    const items = list.items.slice();
    if (index >= 0) items[index] = summary;
    else items.unshift(summary);
    if (index < 0 || !wireValueEqual(list.items[index], summary))
      taskList = { ...list, items };
  }
  const detailLru = touchLru(state.taskDetailsLru, item.id);
  const detailCache = pruneProjectionCache(
    { ...state.taskDetails, [item.id]: ready(item) },
    detailLru,
    state.taskMutations,
    state.openTaskProjectionId,
  );
  return {
    ...state,
    taskList,
    taskDetails: detailCache.cache,
    taskDetailsLru: detailCache.lru,
    error: null,
  };
}

function taskCommentOf(thread: CommentThread): TaskComment {
  return {
    id: thread.root.id,
    taskId: thread.target.kind === "task" ? thread.target.taskId : "",
    author: thread.root.author,
    body: thread.root.body,
    createdAt: thread.root.createdAt,
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
    default:
      return undefined;
  }
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
  if (action.kind === "taskRecoveryItems") {
    const revisions = { ...(state.stateEventRevisions.tasks ?? {}) };
    for (const event of action.events) delete revisions[event.id];
    const recovered = applyEvent(
      {
        ...state,
        stateEventRevisions: {
          ...state.stateEventRevisions,
          tasks: revisions,
        },
      },
      { type: "stateEvents", topic: "tasks", seq: 0, events: action.events },
    );
    const pullRequestCards = reconcilePullRequestCardTaskRecovery(
      recovered.pullRequestCards,
      action.events,
    );
    return pullRequestCards === recovered.pullRequestCards
      ? recovered
      : withChat(recovered, { pullRequestCards });
  }
  if (action.kind === "projectRecoveryItems") {
    const revisions = { ...(state.stateEventRevisions.projects ?? {}) };
    for (const event of action.events) delete revisions[event.id];
    return applyProjectEvent(
      {
        ...state,
        stateEventRevisions: {
          ...state.stateEventRevisions,
          projects: revisions,
        },
      },
      { type: "stateEvents", topic: "projects", seq: 0, events: action.events },
    );
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
      ...state,
      sessions: applyOptimisticSessionRename(
        state.sessions,
        action.sessionId,
        action.title,
        action.now,
      ),
      error: null,
    };
  }
  if (action.kind === "optimisticSpawnOwnership") {
    return {
      ...state,
      sessions: state.sessions.map((session) =>
        session.id === action.sessionId && session.spawnedBySessionId
          ? { ...session, spawnOwnership: action.ownership }
          : session,
      ),
      error: null,
    };
  }
  if (action.kind === "optimisticSessionSettle") {
    let sessions = applyOptimisticSessionSettle(
      state.sessions,
      action.sessionId,
      action.settled,
      action.now,
    );
    // A peer already down keeps its settled time, as the server's cascade
    // does, so it does not jump to the top of the shelf until the list lands.
    const alreadySettled = new Set(
      sessions
        .filter((session) => session.settledAt !== undefined)
        .map((session) => session.id),
    );
    for (const sessionId of action.peerSessionIds)
      if (!alreadySettled.has(sessionId))
        sessions = applyOptimisticSessionSettle(
          sessions,
          sessionId,
          true,
          action.now,
        );
    return { ...state, sessions, error: null };
  }
  if (action.kind === "optimisticWorkflowRunSettle") {
    let sessions = state.sessions;
    for (const sessionId of action.sessionIds)
      sessions = applyOptimisticSessionSettle(
        sessions,
        sessionId,
        true,
        action.now,
      );
    return {
      ...state,
      sessions,
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
  if (action.kind === "optimisticSessionDelete") {
    return {
      ...state,
      sessions: state.sessions.filter(
        (session) => session.id !== action.sessionId,
      ),
      error: null,
    };
  }
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
  if (action.kind === "skillLibraryLoad") {
    // Same query, so rows already on screen stay put and only the refresh
    // indicator changes; a first visit has nothing to keep and plainly loads.
    return { ...state, skillLibrary: beginLoad(state.skillLibrary) };
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
      content: [{ type: "text", text: action.text }],
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
    return applyTaskSaved(state, action.item, action.tempId);
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
  if (action.kind === "taskDetailResult") {
    const current = state.taskDetails[action.id] ?? idle<TaskItem | null>();
    const next = action.error
      ? failFrom(current, action.error)
      : ready(action.item);
    const lru = touchLru(state.taskDetailsLru, action.id);
    const projection = pruneProjectionCache(
      { ...state.taskDetails, [action.id]: next },
      lru,
      state.taskMutations,
      state.openTaskProjectionId,
    );
    return {
      ...state,
      taskDetails: projection.cache,
      taskDetailsLru: projection.lru,
    };
  }
  if (action.kind === "unwatchComments") {
    const key = commentTargetKey(action.target);
    const comments = { ...state.comments };
    const commentTargets = { ...state.commentTargets };
    const commentRevisions = { ...state.commentRevisions };
    delete comments[key];
    delete commentTargets[key];
    delete commentRevisions[key];
    if (action.target.kind === "task") {
      const taskId = action.target.taskId;
      const taskComments = { ...state.taskComments };
      delete taskComments[taskId];
      return {
        ...state,
        comments,
        commentTargets,
        commentRevisions,
        taskComments,
        taskCommentsLru: state.taskCommentsLru.filter((id) => id !== taskId),
      };
    }
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
  if (action.kind === "taskCommentsLoad") {
    const current = state.taskComments[action.taskId] ?? idle<TaskComment[]>();
    return {
      ...state,
      taskComments: {
        ...state.taskComments,
        [action.taskId]: beginLoad(current),
      },
      taskCommentsLru: touchLru(state.taskCommentsLru, action.taskId),
    };
  }
  if (action.kind === "taskCommentsResult") {
    const current = state.taskComments[action.taskId] ?? idle<TaskComment[]>();
    const next = action.error
      ? failFrom(current, action.error)
      : ready(action.comments);
    const lru = touchLru(state.taskCommentsLru, action.taskId);
    const projection = pruneProjectionCache(
      { ...state.taskComments, [action.taskId]: next },
      lru,
      state.taskMutations,
      state.openTaskProjectionId,
    );
    return {
      ...state,
      taskComments: projection.cache,
      taskCommentsLru: projection.lru,
    };
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
      taskListFresh: action.connected ? state.taskListFresh : false,
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
          sessions: msg.sessions,
          // This step, and only this step: the list it installs is the
          // server's answer for the episode that just opened.
          sessionListFresh: true,
          archivedSessionCount:
            msg.archivedSessionCount ??
            msg.sessions.filter((session) => session.archived).length,
          archivedSessionsLoaded: msg.archivedSessionsLoaded === true,
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
          peerPromptHistoryExpanded: null,
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
          peerPromptHistoryExpanded: null,
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
    case "permanentAssistantOpened": {
      // The Assistant session chat arrived via the transport `snapshot` (from the
      // server's view() switch just before this message); swap in the session
      // shell while the dedicated `/assistant` route remains stable even when
      // the singleton has no messages yet.
      return withChat(
        {
          ...state,
          sessions: mergeSessionList(state.sessions, msg.sessions, false),
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
    case "slackHuddleStatus":
      return {
        ...state,
        settings: msg.settings,
        slackHuddleStatus: msg.status,
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
    case "sessions": {
      // The session list reaches every connection (not just the session's
      // viewers), but the viewed chat's runState is owned by the runtime snapshot
      // and ordered runtime events. Treat list rows as sidebar metadata only.
      const nextSessions = mergeSessionList(
        state.sessions,
        msg.sessions,
        msg.archivedSessionsLoaded === true,
      );
      const archivedSessionCount =
        msg.archivedSessionCount ??
        nextSessions.filter((session) => session.archived).length;
      const archivedSessionsLoaded =
        state.archivedSessionsLoaded || msg.archivedSessionsLoaded === true;
      return {
        ...state,
        sessions: nextSessions,
        archivedSessionCount,
        archivedSessionsLoaded,
      };
    }
    case "sessionUpdated": {
      const nextSessions = upsertSessionListItem(state.sessions, msg.session);
      return { ...state, sessions: nextSessions };
    }
    case "objectLinksResolved":
      return {
        ...state,
        objectLinks: mergeObjectLinks(state.objectLinks, msg.links),
      };
    case "subagentThreadRunSnapshot": {
      const revisions = taskDigestRecord(msg.revisions) ?? {};
      return {
        ...state,
        subagentRunDetails: {
          ...state.subagentRunDetails,
          [msg.threadId]: { detail: msg.detail, revisions, seq: msg.seq },
        },
      };
    }
    case "subagentRunEvents":
      return applySubagentRunEvents(state, msg.threadId, msg.events, msg.seq);
    case "subagentRunItems":
      return applySubagentRunEvents(
        state,
        msg.threadId,
        msg.events,
        state.subagentRunDetails[msg.threadId]?.seq ?? 0,
      );
    case "subagentRunDigest": {
      const held = state.subagentRunDetails[msg.threadId];
      const revisions = taskDigestRecord(msg.entries);
      if (!held || !revisions) return state;
      const liveIds = new Set(msg.entries.map((entry) => entry.id));
      const runs = held.detail.runs.filter((run) => liveIds.has(run.id));
      const keptRevisions: Record<string, number> = {};
      for (const entry of msg.entries) {
        if (held.revisions[entry.id] !== undefined)
          keptRevisions[entry.id] = held.revisions[entry.id]!;
      }
      return {
        ...state,
        subagentRunDetails: {
          ...state.subagentRunDetails,
          [msg.threadId]: {
            ...held,
            detail:
              runs.length === held.detail.runs.length
                ? held.detail
                : { ...held.detail, runs },
            revisions: keptRevisions,
            seq: msg.seq,
          },
        },
      };
    }
    case "stateEvents":
      return applyEvent(state, msg);
    case "stateDigest":
      return msg.topic === "tasks"
        ? applyTaskDigest(state, msg)
        : msg.topic === "projects"
          ? applyProjectDigest(state, msg)
          : state;
    case "stateItems": {
      const applied =
        msg.topic === "tasks"
          ? applyEvent(state, {
              type: "stateEvents",
              topic: "tasks",
              seq: 0,
              events: msg.events,
            })
          : applyEvent(state, {
              type: "stateEvents",
              topic: "projects",
              seq: 0,
              events: msg.events,
            });
      return {
        ...applied,
        ...(msg.topic === "tasks"
          ? { taskListFresh: true, taskListError: null }
          : { projectListFresh: true, projectListError: null }),
        error: null,
      };
    }
    case "backgroundWorkList": {
      const revisions = taskDigestRecord(msg.revisions);
      return {
        ...state,
        backgroundWorkItems: msg.items,
        backgroundWorkTruncated: msg.truncated === true,
        stateEventRevisions: {
          ...state.stateEventRevisions,
          background: revisions ?? {},
        },
      };
    }
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
    case "subagentThreadList": {
      const revisions = taskDigestRecord(msg.revisions);
      return {
        ...state,
        subagentThreads: msg.threads,
        stateEventRevisions: {
          ...state.stateEventRevisions,
          subagents: revisions ?? {},
        },
      };
    }
    case "taskList": {
      const taskList = reconcileTaskList(state.taskList, msg.list);
      const revisionRecord = taskDigestRecord(msg.revisions);
      const revisions =
        isCacheableTaskList(taskList) &&
        revisionRecord &&
        taskListHasRevisionSidecar(taskList, revisionRecord)
          ? revisionRecord
          : {};
      return {
        ...state,
        taskList,
        taskListFresh: true,
        taskListError: null,
        stateEventRevisions: { ...state.stateEventRevisions, tasks: revisions },
        taskDetails: reconcileTaskDetails(state.taskDetails, taskList.items),
        error: null,
      };
    }
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
    case "projectList": {
      // Filtered reads are independent projections and never own the canonical
      // reducer/cache slot.
      if (!isCanonicalProjectList(msg.list)) return state;
      const projectList = reconcileProjectList(state.projectList, msg.list);
      const revisionRecord = taskDigestRecord(msg.revisions);
      const revisions =
        revisionRecord &&
        projectListHasRevisionSidecar(projectList, revisionRecord)
          ? revisionRecord
          : {};
      return {
        ...state,
        projectList,
        projectListFresh: true,
        projectListError: null,
        stateEventRevisions: {
          ...state.stateEventRevisions,
          projects: revisions,
        },
        error: null,
      };
    }
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
    case "skillList":
      // A failed scan keeps the last good library beside its error (R2); it
      // never becomes an empty library, which would be a claim about authored
      // content that this message cannot make.
      return {
        ...state,
        skillLibrary: msg.list
          ? ready(msg.list)
          : failFrom(
              state.skillLibrary,
              msg.error ?? "Failed to read the skills library.",
            ),
      };
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
      if (msg.target.kind === "task") {
        const taskId = msg.target.taskId;
        const current = state.taskComments[taskId] ?? idle<TaskComment[]>();
        const next = msg.error
          ? failFrom(current, msg.error)
          : ready(msg.threads.map(taskCommentOf));
        const lru = touchLru(state.taskCommentsLru, taskId);
        const projection = pruneProjectionCache(
          { ...state.taskComments, [taskId]: next },
          lru,
          state.taskMutations,
          state.openTaskProjectionId,
        );
        return {
          ...state,
          comments,
          commentTargets,
          commentRevisions,
          taskComments: projection.cache,
          taskCommentsLru: projection.lru,
        };
      }
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
      if (msg.target.kind === "task") {
        const taskId = msg.target.taskId;
        return {
          ...state,
          comments,
          commentTargets,
          commentRevisions,
          taskComments: {
            ...state.taskComments,
            [taskId]: ready(threads.map(taskCommentOf)),
          },
          taskCommentsLru: touchLru(state.taskCommentsLru, taskId),
        };
      }
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
      return applyTaskSaved(state, msg.item);
    case "taskDetail": {
      const current = state.taskDetails[msg.id] ?? idle<TaskItem | null>();
      const next = msg.error ? failFrom(current, msg.error) : ready(msg.item);
      const lru = touchLru(state.taskDetailsLru, msg.id);
      const projection = pruneProjectionCache(
        { ...state.taskDetails, [msg.id]: next },
        lru,
        state.taskMutations,
        state.openTaskProjectionId,
      );
      return {
        ...state,
        taskDetails: projection.cache,
        taskDetailsLru: projection.lru,
      };
    }
    case "forkedSession": {
      // The new session's chat arrived via the transport `snapshot` (sent by the
      // server's view() switch just before this message); we only update session
      // shell + navigation here, preserving that timeline.
      const token = Date.now();
      return withChat(
        {
          ...state,
          sessions: mergeSessionList(state.sessions, msg.sessions, false),
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
          sessions: mergeSessionList(state.sessions, msg.sessions, false),
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
    case "approvalGrants":
      if (msg.sessionId !== state.session?.sessionId) return state;
      return {
        ...state,
        approvalGrants: { sessionId: msg.sessionId, grants: msg.grants },
      };
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
          msg.queue.items.length > 0
            ? { ...rest, promptQueue: msg.queue }
            : rest,
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
          },
        },
      };
    case "peerPromptHistoryExpanded":
      if (msg.sessionId !== state.session?.sessionId) return state;
      // The expanded projection can carry states for messages older than the
      // default bounded snapshot; merge it into the overlay too (not just the
      // separate Peer prompts section list), so explicitly loading more
      // history also reconciles any stale, already-rendered transcript cards.
      return {
        ...state,
        peerPromptHistoryExpanded: msg.projection,
        peerPromptCardOverrides: {
          ...state.peerPromptCardOverrides,
          ...seedPeerPromptCardOverridesFromHistory(msg.projection),
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
  credentialProfileId?: string;
  attachTaskId?: string;
  projectId?: string;
  worktreeId?: string;
  /** "+ New worktree": provision one in this project before creating the session. */
  createWorktreeInProjectId?: string;
  /** A document staged as context, as its canonical viewer route. */
  fileContext?: string;
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
   * Settle a formal Workflow Run out of the Sessions inbox (Task-677): the
   * command acknowledges `throughRevision` — the attention revision the
   * CLICKED item rendered, captured by the caller at the click — and the
   * server settles the run's role sessions with it.
   */
  settleWorkflowRun: (runId: string, throughRevision: number) => void;
  renameSession: (id: string, title: string) => void;
  /**
   * Take a spawned peer over, or hand it back to the coordinator that spawned
   * it — the user's explicit word on ownership; messaging a peer never moves
   * it. Optimistic, like a Settle: the inbox re-folds at once, and a refusal
   * (carrying this requestId) triggers the recovery refetch.
   */
  setSpawnOwnership: (id: string, ownership: SettableSpawnOwnership) => void;
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
  saveAndTestSlackHuddleSettings: (patch: SlackSettingsPatch) => void;
  testSlackHuddleSettings: () => void;
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
  /** Pin/unpin the Task route's keyed body/activity entries in their LRU caches. */
  setOpenTaskProjection: (id: string | null) => void;
  /** Request the full task body for the Task surface; same-id reads are correlated. */
  requestTaskDetail: (id: string) => void;
  reorderTasks: (
    orderedIds: string[],
    placements?: { id: string; parentId?: string | null }[],
  ) => void;
  cancelPostReloadContinuation: () => void;
  /** Explicit expansion of the current session's bounded Peer prompts history. */
  requestPeerPromptHistory: (limit?: number) => void;
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
  ) => void;
  /** Withdraw one of a session's "Approve for session" grants. */
  revokeApprovalGrant: (sessionId: string, key: string) => void;
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
  /** Fetch/watch a Task's authoritative activity-trace comments. */
  listTaskComments: (taskId: string) => void;
  /** Stop broadcasts and drop the closed Task's comment projection. */
  unwatchTaskComments: (taskId: string) => void;
  /** Append a correlated user comment to a Task's activity trace. */
  addTaskComment: (input: { taskId: string; body: string }) => void;
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
          credentialProfileId?: string;
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
  /** Last `seq` seen per topic — the gap tripwire, never a replay cursor. */
  const topicSeqRef = useRef<Partial<Record<BroadcastTopic, number>>>({});
  /** Last seq per held thread-detail topic; gaps trigger a fresh bounded snapshot. */
  const subagentRunSeqRef = useRef<Record<string, number>>({});
  /**
   * Optimistic mutations still waiting for their own outcome, keyed by the
   * `requestId` the command carried. Correlation is explicit because these
   * domains also receive UNSOLICITED authoritative broadcasts (an agent editing
   * a Task, another tab saving a project): resolving against "the next list
   * that arrives" consumed the wrong snapshot and left a genuine failure with
   * nothing to restore.
   */
  const pendingMutationsRef = useRef(new Map<string, TrackedPendingMutation>());
  /** Correlates card-local pending/error state with the generic mutation channel. */
  const pullRequestCardMutationRequestsRef = useRef(
    new Map<
      string,
      {
        cardId: string;
        action: PullRequestCardAction;
        /** The server has dequeued this action, so the card speaks for it. */
        serverBusySeen: boolean;
        outcomeSeen: boolean;
        settledSeen: boolean;
        /** A different actor currently owns the durable action gate. */
        competingActionSeen: boolean;
        /** Its raw server card, before local linked-Task preservation. */
        competingCard?: PullRequestCard;
      }
    >(),
  );
  /**
   * Correlates a Workflow card's delivery click with the generic mutation
   * channel: which run is waiting on which answer, and how far that answer has
   * got. The run list is the authoritative outcome here — the server
   * re-broadcasts it whether the action lands or is refused — so the two flags
   * only decide WHEN the click may stop claiming the control, never what the
   * control says afterwards.
   */
  const workflowDeliveryRequestsRef = useRef(
    new Map<
      string,
      {
        runId: string;
        /** The command's handler resolved; its broadcast may still be in flight. */
        settledSeen: boolean;
      }
    >(),
  );
  /** Latest in-flight keyed reads; a superseded same-id answer is ignored. */
  const taskDetailRequestsRef = useRef(new Map<string, string>());
  const projectDetailRequestsRef = useRef(new Map<string, string>());
  const taskCommentRequestsRef = useRef(new Map<string, string>());
  /** Latest list generation for every comment target. */
  const commentRequestsRef = useRef(new Map<string, string>());
  /** Immediate surface ownership, independent of asynchronous reducer updates. */
  const heldCommentTargetsRef = useRef(new Map<string, CommentTarget>());
  /** Per-target reconnect snapshots already requested by the socket episode. */
  const commentResyncRef = useRef(new Set<string>());
  /** Correlates the generic mutation outcome channel to one Task control. */
  const taskMutationRequestsRef = useRef(new Map<string, string>());
  const projectMutationRequestsRef = useRef(new Map<string, string>());
  /** One in-flight targeted catch-up for the latest Task digest. */
  const taskDigestSyncRef = useRef<TaskDigestSync | null>(null);
  const projectDigestSyncRef = useRef<TaskDigestSync | null>(null);
  const subagentRunDigestSyncRef = useRef(
    new Map<string, SubagentRunDigestSync>(),
  );
  /** Explicit per-mutation item recoveries, independent of digest catch-up. */
  const taskRecoveryItemsRef = useRef(new Map<string, ReadonlySet<string>>());
  const projectRecoveryItemsRef = useRef(
    new Map<string, ReadonlySet<string>>(),
  );
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
    if (pendingMutationsRef.current.size > 0) return;
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
    // Held as a local so the cleanup clears the map this episode used. The ref
    // is never reassigned, so this is the same object either way — but reading
    // `.current` from a cleanup is the shape that silently stops being true.
    const taskRecoveryItems = taskRecoveryItemsRef.current;
    const projectRecoveryItems = projectRecoveryItemsRef.current;
    let disposed = false;
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

    const clearDigestSync = (topic: "tasks" | "projects") => {
      const ref = topic === "tasks" ? taskDigestSyncRef : projectDigestSyncRef;
      const sync = ref.current;
      if (sync) clearTimeout(sync.timer);
      ref.current = null;
    };
    const clearTaskDigestSync = () => clearDigestSync("tasks");
    const clearSubagentRunDigestSync = (threadId: string) => {
      const sync = subagentRunDigestSyncRef.current.get(threadId);
      if (sync) clearTimeout(sync.timer);
      subagentRunDigestSyncRef.current.delete(threadId);
    };
    const resubscribeSubagentRun = (threadId: string, reason: string) => {
      clearSubagentRunDigestSync(threadId);
      console.warn(`[state-sync] subagent run ${threadId} resync: ${reason}`);
      socket.send({ type: "subscribeSubagentThread", threadId });
    };
    const fallbackFromDigest = (
      topic: "tasks" | "projects",
      reason: string,
    ) => {
      clearDigestSync(topic);
      console.warn(`[state-sync] ${topic} digest fallback: ${reason}`);
      socket.send(
        topic === "tasks"
          ? { type: "listTasks", request: {} }
          : { type: "listProjects", request: { includeArchived: true } },
      );
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
          if (recordWebBuild(window.localStorage, incomingWebBuildId)) {
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
      if (msg.type === "taskList") {
        clearTaskDigestSync();
        topicSeqRef.current.tasks = msg.seq;
      }
      if (msg.type === "projectList" && isCanonicalProjectList(msg.list)) {
        clearDigestSync("projects");
        topicSeqRef.current.projects = msg.seq;
      }
      if (msg.type === "backgroundWorkList") {
        topicSeqRef.current.background = msg.seq;
      }
      if (msg.type === "subagentThreadList") {
        // A snapshot is the authoritative tripwire baseline, including after a
        // gap resubscribe and on a cold subscribe.
        topicSeqRef.current.subagents = msg.seq;
      }
      if (msg.type === "subagentThreadRunSnapshot") {
        subagentRunSeqRef.current[msg.threadId] = msg.seq;
      }
      if (msg.type === "subagentRunDigest") {
        subagentRunSeqRef.current[msg.threadId] = msg.seq;
      }
      if (msg.type === "subagentRunEvents") {
        const previous = subagentRunSeqRef.current[msg.threadId];
        if (previous !== undefined && msg.seq !== previous + 1) {
          console.warn(
            `[state-sync] subagent run topic ${msg.threadId} sequence gap: expected ${previous + 1}, got ${msg.seq}; resubscribing`,
          );
          socket.send({
            type: "subscribeSubagentThread",
            threadId: msg.threadId,
          });
          return;
        }
        subagentRunSeqRef.current[msg.threadId] = msg.seq;
      }
      if (msg.type === "stateDigest") {
        clearDigestSync(msg.topic);
        topicSeqRef.current[msg.topic] = msg.seq;
        const changedIds =
          msg.topic === "tasks"
            ? changedTaskIdsForDigest(stateRef.current, msg)
            : changedProjectIdsForDigest(stateRef.current, msg);
        if (!changedIds) {
          fallbackFromDigest(
            msg.topic,
            "cached objects or revisions were invalid",
          );
          return;
        }
        if (changedIds.length > 0) {
          const requestId = createClientId();
          const expectedIds = new Set(changedIds);
          const timer = setTimeout(
            () =>
              fallbackFromDigest(msg.topic, "targeted item fetch timed out"),
            TASK_DIGEST_TIMEOUT_MS,
          );
          const ref =
            msg.topic === "tasks" ? taskDigestSyncRef : projectDigestSyncRef;
          ref.current = { requestId, expectedIds, timer };
          socket.send({
            type: "getStateItems",
            topic: msg.topic,
            ids: changedIds,
            requestId,
          });
        }
      }
      if (msg.type === "subagentRunDigest") {
        const held = stateRef.current.subagentRunDetails[msg.threadId];
        const digest = taskDigestRecord(msg.entries);
        if (!held || !digest) {
          resubscribeSubagentRun(
            msg.threadId,
            "cached detail or revisions were invalid",
          );
          return;
        }
        const knownIds = new Set(held.detail.runs.map((run) => run.id));
        const changedIds = msg.entries
          .filter(
            (entry) =>
              !knownIds.has(entry.id) ||
              held.revisions[entry.id] !== entry.revision,
          )
          .map((entry) => entry.id);
        if (changedIds.length > 0) {
          clearSubagentRunDigestSync(msg.threadId);
          const requestId = createClientId();
          const expectedIds = new Set(changedIds);
          const timer = setTimeout(
            () =>
              resubscribeSubagentRun(
                msg.threadId,
                "targeted run item fetch timed out",
              ),
            TASK_DIGEST_TIMEOUT_MS,
          );
          subagentRunDigestSyncRef.current.set(msg.threadId, {
            threadId: msg.threadId,
            requestId,
            expectedIds,
            timer,
          });
          socket.send({
            type: "getSubagentRunItems",
            threadId: msg.threadId,
            ids: changedIds,
            requestId,
          });
        }
      }
      if (msg.type === "subagentRunItems") {
        const sync = subagentRunDigestSyncRef.current.get(msg.threadId);
        if (!sync || sync.requestId !== msg.requestId) return;
        const receivedIds = new Set(msg.events.map((event) => event.id));
        const complete =
          receivedIds.size === msg.events.length &&
          receivedIds.size === sync.expectedIds.size &&
          [...sync.expectedIds].every((id) => receivedIds.has(id));
        if (!complete) {
          resubscribeSubagentRun(
            msg.threadId,
            "targeted run item response was incomplete",
          );
          return;
        }
        clearSubagentRunDigestSync(msg.threadId);
      }
      if (msg.type === "stateItems") {
        const receivedIds = new Set(msg.events.map((event) => event.id));
        const complete = (expectedIds: ReadonlySet<string>) =>
          receivedIds.size === msg.events.length &&
          receivedIds.size === expectedIds.size &&
          [...expectedIds].every((id) => receivedIds.has(id));
        const taskRecoveryIds =
          msg.topic === "tasks"
            ? taskRecoveryItemsRef.current.get(msg.requestId)
            : undefined;
        if (taskRecoveryIds) {
          if (msg.topic !== "tasks") return;
          taskRecoveryItemsRef.current.delete(msg.requestId);
          if (!complete(taskRecoveryIds)) {
            socket.send({ type: "listTasks", request: {} });
            return;
          }
          dispatch({ kind: "taskRecoveryItems", events: msg.events });
          return;
        }
        const projectRecoveryIds =
          msg.topic === "projects"
            ? projectRecoveryItemsRef.current.get(msg.requestId)
            : undefined;
        if (projectRecoveryIds) {
          if (msg.topic !== "projects") return;
          projectRecoveryItemsRef.current.delete(msg.requestId);
          if (!complete(projectRecoveryIds)) return;
          dispatch({ kind: "projectRecoveryItems", events: msg.events });
          return;
        } else {
          const ref =
            msg.topic === "tasks" ? taskDigestSyncRef : projectDigestSyncRef;
          const sync = ref.current;
          if (!sync || msg.requestId !== sync.requestId) return;
          if (!complete(sync.expectedIds)) {
            fallbackFromDigest(
              msg.topic,
              "targeted item response was incomplete",
            );
            return;
          }
          clearDigestSync(msg.topic);
        }
      }
      if (
        msg.type === "error" &&
        msg.requestId &&
        taskRecoveryItemsRef.current.has(msg.requestId)
      ) {
        // A targeted authoritative restore that itself fails degrades to the
        // existing full Task read; the original mutation failure already has
        // its inline home on the card.
        taskRecoveryItemsRef.current.delete(msg.requestId);
        socket.send({ type: "listTasks", request: {} });
        return;
      }
      // Only the failure OF the in-flight digest catch-up falls back to a full
      // list read. The sync has to exist for that: an ordinary chat error
      // carries no requestId, and comparing it against `…current?.requestId`
      // with no sync in flight matched undefined to undefined — which swallowed
      // every unaddressed error before the reducer could show it, and re-read
      // the Task list for it.
      const digestTopic = (["tasks", "projects"] as const).find((topic) => {
        const sync =
          topic === "tasks"
            ? taskDigestSyncRef.current
            : projectDigestSyncRef.current;
        return sync && msg.type === "error" && msg.requestId === sync.requestId;
      });
      if (msg.type === "error" && digestTopic) {
        fallbackFromDigest(digestTopic, msg.message);
        return;
      }
      const subagentDigest = [
        ...subagentRunDigestSyncRef.current.values(),
      ].find(
        (sync) => msg.type === "error" && msg.requestId === sync.requestId,
      );
      if (msg.type === "error" && subagentDigest) {
        resubscribeSubagentRun(subagentDigest.threadId, msg.message);
        return;
      }
      if (msg.type === "taskDetail" && msg.requestId) {
        if (taskDetailRequestsRef.current.get(msg.id) !== msg.requestId) return;
        taskDetailRequestsRef.current.delete(msg.id);
        dispatch({
          kind: "taskDetailResult",
          id: msg.id,
          item: msg.item,
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
      if (msg.type === "projectSaved") {
        dispatch({
          kind: "projectSaved",
          item: msg.item,
          revision: msg.revision,
        });
        return;
      }
      if (
        msg.type === "commentsSnapshot" &&
        msg.target.kind === "task" &&
        msg.requestId
      ) {
        const taskId = msg.target.taskId;
        if (taskCommentRequestsRef.current.get(taskId) !== msg.requestId)
          return;
        taskCommentRequestsRef.current.delete(taskId);
        dispatch({ kind: "server", msg });
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
        for (const [requestId, pending] of [
          ...workflowDeliveryRequestsRef.current,
        ]) {
          const busy =
            msg.cards[pending.runId]?.pullRequest?.delivery?.busyAction;
          if (!busy && !pending.settledSeen) continue;
          workflowDeliveryRequestsRef.current.delete(requestId);
          // Answered either way, so the tracked mutation must stop counting
          // down towards "the server never replied".
          settleMutation(pendingMutationsRef.current, requestId);
          // A stated action already drops the overlay in the reducer; only the
          // settled-but-idle case still has a claim to retire.
          if (!busy)
            dispatch({ kind: "workflowDeliveryResult", runId: pending.runId });
        }
      if (msg.type === "pullRequestCardUpdate") {
        const entry = [...pullRequestCardMutationRequestsRef.current].find(
          ([, pending]) => pending.cardId === msg.card.id,
        );
        if (entry) {
          const [requestId, pending] = entry;
          if (msg.card.busyAction === pending.action) {
            // This click eventually acquired the gate after any earlier actor.
            // From here, an older competing snapshot must never settle it.
            pending.serverBusySeen = true;
            pending.competingActionSeen = false;
            delete pending.competingCard;
          } else if (msg.card.busyAction) {
            if (pending.serverBusySeen) {
              // A later action can own the gate only after this one finished;
              // it is newer authoritative state, not evidence this click lost.
              pending.outcomeSeen = true;
            } else {
              pending.competingActionSeen = true;
              pending.competingCard = msg.card;
            }
          }
          // Only the server's own dequeue proves the card's action fields
          // describe THIS action: that write is what clears the previous
          // outcome (`pullRequestActions.ts`). Until it lands, a routine watcher
          // patch still carries the old `actionError`/`actionMessage` — and a
          // newer `updatedAt`, which the watcher bumps on every poll — so
          // consuming either would revert valid optimism and re-surface an
          // answered refusal while the action is still running. Once the busy
          // flag has been seen, its CLEARING is the outcome, whatever fields
          // come with it: an action whose result changes no card field must
          // settle too.
          else if (pending.serverBusySeen && !msg.card.busyAction)
            pending.outcomeSeen = true;
          if (
            pending.outcomeSeen &&
            (msg.card.actionError || pending.settledSeen)
          ) {
            // Card actions keep refusals on the durable card rather than
            // emitting a second generic error. Its authoritative outcome is
            // also the signal to restore this tab's optimistic domain effects.
            pullRequestCardMutationRequestsRef.current.delete(requestId);
            const mutation = settleMutation(
              pendingMutationsRef.current,
              requestId,
            );
            if (msg.card.actionError) mutation?.recover(mutation);
            dispatch({
              kind: "pullRequestCardActionResult",
              cardId: pending.cardId,
              ...(msg.card.actionError ? { error: msg.card.actionError } : {}),
            });
          } else if (pending.settledSeen && pending.competingActionSeen) {
            // Another actor won the server's durable action gate. This click
            // settled without running, so its domain optimism must not stand.
            // Remembering the busy echo makes this converge even when the
            // card update precedes mutationSettled.
            pullRequestCardMutationRequestsRef.current.delete(requestId);
            const mutation = settleMutation(
              pendingMutationsRef.current,
              requestId,
            );
            mutation?.recover(mutation);
            dispatch({
              kind: "pullRequestCardActionResult",
              cardId: pending.cardId,
              ...(pending.competingCard
                ? { authoritativeCard: pending.competingCard }
                : {}),
            });
          }
        }
      }
      if (msg.type === "mutationSettled") {
        // Card broadcasts are best-effort async sends and can follow this
        // generic settle. Keep their recovery alive until the matching durable
        // outcome arrives; a timeout remains the final backstop.
        const pullRequest = pullRequestCardMutationRequestsRef.current.get(
          msg.requestId,
        );
        if (pullRequest) {
          pullRequest.settledSeen = true;
          if (pullRequest.outcomeSeen || pullRequest.competingActionSeen) {
            pullRequestCardMutationRequestsRef.current.delete(msg.requestId);
            const mutation = settleMutation(
              pendingMutationsRef.current,
              msg.requestId,
            );
            if (pullRequest.competingActionSeen) mutation?.recover(mutation);
            dispatch({
              kind: "pullRequestCardActionResult",
              cardId: pullRequest.cardId,
              ...(pullRequest.competingCard
                ? { authoritativeCard: pullRequest.competingCard }
                : {}),
            });
          }
        } else if (workflowDeliveryRequestsRef.current.has(msg.requestId)) {
          // A delivery action settles when its handler resolves, but the run
          // list stating what it CAME TO is an async broadcast that can follow
          // this message. Retiring the click here would hand the control back
          // for that gap: Merge offered again over a merged pull request, and
          // the previous action's failure re-exposed as if it were the answer.
          //
          // So the settle records itself and ASKS for the list rather than
          // waiting for one. That broadcast is best-effort (`void broadcast` in
          // `pullRequestCards.ts`, failures swallowed), so a click that waited
          // for it could wait for a message that was never sent — until the
          // deadline turned a finished merge into "the server did not answer".
          // A subscribe answers from the stores as they stand, which is the
          // same authority with none of the delivery risk; the resync is the
          // per-topic one a state-event gap uses. A surface no longer holding
          // the topic gets no list at all, so its click is simply released.
          workflowDeliveryRequestsRef.current.get(msg.requestId)!.settledSeen =
            true;
          if (topicsRef.current.has("workflow")) {
            socket.send({ type: "unsubscribe", topics: ["workflow"] });
            socket.send(
              taskSubscribeMessage(
                ["workflow"],
                stateRef.current,
                pendingMutationsRef.current,
              ),
            );
          } else {
            const pending = workflowDeliveryRequestsRef.current.get(
              msg.requestId,
            )!;
            workflowDeliveryRequestsRef.current.delete(msg.requestId);
            settleMutation(pendingMutationsRef.current, msg.requestId);
            dispatch({ kind: "workflowDeliveryResult", runId: pending.runId });
          }
        } else {
          settleMutation(pendingMutationsRef.current, msg.requestId);
        }
        // A skill write is answered HERE, not by its settings echo: the settle
        // is the only message that names the request, and by now that echo has
        // been applied (the server sends it first). A settle for anything else,
        // or for a write a later one has already superseded, changes nothing.
        dispatch({ kind: "skillTogglesAnswered", requestId: msg.requestId });
        const key = taskMutationRequestsRef.current.get(msg.requestId);
        if (key) {
          taskMutationRequestsRef.current.delete(msg.requestId);
          dispatch({ kind: "taskMutationResult", key });
        }
        const projectKey = projectMutationRequestsRef.current.get(
          msg.requestId,
        );
        if (projectKey) {
          projectMutationRequestsRef.current.delete(msg.requestId);
          dispatch({ kind: "projectMutationResult", key: projectKey });
        }
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
      // real read rather than a no-op behind the once-per-episode gate.
      if (msg.type === "error" && msg.target?.type === "task" && !msg.target.id)
        episodeListReadsRef.current.tasks = false;
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
        const mutation = settleMutation(
          pendingMutationsRef.current,
          msg.requestId,
        );
        mutation?.recover(mutation);
        const pullRequest = pullRequestCardMutationRequestsRef.current.get(
          msg.requestId,
        );
        if (pullRequest) {
          pullRequestCardMutationRequestsRef.current.delete(msg.requestId);
          dispatch({
            kind: "pullRequestCardActionResult",
            cardId: pullRequest.cardId,
            error: msg.message,
          });
          // The card is this failure's R5 home. If it is still on screen, do
          // not also turn the same refusal into the chat's global error. The
          // store holds cards the loaded window has not placed, so a row is
          // what counts (`loadedHistoryStart`).
          if (
            clientPullRequestCard(stateRef.current.messages, pullRequest.cardId)
          )
            return;
        }
        // A delivery refusal raised BEFORE the pull-request card was touched:
        // the server states it on the Task, because nothing else will, and the
        // announcement below is left to do that. Here the click only stops
        // owning the control — writing the same sentence onto the delivery
        // block as well would be the duplicate `docs/messaging.md` forbids.
        const delivery = workflowDeliveryRequestsRef.current.get(msg.requestId);
        if (delivery) {
          workflowDeliveryRequestsRef.current.delete(msg.requestId);
          dispatch({ kind: "workflowDeliveryResult", runId: delivery.runId });
        }
        const key = taskMutationRequestsRef.current.get(msg.requestId);
        if (key) {
          taskMutationRequestsRef.current.delete(msg.requestId);
          dispatch({ kind: "taskMutationResult", key, error: msg.message });
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
        const projectKey = projectMutationRequestsRef.current.get(
          msg.requestId,
        );
        if (projectKey) {
          projectMutationRequestsRef.current.delete(msg.requestId);
          controlOwned = true;
          dispatch({
            kind: "projectMutationResult",
            key: projectKey,
            error: msg.message,
          });
        }
      }
      if (msg.type === "taskSaved") {
        // The temp id lives in the pending queue, never on the wire: the server
        // has no idea a browser-local row exists, so only this correlation can
        // retire it (see `applyTaskSaved`).
        const tempId = msg.requestId
          ? pendingMutationsRef.current.get(msg.requestId)?.tempId
          : undefined;
        dispatch({
          kind: "taskSaved",
          item: msg.item,
          ...(tempId !== undefined ? { tempId } : {}),
        });
        return;
      }
      // The gap tripwire is transport bookkeeping, and it lives in a ref rather
      // than in reducer state on purpose: two batches can arrive before React
      // re-renders, and comparing both against the same rendered `seq` would
      // report a gap that never happened.
      if (msg.type === "stateEvents") {
        const previous = topicSeqRef.current[msg.topic];
        topicSeqRef.current[msg.topic] = msg.seq;
        // A batch that does not continue the last one means an event was missed
        // while subscribed. `seq` never replays anything — it resubscribes for a
        // fresh snapshot, loudly, because silence here is silent data loss.
        if (previous !== undefined && msg.seq !== previous + 1) {
          console.warn(
            `[state-sync] ${msg.topic} event gap: expected seq ${previous + 1}, got ${msg.seq}; resubscribing.`,
          );
          socket.send({ type: "unsubscribe", topics: [msg.topic] });
          socket.send(
            taskSubscribeMessage(
              [msg.topic],
              stateRef.current,
              pendingMutationsRef.current,
            ),
          );
        }
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
      announceArrival(msg, stateRef.current);
      dispatch({
        kind: "server",
        msg,
        ...(controlOwned ? { controlOwned } : {}),
      });
    });
    const offStatus = socket.onStatus((connected) => {
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
          if (topics.length > 0)
            socket.send(
              taskSubscribeMessage(
                topics,
                stateRef.current,
                pendingMutationsRef.current,
              ),
            );
          // The re-declared skills subscription re-scans on the server, and the
          // rows already on screen are the ones that scan may correct.
          if (topics.includes("skills")) dispatch({ kind: "skillLibraryLoad" });
          // Held run-detail topics are per connection too; a reconnect must
          // request a fresh bounded snapshot rather than wait for an event gap.
          for (const threadId of Object.keys(
            stateRef.current.subagentRunDetails,
          )) {
            socket.send({ type: "subscribeSubagentThread", threadId });
          }
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
        clearTaskDigestSync();
        clearDigestSync("projects");
        taskRecoveryItemsRef.current.clear();
        projectRecoveryItemsRef.current.clear();
        commentResyncRef.current.clear();
        commentRequestsRef.current.clear();
        // No run events can arrive while disconnected; the next snapshot is
        // the new sequence baseline.
        subagentRunSeqRef.current = {};
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
        for (const taskId of taskCommentRequestsRef.current.keys())
          dispatch({
            kind: "taskCommentsResult",
            taskId,
            comments: [],
            error: "Connection lost while loading Task activity.",
          });
        taskCommentRequestsRef.current.clear();
        // A delivery click belongs to the connection it was sent on: its
        // `mutationSettled` and any stamped refusal can only arrive there, and
        // the reconnect answers with a fresh run list instead. So the claim is
        // handed back now rather than left to a deadline that would eventually
        // write "the server did not answer" over an action that may well have
        // landed. The action itself is unaffected — it is the server's, and the
        // snapshot states it, `busyAction` included if it is still running.
        for (const [
          requestId,
          pending,
        ] of workflowDeliveryRequestsRef.current) {
          settleMutation(pendingMutationsRef.current, requestId);
          dispatch({ kind: "workflowDeliveryResult", runId: pending.runId });
        }
        workflowDeliveryRequestsRef.current.clear();
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
      clearTaskDigestSync();
      clearDigestSync("projects");
      taskRecoveryItems.clear();
      projectRecoveryItems.clear();
      for (const timer of lazyBlockRetryTimers) clearTimeout(timer);
      lazyBlockRetryTimers.clear();
      offMsg();
      offStatus();
      socket.dispose();
    };
  }, [socket]);

  const actions = useMemo<AssistantActions>(() => {
    const send = (msg: ClientMessage) => socketRef.current?.send(msg);
    /** Mint the id this mutation will be answered with, and hold its recovery. */
    const trackMutation = (
      mutation: PendingMutation,
      recover: (mutation: PendingMutation) => void,
      timeoutMs = MUTATION_SETTLE_TIMEOUT_MS,
    ): string => {
      const requestId = createClientId();
      const timer = setTimeout(() => {
        const pending = pendingMutationsRef.current.get(requestId);
        pendingMutationsRef.current.delete(requestId);
        pending?.recover(pending);
        const pullRequest =
          pullRequestCardMutationRequestsRef.current.get(requestId);
        if (pullRequest) {
          pullRequestCardMutationRequestsRef.current.delete(requestId);
          dispatch({
            kind: "pullRequestCardActionResult",
            cardId: pullRequest.cardId,
            error:
              "The server did not answer this pull request action. Try again.",
          });
        }
        // Only a click still WAITING says this. One the run list already
        // answered — the server stated the action, or its outcome landed — is
        // off the control, and a deadline reached long afterwards must not
        // write a failure over a card that has moved on.
        const delivery = workflowDeliveryRequestsRef.current.get(requestId);
        if (delivery) {
          workflowDeliveryRequestsRef.current.delete(requestId);
          dispatch({
            kind: "workflowDeliveryResult",
            runId: delivery.runId,
            error: "The server did not answer this delivery action. Try again.",
          });
        }
        const key = taskMutationRequestsRef.current.get(requestId);
        if (key) {
          taskMutationRequestsRef.current.delete(requestId);
          dispatch({
            kind: "taskMutationResult",
            key,
            error: "The server did not answer this Task change. Try again.",
          });
        }
        const projectKey = projectMutationRequestsRef.current.get(requestId);
        if (projectKey) {
          projectMutationRequestsRef.current.delete(requestId);
          dispatch({
            kind: "projectMutationResult",
            key: projectKey,
            error: "The server did not answer this Project change. Try again.",
          });
        }
      }, timeoutMs);
      pendingMutationsRef.current.set(requestId, {
        ...mutation,
        recover,
        timer,
      });
      return requestId;
    };
    /** Ask where a jump target lives; the answer arrives as a `timelineAnchor`. */
    const requestReveal = (target: TimelineAnchorTarget) => {
      const requestId = createClientId();
      dispatch({ kind: "revealRequested", requestId, target });
      send({ type: "resolveTimelineAnchor", requestId, target });
    };
    /** Authoritative re-reads used to recover a failed optimistic mutation. */
    const refetchSessions = () => {
      if (stateRef.current.archivedSessionsLoaded)
        send({ type: "loadArchivedSessions" });
      else send({ type: "listSessions" });
    };
    const refetchTasks = () => send({ type: "listTasks", request: {} });
    const recoverTasks = (mutation: PendingMutation) => {
      const ids = [...new Set(mutation.objectIds)];
      if (ids.length === 0) return;
      const requestId = createClientId();
      taskRecoveryItemsRef.current.set(requestId, new Set(ids));
      send({ type: "getStateItems", topic: "tasks", ids, requestId });
    };
    const recoverProjects = (mutation: PendingMutation) => {
      const ids = [...new Set(mutation.objectIds)];
      if (ids.length > 0) {
        const requestId = createClientId();
        projectRecoveryItemsRef.current.set(requestId, new Set(ids));
        send({ type: "getStateItems", topic: "projects", ids, requestId });
      }
      const openId = stateRef.current.openProjectProjectionId;
      if (!openId || !ids.includes(openId)) return;
      const requestId = createClientId();
      projectDetailRequestsRef.current.set(openId, requestId);
      dispatch({ kind: "projectDetailLoad", id: openId });
      send({ type: "getProject", id: openId, requestId });
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
      const requestId = trackMutation(
        { topic: "projects", objectIds },
        recoverProjects,
        timeoutMs,
      );
      projectMutationRequestsRef.current.set(requestId, key);
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
      const requestId = trackMutation(
        { topic: "workflow", objectIds: [runId] },
        () => dispatch({ kind: "workflowDeliveryResult", runId }),
        // A merge talks to the provider and a cleanup refreshes the base and
        // removes a checkout: the short deadline would fire mid-action and
        // claim the server never answered.
        LONG_MUTATION_SETTLE_TIMEOUT_MS,
      );
      workflowDeliveryRequestsRef.current.set(requestId, {
        runId,
        settledSeen: false,
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
        optimisticUserEcho(dispatch, clientRequestId, text, target);
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
      openPermanentAssistant: () => send({ type: "openPermanentAssistant" }),
      loadArchivedSessions: () => send({ type: "loadArchivedSessions" }),
      deleteSession: (id) => {
        timelineCacheRef.current.delete(id);
        void deleteSessionTimelineCache(id);
        forgetTranscriptScrollPosition(id);
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          refetchSessions,
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
          refetchSessions,
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
          refetchSessions,
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
      settleWorkflowRun: (runId, throughRevision) => {
        // Optimistic for the same reason a session settle is; the server's
        // `error` (carrying this requestId) triggers the recovery refetch, and
        // the authoritative `workflowRunList` corrects the run either way.
        // The roles were shelved optimistically too, so the recovery re-reads
        // the session list; the server re-sends the run list itself with any
        // refusal.
        const requestId = trackMutation(
          { topic: "workflow", objectIds: [runId] },
          refetchSessions,
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
      setSpawnOwnership: (id, ownership) => {
        const requestId = trackMutation(
          { topic: "sessions", objectIds: [id] },
          refetchSessions,
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
          refetchSessions,
        );
        dispatch({
          kind: "optimisticSessionRename",
          sessionId: id,
          title: trimmed,
          now: Date.now(),
        });
        send({ type: "renameSession", id, title, requestId });
      },
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
      saveAndTestSlackHuddleSettings: (patch) =>
        send({ type: "saveAndTestSlackHuddleSettings", patch }),
      testSlackHuddleSettings: () => send({ type: "testSlackHuddleSettings" }),
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
        if (added.includes("skills")) dispatch({ kind: "skillLibraryLoad" });
        if (added.length > 0)
          send(
            taskSubscribeMessage(
              added,
              stateRef.current,
              pendingMutationsRef.current,
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
        const requestId = trackMutation(
          {
            topic: "tasks",
            objectIds: request.id ? [request.id] : [],
            ...(tempId ? { tempId } : {}),
          },
          refetchTasks,
        );
        taskMutationRequestsRef.current.set(requestId, key);
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
        const requestId = trackMutation(
          { topic: "tasks", objectIds: updates.map((update) => update.id) },
          refetchTasks,
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
        taskMutationRequestsRef.current.set(
          requestId,
          taskMutationKey(null, "assignProjects"),
        );
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
        const requestId = trackMutation(
          { topic: "tasks", objectIds: [id] },
          refetchTasks,
        );
        // Membership in the live projection is what the list shows: archiving
        // removes the row, restoring brings it back through the server event
        // (the browser holds no archived row to put back optimistically).
        if (archived) dispatch({ kind: "optimisticTaskRemove", id });
        dispatch({ kind: "clearObjectFailure", type: "task", id });
        send({ type: "archiveTask", id, archived, requestId });
      },
      deleteTask: (id) => {
        const requestId = trackMutation(
          { topic: "tasks", objectIds: [id] },
          refetchTasks,
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
        const requestId = trackMutation(
          {
            topic: "tasks",
            objectIds: placements?.map((p) => p.id) ?? orderedIds,
          },
          refetchTasks,
        );
        taskMutationRequestsRef.current.set(requestId, key);
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
      requestPeerPromptHistory: (limit) =>
        send({ type: "requestPeerPromptHistory", ...(limit ? { limit } : {}) }),
      clearChatError: (sessionId?: string) =>
        dispatch({
          kind: "clearChatError",
          ...(sessionId !== undefined ? { sessionId } : {}),
        }),
      dismissObjectFailure: (type, id) =>
        dispatch({ kind: "clearObjectFailure", type, id }),
      resolveApproval: (approvalId, decision, edits, forSession) =>
        send({
          type: "resolveApproval",
          approvalId,
          decision,
          ...(edits ? { edits } : {}),
          ...(forSession ? { forSession: true } : {}),
        }),
      revokeApprovalGrant: (sessionId, key) =>
        send({ type: "revokeApprovalGrant", sessionId, key }),
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
            refetchSessions();
          }
        };
        const requestId = trackMutation(
          mutation,
          recover,
          // Everything but the linked-Task write is real remote work — a merge,
          // a rebase and force-push, a worktree retirement — and the server
          // answers `mutationSettled` only when it COMPLETES. The short timeout
          // would fire mid-action there and claim the server never answered.
          action === "mark-task-done"
            ? MUTATION_SETTLE_TIMEOUT_MS
            : LONG_MUTATION_SETTLE_TIMEOUT_MS,
        );
        pullRequestCardMutationRequestsRef.current.set(requestId, {
          cardId,
          action,
          serverBusySeen: false,
          outcomeSeen: false,
          settledSeen: false,
          competingActionSeen: false,
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
      listTaskComments: (taskId) => {
        const target: CommentTarget = { kind: "task", taskId };
        if (commentResyncRef.current.has(commentTargetKey(target))) return;
        if (taskCommentRequestsRef.current.has(taskId)) return;
        const requestId = createClientId();
        taskCommentRequestsRef.current.set(taskId, requestId);
        heldCommentTargetsRef.current.set(commentTargetKey(target), target);
        commentRequestsRef.current.set(commentTargetKey(target), requestId);
        dispatch({ kind: "taskCommentsLoad", taskId });
        send({
          type: "listComments",
          target,
          requestId,
        });
      },
      unwatchTaskComments: (taskId) => {
        const target: CommentTarget = { kind: "task", taskId };
        taskCommentRequestsRef.current.delete(taskId);
        heldCommentTargetsRef.current.delete(commentTargetKey(target));
        commentRequestsRef.current.delete(commentTargetKey(target));
        commentResyncRef.current.delete(commentTargetKey(target));
        dispatch({ kind: "unwatchComments", target });
        send({ type: "unwatchComments", target });
      },
      addTaskComment: ({ taskId, body }) => {
        const key = taskMutationKey(taskId, "comment");
        const current = stateRef.current.taskMutations[key];
        if (current?.status === "loading" || current?.status === "refreshing")
          return;
        const requestId = trackMutation(
          { topic: "tasks", objectIds: [taskId] },
          refetchTasks,
        );
        taskMutationRequestsRef.current.set(requestId, key);
        dispatch({ kind: "taskMutationStart", key });
        dispatch({ kind: "clearObjectFailure", type: "task", id: taskId });
        send({
          type: "addComment",
          target: { kind: "task", taskId },
          body,
          requestId,
        });
      },
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
  }, [readTimelineCache, scheduleLiveBodySubscriptions]);

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
