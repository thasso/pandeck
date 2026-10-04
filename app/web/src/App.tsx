import {
  lazy,
  Profiler,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowLeft,
  Check,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareQuote,
  SendHorizontal,
} from "lucide-react";
import {
  CLAUDE_SDK_PROVIDER,
  claudeSdkModelOption,
  clampThinkingLevelForModel,
  isClaudeSdkModel,
  isCodingAgentType,
  modelKey,
  UNLABELED_SESSION_TITLE,
  type AgentQuestionResponse,
  type Harness,
  type ModelOption,
  type PromptAttachment,
  type PullRequestCheckoutOutcome,
  type PullRequestInventoryItem,
  type AgentType,
  type SessionListItem,
  type SessionMode,
  type SessionState,
  type TaskStatus,
  type ThinkingLevel,
  type WorktreeChangeFile,
  type WorktreeChangesResponse,
  type WorktreeComment,
  type WorktreeRecord,
  type WorktreeReviewSet,
} from "@assistant/shared";
import {
  approvalCardHref,
  extractPaObjectLinkUris,
  formatPaObjectLink,
  paObjectHref,
  paObjectKey,
  paObjectTypeLabel,
  parsePaObjectLink,
  paWorktreeTitle,
  type PaObjectLinkResolution,
  type PaObjectType,
} from "@assistant/shared/objectLinks";
import { paObjectReferenceKey } from "./lib/transcriptKeys.ts";
import {
  approvalCardsOf,
  approvalStatusDetail,
  pendingApprovalCards,
  pendingApprovalsKey,
} from "./lib/approvalCards.ts";
import { mentionedPaUris } from "./lib/transcriptMentions.ts";
import { backlogSessionsKey } from "./lib/sessionRows.ts";
import { chatRouteFailure, chatRoutePending } from "./lib/chatRouteStage.ts";
import {
  backgroundInspectorSubscribes,
  topicsForSurface,
} from "./lib/broadcastTopics.ts";
import {
  notifyWindowReady,
  onNativeOpenUrl,
  ownsScreenEdgeGestures,
  takePendingNativeOpenUrl,
} from "./lib/nativeShell.ts";
import { pathFromOpenTarget } from "./lib/openTarget.ts";
import { PerfHud } from "./components/PerfHud.tsx";
import { recordRender, usePerfRenderCount } from "./lib/perfStats.ts";
import {
  useAssistant,
  taskMutationKey,
  WORKTREE_PROVISION_MESSAGE_ID,
  type AssistantActions,
  type HarnessSendInput,
  type UIState,
} from "./hooks/useAssistant.ts";
import { useMemory } from "./hooks/useMemory.ts";
import { useSessionReadDwell } from "./hooks/useSessionReadDwell.ts";
import {
  usePendingChatComments,
  type NewPendingChatComment,
} from "./hooks/usePendingChatComments.ts";
import {
  isDocumentComment,
  type PendingChatComment,
} from "./lib/chatCommentPrompt.ts";
import { documentTargetHref } from "@assistant/shared/documentTargets";
import { LoadedMemorySection } from "./components/LoadedMemorySection.tsx";
import { BackgroundWorkSection } from "./components/BackgroundWorkSection.tsx";
import { BackgroundWorkLedge } from "./components/BackgroundWorkLedge.tsx";
import { PromptQueueLedge } from "./components/PromptQueueLedge.tsx";
import { PendingApprovalsLedge } from "./components/PendingApprovalsLedge.tsx";
import {
  SPAWNED_SESSIONS_LEDGE_LIMIT,
  SpawnedSessionsLedge,
} from "./components/SpawnedSessionsLedge.tsx";
import {
  sessionSettleCascade,
  spawnedSessionsKey,
  spawnedSessionsView,
} from "./lib/sessionInbox.ts";
import { SessionTitleText } from "./components/SessionTitleText.tsx";
import {
  PendingSessionPanel,
  UnavailableSessionPanel,
  SessionBootstrapNarration,
  SessionRefreshMark,
} from "./components/SessionStage.tsx";
import { usePrefs } from "./hooks/usePrefs.ts";
import { useLocationHash } from "./hooks/useLocationHash.ts";
import { workflowRunPath } from "./lib/workflowRunRoutes.ts";
import {
  backgroundTasksPath,
  calendarPath,
  isSectionIndexRoute,
  knowledgeEntryPath,
  knowledgeFilePath,
  knowledgePath,
  PERMANENT_ASSISTANT_PATH,
  projectPath,
  pullRequestPath,
  settingsPath,
  taskPath,
  usagePath,
  useSessionRouting,
  worktreePath,
  type Route,
  type SettingsSection,
} from "./hooks/useSessionRouting.ts";
import {
  SESSIONS_CREATE_PATH,
  SESSIONS_PATH,
  entryIdFromHash,
  messageHash,
  sessionIdFromPathname,
  sessionPath,
} from "./lib/sessionRoutes.ts";
import { appendLiveMessagesAfterPreview } from "./lib/sessionPreview.ts";
import {
  loadBootSessionPreview,
  previewForSessionRoute,
  saveSessionPreview,
  spendBootRouteIdentity,
  type SessionPreview,
} from "./lib/sessionPreviewStore.ts";
import { resolveSessionDockContext } from "./lib/sessionDockContext.ts";
import { applyPeerPromptCardOverridesToMessages } from "./lib/peerPromptCardOverrides.ts";
import {
  carryOverRuntimeSelection,
  composerDraftStorageKey,
  firstPromptRuntimeSelection,
  newSessionRuntimeDefaults,
  reviewHandoffSessionTarget,
  routeComposerSend,
  visibleSessionDraft,
} from "./lib/newSessionRuntime.ts";
import { newSessionShell, stagedTranscript } from "./lib/newSessionShell.ts";
import {
  appendReviewReportConvention,
  buildPullRequestReviewPrompt,
  buildSessionReviewPrompt,
  pullRequestReviewContext,
  reviewAgentType,
  reviewContextForSession,
  sessionContextForWorktree,
} from "./lib/sessionHandoff.ts";
import { useCalendar } from "./hooks/useCalendar.ts";
import type { BacklogState } from "./hooks/useBacklog.ts";
import { todayIso } from "./components/calendar/calendarDates.ts";
import { UserTimeZoneContext } from "./hooks/useUserTimeZone.ts";
import {
  hasModeAxis,
  isOptimisticHarness,
  locksModelAfterStart,
} from "./lib/sessionCapabilities.ts";
import { createClientId } from "./lib/clientId.ts";
import { copyWithToast } from "./lib/clipboard.ts";
import { showToast, TOAST_DWELL_MS } from "./lib/toast.ts";
import { failureOnViewedSession } from "./lib/messageAnnounce.ts";
import { setFailureHomes } from "./lib/messageArrival.ts";
import { visibleModels } from "./lib/models.ts";
import { accountModelOptions } from "./lib/credentialProfiles.ts";
import {
  credentialProfileProjectionBlockReason,
  credentialProfileProjectionBlocksSend,
} from "./lib/credentialProfileProjection.ts";
import { useCredentialProfileProjection } from "./hooks/useCredentialProfileProjection.ts";
import {
  dataOf,
  errorOf,
  failed,
  loading,
  ready,
  refreshing,
} from "./lib/loadState.ts";
import { fetchWorktreeChanges, worktreeForTask } from "./lib/worktrees.ts";
import { useFetchState, useReloadOnToken } from "./hooks/useFetchState.ts";
import { hostingSurfaces } from "./lib/worktreeHosting.ts";
import { rowWorktreeStatus } from "./lib/worktreeRowStatuses.ts";
import { taskRowsHaveMeta } from "./lib/taskRowMeta.ts";
import { SIDEBAR_BACKLOG_DENSITY } from "./lib/backlogTreeModel.ts";
import { useWorktreeHosting } from "./hooks/useWorktreeHosting.ts";
import { usePullRequestInventory } from "./hooks/usePullRequestInventory.ts";
import {
  pullRequestDetailState,
  pullRequestJoinSources,
  type PullRequestTarget,
} from "./lib/pullRequestInbox.ts";
import { useDirtyWorktrees } from "./hooks/useDirtyWorktrees.ts";
import { useWorkflowIndicators } from "./hooks/useWorkflowIndicators.ts";
import { useWorktreeWatches } from "./hooks/useWorktreeWatches.ts";
import { useApnsRegistration } from "./hooks/useApnsRegistration.ts";
import { taskStartSession, taskWorktreeIds } from "./lib/taskActivity.ts";
import {
  acceptStatusSuggestionSave,
  nextStatus,
  type Task,
} from "./lib/backlogTree.ts";
import type { ArchiveContext } from "./lib/taskArchive.ts";
import { runTaskArchive } from "./lib/taskArchiveRun.ts";
import { deleteConfirmation, deleteSet } from "./lib/taskDelete.ts";
import {
  canonicalSidebarSection,
  sectionIndexPath,
  useSidebarSection,
  type NavAction,
  type SidebarSection,
} from "./hooks/useSidebarSection.ts";
import { PRIMARY_NAV_SLOTS } from "./components/primaryNavSections.tsx";
import { Topbar } from "./components/Topbar.tsx";
import {
  KnowledgeInspector,
  ProjectInspector,
  PullRequestInspector,
  SessionInspector,
  TaskInspector,
  WorktreeInspector,
  worktreeObjectTreeRefs,
  type ObjectOpeners,
  type ObjectRef,
} from "./components/objectInspectors.tsx";
import type { SendCommentsTarget } from "./components/review/SendCommentsSheet.tsx";
import {
  DocumentCommentHostProvider,
  type DocumentCommentHost,
} from "./components/DocumentComments.tsx";
import { moveTrayToOutbox } from "./lib/pendingCommentStore.ts";
import {
  CommentActuationProvider,
  useCommentActuation,
} from "./components/review/CommentActuation.tsx";
import type { CommentActions } from "./components/diff/comments.tsx";
import { WorktreeReviewSubmitSheet } from "./components/worktree/worktreeReview.tsx";
import { TaskContextSections } from "./components/TaskContextSections.tsx";
import { buildProjectsById } from "./lib/projectDisplay.ts";
import { AppShell } from "./components/shell/AppShell.tsx";
import {
  DocumentNavigationMarker,
  useDocumentNavigationRegistration,
} from "./components/DocumentNavigationShell.tsx";
import { DockAction, type DockPeek } from "./components/shell/ObjectDock.tsx";
import { DocumentZoomSection } from "./components/DocumentZoom.tsx";
import { documentDockPeek } from "./components/DocumentDockRow.tsx";
import {
  primarySlotShowsReview,
  RoutePrimaryActionProvider,
  type RoutePrimaryAction,
} from "./components/shell/RoutePrimaryAction.tsx";
import {
  SessionDockActions,
  type SessionDockContextSlot,
} from "./components/SessionDockActions.tsx";
import {
  TASK_STATUS_LABEL,
  TaskStatusIcon,
} from "./components/TaskStatusIcon.tsx";
import {
  Inspector,
  InspectorChromeProvider,
} from "./components/shell/Inspector.tsx";
import {
  RightPanelTabs,
  type PanelId,
} from "./components/shell/RightPanelTabs.tsx";
import {
  KnowledgeOpenTargetsProvider,
  type KnowledgeOpenTargets,
} from "./components/KnowledgeOpenTargets.tsx";
import { useWorktreeCommentWatch } from "./hooks/useCommentWatch.ts";
import { useMobileLayout } from "./components/shell/useMobileLayout.ts";
import {
  decodeBoolean,
  useSessionStorageState,
} from "./hooks/useSessionStorageState.ts";
import {
  Composer,
  PlanModeBadge,
  type BranchPanelInfo,
} from "./components/Composer.tsx";
import { SessionWorktreeMissingBanner } from "./components/SessionWorktreeMissingBanner.tsx";
import type { MarkdownPaObjectReference } from "./components/Markdown.tsx";
import type {
  StagedContextData,
  StagedContextField,
} from "./components/StagedContext.tsx";
import {
  NewSessionQuickStart,
  orderProjectsByActivity,
  orderWorktreesByActivity,
} from "./components/NewSessionQuickStart.tsx";
import { ChatHeaderMenu } from "./components/ChatHeaderMenu.tsx";
import type { TranscriptViewPrefs } from "./components/transcriptView.ts";
import {
  PageHeader,
  sessionHeaderIcon,
  type PageHeaderBack,
} from "./components/PageHeader.tsx";
import { SessionContextSections } from "./components/SessionContextSections.tsx";
import { ToastViewport } from "./components/ToastViewport.tsx";
import { AppStatus } from "./components/AppStatus.tsx";
import { WorkflowRunStartSheet } from "./components/WorkflowRunStartSheet.tsx";
import { settleBackgroundWorkflowStarts } from "./lib/workflowStart.ts";
import { UnreadDot } from "./components/UnreadDot.tsx";
import {
  useShortcuts,
  type ShortcutGroup,
} from "./components/ui/shortcuts.tsx";
import { ErrorNote, PaneLoading, Skeleton } from "./components/ui/load.tsx";
import { useDialogs } from "./components/ui/dialog.tsx";

const SIDEBAR_MIN_WIDTH = 220;

// Always-present shortcuts shown at the bottom of the `?` help overlay. The key
// is handled by its owning surface (the ShortcutsProvider owns `?`); listing it
// here keeps the overlay complete.
const GENERAL_SHORTCUTS: ShortcutGroup = {
  title: "General",
  shortcuts: [{ keys: ["?"], label: "Show keyboard shortcuts", keyHint: "?" }],
};
const TASK_DRAWER_MIN_WIDTH = 260;
/** How often a VISIBLE usage surface nudges the server to revalidate its cache. */
const USAGE_HEARTBEAT_MS = 60_000;
/** One shared empty list, so "no Backlog worktrees" is a stable identity. */
const NO_WORKTREE_IDS: string[] = [];
/** Ditto for an unanswered/clean workspace: the transcript memoizes on this prop. */
const NO_CHANGED_FILES: WorktreeChangeFile[] = [];
const NO_CREDENTIAL_PROFILES: import("@assistant/shared").CredentialProfileSummary[] =
  [];
const NO_CREDENTIAL_PROFILE_MODELS: Record<string, ModelOption[]> = {};
/** And for a worktree with no review comments: the diff surfaces memoize on it. */
const NO_WORKTREE_COMMENTS: WorktreeComment[] = [];
const NO_WORKTREE_REVIEW_SETS: WorktreeReviewSet[] = [];
const DEFAULT_WORKTREE_REVIEW_PROMPT =
  "Review the selected comments, apply the appropriate changes, and reply to or resolve each thread.";
const REVIEW_SET_CLAIMS_PROMPT = `Findings are claims, not orders. Verify each against the code before acting.
Fix real findings at the root cause — not the narrowest patch that silences the
wording. If a finding is wrong, do NOT change the code for it: reply on the
thread with concrete evidence and leave it unresolved for the reviewer. Resolve
a thread only when the finding is fixed or explicitly withdrawn.`;

function isReviewSetSelection(
  comments: WorktreeComment[],
  commentIds: string[],
): boolean {
  const selected = comments.filter(
    (comment) => !comment.parentId && commentIds.includes(comment.id),
  );
  const selectedSetIds = [
    ...new Set(selected.map((comment) => comment.reviewSetId).filter(Boolean)),
  ];
  return (
    selected.length > 0 &&
    selectedSetIds.length === 1 &&
    selected.every((comment) => comment.reviewSetId === selectedSetIds[0])
  );
}
/**
 * The cards whose conflicted rebase is with this session's agent. Each entry of
 * `state.pullRequestCards` is the one-block message `upsertPullRequestCard`
 * writes, so the card is read off the block rather than from a second store.
 */
function rebaseHandedOffCardIds(cards: UIState["pullRequestCards"]): string[] {
  const ids: string[] = [];
  for (const message of cards)
    for (const block of message.blocks)
      if (block.kind === "pullRequest" && block.pullRequest.rebaseHandedOff)
        ids.push(block.pullRequest.id);
  return ids;
}

// The third review draft — /review's "an agent reviews this session's work" —
// is lib/sessionHandoff.ts's buildSessionReviewPrompt, because it interpolates
// the source session id.

type PendingWorktreeReview = {
  worktreeId: string;
  commentIds: string[];
  commentCount: number;
  draft: { sessionId: string; text: string; token: number };
};

/**
 * A first send dispatched from a staging route, recorded by `armStagedSend` for
 * as long as the session it creates has not been adopted.
 */
type StagedFirstSend = {
  /**
   * Every session id that EXISTED when the send left — the sidebar list plus
   * the id then viewed. The session this send creates is necessarily absent
   * from it, which is the only positive evidence the surface has that the
   * session now in view is its own answer rather than one that drifted in.
   *
   * It is the same set, captured the same way, as `useSessionRouting`'s
   * `knownIdsAtArm`: the URL and the surface must adopt the SAME session, and
   * a weaker test here than the router uses is how the transcript ends up
   * showing a conversation the URL correctly refused to follow.
   */
  knownSessionIds: ReadonlySet<string>;
  /**
   * Re-dispatch this exact send. Every first send has one; only the plain
   * `harnessSend` kinds also carry `input`, because a review handoff's bundle
   * cannot be rebuilt into a `harnessSend` the composer could re-issue.
   */
  resend: () => void;
  /** The held `harnessSend`, re-issued verbatim by the composer's next send. */
  input: HarnessSendInput | null;
};

let messageListPreload: Promise<
  typeof import("./components/MessageList.tsx")
> | null = null;
function loadMessageList() {
  messageListPreload ??= import("./components/MessageList.tsx");
  return messageListPreload;
}

const MessageList = lazy(() =>
  loadMessageList().then((module) => ({ default: module.MessageList })),
);
const SettingsPage = lazy(() =>
  import("./components/SettingsPage.tsx").then((module) => ({
    default: module.SettingsPage,
  })),
);
const TaskManagementPage = lazy(() =>
  import("./components/TaskManagementPage.tsx").then((module) => ({
    default: module.TaskManagementPage,
  })),
);
const ProjectDetailPage = lazy(() =>
  import("./components/ProjectDetailPage.tsx").then((module) => ({
    default: module.ProjectDetailPage,
  })),
);
const KnowledgePage = lazy(() =>
  import("./components/KnowledgePage.tsx").then((module) => ({
    default: module.KnowledgePage,
  })),
);
const KnowledgePanel = lazy(() =>
  import("./components/shell/KnowledgePanel.tsx").then((module) => ({
    default: module.KnowledgePanel,
  })),
);
const CalendarPage = lazy(() =>
  import("./components/calendar/CalendarPage.tsx").then((module) => ({
    default: module.CalendarPage,
  })),
);
const UsagePage = lazy(() =>
  import("./components/UsagePage.tsx").then((module) => ({
    default: module.UsagePage,
  })),
);
const BackgroundTasksPage = lazy(() =>
  import("./components/BackgroundTasksPage.tsx").then((module) => ({
    default: module.BackgroundTasksPage,
  })),
);
const FileViewerPage = lazy(() =>
  import("./components/FileViewerPage.tsx").then((module) => ({
    default: module.FileViewerPage,
  })),
);
const SessionArtifactViewer = lazy(() =>
  import("./components/SessionArtifactViewer.tsx").then((module) => ({
    default: module.SessionArtifactViewer,
  })),
);
const CalendarDetailPanel = lazy(() =>
  import("./components/calendar/CalendarDetailPanel.tsx").then((module) => ({
    default: module.CalendarDetailPanel,
  })),
);
const PullRequestDetailPage = lazy(() =>
  import("./components/pullRequest/PullRequestDetailPage.tsx").then(
    (module) => ({ default: module.PullRequestDetailPage }),
  ),
);
const WorktreeDetailPage = lazy(
  () => import("./components/worktree/WorktreeDetailPage.tsx"),
);
// The panel draws the same page, so it lands in the same lazy chunk: the
// pierre diff stack stays out of the main bundle either way.
const WorktreePanel = lazy(() =>
  import("./components/shell/WorktreePanel.tsx").then((module) => ({
    default: module.WorktreePanel,
  })),
);
let worktreeOverlaysPreload: Promise<
  typeof import("./components/worktree/WorktreeOverlays.tsx")
> | null = null;
function loadWorktreeOverlays() {
  worktreeOverlaysPreload ??=
    import("./components/worktree/WorktreeOverlays.tsx");
  return worktreeOverlaysPreload;
}
const WorktreeOverlays = lazy(() =>
  loadWorktreeOverlays().then((module) => ({
    default: module.WorktreeOverlays,
  })),
);
const Sidebar = lazy(() =>
  import("./components/Sidebar.tsx").then((module) => ({
    default: module.Sidebar,
  })),
);
const BacklogList = lazy(() =>
  import("./components/BacklogList.tsx").then((module) => ({
    default: module.BacklogList,
  })),
);

if (typeof window !== "undefined") {
  const initialPath = window.location.pathname.replace(/\/$/, "") || "/";
  if (
    sessionIdFromPathname(initialPath) ||
    initialPath === "/" ||
    initialPath === SESSIONS_CREATE_PATH ||
    initialPath === SESSIONS_PATH
  ) {
    // Direct transcript and new-session routes need the renderer for their
    // first meaningful action. Fetch the split chunk during module evaluation:
    // cached previews paint immediately, and first send never crosses a lazy
    // whole-pane fallback.
    void loadMessageList();
  }
}

function objectLinkCoveredByReferences(
  uri: string,
  refs: readonly PaObjectLinkResolution[],
): boolean {
  const parsed = parsePaObjectLink(uri);
  if (!parsed) return false;
  const key = paObjectKey(parsed);
  return refs.some((ref) => ref.uri === uri || paObjectKey(ref) === key);
}

function appObjectLink(
  type: PaObjectType,
  id: string,
  title: string,
  existence: PaObjectLinkResolution["existence"] = "exists",
): PaObjectLinkResolution {
  return {
    uri: formatPaObjectLink({ objectType: type, id }),
    objectType: type,
    knownType: true,
    id,
    href: paObjectHref({ objectType: type, id }),
    title,
    typeLabel: paObjectTypeLabel(type),
    existence,
  };
}

/**
 * One key per addressed object, so "the route changed" means the app is showing
 * a DIFFERENT thing — not that the router re-parsed the same URL (a reconnect
 * canonicalization, a same-path tap).
 */
function routeIdentityOf(route: Route): string {
  return route.name === "session" ? `session:${route.id}` : route.name;
}

/** Stable fetcher: `useFetchState` re-runs on key change, not on identity. */
function loadWorkspaceChanges(
  worktreeId: string,
): Promise<WorktreeChangesResponse> {
  return fetchWorktreeChanges(worktreeId, { kind: "workingTree" });
}

function pendingSessionState(
  route: { id: string } | null,
  sessions: SessionListItem[],
  fallback: SessionState | null,
): SessionState | null {
  if (!route) return fallback;
  const item = sessions.find((session) => session.id === route.id);
  return {
    sessionId: route.id,
    ...(fallback?.sessionId === route.id
      ? { sessionFile: fallback.sessionFile }
      : {}),
    // `harness`/`agentType` come from the list item when known; default to the
    // always-available pi assistant for an unknown/not-yet-listed session.
    harness: item?.harness ?? "pi",
    agentType: item?.agentType ?? "assistant",
    ...(item?.forkOrigin !== undefined ? { forkOrigin: item?.forkOrigin } : {}),
    ...(fallback?.model !== undefined ? { model: fallback?.model } : {}),
    thinkingLevel: fallback?.thinkingLevel ?? "off",
  };
}

function useMobileKeyboardInset() {
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;

    const root = document.documentElement;
    const viewport = window.visualViewport;
    const mobileMedia = window.matchMedia("(max-width: 767px)");

    const reset = () => {
      root.style.removeProperty("--app-keyboard-inset-bottom");
      root.style.removeProperty("--app-composer-bottom-padding");
    };

    const isTextInputFocused = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      if (active.isContentEditable) return true;
      return active.matches(
        "input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='submit']), textarea, select",
      );
    };

    const update = () => {
      if (!mobileMedia.matches) {
        reset();
        return;
      }

      const layoutHeight =
        window.innerHeight || document.documentElement.clientHeight;
      const visibleBottom = viewport.height + viewport.offsetTop;
      const keyboardOverlap = Math.max(0, layoutHeight - visibleBottom);
      const keyboardLikelyOpen = isTextInputFocused() && keyboardOverlap > 120;

      if (!keyboardLikelyOpen) {
        reset();
        return;
      }

      root.style.setProperty(
        "--app-keyboard-inset-bottom",
        `${Math.round(keyboardOverlap)}px`,
      );
      root.style.setProperty("--app-composer-bottom-padding", "0.25rem");
      window.scrollTo(0, 0);
    };

    const requestUpdate = () => window.requestAnimationFrame(update);

    update();
    viewport.addEventListener("resize", requestUpdate);
    viewport.addEventListener("scroll", requestUpdate);
    window.addEventListener("resize", requestUpdate);
    window.addEventListener("orientationchange", requestUpdate);
    window.addEventListener("focusin", requestUpdate);
    window.addEventListener("focusout", requestUpdate);
    mobileMedia.addEventListener("change", requestUpdate);
    return () => {
      viewport.removeEventListener("resize", requestUpdate);
      viewport.removeEventListener("scroll", requestUpdate);
      window.removeEventListener("resize", requestUpdate);
      window.removeEventListener("orientationchange", requestUpdate);
      window.removeEventListener("focusin", requestUpdate);
      window.removeEventListener("focusout", requestUpdate);
      mobileMedia.removeEventListener("change", requestUpdate);
      reset();
    };
  }, []);
}

/**
 * The boot screen, before anything is hydrated: the full viewport framing the
 * app's own pane load, so the first thing drawn is the same spinner and the
 * same label geometry every pane uses afterwards. The label is the caller's —
 * "Connecting…" before the socket answers, "Loading session…" after.
 */
function LoadingShell({ label = "Loading session…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-dvh flex-col bg-surface text-fg">
      <PaneLoading label={label} />
    </div>
  );
}

/**
 * A lazy chunk arriving. It is a pane load like any other (R4 has no silhouette
 * to reserve here: which surface is opening is exactly what is not loaded yet),
 * so it looks like one instead of the bare centred word it used to be.
 */
function LazySurfaceFallback({ label = "Opening…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-surface">
      <PaneLoading label={label} />
    </div>
  );
}

/**
 * Inline transcript silhouette used only if a primary action beats its idle
 * preload. It occupies transcript geometry, so first send never swaps the hero
 * for a whole-pane chunk fallback or for an empty frame.
 */
function recordTranscriptRender(
  _id: string,
  _phase: string,
  actualDuration: number,
): void {
  recordRender("Transcript", actualDuration);
}

function TranscriptChunkFallback() {
  return (
    <div
      role="status"
      aria-label="Opening transcript"
      className="min-h-0 flex-1 overflow-hidden bg-surface"
    >
      <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-end gap-3 px-4 py-6">
        <div className="ml-auto w-2/3 rounded-2xl border border-line bg-panel p-4">
          <Skeleton className="h-3 w-full rounded-full" />
          <Skeleton className="mt-2 h-3 w-3/4 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * Main-pane surface for a worktree id that no longer resolves. There is no
 * `/worktrees` index any more — a worktree is browsed on its Project page — so
 * this is the one case left. It still owns a real page header so the mobile
 * back control has a home.
 */
function WorktreePlaceholder({
  detail,
  back,
}: {
  detail: string;
  back?: PageHeaderBack | undefined;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PageHeader
        back={back}
        icon={<GitBranch size={16} />}
        title="Worktrees"
      />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-body text-muted">
        {detail}
      </div>
    </div>
  );
}

/**
 * The Pull Requests index in the main pane. The list itself is the browser
 * (sidebar panel on desktop, browser screen on a phone), so the index route
 * renders a real surface that says what this section is for rather than a
 * blank pane.
 */
function PullRequestIndexPlaceholder({
  back,
}: {
  back?: PageHeaderBack | undefined;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PageHeader
        back={back}
        icon={<GitPullRequest size={16} />}
        title="Pull Requests"
      />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-body text-muted">
        Pick a pull request to see its checks, its review and what it is joined
        to on this machine.
      </div>
    </div>
  );
}

function AppContent() {
  usePerfRenderCount("App");
  useMobileKeyboardInset();
  // The app's own confirm/prompt surface. Native dialogs are banned: the Tauri
  // shell's webview never shows them, so the action they guard silently does
  // nothing (`components/ui/dialog.tsx`). Both members are stable, so the
  // handlers below stay referentially stable for memoized rows.
  const dialogs = useDialogs();
  // Register the always-present General group last (lowest priority) so it sorts
  // to the bottom of the help overlay beneath context-specific groups.
  useShortcuts(GENERAL_SHORTCUTS, -1);
  const commentActuation = useCommentActuation();
  const documentNavigation = useDocumentNavigationRegistration();

  const { state, actions, socket } = useAssistant();
  const { prefs, update } = usePrefs();
  const credentialProfileFetch = useCredentialProfileProjection({
    connected: state.connected,
    ...(state.credentialProfileProjection != null
      ? { initialData: state.credentialProfileProjection }
      : {}),
    onProjection: actions.setCredentialProfileProjection,
  });
  const credentialProfileProjection = dataOf(credentialProfileFetch.state);
  const credentialProfiles =
    credentialProfileProjection?.profiles ?? NO_CREDENTIAL_PROFILES;
  const activeCredentialProfiles = useMemo(
    () => credentialProfiles.filter((profile) => profile.enabled),
    [credentialProfiles],
  );
  const credentialProfileModels =
    credentialProfileProjection?.modelsByProfile ??
    NO_CREDENTIAL_PROFILE_MODELS;
  // Settings configures agents as account/model combinations, so its pickers
  // list every enabled account's models rather than the default account's.
  const settingsAccountModels = useMemo(
    () => accountModelOptions(credentialProfiles, credentialProfileModels),
    [credentialProfiles, credentialProfileModels],
  );

  const [credentialProfileId, setCredentialProfileId] = useState(
    prefs.credentialProfileId ?? "default",
  );
  // A new-session profile picker change also picks that family’s first model.
  // Carry its explicit account through the same event instead of consulting a
  // stale render closure in the model handler.
  const explicitProfileForNextModel = useRef<string | null>(null);
  useEffect(() => {
    if (!credentialProfileProjection) return;
    setCredentialProfileId((current) =>
      activeCredentialProfiles.some((profile) => profile.id === current)
        ? current
        : (activeCredentialProfiles[0]?.id ?? ""),
    );
  }, [credentialProfileProjection, activeCredentialProfiles]);
  useEffect(() => {
    if (
      credentialProfileId &&
      credentialProfileId !== prefs.credentialProfileId
    )
      update({ credentialProfileId });
  }, [credentialProfileId, prefs.credentialProfileId, update]);
  const memory = useMemory(socket);
  const [sidebarOpen, setSidebarOpen] = useSessionStorageState(
    "assistant.shell.sidebar-open.v1",
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 768px)").matches,
    decodeBoolean,
  );
  /**
   * Bumping this token tells the rendered Sidebar to move keyboard focus into
   * the session list. Used when the user opens the Sessions surface via the
   * header Sessions button (toggle→open or direct navigation to /sessions).
   */
  const [sidebarFocusToken, setSidebarFocusToken] = useState(0);
  // The right panel (inspector) mirrors the left sidebar: pure user state,
  // never disabled by the route, at most empty (ui-shell.md).
  const [inspectorOpen, setInspectorOpen] = useSessionStorageState(
    "assistant.shell.right-panel-open.v1",
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 768px)").matches,
    decodeBoolean,
  );
  // The desktop tab host owns which panel is actually visible; mobile has no
  // tab host, so `inspectorOpen` is the complete gate there.
  const [activeRightPanel, setActiveRightPanel] = useState<PanelId | null>(
    null,
  );
  const reportActiveRightPanel = useCallback((panel: PanelId | null) => {
    setActiveRightPanel(panel);
  }, []);
  const inspectorTabVisible = activeRightPanel === "inspector";
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  // Mobile: the composer has no collapsed bar there, so it either occupies the
  // bottom edge or the object dock's action row does (ui-shell.md, Small Screens).
  // `composerVisible` is what the composer reports; `openComposerRef` is how the
  // dock's compose control focuses it INSIDE its own tap, which is the only way
  // iOS raises the keyboard without a second one.
  const [composerVisible, setComposerVisible] = useState(false);
  // The composer's background ledge, expanded: the one state that subscribes
  // this browser to the registry topic from the session screen itself.
  const [backgroundLedgeOpen, setBackgroundLedgeOpen] = useState(false);
  const toggleBackgroundLedge = useCallback(
    () => setBackgroundLedgeOpen((value) => !value),
    [],
  );
  // The composer's spawned-session ledge, expanded. It subscribes nothing: the
  // peers are rows of the session list this browser already holds.
  const [spawnedLedgeOpen, setSpawnedLedgeOpen] = useState(false);
  // The session whose ledge lists EVERY peer rather than its first ten. Keyed
  // by session rather than a boolean so a chat switched to mid-list starts at
  // the cut again without an effect to reset it; closing the strip forgets it.
  const [spawnedLedgeAllFor, setSpawnedLedgeAllFor] = useState<string | null>(
    null,
  );
  const toggleSpawnedLedge = useCallback(() => {
    setSpawnedLedgeOpen((value) => {
      if (value) setSpawnedLedgeAllFor(null);
      return !value;
    });
  }, []);
  // The draft as the dock's field shows it while the composer is closed. Only the
  // composer knows it, and it only reports it while hidden (see `Composer`).
  const [composerDraft, setComposerDraft] = useState("");
  const openComposerRef = useRef<(() => void) | null>(null);
  const attachComposerRef = useRef<(() => void) | null>(null);
  const submitComposerRef = useRef<(() => void) | null>(null);
  // Dictation on mobile lives in the dock's action row (it renders the trace, so it
  // owns the recorder). App only carries what has to cross between the two: the
  // hand-over from the expanded composer's mic, whether the row is currently the
  // audio's, and the finished transcript on its way to the composer's caret.
  const [dictationRequest, setDictationRequest] = useState<{
    at: number;
  } | null>(null);
  const [dictationActive, setDictationActive] = useState(false);
  const [dictationTranscript, setDictationTranscript] = useState<{
    spoken: string;
    token: number;
  } | null>(null);
  // The row a jump landed on, held here rather than read from `state`: the
  // transcript may still be loading back to it, and the reveal that named it is
  // consumed once (like a fork switch).
  const [messageFocus, setMessageFocus] = useState<{
    sessionId: string;
    entryId: string;
    token: number;
  } | null>(null);
  /** The `#m-` address already acted on, so staying at it does not re-ask. */
  const revealedHashRef = useRef<string | null>(null);
  /** Changes whenever the URL's fragment moves, which no route change reports. */
  const locationHash = useLocationHash();
  const [sessionIdCopied, setSessionIdCopied] = useState(false);
  const mobileLayout = useMobileLayout();
  // The boot route's cached transcript, read synchronously so a reload or deep
  // link paints in the first frame. It is never re-read for a later route:
  // `previewForSessionRoute` below drops it the moment the app navigates, so an
  // in-app switch shows `PendingSessionPanel` instead of a stale transcript.
  const [bootPreview] = useState<SessionPreview | null>(() =>
    loadBootSessionPreview(location.pathname),
  );
  const [previewInteracted, setPreviewInteracted] = useState(false);
  // Submitting follows the answer: the transcript jumps to the end and stays
  // there, wherever in the conversation the send was made from. This is a token
  // rather than something the transcript could notice by itself — an
  // attachments-only prompt echoes no optimistic row to notice.
  const [transcriptPinToken, setTranscriptPinToken] = useState(0);
  const pinTranscriptToBottom = useCallback(
    () => setTranscriptPinToken((token) => token + 1),
    [],
  );
  // A single staged non-pi harness session: created optimistically on the client
  // and only realized server-side by its first prompt's harnessSend.
  const [pendingStart, setPendingStart] = useState<{
    id: string;
    harness: Harness;
    agentType: AgentType;
    provider?: string;
    modelId?: string;
    thinkingLevel: ThinkingLevel;
    /** Build/Plan staged for the first send (absent = Build). */
    mode?: SessionMode;
  } | null>(null);
  /**
   * A first send is armed and the server has not answered yet.
   *
   * Explicit rather than inferred from "the transcript has a user prompt": the
   * worktree review handoff (`attachWorktreeComments`) creates
   * its session server-side and echoes nothing locally, so without this the
   * quick-start hero and the send-blocked hint stayed on screen for the whole
   * round trip — the reported "select a workspace" flicker.
   */
  const [sendInFlight, setSendInFlight] = useState(false);
  /** A Backlog Task queued to be attached (hidden) to the next fresh session's first prompt. */
  const [pendingTaskAttach, setPendingTaskAttach] = useState<{
    taskId: string;
    title: string;
  } | null>(null);
  /** Primary Project context staged for a standalone new Session's first prompt. */
  const [pendingProjectContext, setPendingProjectContext] = useState<
    string | null
  >(null);
  /** Knowledge entry staged as a structured reference on the next fresh session. */
  const [pendingKnowledgeContext, setPendingKnowledgeContext] = useState<{
    entryId: string;
    title: string;
  } | null>(null);
  /** Pending "follow this comment" request from the worktree panel's roster to the detail page. */
  const [worktreeCommentToOpen, setWorktreeCommentToOpen] = useState<{
    worktreeId: string;
    commentId: string;
    nonce: number;
  } | null>(null);
  /** Worktree staged as the next new session's execution context (first send commits it). */
  const [pendingWorktreeContext, setPendingWorktreeContext] = useState<
    string | null
  >(null);
  /**
   * "+ New worktree" staged instead of an existing one: the checkout does not
   * exist yet, so this is a FLAG beside `pendingWorktreeContext` rather than a
   * sentinel inside it — a fake id would have to be excluded again in every
   * place that resolves a worktree (project derivation, labels, review
   * bundles, the wire). It is provisioned by the first send, in the project
   * staged at that moment.
   */
  const [pendingNewWorktree, setPendingNewWorktree] = useState(false);
  /** The Task whose Run-workflow start sheet is open, if any. */
  const [workflowStartTaskId, setWorkflowStartTaskId] = useState<string | null>(
    null,
  );
  /**
   * EVERY start request whose sheet was closed with "Run in background": those
   * sheets can no longer deliver their outcomes, so App does, as toasts. A SET,
   * not a slot — provisioning takes minutes and a Task may run several
   * workflows, so a second backgrounded start must not overwrite the first
   * request's pending outcome. Each id leaves the set on its own terminal
   * phase (`lib/workflowStart.ts`), which also clears its consumed entry.
   */
  const [backgroundWorkflowStarts, setBackgroundWorkflowStarts] = useState<
    string[]
  >([]);
  useEffect(() => {
    if (backgroundWorkflowStarts.length === 0) return;
    const { settled, toasts } = settleBackgroundWorkflowStarts(
      backgroundWorkflowStarts,
      state.workflowRunStarts,
    );
    if (settled.length === 0) return;
    for (const toast of toasts)
      showToast(toast.message, {
        tone: toast.tone,
        ...(toast.tone === "error" ? { durationMs: TOAST_DWELL_MS } : {}),
      });
    for (const requestId of settled) actions.clearWorkflowRunStart(requestId);
    setBackgroundWorkflowStarts((current) =>
      current.filter((requestId) => !settled.includes(requestId)),
    );
  }, [state.workflowRunStarts, backgroundWorkflowStarts, actions]);
  /**
   * The dispatched first send of a staged session, held until the URL lands on
   * the session it creates. It is the surface's bootstrap latch (set at the
   * send, cleared by the route change that adopts the created session), the
   * baseline the staged transcript compares the viewed session against, and the
   * retry: a first send can fail with NO session to send into — provisioning
   * that never produced a checkout, a model the account cannot run — and the
   * prompt is not a composer draft anybody could get back.
   *
   * ONE record for every kind of first send, written by `armStagedSend` and by
   * nothing else. A second way to arm meant a send that recorded no baseline
   * (the review handoffs, which echo no prompt of their own), and the staged
   * surface then adopted the previously viewed session's rows AND identity —
   * the one thing `stagedTranscript` promises never to do.
   */
  const [stagedSend, setStagedSend] = useState<StagedFirstSend | null>(null);
  /** Structured review threads staged for the new-session composer; the first send performs the handoff. */
  const [pendingWorktreeReview, setPendingWorktreeReview] =
    useState<PendingWorktreeReview | null>(null);
  /**
   * The `/review` handoff's prefilled composer draft. Deliberately NOT another
   * pending-state type: the source session id lives only in this prose, and
   * the Task/worktree/project ride the ordinary staged-context states, so the
   * first send needs no structured handoff and no new wire message.
   */
  const [sessionReviewDraft, setSessionReviewDraft] = useState<{
    sessionId: string;
    text: string;
    token: number;
  } | null>(null);
  /** Token-driven request to open the composer's context sheet on a field (the hero's "All…" card). */
  const [contextSheetRequest, setContextSheetRequest] = useState<{
    token: number;
    field?: StagedContextField;
  } | null>(null);
  /** The new-session Task field is the only route-local reason to subscribe to Tasks. */
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const pendingPreviewSaveRef = useRef<SessionPreview | null>(null);
  const previewSaveTimerRef = useRef<number | null>(null);
  const requestedObjectLinkUris = useRef(new Set<string>());

  const flushSessionPreviewSave = useCallback(() => {
    if (previewSaveTimerRef.current !== null) {
      window.clearTimeout(previewSaveTimerRef.current);
      previewSaveTimerRef.current = null;
    }
    const preview = pendingPreviewSaveRef.current;
    if (!preview) return;
    pendingPreviewSaveRef.current = null;
    saveSessionPreview(preview);
  }, []);

  const scheduleSessionPreviewSave = useCallback((preview: SessionPreview) => {
    pendingPreviewSaveRef.current = preview;
    if (previewSaveTimerRef.current !== null)
      window.clearTimeout(previewSaveTimerRef.current);
    previewSaveTimerRef.current = window.setTimeout(() => {
      previewSaveTimerRef.current = null;
      const next = pendingPreviewSaveRef.current;
      if (!next) return;
      pendingPreviewSaveRef.current = null;
      saveSessionPreview(next);
    }, 800);
  }, []);

  // The inspector is still a user-opened overlay on mobile, and a full-screen one
  // — never inherit a desktop "open" into the phone layout.
  useEffect(() => {
    if (mobileLayout) setInspectorOpen(false);
  }, [mobileLayout, setInspectorOpen]);

  const currentId = state.session?.sessionId;
  const hasMessages = state.messages.length > 0;
  const availableAgentTypes = useMemo(
    () => state.agents.map((a) => a.agentType),
    [state.agents],
  );
  // The coding persona to default worktree/coding chats to. Workshop is dev-only
  // (filtered out of the advertised agents in production), so prefer it when
  // available and fall back to the generic Developer persona otherwise. Never
  // default to a persona the picker won't offer, or the label sticks on an agent
  // the user can no longer reselect.
  const defaultCodingAgentType = useMemo<AgentType>(
    () =>
      availableAgentTypes.includes("workshop")
        ? "workshop"
        : availableAgentTypes.includes("developer")
          ? "developer"
          : (availableAgentTypes[0] ?? "assistant"),
    [availableAgentTypes],
  );
  const { route, navigate, notifyStagedFirstSend } = useSessionRouting({
    connected: state.connected,
    hydrated: state.hydrated,
    sessions: state.sessions,
    currentId,
    hasMessages,
    loadSession: actions.loadSession,
    openPermanentAssistant: actions.openPermanentAssistant,
  });
  useEffect(() => {
    if (!state.hydrated || (route.name !== "new" && route.name !== "sessions"))
      return;
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(
        () => void loadMessageList(),
      );
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(() => void loadMessageList(), 0);
    return () => window.clearTimeout(timer);
  }, [route.name, state.hydrated]);
  /**
   * Something outside the page asked for a place inside it: a clicked
   * notification, or a `pa://` link opened anywhere on the machine. The shell
   * raises both as one event (`lib/nativeShell.ts`); resolving the target to a
   * route is `lib/openTarget.ts`, which DROPS anything it does not recognise —
   * any program on the machine can hand us a `pa://` URL.
   *
   * The pending drain is the other half, and not an optimisation: a link that
   * LAUNCHES the app fires long before this effect can subscribe, so the shell
   * parks it and hands it over when the first page asks.
   */
  useEffect(() => {
    const open = (target: string) => {
      const path = pathFromOpenTarget(target);
      if (path) navigate(path);
    };
    const stop = onNativeOpenUrl(open);
    void takePendingNativeOpenUrl().then((target) => {
      if (target) open(target);
    });
    return stop;
  }, [navigate]);
  /**
   * A native shell window is created hidden, so this is what reveals it — and
   * the condition is `hydrated` rather than "mounted" on purpose: hydrated is the
   * first render that draws the app instead of `LoadingShell`, which is the whole
   * point of opening the window already looking like the app. A warm start
   * hydrates from cache, so that is usually the first render there is.
   *
   * The theme rides along because the shell paints the next window's frame before
   * any page exists to ask; re-reporting it on a change keeps that value fresh,
   * and the shell only ever reveals a window on the first report.
   */
  useEffect(() => {
    if (!state.hydrated) return;
    void notifyWindowReady(prefs.theme);
  }, [state.hydrated, prefs.theme]);
  useApnsRegistration();

  const calendarRoute = route.name === "calendar";
  // The view is route-driven, but a bare /calendar (no view in the URL) falls
  // back to the last-used view (persisted), and every explicit view in the URL
  // is remembered so reopening the calendar restores it.
  const calendarView =
    route.name === "calendar"
      ? (route.view ?? prefs.calendarView)
      : prefs.calendarView;
  const userTimeZone = state.settings.profile.effectiveTimeZone;
  const calendarController = useCalendar({
    active: calendarRoute,
    view: calendarView,
    selectedDate:
      route.name === "calendar"
        ? (route.date ?? todayIso(userTimeZone))
        : todayIso(userTimeZone),
    timeZone: userTimeZone,
    showTempo: prefs.calendarShowTempo,
    onNavigate: useCallback(
      (view: "month" | "week" | "day", date: string) =>
        navigate(calendarPath(view, date)),
      [navigate],
    ),
  });
  useEffect(() => {
    if (
      route.name === "calendar" &&
      route.view &&
      route.view !== prefs.calendarView
    )
      update({ calendarView: route.view });
  }, [route, prefs.calendarView, update]);

  // Sidebar section selection is shell UI state, decoupled from the route
  // (ui-shell.md navigation rules). The entry route only seeds it when nothing
  // is persisted.
  const [sidebarSection, setSidebarSection] = useSidebarSection(() =>
    canonicalSidebarSection(route),
  );

  // Small screens collapse to SCREENS, not overlays (ui-shell.md, Small Screens):
  // a section index route is the browser screen, every other route is an object
  // screen. Only the browser's visibility is route-driven — the selected section
  // stays UI state, so navigation rule 2 still holds.
  const browserScreenRoute = isSectionIndexRoute(route);
  const browserScreen = mobileLayout && browserScreenRoute;
  const sidebarPanelOpen = mobileLayout ? browserScreen : sidebarOpen;

  // Which domain lists this browser is SHOWING (`lib/broadcastTopics.ts`): the
  // main pane's route always counts, the SELECTED section only while its browser
  // is actually on screen. The rule lives there because getting the second half
  // wrong is invisible — everything still renders, the quiet surfaces just keep
  // paying for broadcasts they never show.
  // Pending CONTROL state only: which Stop buttons this browser is waiting on.
  // A Stop-all covers every item its owner holds, so those ids join the set too
  // — and nothing in it changes what a row SAYS about the work.
  const backgroundStopPending = useMemo(() => {
    const pending = new Set(state.backgroundStopPending);
    if (state.backgroundStopAllPending.length > 0)
      for (const item of state.backgroundWorkItems)
        if (state.backgroundStopAllPending.includes(item.ownerSessionId))
          pending.add(item.id);
    return pending;
  }, [
    state.backgroundStopPending,
    state.backgroundStopAllPending,
    state.backgroundWorkItems,
  ]);
  const activeTopics = useMemo(
    () =>
      topicsForSurface({
        sidebarVisible: sidebarPanelOpen,
        sidebarSection,
        routeName: route.name,
        taskPickerOpen:
          (route.name === "new" || route.name === "sessions") && taskPickerOpen,
        // The workflow start sheet meters accounts and offers Project branches.
        workflowStartOpen: workflowStartTaskId !== null,
        projectSelected: route.name === "projects" && Boolean(route.id),
        // Only a surface that renders a domain list reads it. The session
        // inspector needs the current skills scan for its loaded/unloaded rows.
        settingsSection: route.name === "settings" ? route.section : undefined,
        sessionInspectorVisible:
          inspectorOpen &&
          (mobileLayout
            ? !composerVisible && !commentActuation?.composerOpen
            : inspectorTabVisible) &&
          route.name === "session" &&
          state.session?.sessionId === route.id &&
          state.session.activeSkills !== undefined,
        // The ledge only exists on a session screen whose session owns work,
        // so an open flag left over from another session subscribes nothing.
        backgroundLedgeOpen:
          backgroundLedgeOpen &&
          route.name === "session" &&
          state.sessions.some(
            (item) => item.id === route.id && item.backgroundActivity,
          ),
        // Read the predicate, never the data: gating this on held rows or on
        // `backgroundActivity` would make a cold load of a session whose work
        // has FINISHED show no history at all (`lib/broadcastTopics.ts`).
        // `sessionExists` is the separate question of whether the id in the
        // address bar names a session at all — `/sessions/anything` parses, and
        // an arbitrary bad URL must not be handed the global snapshot.
        backgroundInspectorVisible: backgroundInspectorSubscribes({
          routeName: route.name,
          ...(route.name === "session" ? { sessionId: route.id } : {}),
          // The authoritative session LIST only. The loaded-session snapshot is
          // not a membership answer: the server answers a view of an unknown id
          // with a placeholder carrying that id, so reading it here would let
          // /sessions/<anything> subscribe again.
          sessionExists:
            route.name === "session" &&
            state.sessions.some((item) => item.id === route.id),
          inspectorVisible:
            inspectorOpen &&
            (mobileLayout
              ? !composerVisible && !commentActuation?.composerOpen
              : inspectorTabVisible),
        }),
      }),
    [
      sidebarPanelOpen,
      sidebarSection,
      route,
      taskPickerOpen,
      workflowStartTaskId,
      inspectorOpen,
      mobileLayout,
      inspectorTabVisible,
      composerVisible,
      commentActuation?.composerOpen,
      state.session,
      state.sessions,
      backgroundLedgeOpen,
    ],
  );
  useEffect(() => {
    actions.setTopics(activeTopics);
  }, [actions, activeTopics]);

  // PR/CI for every worktree, polled ONCE for the whole app. It is not reducer
  // state — it comes from a provider through `GET /api/worktrees/hosting`, not
  // from the socket — but it is app state all the same, because two surfaces
  // read it now: the Worktrees inbox's cards and a Backlog row's delivery chip.
  // `hostingSurfaces` decides when it is worth asking for: the sidebar's Backlog
  // states it on every row's second line now, so it counts whenever that browser
  // is the one on screen — and a window parked on a conversation still asks for
  // nothing.
  // A project's PAGE has a Tasks section; the projects index has none.
  const projectPageOpen = route.name === "projects" && Boolean(route.id);
  useEffect(() => {
    if (!projectPageOpen) return;
    const timer = window.setTimeout(() => void loadWorktreeOverlays(), 0);
    return () => window.clearTimeout(timer);
  }, [projectPageOpen]);
  const projectPageWorktreeIds = useMemo(
    () =>
      projectPageOpen && route.name === "projects" && route.id
        ? (state.worktrees ?? [])
            .filter((worktree) => worktree.projectId === route.id)
            .map((worktree) => worktree.id)
            .sort()
        : NO_WORKTREE_IDS,
    [projectPageOpen, route, state.worktrees],
  );
  useWorktreeWatches({
    ids: projectPageWorktreeIds,
    connected: state.connected,
    actions,
  });
  const hostingActive = useMemo(
    () =>
      hostingSurfaces({
        sidebarVisible: sidebarPanelOpen,
        sidebarSection,
        routeName: route.name,
        projectOpen: projectPageOpen,
        // The sidebar's rows are two-line on a phone and on the rail alike
        // (`SIDEBAR_BACKLOG_DENSITY`); the predicate answers what they state.
        sidebarTaskRowsHaveMeta: taskRowsHaveMeta(
          SIDEBAR_BACKLOG_DENSITY,
          prefs.backlogView,
        ),
      }),
    [
      sidebarPanelOpen,
      sidebarSection,
      route.name,
      projectPageOpen,
      prefs.backlogView,
    ],
  );
  const worktreeHosting = useWorktreeHosting({
    worktrees: state.worktrees,
    statuses: state.worktreeStatuses,
    active: hostingActive.hosting,
  });

  // The Pull Requests view's own projection, polled ONCE for the whole app: the
  // section's browser and the detail page read the same answer, so the list and
  // the page can never disagree about the same pull request. It is a different
  // read from the per-worktree hosting map above — that one is keyed by
  // checkout, this one by pull request — and it runs only while a Pull Requests
  // surface is actually on screen.
  const pullRequestTarget = useMemo<PullRequestTarget | null>(
    () =>
      route.name === "pullRequests" &&
      route.projectId !== undefined &&
      route.provider !== undefined &&
      route.repositoryKey !== undefined &&
      route.number !== undefined
        ? {
            projectId: route.projectId,
            provider: route.provider,
            repositoryKey: route.repositoryKey,
            number: route.number,
          }
        : null,
    [route],
  );
  const pullRequestsActive =
    route.name === "pullRequests" ||
    (sidebarPanelOpen && sidebarSection === "pull-requests");
  const pullRequestInventory = usePullRequestInventory(pullRequestsActive);
  const pullRequestDetail = useMemo(
    () => pullRequestDetailState(pullRequestInventory.state, pullRequestTarget),
    [pullRequestInventory.state, pullRequestTarget],
  );
  // The detail page states the joined checkout's dirt and drift, so the app
  // holds ONE live watch for it while that page is open — through the same
  // refcounting registry as every other watch (`hooks/useWorktreeWatches.ts`).
  const pullRequestWorktreeId = dataOf(pullRequestDetail)?.worktreeId ?? null;
  const pullRequestJoins = useMemo(
    () => pullRequestJoinSources(state),
    [state],
  );
  const pullRequestWorktreeIds = useMemo(
    () => (pullRequestWorktreeId ? [pullRequestWorktreeId] : NO_WORKTREE_IDS),
    [pullRequestWorktreeId],
  );
  useWorktreeWatches({
    ids: pullRequestWorktreeIds,
    connected: state.connected,
    actions,
  });
  // Uncommitted changes, for those same rows. Their reach into worktree state
  // is ONE list — the worktrees the loaded Tasks have work in — and everything
  // below hangs off it: what the app watches git status for, and what may move
  // the memoized Backlog's props. Held here rather than in `Sidebar` because
  // TWO surfaces show those rows and the sidebar knows nothing about the other
  // one: a project page open with the sidebar closed (every phone) would
  // otherwise render markers nobody was keeping current.
  const backlogWorktreeIds = useMemo(() => {
    if (!hostingActive.taskRows) return NO_WORKTREE_IDS;
    const sessionById = new Map(
      state.sessions.map((session) => [session.id, session]),
    );
    return taskWorktreeIds(state.taskList?.items ?? [], sessionById);
  }, [hostingActive.taskRows, state.sessions, state.taskList]);
  // Watching is not free — the server answers each id with a coalesced git scan
  // and then keeps a watcher on it — so this is the set of ids the rows can
  // actually mark, and nothing while no such row is on screen.
  useWorktreeWatches({
    ids: backlogWorktreeIds,
    connected: state.connected,
    actions,
  });
  // The slice itself IS reducer state, but the record it comes from is
  // rewritten by every watcher push, so what the memoized Backlog takes is the
  // derived set of dirty ids within that scope — one identity per dirty SET,
  // not per scan (`hooks/useDirtyWorktrees.ts`).
  const dirtyWorktrees = useDirtyWorktrees(
    state.worktreeStatuses,
    backlogWorktreeIds,
  );
  const workflowIndicators = useWorkflowIndicators(state.workflowRuns ?? []);

  // Usage heartbeat: while a meter-showing page is mounted AND this tab is
  // visible, nudge the server to revalidate anything no longer fresh. A hidden
  // tab stops, and the nudge costs nothing while the cache is fresh — the
  // server owns freshness, min interval and backoff (`docs/usage.md`).
  const usageVisible = activeTopics.includes("usage");
  useEffect(() => {
    if (!usageVisible) return;
    const ping = () => {
      if (document.visibilityState === "visible") actions.refreshUsage();
    };
    const timer = setInterval(ping, USAGE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [actions, usageVisible]);

  // Which screens get an object dock: every object screen except the two with
  // nothing to inspect. Session screens included — their dock's action row is the
  // resting bottom edge, and the composer replaces it while composing.
  const documentRoute =
    route.name === "files" ||
    route.name === "artifacts" ||
    (route.name === "knowledge" &&
      Boolean(route.filePath || (route.entryId && route.assetPath))) ||
    (route.name === "worktrees" && Boolean(route.id && route.path));
  // Published outside lazy route bodies so document navigation is present in
  // the first committed frame; source renderers replace this registration with
  // the same id plus their typed actions when they mount.
  const routeDocumentTarget = useMemo(() => {
    if (route.name === "files")
      return {
        kind: "hostFile" as const,
        path: route.path,
        ...(route.anchor ? { anchor: route.anchor } : {}),
      };
    if (route.name === "artifacts")
      return {
        kind: "sessionArtifact" as const,
        sessionId: route.sessionId,
        path: route.path,
        ...(route.anchor ? { anchor: route.anchor } : {}),
      };
    if (route.name === "knowledge" && route.filePath)
      return {
        kind: "knowledgeFile" as const,
        path: route.filePath,
        ...(route.anchor ? { anchor: route.anchor } : {}),
      };
    if (route.name === "knowledge" && route.entryId && route.assetPath)
      return {
        kind: "knowledgeAsset" as const,
        entryId: route.entryId,
        path: route.assetPath,
        ...(route.anchor ? { anchor: route.anchor } : {}),
      };
    if (route.name === "worktrees" && route.id && route.path)
      return {
        kind: "worktreeFile" as const,
        worktreeId: route.id,
        path: route.path,
        view: route.view === "changes" ? ("diff" as const) : ("file" as const),
        ...(route.anchor ? { anchor: route.anchor } : {}),
      };
    return null;
  }, [route]);
  const dockSuppressed =
    browserScreen ||
    route.name === "settings" ||
    route.name === "usage" ||
    route.name === "backgroundTasks";
  const sessionScreen =
    route.name === "session" ||
    route.name === "new" ||
    route.name === "sessions" ||
    route.name === "permanentAssistant";
  // The bottom edge is ONE slot: while the mobile composer is up (expanded, or
  // recording in its bar) the dock stands down entirely rather than stacking a
  // second row under it. A commentable surface takes the same slot with its own
  // composer — the Knowledge entry's, in the same card — and says so through the
  // actuation channel.
  const composerOwnsBottomEdge =
    mobileLayout &&
    ((sessionScreen && composerVisible) ||
      Boolean(commentActuation?.composerOpen));
  // A resting dock's action row carries back: the bottom edge is thumb-reachable
  // and the header's top-left corner is the opposite of that. Screens without a
  // dock at all (Settings, Usage) keep back in their header.
  const dockCarriesBack = mobileLayout && !dockSuppressed;
  // The inspector overlay stacks over the main pane, so it would also cover the
  // browser screen — reaching the browser means leaving the inspector behind.
  useEffect(() => {
    if (browserScreen) setInspectorOpen(false);
  }, [browserScreen, setInspectorOpen]);

  // Select a section and show its browser — on desktop by opening the panel, on
  // mobile by going to the browser screen (there is no panel to open there).
  // What still needs it is the object that STOPPED existing: archiving or
  // deleting the inspected Task/Project, and back-to-list from a detail page,
  // all have to land the reader on the section's browser rather than on the
  // route of something that is gone.
  const openSidebarSection = useCallback(
    (section: SidebarSection) => {
      setSidebarSection(section);
      if (mobileLayout) {
        navigate(sectionIndexPath(section));
        return;
      }
      setSidebarOpen(true);
    },
    [mobileLayout, navigate, setSidebarOpen, setSidebarSection],
  );

  // Index routes (nav-bar taps, back from an object screen, typed URLs) address a
  // section itself, so they reveal it; Settings and Calendar reveal from any of
  // their routes because their browsers are the section's own view list. Object
  // detail links deliberately do NOT move the sidebar (navigation rule 2:
  // content links preserve sidebar state).
  const revealedSection: SidebarSection | null =
    browserScreenRoute || route.name === "settings" || route.name === "calendar"
      ? canonicalSidebarSection(route)
      : null;
  useEffect(() => {
    if (revealedSection) setSidebarSection(revealedSection);
  }, [revealedSection, setSidebarSection]);

  // Desktop: an index route addresses the browser, so show the panel. This also
  // covers rotating out of a mobile browser screen into the three-pane layout.
  useEffect(() => {
    if (!mobileLayout && browserScreenRoute) setSidebarOpen(true);
  }, [mobileLayout, browserScreenRoute, setSidebarOpen]);

  // Back goes to the SELECTED section's browser screen rather than history.back(),
  // so a deep link with no history behaves like a tap from the browser and a
  // followed content link returns to the browser the user left. ONE definition,
  // rendered either in the dock's action row or — on the screens that have no
  // dock — in the surface's own header (`screenBack`).
  const backToSection = useMemo(
    () => ({
      label: PRIMARY_NAV_SLOTS[sidebarSection].label,
      onClick: () => navigate(sectionIndexPath(sidebarSection)),
    }),
    [sidebarSection, navigate],
  );
  const screenBack: PageHeaderBack | undefined =
    mobileLayout && !dockCarriesBack ? backToSection : undefined;
  // The third place that same one back action is offered: a pull from the
  // leading screen edge, which the shell turns into the screen sliding aside.
  // Only in the native shell — a browser's edges are the platform's, and only
  // where there is something to go back FROM, which the browser screen is not.
  const edgeBack = useMemo(
    () => ({
      enabled:
        !browserScreen &&
        ownsScreenEdgeGestures() &&
        (!documentRoute || documentNavigation !== null),
      onBack:
        documentRoute && documentNavigation
          ? documentNavigation.canBack
            ? documentNavigation.back
            : documentNavigation.close
          : backToSection.onClick,
    }),
    [browserScreen, documentNavigation, documentRoute, backToSection],
  );

  // Worktree and Project routes receive the authoritative worktree list from
  // their topic subscription. Do not issue a duplicate list command here; the
  // explicit reads below remain for session/staged-context surfaces that need
  // worktree metadata without displaying a subscribed domain browser.

  // Live change watching follows the open worktree view. Through the same
  // refcounted registry as every other watch: the Worktrees browser lists this
  // worktree too, and whichever of the two let go first used to take the
  // other's watch with it.
  const watchedWorktreeId =
    route.name === "worktrees" ? (route.id ?? null) : null;
  const routeWorktreeIds = useMemo(
    () => (watchedWorktreeId ? [watchedWorktreeId] : NO_WORKTREE_IDS),
    [watchedWorktreeId],
  );
  useWorktreeWatches({
    ids: routeWorktreeIds,
    connected: state.connected,
    actions,
  });

  useEffect(() => {
    if (
      !state.hydrated ||
      !state.session ||
      state.historySessionId !== state.session.sessionId
    )
      return;
    scheduleSessionPreviewSave({
      sessionId: state.session.sessionId,
      session: state.session,
      messages: state.messages,
      contextInfo: state.contextInfo,
      savedAt: Date.now(),
    });
  }, [
    state.hydrated,
    state.session,
    state.historySessionId,
    state.messages,
    state.contextInfo,
    scheduleSessionPreviewSave,
  ]);

  useEffect(() => {
    const flushIfHidden = () => {
      if (document.visibilityState === "hidden") flushSessionPreviewSave();
    };
    document.addEventListener("visibilitychange", flushIfHidden);
    window.addEventListener("pagehide", flushSessionPreviewSave);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("pagehide", flushSessionPreviewSave);
      flushSessionPreviewSave();
    };
  }, [flushSessionPreviewSave]);

  // Clear the staged optimistic session once the server confirms the real one.
  useEffect(() => {
    if (!pendingStart) return;
    if (state.session?.sessionId === pendingStart.id) setPendingStart(null);
  }, [pendingStart, state.session?.sessionId]);

  // The app shell only receives runtime settings on ready; fetch the full settings
  // object when the Settings route is actually opened.
  useEffect(() => {
    if (route.name === "settings" && state.connected) actions.requestSettings();
  }, [route.name, state.connected, actions]);

  // New-session models come from the selected profile's isolated runtime; an
  // established session keeps the global list so its immutable model remains
  // inspectable even when another new-session profile is remembered.
  const pickerModels = useMemo(() => {
    if (route.name === "session")
      return visibleModels(state.models, state.settings);
    return visibleModels(
      credentialProfileModels[credentialProfileId] ?? state.models,
      state.settings,
    );
  }, [
    state.models,
    state.settings,
    credentialProfileModels,
    credentialProfileId,
    route.name,
  ]);
  const messageModels = useMemo(
    () => visibleModels(state.models, state.settings),
    [state.models, state.settings],
  );
  const currentSessionModel = state.session?.model
    ? (pickerModels.find(
        (m) =>
          m.provider === state.session?.model?.provider &&
          m.id === state.session?.model?.id,
      ) ?? (route.name === "session" ? state.session.model : undefined))
    : undefined;
  // New chats default to the model/thinking level the user last explicitly
  // picked (remembered locally via prefs), when it's still an available model.
  // Falls back to the currently viewed session, then the first picker model.
  const rememberedModel = prefs.lastModelKey
    ? pickerModels.find((m) => modelKey(m) === prefs.lastModelKey)
    : undefined;
  const defaultNewSessionModel =
    rememberedModel ?? currentSessionModel ?? pickerModels[0];
  const defaultNewSessionThinking = clampThinkingLevelForModel(
    defaultNewSessionModel,
    prefs.lastThinkingLevel ?? state.session?.thinkingLevel ?? "off",
  );

  const routeSessionItem =
    route.name === "session"
      ? state.sessions.find((session) => session.id === route.id)
      : undefined;
  // A non-empty list item means the transcript is still loading.
  const routeHistoryPending =
    route.name === "session" &&
    state.historySessionId !== route.id &&
    (routeSessionItem?.messageCount ?? 0) > 0;
  // A staged non-pi harness renders optimistically while we wait for its first
  // prompt. The URL stays on the staging route (`/sessions/create` or
  // `/sessions`) through the send; the armed staged advance in useSessionRouting
  // adopts the created session once its snapshot lands, for BOTH harnesses. The
  // synthetic state carries the staged harness/agentType identity pair.
  // Memoized because five hooks below take it as a dependency: as a bare object
  // literal it was a new identity on every render, so all five recomputed on
  // every render of the app's hottest component.
  const stagedStart = useMemo(
    () =>
      pendingStart ??
      (route.name === "new" || route.name === "sessions"
        ? {
            id: "pending-pi-session",
            // The harness MUST follow the default model's provider. A remembered
            // Claude SDK model with a hardcoded "pi" harness would send the first
            // prompt down the pi path, where findModel("claude-sdk", …) fails with
            // "model is not available".
            harness: (isClaudeSdkModel(defaultNewSessionModel)
              ? "claude-sdk"
              : "pi") as Harness,
            agentType: "assistant" as AgentType,
            provider: defaultNewSessionModel?.provider,
            modelId: defaultNewSessionModel?.id,
            thinkingLevel: defaultNewSessionThinking,
            mode: undefined as SessionMode | undefined,
          }
        : null),
    [
      pendingStart,
      route.name,
      defaultNewSessionModel,
      defaultNewSessionThinking,
    ],
  );
  // Bound with its own null guard so it is evaluated under exactly the same
  // condition as the object below, where `model` may be omitted entirely.
  const optimisticModel = !stagedStart
    ? undefined
    : stagedStart.harness === "claude-sdk"
      ? claudeSdkModelOption(stagedStart.modelId ?? "sonnet")
      : stagedStart.provider && stagedStart.modelId
        ? (pickerModels.find(
            (m) =>
              m.provider === stagedStart.provider &&
              m.id === stagedStart.modelId,
          ) ??
          ({
            provider: stagedStart.provider,
            id: stagedStart.modelId,
          } as ModelOption))
        : defaultNewSessionModel;
  const optimisticSession: SessionState | null =
    stagedStart &&
    state.session?.sessionId !== stagedStart.id &&
    (route.name === "new" ||
      route.name === "sessions" ||
      (route.name === "session" && route.id === stagedStart.id))
      ? {
          sessionId: stagedStart.id,
          sessionFile: stagedStart.id,
          harness: stagedStart.harness,
          agentType: stagedStart.agentType,
          ...(optimisticModel !== undefined ? { model: optimisticModel } : {}),
          thinkingLevel: stagedStart.thinkingLevel,
          ...(stagedStart.mode !== undefined ? { mode: stagedStart.mode } : {}),
        }
      : null;
  const routeIdentity = routeIdentityOf(route);
  const routeSessionPending = chatRoutePending({
    route,
    viewedSessionId: state.session?.sessionId ?? null,
    viewedAgentType: state.session?.agentType,
    hasOptimisticSession: Boolean(optimisticSession),
    transcriptPending: routeHistoryPending,
  });
  // The route this app run started on, SPENT by the first navigation away from
  // it — a one-way latch, so coming back to the boot session is an in-app
  // arrival like any other and gets the pending panel. Held in a ref rather than
  // state because it may never lag a frame behind the route: the frame it lagged
  // would be the one painting a cached transcript under a live session. A render
  // React discards can only spend the latch EARLY, which costs a cached paint
  // and can never show the wrong session.
  const bootRouteIdentityRef = useRef<string | null>(routeIdentity);
  bootRouteIdentityRef.current = spendBootRouteIdentity(
    bootRouteIdentityRef.current,
    routeIdentity,
  );
  const sessionPreview = previewForSessionRoute(
    bootPreview,
    {
      identity: routeIdentity,
      sessionId: route.name === "session" ? route.id : null,
    },
    bootRouteIdentityRef.current,
  );
  // The server said the route's session cannot be opened: nothing is on its way,
  // so neither the pending panel nor a cached preview may claim otherwise.
  const routeSessionFailure = routeSessionPending
    ? chatRouteFailure(route, state.unopenableSessions)
    : null;
  const usePreview =
    routeSessionPending && sessionPreview !== null && !routeSessionFailure;
  const preservePreviewMessages =
    !routeSessionPending &&
    !optimisticSession &&
    previewInteracted &&
    sessionPreview;
  const pendingRoute = route.name === "session" ? { id: route.id } : null;
  const pendingSession = routeSessionPending
    ? pendingSessionState(pendingRoute, state.sessions, state.session)
    : null;
  const showLoadingShell = !state.hydrated;
  const showPendingSessionPanel = routeSessionPending && !usePreview;
  // A staged send has no server session yet, so the transcript shows the rows
  // this browser already dispatched for it — the optimistic `creq-*` prompt —
  // rather than nothing (which used to make the quick-start hero and the
  // send-blocked hint linger for the whole round trip) and rather than the
  // previously viewed session's transcript.
  // The live worktree-provisioning card belongs to THIS browser's staged send,
  // matched by the clientRequestId the send returned — never to whatever
  // transcript happens to be on screen.
  const provisionCardOwned =
    state.worktreeProvision !== null &&
    state.worktreeProvision.clientRequestId ===
      stagedSend?.input?.clientRequestId;
  // A first send is out and its session has not been adopted yet: the whole
  // bootstrap window, from the send to the URL landing on what it created. The
  // record IS the latch, so a send can never be pending without the baseline
  // the handoff below reads.
  const firstSendPending = stagedSend !== null;
  const staged = useMemo(
    () =>
      stagedTranscript({
        stagedSessionId: optimisticSession?.sessionId ?? null,
        optimistic: state.optimistic,
        messages: state.messages,
        provisionMessageId: WORKTREE_PROVISION_MESSAGE_ID,
        provisionOwned: provisionCardOwned,
        firstSendPending,
        viewedSessionId: state.session?.sessionId ?? null,
        knownSessionIdsAtSend: stagedSend?.knownSessionIds ?? null,
      }),
    [
      optimisticSession?.sessionId,
      state.optimistic,
      state.messages,
      provisionCardOwned,
      firstSendPending,
      state.session?.sessionId,
      stagedSend?.knownSessionIds,
    ],
  );
  // The staged phase is over the moment the created session's transcript takes
  // the prompt over, one commit before the route follows it there: the identity
  // the shell shows switches with the rows, so nothing remounts on the advance.
  const shownOptimisticSession = staged.adopted ? null : optimisticSession;
  const displaySession =
    shownOptimisticSession ??
    (usePreview ? sessionPreview!.session : (pendingSession ?? state.session));
  // Only the list that belongs to the session on screen.
  const approvalGrants =
    state.approvalGrants?.sessionId === displaySession?.sessionId
      ? state.approvalGrants?.grants
      : undefined;
  // …and it is only ever a STAGED surface's row: a real session's transcript
  // never carries it, so it cannot end up on top of an unrelated conversation.
  const sessionMessages = useMemo(
    () =>
      state.messages.some(
        (message) => message.id === WORKTREE_PROVISION_MESSAGE_ID,
      )
        ? state.messages.filter(
            (message) => message.id !== WORKTREE_PROVISION_MESSAGE_ID,
          )
        : state.messages,
    [state.messages],
  );
  // Memoized because two transcript memos take it as a dependency, and both of
  // its `appendLiveMessagesAfterPreview` branches build a fresh array: as a bare
  // conditional it re-derived the whole transcript projection every render.
  const displayMessages = useMemo(
    () =>
      shownOptimisticSession
        ? staged.messages
        : usePreview
          ? // A reconnect preview can lag behind the in-memory transcript (notably
            // when /commit triggers a dev reload before the debounced preview save).
            // Keep its stable prefix for instant paint, but append any newer live rows
            // already held by the client instead of temporarily hiding them until the
            // replacement snapshot settles.
            appendLiveMessagesAfterPreview(
              sessionPreview!.messages,
              sessionMessages,
            )
          : routeSessionPending
            ? []
            : preservePreviewMessages
              ? appendLiveMessagesAfterPreview(
                  sessionPreview.messages,
                  sessionMessages,
                )
              : sessionMessages,
    [
      shownOptimisticSession,
      staged.messages,
      usePreview,
      sessionPreview,
      sessionMessages,
      routeSessionPending,
      preservePreviewMessages,
    ],
  );
  const displayContextInfo = shownOptimisticSession
    ? null
    : usePreview
      ? sessionPreview!.contextInfo
      : routeSessionPending
        ? null
        : state.contextInfo;
  // Live peer-prompt card lifecycle patches (Task 90/89 in-place reconciliation)
  // overlaid onto the rendered messages regardless of their source above.
  const displayMessagesWithPeerPromptOverrides = useMemo(
    () =>
      applyPeerPromptCardOverridesToMessages(
        displayMessages,
        state.peerPromptCardOverrides,
      ),
    [displayMessages, state.peerPromptCardOverrides],
  );
  const previewHasStreamingMessage =
    usePreview &&
    displayMessages.some(
      (message) => message.role === "assistant" && message.streaming,
    );
  const displayCurrentId = displaySession?.sessionId;
  // Read dwell follows the viewed route, not the Sessions browser: that browser
  // unmounts when another sidebar section is selected and on mobile object
  // screens, while the session itself stays open through both.
  const readCurrentSessionId = useSessionReadDwell(displayCurrentId);
  // A fork draft is a one-session handoff. The reducer retains the last one, so
  // never let a later composer remount stage it onto another session or the
  // shared new-session draft slot.
  const displayForkDraft = visibleSessionDraft(
    state.forkDraft,
    displayCurrentId,
  );
  // The composer took a staged draft. Only the fork draft lives in the reducer,
  // so only its token matches; the review handoffs are this component's own
  // state and are dropped where they are sent.
  const retireStagedDraft = useCallback(
    (token: number) => actions.retireSessionDraft(token),
    [actions],
  );
  const chatDraftStorageKey = composerDraftStorageKey(
    displayCurrentId,
    Boolean(shownOptimisticSession),
  );
  const chatComments = usePendingChatComments(chatDraftStorageKey);
  const [chatCommentDraft, setChatCommentDraft] = useState<Omit<
    NewPendingChatComment,
    "body"
  > | null>(null);
  const [chatCommentSelection, setChatCommentSelection] = useState<{
    quote: string;
    onComment: () => void;
  } | null>(null);
  const onChatCommentSelectionChange = useCallback(
    (selection: { quote: string; onComment: () => void } | null) =>
      setChatCommentSelection(selection),
    [],
  );
  // A transcript can unmount between session routes; clear its anchor in the
  // host as well as in MessageList so it cannot attach under the next session.
  useEffect(() => {
    setChatCommentDraft(null);
    setChatCommentSelection(null);
  }, [displayCurrentId]);
  const displayStreaming = shownOptimisticSession ? false : state.streaming;
  // The session bound to the selected calendar day (server read-model). The
  // calendar right panel is a Details inspector now (no embedded chat); "Open
  // day session" navigates to this id, so no auto-view is needed.
  const calendarDaySessionId = calendarRoute
    ? (calendarController.dayState?.daySessionId ?? null)
    : null;
  // "Log my time" seeds the day session server-side; when the binding then
  // surfaces in the read-model, jump into it once (covers the fresh-session case
  // where no id exists at click time).
  const [pendingLogTimeDate, setPendingLogTimeDate] = useState<string | null>(
    null,
  );
  // The windowed transcript's two halves: what precedes the rendered rows (the
  // server-computed turn-stats seed) and whether anything precedes them at all.
  // Both belong to the LIVE timeline only — a preview or a staged new-session
  // transcript renders rows this session state does not describe.
  const transcriptIsLiveTimeline = !shownOptimisticSession && !usePreview;
  const transcriptTurnStatsSeed = transcriptIsLiveTimeline
    ? state.turnStatsSeed
    : undefined;
  const hasOlderTimelineEntries =
    transcriptIsLiveTimeline && state.timelineStart > 0;
  const displayHasMessages = displayMessages.length > 0;
  // A live windowed transcript that projects to ZERO rows still has a session
  // behind it, and "Load earlier messages" is the only way back into it. Mounting
  // the transcript for it keeps that door open instead of dropping the reader on
  // the new-session surface (Task 450 — how a poisoned timeline cache became
  // unrecoverable from inside the app).
  const transcriptOnlyHasOlderMessages =
    !displayHasMessages && !routeSessionPending && hasOlderTimelineEntries;
  const displayHasUserPrompt = displayMessages.some(
    (message) => message.role === "user",
  );
  // The armed send is over once the conversation actually shows a prompt, once
  // the route lands on the created session, or once the server rejects it — at
  // which point the new-session surfaces must come back rather than stay hidden.
  useEffect(() => {
    setSendInFlight(false);
    // A staged send belongs to the surface it was dispatched from: leaving it —
    // which is what landing on the session it created looks like — is the end
    // of the bootstrap and of the retry that went with it.
    setStagedSend(null);
    // Plan is picked for ONE session, so leaving the staging surface spends it.
    // The rest of the staged record survives (the model and persona are
    // remembered picks, and a pi send never clears it — the server mints its own
    // id), but a Plan restored on a later landing puts the next session under a
    // tool policy nobody chose for it.
    if (route.name !== "new" && route.name !== "sessions") {
      setPendingStart((prev) => {
        if (!prev || prev.mode === undefined) return prev;
        const { mode: _spent, ...rest } = prev;
        return rest;
      });
    }
  }, [routeIdentity, route.name]);
  useEffect(() => {
    if (displayHasUserPrompt || state.error) setSendInFlight(false);
  }, [displayHasUserPrompt, state.error]);
  // PendingSessionPanel may be opening an ordinary deep link before the list
  // lands; a missing row is unknown, not evidence that naming is in progress.
  const pendingSessionTitle =
    route.name === "permanentAssistant"
      ? state.settings.permanentAssistant.name || "Personal Assistant"
      : route.name === "session"
        ? (state.sessions.find((session) => session.id === route.id)?.title ??
          "session")
        : "session";
  const displaySessionListItem = displayCurrentId
    ? state.sessions.find((session) => session.id === displayCurrentId)
    : undefined;

  // Primary-nav selection. On mobile the nav bar lives on the browser screen, so
  // picking a section stays in the browser: it navigates to that section's index
  // route. On desktop the sidebar and main pane are decoupled, so Settings and
  // Calendar (full main-pane surfaces) navigate and object sections only change
  // what the sidebar browses; leaving Settings (or the sectionless Usage surface)
  // returns to the chat we were in.
  const handleSidebarSectionChange = useCallback(
    (section: SidebarSection) => {
      setSidebarSection(section);
      if (mobileLayout) {
        navigate(sectionIndexPath(section));
      } else if (section === "settings") {
        if (route.name !== "settings") navigate(settingsPath("appearance"));
      } else if (section === "calendar") {
        if (route.name !== "calendar") navigate(calendarPath());
      } else if (section === "knowledge") {
        if (route.name === "settings" || route.name === "usage")
          navigate(knowledgePath());
      } else if (route.name === "settings" || route.name === "usage") {
        navigate(
          displayHasMessages && displayCurrentId
            ? sessionPath(displayCurrentId)
            : SESSIONS_CREATE_PATH,
        );
      }
    },
    [
      mobileLayout,
      route,
      navigate,
      displayHasMessages,
      displayCurrentId,
      setSidebarSection,
    ],
  );

  // The viewed session's worktree drives its change chips + "View changes"
  // link. Refetches on watcher status pushes (updatedAt), clears otherwise.
  const displayWorktreeId = displaySession?.worktreeId;
  const displayWorktreeStatus = displayWorktreeId
    ? state.worktreeStatuses[displayWorktreeId]
    : undefined;
  const worktreesSubscribed = activeTopics.includes("worktrees");
  const projectsSubscribed = activeTopics.includes("projects");
  // Cached rows paint immediately, but only an answer in THIS socket episode
  // is fresh. A visible topic subscription owns that answer when present;
  // otherwise this session surface performs one canonical read per slot. Keep
  // the effects separate so one list answering cannot re-request the other.
  useEffect(() => {
    if (
      !displayWorktreeId ||
      !state.connected ||
      worktreesSubscribed ||
      state.worktreesFresh
    )
      return;
    actions.listWorktrees();
  }, [
    displayWorktreeId,
    state.connected,
    worktreesSubscribed,
    state.worktreesFresh,
    actions,
  ]);
  useEffect(() => {
    if (
      !displayWorktreeId ||
      !state.connected ||
      projectsSubscribed ||
      state.projectListFresh
    )
      return;
    actions.listProjects({ includeArchived: true });
  }, [
    displayWorktreeId,
    state.connected,
    projectsSubscribed,
    state.projectListFresh,
    actions,
  ]);

  const taskIntakeSettingsOpen =
    route.name === "settings" && route.section === "task-intake";
  useEffect(() => {
    if (
      !state.connected ||
      !taskIntakeSettingsOpen ||
      projectsSubscribed ||
      state.projectListFresh
    )
      return;
    actions.listProjects({ includeArchived: true });
  }, [
    actions,
    projectsSubscribed,
    taskIntakeSettingsOpen,
    state.connected,
    state.projectListFresh,
  ]);

  // The worktree the open session runs in, for the header's dirty dot. Through
  // the registry like the rest: this is the same worktree a Task row and the
  // Worktrees browser may be showing, and the wire cannot tell three demands
  // apart.
  const displayWorktreeIds = useMemo(
    () => (displayWorktreeId ? [displayWorktreeId] : NO_WORKTREE_IDS),
    [displayWorktreeId],
  );
  useWorktreeWatches({
    ids: displayWorktreeIds,
    connected: state.connected,
    actions,
  });

  // The viewed worktree's uncommitted files, which turn paths inside the
  // transcript into openable diffs. The KEY is the worktree (a different
  // worktree's file list may never sit under this session, R3); a dirty-status
  // push is an invalidation of the same key, so the list is refetched without
  // being blanked first (R2). It decorates rows rather than owning a region, so
  // it has no placeholder of its own: until it answers there is simply nothing
  // to link, and the header's dirty dot is the surface's narration.
  const workspaceChangesKey =
    displayWorktreeId && displayWorktreeStatus?.dirty
      ? displayWorktreeId
      : null;
  const { state: workspaceChanges, reload: reloadWorkspaceChanges } =
    useFetchState<WorktreeChangesResponse>(
      workspaceChangesKey,
      loadWorkspaceChanges,
    );
  useReloadOnToken(
    workspaceChangesKey,
    displayWorktreeStatus?.updatedAt ?? 0,
    reloadWorkspaceChanges,
  );
  const workspaceChangedFiles =
    dataOf(workspaceChanges)?.files ?? NO_CHANGED_FILES;

  // The session list and the viewed session are read by row callbacks that must
  // stay referentially stable (the sidebar's rows are memoized, and the list
  // itself is rebroadcast up to ~4x/second): a `useCallback` over `state` would
  // hand every row a new identity on each broadcast.
  // `routeId` as well as `currentId`: a session the URL names but that is still
  // loading (clicked a moment ago) is left the same way as one on show, or the
  // route would wait forever for a session that is gone.
  const routeId = route.name === "session" ? route.id : undefined;
  const sessionListRef = useRef({
    sessions: state.sessions,
    currentId,
    routeId,
  });
  sessionListRef.current = { sessions: state.sessions, currentId, routeId };

  const deleteSession = useCallback(
    (id: string) => {
      const { sessions, currentId: viewed, routeId } = sessionListRef.current;
      if (!sessions.some((s) => s.id === id)) return;
      if (id === viewed || id === routeId) navigate(SESSIONS_CREATE_PATH);
      actions.deleteSession(id);
    },
    [actions, navigate],
  );

  // The server took a session away — deleted from another client while this one
  // showed it, or a load of it superseded by its deletion or archive. The URL
  // now names nothing; leave it for the staged new-session surface. Once per
  // arrival: a later deliberate open of an archived session must not bounce.
  const viewClearedHandledRef = useRef<UIState["viewCleared"]>(null);
  useEffect(() => {
    const cleared = state.viewCleared;
    if (!cleared || viewClearedHandledRef.current === cleared) return;
    viewClearedHandledRef.current = cleared;
    if (route.name === "session" && route.id === cleared.sessionId)
      navigate(SESSIONS_CREATE_PATH);
  }, [state.viewCleared, route, navigate]);

  // Every caller is a `() => void` action slot, so the ask runs detached rather
  // than returning a promise nobody waits for; `dialogs` settles on cancel
  // instead of rejecting, so there is nothing to catch.
  const confirmDeleteSession = useCallback(
    (id: string): void => {
      const target = sessionListRef.current.sessions.find((s) => s.id === id);
      const label = target?.title ? `“${target.title}”` : "this session";
      void dialogs
        .confirm({
          title: `Delete session ${label}?`,
          body: "This cannot be undone.",
          confirmLabel: "Delete",
          danger: true,
        })
        .then((confirmed) => {
          if (confirmed) deleteSession(id);
        });
    },
    [deleteSession, dialogs],
  );

  const archiveSession = useCallback(
    (id: string, archived = true) => {
      const { sessions, currentId: viewed, routeId } = sessionListRef.current;
      if (!sessions.some((s) => s.id === id)) return;
      if (archived && (id === viewed || id === routeId))
        navigate(SESSIONS_CREATE_PATH);
      actions.archiveSession(id, archived);
    },
    [actions, navigate],
  );

  // Opening a chat starts the read of its cached timeline prefix BEFORE the
  // navigation commits: `loadSession` needs that descriptor to be answered
  // tail-only, and this is the one moment where the wait costs nothing.
  const openSession = useCallback(
    (id: string) => {
      actions.warmSessionTimeline(id);
      navigate(sessionPath(id));
    },
    [actions, navigate],
  );
  // A link on a Backlog row's second line: it names an OBJECT and carries the
  // route to it, so one handler answers for the Task, the session, the worktree
  // and the Project alike. The session case still warms the timeline, exactly as
  // `openSession` does — the row's gutter and its chip lead to the same place and
  // must not arrive differently.
  const openBacklogRowLink = useCallback(
    (path: string) => {
      const sessionId = sessionIdFromPathname(path);
      if (sessionId) actions.warmSessionTimeline(sessionId);
      navigate(path);
    },
    [actions, navigate],
  );
  // The sidebar is memoized, so every handler it takes must be stable — an
  // inline arrow re-renders the whole left pane on each App render, which
  // during a streaming turn means up to ~60 times a second.
  /**
   * The open Knowledge entry's title, reported by the page once its document loads.
   * The dock's action row labels "Start session" and stages the review draft for a
   * NAMED entry, and only the loaded document knows that name.
   *
   * It carries the ADDRESS it was loaded for, because this state outlives the
   * route: `addressedPath` is the entry path the page was asked for, or null when
   * the route named an id. Without it, a path→path navigation reports entry A
   * while B is still loading, and anything reading the id (the dock's label, the
   * failure home below) would speak for A under B's URL.
   */
  const [knowledgeEntry, setKnowledgeEntry] = useState<{
    id: string;
    title: string;
    addressedPath: string | null;
  } | null>(null);
  const rememberKnowledgeEntry = useCallback(
    (id: string, title: string, addressedPath: string | null) => {
      setKnowledgeEntry((current) =>
        current?.id === id &&
        current.title === title &&
        current.addressedPath === addressedPath
          ? current
          : { id, title, addressedPath },
      );
    },
    [],
  );
  const openCalendarView = useCallback(
    (view: "month" | "week" | "day") =>
      navigate(calendarPath(view, todayIso(userTimeZone))),
    [navigate, userTimeZone],
  );
  const openProject = useCallback(
    (id: string) => navigate(projectPath(id)),
    [navigate],
  );
  const openKnowledgeEntry = useCallback(
    (entryId: string) => navigate(knowledgePath(entryId)),
    [navigate],
  );
  const openInvalidKnowledgeEntry = useCallback(
    (path: string) => navigate(knowledgeEntryPath(path)),
    [navigate],
  );
  const openKnowledgeFile = useCallback(
    (path: string) => navigate(knowledgeFilePath(path)),
    [navigate],
  );
  /**
   * The entry the right panel's Knowledge tab is reading, or null while it is
   * browsing the tree. It is panel state, not route state: the panel exists to
   * read an entry BESIDE whatever the main pane is on, so the URL keeps naming
   * the main pane's object.
   */
  const [knowledgePanelEntryId, setKnowledgePanelEntryId] = useState<
    string | null
  >(null);
  /** The panel a card elsewhere in the app asked the right panel to show. */
  const [rightPanelOpenRequest, setRightPanelOpenRequest] = useState<{
    panel: PanelId;
    nonce: number;
  } | null>(null);
  const openKnowledgeInSidePanel = useCallback(
    (entryId: string) => {
      setKnowledgePanelEntryId(entryId);
      setInspectorOpen(true);
      // The nonce counts requests rather than reading the clock: two cards
      // opened inside one millisecond are two requests, and the second must
      // still bring the tab forward if the user has since selected another.
      setRightPanelOpenRequest((current) => ({
        panel: "knowledge",
        nonce: (current?.nonce ?? 0) + 1,
      }));
    },
    [setInspectorOpen],
  );
  /**
   * Where a Knowledge entry named anywhere in the app opens. The side panel is
   * a desktop surface (`app/web/docs/ui-shell.md`, Small Screens): on a phone
   * the right panel is the object dock and has no tabs, so a card there offers
   * the route alone rather than an action that would go nowhere.
   */
  const knowledgeOpenTargets = useMemo<KnowledgeOpenTargets>(
    () => ({
      openInMain: openKnowledgeEntry,
      ...(mobileLayout ? {} : { openInPanel: openKnowledgeInSidePanel }),
    }),
    [mobileLayout, openKnowledgeEntry, openKnowledgeInSidePanel],
  );
  /**
   * The panel's entry when it is actually READABLE: this layout has right-panel
   * tabs, the panel is open, and Knowledge is the active one. The panel draws
   * that entry's failure note in place, so it may only CLAIM the entry's
   * failures while the reader can see it — a note behind an unselected tab
   * would suppress the announcement and show nothing (`lib/messageArrival.ts`).
   */
  const visibleKnowledgePanelEntryId =
    !mobileLayout && inspectorOpen && activeRightPanel === "knowledge"
      ? knowledgePanelEntryId
      : null;
  const openSettingsSection = useCallback(
    (section: SettingsSection) => navigate(settingsPath(section)),
    [navigate],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      if (!sessionListRef.current.sessions.some((s) => s.id === id)) return;
      actions.renameSession(id, title);
    },
    [actions],
  );

  /**
   * The one rename flow for a session, wherever it is asked for: list row,
   * inspector, chat header menu. The sidebar's rows are memoized, so this and
   * `settleSession` below must stay referentially stable — see `sessionListRef`
   * above.
   */
  const promptRenameSession = useCallback(
    (id: string): void => {
      const target = sessionListRef.current.sessions.find((s) => s.id === id);
      if (!target) return;
      // As with `confirmDeleteSession`: a `() => void` slot, and the ask
      // settles rather than rejecting.
      void dialogs
        .promptText({
          title: "Rename session",
          label: "Session name",
          defaultValue: target.title,
        })
        .then((title) => {
          if (title && title !== target.title) renameSession(id, title);
        });
    },
    [dialogs, renameSession],
  );

  /**
   * Settle a session out of the Sessions inbox working set (or bring it back).
   * Deliberately does NOT navigate: unlike archive, a settled session stays
   * readable and stays visible in the shelf, so settling what you are reading
   * must not throw you out of it.
   */
  const settleSession = useCallback(
    (id: string, settled: boolean) => {
      if (!sessionListRef.current.sessions.some((s) => s.id === id)) return;
      actions.settleSession(id, settled);
    },
    [actions],
  );

  /** Settle a Workflow Run out of the inbox; same stability contract. */
  const settleWorkflowRun = useCallback(
    (runId: string, throughRevision: number) =>
      actions.settleWorkflowRun(runId, throughRevision),
    [actions],
  );

  // Backlog data for the sidebar's Backlog tab. The list can be unloaded (null)
  // until the tab or a Task detail route requests it.
  const backlogTasks = useMemo(
    () => state.taskList?.items ?? [],
    [state.taskList],
  );
  const backlogLoaded = state.taskList !== null;
  const selectedTaskId = route.name === "tasks" ? (route.id ?? null) : null;
  const selectedStatusMutation = selectedTaskId
    ? state.taskMutations[taskMutationKey(selectedTaskId, "status")]
    : undefined;
  const selectedRenameMutation = selectedTaskId
    ? state.taskMutations[taskMutationKey(selectedTaskId, "rename")]
    : undefined;
  const selectedDescriptionMutation = selectedTaskId
    ? state.taskMutations[taskMutationKey(selectedTaskId, "description")]
    : undefined;
  const selectedCommentMutation = selectedTaskId
    ? state.taskMutations[taskMutationKey(selectedTaskId, "comment")]
    : undefined;
  const selectedTaskMutations = useMemo(() => {
    const projection: UIState["taskMutations"] = {};
    if (!selectedTaskId) return projection;
    if (selectedStatusMutation)
      projection[taskMutationKey(selectedTaskId, "status")] =
        selectedStatusMutation;
    if (selectedRenameMutation)
      projection[taskMutationKey(selectedTaskId, "rename")] =
        selectedRenameMutation;
    if (selectedDescriptionMutation)
      projection[taskMutationKey(selectedTaskId, "description")] =
        selectedDescriptionMutation;
    if (selectedCommentMutation)
      projection[taskMutationKey(selectedTaskId, "comment")] =
        selectedCommentMutation;
    return projection;
  }, [
    selectedTaskId,
    selectedStatusMutation,
    selectedRenameMutation,
    selectedDescriptionMutation,
    selectedCommentMutation,
  ]);
  const selectedTaskWorkflowRuns = useMemo(
    () =>
      state.workflowRuns?.filter((run) => run.taskId === selectedTaskId) ??
      state.workflowRuns,
    [selectedTaskId, state.workflowRuns],
  );
  const selectedTaskWorkflowCards = useMemo(() => {
    if (!selectedTaskWorkflowRuns) return {};
    return Object.fromEntries(
      selectedTaskWorkflowRuns.flatMap((run) => {
        const card = state.workflowCards[run.id];
        return card ? [[run.id, card]] : [];
      }),
    );
  }, [selectedTaskWorkflowRuns, state.workflowCards]);
  const projects = useMemo(
    () => state.projectList?.projects ?? [],
    [state.projectList],
  );
  const projectsLoaded = state.projectList !== null;
  /**
   * The slices the Backlog surfaces read, as one object whose identity changes
   * only when one of them does. `Sidebar` is memoized, and it is the left pane
   * of every screen: handing it the whole `UIState` would re-render its browser
   * (and the Backlog's ~220 rows) on every streamed token.
   */
  // Gated on the facts a Backlog row reads (`lib/sessionRows.ts`): which
  // sessions exist, stream, are archived, where they run, and what they are
  // called. The list itself is rebroadcast up to ~4x/second and almost never
  // changes any of them.
  const backlogSessionKey = backlogSessionsKey(state.sessions);
  // oxlint-disable-next-line react/exhaustive-deps -- `backlogSessionKey` IS the Backlog-visible content of `state.sessions` (`lib/sessionRows.ts` enumerates it); depending on the array would re-render the memoized Sidebar (~220 rows) on every rebroadcast, which is the whole point of the gate
  const backlogSessions = useMemo(() => state.sessions, [backlogSessionKey]);
  // Archiving from the inspector answers to the same rules (and produces the
  // same Undo receipt) as archiving from the list; `useBacklog` builds the
  // identical context for its own surfaces. It reads the GATED session array
  // for the same reason that array exists: the ungated one is rebroadcast
  // ~4x/second, and this asks it one question that rarely changes.
  const taskArchiveContext = useMemo<ArchiveContext>(
    () => ({
      tasks: backlogTasks,
      sessionById: new Map(backlogSessions.map((s) => [s.id, s])),
    }),
    [backlogTasks, backlogSessions],
  );
  const backlogState = useMemo<BacklogState>(
    () => ({
      connected: state.connected,
      taskList: state.taskList,
      taskListError: state.taskListError,
      projectList: state.projectList,
      taskMutations: state.taskMutations,
      taskProjectsAssignedSeq: state.taskProjectsAssignedSeq,
      worktreeMerge: state.worktreeMerge,
      sessions: backlogSessions,
    }),
    [
      state.connected,
      state.taskList,
      state.taskListError,
      state.projectList,
      state.taskMutations,
      state.taskProjectsAssignedSeq,
      state.worktreeMerge,
      backlogSessions,
    ],
  );
  const projectIdForWorktree = useCallback(
    (worktreeId: string | null | undefined): string | null => {
      if (!worktreeId) return null;
      return (
        state.worktrees?.find((worktree) => worktree.id === worktreeId)
          ?.projectId ?? null
      );
    },
    [state.worktrees],
  );
  const projectIdForTask = useCallback(
    (taskId: string | null | undefined): string | null => {
      if (!taskId) return null;
      return backlogTasks.find((task) => task.id === taskId)?.projectId ?? null;
    },
    [backlogTasks],
  );
  const selectedProjectId =
    route.name === "projects" ? (route.id ?? null) : null;
  const selectedWorktreeId =
    route.name === "worktrees" ? (route.id ?? null) : null;
  const selectedDeleteState = selectedProjectId
    ? state.projectMutations[`${selectedProjectId}:delete`]
    : undefined;
  useEffect(() => {
    if (
      !selectedProjectId ||
      !selectedDeleteState ||
      dataOf(selectedDeleteState) !== true ||
      projects.some((project) => project.id === selectedProjectId)
    )
      return;
    openSidebarSection("projects");
  }, [openSidebarSection, projects, selectedDeleteState, selectedProjectId]);
  const activeSettingsSection =
    route.name === "settings" ? (route.section ?? null) : null;
  const selectedKnowledgeEntryId =
    route.name === "knowledge" ? (route.entryId ?? null) : null;
  const selectedKnowledgeEntryPath =
    route.name === "knowledge" ? (route.entryPath ?? null) : null;
  const selectedKnowledgeFilePath =
    route.name === "knowledge" ? (route.filePath ?? null) : null;
  // Newest committed KB change this client has heard about; the sidebar tree is
  // an HTTP read model, so agent-created entries need this to become visible.
  const knowledgeChangedAt = useMemo(
    () =>
      Object.values(state.knowledgeChangedAt).reduce(
        (newest, at) => Math.max(newest, at),
        0,
      ),
    [state.knowledgeChangedAt],
  );
  // Includes archived so stale assignments still resolve names in badges/selectors.
  const projectsById = useMemo(() => buildProjectsById(projects), [projects]);
  const selectedTaskDetailState = selectedTaskId
    ? state.taskDetails[selectedTaskId]
    : undefined;
  const selectedProjectDetailState = selectedProjectId
    ? state.projectDetails[selectedProjectId]
    : undefined;
  const objectLinkUrisToResolve = useMemo(() => {
    // The Task list carries summaries only, so the body to scan for pa:// links
    // is the on-demand detail the open Task page fetched (absent until it lands).
    const selectedTaskDetail = selectedTaskDetailState;
    const selectedTaskBody = selectedTaskDetail
      ? dataOf(selectedTaskDetail)?.description
      : undefined;
    const selectedProject = selectedProjectDetailState
      ? dataOf(selectedProjectDetailState)
      : undefined;
    return [
      ...new Set([
        ...mentionedPaUris(displayMessages),
        ...extractPaObjectLinkUris(selectedTaskBody ?? ""),
        ...extractPaObjectLinkUris(selectedProject?.description ?? ""),
      ]),
    ];
  }, [displayMessages, selectedTaskDetailState, selectedProjectDetailState]);

  const builtPaObjectReferences = useMemo(() => {
    const refs = new Map<string, PaObjectLinkResolution>();
    const add = (ref: PaObjectLinkResolution) => refs.set(ref.uri, ref);
    for (const session of state.sessions)
      add(appObjectLink("session", session.id, session.title));
    for (const task of backlogTasks)
      add(appObjectLink("task", task.id, task.title));
    for (const project of projects)
      add(appObjectLink("project", project.id, project.name));
    for (const worktree of state.worktrees ?? [])
      add(
        appObjectLink(
          "worktree",
          worktree.id,
          paWorktreeTitle(worktree, projectsById.get(worktree.projectId)?.name),
        ),
      );
    for (const resolved of Object.values(state.objectLinks)) add(resolved);
    // After the server's answers, so the viewed session's own cards win: those
    // are live, where a resolved answer is a cached copy of a changing status.
    for (const card of approvalCardsOf(state.approvals))
      add({
        ...appObjectLink("approval", card.id, card.title),
        href: approvalCardHref(card.sessionId, card.id),
        detail: approvalStatusDetail(card.status),
      });
    return Array.from(refs.values());
  }, [
    state.sessions,
    backlogTasks,
    projects,
    state.worktrees,
    projectsById,
    state.objectLinks,
    state.approvals,
  ]);
  // Everything a rendered `pa://` link is made of. Rebuilding this list is cheap;
  // letting its IDENTITY change is not. It feeds `Markdown`, whose memo it
  // breaks — re-running the whole remark → rehype → sanitize pipeline for every
  // message in the transcript — and the session list alone is rebroadcast up to
  // ~4x/second while any agent runs, with brand-new row objects that almost
  // never change a title. So gate identity on the content, exactly as
  // `MessageList`'s `sessionReferences` does.
  //
  // Narrowed to the objects the rendered text actually MENTIONS first, because
  // the content gate alone still has every session, Task, project and worktree
  // in it: naming one new session — which the server does from the first prompt
  // of every session anyone starts — was a content change, and re-rendered every
  // message in the open transcript for a title no rendered link asks for. The
  // scan is `objectLinkUrisToResolve`, already computed above with the SAME
  // extractor the renderer resolves with, so a link that will be looked up is a
  // link that survives this filter.
  const mentionedObjectKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const uri of objectLinkUrisToResolve) {
      const parsed = parsePaObjectLink(uri);
      if (parsed) keys.add(paObjectKey(parsed));
    }
    return keys;
  }, [objectLinkUrisToResolve]);
  const mentionedPaObjectReferences = useMemo(
    () =>
      builtPaObjectReferences.filter((ref) =>
        mentionedObjectKeys.has(paObjectKey(ref)),
      ),
    [builtPaObjectReferences, mentionedObjectKeys],
  );
  const referenceKey = useMemo(
    () => paObjectReferenceKey(mentionedPaObjectReferences),
    [mentionedPaObjectReferences],
  );
  const paObjectReferences = useMemo(
    () => mentionedPaObjectReferences,
    // oxlint-disable-next-line react/exhaustive-deps -- `referenceKey` IS the content of `mentionedPaObjectReferences`; depending on the array would hand the transcript new link props on every broadcast that touched a mentioned object
    [referenceKey],
  );

  const selectedProjectWorktreeCache = useRef<{
    key: string;
    value: WorktreeRecord[];
  }>({ key: "", value: [] });
  const selectedProjectWorktreeRows = selectedProjectId
    ? (state.worktrees ?? []).filter(
        (worktree) => worktree.projectId === selectedProjectId,
      )
    : [];
  const selectedProjectWorktreeKey = JSON.stringify(
    selectedProjectWorktreeRows,
  );
  if (selectedProjectWorktreeCache.current.key !== selectedProjectWorktreeKey)
    selectedProjectWorktreeCache.current = {
      key: selectedProjectWorktreeKey,
      value: selectedProjectWorktreeRows,
    };
  const projectWorktreesLoaded = state.worktrees !== null;
  // The CACHED array, not the key: its identity already changes exactly when
  // the key does (the write just above), so it is a dependency the rule can
  // check — where the key was one the memo never read.
  const selectedProjectWorktreeItems =
    selectedProjectWorktreeCache.current.value;
  const selectedProjectWorktreeState = useMemo(() => {
    const rows = selectedProjectWorktreeItems;
    if (state.worktreeListError)
      return failed(
        state.worktreeListError,
        projectWorktreesLoaded ? rows : undefined,
      );
    if (!projectWorktreesLoaded) return loading<WorktreeRecord[]>();
    return state.worktreesFresh ? ready(rows) : refreshing(rows);
  }, [
    selectedProjectWorktreeItems,
    state.worktreeListError,
    projectWorktreesLoaded,
    state.worktreesFresh,
  ]);
  useEffect(() => {
    if (!state.connected || objectLinkUrisToResolve.length === 0) return;
    const missing = objectLinkUrisToResolve.filter(
      (uri) =>
        !state.objectLinks[uri] &&
        !objectLinkCoveredByReferences(uri, paObjectReferences) &&
        !requestedObjectLinkUris.current.has(uri),
    );
    if (missing.length === 0) return;
    for (const uri of missing) requestedObjectLinkUris.current.add(uri);
    actions.resolveObjectLinks(createClientId(), missing);
  }, [
    actions,
    objectLinkUrisToResolve,
    paObjectReferences,
    state.connected,
    state.objectLinks,
  ]);
  const loadBacklog = useCallback(() => actions.listTasks({}), [actions]);
  const loadProjects = useCallback(
    () => actions.listProjects({ includeArchived: true }),
    [actions],
  );
  const cycleTaskStatus = useCallback(
    (item: Task) =>
      actions.saveTask({
        id: item.id,
        status: nextStatus(item.status),
      }),
    [actions],
  );
  // Answering an agent's status suggestion from a transcript card: the SAME save
  // the Backlog Focus row sends (`acceptStatusSuggestionSave`). It resumes no
  // session, so answering here costs no provider call, and it carries no title,
  // so a card recorded before a rename cannot undo it.
  const applyTaskStatusSuggestion = useCallback(
    (task: { id: string; status: TaskStatus }) =>
      actions.saveTask(
        acceptStatusSuggestionSave({ id: task.id, to: task.status }),
      ),
    [actions],
  );
  const reorderBacklog = useCallback(
    (
      orderedIds: string[],
      placements: { id: string; parentId?: string | null }[],
    ) => actions.reorderTasks(orderedIds, placements),
    [actions],
  );
  const reorderProjects = useCallback(
    (
      orderedIds: string[],
      placements: { id: string; parentId?: string | null }[],
    ) => actions.reorderProjects(orderedIds, placements),
    [actions],
  );

  // The id is the whole of what this reads, and it must stay referentially
  // stable for the memoized transcript rows that carry it.
  const forkSourceSessionId = state.session?.sessionId;
  const forkMessage = useCallback(
    (entryId: string, position: "before" | "at") => {
      if (!forkSourceSessionId) return;
      actions.forkSession(forkSourceSessionId, entryId, position);
    },
    [actions, forkSourceSessionId],
  );

  // Resend a prompt into the SAME session: it lands in the composer for the user
  // to send, which is the only safe repeat when a turn may have failed after
  // tool calls already ran.
  const resendPrompt = useCallback(
    (text: string) => {
      if (!displayCurrentId) return;
      actions.stageSessionDraft(displayCurrentId, text);
    },
    [actions, displayCurrentId],
  );

  // The transcript's display flags as ONE memoized object: every message row is
  // memoized, so a flip costs one referential comparison per row instead of five
  // (see components/transcriptView.ts).
  const transcriptView = useMemo<TranscriptViewPrefs>(
    () => ({
      showThinking: prefs.showThinking,
      showTools: prefs.showTools,
      expandThinking: prefs.expandThinking,
      expandTools: prefs.expandTools,
      wrapToolLines: prefs.wrapToolLines,
    }),
    [
      prefs.showThinking,
      prefs.showTools,
      prefs.expandThinking,
      prefs.expandTools,
      prefs.wrapToolLines,
    ],
  );

  // The transcript's own hold on the reading position, registered by
  // `MessageList` while it is mounted (`hooks/useTranscriptScroll.ts`). It lives
  // up here because only the party that CHANGES a display preference knows a
  // change is coming, and the layout the hold measures is gone once it renders.
  const transcriptViewHold = useRef<(() => void) | null>(null);
  const registerTranscriptViewHold = useCallback(
    (hold: (() => void) | null) => {
      transcriptViewHold.current = hold;
    },
    [],
  );

  // Expanding every block in a long transcript is heavy even after the viewport
  // gate; as a transition React can interrupt it, so the menu keeps responding
  // and the toggle's own checkmark paints immediately. The hold runs FIRST, in
  // this event and outside the transition: every one of these flags mounts,
  // unmounts or re-measures rows, and the reader is somewhere in the middle of
  // them (Task-351).
  const updateTranscriptView = useCallback(
    (patch: Partial<TranscriptViewPrefs>) => {
      transcriptViewHold.current?.();
      startTransition(() => update(patch));
    },
    [update],
  );

  // Stable, because the dock row's own "new session" control hangs off it: an identity
  // that changed every render would recompute that row's memo on every render with it.
  const startNewChat = useCallback(() => {
    setPendingProjectContext(null);
    setPendingKnowledgeContext(null);
    setPendingWorktreeContext(null);
    setPendingWorktreeReview(null);
    setSessionReviewDraft(null);
    setPendingStart(null);
    navigate(SESSIONS_CREATE_PATH);
    setComposerFocusToken((token) => token + 1);
  }, [navigate]);

  // Stage a fresh session optimistically. No server session is created and the
  // URL is NOT changed yet; the real session is established by the first prompt's
  // harnessSend. For pi the server mints the final id, while non-pi keeps the
  // staged client id.
  const startStagedSession = useCallback(
    (opts: {
      id?: string;
      harness: Harness;
      agentType: AgentType;
      provider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
      /**
       * Build/Plan, stated by every caller (undefined = Build). A RESTAGE for one
       * axis (model, thinking, persona, account) passes the record's own mode on;
       * a fresh entry point — a Task, a worktree, the `/review` handoff — passes
       * none, because Plan belongs to the session it was picked for and must not
       * travel to the next one behind the user's back.
       */
      mode: SessionMode | undefined;
    }) => {
      flushSync(() => {
        setPendingStart({
          id: opts.id ?? createClientId(),
          harness: opts.harness,
          agentType: opts.agentType,
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
          ...(opts.modelId !== undefined ? { modelId: opts.modelId } : {}),
          thinkingLevel: opts.thinkingLevel ?? "off",
          // Only the personas WITH the mode axis can carry Plan, so a switch to
          // an assistant persona drops it rather than hiding it.
          ...(hasModeAxis({ agentType: opts.agentType }) &&
          opts.mode !== undefined
            ? { mode: opts.mode }
            : {}),
        });
      });
      // Only pull focus back to the composer on desktop. On mobile every staging
      // control (agent type / model / thinking) is changed from inside the Runtime
      // dock sheet, so focusing the textarea there just pops the virtual keyboard
      // over the sheet the user is still interacting with.
      if (!mobileLayout) setComposerFocusToken((token) => token + 1);
    },
    [mobileLayout],
  );

  // Switch the new-chat agent type (hero row + composer pickers). Client
  // staging only; the server session is created on the first prompt. A
  // Developer pick without a staged worktree needs no extra nudge here — the
  // send-blocked hint above the composer carries it.
  const switchStagedAgentType = useCallback(
    (
      agentType: AgentType,
      opts?: {
        /**
         * This staging BEGINS a session rather than editing the one being
         * staged, so nothing is carried over from the record on screen.
         *
         * A fresh entry point (`startSessionForTask`) clears `pendingStart` and
         * then reaches this helper through `stageWorktreeContext`; its clear is
         * still queued, so `current` below is the record it just replaced — and
         * the `flushSync` here would write that record's Plan back AFTER the
         * clear lands. The flag is how the caller says which of the two this is.
         */
        fresh?: boolean;
      },
    ) => {
      const current = opts?.fresh ? undefined : (pendingStart ?? stagedStart);
      // Off the new-session route there is no staged record yet (the route
      // fallback below only exists on `new`/`sessions`), so a persona switch
      // made WHILE staging — `startSessionForTask` staging the Task's worktree,
      // say — used to invent a record with the bare "pi" harness and no model
      // while the pickers went on showing the remembered (possibly Claude)
      // default. Stage that visible default instead of a contradiction, which
      // also keeps its thinking level rather than resetting to "off".
      const runtime =
        current?.provider && current.modelId
          ? {
              harness: current.harness,
              provider: current.provider,
              modelId: current.modelId,
              thinkingLevel: current.thinkingLevel,
            }
          : newSessionRuntimeDefaults(
              defaultNewSessionModel,
              defaultNewSessionThinking,
            );
      startStagedSession({
        ...(!(current?.id === "pending-pi-session")
          ? { ...(current?.id !== undefined ? { id: current?.id } : {}) }
          : {}),
        agentType,
        ...runtime,
        // Restage of the SAME staged session: the mode picked for it survives a
        // persona switch (`startStagedSession` drops it where the axis is gone).
        // A fresh start has no `current`, so it stages Build.
        mode: current?.mode,
      });
    },
    [
      pendingStart,
      stagedStart,
      startStagedSession,
      defaultNewSessionModel,
      defaultNewSessionThinking,
    ],
  );

  // Composable staged-context derivation (project ⊃ worktree, project ⊃ task):
  // picking a worktree/task fills in the project, and re-picking the project
  // drops a worktree/task that no longer belongs to it. Knowledge context is a
  // separate entry start path, so explicitly picking a project/worktree/task
  // clears any staged Knowledge entry/review.
  const stageProjectContext = useCallback(
    (projectId: string | null) => {
      setPendingKnowledgeContext(null);
      const norm = projectId?.trim() || null;
      setPendingProjectContext(norm);
      // Re-picking the project can drop the staged worktree; a staged Developer
      // must fall back to Assistant with it (same rule as removing the chip).
      const dropsWorktree = Boolean(
        pendingWorktreeContext &&
        (!norm || projectIdForWorktree(pendingWorktreeContext) !== norm),
      );
      if (dropsWorktree) setPendingWorktreeReview(null);
      // A staged NEW worktree has no identity yet, so switching the project
      // RETARGETS it (you still want a fresh checkout, now over there) rather
      // than cancelling and bouncing the persona. Only clearing the project
      // cancels it: there is then no repository to create it in.
      const dropsNewWorktree = pendingNewWorktree && !norm;
      if (dropsNewWorktree) setPendingNewWorktree(false);
      if (
        (dropsWorktree || dropsNewWorktree) &&
        (pendingStart ?? stagedStart)?.agentType === "developer"
      )
        switchStagedAgentType("assistant");
      if (!norm) {
        setPendingWorktreeContext(null);
        return;
      }
      setPendingWorktreeContext((cur) =>
        cur && projectIdForWorktree(cur) !== norm ? null : cur,
      );
      setPendingTaskAttach((cur) =>
        cur && projectIdForTask(cur.taskId) !== norm ? null : cur,
      );
    },
    [
      projectIdForWorktree,
      projectIdForTask,
      pendingWorktreeContext,
      pendingNewWorktree,
      pendingStart,
      stagedStart,
      switchStagedAgentType,
    ],
  );
  const stageWorktreeContext = useCallback(
    (
      worktreeId: string | null,
      /** Passed straight to `switchStagedAgentType` — see its `fresh`. */
      opts?: { fresh?: boolean },
    ) => {
      setPendingKnowledgeContext(null);
      if (
        pendingWorktreeReview &&
        pendingWorktreeReview.worktreeId !== worktreeId
      )
        setPendingWorktreeReview(null);
      setPendingWorktreeContext(worktreeId);
      setPendingNewWorktree(false);
      const pid = projectIdForWorktree(worktreeId);
      if (pid) setPendingProjectContext(pid);
      // Worktree ⇒ coding persona: staging one switches the new chat to the
      // coding agent, and removing it drops a staged Developer back to the
      // Assistant so a worktree-less Developer session can never be sent. A
      // fresh start compares against the persona a fresh record HAS, not the one
      // on screen: reading the record it is replacing (whose clear is queued)
      // both skipped the switch it needs and carried that record's mode.
      const stagedAgent = opts?.fresh
        ? "assistant"
        : ((pendingStart ?? stagedStart)?.agentType ?? "assistant");
      if (worktreeId && !isCodingAgentType(stagedAgent))
        switchStagedAgentType(defaultCodingAgentType, opts);
      else if (!worktreeId && stagedAgent === "developer")
        switchStagedAgentType("assistant", opts);
    },
    [
      projectIdForWorktree,
      pendingStart,
      stagedStart,
      switchStagedAgentType,
      defaultCodingAgentType,
      pendingWorktreeReview,
    ],
  );
  /**
   * Stage (or unstage) "+ New worktree". It replaces a staged worktree and
   * satisfies the Developer guard exactly as a real one does — the checkout is
   * simply created by the first send instead of beforehand — so it takes the
   * same persona coupling: staging switches to the coding agent, unstaging
   * takes a Developer back to the Assistant.
   */
  const stageNewWorktree = useCallback(
    (staged: boolean) => {
      setPendingKnowledgeContext(null);
      setPendingWorktreeReview(null);
      setPendingWorktreeContext(null);
      setPendingNewWorktree(staged);
      const stagedAgent =
        (pendingStart ?? stagedStart)?.agentType ?? "assistant";
      if (staged && !isCodingAgentType(stagedAgent))
        switchStagedAgentType(defaultCodingAgentType);
      else if (!staged && stagedAgent === "developer")
        switchStagedAgentType("assistant");
    },
    [pendingStart, stagedStart, switchStagedAgentType, defaultCodingAgentType],
  );
  // Which worktree a Task is being implemented in. ONE helper for every entry
  // point, so the Task page and the quick-start's Task row cannot drift — they
  // used to disagree, the row staging a worktree and the page clearing one.
  const worktreeIdForTask = useCallback(
    (taskId: string): string | undefined =>
      worktreeForTask(
        taskId,
        state.worktrees,
        sessionListRef.current.sessions,
        backlogTasks,
      ),
    [state.worktrees, backlogTasks],
  );
  const stageTaskContext = useCallback(
    (task: { taskId: string; title: string } | null) => {
      setPendingKnowledgeContext(null);
      if (task) setPendingWorktreeReview(null);
      setPendingTaskAttach(task);
      const pid = task ? projectIdForTask(task.taskId) : null;
      if (pid) setPendingProjectContext(pid);
      // One-tap resume: a Task already being worked somewhere stages that
      // worktree too, and with it the coding persona. It never CLEARS one —
      // picking a Task must not undo a worktree the picker's own field set.
      if (!task) return;
      const derived = worktreeIdForTask(task.taskId);
      if (derived && derived !== pendingWorktreeContext)
        stageWorktreeContext(derived);
    },
    [
      projectIdForTask,
      worktreeIdForTask,
      pendingWorktreeContext,
      stageWorktreeContext,
    ],
  );

  // After starting a session from an object, land the user on the new-session
  // page: collapse the dock sheet ON MOBILE, where it is a full-screen overlay
  // that would otherwise hide the create surface entirely, and pull focus to the
  // composer. On a wide layout the panel covers nothing, so it stays exactly as
  // the user left it (ui-shell.md: the object panel is pure user state). The
  // `/sessions/create` route itself takes care of leaving the browser screen on
  // mobile.
  const revealNewSessionSurface = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    setComposerFocusToken((token) => token + 1);
  }, [mobileLayout, setInspectorOpen]);

  // Start a fresh session to work on a Backlog Task: stage the Task exactly like
  // tapping it in the new-session page (which also derives its Project so the
  // Worktree row scopes to it), then land on the new-session page.
  const startSessionForTask = useCallback(
    (taskId: string, title: string) => {
      setPendingKnowledgeContext(null);
      setPendingWorktreeReview(null);
      setSessionReviewDraft(null);
      setPendingStart(null);
      setPendingTaskAttach({ taskId, title });
      // Derive the Task's Project (same as stageTaskContext) so worktrees/tasks
      // narrow to it; a Task with no project leaves the scope global.
      setPendingProjectContext(projectIdForTask(taskId));
      // …and the worktree it is being implemented in, through the same helper the
      // quick-start's Task row uses. `stageWorktreeContext` rather than a bare
      // setter, so the Developer coupling applies exactly as it does there —
      // `fresh`, because this start REPLACES the staged record cleared above
      // rather than editing it (a Plan staged for the previous one would
      // otherwise be written back after that clear).
      stageWorktreeContext(worktreeIdForTask(taskId) ?? null, { fresh: true });
      navigate(SESSIONS_CREATE_PATH);
      revealNewSessionSurface();
    },
    [
      projectIdForTask,
      worktreeIdForTask,
      stageWorktreeContext,
      navigate,
      revealNewSessionSurface,
    ],
  );

  // Start a fresh session with a Project staged as initial context for the
  // first prompt (the composer shows it as removable staged context).
  const startSessionForProject = useCallback(
    (projectId: string) => {
      setPendingTaskAttach(null);
      setPendingKnowledgeContext(null);
      setPendingStart(null);
      setPendingWorktreeContext(null);
      setPendingWorktreeReview(null);
      setSessionReviewDraft(null);
      setPendingProjectContext(projectId);
      navigate(SESSIONS_CREATE_PATH);
      revealNewSessionSurface();
    },
    [navigate, revealNewSessionSurface],
  );

  // Start a fresh session with a Knowledge entry staged as initial context (the
  // composer shows it as a removable chip; the entry's inspector "Start session"
  // action and plain per-entry starts route here).
  const startSessionForKnowledge = useCallback(
    (entryId: string, title: string) => {
      setPendingTaskAttach(null);
      setPendingProjectContext(null);
      setPendingWorktreeContext(null);
      setPendingWorktreeReview(null);
      setSessionReviewDraft(null);
      setPendingStart(null);
      setPendingKnowledgeContext({ entryId, title });
      navigate(SESSIONS_CREATE_PATH);
      revealNewSessionSurface();
    },
    [navigate, revealNewSessionSurface],
  );

  // Following a comment link from the worktree panel's roster: the panel is the
  // one place the comments are listed now (mirroring Knowledge), so it is
  // cross-pane — collapse the dock sheet on
  // mobile (it covers the diff) and hand the page the comment to land on.
  const openWorktreeComment = useCallback(
    (worktreeId: string, commentId: string) => {
      if (mobileLayout) setInspectorOpen(false);
      setWorktreeCommentToOpen({ worktreeId, commentId, nonce: Date.now() });
    },
    [mobileLayout, setInspectorOpen],
  );

  const openWorktree = useCallback(
    (id: string) => {
      navigate(worktreePath(id));
    },
    [navigate],
  );
  const openPullRequest = useCallback(
    (target: PullRequestTarget) => navigate(pullRequestPath(target)),
    [navigate],
  );

  // One `CommentActions` object per worktree, held for as long as the app runs.
  // It reaches pierre through the review surfaces' comment config, which they
  // compare by identity — an object literal built in this render would re-render
  // every open diff for every broadcast, which is what made the gutter's comment
  // affordance blink under the reader's pointer.
  const worktreeCommentActionsCache = useRef(new Map<string, CommentActions>());
  const worktreeCommentActionsFor = useCallback(
    (worktreeId: string): CommentActions => {
      const held = worktreeCommentActionsCache.current.get(worktreeId);
      if (held) return held;
      const made: CommentActions = {
        onAddComment: ({ body, path, line, parentId, ref, selectors }) =>
          actions.addWorktreeComment({
            worktreeId,
            body,
            ...(parentId
              ? { parentId }
              : {
                  anchor: {
                    path,
                    side: "new",
                    line,
                    ...(ref ? { ref } : {}),
                    ...(selectors ? { selectors } : {}),
                  },
                }),
          }),
        onResolveComment: (commentId, resolved) =>
          actions.resolveWorktreeComment(commentId, resolved),
        onDeleteComment: (commentId) =>
          actions.deleteWorktreeComment(commentId),
      };
      worktreeCommentActionsCache.current.set(worktreeId, made);
      return made;
    },
    [actions],
  );

  // Stage a fresh session whose first prompt executes in the worktree: the
  // create-on-first-prompt flow (harnessSend) carries the worktreeId; until
  // then the worktree shows as removable staged context in the inspector.
  // Project AND the checkout's single implementing Task come from the shared
  // derivation rule (lib/sessionHandoff.ts), so starting here lands with the
  // same context the work already has instead of a bare worktree.
  const startSessionInWorktree = useCallback(
    (worktreeId: string) => {
      const context = sessionContextForWorktree(
        worktreeId,
        state.worktrees,
        sessionListRef.current.sessions,
        backlogTasks,
      );
      setPendingTaskAttach(context.task ?? null);
      setPendingKnowledgeContext(null);
      setPendingWorktreeReview(null);
      setSessionReviewDraft(null);
      setPendingProjectContext(context.projectId ?? null);
      setPendingWorktreeContext(worktreeId);
      navigate(SESSIONS_CREATE_PATH);
      // Mobile only: the sheet is a full-screen overlay over the surface we are
      // landing on. A wide layout leaves the panel exactly as the user set it.
      if (mobileLayout) setInspectorOpen(false);
      startStagedSession({
        ...newSessionRuntimeDefaults(
          defaultNewSessionModel,
          defaultNewSessionThinking,
        ),
        agentType: defaultCodingAgentType,
      });
    },
    [
      state.worktrees,
      backlogTasks,
      navigate,
      mobileLayout,
      setInspectorOpen,
      startStagedSession,
      defaultNewSessionModel,
      defaultNewSessionThinking,
      defaultCodingAgentType,
    ],
  );

  /**
   * The Pull Requests view's Review, once its checkout exists on the server.
   *
   * The SAME staging path as the worktree review below and the `/review`
   * handoff — staged project/worktree/Task plus a prefilled, editable draft —
   * because a second one would drift from it. Nothing is sent: the composer
   * lands with the prompt in it and runtime, persona and the text itself are
   * the user's. The navigation IS the confirmation, so nothing announces it.
   */
  const startPullRequestReviewDraft = useCallback(
    (
      item: PullRequestInventoryItem,
      worktreeId: string,
      outcome: PullRequestCheckoutOutcome,
    ) => {
      // WHICH Task is decided by server ids only — the checkout's own edges
      // from this very answer, then the pull request's links — so a cold or
      // stale browser list can never be read as "there is no Task". The lists
      // travel WITH their currency for what they alone can answer
      // (`lib/sessionHandoff.ts`).
      const context = pullRequestReviewContext(
        {
          worktreeId,
          projectId: item.projectId,
          checkoutTaskIds: outcome.status === "refused" ? [] : outcome.taskIds,
          pullRequestTaskIds: item.taskIds,
        },
        {
          sessions: {
            rows: sessionListRef.current.sessions,
            fresh: state.sessionListFresh,
          },
          tasks: { rows: backlogTasks, fresh: state.taskListFresh },
        },
      );
      setPendingTaskAttach(context.task ?? null);
      setPendingKnowledgeContext(null);
      setPendingWorktreeReview(null);
      setPendingProjectContext(context.projectId ?? item.projectId);
      setPendingWorktreeContext(worktreeId);
      setSessionReviewDraft({
        sessionId: "pending-pull-request-review",
        text: buildPullRequestReviewPrompt(item),
        token: Date.now(),
      });
      navigate(SESSIONS_CREATE_PATH);
      // Mobile only: the sheet is a full-screen overlay over the surface we are
      // landing on. A wide layout leaves the panel exactly as the user set it.
      if (mobileLayout) setInspectorOpen(false);
      startStagedSession({
        ...newSessionRuntimeDefaults(
          defaultNewSessionModel,
          defaultNewSessionThinking,
        ),
        agentType: reviewAgentType(context, defaultCodingAgentType),
      });
    },
    [
      backlogTasks,
      state.sessionListFresh,
      state.taskListFresh,
      navigate,
      mobileLayout,
      setInspectorOpen,
      startStagedSession,
      defaultNewSessionModel,
      defaultNewSessionThinking,
      defaultCodingAgentType,
    ],
  );

  // A review handoff is a normal, editable new-session draft rather than an
  // immediate server-side spawn. The structured thread ids stay staged beside
  // the worktree while the standard landing owns model/thinking/persona choice.
  const startWorktreeReviewDraft = useCallback(
    (worktreeId: string, commentIds: string[]) => {
      // Shared context-derivation rule (lib/sessionHandoff.ts, also behind
      // /review and a plain start in a worktree): the draft inherits the
      // worktree's project AND its single implementing Task, so the review
      // session gets the Task context injected and shows on the Task's trace
      // instead of hanging off nothing.
      const context = sessionContextForWorktree(
        worktreeId,
        state.worktrees,
        sessionListRef.current.sessions,
        backlogTasks,
      );
      setPendingTaskAttach(context.task ?? null);
      setPendingKnowledgeContext(null);
      setSessionReviewDraft(null);
      setPendingProjectContext(context.projectId ?? null);
      setPendingWorktreeContext(worktreeId);
      const reviewSetSelection = isReviewSetSelection(
        state.worktreeComments[worktreeId] ?? [],
        commentIds,
      );
      setPendingWorktreeReview({
        worktreeId,
        commentIds,
        commentCount: commentIds.length,
        draft: {
          sessionId: "pending-worktree-review",
          text: reviewSetSelection
            ? `${DEFAULT_WORKTREE_REVIEW_PROMPT}\n\n${REVIEW_SET_CLAIMS_PROMPT}`
            : DEFAULT_WORKTREE_REVIEW_PROMPT,
          token: Date.now(),
        },
      });
      navigate(SESSIONS_CREATE_PATH);
      // Mobile only: the sheet is a full-screen overlay over the surface we are
      // landing on. A wide layout leaves the panel exactly as the user set it.
      if (mobileLayout) setInspectorOpen(false);
      startStagedSession({
        ...newSessionRuntimeDefaults(
          defaultNewSessionModel,
          defaultNewSessionThinking,
        ),
        agentType: defaultCodingAgentType,
      });
    },
    [
      state.worktrees,
      state.worktreeComments,
      backlogTasks,
      navigate,
      mobileLayout,
      setInspectorOpen,
      startStagedSession,
      defaultNewSessionModel,
      defaultNewSessionThinking,
      defaultCodingAgentType,
    ],
  );

  /**
   * The `/review` handoff — the OTHER DIRECTION of the review loop from
   * `submitWorktreeReview` (an agent reviews the work, rather than my comments
   * going to an agent): land on the new-session page with a short code-review
   * draft naming the source session and its Task/worktree/project staged,
   * while the standard landing keeps model/provider/thinking pickable. Runtime
   * is the normal new-session default, NOT the source session's — a review
   * wants an independent look. Returns an inline error for the composer, or
   * null when the handoff landed.
   */
  const startReviewSessionForSession = useCallback(
    (extraText = ""): string | null => {
      const sourceId = displayCurrentId;
      if (!sourceId || !displayHasUserPrompt)
        return "Nothing to review yet — this session has no work to look at.";
      const context = reviewContextForSession(
        {
          sessionId: sourceId,
          ...(displaySession?.worktreeId !== undefined
            ? { worktreeId: displaySession?.worktreeId }
            : {}),
          ...(displaySessionListItem?.projectId !== undefined
            ? { projectId: displaySessionListItem?.projectId }
            : {}),
          ...(displaySession?.originTask !== undefined
            ? { originTask: displaySession?.originTask }
            : {}),
        },
        state.worktrees,
        sessionListRef.current.sessions,
        backlogTasks,
      );
      setPendingTaskAttach(context.task ?? null);
      setPendingKnowledgeContext(null);
      setPendingWorktreeReview(null);
      setPendingProjectContext(context.projectId ?? null);
      setPendingWorktreeContext(context.worktreeId ?? null);
      setSessionReviewDraft({
        sessionId: "pending-session-review",
        text: buildSessionReviewPrompt(sourceId, extraText),
        token: Date.now(),
      });
      navigate(SESSIONS_CREATE_PATH);
      // Mobile only: the sheet is a full-screen overlay over the surface we are
      // landing on. A wide layout leaves the panel exactly as the user set it.
      if (mobileLayout) setInspectorOpen(false);
      startStagedSession({
        ...newSessionRuntimeDefaults(
          defaultNewSessionModel,
          defaultNewSessionThinking,
        ),
        agentType: reviewAgentType(context, defaultCodingAgentType),
      });
      return null;
    },
    [
      displayCurrentId,
      displayHasUserPrompt,
      displaySession?.worktreeId,
      displaySession?.originTask,
      displaySessionListItem?.projectId,
      state.worktrees,
      backlogTasks,
      navigate,
      mobileLayout,
      setInspectorOpen,
      startStagedSession,
      defaultNewSessionModel,
      defaultNewSessionThinking,
      defaultCodingAgentType,
    ],
  );

  /**
   * Client-executed slash commands (`SlashCommandInfo.execution === "client"`)
   * from the main chat composer. One registry, one help list — only the
   * dispatch point differs from host commands.
   */
  const runClientSlashCommand = useCallback(
    (name: string, rawArgs: string): string | null => {
      if (name === "review") return startReviewSessionForSession(rawArgs);
      return `/${name} is not available here.`;
    },
    [startReviewSessionForSession],
  );

  /**
   * Threads the worktree dock's submit action hands over, once a target is
   * picked — WITH the worktree they were written on. Two surfaces submit now
   * (the route's page and the right panel's Worktree tab, which follows the
   * session rather than the route), so the sheet cannot read its target off the
   * address bar: beside a session it would find no worktree at all, and beside
   * another worktree's page it would find the wrong one.
   */
  const [worktreeSubmission, setWorktreeSubmission] = useState<{
    worktreeId: string;
    commentIds: string[];
  } | null>(null);

  /**
   * Sending a document's comment tray (`components/DocumentComments.tsx`): its
   * comments MOVE into the chosen session's composer, and the reader follows
   * them there to add a message and send. A new session receives them on the
   * new-session page. The phone's dock sheet collapses, since both land on a
   * different screen than the one it is covering. A move storage refused
   * leaves the tray as it was and stays put: the tray reports it in place.
   */
  const sendDocumentComments = useCallback(
    async (
      trayKey: string,
      target: SendCommentsTarget,
    ): Promise<string | null> => {
      const moved = await moveTrayToOutbox(
        trayKey,
        target.kind === "existing"
          ? composerDraftStorageKey(target.sessionId, false)
          : composerDraftStorageKey(null, true),
      );
      if ("error" in moved) return moved.error;
      if (mobileLayout) setInspectorOpen(false);
      if (target.kind === "existing") {
        navigate(sessionPath(target.sessionId));
        return null;
      }
      navigate(SESSIONS_CREATE_PATH);
      revealNewSessionSurface();
      return null;
    },
    [mobileLayout, navigate, revealNewSessionSurface, setInspectorOpen],
  );

  /**
   * Submitting a worktree review: the ONE path, shared by the page's roster and the
   * dock's action.
   */
  const submitWorktreeReview = useCallback(
    (worktreeId: string, commentIds: string[], target: SendCommentsTarget) => {
      if (target.kind === "new") {
        startWorktreeReviewDraft(worktreeId, commentIds);
        return;
      }
      const claims = isReviewSetSelection(
        state.worktreeComments[worktreeId] ?? [],
        commentIds,
      )
        ? REVIEW_SET_CLAIMS_PROMPT
        : "";
      const additionalPrompt = [target.additionalPrompt, claims]
        .filter(Boolean)
        .join("\n\n");
      actions.attachWorktreeComments({
        worktreeId,
        commentIds,
        target: {
          kind: "existing",
          sessionId: target.sessionId,
          ...(additionalPrompt ? { additionalPrompt } : {}),
        },
      });
    },
    [actions, startWorktreeReviewDraft, state.worktreeComments],
  );

  // Worktree lifecycle dialogs (create / merge / remove) live in one lazy
  // overlay mount driven by this state.
  const [worktreeOverlay, setWorktreeOverlay] = useState<{
    createForProjectId: string | null;
    mergeWorktreeId: string | null;
    removeWorktreeId: string | null;
  }>({
    createForProjectId: null,
    mergeWorktreeId: null,
    removeWorktreeId: null,
  });

  const createWorktreeForProject = useCallback((projectId: string) => {
    setWorktreeOverlay({
      createForProjectId: projectId,
      mergeWorktreeId: null,
      removeWorktreeId: null,
    });
  }, []);

  const forkParentSessionId = displaySession?.forkOrigin?.parentSessionId;
  const forkParentEntryId = displaySession?.forkOrigin?.parentEntryId;
  // Both halves of the jump go through the reveal: the server answers where the
  // entry sits, which is what lets the transcript load back to it rather than
  // landing at the parent's tail whenever the origin is older than its window.
  const openForkOrigin = useCallback(() => {
    if (forkParentSessionId && forkParentEntryId)
      actions.revealTimelineEntry(forkParentSessionId, forkParentEntryId);
    else if (forkParentSessionId) navigate(sessionPath(forkParentSessionId));
  }, [actions, forkParentEntryId, forkParentSessionId, navigate]);

  // The transcript's fork-boundary marker: the parent's title, and the same
  // "open the source message" jump the branch panel offers. Kept off
  // `state.sessions` identity so an unrelated session-list update does not hand
  // the transcript a new object (see `src/CLAUDE.md`).
  const forkParentTitle = forkParentSessionId
    ? state.sessions.find((s) => s.id === forkParentSessionId)?.title
    : undefined;

  // A focus is only ever the viewed transcript's business, and it has to stay
  // referentially stable while it says the same thing (see `src/CLAUDE.md`):
  // the transcript re-runs its jump on a new object.
  const focusedSessionId = messageFocus?.sessionId;
  const focusedEntryId = messageFocus?.entryId;
  const focusToken = messageFocus?.token;
  const viewedSessionId = displaySession?.sessionId;
  const transcriptFocusEntry = useMemo(
    () =>
      focusedEntryId && focusToken && focusedSessionId === viewedSessionId
        ? { entryId: focusedEntryId, token: focusToken }
        : null,
    [focusedEntryId, focusToken, focusedSessionId, viewedSessionId],
  );
  // A jump is spent once the transcript lands on it: keeping it would replay the
  // jump the next time this session is opened, over the reader's own position —
  // and `useAssistant` would walk that session's fresh tail back to the old
  // anchor to make it possible. Both halves retire together.
  const retireMessageFocus = useCallback(
    (token: number) => {
      setMessageFocus((current) => (current?.token === token ? null : current));
      actions.retireMessageReveal(token);
    },
    [actions],
  );
  // A pending comment's row, reached from the composer's comment list: the same
  // jump a deep link makes, minus the server round trip — the row it annotates
  // is one this transcript has already rendered. `Math.max` keeps the token
  // moving even for two clicks inside one millisecond.
  // A document comment's row opens its document instead, at its lines when
  // it has them.
  const revealChatComment = useCallback(
    (comment: PendingChatComment) => {
      if (isDocumentComment(comment)) {
        const document = comment.anchor.document;
        navigate(
          document.kind === "knowledgeEntry"
            ? knowledgePath(document.entryId)
            : documentTargetHref({
                kind: "hostFile",
                path: document.path,
                ...(comment.lines
                  ? {
                      anchor: {
                        start: comment.lines.start,
                        ...(comment.lines.end > comment.lines.start
                          ? { end: comment.lines.end }
                          : {}),
                      },
                    }
                  : {}),
              }),
        );
        return;
      }
      const { sessionId, entryId } = comment.anchor;
      setMessageFocus((current) => ({
        sessionId,
        entryId,
        token: Math.max(Date.now(), (current?.token ?? 0) + 1),
      }));
    },
    [navigate],
  );
  const transcriptForkBoundary = useMemo(
    () =>
      forkParentSessionId
        ? {
            parentTitle: forkParentTitle ?? "parent session",
            onOpen: openForkOrigin,
          }
        : undefined,
    [forkParentSessionId, forkParentTitle, openForkOrigin],
  );

  const branchInfo = useMemo<BranchPanelInfo | null>(() => {
    const current = displaySession;
    if (!current) return null;
    const currentItem = state.sessions.find((s) => s.id === current.sessionId);
    const currentTitle = currentItem?.title ?? "Current session";
    const origin = current.forkOrigin;
    const parentItem = origin
      ? state.sessions.find(
          (s) => origin.parentSessionId && s.id === origin.parentSessionId,
        )
      : undefined;
    const children = state.sessions
      .filter((s) => {
        const childOrigin = s.forkOrigin;
        if (!childOrigin) return false;
        return childOrigin.parentSessionId === current.sessionId;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((child) => ({
        id: child.id,
        title: child.title,
        subtitle: "Forked from this session",
        onOpen: () => navigate(sessionPath(child.id)),
      }));

    const parentId = origin
      ? (origin.parentSessionId ?? origin.parentSessionFile)
      : undefined;
    if (!origin && children.length === 0) return null;
    return {
      currentTitle,
      ...(parentId !== undefined
        ? {
            parent: {
              id: parentId,
              title: parentItem?.title ?? "Parent session",
              subtitle: origin?.parentEntryId
                ? "Open source message"
                : "Open parent session",
              onOpen: openForkOrigin,
            },
          }
        : {}),
      children,
    };
  }, [displaySession, state.sessions, navigate, openForkOrigin]);

  const currentContextInfo =
    displayContextInfo?.sessionId === displayCurrentId
      ? displayContextInfo
      : null;
  const currentThinkingLevel = displaySession?.thinkingLevel ?? "off";
  // The displayed session's harness/agentType (server-populated, or staged on the
  // optimistic session). Defaults to a fresh pi assistant on the new-chat landing.
  const displayHarness: Harness = displaySession?.harness ?? "pi";
  const displayAgentType: AgentType = displaySession?.agentType ?? "assistant";
  // On the new-chat landing, show the agent-type picker in the Composer top-left.
  // It stays visible for a staged (optimistic) non-pi session too — staging a
  // Claude model must not look like the chat already started; the picker only
  // disappears once the session actually has messages (i.e. after the first
  // prompt, which also navigates to /sessions/<id> off this route).
  const isNewChatRoute = route.name === "new" || route.name === "sessions";
  /** This browser's own worktree-provisioning card reports a failed checkout. */
  const provisionFailed =
    provisionCardOwned && state.worktreeProvision?.state === "failed";
  const showAgentTypePicker =
    isNewChatRoute && !displayHasMessages && availableAgentTypes.length > 1;
  // The composable staged-context bar (Project + Worktree + Task, plus a staged
  // Knowledge entry / comment-review bundle) shows on a fresh new-chat surface.
  const showContextPicker =
    isNewChatRoute && !displayHasUserPrompt && !sendInFlight;
  // Developer sessions require a worktree (server-enforced): while one is
  // staged without it, sending is blocked and the composer hint/auto-open
  // steer to the Worktree picker. A staged "+ New worktree" satisfies it — the
  // first send provisions one before the session exists.
  const newSessionNeedsWorktree =
    isNewChatRoute &&
    !displayHasUserPrompt &&
    !sendInFlight &&
    displayAgentType === "developer" &&
    !pendingWorktreeContext &&
    !pendingNewWorktree;
  // The worktree an EXISTING session ran in is gone (Task 321). The server
  // refuses every run until the user acknowledges running in the app directory,
  // so the composer stays disabled behind the banner that offers exactly that.
  const worktreeMissing = Boolean(displaySession?.worktreeMissing);
  const acknowledgeMissingWorktree = useCallback(() => {
    if (displayCurrentId) actions.acknowledgeMissingWorktree(displayCurrentId);
  }, [actions, displayCurrentId]);
  const credentialProfileSendBlockedReason =
    isNewChatRoute && !displayHasUserPrompt && !sendInFlight
      ? credentialProfileProjectionBlockReason(
          credentialProfileFetch.state,
          credentialProfileId,
          Object.hasOwn(credentialProfileModels, credentialProfileId)
            ? pickerModels
            : undefined,
          displaySession?.model,
        )
      : undefined;
  const credentialProfileSendBlocked =
    isNewChatRoute &&
    !displayHasUserPrompt &&
    !sendInFlight &&
    credentialProfileProjectionBlocksSend(credentialProfileFetch.state);
  // Worktrees for the new-session pickers (hero row + context sheet), most
  // recently worked-on first (session activity, falling back to the record).
  const orderedWorktrees = useMemo(
    () => orderWorktreesByActivity(state.worktrees ?? [], state.sessions),
    [state.worktrees, state.sessions],
  );
  // Projects share the picker-only recency rule: the browser keeps its stable
  // registry order, while selection surfaces lead with recently active work.
  const orderedPickerProjects = useMemo(
    () => orderProjectsByActivity(projects, state.sessions, backlogTasks),
    [projects, state.sessions, backlogTasks],
  );
  // The optimistic session shell (`lib/newSessionShell.ts`): from the first send
  // until the URL lands on the session it created, this surface renders as if
  // that session existed. Its context comes from the HELD send once the pickers
  // have been cleared by that send — the staged values are gone by then, and
  // rebuilding the identity from empty pickers would blank the header mid-boot.
  const stagedWorktreeId =
    stagedSend?.input?.worktreeId ?? pendingWorktreeContext;
  const stagedProjectId = stagedSend?.input
    ? (stagedSend.input.projectId ?? stagedSend.input.createWorktreeInProjectId)
    : pendingProjectContext;
  const modelNameValue =
    displaySession?.model?.name ?? displaySession?.model?.id;
  const worktreeNameValue = orderedWorktrees.find(
    (worktree) => worktree.id === stagedWorktreeId,
  )?.branch;
  const projectNameValue = projects.find(
    (project) => project.id === stagedProjectId,
  )?.name;
  const sessionShell = newSessionShell({
    isNewChatRoute,
    firstSendPending,
    ...(displaySessionListItem?.title !== undefined
      ? {
          sessionTitle: displaySessionListItem.title,
          sessionTitleGenerationPending:
            displaySessionListItem.titleGenerationPending === true,
        }
      : {}),
    autoNamingEnabled: state.settings.sessionNaming.enabled,
    ...(modelNameValue !== undefined ? { modelName: modelNameValue } : {}),
    ...(stagedWorktreeId
      ? {
          ...(worktreeNameValue !== undefined
            ? { worktreeName: worktreeNameValue }
            : {}),
        }
      : {}),
    newWorktree: stagedSend?.input
      ? Boolean(stagedSend.input.createWorktreeInProjectId)
      : pendingNewWorktree,
    ...(stagedProjectId
      ? {
          ...(projectNameValue !== undefined
            ? { projectName: projectNameValue }
            : {}),
        }
      : {}),
    agentResponding:
      displayStreaming ||
      // The provisioning card is an assistant row that is not the agent talking.
      displayMessages.some(
        (message) =>
          message.role === "assistant" &&
          message.id !== WORKTREE_PROVISION_MESSAGE_ID,
      ),
    worktreeNarrationVisible: provisionCardOwned,
    provisionFailed,
    error: state.error,
    sendLanded: staged.landed,
  });
  /**
   * The staged send reported a blocker AND created nothing (`retryable`). Both
   * halves matter: a failure claim is also a claim that this send can be run
   * again, and once its session exists running it again makes a second one.
   * Only `landed` settles that — the error itself cannot, since a plain server
   * error carries nothing to correlate it with this send.
   */
  const firstSendFailed = sessionShell.retryable;
  /**
   * A failed first send may have created NO session at all — provisioning that
   * never produced a checkout, a model the account cannot run. The surface must
   * therefore stay in first-send mode: an ordinary `prompt` would be driven into
   * whichever session this connection still views (there is no detach message),
   * silently starting a turn somewhere else entirely. The next composer send
   * re-issues the held first send instead, carrying the new text under its
   * original clientRequestId so the prompt shows once.
   *
   * Only a `harnessSend` can be re-issued that way. A review handoff has no
   * such input, so the composer's next send falls through to an ordinary first
   * send — which creates its own session and therefore cannot misdeliver
   * either; its own Retry (the narration's) is what re-runs the handoff.
   */
  const firstSendRetryPending = firstSendFailed && stagedSend?.input != null;
  // The new-session screen needs no header on a phone: it said "New Session" over
  // a screen that is visibly a new session, its subtitle described a session that
  // does not exist yet (down to a Copy session ID for a draft), and back moved to
  // the dock's row. Once the first prompt is sent that stops being true — the
  // screen is a session being created, and the row carries the identity the
  // transcript never states plus the bootstrap's progress.
  const chatHeaderHidden =
    mobileLayout && route.name === "new" && !sessionShell.bootstrapping;
  const displaySessionTitle =
    route.name === "permanentAssistant"
      ? state.settings.permanentAssistant.name || "Personal Assistant"
      : isNewChatRoute
        ? sessionShell.title
        : (displaySessionListItem?.title ??
          (route.name === "session" ? UNLABELED_SESSION_TITLE : "New Session"));
  const displaySessionTitleGenerationPending =
    route.name !== "permanentAssistant" &&
    (isNewChatRoute
      ? sessionShell.titleGenerationPending
      : displaySessionListItem?.titleGenerationPending === true);
  const sessionTitleHeading = (
    <h2 className="truncate text-body font-semibold tracking-tight text-fg">
      <SessionTitleText
        title={displaySessionTitle}
        pending={displaySessionTitleGenerationPending}
      />
    </h2>
  );
  const stagedContextBar: StagedContextData | undefined = showContextPicker
    ? {
        value: {
          projectId: pendingProjectContext,
          worktreeId: pendingWorktreeContext,
          newWorktree: pendingNewWorktree,
          task: pendingTaskAttach,
          review: pendingWorktreeReview
            ? { commentCount: pendingWorktreeReview.commentCount }
            : null,
          knowledge: pendingKnowledgeContext,
        },
        projects: orderedPickerProjects,
        worktrees: orderedWorktrees,
        tasks: backlogTasks,
        // Subscription answers distinguish a genuinely empty list from a cold
        // one. Tasks stay cold until this panel reports its Task field open.
        projectsLoaded,
        worktreesLoaded: state.worktrees !== null,
        tasksLoaded: backlogLoaded,
        onChangeProject: stageProjectContext,
        onChangeWorktree: stageWorktreeContext,
        onChangeNewWorktree: stageNewWorktree,
        onChangeTask: stageTaskContext,
        onTaskPickerOpenChange: setTaskPickerOpen,
        onChangeReview: () => setPendingWorktreeReview(null),
        onChangeKnowledge: () => setPendingKnowledgeContext(null),
        // Reuse the left-panel Backlog list for the Task field: same rows,
        // status/project filtering, and drag UI. When a project is already
        // staged we pin it as the fixed filter (the picker already scopes to it);
        // otherwise the list's own project filter is available.
        renderTaskPicker: () => (
          <Suspense
            fallback={
              <div className="px-1 py-2 text-caption text-faint">
                Loading tasks…
              </div>
            }
          >
            <BacklogList
              state={state}
              actions={actions}
              prefs={prefs}
              onUpdatePrefs={update}
              selectedId={pendingTaskAttach?.taskId ?? null}
              onOpenTask={(id) => {
                const task = backlogTasks.find((t) => t.id === id);
                stageTaskContext(
                  task ? { taskId: task.id, title: task.title } : null,
                );
              }}
              fixedProjectId={pendingProjectContext ?? undefined}
              // A picker, with no secondary affordances to hit: 28px is fine for
              // tapping a full-width row, and the field it sits in has no room
              // for a second line per Task.
              density="tight"
            />
          </Suspense>
        ),
      }
    : undefined;
  // The agentType applied to whatever harness the new chat picks (the top-left
  // agent picker drives this for ALL harnesses now).
  const agentTypeForPicker: AgentType = displayAgentType;

  // Model/provider locking is scoped to the displayed session's own first user
  // prompt. Fresh new-chat routes and unprompted sessions must remain free to
  // switch provider, regardless of any other session that was previously active.
  const runtimeHasStarted = isNewChatRoute ? false : displayHasUserPrompt;
  // Full option (capabilities included) behind a provider/model pair. The picker
  // list alone is not enough on an account switch: the pair being staged comes
  // from the profile the user is switching TO, whose models are not in
  // `pickerModels` until `credentialProfileId` state catches up.
  const findModelOption = useCallback(
    (provider: string, id: string): ModelOption | undefined => {
      const matches = (model: ModelOption) =>
        model.provider === provider && model.id === id;
      return (
        pickerModels.find(matches) ??
        Object.values(credentialProfileModels).flat().find(matches) ??
        state.models.find(matches)
      );
    },
    [pickerModels, credentialProfileModels, state.models],
  );
  const runtimeActions = useMemo<AssistantActions>(
    () => ({
      ...actions,
      setModel: (provider, id) => {
        // Keep the new-session profile aligned even when this was an existing
        // session's model picker: otherwise lastModelKey can point at a model
        // the separately remembered profile filters out on the next new chat.
        const profileProvider =
          provider === CLAUDE_SDK_PROVIDER ? "claude" : "openai-codex";
        const explicitProfileId = explicitProfileForNextModel.current;
        explicitProfileForNextModel.current = null;
        const selectedProfile =
          activeCredentialProfiles.find(
            (profile) =>
              profile.id === explicitProfileId &&
              profile.provider === profileProvider,
          ) ??
          activeCredentialProfiles.find(
            (profile) =>
              profile.id === credentialProfileId &&
              profile.provider === profileProvider,
          ) ??
          activeCredentialProfiles.find(
            (profile) => profile.provider === profileProvider,
          );
        if (selectedProfile) setCredentialProfileId(selectedProfile.id);
        // Remember this explicit pick as the default for future new chats. The
        // profile sync effect is the sole persistence writer for its selection.
        update({ lastModelKey: modelKey({ provider, id }) });
        // Provider implies the harness: claude-sdk→claude-sdk, anything else→pi.
        // The agentType comes from the top-left agent picker, applied to every
        // harness.
        const harness: Harness =
          provider === CLAUDE_SDK_PROVIDER ? "claude-sdk" : "pi";
        if (isNewChatRoute && !runtimeHasStarted) {
          startStagedSession({
            // Keep the staged identity across a harness switch too: it keys the
            // composer's per-session state, so minting a fresh id here threw
            // away an already-typed prompt (or a staged /review draft) the
            // moment the user moved from Claude to OpenAI or back.
            ...(pendingStart?.id !== undefined ? { id: pendingStart?.id } : {}),
            harness,
            agentType: agentTypeForPicker,
            provider,
            modelId: id,
            // Levels are not portable between models (Claude has no
            // minimal/max, some Claude models no off): keep the user's level
            // where the target accepts it and map it to the nearest one it does.
            thinkingLevel: clampThinkingLevelForModel(
              findModelOption(provider, id),
              currentThinkingLevel,
            ),
            // Restage: changing the model does not change the staged mode.
            mode: (pendingStart ?? stagedStart)?.mode,
          });
          return;
        }

        if (isOptimisticHarness(harness)) {
          actions.setModel(provider, id);
          return;
        }

        actions.setModel(provider, id);
      },
      setThinkingLevel: (level) => {
        // Remember this explicit pick as the default for future new chats.
        update({ lastThinkingLevel: level });
        if (isNewChatRoute && !runtimeHasStarted) {
          const current = pendingStart ?? stagedStart;
          startStagedSession({
            ...(!(current?.id === "pending-pi-session")
              ? { ...(current?.id !== undefined ? { id: current?.id } : {}) }
              : {}),
            harness: displayHarness,
            agentType: agentTypeForPicker,
            ...(current?.provider !== undefined
              ? { provider: current?.provider }
              : {}),
            ...(current?.modelId !== undefined
              ? { modelId: current?.modelId }
              : {}),
            thinkingLevel: level,
            // Restage: changing the thinking level does not change the mode.
            mode: current?.mode,
          });
        } else {
          actions.setThinkingLevel(level);
        }
      },
      setSessionMode: (mode) => {
        // Staged: mode is client state until the first send creates the
        // session. Live: the server record is authoritative and echoes back
        // through the session state broadcast.
        if (isNewChatRoute && !runtimeHasStarted) {
          const current = pendingStart ?? stagedStart;
          startStagedSession({
            ...(!(current?.id === "pending-pi-session")
              ? { ...(current?.id !== undefined ? { id: current?.id } : {}) }
              : {}),
            harness: displayHarness,
            agentType: agentTypeForPicker,
            ...(current?.provider !== undefined
              ? { provider: current?.provider }
              : {}),
            ...(current?.modelId !== undefined
              ? { modelId: current?.modelId }
              : {}),
            thinkingLevel: current?.thinkingLevel ?? currentThinkingLevel,
            mode,
          });
        } else {
          actions.setSessionMode(mode);
        }
      },
    }),
    [
      actions,
      isNewChatRoute,
      runtimeHasStarted,
      displayHarness,
      currentThinkingLevel,
      startStagedSession,
      pendingStart,
      stagedStart,
      agentTypeForPicker,
      activeCredentialProfiles,
      credentialProfileId,
      findModelOption,
      update,
    ],
  );
  // Capability-driven picker locking: non-pi harnesses pin model/thinking after
  // their first turn (see lib/sessionCapabilities.locksModelAfterStart).
  const modelLocked = displaySession
    ? locksModelAfterStart(displaySession) && runtimeHasStarted
    : false;
  const thinkingLocked = modelLocked;
  // Claude SDK models belong only to Claude-driven sessions; disable them in a
  // started pi session. Non-pi sessions are exempt from this restriction.
  const isModelDisabled = useCallback(
    (model: ModelOption) =>
      modelLocked ||
      (displayHarness === "pi" && runtimeHasStarted && isClaudeSdkModel(model)),
    [modelLocked, displayHarness, runtimeHasStarted],
  );
  const sessionTasks = displaySession?.tasks ?? [];
  const relatedGlobalTasks = displaySession?.relatedGlobalTasks ?? [];
  const sessionOriginTask = displaySession?.originTask;
  const chatHeaderGlyph = sessionHeaderIcon("session", {
    harness: displayHarness,
    agentType: displayAgentType,
  }).icon;
  // A staged session has no durable id to fingerprint and no plan to count: the
  // second line carries the identity the user picked instead (model, and where
  // the session will run), and the copy affordance waits for a real id.
  const copySessionId =
    displayCurrentId && !shownOptimisticSession
      ? () => {
          void copyWithToast(displayCurrentId, {
            successMessage: "Session ID copied",
          }).then((ok) => {
            if (!ok) return;
            setSessionIdCopied(true);
            window.setTimeout(() => setSessionIdCopied(false), 1200);
          });
        }
      : undefined;
  const sessionArtifacts = displaySession?.artifacts ?? [];
  const pendingPostReloadContinuation =
    displaySession?.pendingPostReloadContinuation;
  const browserRuntimes = displaySession?.browserRuntimes ?? [];
  // An explicit history-expansion request replaces the default bounded snapshot
  // for display; the reducer resets this to null whenever the session changes.
  const peerPrompts =
    state.peerPromptHistoryExpanded ?? displaySession?.peerPrompts;
  // Which bubble is waiting on its jump: resolving where a message lives is a
  // round trip, so the control that asked says it is working.
  const peerPromptRevealPendingKey =
    state.revealRequest?.target.kind === "peerPrompt"
      ? state.revealRequest.target.messageKey
      : undefined;

  // The inspector resolves related objects from the Backlog and Project lists;
  // make sure both are loaded when an object detail route is open.
  const inspectorObjectRoute =
    ((route.name === "tasks" ||
      route.name === "projects" ||
      route.name === "worktrees") &&
      !!route.id) ||
    pullRequestTarget !== null;
  useEffect(() => {
    if (!state.connected || !inspectorObjectRoute) return;
    if (!backlogLoaded) loadBacklog();
    if (!projectsLoaded) loadProjects();
  }, [
    state.connected,
    inspectorObjectRoute,
    backlogLoaded,
    loadBacklog,
    projectsLoaded,
    loadProjects,
  ]);

  // Always switch to a freshly forked session as soon as the server confirms it.
  // The reducer already swaps in the fork's state/messages, so this navigation is
  // just an in-app route transition (no extra load) that keeps the URL in sync.
  // Consumed BY TOKEN, like `messageReveal` below and as `useAssistant`'s
  // `ForkSwitch` documents: it names a navigation the app performs once, not a
  // state it stays in. So the TOKEN is the only trigger and the id is read when
  // it moves — listing the id would make a fork's arrival and its id two
  // separate reasons to navigate, and listing the token without reading it is a
  // dependency the linter drops.
  const forkSwitchToken = state.forkSwitch?.token;
  const forkSwitchIdRef = useRef(state.forkSwitch?.sessionId);
  forkSwitchIdRef.current = state.forkSwitch?.sessionId;
  useEffect(() => {
    if (forkSwitchToken === undefined) return;
    const id = forkSwitchIdRef.current;
    if (id) navigate(sessionPath(id));
  }, [forkSwitchToken, navigate]);

  // A resolved jump: go to the session holding the message and address the
  // message itself in the URL, so the position survives a reload or a shared
  // link. The hash is the ADDRESS only — the transcript owns its own scrollTop
  // (see `useTranscriptScroll`), so `focusEntry` below is what performs the jump
  // once `useAssistant` has loaded the row into the window.
  const revealToken = state.messageReveal?.token;
  const revealSessionId = state.messageReveal?.sessionId;
  const revealEntryId = state.messageReveal?.entryId;
  // The viewed session decides only WHETHER to warm a timeline, so it is read
  // through a ref: as a dependency it would re-run this effect the moment its
  // own navigation landed, and `navigate` compares without the hash — so the
  // same jump would push a second history entry.
  const viewedForRevealRef = useRef(state.session?.sessionId);
  viewedForRevealRef.current = state.session?.sessionId;
  useEffect(() => {
    if (revealToken === undefined || !revealSessionId || !revealEntryId) return;
    setMessageFocus({
      sessionId: revealSessionId,
      entryId: revealEntryId,
      token: revealToken,
    });
    revealedHashRef.current = messageHash(revealSessionId, revealEntryId);
    if (revealSessionId !== viewedForRevealRef.current)
      actions.warmSessionTimeline(revealSessionId);
    navigate(
      `${sessionPath(revealSessionId)}#m-${encodeURIComponent(revealEntryId)}`,
    );
  }, [revealToken, revealSessionId, revealEntryId, actions, navigate]);

  // The other direction: a `#m-<entryId>` the browser arrived on — a reload, a
  // shared link, or the back/forward arrows walking onto one. Its row can be
  // anywhere in the session, so it asks the server where it is exactly as a
  // click does, and every later step is shared.
  //
  // The trigger is the ADDRESS changing, not the route: a fragment moves under
  // an unchanged route, so the observed hash is what says the URL moved. The ref
  // holds the address already acted on and is CLEARED by leaving it, so
  // returning to the same deep link later reveals again rather than being
  // suppressed by a stale key.
  // Extracted once and shared with the staged-context effect below: an inline
  // conditional in a dependency array is not statically checkable.
  const routeSessionId = route.name === "session" ? (route.id ?? null) : null;
  useEffect(() => {
    const entryId = routeSessionId ? entryIdFromHash(location.hash) : null;
    const address =
      routeSessionId && entryId ? messageHash(routeSessionId, entryId) : null;
    if (revealedHashRef.current === address) return;
    revealedHashRef.current = address;
    if (routeSessionId && entryId)
      actions.revealTimelineEntry(routeSessionId, entryId);
  }, [routeSessionId, locationHash, actions]);

  // Fresh topic subscriptions are the read for staged-context lists. The `new`
  // route keeps projects/worktrees live for its visible quick start; the Task
  // field adds Tasks only while expanded. Each answer replaces shell cache, so
  // explicit list commands here would duplicate payloads and race projections.

  // NB: attaching a Task must NOT clear the staged project — `stageTaskContext`
  // derives the project FROM the task and the chip bar shows it as the implied
  // (dimmed) project. The send path already ignores `pendingProjectContext` when a
  // Task is attached, so the derived project is display-only. Both task-attach
  // entry points (`stageTaskContext`, `startSessionForTask`) already clear the
  // mutually-exclusive Knowledge context themselves.
  useEffect(() => {
    // A non-null `routeSessionId` IS "the route names a session", so it stands
    // in for `route.name` here and stays the trigger when one session's chat is
    // opened straight from another's.
    if (routeSessionId && displayHasUserPrompt) {
      setPendingProjectContext(null);
      setPendingKnowledgeContext(null);
      setPendingWorktreeContext(null);
      setPendingWorktreeReview(null);
    }
  }, [routeSessionId, displayHasUserPrompt]);

  // Land keyboard focus inside the session list when the route addresses the
  // Sessions surface directly. Desktop only: on a phone this is a browser screen
  // reached by tapping, and focusing a row there just scrolls it under the thumb.
  useEffect(() => {
    if (!mobileLayout && route.name === "sessions")
      setSidebarFocusToken((token) => token + 1);
  }, [mobileLayout, route.name]);

  // Header left-panel toggle (desktop only — on small screens the browser is a
  // screen reached by back or the nav bar, so the header carries no toggle).
  const toggleSidebarPanel = useCallback(() => {
    setSidebarOpen((open) => {
      if (!open) setSidebarFocusToken((token) => token + 1);
      return !open;
    });
  }, [setSidebarOpen]);

  /**
   * A failure that names the session currently in view. It has a home on
   * screen, so it is rendered there (above the composer) and NOT announced in
   * passing — the doc's first question, applied to the object with the most
   * failures by far.
   */
  const sessionFailure = routeSessionFailure
    ? null // the unavailable panel already says it, in the transcript's place
    : failureOnViewedSession(state.sessionFailures, displayCurrentId);

  /**
   * What this shell renders failures IN PLACE for, stated to the announcer so
   * an arrival it owns is never also said in passing (`docs/messaging.md`).
   *
   * A claim, not a suppression rule: the announcement itself is raised where the
   * message lands (`useAssistant`'s socket handler), and only the view layer can
   * answer whether the object it names is in front of the user. Everything else
   * about ownership is a wire fact now — a list that could not be read names its
   * COLLECTION, so the pane's `ErrorNote` needs no claim here at all.
   */
  const stagedSendSessionId = stagedSend?.input?.id ?? null;
  /**
   * The Knowledge entry actually open, by its real id: a route may address an
   * entry by PATH, and only the loaded document knows which entry that is.
   *
   * Correlated against the CURRENT address, not merely gated on there being one.
   * The reported pair outlives the page that reported it, so a path→path
   * navigation holds entry A's id until B's document lands — and claiming A there
   * would suppress A's failure as if it were on screen and draw A's note over B's
   * loading surface. Both halves of the claim have to name the same entry the
   * user is looking at, or neither may.
   */
  const openKnowledgeEntryId =
    route.name !== "knowledge" || selectedKnowledgeFilePath
      ? null
      : selectedKnowledgeEntryId
        ? selectedKnowledgeEntryId
        : selectedKnowledgeEntryPath &&
            knowledgeEntry?.addressedPath === selectedKnowledgeEntryPath
          ? knowledgeEntry.id
          : null;
  useEffect(() => {
    setFailureHomes({
      viewedSessionId: displayCurrentId ?? null,
      // The id the staged send would be NAMED by, so the claim stays on its own
      // failure: a claude-sdk send supplies the session id the server uses, a pi
      // send does not (the server mints the durable one) and a review handoff
      // carries no `input` at all — in both of those the blockers that reach
      // this surface name nothing, which is what the claim then covers.
      stagedSend: sessionShell.ownsFailure
        ? { sessionId: stagedSendSessionId }
        : null,
      // One id per type, because the app opens one of each at a time. A member
      // that is merely a row in a list is NOT claimed: a row draws a title and a
      // status, so a failure about it would be suppressed into nothing.
      openObjects: {
        project: selectedProjectId ? [selectedProjectId] : [],
        task: selectedTaskId ? [selectedTaskId] : [],
        // Two Knowledge surfaces can read at once, each drawing its own note:
        // the route in the main pane and the right panel's Knowledge tab.
        knowledge: [
          ...new Set(
            [openKnowledgeEntryId, visibleKnowledgePanelEntryId].filter(
              (id): id is string => Boolean(id),
            ),
          ),
        ],
      },
    });
  }, [
    displayCurrentId,
    sessionShell.ownsFailure,
    stagedSendSessionId,
    selectedProjectId,
    selectedTaskId,
    openKnowledgeEntryId,
    visibleKnowledgePanelEntryId,
  ]);

  // Leaving settings returns to the chat we were in, or to /sessions/create for a fresh start.
  const closeSettings = () =>
    navigate(
      displayHasMessages && displayCurrentId
        ? sessionPath(displayCurrentId)
        : SESSIONS_CREATE_PATH,
    );

  /**
   * Arm the staged first send: the URL advances when the created session's
   * snapshot lands, and the new-session surfaces stand down NOW rather than
   * when the server answers.
   *
   * This is also where the send is RECORDED — the baseline for the staged
   * transcript's handoff and the retry — so arming and recording cannot drift
   * apart. The chat error channel is cleared with it: a send is a new outcome,
   * and an error that has already been announced (which leaves `state.error`
   * set) would otherwise be narrated as this bootstrap failing. The ordinary prompt path clears it through its optimistic echo;
   * the review handoffs echo nothing, so nothing else would.
   */
  const armStagedSend = useCallback(
    (send: Omit<StagedFirstSend, "knownSessionIds">) => {
      setSendInFlight(true);
      // Captured here rather than read later, and captured exactly as
      // `notifyStagedFirstSend` captures it one line down: both layers have to
      // recognise the SAME created session.
      const knownSessionIds = new Set(state.sessions.map((row) => row.id));
      if (state.session?.sessionId)
        knownSessionIds.add(state.session.sessionId);
      setStagedSend({ ...send, knownSessionIds });
      // No session id: a staged send CREATES a session, and `state.session` is
      // whatever was viewed before it — retiring that would silence an
      // unrelated chat's live failure. The send's own target is retired by the
      // send itself once it has one.
      actions.clearChatError();
      notifyStagedFirstSend();
    },
    [notifyStagedFirstSend, actions, state.sessions, state.session?.sessionId],
  );

  const sendPromptWithRuntime = (
    text: string,
    attachments: PromptAttachment[] = [],
  ) => {
    // Belt for the composer's disabled Send: a Developer session without its
    // required worktree — or one whose worktree disappeared — must never reach
    // the server (which would reject it).
    if (
      newSessionNeedsWorktree ||
      credentialProfileSendBlockedReason ||
      worktreeMissing
    )
      return;
    // Whatever this send turns into, the transcript follows it to the end.
    pinTranscriptToBottom();
    const allAttachments = attachments;
    // `/review` drafts remain short and editable. Inject the shared convention
    // at this first dispatch so the exact message sent is visible and auditable.
    const sentText =
      !displayHasUserPrompt && sessionReviewDraft
        ? appendReviewReportConvention(text)
        : text;
    // A Task started from the Backlog rides along (hidden) with the first prompt
    // of the fresh session, then the pending attach is cleared.
    const attachTaskId =
      pendingTaskAttach && !displayHasUserPrompt
        ? pendingTaskAttach.taskId
        : undefined;
    const knowledgeEntryId =
      !attachTaskId && !displayHasUserPrompt
        ? pendingKnowledgeContext?.entryId
        : undefined;
    const projectId =
      !attachTaskId && !knowledgeEntryId && !displayHasUserPrompt
        ? pendingProjectContext?.trim() || undefined
        : undefined;
    const worktreeId = !displayHasUserPrompt
      ? (pendingWorktreeContext ?? undefined)
      : undefined;
    // "+ New worktree": the send carries the PROJECT to provision in, and the
    // server creates the checkout before the session so it is born with the
    // right cwd. Provisioning reports back through `state.worktreeProvision`.
    const createWorktreeInProjectId =
      !displayHasUserPrompt && !worktreeId && pendingNewWorktree
        ? pendingProjectContext?.trim() || undefined
        : undefined;
    const review = !displayHasUserPrompt ? pendingWorktreeReview : null;
    if (isNewChatRoute && review) {
      const runtime = firstPromptRuntimeSelection(displaySession);
      const handoff = {
        worktreeId: review.worktreeId,
        commentIds: review.commentIds,
        target: reviewHandoffSessionTarget({
          runtime,
          agentType: displayAgentType,
          credentialProfileId,
          additionalPrompt: sentText,
          attachments: allAttachments,
        }),
      };
      const resend = () => actions.attachWorktreeComments(handoff);
      resend();
      // attachWorktreeComments creates and views the session server-side for
      // both harnesses, so the staged router follows that new non-empty view.
      armStagedSend({ resend, input: null });
      setPendingWorktreeReview(null);
      setPendingProjectContext(null);
      setPendingWorktreeContext(null);
      return;
    }
    const routing = routeComposerSend({
      isNewChatRoute,
      hasUserPrompt: displayHasUserPrompt,
      firstSendRetryPending,
    });
    if (routing !== "prompt") {
      const staged = pendingStart ?? stagedStart;
      const id =
        staged?.id && staged.id !== "pending-pi-session"
          ? staged.id
          : createClientId();
      // The optimistic session is the source of truth for the visible pickers.
      // Send that exact runtime — model AND the harness derived from it —
      // rather than trusting a possibly incomplete staging record (notably
      // sessions started from a worktree or a Task).
      const runtime = firstPromptRuntimeSelection(displaySession);
      // Re-sending after a failed first send reuses the HELD send: its staged
      // context (project to provision in, Task, worktree) was already consumed
      // and cleared, so rebuilding it from the pickers would silently drop it.
      // Only the text/attachments are the composer's, and the clientRequestId
      // rides along so the visible prompt is replaced rather than duplicated.
      const input: HarnessSendInput =
        routing === "reissue-first-send"
          ? {
              ...stagedSend!.input!,
              text: sentText,
              attachments: allAttachments,
            }
          : {
              id,
              harness: runtime.harness,
              agentType: displayAgentType,
              text: sentText,
              attachments: allAttachments,
              ...(runtime.provider ? { modelProvider: runtime.provider } : {}),
              ...(runtime.modelId !== undefined
                ? { modelId: runtime.modelId }
                : {}),
              ...(runtime.thinkingLevel !== undefined
                ? { thinkingLevel: runtime.thinkingLevel }
                : {}),
              ...(runtime.mode !== undefined ? { mode: runtime.mode } : {}),
              ...(credentialProfileId !== undefined
                ? { credentialProfileId }
                : {}),
              ...(attachTaskId !== undefined ? { attachTaskId } : {}),
              ...(projectId !== undefined ? { projectId } : {}),
              ...(worktreeId !== undefined ? { worktreeId } : {}),
              ...(createWorktreeInProjectId !== undefined
                ? { createWorktreeInProjectId }
                : {}),
              ...(knowledgeEntryId !== undefined ? { knowledgeEntryId } : {}),
            };
      const clientRequestId = actions.harnessSend(input);
      // Hold the send verbatim for the whole bootstrap: it is what the shell
      // renders the staged identity from, and if it fails there is no session
      // and no turn — the card's Retry, the bootstrap narration's and the next
      // composer send all re-issue exactly this, under the same
      // clientRequestId, so the prompt shows once.
      const held = { ...input, clientRequestId };
      // Both harnesses advance the URL through the armed staged advance once the
      // created session's snapshot lands (the server views the new session as
      // part of harnessSend for pi AND claude-sdk). Navigating to the staged
      // client id here instead would put a session id in the route that is not
      // in the sidebar list yet, tripping the pending-unknown-session fallback
      // in useSessionRouting — which canonicalizes the URL back to the
      // previously viewed session and steers the server off the new one.
      armStagedSend({ resend: () => actions.harnessSend(held), input: held });
    } else {
      actions.prompt(
        sentText,
        allAttachments,
        attachTaskId,
        projectId,
        knowledgeEntryId,
      );
    }
    if (attachTaskId) setPendingTaskAttach(null);
    if (knowledgeEntryId) setPendingKnowledgeContext(null);
    if (projectId) setPendingProjectContext(null);
    if (worktreeId) setPendingWorktreeContext(null);
    if (createWorktreeInProjectId) setPendingNewWorktree(false);
    // The /review draft was consumed by the composer; dropping it here keeps a
    // later fork draft from being masked in the composer's draft slot.
    if (sessionReviewDraft) setSessionReviewDraft(null);
  };

  // The composer is memoized, and a send reads about twenty pieces of this
  // render's state — a dependency list nobody could keep exact, and one missed
  // entry there is a prompt sent with stale context. So the identity handed
  // down is fixed and the ref carries this render's real function; the composer
  // only ever calls it from an event, never during render.
  const sendPromptRef = useRef(sendPromptWithRuntime);
  sendPromptRef.current = sendPromptWithRuntime;
  const submitPrompt = useCallback(
    (text: string, attachments?: PromptAttachment[]) =>
      sendPromptRef.current(text, attachments),
    [],
  );
  const abortRun = useCallback(() => actions.abort(), [actions]);
  const composerDictation = useMemo(
    () => ({
      enabled: state.settings.speechToText.enabled,
      status: state.speechToText,
    }),
    [state.settings.speechToText.enabled, state.speechToText],
  );

  // A worktree can be open on its route and in the side panel at once, and
  // `unwatchComments` is not refcounted on the wire: the counting happens here
  // so the panel closing cannot take the route's comment projection with it
  // (`hooks/useCommentWatch.ts`).
  const worktreeCommentWatch = useWorktreeCommentWatch(actions);
  /**
   * Where any document's comment tray can go: the session on screen first, then
   * the rest by recency.
   */
  const documentCommentHost = useMemo<DocumentCommentHost>(() => {
    const available = state.sessions.filter((session) => !session.archived);
    const current = displayCurrentId ?? null;
    return {
      sessions: [...available]
        .sort(
          (a, b) =>
            Number(b.id === current) - Number(a.id === current) ||
            b.updatedAt - a.updatedAt,
        )
        .map((session) => ({
          id: session.id,
          title: session.title || session.id,
          linked: session.id === current,
        })),
      send: sendDocumentComments,
      composer: { refine: {}, dictation: composerDictation },
    };
  }, [
    composerDictation,
    displayCurrentId,
    sendDocumentComments,
    state.sessions,
  ]);
  const openWorkspaceFile = useCallback(
    (path: string) => {
      const worktreeId = displaySession?.worktreeId;
      if (worktreeId) navigate(worktreePath(worktreeId, "files", { path }));
    },
    [displaySession?.worktreeId, navigate],
  );

  /**
   * Re-run the failed first send, exactly as it was dispatched — a
   * `harnessSend` under its original clientRequestId (the prompt is already the
   * visible, still optimistic first message, so the retry replaces that echo
   * rather than adding a second one) or the review handoff that carried no
   * prompt of its own. It is offered from the provisioning card when a checkout
   * failed and from the bootstrap narration for every other blocker; re-arming
   * rebaselines the send, since a failed attempt may have moved the view.
   */
  const retryFirstSend = useCallback(() => {
    const send = stagedSend;
    if (!send) return;
    pinTranscriptToBottom();
    send.resend();
    armStagedSend(send);
  }, [stagedSend, pinTranscriptToBottom, armStagedSend]);
  const onRetryWorktreeProvision =
    firstSendFailed && provisionFailed ? retryFirstSend : undefined;
  const onRetryFirstSend = firstSendFailed ? retryFirstSend : undefined;

  // The calendar's per-day actions run in a dedicated, date-bound assistant
  // session (server-created, fixed name) that the calendar's right panel embeds.
  const activateCalendarDay = (
    date: string,
    opts: {
      scan?: boolean;
      logTime?: boolean;
      text?: string;
      modelProvider?: string;
      modelId?: string;
      thinkingLevel?: ThinkingLevel;
    },
  ) => {
    actions.calendarDayActivate(date, opts);
    // The binding (daySessionId) is recorded server-side; pull it into the day
    // read-model so the embedded chat + auto-view reconcile.
    window.setTimeout(() => calendarController.refreshDay(), 700);
  };

  // "Log my time": open the day's chat (preferring the existing bound session)
  // seeded with the user's own work for the day, then jump into it so the user
  // watches the assistant propose worklogs. If a session is already bound we
  // jump now; otherwise the pending-open effect jumps once the server binds one.
  const logMyTimeForDay = (date: string) => {
    activateCalendarDay(date, { logTime: true });
    if (calendarDaySessionId) openSession(calendarDaySessionId);
    else setPendingLogTimeDate(date);
  };

  // Transcript callbacks are memoized because every message row is memoized: an
  // inline arrow here is a new prop on every App render, which defeats those
  // rows unconditionally and takes the `Markdown` memo down with them.
  // A card link REVEALS rather than navigates: its href addresses the card's
  // row, and following the same address twice would not jump a second time.
  const openPaObject = useCallback(
    (link: PaObjectLinkResolution) => {
      if (link.objectType === "approval") actions.revealApproval(link.id);
      else navigate(link.href);
    },
    [actions, navigate],
  );
  const openTaskById = useCallback(
    (taskId: string) => navigate(taskPath(taskId)),
    [navigate],
  );
  // A Workflow Run opens where it can be acted on: its own card, on its Task.
  // The fragment is what makes it the RUN rather than the Task's list of them
  // (`lib/workflowRunRoutes.ts`).
  const openWorkflowRun = useCallback(
    (taskId: string, runId: string) => navigate(workflowRunPath(taskId, runId)),
    [navigate],
  );

  useEffect(() => {
    if (!pendingLogTimeDate) return;
    if (
      calendarController.dayState?.date === pendingLogTimeDate &&
      calendarDaySessionId
    ) {
      setPendingLogTimeDate(null);
      openSession(calendarDaySessionId);
    }
  }, [
    pendingLogTimeDate,
    calendarDaySessionId,
    calendarController.dayState?.date,
    openSession,
  ]);

  const markPreviewInteracted = useCallback(
    () => setPreviewInteracted(true),
    [],
  );

  // Answering a question is a submit too, so the transcript follows it.
  const respondToQuestion = useCallback(
    (response: AgentQuestionResponse) => {
      pinTranscriptToBottom();
      actions.respondToQuestion(response);
    },
    [actions, pinTranscriptToBottom],
  );

  /**
   * A conflicted "Update with main" is not answered on the card at all: it
   * lands as a PROMPT in this session, seconds after the click, and the card
   * only says so afterwards (`rebaseHandedOff`). That is a submit, so the
   * transcript follows it — but not at click time, when there is nothing to
   * follow yet and the rebase may still resolve deterministically, and not in
   * a second viewer of the same session, which never asked for anything and
   * keeps its reading position. Hence the intent is remembered HERE, per card,
   * and spent when that card's handoff actually shows up.
   */
  const rebaseHandoffPending = useRef<Set<string>>(new Set());
  const runPullRequestCardAction = useCallback<
    AssistantActions["runPullRequestCardAction"]
  >(
    (cardId, action, options) => {
      if (action === "update-with-main")
        rebaseHandoffPending.current.add(cardId);
      actions.runPullRequestCardAction(cardId, action, options);
    },
    [actions],
  );
  useEffect(() => {
    const waiting = rebaseHandoffPending.current;
    if (waiting.size === 0) return;
    let handedOff = false;
    for (const id of rebaseHandedOffCardIds(state.pullRequestCards))
      if (waiting.delete(id)) handedOff = true;
    if (handedOff) pinTranscriptToBottom();
  }, [state.pullRequestCards, pinTranscriptToBottom]);

  // The app-level actions that share the nav bar with the sections. They just
  // navigate — the sidebar section stays where it is (navigation rule 2), and on
  // mobile the object screen they open is what replaces the browser.
  const openBackgroundTasks = useCallback(
    () => navigate(backgroundTasksPath()),
    [navigate],
  );
  const openBackgroundWork = useCallback(
    (taskId: string) => navigate(backgroundTasksPath(taskId)),
    [navigate],
  );
  // The composer's background ledge: only on a session screen whose session
  // owns active work or holds a retained host (that is when the projection is
  // present), and memoized so the composer does not re-render for every
  // unrelated App render. Its rows are the registry topic's, which the open
  // flag subscribes (`activeTopics`).
  const backgroundLedgeActivity =
    route.name === "session"
      ? displaySessionListItem?.backgroundActivity
      : undefined;
  // The session both composer ledges speak for: the one on screen.
  const ledgeSessionId = displaySessionListItem?.id;
  const backgroundLedge = useMemo(
    () =>
      backgroundLedgeActivity && ledgeSessionId ? (
        <BackgroundWorkLedge
          sessionId={ledgeSessionId}
          activity={backgroundLedgeActivity}
          items={state.backgroundWorkItems}
          open={backgroundLedgeOpen}
          onToggle={toggleBackgroundLedge}
          stopPending={backgroundStopPending}
          onStop={actions.stopBackgroundWork}
          onStopAll={actions.stopAllBackgroundWork}
          onOpenRegistry={openBackgroundWork}
        />
      ) : undefined,
    [
      backgroundLedgeActivity,
      ledgeSessionId,
      state.backgroundWorkItems,
      backgroundLedgeOpen,
      toggleBackgroundLedge,
      backgroundStopPending,
      actions.stopBackgroundWork,
      actions.stopAllBackgroundWork,
      openBackgroundWork,
    ],
  );
  // The composer's spawned-session ledge: the peers THIS session started, shaped
  // by the same projection the Sessions inbox uses. Derived from the session
  // list alone — no subscription, no server call — and absent (so the strip is
  // never mounted) for a session that spawned nothing, which is almost all of
  // them.
  const spawnedLedgeAll =
    ledgeSessionId !== undefined && spawnedLedgeAllFor === ledgeSessionId;
  const spawnedSessions = useMemo(
    () =>
      route.name === "session" && ledgeSessionId
        ? spawnedSessionsView({
            sessions: state.sessions,
            coordinatorId: ledgeSessionId,
            // "Show N more" lifts the cut for this session; the projection then
            // counts nothing as hidden, which is what removes the button.
            ...(spawnedLedgeAll ? {} : { limit: SPAWNED_SESSIONS_LEDGE_LIMIT }),
          })
        : undefined,
    [route.name, ledgeSessionId, state.sessions, spawnedLedgeAll],
  );
  const showAllSpawnedSessions = useCallback(
    () => setSpawnedLedgeAllFor(ledgeSessionId ?? null),
    [ledgeSessionId],
  );
  // Gated on what the strip DRAWS (`spawnedSessionsKey`), exactly as the
  // Backlog's session slice is: the projection above is rebuilt on every
  // rebroadcast, `Composer` is memoized, and a ledge node rebuilt with it would
  // re-render the whole card several times a second for a line whose text did
  // not change (`src/CLAUDE.md`). Whether the strip is OPEN is part of the key's
  // question, because it decides whether the peer rows are on screen at all.
  const spawnedLedgeKey = spawnedSessions
    ? spawnedSessionsKey(spawnedSessions, spawnedLedgeOpen)
    : "";
  // oxlint-disable-next-line react/exhaustive-deps -- `spawnedLedgeKey` IS the strip's visible content of `spawnedSessions` (`lib/sessionInbox.ts` enumerates it); depending on the projection would rebuild the ledge on every rebroadcast, which is the whole point of the gate
  const spawnedLedgeView = useMemo(() => spawnedSessions, [spawnedLedgeKey]);
  const spawnedLedge = useMemo(
    () =>
      spawnedLedgeView &&
      spawnedLedgeView.counts.total > 0 &&
      ledgeSessionId ? (
        <SpawnedSessionsLedge
          sessionId={ledgeSessionId}
          view={spawnedLedgeView}
          open={spawnedLedgeOpen}
          onToggle={toggleSpawnedLedge}
          onOpenSession={openSession}
          onShowAll={showAllSpawnedSessions}
          onSettleSession={settleSession}
        />
      ) : undefined,
    [
      spawnedLedgeView,
      ledgeSessionId,
      spawnedLedgeOpen,
      toggleSpawnedLedge,
      openSession,
      showAllSpawnedSessions,
      settleSession,
    ],
  );
  // The composer's pending-approval strip: the cards the viewed session is
  // waiting on, read from its own approval state. Gated on what the strip
  // DRAWS, like the peers strip: `state.approvals` is rebuilt on every card
  // update and snapshot, and `Composer` is memoized.
  const pendingApprovals =
    route.name === "session" &&
    ledgeSessionId &&
    state.session?.sessionId === ledgeSessionId
      ? pendingApprovalCards(state.approvals)
      : [];
  const pendingApprovalsLedgeKey = pendingApprovalsKey(pendingApprovals);
  const pendingApprovalsLedge = useMemo(
    () =>
      pendingApprovals.length > 0 ? (
        <PendingApprovalsLedge
          cards={pendingApprovals}
          onRevealApproval={actions.revealApproval}
        />
      ) : undefined,
    // oxlint-disable-next-line react/exhaustive-deps -- `pendingApprovalsLedgeKey` IS the strip's visible content of `pendingApprovals` (`lib/approvalCards.ts`); depending on the array would rebuild the strip on every snapshot
    [pendingApprovalsLedgeKey, actions.revealApproval],
  );
  // The user's own queue (`promptQueue.ts`) belongs to an ordinary session on
  // screen; the permanent Assistant queues its intake on its own.
  const queueSessionId =
    route.name === "session" ? displaySession?.sessionId : undefined;
  const sendPromptQueue = actions.promptQueue;
  const queuePrompt = useMemo(
    () =>
      queueSessionId
        ? (item: {
            text: string;
            attachments?: PromptAttachment[];
            command?: { name: string; rawArgs: string };
          }) =>
            sendPromptQueue({
              type: "queuePrompt",
              sessionId: queueSessionId,
              ...item,
            })
        : undefined,
    [queueSessionId, sendPromptQueue],
  );
  const shownPromptQueue = queueSessionId
    ? displaySession?.promptQueue
    : undefined;
  const sessionCanSteer = Boolean(displaySession?.canSteer);
  const promptQueueLedge = useMemo(
    () =>
      shownPromptQueue && queueSessionId ? (
        <PromptQueueLedge
          queue={shownPromptQueue}
          running={displayStreaming}
          canSteer={sessionCanSteer}
          onEdit={(id, text) =>
            sendPromptQueue({
              type: "updateQueuedPrompt",
              sessionId: queueSessionId,
              id,
              text,
            })
          }
          onRemove={(id) =>
            sendPromptQueue({
              type: "removeQueuedPrompt",
              sessionId: queueSessionId,
              id,
            })
          }
          onMove={(id, toIndex) =>
            sendPromptQueue({
              type: "moveQueuedPrompt",
              sessionId: queueSessionId,
              id,
              toIndex,
            })
          }
          onSendNow={(id) =>
            sendPromptQueue({
              type: "sendQueuedPromptNow",
              sessionId: queueSessionId,
              id,
            })
          }
          onClear={() =>
            sendPromptQueue({
              type: "clearPromptQueue",
              sessionId: queueSessionId,
            })
          }
          onResume={() =>
            sendPromptQueue({
              type: "resumePromptQueue",
              sessionId: queueSessionId,
            })
          }
        />
      ) : undefined,
    [
      shownPromptQueue,
      queueSessionId,
      displayStreaming,
      sessionCanSteer,
      sendPromptQueue,
    ],
  );
  // One shelf, up to four strips on it: what waits on the user on top, then
  // the peers, background work, and the user's own queue on the edge nearest
  // the field it was typed in.
  const composerLedge = useMemo(
    () =>
      pendingApprovalsLedge ||
      spawnedLedge ||
      backgroundLedge ||
      promptQueueLedge ? (
        <>
          {pendingApprovalsLedge}
          {spawnedLedge}
          {backgroundLedge}
          {promptQueueLedge}
        </>
      ) : undefined,
    [pendingApprovalsLedge, spawnedLedge, backgroundLedge, promptQueueLedge],
  );

  const runNavAction = useCallback(
    (action: NavAction) => {
      if (action === "new-session") {
        startNewChat();
        return;
      }
      navigate(
        action === "assistant"
          ? PERMANENT_ASSISTANT_PATH
          : action === "background-tasks"
            ? backgroundTasksPath()
            : usagePath(),
      );
    },
    [navigate, startNewChat],
  );

  // The dock's compose control. It collapses the sheet first — composing replaces
  // the surface the sheet is covering — and then focuses the composer through the
  // live ref, synchronously, so iOS raises the keyboard in this same tap.
  //
  // These four are dock controls, so the collapse IS the user's own tap and only
  // a phone ever reaches them. They still ask, because the rule is not "the dock
  // is mobile" but "nothing closes a panel the user opened on a wide layout" —
  // and a rule with an exception is one nobody can check.
  const openComposer = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    openComposerRef.current?.();
  }, [mobileLayout, setInspectorOpen]);

  // The dock row's paperclip, for a session with no object to jump to. Like compose,
  // it reaches into the composer through a live ref so the picker opens inside this
  // tap; a chosen file stages an attachment, which opens the composer by itself.
  const attachFromDock = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    attachComposerRef.current?.();
  }, [mobileLayout, setInspectorOpen]);

  // The dock row's Send. The draft lives in the composer, so this reaches into it the
  // same way compose and the paperclip do; the composer decides what a press means
  // (send it, or open on the hint saying why it cannot).
  const submitFromDock = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    submitComposerRef.current?.();
  }, [mobileLayout, setInspectorOpen]);

  // The dock row's comment press, when a transcript selection has taken over its
  // Send slot. Capturing the anchor alone leaves nothing on screen on a phone: the
  // comment box lives in the composer, which is HIDDEN there until something opens
  // it. So the composer is opened inside this tap — synchronously, like compose and
  // the paperclip, or iOS keeps the keyboard down — and the anchor is captured after,
  // since opening focuses the textarea and comment mode wants that caret.
  const commentFromDock = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    openComposerRef.current?.();
    chatCommentSelection?.onComment();
  }, [chatCommentSelection, mobileLayout, setInspectorOpen]);

  // The dock row's staged-context control on the new-session screen: the same sheet the
  // composer's own `+` opens, requested from outside (the composer knows not to grab
  // focus for an external open — nobody was typing).
  const openContextFromDock = useCallback(() => {
    if (mobileLayout) setInspectorOpen(false);
    setContextSheetRequest((current) => ({ token: (current?.token ?? 0) + 1 }));
  }, [mobileLayout, setInspectorOpen]);

  // The expanded composer's mic hands over to the dock's row: it has already
  // remembered its caret and dropped focus, so closing it reveals the row and this
  // token starts the recording there. One recorder, one recording UI, either way in.
  // Held until the dock's row consumes it: the composer's mic closes the composer,
  // and THAT is what mounts the row which owns the recorder, so the hand-over has to
  // survive a mount rather than being a change only an already-mounted row could see.
  const requestDictation = useCallback(
    () => setDictationRequest({ at: Date.now() }),
    [],
  );
  const clearDictationRequest = useCallback(
    () => setDictationRequest(null),
    [],
  );
  const receiveTranscript = useCallback((spoken: string) => {
    setDictationTranscript((current) => ({
      spoken,
      token: (current?.token ?? 0) + 1,
    }));
  }, []);

  // Mobile: the object panel rests showing the dock's header row and slides up
  // into a sheet (`inspectorOpen` means EXPANDED there). That row is the object's
  // action home AND, on the screens that have it, the screen's back control.
  // Kept ABOVE the loading-shell guard below, like every other hook here: App
  // returns early until the first snapshot hydrates, and a hook after that point
  // changes the hook count on the render that hydrates (React error #310).
  // The dock row's context slot: which object this session is about (the tier order
  // lives in `lib/sessionDockContext.ts`, with its tests), turned into the navigation
  // and the one indicator worth a dot — a dirty worktree.
  const dockSessionContext = useMemo<SessionDockContextSlot | undefined>(() => {
    const target = resolveSessionDockContext({
      ...(displayWorktreeId !== undefined
        ? { worktreeId: displayWorktreeId }
        : {}),
      ...(sessionOriginTask?.id !== undefined
        ? { originTaskId: sessionOriginTask.id }
        : {}),
      hasUserPrompt: displayHasUserPrompt,
      staged: {
        ...(pendingWorktreeContext !== undefined
          ? { worktreeId: pendingWorktreeContext }
          : {}),
        ...(pendingTaskAttach?.taskId !== undefined
          ? { taskId: pendingTaskAttach?.taskId }
          : {}),
        ...(pendingKnowledgeContext?.entryId !== undefined
          ? { knowledgeEntryId: pendingKnowledgeContext?.entryId }
          : {}),
        projectId: pendingProjectContext,
      },
    });
    if (!target) return undefined;
    switch (target.kind) {
      case "worktree":
        return {
          kind: target.kind,
          dirty: Boolean(state.worktreeStatuses[target.id]?.dirty),
          onOpen: () => navigate(worktreePath(target.id, "changes")),
        };
      case "task":
        return {
          kind: target.kind,
          onOpen: () => navigate(taskPath(target.id)),
        };
      case "knowledge":
        return {
          kind: target.kind,
          onOpen: () => navigate(knowledgePath(target.id)),
        };
      case "project":
        return {
          kind: target.kind,
          onOpen: () => navigate(projectPath(target.id)),
        };
    }
  }, [
    displayWorktreeId,
    displayHasUserPrompt,
    pendingWorktreeContext,
    state.worktreeStatuses,
    sessionOriginTask?.id,
    pendingTaskAttach?.taskId,
    pendingKnowledgeContext?.entryId,
    pendingProjectContext,
    navigate,
  ]);

  /**
   * What the object on this route leads with. ONE definition, read by the wide
   * page header, by the dock's action row below, and by the object panel (which
   * drops its own `primary` while this is published, so the same button is not
   * offered twice).
   */
  const routePrimaryAction = useMemo<RoutePrimaryAction | null>(() => {
    const icon = <MessageSquarePlus size={18} />;
    if (route.name === "tasks" && route.id) {
      const task = backlogTasks.find((item) => item.id === route.id);
      if (!task) return null;
      return {
        label: "Start session for this task",
        icon,
        onRun: () => startSessionForTask(task.id, task.title),
      };
    }
    if (route.name === "projects" && route.id) {
      const projectId = route.id;
      return {
        label: "Start session in this project",
        icon,
        onRun: () => startSessionForProject(projectId),
      };
    }
    if (route.name === "worktrees" && route.id) {
      const worktreeId = route.id;
      return {
        label: "Start session in this worktree",
        icon,
        onRun: () => startSessionInWorktree(worktreeId),
      };
    }
    // A pull request leads with its checkout's session ONLY once the checkout
    // exists: without one the panel lists the action disabled, with creating
    // the worktree as the reason, rather than the slot offering nothing.
    if (route.name === "pullRequests" && pullRequestWorktreeId) {
      const worktreeId = pullRequestWorktreeId;
      return {
        label: "Start session in this pull request's worktree",
        icon,
        onRun: () => startSessionInWorktree(worktreeId),
      };
    }
    if (route.name === "knowledge" && route.entryId) {
      const entryId = route.entryId;
      const title =
        knowledgeEntry?.id === entryId ? knowledgeEntry.title : entryId;
      return {
        label: "Start session with this entry",
        icon,
        onRun: () => startSessionForKnowledge(entryId, title),
      };
    }
    return null;
  }, [
    route,
    backlogTasks,
    knowledgeEntry,
    pullRequestWorktreeId,
    startSessionForTask,
    startSessionForProject,
    startSessionInWorktree,
    startSessionForKnowledge,
  ]);

  const dockPeek = useMemo<DockPeek | undefined>(() => {
    if (!dockCarriesBack) return undefined;
    const back = (
      <DockAction
        icon={<ArrowLeft size={18} />}
        label={`Back to ${backToSection.label}`}
        onRun={backToSection.onClick}
      />
    );
    const pendingCommentCount = Math.max(
      0,
      commentActuation?.pendingCount ?? 0,
    );
    // The row's own tail: what you can say about this object, then the one slot
    // that holds what to do with it. The slot is the rightmost control — the
    // thumb's — so it carries the object's primary action, and Submit review
    // while comments are waiting to go (`shell/RoutePrimaryAction.tsx`).
    const submitInSlot =
      commentActuation?.onSubmitReview &&
      primarySlotShowsReview(pendingCommentCount)
        ? commentActuation.onSubmitReview
        : undefined;
    const objectDockActions =
      commentActuation?.onComment || submitInSlot || routePrimaryAction ? (
        <>
          {commentActuation?.onComment ? (
            <DockAction
              icon={<MessageSquareQuote size={18} />}
              label="Add comment"
              onRun={commentActuation.onComment}
              disabled={commentActuation.canComment !== true}
              disabledReason="Select text to comment"
              commentActuation
            />
          ) : null}
          {submitInSlot ? (
            <DockAction
              icon={<SendHorizontal size={18} />}
              label={commentActuation?.submitLabel ?? "Submit review"}
              onRun={submitInSlot}
              badge={pendingCommentCount}
              commentActuation
            />
          ) : routePrimaryAction ? (
            <DockAction
              icon={routePrimaryAction.icon}
              label={routePrimaryAction.label}
              onRun={routePrimaryAction.onRun}
            />
          ) : null}
        </>
      ) : null;
    if (documentRoute && documentNavigation) {
      // `DocumentDockRow` owns the order — Back, Forward, Close, then the
      // source's and the object's actions, and no zoom controls at all.
      return documentDockPeek(documentNavigation, objectDockActions);
    }
    // A session screen's row IS the resting composer, bookended two controls a side
    // around the field (`SessionDockActions` owns that arrangement). It always
    // `fill`s: the field has to be as wide as what the clusters leave, and a row whose
    // width changed between states would read as a different bar.
    if (sessionScreen) {
      return {
        back,
        // Dictation happens inside the field now, so the row keeps its controls
        // through it — but the SHEET still cannot open over a recording: nothing may
        // cover the Stop button the thumb is aiming for mid-sentence.
        expandBlocked: dictationActive,
        fill: true,
        actions: (
          <>
            <SessionDockActions
              disabled={!state.connected || routeSessionPending}
              streaming={displayStreaming}
              acceptsInputWhileRunning={sessionCanSteer || Boolean(queuePrompt)}
              onAbort={() => actions.abort()}
              draft={composerDraft}
              onCompose={openComposer}
              onSubmit={submitFromDock}
              commentSelection={chatCommentSelection}
              onComment={chatCommentSelection ? commentFromDock : undefined}
              // Beside back: what this conversation is about. A session that has not
              // been sent yet is about nothing yet, so there the slot carries the same
              // staged-context picker the composer's `+` opens (exactly while that
              // sheet exists), and a session that hangs off nothing at all falls back
              // to the composer's paperclip.
              contextSlot={
                showContextPicker
                  ? { kind: "add-context", onRun: openContextFromDock }
                  : (dockSessionContext ?? {
                      kind: "attach",
                      onRun: attachFromDock,
                    })
              }
              dictation={{
                enabled: state.settings.speechToText.enabled,
                status: state.speechToText,
              }}
              startRequest={dictationRequest}
              onStartHandled={clearDictationRequest}
              onTranscript={receiveTranscript}
              onActiveChange={setDictationActive}
            />
          </>
        ),
      };
    }
    // Every agent-enabled object type leads with the same primary action
    // (ui-shell.md, Object panel), which `routePrimaryAction` resolves once for
    // every surface that draws it. What a TYPE adds sits before that tail.
    if (route.name === "tasks" && route.id) {
      const task = backlogTasks.find((item) => item.id === route.id);
      if (!task) return { back };
      // The Task's own session, by the same rule the tree row's gutter action
      // uses (`lib/taskActivity.ts`'s `taskStartSession`): streaming first,
      // otherwise the most recently touched, and never an archived one — so
      // this action never leads nowhere.
      const session = taskStartSession(
        task,
        new Map(state.sessions.map((s) => [s.id, s])),
      );
      // Status is a dock action here, not a header control: the glyph shows the state
      // and cycling it is what you most often come to a Task to do. The page's own
      // title block therefore shows the state without offering to change it.
      return {
        back,
        actions: (
          <>
            <DockAction
              icon={<TaskStatusIcon status={task.status} size={18} />}
              label={`Status: ${TASK_STATUS_LABEL[task.status]}. Mark as ${TASK_STATUS_LABEL[nextStatus(task.status)].toLowerCase()}`}
              onRun={() => cycleTaskStatus(task)}
            />
            {session ? (
              <DockAction
                icon={<MessageSquare size={18} />}
                label={
                  session.isStreaming
                    ? `Open the session running on “${task.title}”`
                    : `Open the session started from “${task.title}”`
                }
                onRun={() => openSession(session.id)}
              />
            ) : null}
            {objectDockActions}
          </>
        ),
      };
    }
    return { back, actions: objectDockActions ?? undefined };
  }, [
    dockCarriesBack,
    documentRoute,
    documentNavigation,
    commentActuation,
    backToSection,
    sessionScreen,
    route,
    backlogTasks,
    state.sessions,
    openSession,
    cycleTaskStatus,
    displayStreaming,
    sessionCanSteer,
    queuePrompt,
    composerDraft,
    openComposer,
    submitFromDock,
    chatCommentSelection,
    commentFromDock,
    actions,
    dockSessionContext,
    showContextPicker,
    openContextFromDock,
    attachFromDock,
    state.connected,
    routeSessionPending,
    state.settings.speechToText.enabled,
    state.speechToText,
    dictationActive,
    dictationRequest,
    clearDictationRequest,
    receiveTranscript,
    routePrimaryAction,
  ]);

  // Navigating from inside the object panel changes the main pane — which on a
  // phone this panel is sitting on top of, so the dock collapses to reveal the
  // result. Same rule the `Inspector` frame applies to its own relations and
  // actions; this covers the links its section CHILDREN render.
  const navigateFromInspector = useCallback(
    (path: string) => {
      if (mobileLayout) setInspectorOpen(false);
      navigate(path);
    },
    [mobileLayout, navigate, setInspectorOpen],
  );

  // Every hook the Project page needs is derived HERE, above the loading
  // shell's early return: a hook below it does not run on the hydrating
  // render, and the connected render that follows then trips React #310 and
  // blanks the app (app/web/src/CLAUDE.md).
  const projectPageMutationCache = useRef<{
    key: string;
    value: typeof state.projectMutations;
  }>({ key: "", value: {} });
  const projectMutationEntries = selectedProjectId
    ? Object.entries(state.projectMutations).filter(([key]) =>
        key.startsWith(`${selectedProjectId}:`),
      )
    : [];
  const projectMutationKey = JSON.stringify(projectMutationEntries);
  if (projectPageMutationCache.current.key !== projectMutationKey)
    projectPageMutationCache.current = {
      key: projectMutationKey,
      value: Object.fromEntries(projectMutationEntries),
    };
  const projectPageStatusCache = useRef<{
    key: string;
    value: typeof state.worktreeStatuses;
  }>({ key: "", value: {} });
  // One of the two places the remembered statuses are read: a Project page row
  // falls back to what git last said so the section paints at its real height
  // instead of growing each row as its watch answers. Nothing that decides from
  // a status may be built from this map (`lib/worktreeRowStatuses.ts`).
  const projectStatusEntries = selectedProjectId
    ? selectedProjectWorktreeCache.current.value.flatMap((worktree) => {
        const status = rowWorktreeStatus(
          state.worktreeStatuses,
          state.cachedWorktreeStatuses,
          worktree.id,
        );
        return status ? ([[worktree.id, status]] as const) : [];
      })
    : [];
  const projectStatusKey = JSON.stringify(projectStatusEntries);
  if (projectPageStatusCache.current.key !== projectStatusKey)
    projectPageStatusCache.current = {
      key: projectStatusKey,
      value: Object.fromEntries(projectStatusEntries),
    };
  const projectBackToList = useCallback(
    () => openSidebarSection("projects"),
    [openSidebarSection],
  );
  const saveProject = useCallback(
    (id: string, patch: Parameters<AssistantActions["saveProject"]>[1]) =>
      actions.saveProject(id, patch),
    [actions],
  );
  const cloneProjectRepo = useCallback(
    (id: string) => actions.provisionProjectRepo(id),
    [actions],
  );
  const removeProjectRepo = useCallback(
    (id: string) => actions.removeProjectRepo(id),
    [actions],
  );
  const reloadWorktrees = useCallback(() => actions.listWorktrees(), [actions]);
  const openProjectPaObject = useCallback(
    (link: MarkdownPaObjectReference) => navigate(link.href),
    [navigate],
  );
  const renderProjectTasks = useCallback(
    (projectId: string) => (
      <Suspense
        fallback={
          <div
            role="status"
            aria-label="Loading Project tasks"
            className="flex flex-col gap-2 px-1 py-2"
          >
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        }
      >
        <BacklogList
          state={backlogState}
          actions={actions}
          prefs={prefs}
          onUpdatePrefs={update}
          selectedId={null}
          onOpenTask={openTaskById}
          onOpenSession={openSession}
          onStartSessionForTask={startSessionForTask}
          onNavigate={openBacklogRowLink}
          hosting={worktreeHosting.hosting}
          dirtyWorktrees={dirtyWorktrees}
          workflowIndicators={workflowIndicators}
          fixedProjectId={projectId}
          density="comfortable"
          showAddTask
        />
      </Suspense>
    ),
    [
      actions,
      backlogState,
      dirtyWorktrees,
      openBacklogRowLink,
      openSession,
      openTaskById,
      prefs,
      startSessionForTask,
      update,
      workflowIndicators,
      worktreeHosting.hosting,
    ],
  );

  if (showLoadingShell) {
    return (
      <LoadingShell
        label={state.connected ? "Loading session…" : "Connecting…"}
      />
    );
  }

  // The chat surface (Composer + MessageList / pending / hero), hoisted so it can
  // render either in the main column (normal routes) or inside the Calendar
  // page's Assistant tab (reusing the same active session — see calendar-view).
  const chatSurface = (() => {
    const composerEl = (
      <>
        {worktreeMissing ? (
          <SessionWorktreeMissingBanner
            onAcknowledge={acknowledgeMissingWorktree}
          />
        ) : null}
        {/* A failure that names THIS session belongs here rather than in
            passing (`docs/messaging.md`): this is where the user acts on it,
            and it survives unrelated traffic and other sessions' failures until
            something retires it. Two things do, and both name this session: the
            dismiss below, and the session's own next send (which dispatches
            `clearSessionFailure` — the SEND does it, not its echo, because an
            attachments-only prompt echoes nothing). */}
        {sessionFailure ? (
          <div className="mx-auto w-full max-w-3xl px-4 pb-2">
            <ErrorNote
              message={sessionFailure}
              onRetry={() =>
                displayCurrentId && actions.clearChatError(displayCurrentId)
              }
              retryLabel="Dismiss"
            />
          </div>
        ) : null}
        <Composer
          onSend={submitPrompt}
          {...(queuePrompt ? { onQueue: queuePrompt } : {})}
          onAbort={abortRun}
          streaming={displayStreaming}
          // A dead worktree edge disables the whole composer, not just Send: the
          // banner above it owns the one action that unblocks the session.
          disabled={!state.connected || routeSessionPending || worktreeMissing}
          contextInfo={currentContextInfo}
          session={displaySession}
          models={pickerModels}
          slashCommands={state.slashCommands}
          onClientSlashCommand={runClientSlashCommand}
          actions={runtimeActions}
          focusToken={composerFocusToken}
          draftStorageKey={chatDraftStorageKey}
          chatComments={chatComments}
          commentDraft={chatCommentDraft}
          onCommentDraftChange={setChatCommentDraft}
          onAddComment={chatCommentSelection?.onComment}
          onRevealComment={revealChatComment}
          draft={
            pendingWorktreeReview?.draft ??
            sessionReviewDraft ??
            displayForkDraft
          }
          onDraftConsumed={retireStagedDraft}
          // Never on mobile: the screen rests on the dock's action row, so autofocus
          // would open the keyboard over the quick-start rows before anything is picked.
          draftAutoFocus={!mobileLayout}
          branchInfo={branchInfo}
          contextBar={stagedContextBar}
          contextOpenRequest={contextSheetRequest}
          sendBlockedReason={
            newSessionNeedsWorktree
              ? "Developer sessions run in a worktree — pick one to continue."
              : credentialProfileSendBlockedReason
          }
          sendBlocked={credentialProfileSendBlocked}
          mobile={mobileLayout}
          // Mobile has no collapsed bar: the composer reports when it takes over the
          // bottom edge (so the dock's row stands down) and when a draft is waiting in
          // it (so the dock's field can show it), and hands back the three reaches the
          // dock's row makes into it — the synchronous open the keyboard needs, the
          // file picker, and Send.
          onVisibilityChange={setComposerVisible}
          onDraftPreviewChange={setComposerDraft}
          attachRef={attachComposerRef}
          openRef={openComposerRef}
          submitRef={submitComposerRef}
          // Mobile dictation belongs to the dock's row, so the toolbar mic hands over
          // to it and the finished text comes back as data, inserted at the caret the
          // composer remembered when it handed over.
          onRequestDictation={mobileLayout ? requestDictation : undefined}
          transcript={dictationTranscript}
          isModelDisabled={isModelDisabled}
          modelLocked={modelLocked}
          thinkingLocked={thinkingLocked}
          hideRuntimeControls={route.name === "permanentAssistant"}
          ledge={composerLedge}
          selectedAgentType={
            showAgentTypePicker ? agentTypeForPicker : undefined
          }
          availableAgentTypes={
            showAgentTypePicker ? availableAgentTypes : undefined
          }
          onAgentTypeChange={
            showAgentTypePicker ? switchStagedAgentType : undefined
          }
          dictation={composerDictation}
        />
      </>
    );

    // The bootstrap's one line, under the prompt it belongs to: the session the
    // surface is already rendering does not exist yet.
    const bootstrapNarrationEl = sessionShell.narration ? (
      <SessionBootstrapNarration
        narration={sessionShell.narration}
        onRetry={onRetryFirstSend}
      />
    ) : null;

    if (showPendingSessionPanel) {
      return (
        <>
          {routeSessionFailure ? (
            <UnavailableSessionPanel
              title={pendingSessionTitle}
              message={routeSessionFailure}
            />
          ) : (
            <PendingSessionPanel title={pendingSessionTitle} />
          )}
          <div
            className="relative z-10 shrink-0 bg-transparent transition-transform duration-150 ease-out"
            style={{
              transform:
                "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
            }}
          >
            {composerEl}
          </div>
        </>
      );
    }

    if (displayHasMessages || transcriptOnlyHasOlderMessages) {
      return (
        <>
          {/* Commit DURATION of the transcript subtree, for the dev HUD: the
              render counts say how often it redraws, this says what one redraw
              costs (a no-op outside profiling builds). */}
          <Profiler id="Transcript" onRender={recordTranscriptRender}>
            <Suspense fallback={<TranscriptChunkFallback />}>
              <MessageList
                sessionId={displayCurrentId}
                messages={displayMessagesWithPeerPromptOverrides}
                timeline={state.timeline}
                chatComments={chatComments}
                commentDraft={chatCommentDraft}
                onCommentDraftChange={setChatCommentDraft}
                onCommentSelectionChange={onChatCommentSelectionChange}
                sessionStreaming={displayStreaming}
                promptQueueStates={state.promptQueueStates}
                appearance={state.settings.appearance}
                sessionCanSteer={Boolean(displaySession?.canSteer)}
                sessions={state.sessions}
                changedFiles={workspaceChangedFiles}
                paObjectReferences={paObjectReferences}
                onOpenPaObject={openPaObject}
                view={transcriptView}
                onAcceptCommitDryRun={actions.acceptCommitDryRun}
                onCreateDraftSession={actions.createDraftSession}
                models={messageModels}
                defaultModel={displaySession?.model}
                defaultThinkingLevel={displaySession?.thinkingLevel}
                onForkMessage={forkMessage}
                onResendPrompt={resendPrompt}
                onOpenSession={openSession}
                onOpenChangedFile={openWorkspaceFile}
                onOpenTask={openTaskById}
                onOpenBackgroundWork={openBackgroundWork}
                onOpenWorktree={openWorktree}
                onRetryWorktreeProvision={onRetryWorktreeProvision}
                onApplyTaskStatusSuggestion={applyTaskStatusSuggestion}
                onResolveApproval={actions.resolveApproval}
                approvalGrants={approvalGrants}
                onRevokeApprovalGrant={actions.revokeApprovalGrant}
                accountModels={settingsAccountModels}
                onChoosePullRequestTask={actions.choosePullRequestTask}
                onPullRequestCardAction={runPullRequestCardAction}
                pendingQuestion={displaySession?.pendingQuestion}
                answeredQuestions={displaySession?.answeredQuestions}
                onRespondToQuestion={respondToQuestion}
                onLoadTimelineBlock={actions.loadTimelineBlock}
                onLiveBodyDemand={actions.setLiveBodyDemand}
                turnStatsSeed={transcriptTurnStatsSeed}
                hasOlderMessages={hasOlderTimelineEntries}
                loadingOlderMessages={state.timelineRangePending !== null}
                onLoadOlderMessages={actions.loadOlderTimeline}
                focusEntry={transcriptFocusEntry}
                onFocusEntryApplied={retireMessageFocus}
                forkBoundary={transcriptForkBoundary}
                pinToBottomToken={transcriptPinToken}
                onRegisterViewHold={registerTranscriptViewHold}
                loadingPreview={usePreview}
                onPreviewInteraction={markPreviewInteracted}
              />
            </Suspense>
          </Profiler>
          {bootstrapNarrationEl}
          <div
            className="relative z-10 shrink-0 bg-transparent transition-transform duration-150 ease-out"
            style={{
              transform:
                "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
            }}
          >
            {composerEl}
          </div>
        </>
      );
    }

    // New session: composer anchored at the bottom (same as an active chat) so
    // it uses the full width/height instead of floating in the middle. The
    // quick-start rows fill the space above it (no hero line — a stable layout
    // beats a greeting; the composer placeholder carries the same message).
    // No horizontal padding here: the quick-start rows own their own inset so
    // they can scroll edge-to-edge instead of being clipped by a page gutter.
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto py-6">
          {showContextPicker ? (
            <NewSessionQuickStart
              credentialProfiles={activeCredentialProfiles}
              credentialProfilesLoaded={
                credentialProfileProjection !== undefined
              }
              credentialProfilesError={errorOf(credentialProfileFetch.state)}
              onRetryCredentialProfiles={credentialProfileFetch.reload}
              usageIndicators={state.usageIndicators}
              selectedCredentialProfileId={credentialProfileId}
              onSelectCredentialProfile={(id) => {
                const profile = activeCredentialProfiles.find(
                  (item) => item.id === id,
                );
                // Switching WHO runs the session keeps WHAT runs it as far as
                // the new account allows, instead of snapping back to its
                // first model at "off" thinking.
                const { model } = carryOverRuntimeSelection({
                  model: displaySession?.model,
                  thinkingLevel: currentThinkingLevel,
                  fromModels: pickerModels,
                  toModels: visibleModels(
                    credentialProfileModels[id] ?? [],
                    state.settings,
                  ),
                });
                explicitProfileForNextModel.current = id;
                // Before staging, so the flushSync in `startStagedSession`
                // commits the new account and its models together — otherwise
                // the carried model is momentarily absent from `pickerModels`
                // and the rows render it stripped of its capabilities.
                setCredentialProfileId(id);
                if (model) {
                  // The carried thinking level is not passed on: `setModel`
                  // clamps the current level against this very model, which
                  // is the same mapping.
                  runtimeActions.setModel(model.provider, model.id);
                } else if (profile && isNewChatRoute && !runtimeHasStarted) {
                  startStagedSession({
                    harness:
                      profile.provider === "claude" ? "claude-sdk" : "pi",
                    agentType: agentTypeForPicker,
                    thinkingLevel: "off",
                    // Restage: switching WHO runs the session keeps its mode.
                    mode: (pendingStart ?? stagedStart)?.mode,
                  });
                }
              }}
              agentTypes={availableAgentTypes}
              selectedAgentType={agentTypeForPicker}
              onSelectAgentType={switchStagedAgentType}
              // The hero states Build/Plan next to the persona that has the
              // axis; the composer's pill stays the in-conversation control.
              mode={
                hasModeAxis({ agentType: agentTypeForPicker })
                  ? (displaySession?.mode ?? "build")
                  : undefined
              }
              onSelectMode={(next) => runtimeActions.setSessionMode(next)}
              worktrees={orderedWorktrees}
              worktreesLoaded={state.worktrees !== null}
              projects={orderedPickerProjects}
              projectsLoaded={projectsLoaded}
              selectedProjectId={pendingProjectContext}
              onSelectProject={stageProjectContext}
              selectedWorktreeId={pendingWorktreeContext}
              onSelectWorktree={stageWorktreeContext}
              newWorktreeStaged={pendingNewWorktree}
              onSelectNewWorktree={stageNewWorktree}
              onOpenPicker={() =>
                setContextSheetRequest({
                  token: Date.now(),
                  field: "worktree",
                })
              }
              models={pickerModels}
              selectedModel={displaySession?.model}
              onSelectModel={(m) => runtimeActions.setModel(m.provider, m.id)}
              thinkingLevel={currentThinkingLevel}
              onSelectThinking={(level) =>
                runtimeActions.setThinkingLevel(level)
              }
            />
          ) : null}
        </div>
        {/* A first send that echoes no prompt of its own (a review handoff) is
            still a bootstrap: the surface says so rather than sitting empty. */}
        {bootstrapNarrationEl}
        <div
          className="relative z-10 shrink-0 bg-transparent transition-transform duration-150 ease-out"
          style={{
            transform:
              "translateY(calc(-1 * var(--app-keyboard-inset-bottom, 0px)))",
          }}
        >
          {composerEl}
        </div>
      </>
    );
  })();

  // The calendar's right-side detail pane (a Details inspector, no embedded
  // agent): the day report/health/Tempo/sources plus an actions row that scans,
  // opens the day's bound chat, or starts a new session.
  const calendarDetailEl = (
    <Suspense fallback={<LazySurfaceFallback label="Opening details…" />}>
      <CalendarDetailPanel
        calendar={calendarController}
        hasDaySession={!!calendarDaySessionId}
        onOpenDaySession={() =>
          calendarDaySessionId &&
          navigateFromInspector(sessionPath(calendarDaySessionId))
        }
        onNewSession={() => {
          // Stage the day report as context so a fresh session starts with a
          // reference to the day instead of a blank slate.
          const summary = calendarController.dayState?.summary;
          if (summary)
            startSessionForKnowledge(
              summary.entryId,
              `Daily summary ${calendarController.selectedDate}`,
            );
          else navigate(SESSIONS_CREATE_PATH);
        }}
        onLogTime={logMyTimeForDay}
        onOpenReport={(entryId) =>
          navigateFromInspector(knowledgePath(entryId))
        }
        scanProgress={
          state.calendarScanProgress[calendarController.selectedDate] ?? null
        }
        onScan={(date) => activateCalendarDay(date, { scan: true })}
        onOpenTask={(id) => navigateFromInspector(taskPath(id))}
      />
    </Suspense>
  );

  // The left sidebar's navigation callbacks. Opening an object just navigates: on
  // mobile that object route IS what replaces the browser screen (ui-shell.md,
  // Small Screens), and on desktop the panel stays open beside it.
  const sidebarContent = (
    <Suspense fallback={<LazySurfaceFallback label="Opening sidebar…" />}>
      <Sidebar
        sessions={state.sessions}
        archivedSessionCount={state.archivedSessionCount}
        archivedSessionsLoaded={state.archivedSessionsLoaded}
        currentId={displayCurrentId}
        readCurrentId={readCurrentSessionId}
        onSelect={openSession}
        onNavAction={runNavAction}
        onOpenBackgroundTasks={openBackgroundTasks}
        assistantLabel={
          state.settings.permanentAssistant.name || "Personal Assistant"
        }
        onArchive={archiveSession}
        onSettleSession={settleSession}
        onRenameSession={promptRenameSession}
        onDeleteSession={confirmDeleteSession}
        onLoadArchivedSessions={actions.loadArchivedSessions}
        focusToken={sidebarFocusToken}
        section={sidebarSection}
        onSectionChange={handleSidebarSectionChange}
        mobile={mobileLayout}
        onOpenCalendarView={openCalendarView}
        onStartSessionForProject={startSessionForProject}
        tasksFresh={state.taskListFresh}
        projectsFresh={state.projectListFresh}
        worktreesFresh={state.worktreesFresh}
        domainListsSubscribed={activeTopics.some(
          (topic) =>
            topic === "tasks" || topic === "projects" || topic === "worktrees",
        )}
        selectedTaskId={selectedTaskId}
        onLoadBacklog={loadBacklog}
        onOpenTask={openTaskById}
        onOpenSessionForTask={openSession}
        onStartSessionForTask={startSessionForTask}
        onNavigate={openBacklogRowLink}
        onCycleTaskStatus={cycleTaskStatus}
        onReorderTasks={reorderBacklog}
        projects={projects}
        projectsLoaded={projectsLoaded}
        projectMutations={state.projectMutations}
        selectedProjectId={selectedProjectId}
        onLoadProjects={loadProjects}
        onReorderProjects={reorderProjects}
        onOpenProject={openProject}
        worktrees={state.worktrees}
        worktreeStatuses={state.worktreeStatuses}
        lastKnownWorktreeStatuses={state.cachedWorktreeStatuses}
        worktreeHosting={worktreeHosting.hosting}
        dirtyWorktrees={dirtyWorktrees}
        workflowIndicators={workflowIndicators}
        workflowRuns={state.workflowRuns}
        workflowCards={state.workflowCards}
        onOpenWorkflowRun={openWorkflowRun}
        onSettleWorkflowRun={settleWorkflowRun}
        pullRequestInventory={pullRequestInventory.state}
        onReloadPullRequests={pullRequestInventory.reload}
        selectedPullRequest={pullRequestTarget}
        onOpenPullRequest={openPullRequest}
        selectedWorktreeId={selectedWorktreeId}
        selectedKnowledgeEntryId={selectedKnowledgeEntryId}
        selectedKnowledgeEntryPath={selectedKnowledgeEntryPath}
        selectedKnowledgeFilePath={selectedKnowledgeFilePath}
        onOpenKnowledgeEntry={openKnowledgeEntry}
        onOpenInvalidKnowledgeEntry={openInvalidKnowledgeEntry}
        onOpenKnowledgeFile={openKnowledgeFile}
        knowledgeChangedAt={knowledgeChangedAt}
        onLoadWorktrees={actions.listWorktrees}
        onOpenWorktree={openWorktree}
        onStartSessionInWorktree={startSessionInWorktree}
        activeSection={activeSettingsSection}
        onOpenSection={openSettingsSection}
        state={backlogState}
        actions={actions}
        prefs={prefs}
        onUpdatePrefs={update}
      />
    </Suspense>
  );

  // Draft-session staged context (task attach / project / worktree context
  // queued for the first prompt), surfaced in the inspector as object references.
  const stagedContextRefs: ObjectRef[] = displayHasUserPrompt
    ? []
    : [
        ...(pendingWorktreeContext
          ? worktreeObjectTreeRefs(
              state.worktrees?.find(
                (worktree) => worktree.id === pendingWorktreeContext,
              ) ?? {
                id: pendingWorktreeContext,
                branch: pendingWorktreeContext,
                ...(pendingProjectContext != null
                  ? { projectId: pendingProjectContext }
                  : {}),
              },
              projects,
              state.worktreeStatuses[pendingWorktreeContext],
            )
          : []),
        ...(pendingTaskAttach
          ? [
              {
                kind: "task" as const,
                id: pendingTaskAttach.taskId,
                title: pendingTaskAttach.title,
                subtitle: "Attached to first prompt",
              },
            ]
          : []),
        ...(pendingKnowledgeContext && !pendingTaskAttach
          ? [
              {
                kind: "knowledge" as const,
                id: pendingKnowledgeContext.entryId,
                title: pendingKnowledgeContext.title,
                subtitle: "Attached to first prompt",
              },
            ]
          : []),
        ...(pendingProjectContext &&
        !pendingWorktreeContext &&
        !pendingKnowledgeContext
          ? [
              {
                kind: "project" as const,
                id: pendingProjectContext,
                title: (() => {
                  const project = projects.find(
                    (p) => p.id === pendingProjectContext,
                  );
                  return project
                    ? `${project.key} · ${project.name}`
                    : pendingProjectContext;
                })(),
                subtitle: "Project context",
              },
            ]
          : []),
      ];

  // Open an object in the main pane from the inspector; the sidebar stays put
  // (navigation rule 2).
  const inspectorOpeners: ObjectOpeners = {
    onOpenTask: (id) => navigateFromInspector(taskPath(id)),
    onOpenProject: (id) => navigateFromInspector(projectPath(id)),
    onOpenSession: (id) => navigateFromInspector(sessionPath(id)),
    onOpenWorktree: (id) => navigateFromInspector(worktreePath(id)),
    onOpenKnowledge: (id) => navigateFromInspector(knowledgePath(id)),
  };

  const inspectedTask =
    route.name === "tasks" && route.id
      ? backlogTasks.find((t) => t.id === route.id)
      : undefined;
  const rightPanelContent = calendarRoute ? (
    calendarDetailEl
  ) : route.name === "tasks" && route.id ? (
    <TaskInspector
      task={inspectedTask}
      tasks={backlogTasks}
      sessions={state.sessions}
      openers={inspectorOpeners}
      onStartSession={startSessionForTask}
      // Only a Task with a Project can have a run worktree provisioned; the
      // server still owns the real git-backed check and refuses with a
      // readable error inside the sheet.
      onRunWorkflow={
        inspectedTask?.projectId
          ? (taskId) => setWorkflowStartTaskId(taskId)
          : undefined
      }
      onArchive={(taskId) => {
        if (runTaskArchive([taskId], taskArchiveContext, actions))
          openSidebarSection("tasks");
      }}
      onDelete={(taskId) => {
        if (!inspectedTask) return;
        // The same act as the Backlog's, through the same rules: subtree-shaped
        // and deepest first, with the count declared in the question
        // (`lib/taskDelete.ts`). Deleting the head alone from here would scatter
        // the subtasks the tree's own delete removes.
        const doomed = deleteSet(taskArchiveContext.tasks, [taskId]);
        const { title, body } = deleteConfirmation(
          taskArchiveContext.tasks,
          [taskId],
          doomed,
        );
        void dialogs
          .confirm({ title, body, confirmLabel: "Delete", danger: true })
          .then((confirmed) => {
            if (!confirmed) return;
            for (const id of doomed) actions.deleteTask(id);
            openSidebarSection("tasks");
          });
      }}
    >
      {inspectedTask && (
        <TaskContextSections
          task={inspectedTask}
          projects={projects.filter((p) => p.status !== "archived")}
          projectsById={projectsById}
          jiraHost={state.settings.jira.jiraHost}
          forgejoBaseUrl={state.settings.forgejo.baseUrl}
          onPatch={(patch) =>
            actions.saveTask({
              id: inspectedTask.id,
              status: inspectedTask.status,
              ...patch,
            })
          }
          onOpenProject={(id) => navigateFromInspector(projectPath(id))}
        />
      )}
    </TaskInspector>
  ) : route.name === "projects" && route.id ? (
    <ProjectInspector
      project={
        selectedProjectDetailState
          ? (dataOf(selectedProjectDetailState) ?? undefined)
          : undefined
      }
      projects={projects}
      tasks={backlogTasks}
      sessions={state.sessions}
      worktreeState={selectedProjectWorktreeState}
      onReloadWorktrees={reloadWorktrees}
      openers={inspectorOpeners}
      onStartSession={startSessionForProject}
      onSave={(patch) => actions.saveProject(route.id!, patch)}
      mutationStates={projectPageMutationCache.current.value}
      onArchive={() => {
        actions.archiveProject(route.id!);
      }}
      onDelete={() => {
        const project = projects.find((candidate) => candidate.id === route.id);
        void dialogs
          .confirm({
            title: `Delete Project “${project?.name ?? route.id}”?`,
            body: "This removes it from the registry and cannot be undone.",
            confirmLabel: "Delete",
            danger: true,
          })
          .then((confirmed) => {
            if (confirmed) actions.deleteProject(route.id!);
          });
      }}
    />
  ) : route.name === "worktrees" && route.id ? (
    <WorktreeInspector
      // Keyed by the worktree it inspects. The panel survives navigation
      // otherwise, and its flows hold per-worktree state — a retirement's
      // consent-bearing refusal above all, which under another branch would
      // enable a forced retirement there (`worktree/useWorktreeRetire.tsx`).
      key={route.id}
      worktree={state.worktrees?.find((item) => item.id === route.id)}
      status={state.worktreeStatuses[route.id]}
      projects={projects}
      sessions={state.sessions}
      sessionsFresh={state.sessionListFresh}
      comments={state.worktreeComments[route.id] ?? NO_WORKTREE_COMMENTS}
      reviewSets={state.worktreeReviewSets[route.id] ?? NO_WORKTREE_REVIEW_SETS}
      onOpenComment={(commentId) => openWorktreeComment(route.id!, commentId)}
      openers={inspectorOpeners}
      onStartSession={startSessionInWorktree}
      onMerge={(id) =>
        setWorktreeOverlay({
          createForProjectId: null,
          mergeWorktreeId: id,
          removeWorktreeId: null,
        })
      }
      onRemove={(id) =>
        setWorktreeOverlay({
          createForProjectId: null,
          mergeWorktreeId: null,
          removeWorktreeId: id,
        })
      }
    />
  ) : route.name === "pullRequests" ? (
    pullRequestTarget ? (
      <PullRequestInspector
        // Keyed by the pull request it inspects: the merge flow's refusal is
        // consent-bearing, and under another pull request it would arm a
        // forced checkout removal there
        // (`pullRequest/usePullRequestMergeCleanup.tsx`).
        key={`${pullRequestTarget.projectId}#${pullRequestTarget.provider}#${pullRequestTarget.repositoryKey}#${pullRequestTarget.number}`}
        state={pullRequestDetail}
        projects={projects}
        joins={pullRequestJoins}
        openers={inspectorOpeners}
        onStartSession={startSessionInWorktree}
        onReview={startPullRequestReviewDraft}
        onReload={pullRequestInventory.reload}
      />
    ) : (
      <Inspector relations={[]} actions={[]} />
    )
  ) : route.name === "knowledge" ? (
    <KnowledgeInspector
      entryId={route.entryId ?? null}
      entryPath={route.entryPath ?? null}
      refreshToken={
        route.entryId ? (state.knowledgeChangedAt[route.entryId] ?? 0) : 0
      }
      prefs={prefs}
      onUpdatePrefs={update}
      openers={inspectorOpeners}
      onStartSession={startSessionForKnowledge}
      // Mobile folds the entry viewer's header buttons in here.
    />
  ) : route.name === "settings" ||
    route.name === "usage" ||
    route.name === "backgroundTasks" ||
    route.name === "files" ||
    route.name === "artifacts" ? (
    <Inspector relations={[]} actions={[]} />
  ) : (
    <SessionInspector
      sessionId={displayCurrentId}
      originTask={sessionOriginTask}
      relatedTasks={relatedGlobalTasks}
      sessionTasks={sessionTasks}
      forkOrigin={displaySession?.forkOrigin}
      credentialProfile={(() => {
        const profileId =
          displaySessionListItem?.credentialProfileId ??
          (!runtimeHasStarted ? credentialProfileId : undefined);
        const profile = credentialProfiles.find(
          (item) => item.id === profileId,
        );
        return profile
          ? { name: profile.name, provider: profile.provider }
          : undefined;
      })()}
      // Before the first prompt the runtime is still the staged selection, the
      // same one the composer's pickers show.
      model={
        displaySession?.model ??
        (runtimeHasStarted ? undefined : defaultNewSessionModel)
      }
      thinkingLevel={
        displaySession?.thinkingLevel ??
        (runtimeHasStarted ? undefined : defaultNewSessionThinking)
      }
      sessions={state.sessions}
      projects={projects}
      worktree={(() => {
        const id = displaySession?.worktreeId;
        if (!id) return undefined;
        return (
          state.worktrees?.find((item) => item.id === id) ?? {
            id,
            branch: displayWorktreeStatus?.branch ?? "worktree",
          }
        );
      })()}
      worktreeStatus={displayWorktreeStatus}
      stagedRefs={stagedContextRefs}
      openers={inspectorOpeners}
      // Settling from the panel is the same command the inbox card sends,
      // guarded by the same shared reason — the CLUSTER's, since the command
      // shelves the peers this session coordinates along with it.
      onSettle={
        displaySessionListItem
          ? () =>
              settleSession(
                displaySessionListItem.id,
                displaySessionListItem.settledAt === undefined,
              )
          : undefined
      }
      settled={displaySessionListItem?.settledAt !== undefined}
      {...(displaySessionListItem
        ? (() => {
            const { blocked } = sessionSettleCascade(
              displaySessionListItem.id,
              state.sessions,
              state.workflowRuns,
              state.workflowCards,
            );
            return blocked ? { settleBlockedReason: blocked } : {};
          })()
        : {})}
      onRename={
        displaySessionListItem
          ? () => promptRenameSession(displaySessionListItem.id)
          : undefined
      }
      onArchive={
        displaySessionListItem
          ? () => archiveSession(displaySessionListItem.id)
          : undefined
      }
      onDelete={
        displaySessionListItem
          ? () => confirmDeleteSession(displaySessionListItem.id)
          : undefined
      }
      // On mobile the dock is the session's action home, so the chat header's two
      // controls fold in here: the worktree-diff button as an action and the
      // transcript toggles as the View section. Desktop keeps its `⋯` menu.
      onOpenWorktreeChanges={
        mobileLayout && displayWorktreeId
          ? () => navigate(worktreePath(displayWorktreeId, "changes"))
          : undefined
      }
      // Mirrors the composer's /review guards: something to review, and never
      // while the agent is streaming (a second agent on a live working tree).
      onReviewWork={
        displayHasUserPrompt && !displayStreaming
          ? () => {
              const error = startReviewSessionForSession();
              if (error) showToast(error);
            }
          : undefined
      }
      view={
        mobileLayout && displayHasMessages
          ? { ...transcriptView, onChange: updateTranscriptView }
          : undefined
      }
    >
      <SessionContextSections
        sessionId={displaySession?.sessionId}
        toolExposure={displaySession?.toolExposure}
        activeSkills={displaySession?.activeSkills}
        skillInvocations={displaySession?.skillInvocations}
        skillLibrary={state.skillLibrary}
        artifacts={sessionArtifacts}
        pendingPostReloadContinuation={pendingPostReloadContinuation}
        browserRuntimes={browserRuntimes}
        peerPrompts={peerPrompts}
        onExpandPeerPromptHistory={actions.requestPeerPromptHistory}
        onOpenSession={openSession}
        onRevealPeerPromptMessage={actions.revealPeerPromptMessage}
        {...(peerPromptRevealPendingKey ? { peerPromptRevealPendingKey } : {})}
        onCancelPostReloadContinuation={actions.cancelPostReloadContinuation}
        approvalGrants={approvalGrants}
        onRevokeApprovalGrant={actions.revokeApprovalGrant}
      />
      <BackgroundWorkSection
        sessionId={displaySessionListItem?.id}
        items={state.backgroundWorkItems}
        activity={displaySessionListItem?.backgroundActivity}
        artifacts={sessionArtifacts}
        stopPending={backgroundStopPending}
        onStop={actions.stopBackgroundWork}
        onStopAll={actions.stopAllBackgroundWork}
        onOpenRegistry={() => navigateFromInspector(backgroundTasksPath())}
        protectedTurnWait={
          displaySessionListItem
            ? state.backgroundHostCloseWaiting.includes(
                displaySessionListItem.id,
              )
            : false
        }
      />
      <LoadedMemorySection
        sessionId={displaySession?.sessionId}
        hasAcceptedUserTurn={runtimeHasStarted}
        stagedScope={{
          persona: displayAgentType,
          ...(pendingProjectContext
            ? { projectId: pendingProjectContext }
            : pendingTaskAttach
              ? (() => {
                  // Resolve the ACTUAL project from the authoritative task list rather
                  // than just showing the Task's title (a title is not a scope).
                  const task = backlogTasks.find(
                    (t) => t.id === pendingTaskAttach.taskId,
                  );
                  if (!task)
                    return {
                      pendingTaskTitle: pendingTaskAttach.title,
                      projectUnresolved: true as const,
                    };
                  return task.projectId
                    ? {
                        projectId: task.projectId,
                        pendingTaskTitle: pendingTaskAttach.title,
                      }
                    : {
                        projectIsGlobal: true as const,
                        pendingTaskTitle: pendingTaskAttach.title,
                      };
                })()
              : {}),
        }}
        memory={memory}
        loadingEnabled={state.settings.memory.loadingEnabled}
        maxCards={state.settings.memory.maxCards}
        onOpenManager={() => navigateFromInspector(settingsPath("memory"))}
      />
    </SessionInspector>
  );

  // Desktop right-panel surfaces live in a closeable tab host. The mobile dock
  // deliberately receives the Inspector directly, preserving its existing flip-up
  // interaction and action sheet.
  const desktopRightPanelContent = (
    <InspectorChromeProvider header={false} desktopTabs>
      <RightPanelTabs
        inspector={rightPanelContent}
        knowledge={
          <Suspense fallback={<PaneLoading label="Opening Knowledge…" />}>
            <KnowledgePanel
              entryId={knowledgePanelEntryId}
              failure={
                knowledgePanelEntryId
                  ? state.objectFailures.knowledge[knowledgePanelEntryId]
                  : undefined
              }
              onDismissFailure={() =>
                knowledgePanelEntryId &&
                actions.dismissObjectFailure("knowledge", knowledgePanelEntryId)
              }
              onSelectEntry={setKnowledgePanelEntryId}
              onOpenInMain={openKnowledgeEntry}
              onOpenFile={openKnowledgeFile}
              // A Knowledge link followed INSIDE the panel stays in the panel;
              // anything else is another object, which belongs in the pane that
              // addresses objects.
              onOpenPaObject={(link) =>
                link.objectType === "knowledge"
                  ? setKnowledgePanelEntryId(link.id)
                  : navigate(link.href)
              }
              changedAtByEntryId={state.knowledgeChangedAt}
              changedAt={knowledgeChangedAt}
            />
          </Suspense>
        }
        worktree={
          <Suspense fallback={<PaneLoading label="Opening worktree…" />}>
            <WorktreePanel
              worktree={
                displayWorktreeId
                  ? state.worktrees?.find(
                      (item) => item.id === displayWorktreeId,
                    )
                  : undefined
              }
              worktreeId={displayWorktreeId}
              worktreesLoaded={state.worktrees !== null}
              status={displayWorktreeStatus}
              prefs={prefs}
              onUpdatePrefs={update}
              commentsByWorktreeId={state.worktreeComments}
              commentWatch={worktreeCommentWatch}
              commentActionsFor={worktreeCommentActionsFor}
              onSubmitReview={(worktreeId, commentIds) =>
                setWorktreeSubmission({ worktreeId, commentIds })
              }
              onNavigate={navigate}
            />
          </Suspense>
        }
        // A tab nobody has looked at yet must not start fetching behind a shut
        // panel: this host stays mounted while it is closed, because the
        // Inspector publishes the page header's overflow actions from in here.
        visible={inspectorOpen}
        openRequest={rightPanelOpenRequest ?? undefined}
        onActivePanelChange={reportActiveRightPanel}
      />
    </InspectorChromeProvider>
  );

  return (
    // One definition of "what this object leads with", read by the wide page
    // header, the dock's action row and the object panel alike.
    <UserTimeZoneContext.Provider value={userTimeZone}>
      <RoutePrimaryActionProvider action={routePrimaryAction}>
        <DocumentCommentHostProvider host={documentCommentHost}>
          {/* Where a Knowledge entry named in a transcript card opens. A card is
          rendered by both chat surfaces — the main pane and the Personal
          Assistant panel — so the two targets are published, not threaded. */}
          <KnowledgeOpenTargetsProvider targets={knowledgeOpenTargets}>
            {import.meta.env.DEV ? <PerfHud /> : null}
            <AppShell
              mobile={mobileLayout}
              // No app header on small screens: its actions are nav-bar slots now and its
              // panel toggles never existed there, so the bar had nothing left to hold
              // (ui-shell.md, Small Screens). On wide layouts it survives as the home of
              // the two pane toggles, which have nowhere better yet.
              header={
                mobileLayout ? undefined : (
                  <Topbar
                    prefs={prefs}
                    updatePrefs={update}
                    sidebarOpen={sidebarPanelOpen}
                    inspectorOpen={inspectorOpen}
                    onToggleSidebar={toggleSidebarPanel}
                    onToggleInspector={() => setInspectorOpen((open) => !open)}
                    connected={state.connected}
                    reloading={state.reloading}
                    hydrationSource={state.hydrationSource}
                  />
                )
              }
              left={{
                open: sidebarPanelOpen,
                width: prefs.sidebarWidth,
                minWidth: SIDEBAR_MIN_WIDTH,
                onResize: (width) => update({ sidebarWidth: width }),
                animate: prefs.animateLeftSidebar,
                // On mobile the browser is a route-driven screen, so it has no dismiss.
                mobilePresentation: "screen",
                onDismiss: () => setSidebarOpen(false),
                label: "sidebar",
                content: sidebarContent,
              }}
              right={{
                open: inspectorOpen,
                width: prefs.taskDrawerWidth,
                minWidth: TASK_DRAWER_MIN_WIDTH,
                onResize: (width) => update({ taskDrawerWidth: width }),
                animate: prefs.animateRightDrawer,
                // On mobile the object panel is a bottom dock: peek at rest, sheet when
                // expanded. `open` therefore means expanded there.
                mobilePresentation: "dock",
                ...(dockPeek !== undefined ? { peek: dockPeek } : {}),
                mobileDockSuppressed: dockSuppressed || composerOwnsBottomEdge,
                onExpand: () => setInspectorOpen(true),
                onDismiss: () => setInspectorOpen(false),
                label: "inspector",
                // The page header owns the inspector's overflow actions on wide layouts,
                // so keep their publisher alive even when the panel itself is closed.
                keepMountedWhenClosed: true,
                // The expanded sheet is where a document's detailed zoom controls
                // live on a phone; the desktop keeps them in the viewer's header.
                content: mobileLayout ? (
                  <>
                    {documentRoute && documentNavigation?.zoom ? (
                      <DocumentZoomSection zoom={documentNavigation.zoom} />
                    ) : null}
                    {rightPanelContent}
                  </>
                ) : (
                  desktopRightPanelContent
                ),
              }}
              edgeBack={edgeBack}
            >
              {routeDocumentTarget ? (
                <DocumentNavigationMarker
                  target={routeDocumentTarget}
                  title={
                    routeDocumentTarget.path.split("/").pop() ??
                    routeDocumentTarget.path
                  }
                />
              ) : null}
              {route.name === "tasks" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Task…" />}
                >
                  <TaskManagementPage
                    backlogState={backlogState}
                    connected={state.connected}
                    detailState={selectedTaskDetailState}
                    failure={
                      selectedTaskId
                        ? state.objectFailures.task[selectedTaskId]
                        : undefined
                    }
                    onDismissFailure={() =>
                      selectedTaskId &&
                      actions.dismissObjectFailure("task", selectedTaskId)
                    }
                    commentsState={
                      selectedTaskId
                        ? state.taskComments[selectedTaskId]
                        : undefined
                    }
                    workflowRuns={selectedTaskWorkflowRuns}
                    workflowCards={selectedTaskWorkflowCards}
                    sessions={backlogSessions}
                    taskMutations={selectedTaskMutations}
                    actions={actions}
                    prefs={prefs}
                    onUpdatePrefs={update}
                    selectedId={route.id ?? null}
                    detailOnly
                    back={screenBack}
                    mobile={mobileLayout}
                    onSelect={(id) => navigate(taskPath(id))}
                    onNavigate={openBacklogRowLink}
                    onCloseDetail={() => openSidebarSection("tasks")}
                    onClose={closeSettings}
                    paObjectReferences={paObjectReferences}
                    onOpenPaObject={(link) => navigate(link.href)}
                    onOpenSession={openSession}
                    workflowIndicators={workflowIndicators}
                  />
                </Suspense>
              ) : route.name === "projects" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Projects…" />}
                >
                  <ProjectDetailPage
                    key={selectedProjectId ?? "projects-index"}
                    back={screenBack}
                    projects={projects}
                    loaded={projectsLoaded}
                    listError={state.projectListError}
                    // The failure this project is CARRYING, for the writes no control
                    // on the page tracks. Retired by its own dismiss, or by this
                    // project's next write (`docs/messaging.md`).
                    failure={
                      selectedProjectId
                        ? state.objectFailures.project[selectedProjectId]
                        : undefined
                    }
                    onDismissFailure={() =>
                      selectedProjectId &&
                      actions.dismissObjectFailure("project", selectedProjectId)
                    }
                    selectedId={selectedProjectId}
                    onLoad={loadProjects}
                    detailState={selectedProjectDetailState}
                    onLoadDetail={actions.requestProjectDetail}
                    onOpenProjection={actions.setOpenProjectProjection}
                    mutationStates={projectPageMutationCache.current.value}
                    onBackToList={projectBackToList}
                    onSave={saveProject}
                    onCloneRepo={cloneProjectRepo}
                    onRemoveClone={removeProjectRepo}
                    worktreeState={selectedProjectWorktreeState}
                    onLoadWorktrees={reloadWorktrees}
                    worktreeStatuses={projectPageStatusCache.current.value}
                    onOpenWorktree={openWorktree}
                    onCreateWorktree={createWorktreeForProject}
                    onStartSessionInWorktree={startSessionInWorktree}
                    // The project's Tasks are a section of its page, not of the object
                    // panel: the panel is for what the page cannot show.
                    renderTasks={renderProjectTasks}
                    paObjectReferences={paObjectReferences}
                    onOpenPaObject={openProjectPaObject}
                  />
                </Suspense>
              ) : route.name === "pullRequests" ? (
                <Suspense
                  fallback={
                    <LazySurfaceFallback label="Opening Pull Requests…" />
                  }
                >
                  {pullRequestTarget ? (
                    <PullRequestDetailPage
                      // R3: the page is keyed by what it addresses, so switching pull
                      // requests mounts the new one's own loading state rather than
                      // leaving the previous body under a new number.
                      key={`${pullRequestTarget.projectId}#${pullRequestTarget.provider}#${pullRequestTarget.repositoryKey}#${pullRequestTarget.number}`}
                      back={screenBack}
                      target={pullRequestTarget}
                      state={pullRequestDetail}
                      onReload={pullRequestInventory.reload}
                      projects={projects}
                      // ONE mapping, in a tested pure function: the lists AND what is
                      // known about their currency travel together, so a later tidy
                      // cannot quietly turn "not answered yet" into "there are none"
                      // (`lib/pullRequestInbox.ts`).
                      joins={pullRequestJoins}
                      status={
                        pullRequestWorktreeId
                          ? state.worktreeStatuses[pullRequestWorktreeId]
                          : undefined
                      }
                      onOpenWorktree={(id) =>
                        navigate(worktreePath(id, "changes"))
                      }
                      onOpenSession={openSession}
                      onOpenTask={openTaskById}
                    />
                  ) : (
                    <PullRequestIndexPlaceholder back={screenBack} />
                  )}
                </Suspense>
              ) : route.name === "worktrees" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Worktree…" />}
                >
                  {(() => {
                    const worktree = state.worktrees?.find(
                      (item) => item.id === route.id,
                    );
                    if (!worktree) {
                      return (
                        <WorktreePlaceholder
                          back={screenBack}
                          detail={
                            state.worktrees === null
                              ? "Loading worktrees…"
                              : "This worktree no longer exists."
                          }
                        />
                      );
                    }
                    return (
                      <WorktreeDetailPage
                        back={screenBack}
                        worktree={worktree}
                        status={state.worktreeStatuses[worktree.id]}
                        narrow={mobileLayout}
                        view={route.view ?? "changes"}
                        filePath={route.path}
                        from={route.from}
                        to={route.to}
                        anchor={route.anchor}
                        navigate={navigate}
                        prefs={prefs}
                        onUpdatePrefs={update}
                        comments={
                          state.worktreeComments[worktree.id] ??
                          NO_WORKTREE_COMMENTS
                        }
                        onLoadComments={() =>
                          worktreeCommentWatch.list(worktree.id)
                        }
                        onUnloadComments={() =>
                          worktreeCommentWatch.unwatch(worktree.id)
                        }
                        onSubmitReview={(commentIds) =>
                          setWorktreeSubmission({
                            worktreeId: worktree.id,
                            commentIds,
                          })
                        }
                        commentActions={worktreeCommentActionsFor(worktree.id)}
                        openComment={
                          worktreeCommentToOpen &&
                          worktreeCommentToOpen.worktreeId === worktree.id
                            ? {
                                commentId: worktreeCommentToOpen.commentId,
                                nonce: worktreeCommentToOpen.nonce,
                              }
                            : undefined
                        }
                      />
                    );
                  })()}
                </Suspense>
              ) : route.name === "knowledge" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Knowledge…" />}
                >
                  <KnowledgePage
                    back={screenBack}
                    failure={
                      openKnowledgeEntryId
                        ? state.objectFailures.knowledge[openKnowledgeEntryId]
                        : undefined
                    }
                    onDismissFailure={() =>
                      openKnowledgeEntryId &&
                      actions.dismissObjectFailure(
                        "knowledge",
                        openKnowledgeEntryId,
                      )
                    }
                    entryId={route.entryId ?? null}
                    entryPath={route.entryPath ?? null}
                    filePath={route.filePath ?? null}
                    assetPath={route.assetPath ?? null}
                    anchor={route.anchor}
                    onOpenPaObject={(link) => navigate(link.href)}
                    onEntryLoaded={rememberKnowledgeEntry}
                    changedAtByEntryId={state.knowledgeChangedAt}
                  />
                </Suspense>
              ) : route.name === "settings" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Settings…" />}
                >
                  <SettingsPage
                    back={screenBack}
                    models={state.models}
                    accountModels={settingsAccountModels}
                    credentialProfiles={credentialProfiles}
                    onOpenSection={(section) => navigate(settingsPath(section))}
                    projects={projects}
                    settings={state.settings}
                    memory={memory}
                    skills={state.skillLibrary}
                    prefs={prefs}
                    speechToText={state.speechToText}
                    serverBuild={state.serverBuild}
                    onUpdate={actions.updateSettings}
                    onToggleSkill={actions.setSkillEnabled}
                    onUpdatePrefs={update}
                    onRefreshModels={actions.refreshModels}
                    modelsRefreshing={state.modelsRefreshRequestId !== null}
                    section={route.section}
                    onSaveAndTestJira={actions.saveAndTestJiraSettings}
                    onTestJira={actions.testJiraSettings}
                    jiraStatus={state.jiraStatus}
                    onSaveAndTestConfluence={
                      actions.saveAndTestConfluenceSettings
                    }
                    onTestConfluence={actions.testConfluenceSettings}
                    confluenceStatus={state.confluenceStatus}
                    onUpdateTempo={actions.updateTempoSettings}
                    onSaveAndTestTempo={actions.saveAndTestTempoSettings}
                    onTestTempo={actions.testTempoSettings}
                    tempoStatus={state.tempoStatus}
                    onUpdateGoogle={actions.updateGoogleSettings}
                    onSaveAndTestGoogle={actions.saveAndTestGoogleSettings}
                    onTestGoogle={actions.testGoogleSettings}
                    googleStatus={state.googleStatus}
                    onSaveAndTestSlack={actions.saveAndTestSlackSettings}
                    onTestSlack={actions.testSlackSettings}
                    slackStatus={state.slackStatus}
                    onSaveAndTestSlackHuddles={
                      actions.saveAndTestSlackHuddleSettings
                    }
                    onTestSlackHuddles={actions.testSlackHuddleSettings}
                    slackHuddleStatus={state.slackHuddleStatus}
                    onSaveAndTestOpenAiCompatible={
                      actions.saveAndTestOpenAiCompatibleSettings
                    }
                    onTestOpenAiCompatible={
                      actions.testOpenAiCompatibleSettings
                    }
                    openAiCompatibleStatus={state.openAiCompatibleStatus}
                    onSaveAndTestBrave={actions.saveAndTestBraveSettings}
                    onTestBrave={actions.testBraveSettings}
                    braveStatus={state.braveStatus}
                    onSaveAndTestContext7={actions.saveAndTestContext7Settings}
                    onTestContext7={actions.testContext7Settings}
                    context7Status={state.context7Status}
                    onSaveAndTestGithub={actions.saveAndTestGithubSettings}
                    onTestGithub={actions.testGithubSettings}
                    githubStatus={state.githubStatus}
                    onSaveAndTestForgejo={actions.saveAndTestForgejoSettings}
                    onTestForgejo={actions.testForgejoSettings}
                    forgejoStatus={state.forgejoStatus}
                  />
                </Suspense>
              ) : route.name === "calendar" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Calendar…" />}
                >
                  <CalendarPage
                    back={screenBack}
                    calendar={calendarController}
                    prefs={prefs}
                    onUpdatePrefs={update}
                    onFocusDay={() => setInspectorOpen(true)}
                  />
                </Suspense>
              ) : route.name === "usage" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening Usage…" />}
                >
                  <UsagePage back={screenBack} />
                </Suspense>
              ) : route.name === "files" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening file…" />}
                >
                  <FileViewerPage path={route.path} anchor={route.anchor} />
                </Suspense>
              ) : route.name === "artifacts" ? (
                <Suspense
                  fallback={<LazySurfaceFallback label="Opening artifact…" />}
                >
                  <SessionArtifactViewer
                    sessionId={route.sessionId}
                    path={route.path}
                    anchor={route.anchor}
                  />
                </Suspense>
              ) : route.name === "backgroundTasks" ? (
                <Suspense
                  fallback={
                    <LazySurfaceFallback label="Opening background work…" />
                  }
                >
                  <BackgroundTasksPage
                    back={screenBack}
                    items={state.backgroundWorkItems}
                    truncated={state.backgroundWorkTruncated}
                    sessions={state.sessions}
                    anchoredId={route.taskId}
                    stopPending={backgroundStopPending}
                    onStop={actions.stopBackgroundWork}
                    onStopAllForOwner={actions.stopAllBackgroundWork}
                    onOpenSession={openSession}
                  />
                </Suspense>
              ) : (
                <>
                  {chatHeaderHidden ? null : (
                    <PageHeader
                      back={screenBack}
                      {...sessionHeaderIcon("session", {
                        harness: displayHarness,
                        agentType: displayAgentType,
                      })}
                      // The session header is always one compact identity row. Counts have a
                      // richer home in the right panel's Tasks and Tools sections; the glyph
                      // carries the session-id copy action on every viewport.
                      density="compact"
                      icon={
                        sessionIdCopied ? (
                          <Check size={16} strokeWidth={2.5} />
                        ) : (
                          chatHeaderGlyph
                        )
                      }
                      onIconClick={copySessionId}
                      iconLabel={
                        sessionIdCopied ? "Copied!" : "Copy session ID"
                      }
                      objectOverflow={false}
                      // The Plan badge rides the identity row so the mode is visible
                      // wherever the session is, tracking the server record (the
                      // optimistic staged session only until adoption).
                      title={
                        displaySession?.mode === "plan" ? (
                          <div className="flex min-w-0 items-center gap-2">
                            {sessionTitleHeading}
                            <PlanModeBadge />
                          </div>
                        ) : (
                          sessionTitleHeading
                        )
                      }
                      // Mobile folds both of these into the object dock (ui-shell.md, Small
                      // Screens), leaving this row to identity alone.
                      actions={
                        mobileLayout ? undefined : (
                          <div className="flex items-center gap-1">
                            {displayWorktreeId && (
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(
                                    worktreePath(displayWorktreeId, "changes"),
                                  )
                                }
                                title="View this session's worktree changes"
                                aria-label="View this session's worktree changes"
                                className="relative flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-panel hover:text-fg"
                              >
                                {/* Same rule as the dock's row and the inspector's action: the
                      glyph is the worktree this leaves for, not the diff it opens on. */}
                                <GitBranch size={16} />
                                {displayWorktreeStatus?.dirty && (
                                  <UnreadDot title="Worktree has uncommitted changes" />
                                )}
                              </button>
                            )}
                            <ChatHeaderMenu
                              mobile={mobileLayout}
                              view={
                                displayHasMessages
                                  ? {
                                      ...transcriptView,
                                      onChange: updateTranscriptView,
                                    }
                                  : undefined
                              }
                            />
                          </div>
                        )
                      }
                    />
                  )}

                  {/* A cached boot paint is the one case where the stage shows a
                transcript nobody has revalidated yet; a streaming row narrates
                that itself, and two narrations for one source is exactly what
                the model forbids. */}
                  {usePreview && !previewHasStreamingMessage && (
                    <SessionRefreshMark />
                  )}

                  {chatSurface}
                </>
              )}
            </AppShell>
            {worktreeOverlay.createForProjectId ||
            worktreeOverlay.mergeWorktreeId ||
            worktreeOverlay.removeWorktreeId ? (
              <Suspense
                fallback={
                  <LazySurfaceFallback label="Opening worktree tools…" />
                }
              >
                <WorktreeOverlays
                  overlay={worktreeOverlay}
                  onChange={setWorktreeOverlay}
                  state={state}
                  projects={projects}
                  actions={actions}
                  onOpenSession={(id) => navigate(sessionPath(id))}
                />
              </Suspense>
            ) : null}
            {worktreeSubmission
              ? (() => {
                  const worktree = (state.worktrees ?? []).find(
                    (candidate) =>
                      candidate.id === worktreeSubmission.worktreeId,
                  );
                  if (!worktree) return null;
                  return (
                    <WorktreeReviewSubmitSheet
                      worktree={worktree}
                      commentIds={worktreeSubmission.commentIds}
                      sessions={state.sessions}
                      onClose={() => setWorktreeSubmission(null)}
                      onSubmit={(commentIds, target) => {
                        submitWorktreeReview(worktree.id, commentIds, target);
                        setWorktreeSubmission(null);
                      }}
                    />
                  );
                })()
              : null}
            {workflowStartTaskId
              ? (() => {
                  const task = backlogTasks.find(
                    (candidate) => candidate.id === workflowStartTaskId,
                  );
                  if (!task) return null;
                  return (
                    <WorkflowRunStartSheet
                      task={task}
                      tasks={backlogTasks}
                      models={settingsAccountModels}
                      worktrees={state.worktrees ?? []}
                      usageIndicators={state.usageIndicators}
                      storedRuntimes={prefs.workflowRoleRuntimes}
                      storedLimits={prefs.workflowRunLimits}
                      startStates={state.workflowRunStarts}
                      onStart={actions.startWorkflowRun}
                      onRemember={({ runtimes, limits }) =>
                        update({
                          workflowRoleRuntimes: runtimes,
                          workflowRunLimits: limits,
                        })
                      }
                      onContinueInBackground={(requestId) =>
                        setBackgroundWorkflowStarts((current) =>
                          current.includes(requestId)
                            ? current
                            : [...current, requestId],
                        )
                      }
                      onClearStart={actions.clearWorkflowRunStart}
                      onClose={() => setWorkflowStartTaskId(null)}
                    />
                  );
                })()
              : null}
            {/* The app status slot's narrow-layout placement; the wide one lives in
          `Topbar`. Mounted unconditionally and gating itself: it owns the grace
          period before a dropped socket is worth saying out loud, so the
          decision has to survive the state changing. Its hooks are its own —
          the `App` hook rule in `CLAUDE.md` is not in play. */}
            <AppStatus
              connected={state.connected}
              reloading={state.reloading}
              hydrationSource={state.hydrationSource}
              placement="floating"
            />
            <ToastViewport />
          </KnowledgeOpenTargetsProvider>
        </DocumentCommentHostProvider>
      </RoutePrimaryActionProvider>
    </UserTimeZoneContext.Provider>
  );
}

export default function App() {
  return (
    <CommentActuationProvider>
      <AppContent />
    </CommentActuationProvider>
  );
}
