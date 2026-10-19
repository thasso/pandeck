import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  ChevronRight,
  Inbox,
  Lightbulb,
  CornerLeftUp,
  CalendarCheck,
  Check,
  ClipboardList,
  Flag,
  Pencil,
  Ticket,
  Undo2,
} from "lucide-react";
import { Button } from "./ui/button.tsx";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { followRowLink } from "../lib/rowLink.ts";
import { belongsInInbox, taskOrigin } from "../lib/backlogInbox.ts";
import { AppCard } from "./common/AppCard.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { ActionRow } from "./common/ActionRow.tsx";
import { TaskLinkList } from "./TaskLinkList.tsx";
import {
  TitleDescriptionEditor,
  type TitleDescriptionChanges,
} from "./common/TitleDescriptionEditor.tsx";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  ProjectRecord,
  PullRequestMergeMethod,
  SessionListItem,
  TaskItem,
  WorkflowCeilingRaise,
  WorkflowCommitCheckChoice,
  WorkflowRunSummary,
} from "@assistant/shared";
import { taskSummaryOf } from "@assistant/shared";
import {
  taskMutationKey,
  type AssistantActions,
  type ClientWorkflowRunCard,
  type UIState,
} from "../hooks/useAssistant.ts";
import type { BacklogState } from "../hooks/useBacklog.ts";
import type { Prefs } from "../hooks/usePrefs.ts";
import { AppHeaderBar } from "./AppHeaderBar.tsx";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { TASK_STATUS_LABEL, TaskStatusIcon } from "./TaskStatusIcon.tsx";
import { copyWithToast } from "../lib/clipboard.ts";
import { Markdown, type MarkdownPaObjectReference } from "./Markdown.tsx";
import {
  ResizableSeparator,
  useResizeDrag,
} from "./common/ResizableSeparator.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import {
  dataOf,
  errorOf,
  idle,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import {
  acceptStatusSuggestionSave,
  flattenTasks,
  answeredStatusClaim,
  pendingStatusSuggestion,
  type Task,
} from "../lib/backlogTree.ts";
import { BacklogList } from "./BacklogList.tsx";
import { browserRowDensity } from "../lib/rowDensity.ts";
import { dueLabel, scheduledLabel } from "../lib/backlogFocus.ts";
import { todayIso } from "../lib/taskDates.ts";
import { useUserTimeZone } from "../hooks/useUserTimeZone.ts";
import { ProjectSelector } from "./ProjectSelector.tsx";
import { ticketFallbackUrl, useTicketDetails } from "./TaskTicketProperty.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";

/** The statuses in the order a Task moves through them. */
const TASK_STATUSES: Task["status"][] = ["todo", "doing", "done"];
import { buildProjectsById } from "../lib/projectDisplay.ts";
import { projectPath } from "../hooks/useSessionRouting.ts";
import { useListScroll } from "../hooks/useListScroll.ts";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";
import { TaskLinksSection } from "./TaskLinksSection.tsx";
import { TaskInitiativesSection } from "./TaskInitiativeList.tsx";
import { TaskBlockedIndicator } from "./TaskBlockedIndicator.tsx";
import { usePrefersReducedMotion } from "./shell/usePrefersReducedMotion.ts";
import { useLocationHash } from "../hooks/useLocationHash.ts";
import {
  runIdFromHash,
  workflowRunAnchorId,
} from "../lib/workflowRunRoutes.ts";
import type { WorkflowIndicators } from "../lib/workflowIndicator.ts";

const IDLE_DETAIL = idle<TaskItem | null>();

// Master/detail split sizing. The master (list) width is resizable and persisted;
// the detail keeps at least DETAIL_MIN_WIDTH so it stays usable. The split shows
// only when the page is wide enough to fit both panes; below that one shows at a
// time. The decision is driven by the measured page width (not a device media
// query) so it is correct regardless of how the page is laid out.
const MASTER_MIN_WIDTH = 280;
const DETAIL_MIN_WIDTH = 380;
const SPLIT_MIN_WIDTH = MASTER_MIN_WIDTH + DETAIL_MIN_WIDTH;
const MASTER_KEYBOARD_STEP = 16;

function getMasterMaxWidth(pageWidth: number): number {
  return Math.max(MASTER_MIN_WIDTH, pageWidth - DETAIL_MIN_WIDTH);
}

function clampMasterWidth(width: number, pageWidth: number): number {
  return Math.min(
    Math.max(Math.round(width), MASTER_MIN_WIDTH),
    getMasterMaxWidth(pageWidth),
  );
}

/**
 * @component TaskManagementPage
 * @purpose Backlog Task detail surface: the task document (title, status, description).
 * @useWhen A Task detail route such as /tasks/:id needs title/status/description editing.
 * @avoidWhen Task context (project, Jira, links) or linked sessions; those live in the task inspector (TaskContextSections + relations). Session execution plans live in the session inspector.
 * @intent A clean document in the main pane; the sidebar owns list browsing and the inspector owns connections/actions. Inline edits are triggered by ghost icon buttons, never by clicking prose.
 */
export function TaskManagementPage({
  backlogState,
  connected,
  detailState = IDLE_DETAIL,
  failure,
  onDismissFailure,
  workflowRuns,
  workflowCards,
  accountNames,
  sessions,
  taskMutations,
  actions,
  prefs,
  onUpdatePrefs,
  selectedId,
  detailOnly = false,
  back,
  mobile = false,
  onSelect,
  onCloseDetail,
  onClose,
  onNavigate,
  paObjectReferences = [],
  onOpenPaObject,
  onOpenSession,
  workflowIndicators,
}: {
  backlogState: BacklogState;
  connected: boolean;
  detailState?: LoadState<TaskItem | null> | undefined;
  /**
   * The failure the OPEN Task is carrying (`docs/messaging.md`) — a write about
   * the Task itself that no control here tracks, archiving it being the usual
   * one. A Task that is only a row in the list carries none: a row has no
   * failure surface, so such a failure is announced naming the Task instead.
   */
  failure?: string | undefined;
  onDismissFailure?: () => void;
  workflowRuns: WorkflowRunSummary[] | null;
  workflowCards: Record<string, ClientWorkflowRunCard>;
  /** Account names by credential profile id, for the run card's roles. */
  accountNames: Readonly<Record<string, string>>;
  sessions: SessionListItem[];
  taskMutations: UIState["taskMutations"];
  actions: AssistantActions;
  prefs: Prefs;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  selectedId: string | null;
  detailOnly?: boolean;
  /** Mobile screen back control (ui-shell.md, Small Screens). */ back?:
    PageHeaderBack | undefined;
  /** Small-screen layout: object actions live in the bottom object dock, not this header. */ mobile?: boolean;
  onSelect: (id: string) => void;
  onCloseDetail: () => void;
  onClose: () => void;
  /** Follow one of the links a Task row's second line draws (`TaskRowBody`). */
  onNavigate?: (path: string) => void;
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenPaObject?: (link: MarkdownPaObjectReference) => void;
  /** Navigate to one of the run's role sessions in the screens model. */
  onOpenSession: (id: string) => void;
  /** Content-stable active/paused markers for the optional master list. */
  workflowIndicators?: WorkflowIndicators;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const masterWidth = prefs.backlogMasterWidth;

  // Measure the actual page width so the split decision and width clamping track
  // the real container, not an assumed device breakpoint.
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const update = () => setPageWidth(el.offsetWidth);
    update();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  const effectivePageWidth =
    pageWidth || (typeof window !== "undefined" ? window.innerWidth : 1280);
  const wide = effectivePageWidth >= SPLIT_MIN_WIDTH;

  const resizeMasterTo = useCallback(
    (width: number) => {
      onUpdatePrefs({
        backlogMasterWidth: clampMasterWidth(width, effectivePageWidth),
      });
    },
    [effectivePageWidth, onUpdatePrefs],
  );

  const masterResize = useResizeDrag({
    onResize: useCallback(
      (clientX: number) => {
        const left = pageRef.current?.getBoundingClientRect().left ?? 0;
        resizeMasterTo(clientX - left);
      },
      [resizeMasterTo],
    ),
  });

  const handleMasterResizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeMasterTo(masterWidth - MASTER_KEYBOARD_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeMasterTo(masterWidth + MASTER_KEYBOARD_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeMasterTo(MASTER_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      resizeMasterTo(getMasterMaxWidth(effectivePageWidth));
    }
  };

  const items = useMemo(
    () => backlogState.taskList?.items ?? [],
    [backlogState.taskList],
  );
  const projectsById = useMemo(
    () => buildProjectsById(backlogState.projectList?.projects ?? []),
    [backlogState.projectList],
  );
  // "Today" for planning an Inbox arrival, in the user's own time zone.
  const timeZone = useUserTimeZone();

  // The Backlog is the one list this page browses, so it remembers where the
  // reader was across opening a Task and coming back.
  const listScrollRef = useListScroll({
    listKey: detailOnly ? null : "page:tasks",
  });

  const setTaskProject = (item: Task, projectId: string | null) => {
    actions.saveTask({ id: item.id, status: item.status, projectId }, "edit");
  };

  // An agent's status suggestion, answered here as in the Focus view: accept
  // is an ordinary save that also clears the claim, dismiss clears only it.
  const acceptSuggestion = (item: Task) => {
    const to = item.statusSuggestion?.to;
    if (to)
      actions.saveTask(
        acceptStatusSuggestionSave({ id: item.id, to }),
        "status",
      );
  };
  const dismissSuggestion = (item: Task) => {
    actions.saveTask(
      { id: item.id, status: item.status, clearStatusSuggestion: true },
      "status",
    );
  };

  // The Inbox's two answers, as its list row gives them: let it into the
  // Backlog as is, or plan it for today (which triages it too).
  const dismissFromInbox = (item: Task) => {
    actions.saveTask(
      { id: item.id, status: item.status, triaged: true },
      "edit",
    );
  };
  const planToday = (item: Task) => {
    actions.saveTask(
      { id: item.id, status: item.status, scheduledFor: todayIso(timeZone) },
      "edit",
    );
  };

  const setTaskStatus = (item: Task, status: Task["status"]) => {
    if (status === item.status) return;
    actions.saveTask({ id: item.id, status }, "status");
  };

  // Title and description are edited together, so they save together: one
  // request carrying only the fields that changed (an unchanged title is
  // omitted, never echoed back).
  const editTask = (item: Task, changes: TitleDescriptionChanges) => {
    const description =
      changes.description !== undefined
        ? { description: changes.description }
        : {};
    if (changes.title !== undefined)
      actions.saveTask(
        {
          id: item.id,
          title: changes.title,
          status: item.status,
          ...description,
        },
        "edit",
      );
    else
      actions.saveTask(
        { id: item.id, status: item.status, ...description },
        "edit",
      );
  };

  // Progress rollups for every task (order-independent) so the detail panel can
  // show a parent's subtree progress.
  const progressById = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const entry of flattenTasks(items)) {
      if (entry.descendantCount > 0)
        map.set(entry.item.id, {
          done: entry.doneDescendantCount,
          total: entry.descendantCount,
        });
    }
    return map;
  }, [items]);

  // The page is routed on the selected ID, not on the Backlog row: an archived
  // Task — reached through a link — has no row in the live list, so its page
  // is drawn from its body, and `getTask` is asked either way.
  const selectedRow = selectedId
    ? (items.find((item) => item.id === selectedId) ?? null)
    : null;
  const selectedBody = dataOf(detailState);
  const bodySummary = useMemo(
    () =>
      selectedBody && selectedBody.id === selectedId
        ? taskSummaryOf(selectedBody)
        : null,
    [selectedBody, selectedId],
  );
  const selectedTask = selectedRow ?? bodySummary;
  const selectedRuns = useMemo(
    () =>
      (workflowRuns ?? [])
        .filter((run) => run.taskId === selectedId)
        .sort((left, right) => right.createdAt - left.createdAt),
    [workflowRuns, selectedId],
  );
  const detailOnlyActive = detailOnly;
  // A body known NOT to exist — answered, or retained through a later read
  // that is still on its way or failed. Only a settled answer says so on the
  // page (`detailNotFound`); the others show that read's own state.
  const detailUnavailable = dataOf(detailState) === null;
  const detailNotFound =
    detailState.status === "ready" && detailState.data === null;

  // The open Task is a cache pin, independent of whether its body is currently
  // loading or ready. Late replies for other ids may fill the LRU without ever
  // evicting the document this route is still showing.
  useEffect(() => {
    actions.setOpenTaskProjection(selectedId);
    return () => actions.setOpenTaskProjection(null);
  }, [actions, selectedId]);

  // The reducer owns freshness and correlation. An absent key starts once; a
  // newer summary marks retained data `refreshing`, which starts the same keyed
  // read without blanking the body.
  useEffect(() => {
    if (!selectedId || !connected) return;
    const detail = dataOf(detailState);
    const disconnectedFailure =
      detailState.status === "error" &&
      detailState.error.startsWith("Connection lost");
    if (
      detailState.status === "idle" ||
      detailState.status === "refreshing" ||
      disconnectedFailure ||
      (detail && selectedRow && detail.updatedAt < selectedRow.updatedAt)
    )
      actions.requestTaskDetail(selectedId);
  }, [actions, connected, detailState, selectedId, selectedRow]);
  const detailError = errorOf(detailState);

  return (
    <div
      ref={pageRef}
      className="flex h-full min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      {!detailOnlyActive ? (
        <AppHeaderBar className="gap-3" safeAreaTop={false}>
          <IconButton label="Back to chat" onClick={onClose}>
            <ArrowLeft />
          </IconButton>
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
            <ClipboardList size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">
              Backlog
            </h1>
            <p className="truncate text-sm text-muted-foreground">
              Your durable list of Tasks.
            </p>
          </div>
        </AppHeaderBar>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!detailOnlyActive ? (
          <section
            className={`relative h-full min-h-0 flex-col ${wide ? "flex shrink-0 border-r border-border" : selectedId ? "hidden" : "flex w-full"}`}
            style={
              wide
                ? { width: clampMasterWidth(masterWidth, effectivePageWidth) }
                : undefined
            }
          >
            <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-5">
                <BacklogList
                  state={backlogState}
                  actions={actions}
                  prefs={prefs}
                  onUpdatePrefs={onUpdatePrefs}
                  selectedId={selectedId}
                  onOpenTask={onSelect}
                  onNavigate={onNavigate}
                  workflowIndicators={workflowIndicators}
                  density={browserRowDensity(mobile)}
                  showAddTask
                />
              </div>
            </div>
            {wide ? (
              <ResizableSeparator
                edge="right"
                label="task list"
                min={MASTER_MIN_WIDTH}
                max={getMasterMaxWidth(effectivePageWidth)}
                value={masterWidth}
                resizing={masterResize.resizing}
                onPointerDown={masterResize.onPointerDown}
                onKeyDown={handleMasterResizeKey}
              />
            ) : null}
          </section>
        ) : null}

        <section
          className={`h-full min-h-0 min-w-0 flex-1 flex-col ${detailOnlyActive || wide || selectedId ? "flex" : "hidden"}`}
        >
          {/* Outside the branch below, so the failure is rendered whether or not
              this Task's body arrived: a delete that the server refuses has
              already taken the row out of the list optimistically, and a note
              only the loaded panel could draw would be claimed by this surface
              and then shown by nothing. */}
          {failure && selectedId ? (
            <div className="shrink-0 px-5 pt-4">
              <ErrorNote
                message={failure}
                onRetry={onDismissFailure}
                retryLabel="Dismiss"
              />
            </div>
          ) : null}
          {selectedTask && !detailUnavailable ? (
            <TaskDetailPanel
              key={selectedTask.id}
              projectsById={projectsById}
              onNavigate={onNavigate}
              back={back}
              mobile={mobile}
              item={selectedTask}
              detailState={detailState}
              progress={progressById.get(selectedTask.id)}
              parentTask={
                selectedTask.parentId
                  ? items.find((task) => task.id === selectedTask.parentId)
                  : undefined
              }
              subtasks={items.filter(
                (task) => task.parentId === selectedTask.id,
              )}
              taskTitle={(id) => items.find((task) => task.id === id)?.title}
              onOpenTask={onSelect}
              runs={selectedRuns}
              runsLoaded={workflowRuns !== null}
              workflowCards={workflowCards}
              accountNames={accountNames}
              sessions={sessions}
              onOpenSession={onOpenSession}
              onPauseRun={actions.pauseWorkflowRun}
              onResumeRun={actions.resumeWorkflowRun}
              onCancelRun={actions.cancelWorkflowRun}
              onDeleteRun={actions.deleteWorkflowRun}
              onRetryRun={actions.retryWorkflowRun}
              onAnswerCeiling={actions.answerWorkflowCeiling}
              onAnswerCommitCheck={actions.answerWorkflowCommitCheck}
              onRebaseAndReviewRun={actions.rebaseAndReviewWorkflowRun}
              onMergeRun={actions.mergeWorkflowRun}
              onCleanUpRun={actions.cleanUpWorkflowRun}
              onSetStatus={(status) => setTaskStatus(selectedTask, status)}
              onAcceptSuggestion={() => acceptSuggestion(selectedTask)}
              onDismissSuggestion={() => dismissSuggestion(selectedTask)}
              onDismissFromInbox={() => dismissFromInbox(selectedTask)}
              onPlanToday={() => planToday(selectedTask)}
              onEdit={(changes) => editTask(selectedTask, changes)}
              onSetProject={(projectId) =>
                setTaskProject(selectedTask, projectId)
              }
              statusMutation={
                taskMutations[taskMutationKey(selectedTask.id, "status")]
              }
              editMutation={
                taskMutations[taskMutationKey(selectedTask.id, "edit")]
              }
              onRetryDetail={() => actions.requestTaskDetail(selectedTask.id)}
              onRestore={() => actions.archiveTask(selectedTask.id, false)}
              paObjectReferences={paObjectReferences}
              onOpenPaObject={onOpenPaObject}
            />
          ) : selectedId && detailError ? (
            // The current read failed, and there is no body to draw the page
            // from — even one an earlier answer said does not exist: the
            // failure is what is true now, and it can be retried.
            <div className="px-5 pt-4">
              <ErrorNote
                message={detailError}
                onRetry={() => actions.requestTaskDetail(selectedId)}
              />
            </div>
          ) : selectedId && detailNotFound ? (
            // The server answered: there is no such Task (never was, or it was
            // deleted). No way out is offered — where to go next is the user's
            // call, and the shell's navigation is what answers it.
            <div className="flex h-full items-center justify-center px-6">
              <EmptyBox>Task-{selectedId} does not exist.</EmptyBox>
            </div>
          ) : selectedId ? (
            // A Task IS addressed; the list or the body carrying it has not
            // arrived yet, or a re-read of one said to be missing is under way.
            // "Select a task" here would deny the route.
            <PaneLoading label="Loading Task…" className="h-full" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
              <div className="flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground">
                <ClipboardList size={18} />
              </div>
              <p className="text-sm">Select a task to see its details.</p>
              {detailOnlyActive ? (
                <Button
                  variant="outline"
                  className="mt-2"
                  onClick={onCloseDetail}
                >
                  Open Backlog list
                </Button>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Reveal the run a `#workflow-run-<id>` address names: scroll its Workflow card
 * into view and focus it, once it EXISTS.
 *
 * The wait is the whole hook. This page arrives at the address with neither
 * load finished — the Task's row comes from the Backlog list and its runs from
 * the `workflow` topic, each on its own broadcast — so the browser's native
 * fragment scrolling resolves against a page that has no such element yet and
 * then never tries again. Waiting for the run to be in `runs` is what makes the
 * jump land on the card rather than at the top of the Task.
 *
 * The reveal is performed once per address and CLEARED by leaving it, so
 * scrolling away and coming back to the same link jumps again instead of being
 * suppressed by a stale key — the same rule the transcript's `#m-` reveal uses.
 * Focus follows the scroll because the run is the object the user asked for:
 * the keyboard has to arrive there too, and `preventScroll` keeps that from
 * fighting the animation.
 */
function useWorkflowRunAnchor(
  runs: WorkflowRunSummary[],
  runsLoaded: boolean,
): void {
  const hash = useLocationHash();
  const reducedMotion = usePrefersReducedMotion();
  const runId = runIdFromHash(hash);
  const present =
    runsLoaded && runId !== null && runs.some((run) => run.id === runId);
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!runId) {
      revealed.current = null;
      return;
    }
    if (!present || revealed.current === runId) return;
    const node = document.getElementById(workflowRunAnchorId(runId));
    if (!node) return;
    revealed.current = runId;
    node.scrollIntoView({
      block: "start",
      behavior: reducedMotion ? "auto" : "smooth",
    });
    node.focus({ preventScroll: true });
  }, [runId, present, reducedMotion]);
}

/**
 * Task detail: status, inline-editable title, subtle source links, markdown
 * description, explicit Jira links, related links, and linked agent sessions.
 * Low-risk title and description edits use the shared shadcn inputs in place.
 */
function TaskDetailPanel({
  projectsById,
  onNavigate,
  back,
  mobile,
  item,
  detailState,
  progress,
  parentTask,
  subtasks,
  taskTitle,
  onOpenTask,
  runs,
  runsLoaded,
  workflowCards,
  accountNames,
  sessions,
  onOpenSession,
  onPauseRun,
  onResumeRun,
  onCancelRun,
  onDeleteRun,
  onRetryRun,
  onAnswerCeiling,
  onAnswerCommitCheck,
  onRebaseAndReviewRun,
  onMergeRun,
  onCleanUpRun,
  onSetStatus,
  onAcceptSuggestion,
  onDismissSuggestion,
  onDismissFromInbox,
  onPlanToday,
  onEdit,
  onSetProject,
  statusMutation,
  editMutation,
  onRetryDetail,
  onRestore,
  paObjectReferences,
  onOpenPaObject,
}: {
  projectsById: Map<string, ProjectRecord>;
  onNavigate?: ((path: string) => void) | undefined;
  back?: PageHeaderBack | undefined;
  mobile?: boolean;
  item: Task;
  /**
   * The fetched full Task, carrying its lazily loaded Markdown body.
   * `undefined` while it is still on its way — the row itself supplies title and
   * status, so the panel renders at once.
   */
  detailState: LoadState<TaskItem | null>;
  progress?: { done: number; total: number } | undefined;
  /** The Task this one is a subtask of, when the Backlog holds it. */
  parentTask?: Task | undefined;
  /** Its direct subtasks, in Backlog order. */
  subtasks: Task[];
  /** A Task's live title, when the Backlog holds it. */
  taskTitle: (id: string) => string | undefined;
  onOpenTask: (id: string) => void;
  runs: WorkflowRunSummary[];
  runsLoaded: boolean;
  workflowCards: UIState["workflowCards"];
  accountNames: Readonly<Record<string, string>>;
  sessions: UIState["sessions"];
  onOpenSession: (id: string) => void;
  onPauseRun: (id: string) => void;
  onResumeRun: (id: string) => void;
  onCancelRun: (id: string) => void;
  onDeleteRun: (
    id: string,
    options: { deleteWorktree: boolean; archiveSessions: boolean },
  ) => void;
  onRetryRun: (id: string) => void;
  onAnswerCeiling: (
    runId: string,
    choice: "raise" | "deliver" | "re-evaluate" | "cancel",
    raise?: WorkflowCeilingRaise,
  ) => void;
  onAnswerCommitCheck: (
    runId: string,
    choice: WorkflowCommitCheckChoice,
  ) => void;
  onRebaseAndReviewRun: (id: string) => void;
  onMergeRun: (
    id: string,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch: boolean },
  ) => void;
  onCleanUpRun: (id: string) => void;
  onSetStatus: (status: Task["status"]) => void;
  onAcceptSuggestion: () => void;
  onDismissSuggestion: () => void;
  onDismissFromInbox: () => void;
  onPlanToday: () => void;
  onEdit: (changes: TitleDescriptionChanges) => void;
  onSetProject: (projectId: string | null) => void;
  statusMutation?: LoadState<true> | undefined;
  editMutation?: LoadState<true> | undefined;
  onRetryDetail: () => void;
  /** Bring an archived Task back into the Backlog. */
  onRestore: () => void;
  paObjectReferences: MarkdownPaObjectReference[];
  onOpenPaObject?: ((link: MarkdownPaObjectReference) => void) | undefined;
}) {
  // `undefined` means the body has not arrived yet. It must stay distinct from
  // "" — editing is disabled until it lands, so an empty editor can never be
  // saved over a real description that simply had not loaded.
  const detail = dataOf(detailState) ?? undefined;
  const description = detail?.description;
  const descriptionLoaded = description !== undefined;
  const descriptionText = description ?? "";
  const detailRefreshing = detailState.status === "refreshing";
  const detailLoading =
    detailState.status === "idle" || detailState.status === "loading";
  const detailError = errorOf(detailState);

  // The prose is not clickable; the section action owns edit mode.
  const [editing, setEditing] = useState(false);
  // Brief confirmation on the header glyph after it copies the task id.
  const [idCopied, setIdCopied] = useState(false);
  useWorkflowRunAnchor(runs, runsLoaded);

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* One row of IDENTITY: the glyph and the id. The title and the status moved
            into the page body, where a title can wrap in full instead of truncating
            and where the status reads as information rather than chrome. The glyph
            copies the id — the thing you paste into a prompt or a commit message —
            the same gesture the session header's glyph carries. */}
        <PageHeader
          back={back}
          density="compact"
          icon={
            idCopied ? (
              <Check size={16} strokeWidth={2.5} />
            ) : (
              <ClipboardList size={16} />
            )
          }
          onIconClick={() => {
            void copyWithToast(`Task-${item.id}`, {
              successMessage: `Task-${item.id} copied`,
            }).then((ok) => {
              if (!ok) return;
              setIdCopied(true);
              window.setTimeout(() => setIdCopied(false), 1200);
            });
          }}
          iconLabel={idCopied ? "Copied!" : `Copy Task-${item.id}`}
          title={
            <span className="select-all font-mono text-sm text-muted-foreground">
              Task-{item.id}
            </span>
          }
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-5 py-6">
            <TaskTitleBlock
              item={item}
              progress={progress}
              parentTask={parentTask}
              subtasks={subtasks}
              onOpenTask={onOpenTask}
              onAcceptSuggestion={onAcceptSuggestion}
              onDismissSuggestion={onDismissSuggestion}
              onDismissFromInbox={onDismissFromInbox}
              onPlanToday={onPlanToday}
              onRestore={onRestore}
              onOpenSession={onOpenSession}
              sessions={sessions}
              projectsById={projectsById}
              onNavigate={onNavigate}
              onSetProject={onSetProject}
              editor={
                editing ? (
                  <TitleDescriptionEditor
                    title={item.title}
                    description={descriptionText}
                    titleLabel="Task title"
                    descriptionLabel="Task description"
                    onSave={onEdit}
                    submitState={editMutation}
                    onClose={() => setEditing(false)}
                  />
                ) : null
              }
              statusMutation={statusMutation}
              // The status control lives HERE on a wide layout and in the object
              // dock's action row on a phone — the dock is the object's action home
              // there, so this block shows the state and does not offer to change it.
              // An archived Task shows it too: Restore is its one action.
              onSetStatus={
                mobile || item.archivedAt !== undefined
                  ? undefined
                  : onSetStatus
              }
            />

            {/* The other Tasks this one waits on, holds up or relates to. They
                come with the full Task, so a refresh keeps the last ones shown
                rather than blanking them. */}
            <TaskLinksSection links={detail?.links} onOpenTask={onOpenTask} />
            <TaskInitiativesSection
              initiatives={detail?.initiatives}
              onNavigate={onNavigate}
              taskTitle={taskTitle}
            />

            {!runsLoaded ? (
              <div
                role="status"
                aria-label="Loading Task workflow runs"
                className="mb-6"
              >
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            ) : runs.length ? (
              <div className="mb-6 flex flex-col gap-3">
                {runs.map((run, index) => (
                  // The run's durable ADDRESS on this page: what
                  // `/tasks/:taskId#workflow-run-:runId` resolves to, and the
                  // element {@link useWorkflowRunAnchor} scrolls to and focuses
                  // once both loads have landed. `tabIndex={-1}` makes it a
                  // programmatic focus target without putting a stop in the tab
                  // order for everyone else.
                  <div
                    key={run.id}
                    id={workflowRunAnchorId(run.id)}
                    tabIndex={-1}
                    className="scroll-mt-4 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <WorkflowRunCard
                      run={run}
                      card={workflowCards[run.id]}
                      accountNames={accountNames}
                      sessions={sessions}
                      onOpenSession={onOpenSession}
                      onPause={onPauseRun}
                      onResume={onResumeRun}
                      onCancel={onCancelRun}
                      onDelete={onDeleteRun}
                      onRetry={onRetryRun}
                      onAnswerCeiling={onAnswerCeiling}
                      onAnswerCommitCheck={onAnswerCommitCheck}
                      onRebaseAndReview={onRebaseAndReviewRun}
                      onMerge={onMergeRun}
                      onCleanUp={onCleanUpRun}
                      // The newest run leads; an older one that has finished
                      // starts as one line under it.
                      defaultCollapsed={
                        index > 0 &&
                        (run.lifecycle === "completed" ||
                          run.lifecycle === "cancelled")
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {/* The description IS the page's body, under the title: no heading
                and no fold. While editing it is part of the editor above. Under
                it, a small action row: Edit (title and description together). */}
            {editing ? null : (
              <section aria-label="Description" className="mb-4">
                {detailError ? (
                  <ErrorNote message={detailError} onRetry={onRetryDetail} />
                ) : null}
                <div className="min-h-16 w-full py-1">
                  {descriptionText.trim() ? (
                    <Markdown
                      text={descriptionText}
                      paObjectReferences={paObjectReferences}
                      onOpenPaObject={onOpenPaObject}
                    />
                  ) : !descriptionLoaded ? (
                    // The summary's preview stands in while the body loads, so
                    // a Task that HAS a description never flashes "none yet".
                    // It is raw source, not rendered Markdown: a URL or other
                    // unbreakable token would run off the pane without
                    // `break-words`. With no preview to show there is nothing
                    // to say yet, so the paragraph is RESERVED rather than
                    // filled with the word "Loading" (R4).
                    item.descriptionPreview ? (
                      <span
                        role={detailLoading ? "status" : undefined}
                        aria-label={
                          detailLoading ? "Loading description" : undefined
                        }
                        className="break-words text-sm text-muted-foreground"
                      >
                        {item.descriptionPreview}
                      </span>
                    ) : (
                      <div
                        role={detailLoading ? "status" : undefined}
                        aria-label={
                          detailLoading ? "Loading description" : undefined
                        }
                        className="flex flex-col gap-2 pt-1"
                      >
                        <Skeleton className="h-3.5 w-full" />
                        <Skeleton className="h-3.5 w-11/12" />
                        <Skeleton className="h-3.5 w-2/3" />
                      </div>
                    )
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No description yet.
                    </span>
                  )}
                </div>
                <ActionRow>
                  {detailRefreshing ? (
                    <RefreshIndicator label="Refreshing description" />
                  ) : null}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    // The body must be loaded to edit it: saving a draft made
                    // from the preview would cut the description short.
                    disabled={!descriptionLoaded}
                    busy={isPending(editMutation ?? idle())}
                    onClick={() => setEditing(true)}
                  >
                    <Pencil />
                    Edit
                  </Button>
                </ActionRow>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The Task's identity IN the page: full title (wrapping, never truncated), the
 * status, and the subtree progress.
 *
 * This is what the header gave up. A title is the longest thing a Task has and the
 * header row cut it off at ~30 characters; here it wraps, and renaming is a real
 * target instead of a hover-only pencil — which on a touch device was an invisible
 * button you had to know about.
 *
 * `onSetStatus` present means this block owns the status control (wide layouts, which
 * have no dock row). Absent, the status is not shown here AT ALL: the dock's action
 * row shows the state in the glyph you press to change it, and a chip above the
 * title would be the third place to read the same word. A done Task still reads as
 * done here — the title is struck through.
 */
function TaskTitleBlock({
  item,
  progress,
  parentTask,
  subtasks,
  onOpenTask,
  onAcceptSuggestion,
  onDismissSuggestion,
  onDismissFromInbox,
  onPlanToday,
  onRestore,
  onOpenSession,
  sessions,
  projectsById,
  onNavigate,
  onSetProject,
  editor,
  onSetStatus,
  statusMutation,
}: {
  item: Task;
  progress?: { done: number; total: number } | undefined;
  parentTask?: Task | undefined;
  subtasks: Task[];
  onOpenTask: (id: string) => void;
  onAcceptSuggestion: () => void;
  onDismissSuggestion: () => void;
  onDismissFromInbox: () => void;
  onPlanToday: () => void;
  onRestore: () => void;
  onOpenSession: (id: string) => void;
  /** The session list, to name the agent session behind a suggestion. */
  sessions: UIState["sessions"];
  projectsById: Map<string, ProjectRecord>;
  onNavigate?: ((path: string) => void) | undefined;
  /** Assign, change or clear the Task's Project from the facts line. */
  onSetProject: (projectId: string | null) => void;
  /** The title and description editor, shown in the title's place while open. */
  editor: ReactNode;
  onSetStatus?: ((status: Task["status"]) => void) | undefined;
  statusMutation?: LoadState<true> | undefined;
}) {
  const isDone = item.status === "done";
  const statusError = errorOf(statusMutation ?? idle());
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const suggestion = pendingStatusSuggestion(item);
  const archived = item.archivedAt !== undefined;
  // An archived Task is out of the Backlog, so out of its Inbox too.
  const inInbox = !archived && belongsInInbox(item);
  const originSession = item.source?.sessionId
    ? sessions.find((session) => session.id === item.source?.sessionId)
    : undefined;
  const suggestionSession = suggestion?.sessionId
    ? sessions.find((session) => session.id === suggestion.sessionId)
    : undefined;
  const statusClaim = answeredStatusClaim(item);
  // The picker offers the active Projects; an archived one still names itself
  // when it is the current value (`ProjectSelector`).
  const activeProjects = useMemo(
    () =>
      [...projectsById.values()].filter(
        (project) => project.status !== "archived",
      ),
    [projectsById],
  );
  const today = todayIso(useUserTimeZone());
  const planned = scheduledLabel(item, today);
  const due = dueLabel(item, today);
  const overdue = Boolean(item.dueDate && item.dueDate < today);
  // The Task's ticket, linked to where it lives.
  const ticket = item.ticket ?? null;
  const ticketDetails = useTicketDetails(ticket);
  const ticketUrl =
    ticketDetails?.url ?? (ticket ? ticketFallbackUrl(ticket) : undefined);
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      {editor ?? (
        <h1
          className={`text-lg font-semibold ${isDone ? "text-muted-foreground line-through" : "text-foreground"}`}
        >
          {item.title}
        </h1>
      )}
      {archived ? (
        // Reached through a link or an address: the Task is out of the Backlog
        // and every list, and Restore is the way back. The page still reads in
        // full — its links, its body — because that is why it was opened.
        <TaskNoticeCard
          tone="info"
          icon={<Archive />}
          title="Archived"
          actions={
            <Button size="xs" onClick={onRestore}>
              <ArchiveRestore />
              Restore to Backlog
            </Button>
          }
        >
          <p>This Task is archived: it is in no list until it is restored.</p>
        </TaskNoticeCard>
      ) : null}
      {suggestion ? (
        // An agent's claim about this Task's status, answered on the Task
        // itself as well as in the Focus view's review bucket: a card with a
        // warning-toned header naming what it is, who said what (the agent
        // leads to its session) with the reason quoted, and the answers in
        // its footer.
        <TaskNoticeCard
          tone="warning"
          icon={<Lightbulb />}
          title="Suggestion"
          actions={
            <>
              <Button variant="ghost" size="xs" onClick={onDismissSuggestion}>
                {suggestion.to === "done" ? "Not done yet" : "Keep it done"}
              </Button>
              <Button
                size="xs"
                busy={isPending(statusMutation ?? idle())}
                onClick={onAcceptSuggestion}
              >
                {suggestion.to === "done" ? <Check /> : <Undo2 />}
                {suggestion.to === "done" ? "Mark done" : "Move to To do"}
              </Button>
            </>
          }
        >
          <p className="flex flex-wrap items-center gap-x-1">
            {suggestionSession ? (
              // A real link to the session: underlined, and a modifier
              // click opens it in a tab.
              <a
                href={sessionPath(suggestionSession.id)}
                className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-3 hover:text-primary"
                onClick={(event) =>
                  followRowLink(event, sessionPath(suggestionSession.id), () =>
                    onOpenSession(suggestionSession.id),
                  )
                }
              >
                <Bot className="size-3.5" aria-hidden />
                {suggestionSession.title.trim() || "An agent session"}
              </a>
            ) : (
              <span>An agent</span>
            )}
            <span>
              {suggestion.to === "done"
                ? "says this is done."
                : "handed this back unfinished."}
            </span>
          </p>
          {suggestion.reason ? (
            <blockquote className="border-l-2 pl-3 text-muted-foreground italic wrap-anywhere">
              {suggestion.reason}
            </blockquote>
          ) : null}
        </TaskNoticeCard>
      ) : null}
      {inInbox ? (
        // Still in the Inbox: it arrived on its own and nobody has decided
        // about it yet. Said here as well as in the Inbox list, with the two
        // answers that list's row gives — plan it, or just let it into the
        // Backlog.
        <TaskNoticeCard
          tone="info"
          icon={<Inbox />}
          title="Inbox"
          actions={
            <>
              <Button variant="ghost" size="xs" onClick={onPlanToday}>
                <CalendarCheck />
                Plan for today
              </Button>
              <Button size="xs" onClick={onDismissFromInbox}>
                <Check />
                Move to Backlog
              </Button>
            </>
          }
        >
          <p className="flex flex-wrap items-center gap-x-1">
            <span>{taskOrigin(item)}</span>
            {originSession ? (
              <>
                <span>·</span>
                <a
                  href={sessionPath(originSession.id)}
                  className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-3 hover:text-primary"
                  onClick={(event) =>
                    followRowLink(event, sessionPath(originSession.id), () =>
                      onOpenSession(originSession.id),
                    )
                  }
                >
                  <Bot className="size-3.5" aria-hidden />
                  {originSession.title.trim() || "Agent session"}
                </a>
              </>
            ) : null}
          </p>
          <p className="text-muted-foreground">
            It arrived on its own and is waiting for a decision.
          </p>
        </TaskNoticeCard>
      ) : null}
      {/* Under the title, as the chat title bar's subtitle: where the Task
          stands, where it belongs, and how far its subtree is — plain muted
          facts, not chips. */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {onSetStatus ? (
          // A menu of the three statuses rather than a click that cycles:
          // which one comes next is not something to have to remember.
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  // Pulled out by its own padding so the glyph lines up with
                  // the title's first letter.
                  className="-ml-2 text-sm font-normal text-muted-foreground hover:text-foreground"
                  busy={isPending(statusMutation ?? idle())}
                  aria-label={`Status: ${TASK_STATUS_LABEL[item.status]}. Change status`}
                />
              }
            >
              <TaskStatusIcon
                status={item.status}
                size={14}
                claimed={Boolean(suggestion)}
              />
              {TASK_STATUS_LABEL[item.status]}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {TASK_STATUSES.map((status) => (
                <DropdownMenuItem
                  key={status}
                  aria-current={status === item.status || undefined}
                  onClick={() => onSetStatus(status)}
                >
                  <TaskStatusIcon status={status} size={14} />
                  <span className={status === item.status ? "font-medium" : ""}>
                    {TASK_STATUS_LABEL[status]}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          // On a phone the dock's action row changes the status; here it is
          // only read.
          <span className="inline-flex items-center gap-1.5">
            <TaskStatusIcon
              status={item.status}
              size={14}
              claimed={Boolean(suggestion)}
            />
            {TASK_STATUS_LABEL[item.status]}
          </span>
        )}
        {/* Read off the live summary rather than the body, so it changes the
            moment a blocker is done, without waiting for the re-read. */}
        {item.openBlockerCount ? (
          <TaskBlockedIndicator
            openBlockers={item.openBlockerCount}
            label
            size={14}
            className="gap-1.5"
          />
        ) : null}
        {/* Always present, a picker either way: a Task with no Project says
            so, and setting one is a click away rather than in the inspector. */}
        <span className="inline-flex min-w-0 items-center gap-0.5">
          <ProjectSelector
            currentId={item.projectId ?? null}
            projects={activeProjects}
            projectsById={projectsById}
            onChange={(projectId) => onSetProject(projectId || null)}
            label={null}
            emptyLabel="No project"
            // `pr-1`: the open-project arrow follows the name closely.
            className="-ml-2 h-auto min-w-0 py-0.5 pr-1 text-sm font-normal text-muted-foreground hover:text-foreground"
          />
          {item.projectId && onNavigate ? (
            <IconButton
              label="Open project"
              size="icon-xs"
              className="size-5 text-muted-foreground hover:text-foreground"
              onClick={() => onNavigate(projectPath(item.projectId!))}
            >
              <ArrowUpRight />
            </IconButton>
          ) : null}
        </span>
        {subtasks.length ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-sm font-normal text-muted-foreground hover:text-foreground"
            aria-expanded={subtasksOpen}
            title={
              progress
                ? `${progress.done} of ${progress.total} done, nested subtasks included`
                : undefined
            }
            onClick={() => setSubtasksOpen((value) => !value)}
          >
            <ChevronRight
              className={`transition-transform ${subtasksOpen ? "rotate-90" : ""}`}
            />
            {subtasks.filter((task) => task.status === "done").length}/
            {subtasks.length} subtasks
          </Button>
        ) : null}
        {/* The planning and ticket the inspector edits, read here too. */}
        {planned ? (
          <span
            className="inline-flex shrink-0 items-center gap-1.5"
            title={`Planned for ${planned.toLowerCase()}`}
          >
            <CalendarCheck size={14} aria-hidden />
            {planned}
          </span>
        ) : null}
        {due ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 ${overdue ? "text-destructive" : ""}`}
            title={`Due ${due.toLowerCase()}`}
          >
            <Flag size={14} aria-hidden />
            {due}
          </span>
        ) : null}
        {item.priority && item.priority !== "normal" ? (
          <span
            className={`shrink-0 ${item.priority === "urgent" ? "text-destructive" : item.priority === "high" ? "text-warning" : ""}`}
          >
            {item.priority} priority
          </span>
        ) : null}
        {ticket ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Ticket size={14} aria-hidden className="shrink-0" />
            {ticketUrl ? (
              <a
                href={ticketUrl}
                target="_blank"
                rel="noreferrer noopener"
                title={
                  ticketDetails?.title
                    ? `${ticket.ref} — ${ticketDetails.title}`
                    : `Open ${ticket.ref}`
                }
                className="truncate font-mono text-xs text-foreground underline underline-offset-3 hover:text-primary"
              >
                {ticket.ref}
              </a>
            ) : (
              <span className="truncate font-mono text-xs">{ticket.ref}</span>
            )}
          </span>
        ) : null}
      </div>
      {statusClaim ? (
        <StatusClaimLine
          claim={statusClaim}
          status={item.status}
          sessions={sessions}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {statusError ? <ErrorNote message={statusError} /> : null}
      {/* Where it sits in the Backlog: the Task it belongs to, and — unfolded
          from the facts line — the ones that belong to it. */}
      {parentTask ? (
        // Wraps rather than overflowing: a parent's title can be as long as
        // this Task's own. The glyphs sit on the first line.
        <div className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
          {/* Each glyph in a box one text line tall, so it centres on the
              first line however far the title wraps. */}
          <span className="flex h-5 shrink-0 items-center">
            <CornerLeftUp className="size-3.5" aria-hidden />
          </span>
          <span className="shrink-0">Part of</span>
          <Button
            variant="link"
            size="xs"
            className="h-auto min-w-0 shrink items-start px-0 py-0 text-left text-sm font-normal whitespace-normal text-foreground"
            onClick={() => onOpenTask(parentTask.id)}
          >
            <span className="flex h-5 shrink-0 items-center">
              <TaskStatusIcon status={parentTask.status} size={14} />
            </span>
            <span className="min-w-0 wrap-anywhere">{parentTask.title}</span>
          </Button>
        </div>
      ) : null}
      {subtasksOpen && subtasks.length ? (
        <div className="ml-1 border-l pl-2">
          <TaskLinkList items={subtasks} onOpen={onOpenTask} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * How the Task got its current status when an agent set it: a muted line under
 * the facts linking the agent's session (named when this tab knows it) and
 * quoting its reason. Provenance, not a question — nothing to answer,
 * and changing the status replaces it.
 */
function StatusClaimLine({
  claim,
  status,
  sessions,
  onOpenSession,
}: {
  claim: NonNullable<Task["statusSuggestion"]>;
  status: Task["status"];
  sessions: UIState["sessions"];
  onOpenSession: (id: string) => void;
}) {
  const sessionId = claim.sessionId;
  const title = sessionId
    ? sessions.find((session) => session.id === sessionId)?.title.trim()
    : undefined;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
      <Bot className="size-3.5 shrink-0" aria-hidden />
      <span>Set {TASK_STATUS_LABEL[status].toLowerCase()} by agent</span>
      {sessionId ? (
        <>
          <span>in</span>
          <a
            href={sessionPath(sessionId)}
            className="font-medium text-foreground underline underline-offset-3 hover:text-primary"
            onClick={(event) =>
              followRowLink(event, sessionPath(sessionId), () =>
                onOpenSession(sessionId),
              )
            }
          >
            {title || "its session"}
          </a>
        </>
      ) : null}
      {claim.reason ? (
        <span className="min-w-0 wrap-anywhere">
          —{" "}
          <q className="italic">
            <Markdown text={claim.reason} inline density="compact" />
          </q>
        </span>
      ) : null}
    </p>
  );
}

/**
 * A notice about the Task that asks for a decision — an agent's suggestion,
 * an Inbox arrival: a 32px tinted header naming it, the explanation, and a
 * 32px footer with the answers.
 */
function TaskNoticeCard({
  tone,
  icon,
  title,
  actions,
  children,
}: {
  tone: "warning" | "info";
  icon: ReactNode;
  title: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppCard
      role="status"
      tone={tone}
      icon={icon}
      label={title}
      actions={actions}
    >
      {children}
    </AppCard>
  );
}
