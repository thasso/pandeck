import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Archive, Check, ChevronRight, Folder } from "lucide-react";
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isShelvedSession, MAX_INBOX_POSITIONS } from "@assistant/shared";
import type {
  InboxPositionEntry,
  InitiativeSummary,
  ProjectRecord,
  SessionListItem,
  TaskSummary,
  WorkflowRunCard,
  WorkflowRunSummary,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { ActiveSessionCard } from "./ActiveSessionCard.tsx";
import { ClusterChildRow } from "./ClusterChildRow.tsx";
import { WorkflowRunInboxCard } from "./WorkflowRunInboxCard.tsx";
import {
  InitiativeInboxCard,
  InitiativeMoreRow,
} from "./InitiativeInboxCard.tsx";
import { InboxShelfRow } from "./InboxShelfRow.tsx";
import { SessionInboxBar } from "./SessionInboxBar.tsx";
import {
  attentionFilterCount,
  attentionHistoryMatches,
  attentionProjectsBySession,
  DEFAULT_ATTENTION_FILTERS,
  filterAttentionInbox,
  groupAttentionByProject,
  type AttentionFilters,
} from "../lib/attentionFilters.ts";
import type { SessionInboxBarStore } from "../lib/sessionInboxBarStore.ts";
import { EXIT_STAGE_MS, ExitStage } from "./common/ExitStage.tsx";
import { usePrefersReducedMotion } from "./shell/usePrefersReducedMotion.ts";
import { useShortcuts, type ShortcutGroup } from "./common/shortcuts.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
} from "./common/load.tsx";
import type { InitiativeSettleError } from "../hooks/useAssistant.ts";
import { Button } from "@/components/ui/button";
import { ListGroupSection } from "./ListGroupSection.tsx";
import { ListExpansionRow } from "./common/ListExpansionRow.tsx";
import { SwipeRow, type SwipeAction } from "./common/SwipeRow.tsx";
import {
  MOUSE_DRAG_DISTANCE_PX,
  TOUCH_LONG_PRESS_DELAY_MS,
  TOUCH_LONG_PRESS_TOLERANCE_PX,
} from "./common/dragActivation.ts";
import { useNow } from "../hooks/useNow.ts";
import { dismissToastKey, showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import {
  buildSessionInbox,
  classifySessionStatus,
  inboxItemId,
  planCardReorder,
  planInboxDrop,
  sessionCardKey,
  sessionRelationsKey,
  SETTLED_PAGE_SIZE,
  SETTLED_PAGE_STEP,
  workflowRunItemKey,
  type SessionCardRelations,
  type SessionInboxCard,
  type SessionInboxItem,
  type WorkflowRunInboxItem,
} from "../lib/sessionInbox.ts";
import { globalBackgroundActivity } from "../lib/backgroundWork.ts";
import {
  buildInitiativeInbox,
  initiativeItemId,
  initiativeLayoutKey,
  mergeNeedsYou,
  needsYouEntryId,
  type InitiativeInboxItem,
  type NeedsYouEntry,
} from "../lib/initiativeInbox.ts";
import { projectColor, projectDisplayKey } from "../lib/projectDisplay.ts";

// Every row in this browser — card, settled row, archived row — answers the
// same keys, so the overlay states them plainly. Only `s` is narrower: settling
// belongs to the working set and to the Settled shelf that undoes it.
const SESSION_SHORTCUTS: ShortcutGroup = {
  title: "Sessions",
  shortcuts: [
    { keys: ["↑", "↓"], label: "Move between inbox rows" },
    { keys: ["enter"], label: "Open focused session" },
    { keys: ["s"], label: "Settle / bring back" },
    { keys: ["e"], label: "Archive / restore session" },
    { keys: ["#", "delete"], label: "Delete session" },
  ],
};

/** Running durations tick every second; ages only need a minute. */
const RUNNING_TICK_MS = 1_000;
const IDLE_TICK_MS = 60_000;

/** One key for both swipe receipts: a second swipe replaces the first. */
const SESSION_SWIPE_TOAST_KEY = "session-inbox-swipe";

/**
 * The longest a committed swipe waits for `SwipeRow` to report its exit before
 * the command is sent anyway. The exit normally gets there (~340 ms) and that is
 * what fires; this is the backstop for the endings that never do, and on this
 * list they are ordinary rather than exotic — `needsYou` and `active` are
 * separate parents, so a session that changes tier while its card is leaving
 * unmounts the very component that was going to report. Sits comfortably past
 * the exit, which it must not cut short, and well before the swipe stops feeling
 * like something the user just did.
 */
const SWIPE_COMMIT_MAX_MS = 1000;

/** The same fallback the card itself shows, so the receipt names what you saw. */
function sessionTitle(session: SessionListItem): string {
  return session.title.trim() || "Untitled session";
}

/**
 * The settle exit: the card slides out to the left (200ms), and only then does
 * the list close the gap behind it (150ms, delayed by the slide) — two stages,
 * so what you see is the card leaving rather than the whole list jumping. This
 * is when the settle command is sent, so it must stay the sum of the two
 * durations written as literal classes on the wrapper (Tailwind only sees class
 * names it can read in the source, so those cannot be interpolated from here).
 */
const SETTLE_EXIT_MS = EXIT_STAGE_MS;

/** How long a card takes to travel to its new place when the order changes. */
const REORDER_MS = 220;

/** One shared empty relations object, so an unjoined card keeps its memo. */
const NO_RELATIONS: SessionCardRelations = {};

interface Props {
  /**
   * Where the counts bar's facts go when the HOST draws the bar, above its
   * scroll container, so it stays put without being a sticky row the scrollbar
   * runs through (`Sidebar.tsx`). Absent, the bar is the list's first row.
   */
  barStore?: SessionInboxBarStore | undefined;
  filters?: AttentionFilters;
  filterControl?: ReactNode;
  onClearFilters?: (() => void) | undefined;
  sessions: SessionListItem[];
  archivedSessionCount: number;
  archivedSessionsLoaded: boolean;
  currentId: string | undefined;
  /** The open session once the app-level read dwell has elapsed. */
  readCurrentId: string | undefined;
  /** Project registry rows, loaded centrally by the sidebar for the joins. */
  projects: ProjectRecord[];
  /** Worktree records; null until first fetched. */
  worktrees: WorktreeRecord[] | null;
  /** Backlog Tasks, for resolving the ONE Task a session belongs to. */
  tasks: TaskSummary[];
  /**
   * Every Workflow Run the browser holds, or null before the first snapshot.
   * Null and empty shape the same inbox — no run items, nothing folded — which
   * is what makes an unsubscribed or still-loading surface safe.
   */
  workflowRuns: WorkflowRunSummary[] | null;
  /** The recipe projections by run id, exactly as the server broadcasts them. */
  workflowCards: Record<string, WorkflowRunCard>;
  /** Live git status per worktree id — reused, never requested per card. */
  worktreeStatuses: Record<string, WorktreeGitStatus>;
  /** Appearance preference: animate a settled card out before the list closes. */
  animateListChanges: boolean;
  /**
   * The host's row density (`lib/rowDensity.ts`), passed to every card and
   * row: `comfortable` when this browser is a phone SCREEN, `tight` on the
   * rail. The same host decision the Backlog toolbar takes.
   */
  density: RowDensity;
  onSelect: (id: string) => void;
  onSettle: (id: string, settled: boolean) => void;
  /**
   * Dismiss a bubbled peer's failure without settling it. No exit plays: the
   * card it is shown on stays, and so does the peer.
   */
  onDismissFailure: (
    id: string,
    errorAt: number | undefined,
    outcomeRevision: number,
  ) => void;
  onArchive: (id: string, archived: boolean) => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string) => void;
  onLoadArchivedSessions: () => void;
  /** Open the background-work registry from the global running-work line. */
  onOpenBackgroundTasks: () => void;
  onOpenProject: (id: string) => void;
  onOpenTask: (id: string) => void;
  /** Open one Workflow Run on its Task, anchored at that run's own card. */
  onOpenWorkflowRun: (taskId: string, runId: string) => void;
  /**
   * Settle one Workflow Run: acknowledge its latest event — through the
   * revision the clicked item showed — and put down the role sessions it owns.
   * The run is the attention owner, so this is the one verb the run item
   * carries; every other control stays on its Task.
   */
  onSettleWorkflowRun: (runId: string, throughRevision: number) => void;
  /**
   * Live Initiative summaries (the `initiatives` topic). Active ones are items
   * of their own, and paused or done ones while their outcome is unsettled.
   */
  initiatives: readonly InitiativeSummary[];
  /** An Initiative snapshot answered the current subscription. */
  initiativesFresh: boolean;
  /** A new Initiative snapshot is out over the list an earlier one answered. */
  initiativesRefreshing: boolean;
  /** The Initiative list could not be read; stated above the items it holds. */
  initiativeListError: string | null;
  /**
   * A Settle's failure, by Initiative id, said under that Initiative's card
   * (`UIState.initiativeSettleErrors`).
   */
  initiativeSettleErrors?: Readonly<Record<string, InitiativeSettleError>>;
  /** Ask for the Initiative list again; stable. */
  onRetryInitiatives: () => void;
  /** Open one Initiative's page, where its map is. */
  onOpenInitiative: (initiativeId: string) => void;
  /**
   * Settle a paused or done Initiative through the revision its clicked card
   * rendered: the one Initiative write the UI makes.
   */
  onSettleInitiative: (initiativeId: string, throughRevision: number) => void;
  /**
   * Place working-set items where the user dragged them. Absent, the list
   * does not drag. Only the working set below **Needs you** drags: that block
   * empties as it is answered, and the shelves are history.
   */
  onSetInboxPositions?: ((positions: InboxPositionEntry[]) => void) | undefined;
  onOpenWorktree: (id: string) => void;
}

/**
 * @component SessionInbox
 * @purpose The Sessions section's object browser: a working-set inbox of rich
 * cards for every unsettled session, a compact Settled shelf, and the existing
 * lazily-loaded Archived group behind it.
 * @useWhen The sidebar's Sessions section is selected.
 * @avoidWhen Listing the sessions that hang off another object; the Worktrees
 * and Projects browsers keep their compact `SessionRow` trees.
 * @intent Answers "what agent work still needs attention?", so the default
 * surface is a deliberately small set ordered by attention rather than a
 * complete history. Both shelves under it — Settled and Archived — render the
 * SAME compact row, because they are the same kind of thing: work you have put
 * down. Fork lineage is card metadata here; the trees stay in the relation
 * browsers. This component owns search, the shelf's paging, the ONE
 * shared ticker behind every elapsed label, and keyboard traversal.
 * @related ActiveSessionCard, InboxShelfRow, sessionInbox (lib), Sidebar
 */
export function SessionInbox({
  barStore,
  filters = DEFAULT_ATTENTION_FILTERS,
  filterControl,
  onClearFilters,
  sessions,
  archivedSessionCount,
  archivedSessionsLoaded,
  currentId,
  readCurrentId,
  projects,
  worktrees,
  tasks,
  workflowRuns,
  workflowCards,
  worktreeStatuses,
  animateListChanges,
  density,
  onSelect,
  onSettle,
  onDismissFailure,
  onArchive,
  onDeleteSession,
  onRenameSession,
  onLoadArchivedSessions,
  onOpenBackgroundTasks,
  onOpenProject,
  onOpenTask,
  onOpenWorkflowRun,
  onSettleWorkflowRun,
  initiatives,
  initiativesFresh,
  initiativesRefreshing,
  initiativeListError,
  initiativeSettleErrors,
  onRetryInitiatives,
  onOpenInitiative,
  onSettleInitiative,
  onSetInboxPositions,
  onOpenWorktree,
}: Props) {
  useShortcuts(SESSION_SHORTCUTS);

  const [settledOpen, setSettledOpen] = useState(false);
  const [settledLimit, setSettledLimit] = useState(SETTLED_PAGE_SIZE);
  const [showArchived, setShowArchived] = useState(false);
  // Which clusters are open, by coordinator id. Browser state rather than card
  // state: the child rows are laid out, focused and swiped by this list, and a
  // card that unmounts on a re-tier must not take the disclosure with it.
  const [openClusters, setOpenClusters] = useState<string[]>([]);
  // Which open clusters also list their SETTLED peers, by coordinator id. Off
  // by default: the fold is about what is going on now, and its history is a
  // request.
  const [settledHistory, setSettledHistory] = useState<string[]>([]);
  const [expandedInitiativeSessions, setExpandedInitiativeSessions] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Cards on their way out: they stay in the list, playing the exit, until the
  // settle command is actually sent — the row is the animation's subject, so it
  // cannot be removed by the list update first.
  const [settling, setSettling] = useState<string[]>([]);
  const settleTimers = useRef(new Map<string, number>());
  // An item of the working set is being dragged to a new place.
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: MOUSE_DRAG_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_LONG_PRESS_DELAY_MS,
        tolerance: TOUCH_LONG_PRESS_TOLERANCE_PX,
      },
    }),
  );
  const reducedMotion = usePrefersReducedMotion();
  const animateSettle = animateListChanges && !reducedMotion;

  useEffect(() => {
    const timers = settleTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Settling is the one action with an exit: the command is sent when the item
  // has finished leaving, so the animation is never cut short by the list
  // update it causes. With the preference off it is sent immediately. One exit
  // for both kinds of item, keyed by the item's inbox id.
  const settleWithExit = useCallback(
    (id: string, send: () => void) => {
      if (!animateSettle) {
        send();
        return;
      }
      if (settleTimers.current.has(id)) return;
      setSettling((ids) => (ids.includes(id) ? ids : [...ids, id]));
      settleTimers.current.set(
        id,
        window.setTimeout(() => {
          settleTimers.current.delete(id);
          setSettling((ids) => ids.filter((value) => value !== id));
          send();
        }, SETTLE_EXIT_MS),
      );
    },
    [animateSettle],
  );
  const settleCard = useCallback(
    (id: string) => settleWithExit(id, () => onSettle(id, true)),
    [settleWithExit, onSettle],
  );
  // The revision travels from the click, not from the list at send time: the
  // exit runs for SETTLE_EXIT_MS, and a run whose outcome moved in that window
  // must stay awake rather than be acknowledged by a click that never saw it.
  const settleRun = useCallback(
    (runId: string, throughRevision: number) =>
      settleWithExit(`run:${runId}`, () =>
        onSettleWorkflowRun(runId, throughRevision),
      ),
    [settleWithExit, onSettleWorkflowRun],
  );
  // The same capture for an Initiative: the revision its card rendered. Its
  // send also outlives this list, as a swipe's does (`swipeCommit`): leaving
  // the Sessions section mid-exit unmounts the inbox, and the timer that would
  // have sent the acknowledgement dies with it. Whichever ends first — the
  // exit or the inbox — sends it, and the other finds nothing left to send.
  const initiativeSends = useRef(new Map<string, () => void>());
  const settleInitiativeItem = useCallback(
    (initiativeId: string, throughRevision: number) => {
      const id = initiativeItemId(initiativeId);
      if (initiativeSends.current.has(id)) return;
      const send = () => {
        if (!initiativeSends.current.delete(id)) return;
        onSettleInitiative(initiativeId, throughRevision);
      };
      initiativeSends.current.set(id, send);
      settleWithExit(id, send);
    },
    [settleWithExit, onSettleInitiative],
  );
  useEffect(() => {
    const pending = initiativeSends.current;
    return () => {
      for (const send of [...pending.values()]) send();
    };
  }, []);

  /**
   * The command a swiped card is waiting to send, by session id.
   *
   * A swipe owns its own exit (`SwipeRow`), so it does NOT go through
   * `settleCard`: that one plays a leftward CSS exit, and a card that flew off
   * the side the finger did not pull would read as a different act. What the two
   * share is the ORDER — the row leaves first and the command is sent when it
   * has finished, so the list update that removes the card can never cut the
   * animation short. Until then the card is still in `sessions`, which is what
   * keeps it mounted for `SwipeRow` to animate.
   *
   * The map is owned by the LIST rather than by the row, because the row cannot
   * be trusted to still be there: `needsYou` and `active` are separate parents,
   * so a live update that retiers a session mid-exit unmounts the `SwipeRow`
   * playing it and `onExited` never comes. Every commit therefore also arms a
   * backstop, and whichever arrives first wins — the gesture was made, and a
   * settle silently dropped because the agent happened to answer during the
   * animation is the worst ending this can have.
   */
  const swipeCommit = useRef(new Map<string, () => void>());
  const swipeBackstops = useRef(new Map<string, number>());
  const runSwipeExit = useCallback((id: string) => {
    const send = swipeCommit.current.get(id);
    const backstop = swipeBackstops.current.get(id);
    if (backstop !== undefined) {
      clearTimeout(backstop);
      swipeBackstops.current.delete(id);
    }
    if (!send) return;
    swipeCommit.current.delete(id);
    send();
  }, []);

  const armSwipeCommit = useCallback(
    (id: string, send: () => void) => {
      swipeCommit.current.set(id, send);
      const previous = swipeBackstops.current.get(id);
      if (previous !== undefined) clearTimeout(previous);
      swipeBackstops.current.set(
        id,
        window.setTimeout(() => runSwipeExit(id), SWIPE_COMMIT_MAX_MS),
      );
    },
    [runSwipeExit],
  );

  // A pending command belongs to the gesture, not to this screen: leaving the
  // Sessions section mid-exit must still send it. Sending on unmount is the
  // last honest moment — the alternative is a swipe that did nothing.
  useEffect(() => {
    const pending = swipeCommit.current;
    const timers = swipeBackstops.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      const sends = [...pending.values()];
      pending.clear();
      for (const send of sends) send();
    };
  }, []);

  /**
   * Both swipe actions are REVERSIBLE, and the receipt is what makes that
   * reachable rather than merely true: a thumb can settle or archive the wrong
   * card, and both take it out of the working set — archive all the way into a
   * collapsed group, which on a phone is not somewhere you find your way back to
   * by accident. The keyboard paths (`s`, `e`) stay quiet, since a keypress is
   * aimed in a way a gesture over a scrolling list is not.
   */
  const receipt = useCallback((message: string, undo: () => void) => {
    showToast(message, {
      key: SESSION_SWIPE_TOAST_KEY,
      tone: "success",
      durationMs: TOAST_DWELL_MS,
      action: {
        label: "Undo",
        onClick: () => {
          undo();
          dismissToastKey(SESSION_SWIPE_TOAST_KEY);
        },
      },
    });
  }, []);

  /**
   * Settle is offered only where it would SUCCEED. `card.settleBlocked` is the
   * same predicate the `s` key and the gutter button disable themselves on, and
   * the same one the server refuses the command with — so a swipe that ignored
   * it would slide a running session away and have it roll back underneath the
   * receipt. A gesture cannot explain a refusal, so the side simply is not
   * there, and the card keeps its archive swipe alone.
   */
  const cardSwipe = useCallback(
    (card: SessionInboxCard): { left: SwipeAction; right?: SwipeAction } => {
      const { session } = card;
      return {
        ...(card.settleBlocked
          ? {}
          : {
              right: {
                label: "Settle",
                icon: <Check size={14} />,
                run: () => {
                  armSwipeCommit(session.id, () => {
                    onSettle(session.id, true);
                    receipt(`Settled “${sessionTitle(session)}”.`, () =>
                      onSettle(session.id, false),
                    );
                  });
                  return true;
                },
              },
            }),
        left: {
          label: "Archive",
          icon: <Archive size={14} />,
          run: () => {
            armSwipeCommit(session.id, () => {
              onArchive(session.id, true);
              receipt(`Archived “${sessionTitle(session)}”.`, () =>
                onArchive(session.id, false),
              );
            });
            return true;
          },
        },
      };
    },
    [onSettle, onArchive, receipt, armSwipeCommit],
  );

  // A Workflow Run has no title of its own, so the Task it works on is what it
  // is called here and what it is found by. Resolved once for the whole list,
  // like every other join this browser makes.
  const taskTitles = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.title])),
    [tasks],
  );
  const inbox = useMemo(
    () =>
      buildSessionInbox(sessions, {
        ...(currentId !== undefined ? { currentId } : {}),
        ...(readCurrentId !== undefined ? { readCurrentId } : {}),
        // All loaded history is filtered before its visible page is selected.
        settledLimit: Number.MAX_SAFE_INTEGER,
        ...(workflowRuns ? { workflowRuns } : {}),
        workflowCards,
        taskTitles,
      }),
    [
      sessions,
      currentId,
      readCurrentId,
      workflowRuns,
      workflowCards,
      taskTitles,
    ],
  );
  const filterProjects = useMemo(
    () => attentionProjectsBySession(sessions, worktrees),
    [sessions, worktrees],
  );
  const projectOrder = useMemo(
    () => projects.map((project) => project.id),
    [projects],
  );
  const projectForItem = useCallback(
    (item: SessionInboxItem): string | null =>
      item.kind === "run"
        ? item.run.projectId || null
        : (filterProjects.get(item.card.session.id) ?? null),
    [filterProjects],
  );
  const filtersActive = attentionFilterCount(filters) > 0;
  const view = useMemo(
    () =>
      filterAttentionInbox(
        inbox,
        filters,
        filterProjects,
        settledLimit,
        currentId,
        new Set([...settling, ...swipeCommit.current.keys()]),
      ),
    [inbox, filters, filterProjects, settledLimit, currentId, settling],
  );
  useEffect(() => setSettledLimit(SETTLED_PAGE_SIZE), [filters]);

  // Initiatives are items of their own, read off their summaries alone: an
  // active one in its block above the working set, an unsettled paused or done
  // one in Needs you, ordered and counted with everything else there. Their
  // sessions are LISTED under them and keep their own cards, so nothing here
  // takes a session out of `view`.
  const initiativeInbox = useMemo(
    () => buildInitiativeInbox(initiatives, sessions, readCurrentId),
    [initiatives, sessions, readCurrentId],
  );
  const initiativeItems = useMemo(
    () => [...initiativeInbox.outcomes, ...initiativeInbox.active],
    [initiativeInbox],
  );
  const needsYouEntries = useMemo(
    () => mergeNeedsYou(view.needsYou, initiativeInbox.outcomes),
    [view.needsYou, initiativeInbox],
  );

  // Which peers a cluster card is showing under it. The disclosure is the
  // user's: open, and the cluster lists every peer. The card is told that state
  // and nothing else, so its label always describes what the click will do.
  const expandedClusters = useMemo(() => new Set(openClusters), [openClusters]);
  // A Workflow Run's own sessions are listed on exactly the same terms, so one
  // function answers for both kinds of item.
  const childRows = useCallback(
    (item: SessionInboxItem): SessionInboxCard[] => {
      if (!expandedClusters.has(inboxItemId(item))) return [];
      if (item.kind === "run") return item.roles;
      const cluster = item.card.cluster;
      if (!cluster) return [];
      if (!settledHistory.includes(item.card.session.id)) return cluster.children;
      const liveIds = new Set(cluster.children.map((child) => child.session.id));
      return [
        ...cluster.children,
        ...cluster.childrenWithSettled.filter((child) => !liveIds.has(child.session.id)),
      ];
    },
    [expandedClusters, settledHistory],
  );

  // ONE ticker for every visible elapsed label, not one interval per card —
  // including the rows an open cluster or run contributes, which carry their
  // own. A run item is deliberately not a reason to tick every second: it shows
  // a minute-granularity age and no elapsed label, so only the SESSIONS under it
  // can ask for the faster clock.
  const initiativeRows = (item: InitiativeInboxItem): SessionInboxCard[] =>
    !expandedClusters.has(initiativeItemId(item.initiative.id))
      ? []
      : expandedInitiativeSessions.includes(item.initiative.id)
        ? [...item.sessions, ...(item.additionalSessions ?? [])]
        : item.sessions;
  const anyRunning =
    [...view.needsYou, ...view.active].some(
      (item) =>
        (item.kind === "session" && item.card.status === "running") ||
        childRows(item).some((child) => child.status === "running"),
    ) ||
    initiativeItems.some((item) =>
      initiativeRows(item).some((child) => child.status === "running"),
    );
  const now = useNow(anyRunning ? RUNNING_TICK_MS : IDLE_TICK_MS);

  // Which Task a session belongs to, when exactly ONE can be identified. A
  // session commonly carries several loose Task references (context attaches,
  // mentions); those are ambiguous, so the card claims a Task only when the
  // answer is unique.
  const soleTaskBySession = useMemo(() => {
    const found = new Map<string, TaskSummary | null>();
    for (const task of tasks) {
      for (const ref of task.sessionRefs ?? []) {
        // `null` marks "more than one Task claims this session".
        found.set(ref.sessionId, found.has(ref.sessionId) ? null : task);
      }
    }
    return found;
  }, [tasks]);

  // A run card shows its Project the way a session card does.
  const runProjectById = useMemo(
    () =>
      new Map(
        projects.map((project) => [
          project.id,
          {
            key: projectDisplayKey(project),
            name: project.name,
            color: projectColor(project).dot,
          },
        ]),
      ),
    [projects],
  );

  // Central joins: ids are resolved to display metadata once for the whole list.
  const relationsById = useMemo(() => {
    const projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );
    const worktreesById = new Map(
      (worktrees ?? []).map((worktree) => [worktree.id, worktree]),
    );
    const titlesById = new Map(
      sessions.map((session) => [session.id, session.title]),
    );
    const map = new Map<string, SessionCardRelations>();
    for (const session of sessions) {
      const worktree = session.worktreeId
        ? worktreesById.get(session.worktreeId)
        : undefined;
      const status = session.worktreeId
        ? worktreeStatuses[session.worktreeId]
        : undefined;
      const forkedFromTitle = session.forkOrigin
        ? titlesById.get(session.forkOrigin.parentSessionId ?? "")
        : undefined;
      // A session started from a Task + Worktree often has no standalone
      // `in_project` edge, so fall back to the worktree's own project: that join
      // is unambiguous, and without it those cards drop their Project entirely.
      const project = projectsById.get(
        session.projectId ?? worktree?.projectId ?? "",
      );
      const soleTask = soleTaskBySession.get(session.id) ?? undefined;
      const task = soleTask
        ? { id: soleTask.id, title: soleTask.title }
        : undefined;
      const worktreeBranchValue = status?.branch ?? worktree?.branch;
      map.set(session.id, {
        // The card shows the KEY with the Project's own color, so the full name
        // only travels as the tooltip.
        ...(project
          ? {
              projectId: project.id,
              projectKey: projectDisplayKey(project),
              projectName: project.name,
              projectColor: projectColor(project).dot,
            }
          : {}),
        ...((status?.branch ?? worktree?.branch)
          ? {
              ...(worktreeBranchValue !== undefined
                ? { worktreeBranch: worktreeBranchValue }
                : {}),
            }
          : {}),
        ...(task ? { taskId: task.id, taskTitle: task.title } : {}),
        ...(forkedFromTitle ? { forkedFromTitle } : {}),
        ...(status
          ? {
              worktreeAdditions: status.additions,
              worktreeDeletions: status.deletions,
              worktreeAhead: status.ahead,
            }
          : {}),
      });
    }
    return map;
  }, [sessions, projects, worktrees, worktreeStatuses, soleTaskBySession]);

  // Everything the cards render, in the order they render it. A commit that
  // leaves this unchanged repainted no card, so no card can have MOVED — which
  // is what lets the reorder pass below stay off the layout path on the ~5
  // commits a second this browser takes while agents run, without its baseline
  // going stale (nothing moved between the two measurements it does compare).
  //
  // Joined on the same NUL the keys themselves use: they fold in free text, and
  // a separator a title could contain would let two different lists agree here.
  // The consequence is milder than a frozen card — a pass that should have run
  // is skipped — but it is the same silent kind.
  const [projectDisclosureVersion, setProjectDisclosureVersion] = useState(0);
  const onProjectDisclosure = useCallback(
    () => setProjectDisclosureVersion((version) => version + 1),
    [],
  );
  const cardLayoutKey = useMemo(
    () =>
      [
        // The density is part of every card's HEIGHT: a sidebar that turns
        // from rail to phone screen while mounted repaints every row, and a
        // digest that ignored it would leave the baseline at the old geometry
        // for the next keyed change to animate from.
        density,
        ...initiativeItems.map((item) =>
          initiativeLayoutKey(
            item,
            expandedClusters.has(initiativeItemId(item.initiative.id)),
            now,
            expandedInitiativeSessions.includes(item.initiative.id),
          ),
        ),
        filters.byProject ? JSON.stringify(projectOrder) : "",
        projectDisclosureVersion,
        ...[...view.needsYou, ...view.active].map((item) =>
          [
            filters.byProject ? projectForItem(item) : "",
            item.kind === "run"
              ? workflowRunItemKey(item, now)
              : sessionCardKey(item.card, now),
            item.kind === "run"
              ? ""
              : sessionRelationsKey(
                  relationsById.get(item.card.session.id) ?? NO_RELATIONS,
                ),
            // An open cluster's or run's rows are part of the item's height, so
            // opening one — or a session inside it changing what it says — is a
            // commit the reorder pass has to see.
            ...childRows(item).map((child) => sessionCardKey(child, now)),
          ].join("\u0000"),
        ),
      ].join("\u0000"),
    [
      density,
      view,
      now,
      relationsById,
      childRows,
      initiativeItems,
      expandedClusters,
      expandedInitiativeSessions,
      filters.byProject,
      projectOrder,
      projectForItem,
      projectDisclosureVersion,
    ],
  );

  // A card MOVES when its state changes — read, finished, started running — and
  // an instant jump is read as the list having been shuffled by something else.
  // So the commit that moved it measures the cards and animates any that
  // changed place from where they were (FLIP): one transform per moved card, no
  // layout thrash on the ones that stayed. Skipped entirely while a settle exit
  // is playing — that animation already moves the rows below it, and animating
  // both would fight — and while an item is dragged: the drag moves the cards
  // itself, and the drop's commit must not replay the move from where the
  // dragged card started.
  useCardReorder(
    containerRef,
    animateSettle && settling.length === 0 && !dragging,
    cardLayoutKey,
  );

  const backgroundActive = useMemo(
    () => globalBackgroundActivity(sessions),
    [sessions],
  );

  // Every unarchived session running a TURN, folded peers and workflow role
  // sessions included: the bar states the global truth rather than counting
  // top-level cards, and a turn running inside a fold is still a turn running.
  // Classified, not `isStreaming`, so a session that is streaming AND waiting on
  // an approval is counted once, by the chip that says it needs you.
  const workingCount = useMemo(
    () =>
      sessions.filter(
        (session) =>
          !session.archived && classifySessionStatus(session) === "running",
      ).length,
    [sessions],
  );

  // Counts stay global. Jumping to waiting work clears filters first so a
  // filtered-out urgent item is still reachable from the count that names it.
  const focusNeedsYou = useCallback(() => {
    const focus = () => {
      const section = containerRef.current?.querySelector<HTMLElement>(
        "[data-inbox-needs-you]",
      );
      const focusRow = () =>
        section
          ?.querySelector<HTMLElement>("[data-session-row]")
          ?.focus({ preventScroll: false });
      const toggle = filters.byProject
        ? section?.querySelector<HTMLElement>("h2 button[aria-expanded]")
        : null;
      if (toggle?.getAttribute("aria-expanded") === "false") {
        toggle.click();
        window.requestAnimationFrame(focusRow);
      } else focusRow();
    };
    if (filtersActive && onClearFilters) {
      onClearFilters();
      window.requestAnimationFrame(focus);
    } else focus();
  }, [filtersActive, onClearFilters, filters.byProject]);

  // A host-drawn bar hears the counts before paint, so it never shows the
  // previous list's numbers; it hears nothing once this list is gone. Only a
  // changed count reaches it (the store drops an equal answer).
  const needsYouCount = inbox.needsYou.length + initiativeInbox.outcomes.length;
  const { activeCount: backgroundCount, ownerCount: backgroundOwners } =
    backgroundActive;
  useLayoutEffect(() => {
    barStore?.set({
      needsYou: needsYouCount,
      working: workingCount,
      background: {
        activeCount: backgroundCount,
        ownerCount: backgroundOwners,
      },
      onNeedsYou: focusNeedsYou,
    });
  }, [
    barStore,
    needsYouCount,
    workingCount,
    backgroundCount,
    backgroundOwners,
    focusNeedsYou,
  ]);
  useLayoutEffect(() => () => barStore?.set(null), [barStore]);

  const allArchivedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const archivedSessions = useMemo(
    () =>
      allArchivedSessions.filter((session) =>
        attentionHistoryMatches(session, "archived", filters, filterProjects),
      ),
    [allArchivedSessions, filters, filterProjects],
  );
  const archivedAvailableCount = Math.max(
    archivedSessionCount,
    allArchivedSessions.length,
  );
  const showArchivedShelf =
    filters.statuses.length === 0 || filters.statuses.includes("archived");

  useEffect(() => {
    if (
      showArchived &&
      showArchivedShelf &&
      !archivedSessionsLoaded &&
      archivedAvailableCount > 0
    )
      onLoadArchivedSessions();
  }, [
    showArchived,
    showArchivedShelf,
    archivedSessionsLoaded,
    archivedAvailableCount,
    onLoadArchivedSessions,
  ]);

  // A directly routed settled session must never be hidden behind a disclosure.
  const routedIsSettled = view.settled.some(
    (session) => session.id === currentId,
  );
  const settledExpanded = settledOpen || routedIsSettled;

  const toggleCluster = useCallback((id: string) => {
    setOpenClusters((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
    // Closing a fold forgets its history toggle, as closing the composer
    // ledge does: it opens again on what is live.
    setSettledHistory((ids) => ids.filter((value) => value !== id));
  }, []);
  const toggleSettledHistory = useCallback((id: string) => {
    setSettledHistory((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id],
    );
  }, []);
  // Runs and clusters share the disclosure state, so they share its key space:
  // `inboxItemId` is what keeps a run id from colliding with a session id.
  const toggleRunRoles = useCallback(
    (runId: string) => toggleCluster(`run:${runId}`),
    [toggleCluster],
  );
  const toggleInitiativeSessions = useCallback(
    (initiativeId: string) => toggleCluster(initiativeItemId(initiativeId)),
    [toggleCluster],
  );
  const showMoreInitiativeSessions = useCallback((initiativeId: string) => {
    setExpandedInitiativeSessions((ids) => ids.includes(initiativeId) ? ids : [...ids, initiativeId]);
  }, []);

  const focusSibling = useCallback((delta: 1 | -1) => {
    const container = containerRef.current;
    const from = document.activeElement as HTMLElement | null;
    if (!container || !from) return;
    // A card playing an exit is inert, so it is not a stop on the way down the
    // list — whichever exit it is. The keyboard settle marks the stage wrapper,
    // a swipe marks `SwipeRow`'s own host, and a card that has left but is still
    // mounted would otherwise be a focus stop with nothing in it.
    const rows = [
      ...container.querySelectorAll<HTMLElement>("[data-session-row]"),
    ].filter(
      (row) => !row.closest("[data-session-leaving], [data-swipe-exit]"),
    );
    const index = rows.indexOf(from);
    const next = rows[index + delta];
    if (next) next.focus({ preventScroll: false });
  }, []);

  /**
   * The exposed sessions under an item: a cluster's peers, or a Workflow Run's
   * own role sessions. Ordinary rows of this list either way — same swipe, same
   * exit, same focus traversal — which is what keeps a folded session reachable
   * whichever fold it is in.
   */
  const renderChildRows = (
    rows: SessionInboxCard[],
    relation: "coordinated" | "workflow" = "coordinated",
    live?: ReadonlySet<string>,
    dragging = false,
  ) =>
    rows.map((child) => {
      // A settled peer listed as history is already down: it keeps Archive
      // and Delete, and offers no Settle it has nothing left to acknowledge.
      const shelved = isShelvedSession(child.session);
      // History rows are on the Settled shelf too, under the session id.
      const history = live !== undefined && !live.has(child.session.id);
      const swipe = cardSwipe(child);
      return (
        <ExitStage
          key={child.session.id}
          leaving={settling.includes(child.session.id)}
        >
          <SwipeRow
            {...(shelved ? { left: swipe.left } : swipe)}
            disabled={dragging}
            onExited={() => runSwipeExit(child.session.id)}
          >
            <ClusterChildRow
              card={child}
              now={now}
              density={density}
              relation={relation}
              active={child.session.id === currentId}
              {...(history ? { listRowId: `history:${child.session.id}` } : {})}
              onOpen={onSelect}
              onSettle={shelved ? undefined : settleCard}
              onArchive={onArchive}
              onDelete={onDeleteSession}
              onFocusSibling={focusSibling}
            />
          </SwipeRow>
        </ExitStage>
      );
    });

  const renderRunItem = (item: WorkflowRunInboxItem, dragging: boolean) => {
    const id = inboxItemId(item);
    const worktreeStatus = item.run.worktreeId
      ? worktreeStatuses[item.run.worktreeId]
      : undefined;
    // Settle is the ONE verb a run carries here — archive, delete and every
    // run control live on the Workflow card on its Task — so the item has the
    // settle exit and no swipe. Its role rows keep both, because they are
    // still sessions. The whole item leaves through one exit, rows included.
    return (
      <ExitStage leaving={settling.includes(id)}>
        {/* The separator belongs to the WHOLE fold, not its header. When
              roles open, it travels below their rows instead of cutting the
              run away from the sessions it contains. */}
        <div
          // An open fold ends with a little air, so its last row reads as
          // part of it rather than as the start of the next item.
          className={`border-b border-border/60 ${childRows(item).length > 0 ? "pb-2" : ""}`}
        >
          <WorkflowRunInboxCard
            item={item}
            now={now}
            density={density}
            worktreeIntegrated={Boolean(worktreeStatus?.merged && worktreeStatus.ahead > 0)}
            expanded={expandedClusters.has(id)}
            onOpen={onOpenWorkflowRun}
            onOpenSession={onSelect}
            onSettle={settleRun}
            onToggleRoles={toggleRunRoles}
            onFocusSibling={focusSibling}
            projectKey={runProjectById.get(item.run.projectId ?? "")?.key}
            projectName={runProjectById.get(item.run.projectId ?? "")?.name}
            projectColor={runProjectById.get(item.run.projectId ?? "")?.color}
          />
          {renderChildRows(childRows(item), "workflow", undefined, dragging)}
        </div>
      </ExitStage>
    );
  };

  const renderSessionItem = (
    item: SessionInboxItem & { kind: "session" },
    dragging: boolean,
  ) => {
    const card = item.card;
    const id = card.session.id;
    const worktreeStatus = card.session.worktreeId
      ? worktreeStatuses[card.session.worktreeId]
      : undefined;
    const rows = childRows(item);
    const liveIds = new Set(card.cluster?.children.map((child) => child.session.id));
    const settledRows = card.cluster?.childrenWithSettled.filter(
      (child) => !liveIds.has(child.session.id),
    ) ?? [];
    return (
      <ExitStage leaving={settling.includes(id)}>
        {/* The separator wraps the card AND its disclosed peers. It stays
                at the bottom of the cluster as rows open and close, making the
                expansion part of the card rather than loose rows beneath it. */}
        <div
          // An open fold ends with a little air, so its last row reads as
          // part of it rather than as the start of the next card.
          className={`border-b border-border/60 ${
            rows.length > 0 ||
            (expandedClusters.has(id) && (card.cluster?.settledCount ?? 0) > 0)
              ? "pb-2"
              : ""
          }`}
        >
          {/* The swipe wraps the CARD, inside both exit stages: a card
                  leaving by keyboard is animated by the stages above, and one
                  leaving by thumb is animated by `SwipeRow` — whose height
                  close collapses this box, which is what the grid row above
                  measures. Only one of the two ever runs for a given card. */}
          <SwipeRow
            {...cardSwipe(card)}
            disabled={dragging}
            onExited={() => runSwipeExit(id)}
          >
            <ActiveSessionCard
              card={card}
              now={now}
              active={id === currentId}
              relations={relationsById.get(id) ?? NO_RELATIONS}
              worktreeDirty={worktreeStatus?.dirty}
              worktreeIntegrated={Boolean(worktreeStatus?.merged && worktreeStatus.ahead > 0)}
              density={density}
              clusterExpanded={expandedClusters.has(id)}
              onOpen={onSelect}
              onSettle={settleCard}
              onDismissFailure={onDismissFailure}
              onOpenProject={onOpenProject}
              onOpenTask={onOpenTask}
              onOpenWorktree={onOpenWorktree}
              onRename={onRenameSession}
              onArchive={onArchive}
              onDelete={onDeleteSession}
              onToggleCluster={toggleCluster}
              onFocusSibling={focusSibling}
            />
          </SwipeRow>
          {renderChildRows(
            rows.filter((child) => liveIds.has(child.session.id)),
            "coordinated",
            undefined,
            dragging,
          )}
          {expandedClusters.has(id) && settledRows.length > 0 ? (
            <ListExpansionRow
              rowId={`session-peers-settled-${id}`}
              label="Settled"
              count={settledRows.length}
              density={density}
              expanded={settledHistory.includes(id)}
              onToggle={() => toggleSettledHistory(id)}
              onFocusSibling={focusSibling}
            >
              {renderChildRows(settledRows, "coordinated", liveIds, dragging)}
            </ListExpansionRow>
          ) : null}
        </div>
      </ExitStage>
    );
  };

  /**
   * An Initiative and, when opened, the sessions started from its Tasks. Those
   * rows only LIST sessions that keep their own cards, so they open the
   * session and offer none of its lifecycle actions: Settle, Archive and
   * Delete stay on the session's own card, where that session is the subject.
   * Settle is the one verb the Initiative carries, with the settle exit.
   */
  const renderInitiativeItem = (item: InitiativeInboxItem) => {
    const id = initiativeItemId(item.initiative.id);
    const open = expandedClusters.has(id);
    const rows = initiativeRows(item);
    const additionalCount = item.additionalSessions?.length ?? 0;
    const unavailableCount = Math.max(0, item.more - additionalCount);
    const showMore = expandedInitiativeSessions.includes(item.initiative.id);
    // Said about the outcome the card showed when the Settle failed; a newer
    // outcome is a different item.
    const settleError = initiativeSettleErrors?.[item.initiative.id];
    const settleNote =
      settleError && settleError.revision === item.settleRevision
        ? settleError.message
        : null;
    return (
      <div key={id} data-inbox-card={id}>
        <ExitStage leaving={settling.includes(id)}>
          <div className={`border-b border-border/60 ${open ? "pb-2" : ""}`}>
            <InitiativeInboxCard
              item={item}
              now={now}
              density={density}
              expanded={open}
              onOpen={onOpenInitiative}
              onSettle={settleInitiativeItem}
              onToggleSessions={toggleInitiativeSessions}
              onFocusSibling={focusSibling}
            />
            {/* Its Settle's failure, on the card whose control was refused. */}
            {settleNote ? (
              <ErrorNote className="mx-2 my-1" message={settleNote} />
            ) : null}
            {rows.map((child) => (
              <ClusterChildRow
                key={child.session.id}
                card={child}
                now={now}
                density={density}
                relation="working"
                active={child.session.id === currentId}
                // The session's own card already carries its id.
                listRowId={`${id}:${child.session.id}`}
                onOpen={onSelect}
                onFocusSibling={focusSibling}
              />
            ))}
            {open && !showMore && additionalCount > 0 ? (
              <InitiativeMoreRow
                initiativeId={item.initiative.id}
                title={item.initiative.title}
                more={additionalCount}
                density={density}
                onShowMore={showMoreInitiativeSessions}
                onFocusSibling={focusSibling}
              />
            ) : null}
            {open && unavailableCount > 0 ? (
              <p className="border-t border-border/60 px-3 py-1 text-xs text-muted-foreground">
                {unavailableCount} more session{unavailableCount === 1 ? " is" : "s are"} not loaded
              </p>
            ) : null}
          </div>
        </ExitStage>
      </div>
    );
  };

  const renderItem = (item: SessionInboxItem, dragging: boolean) =>
    item.kind === "run"
      ? renderRunItem(item, dragging)
      : renderSessionItem(item, dragging);

  // The whole item — a card and any rows it has open, or a run and its roles —
  // is ONE block of the list: it leaves through one exit, the reorder pass
  // measures it as one block, and a drag picks it up whole, so an expanded
  // cluster cannot animate or be dragged apart.
  const renderCardList = (items: SessionInboxItem[]) =>
    items.map((item) => {
      const id = inboxItemId(item);
      return (
        <div key={id} data-inbox-card={id}>
          {renderItem(item, false)}
        </div>
      );
    });

  const renderNeedsYou = (entries: NeedsYouEntry[]) =>
    entries.map((entry) =>
      entry.kind === "initiative" ? (
        renderInitiativeItem(entry.item)
      ) : (
        <div
          key={needsYouEntryId(entry)}
          data-inbox-card={needsYouEntryId(entry)}
        >
          {renderItem(entry.item, false)}
        </div>
      ),
    );

  const itemIsSelected = (item: SessionInboxItem) =>
    item.kind === "run"
      ? item.roles.some((role) => role.session.id === currentId)
      : item.card.session.id === currentId ||
        Boolean(
          item.card.cluster?.childrenWithSettled.some(
            (child) => child.session.id === currentId,
          ),
        );
  const sessionProject = (session: SessionListItem) =>
    filterProjects.get(session.id) ?? null;
  const sessionIsSelected = (session: SessionListItem) =>
    session.id === currentId;
  const renderProjectGroups = <T,>(
    scope: string,
    items: T[],
    projectFor: (item: T) => string | null,
    render: (items: T[]) => ReactNode,
    selected: (item: T) => boolean,
    nested = false,
  ): ReactNode => {
    if (!filters.byProject) return render(items);
    return groupAttentionByProject(items, projectFor, projectOrder).map(
      (group) => (
        <ListGroupSection
          key={
            group.projectId === null
              ? "unassigned"
              : `project-${group.projectId}`
          }
          id={`session-inbox-${scope}-${group.projectId === null ? "unassigned" : `project-${group.projectId}`}`}
          title={
            group.projectId
              ? (runProjectById.get(group.projectId)?.name ?? group.projectId)
              : "Unassigned"
          }
          icon={<Folder size={14} className="shrink-0" aria-hidden />}
          containsSelected={group.items.some(selected)}
          onOpenChange={onProjectDisclosure}
          sticky={!nested}
          compact={nested}
        >
          {render(group.items)}
        </ListGroupSection>
      ),
    );
  };
  const activeProjects = useMemo(
    () =>
      new Map(
        inbox.active.map((item) => [inboxItemId(item), projectForItem(item)]),
      ),
    [inbox.active, projectForItem],
  );
  const detectInboxCollisions = useCallback<CollisionDetection>(
    (args) => {
      if (!filters.byProject) return closestCenter(args);
      const projectId = activeProjects.get(String(args.active.id));
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => activeProjects.get(String(container.id)) === projectId,
        ),
      });
    },
    [filters.byProject, activeProjects],
  );

  const dropItem = useCallback(
    ({ active, over }: DragEndEvent) => {
      setDragging(false);
      if (!over || !onSetInboxPositions) return;
      const projectId = activeProjects.get(String(active.id));
      if (
        filters.byProject &&
        projectId !== activeProjects.get(String(over.id))
      )
        return;
      const items = filters.byProject
        ? inbox.active.filter((item) => projectForItem(item) === projectId)
        : inbox.active;
      const positions = planInboxDrop(
        items,
        String(active.id),
        String(over.id),
      );
      if (!positions) return;
      // Refused HERE, before anything moves: the server takes at most this
      // many, and a renumbering past it would show an order it then refuses.
      // The card is back where it was, so the message says why.
      if (positions.length > MAX_INBOX_POSITIONS) {
        showToast(
          `Couldn't move the card: reordering here would renumber more than ${MAX_INBOX_POSITIONS} items. Settle some first.`,
          { tone: "error" },
        );
        return;
      }
      onSetInboxPositions(positions);
    },
    [
      inbox.active,
      onSetInboxPositions,
      filters.byProject,
      activeProjects,
      projectForItem,
    ],
  );
  const activeIds = useMemo(
    () =>
      filters.byProject
        ? groupAttentionByProject(
            view.active,
            projectForItem,
            projectOrder,
          ).flatMap((group) => group.items.map(inboxItemId))
        : view.active.map(inboxItemId),
    [view.active, filters.byProject, projectForItem, projectOrder],
  );

  // The cold-start message claims this browser has NOTHING, so a live Workflow
  // Run has to count against it: a run in `starting` owns no session yet, and a
  // run whose projection is absent owns none this browser can name — telling the
  // user there is no agent work while one of those is running is exactly the
  // failure the run items exist to remove. It is a message INSIDE the browser
  // rather than instead of it: the bar states the same three counts on a cold
  // start as at any other moment, and a browser that swapped its own header out
  // would be the first thing to move.
  // Initiatives count against both claims too: an inbox holding only an
  // Initiative is not empty. And neither claim is made before the Initiative
  // list has answered: that would state an emptiness nobody read. A failed
  // read is not that answer — until one comes, the failure stands alone. Nor
  // is an earlier answer while a new read is out: that one refreshes.
  const initiativesPending = !initiativesFresh && !initiativeListError;
  const nothingToShow =
    view.empty && archivedSessions.length === 0 && initiativeItems.length === 0;
  const coldStart =
    sessions.length === 0 &&
    archivedAvailableCount === 0 &&
    inbox.needsYou.length === 0 &&
    inbox.active.length === 0 &&
    initiativeItems.length === 0;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col ${barStore ? "pt-1" : ""}`}
    >
      {/* Background work runs outside any turn and often outside the session you
          are looking at, so the browser states the global count where every
          session list is read, and links to the registry. Derived from the
          session summaries alone — this surface holds no registry subscription. */}
      {barStore ? null : (
        <SessionInboxBar
          needsYou={needsYouCount}
          filterControl={filterControl}
          working={workingCount}
          background={backgroundActive}
          onNeedsYou={focusNeedsYou}
          onOpenBackgroundTasks={onOpenBackgroundTasks}
        />
      )}

      {nothingToShow && initiativesPending ? (
        initiativesRefreshing ? (
          <div className="flex flex-none justify-center p-3">
            <RefreshIndicator label="Refreshing Initiatives" />
          </div>
        ) : (
          <PaneLoading label="Loading Initiatives…" className="flex-none p-3" />
        )
      ) : !initiativesFresh ? null : coldStart ? (
        <EmptyBox>No sessions yet. Use “New Session” to start one.</EmptyBox>
      ) : nothingToShow ? (
        filtersActive ? (
          <EmptyBox
            action={
              onClearFilters ? (
                <Button variant="ghost" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          >
            {showArchivedShelf &&
            archivedAvailableCount > 0 &&
            !archivedSessionsLoaded
              ? "No loaded items match these filters. Archived history loads when opened."
              : "No items match these filters."}
          </EmptyBox>
        ) : (
          <EmptyBox>Nothing needs you right now.</EmptyBox>
        )
      ) : null}

      {/* A failed Initiative list read is stated above both places its
          items stand, over any items still held. */}
      {initiativeListError ? (
        <ErrorNote
          className="mx-2 my-1"
          message={initiativeListError}
          onRetry={onRetryInitiatives}
        />
      ) : null}

      {needsYouEntries.length > 0 ? (
        // No heading: the cards say it themselves (their status icon and a
        // bright title), and the bar above counts them. The section stays the
        // block "Needs you" in the bar scrolls to. An Initiative's unsettled
        // paused or done outcome is one of its items, like an ended run.
        <section
          aria-label="Needs you"
          data-inbox-needs-you
          className="flex flex-col"
        >
          {filters.byProject ? (
            <>
              {renderNeedsYou(
                needsYouEntries.filter((entry) => entry.kind === "initiative"),
              )}
              {renderProjectGroups(
                "needs-you",
                view.needsYou,
                projectForItem,
                renderCardList,
                itemIsSelected,
              )}
            </>
          ) : (
            renderNeedsYou(needsYouEntries)
          )}
        </section>
      ) : null}

      {/* Active Initiatives head the working set, newest first and never
          dragged: their order is creation alone, and Settle is the one
          Initiative write the UI makes. */}
      {initiativeInbox.active.length > 0 ? (
        <section
          aria-label="Initiatives"
          data-inbox-initiatives
          className="flex flex-col"
        >
          {initiativeInbox.active.map(renderInitiativeItem)}
        </section>
      ) : null}

      {onSetInboxPositions ? (
        <DndContext
          sensors={sensors}
          collisionDetection={detectInboxCollisions}
          onDragStart={() => setDragging(true)}
          onDragEnd={dropItem}
          onDragCancel={() => setDragging(false)}
        >
          <SortableContext
            items={activeIds}
            strategy={verticalListSortingStrategy}
          >
            {renderProjectGroups(
              "active",
              view.active,
              projectForItem,
              (items) =>
                items.map((item) => (
                  <DraggableInboxItem
                    key={inboxItemId(item)}
                    id={inboxItemId(item)}
                  >
                    {(lifted) => renderItem(item, lifted)}
                  </DraggableInboxItem>
                )),
              itemIsSelected,
            )}
          </SortableContext>
        </DndContext>
      ) : (
        renderProjectGroups(
          "active",
          view.active,
          projectForItem,
          renderCardList,
          itemIsSelected,
        )
      )}

      {view.settledTotal > 0 ? (
        <ListGroupSection
          id="session-inbox-settled"
          title="Settled"
          icon={<Check size={14} className="shrink-0" aria-hidden />}
          open={settledExpanded}
          onOpenChange={setSettledOpen}
        >
          {/* History totals do not inform a decision; paging says how much
              more there is once the shelf is open. */}
          {renderProjectGroups(
            "settled",
            view.settled,
            sessionProject,
            (items) =>
              items.map((session) => (
                <InboxShelfRow
                  key={session.id}
                  session={session}
                  kind="settled"
                  active={session.id === currentId}
                  now={now}
                  density={density}
                  onOpen={() => onSelect(session.id)}
                  onRestore={() => onSettle(session.id, false)}
                  onArchive={() => onArchive(session.id, true)}
                  onDelete={() => onDeleteSession(session.id)}
                  onFocusSibling={focusSibling}
                />
              )),
            sessionIsSelected,
            true,
          )}
          {view.settledHidden > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setSettledLimit((limit) => limit + SETTLED_PAGE_STEP)
              }
              className="justify-start"
            >
              Show {Math.min(SETTLED_PAGE_STEP, view.settledHidden)} more
              settled session
              {Math.min(SETTLED_PAGE_STEP, view.settledHidden) === 1 ? "" : "s"}
            </Button>
          ) : null}
        </ListGroupSection>
      ) : null}

      {showArchivedShelf && archivedAvailableCount > 0 ? (
        <ListGroupSection
          id="session-inbox-archived"
          title="Archived"
          icon={<Archive size={14} className="shrink-0" aria-hidden />}
          open={showArchived}
          onOpenChange={setShowArchived}
        >
          {archivedSessionsLoaded ? (
            <div className="flex flex-col">
              {archivedSessions.length === 0 ? (
                <EmptyBox>No archived sessions match these filters.</EmptyBox>
              ) : null}
              {renderProjectGroups(
                "archived",
                archivedSessions,
                sessionProject,
                (items) =>
                  items.map((session) => (
                    <InboxShelfRow
                      key={session.id}
                      session={session}
                      kind="archived"
                      active={session.id === currentId}
                      now={now}
                      density={density}
                      onOpen={() => onSelect(session.id)}
                      onRestore={() => onArchive(session.id, false)}
                      onArchive={() => onArchive(session.id, false)}
                      onDelete={() => onDeleteSession(session.id)}
                      onFocusSibling={focusSibling}
                    />
                  )),
                sessionIsSelected,
                true,
              )}
            </div>
          ) : (
            <PaneLoading
              label="Loading archived sessions…"
              className="flex-none p-3"
            />
          )}
        </ListGroupSection>
      ) : null}
    </div>
  );
}

/**
 * One item of the draggable working set, picked up WHOLE: a card with any rows
 * it has open, or a run with its roles. The whole block is the activator — a
 * mouse after a few px, touch after a long press — so a click still opens and
 * a quick horizontal thumb still swipes. Told while it is lifted, so the
 * swipes inside it hand the finger over (`SwipeRow`'s `disabled`).
 *
 * No keyboard drag, deliberately: the cards own ↑/↓, Enter and the settle and
 * archive keys, and the sortable's Space pickup would need a focus stop of its
 * own on top of the card's.
 */
function DraggableInboxItem({
  id,
  children,
}: {
  id: string;
  children: (lifted: boolean) => ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      data-inbox-card={id}
      {...listeners}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: transition ?? undefined,
      }}
      className={`touch-manipulation ${isDragging ? "relative z-10 bg-muted shadow-lg ring-1 ring-foreground/25" : ""}`}
    >
      {children(isDragging)}
    </div>
  );
}

/**
 * FLIP for the inbox's cards: remember where each card was, and after the
 * commit that moved it, put it back and let it travel to its new place. The
 * Web Animations API rather than a class, so this cannot collide with the
 * settle exit's own transitions on the same element.
 *
 * Positions are the cards' LAYOUT positions ({@link layoutTop}), never viewport
 * rects. A viewport rect also moves when the sidebar scrolls, and again while a
 * FLIP of that same card is still running, and neither means the card moved:
 * keyed on rects, every scroll made every card animate back over its own scroll
 * delta, and every overlapping commit measured the previous animation instead
 * of the layout, so the two fed each other. That was the inbox's scroll flicker
 * (Task 338).
 *
 * They are measured from the LIST's own top, not the page's. Whatever sits
 * above the list can move it as a whole without any card having moved: the
 * host-drawn counts bar appears only after the first pass has measured (the
 * list publishes its counts later in that same commit), and on a phone that
 * first pass runs on every return from a chat. Measured from the page, the
 * next tick then slid every card down from one bar height above its place.
 *
 * `version` is a digest of what the cards render, so the pass runs on the
 * commits that could have moved something rather than on all ~5 a second.
 * Measuring is then one layout read per card, in a batch that writes nothing,
 * so it costs a single flush; {@link planCardReorder} then owns the decision,
 * where it can be tested without a layout engine.
 */
function useCardReorder(
  containerRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  version: string,
): void {
  const previous = useRef(new Map<string, number>());
  const running = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!enabled) {
      // Forget the old geometry, or re-enabling would animate from wherever the
      // cards last happened to be measured.
      previous.current.clear();
      for (const animation of running.current.values()) animation.cancel();
      running.current.clear();
      return;
    }

    // Measure every card BEFORE animating any of them: a read after a write
    // would be a forced reflow per card rather than one for the batch.
    const origin = layoutTop(container);
    const nodes = new Map<string, HTMLElement>();
    const measured: Array<{ id: string; top: number }> = [];
    for (const node of container.querySelectorAll<HTMLElement>(
      "[data-inbox-card]",
    )) {
      const id = node.dataset.inboxCard;
      if (!id) continue;
      nodes.set(id, node);
      measured.push({ id, top: layoutTop(node) - origin });
    }

    const { moves, next } = planCardReorder(previous.current, measured);
    for (const { id, from } of moves) {
      const node = nodes.get(id);
      if (!node) continue;
      // One FLIP at a time per card: leaving the previous one running would
      // hand the card back to it the moment the newer one finished.
      running.current.get(id)?.cancel();
      const animation = node.animate?.(
        [
          { transform: `translateY(${from}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: REORDER_MS, easing: "ease-out" },
      );
      if (!animation) continue;
      running.current.set(id, animation);
      const done = () => {
        if (running.current.get(id) === animation) running.current.delete(id);
      };
      animation.addEventListener("finish", done);
      animation.addEventListener("cancel", done);
    }

    // Cards that left take their animation with them.
    for (const [id, animation] of running.current) {
      if (next.has(id)) continue;
      animation.cancel();
      running.current.delete(id);
    }
    previous.current = next;
  }, [containerRef, enabled, version]);

  useEffect(() => {
    const animations = running.current;
    return () => {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    };
  }, []);
}

/**
 * A card's layout position, summed up its whole `offsetParent` chain.
 *
 * `offsetTop` alone is relative to the nearest POSITIONED ancestor, so it is
 * only comparable between two cards while they share one — true today, and
 * exactly the kind of invariant that a later `relative` on the "Needs you"
 * section would break silently: the two blocks would measure against different
 * origins, every card in one of them would look like it had jumped, and the
 * symptom would be the flicker this hook exists to remove. Summing the chain
 * makes the origin the same for every card whatever is positioned in between,
 * so there is no invariant left to defend. It stays immune to scrolling and to
 * a running transform, which is the whole point of not using a viewport rect.
 */
function layoutTop(node: HTMLElement): number {
  let top = 0;
  let current: Element | null = node;
  while (current instanceof HTMLElement) {
    top += current.offsetTop;
    current = current.offsetParent;
  }
  return top;
}
