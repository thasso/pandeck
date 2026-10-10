import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardList,
  Pencil,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";
import { Button } from "./ui/button.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { EditableText } from "./common/EditableText.tsx";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type {
  PullRequestMergeMethod,
  SessionListItem,
  TaskItem,
  WorkflowCeilingRaise,
  WorkflowRunSummary,
} from "@assistant/shared";
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
import { flattenTasks, nextStatus, type Task } from "../lib/backlogTree.ts";
import { BacklogList } from "./BacklogList.tsx";
import { useListScroll } from "../hooks/useListScroll.ts";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";
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
  // `?? []` above cannot say whether the list is cold or genuinely empty, and
  // the detail pane has to: an unfound Task with the list still on its way is
  // loading, not "nothing selected" (R1).
  const tasksLoaded = backlogState.taskList !== null;

  // The Backlog is the one list this page browses, so it remembers where the
  // reader was across opening a Task and coming back.
  const listScrollRef = useListScroll({
    listKey: detailOnly ? null : "page:tasks",
  });

  const cycleStatus = (item: Task) => {
    actions.saveTask(
      {
        id: item.id,
        status: nextStatus(item.status),
      },
      "status",
    );
  };

  const renameTask = (item: Task, title: string) => {
    actions.saveTask({ id: item.id, title, status: item.status }, "rename");
  };

  const saveDescription = (item: Task, description: string) => {
    actions.saveTask(
      {
        id: item.id,
        status: item.status,
        description,
      },
      "description",
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

  const selectedTask = selectedId
    ? (items.find((item) => item.id === selectedId) ?? null)
    : null;
  const selectedRuns = useMemo(
    () =>
      (workflowRuns ?? [])
        .filter((run) => run.taskId === selectedId)
        .sort((left, right) => right.createdAt - left.createdAt),
    [workflowRuns, selectedId],
  );
  const detailOnlyActive = detailOnly;
  const detailUnavailable = dataOf(detailState) === null;

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
    if (!selectedId || !selectedTask || !connected) return;
    const detail = dataOf(detailState);
    const disconnectedFailure =
      detailState.status === "error" &&
      detailState.error.startsWith("Connection lost");
    if (
      detailState.status === "idle" ||
      detailState.status === "refreshing" ||
      disconnectedFailure ||
      (detail && detail.updatedAt < selectedTask.updatedAt)
    )
      actions.requestTaskDetail(selectedId);
  }, [actions, connected, detailState, selectedId, selectedTask]);

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
                  density="comfortable"
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
              back={back}
              mobile={mobile}
              item={selectedTask}
              detailState={detailState}
              progress={progressById.get(selectedTask.id)}
              runs={selectedRuns}
              runsLoaded={workflowRuns !== null}
              workflowCards={workflowCards}
              sessions={sessions}
              onOpenSession={onOpenSession}
              onPauseRun={actions.pauseWorkflowRun}
              onResumeRun={actions.resumeWorkflowRun}
              onCancelRun={actions.cancelWorkflowRun}
              onDeleteRun={actions.deleteWorkflowRun}
              onRetryRun={actions.retryWorkflowRun}
              onAnswerCeiling={actions.answerWorkflowCeiling}
              onRebaseAndReviewRun={actions.rebaseAndReviewWorkflowRun}
              onMergeRun={actions.mergeWorkflowRun}
              onCleanUpRun={actions.cleanUpWorkflowRun}
              onCycle={() => cycleStatus(selectedTask)}
              onRename={(title) => renameTask(selectedTask, title)}
              onSaveDescription={(description) =>
                saveDescription(selectedTask, description)
              }
              statusMutation={
                taskMutations[taskMutationKey(selectedTask.id, "status")]
              }
              renameMutation={
                taskMutations[taskMutationKey(selectedTask.id, "rename")]
              }
              descriptionMutation={
                taskMutations[taskMutationKey(selectedTask.id, "description")]
              }
              onRetryDetail={() => actions.requestTaskDetail(selectedTask.id)}
              paObjectReferences={paObjectReferences}
              onOpenPaObject={onOpenPaObject}
            />
          ) : selectedId && !tasksLoaded ? (
            // A Task IS addressed; the list carrying it simply has not arrived.
            // "Select a task" here would deny the selection the route makes.
            <PaneLoading label="Loading Task…" className="h-full" />
          ) : selectedId ? (
            // No way out is offered: the address named a Task that is not
            // there, and where to go next is the user's call — the shell's
            // navigation is what answers it.
            <div className="flex h-full items-center justify-center px-6">
              <EmptyBox>
                Task-{selectedId} is not available in the Backlog.
              </EmptyBox>
            </div>
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
  back,
  mobile,
  item,
  detailState,
  progress,
  runs,
  runsLoaded,
  workflowCards,
  sessions,
  onOpenSession,
  onPauseRun,
  onResumeRun,
  onCancelRun,
  onDeleteRun,
  onRetryRun,
  onAnswerCeiling,
  onRebaseAndReviewRun,
  onMergeRun,
  onCleanUpRun,
  onCycle,
  onRename,
  onSaveDescription,
  statusMutation,
  renameMutation,
  descriptionMutation,
  onRetryDetail,
  paObjectReferences,
  onOpenPaObject,
}: {
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
  runs: WorkflowRunSummary[];
  runsLoaded: boolean;
  workflowCards: UIState["workflowCards"];
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
  onRebaseAndReviewRun: (id: string) => void;
  onMergeRun: (
    id: string,
    options: { mergeMethod: PullRequestMergeMethod; deleteBranch: boolean },
  ) => void;
  onCleanUpRun: (id: string) => void;
  onCycle: () => void;
  onRename: (title: string) => void;
  onSaveDescription: (description: string) => void;
  statusMutation?: LoadState<true> | undefined;
  renameMutation?: LoadState<true> | undefined;
  descriptionMutation?: LoadState<true> | undefined;
  onRetryDetail: () => void;
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
  const [editingDescription, setEditingDescription] = useState(false);
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
              onRename={onRename}
              renameMutation={renameMutation}
              statusMutation={statusMutation}
              // The status control lives HERE on a wide layout and in the object
              // dock's action row on a phone — the dock is the object's action home
              // there, so this block shows the state and does not offer to change it.
              onCycle={mobile ? undefined : onCycle}
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
                {runs.map((run) => (
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
                      sessions={sessions}
                      onOpenSession={onOpenSession}
                      onPause={onPauseRun}
                      onResume={onResumeRun}
                      onCancel={onCancelRun}
                      onDelete={onDeleteRun}
                      onRetry={onRetryRun}
                      onAnswerCeiling={onAnswerCeiling}
                      onRebaseAndReview={onRebaseAndReviewRun}
                      onMerge={onMergeRun}
                      onCleanUp={onCleanUpRun}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <TaskCollapsibleSection
              title="Description"
              storageKey={`wf.collapse.${item.id}.description`}
              trailing={
                <div className="flex items-center gap-2">
                  {detailRefreshing ? (
                    <RefreshIndicator label="Refreshing description" />
                  ) : null}
                  {descriptionLoaded ? (
                    <IconButton
                      label="Edit description"
                      onClick={() => setEditingDescription(true)}
                      busy={isPending(descriptionMutation ?? idle())}
                    >
                      <Pencil />
                    </IconButton>
                  ) : null}
                </div>
              }
            >
              {detailError ? (
                <ErrorNote message={detailError} onRetry={onRetryDetail} />
              ) : null}
              <EditableText
                value={descriptionText}
                onSubmit={onSaveDescription}
                submitState={descriptionMutation}
                editing={editingDescription}
                onEditingChange={setEditingDescription}
                multiline
                allowEmpty
                label="Task description"
                placeholder="Add a description…"
                className="min-h-32 resize-y"
              >
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
                      No description yet. Use the edit button to add one.
                    </span>
                  )}
                </div>
              </EditableText>
            </TaskCollapsibleSection>
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
 * `onCycle` present means this block owns the status control (wide layouts, which
 * have no dock row). Absent, the status is not shown here AT ALL: the dock's action
 * row shows the state in the glyph you press to change it, and a chip above the
 * title would be the third place to read the same word. A done Task still reads as
 * done here — the title is struck through.
 */
function TaskTitleBlock({
  item,
  progress,
  onRename,
  onCycle,
  renameMutation,
  statusMutation,
}: {
  item: Task;
  progress?: { done: number; total: number } | undefined;
  onRename: (title: string) => void;
  onCycle?: (() => void) | undefined;
  renameMutation?: LoadState<true> | undefined;
  statusMutation?: LoadState<true> | undefined;
}) {
  const isDone = item.status === "done";
  const meta = onCycle || progress;
  const [editing, setEditing] = useState(false);
  return (
    <div className="mb-6 space-y-2">
      {meta ? (
        <div className="flex items-center gap-2">
          {onCycle ? (
            <Button
              variant="outline"
              busy={isPending(statusMutation ?? idle())}
              onClick={onCycle}
              title={`Mark as ${TASK_STATUS_LABEL[nextStatus(item.status)].toLowerCase()}`}
              aria-label={`Status: ${TASK_STATUS_LABEL[item.status]}. Mark as ${TASK_STATUS_LABEL[nextStatus(item.status)].toLowerCase()}`}
            >
              <TaskStatusIcon status={item.status} size={15} />
              {TASK_STATUS_LABEL[item.status]}
            </Button>
          ) : null}
          {progress ? (
            <span className="shrink-0 rounded-full bg-card px-2 py-0.5 text-sm text-muted-foreground">
              {progress.done}/{progress.total} subtasks
            </span>
          ) : null}
        </div>
      ) : null}
      {errorOf(statusMutation ?? idle()) ? (
        <ErrorNote message={errorOf(statusMutation ?? idle())!} />
      ) : null}
      <EditableText
        value={item.title}
        onSubmit={onRename}
        submitState={renameMutation}
        editing={editing}
        onEditingChange={setEditing}
        label="Task title"
      >
        <div className="flex items-start gap-2">
          <h1
            className={`min-w-0 flex-1 text-lg font-semibold ${isDone ? "text-muted-foreground line-through" : "text-foreground"}`}
          >
            {item.title}
          </h1>
          <IconButton
            label="Rename task"
            className="mt-1"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </IconButton>
        </div>
      </EditableText>
    </div>
  );
}

function TaskCollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  trailing,
  children,
}: {
  title: string;
  storageKey: string;
  defaultOpen?: boolean;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try {
      const value = localStorage.getItem(storageKey);
      return value === null ? defaultOpen : value === "1";
    } catch {
      return defaultOpen;
    }
  });
  const changeOpen = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(storageKey, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  return (
    <section className="mb-4">
      <Collapsible open={open} onOpenChange={changeOpen}>
        <div className="mb-1 flex items-center justify-between gap-2">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="min-w-0 justify-start uppercase tracking-wide text-muted-foreground"
              />
            }
          >
            <ChevronRight className={`shrink-0 ${open ? "rotate-90" : ""}`} />
            <span className="truncate">{title}</span>
          </CollapsibleTrigger>
          {trailing ? <div className="shrink-0">{trailing}</div> : null}
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}
