import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Archive, Check, ChevronRight } from "lucide-react";
import { isShelvedSession } from "@assistant/shared";
import type {
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
import { InboxShelfRow } from "./InboxShelfRow.tsx";
import { SessionInboxBar } from "./SessionInboxBar.tsx";
import { usePrefersReducedMotion } from "./shell/usePrefersReducedMotion.ts";
import { useShortcuts, type ShortcutGroup } from "./common/shortcuts.tsx";
import { EmptyBox } from "./common/load.tsx";
import { SwipeRow, type SwipeAction } from "./common/SwipeRow.tsx";
import { useNow } from "../hooks/useNow.ts";
import { dismissToastKey, showToast, TOAST_DWELL_MS } from "../lib/toast.ts";
import type { RowDensity } from "../lib/rowDensity.ts";
import {
  buildSessionInbox,
  classifySessionStatus,
  inboxItemId,
  planCardReorder,
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
const SETTLE_EXIT_MS = 350;

/** How long a card takes to travel to its new place when the order changes. */
const REORDER_MS = 220;

/** One shared empty relations object, so an unjoined card keeps its memo. */
const NO_RELATIONS: SessionCardRelations = {};

interface Props {
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
  onArchive,
  onDeleteSession,
  onRenameSession,
  onLoadArchivedSessions,
  onOpenBackgroundTasks,
  onOpenProject,
  onOpenTask,
  onOpenWorkflowRun,
  onSettleWorkflowRun,
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Cards on their way out: they stay in the list, playing the exit, until the
  // settle command is actually sent — the row is the animation's subject, so it
  // cannot be removed by the list update first.
  const [settling, setSettling] = useState<string[]>([]);
  const settleTimers = useRef(new Map<string, number>());
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
  const view = useMemo(
    () =>
      buildSessionInbox(sessions, {
        ...(currentId !== undefined ? { currentId } : {}),
        ...(readCurrentId !== undefined ? { readCurrentId } : {}),
        settledLimit,
        ...(workflowRuns ? { workflowRuns } : {}),
        workflowCards,
        taskTitles,
      }),
    [
      sessions,
      currentId,
      readCurrentId,
      settledLimit,
      workflowRuns,
      workflowCards,
      taskTitles,
    ],
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
      return settledHistory.includes(item.card.session.id)
        ? cluster.childrenWithSettled
        : cluster.children;
    },
    [expandedClusters, settledHistory],
  );

  // ONE ticker for every visible elapsed label, not one interval per card —
  // including the rows an open cluster or run contributes, which carry their
  // own. A run item is deliberately not a reason to tick every second: it shows
  // a minute-granularity age and no elapsed label, so only the SESSIONS under it
  // can ask for the faster clock.
  const anyRunning = [...view.needsYou, ...view.active].some(
    (item) =>
      (item.kind === "session" && item.card.status === "running") ||
      childRows(item).some((child) => child.status === "running"),
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
  const cardLayoutKey = useMemo(
    () =>
      [
        // The density is part of every card's HEIGHT: a sidebar that turns
        // from rail to phone screen while mounted repaints every row, and a
        // digest that ignored it would leave the baseline at the old geometry
        // for the next keyed change to animate from.
        density,
        ...[...view.needsYou, ...view.active].map((item) =>
          [
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
    [density, view, now, relationsById, childRows],
  );

  // A card MOVES when its state changes — read, finished, started running — and
  // an instant jump is read as the list having been shuffled by something else.
  // So the commit that moved it measures the cards and animates any that
  // changed place from where they were (FLIP): one transform per moved card, no
  // layout thrash on the ones that stayed. Skipped entirely while a settle exit
  // is playing — that animation already moves the rows below it, and animating
  // both would fight.
  useCardReorder(
    containerRef,
    animateSettle && settling.length === 0,
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

  // The bar's counts are stats rather than filters, so the one with somewhere
  // to go takes you to the first row it counts instead of hiding the rest.
  const focusNeedsYou = useCallback(() => {
    containerRef.current
      ?.querySelector<HTMLElement>("[data-inbox-needs-you] [data-session-row]")
      ?.focus({ preventScroll: false });
  }, []);

  const archivedSessions = useMemo(
    () =>
      sessions
        .filter((s) => s.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );
  const archivedAvailableCount = Math.max(
    archivedSessionCount,
    archivedSessions.length,
  );

  useEffect(() => {
    if (showArchived && !archivedSessionsLoaded && archivedAvailableCount > 0)
      onLoadArchivedSessions();
  }, [
    showArchived,
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

  const renderRunItem = (item: WorkflowRunInboxItem) => {
    const id = inboxItemId(item);
    // Settle is the ONE verb a run carries here — archive, delete and every
    // run control live on the Workflow card on its Task — so the item has the
    // settle exit and no swipe. Its role rows keep both, because they are
    // still sessions. The whole item leaves through one exit, rows included.
    return (
      <div key={id} data-inbox-card={id}>
        <ExitStage leaving={settling.includes(id)}>
          {/* The separator belongs to the WHOLE fold, not its header. When
              roles open, it travels below their rows instead of cutting the
              run away from the sessions it contains. */}
          <div className="border-b border-border/60">
            <WorkflowRunInboxCard
              item={item}
              now={now}
              density={density}
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
            {renderChildRows(childRows(item), "workflow")}
          </div>
        </ExitStage>
      </div>
    );
  };

  const renderCardList = (items: SessionInboxItem[]) =>
    items.map((item) => {
      if (item.kind === "run") return renderRunItem(item);
      const card = item.card;
      const id = card.session.id;
      const rows = childRows(item);
      return (
        // The whole cluster — the card and any rows it has open — is ONE item
        // of the list: it leaves through one exit, and the reorder pass measures
        // it as one block, so an expanded cluster cannot animate itself apart.
        <div key={id} data-inbox-card={id}>
          <ExitStage leaving={settling.includes(id)}>
            {/* The separator wraps the card AND its disclosed peers. It stays
                at the bottom of the cluster as rows open and close, making the
                expansion part of the card rather than loose rows beneath it. */}
            <div className="border-b border-border/60">
              {/* The swipe wraps the CARD, inside both exit stages: a card
                  leaving by keyboard is animated by the stages above, and one
                  leaving by thumb is animated by `SwipeRow` — whose height
                  close collapses this box, which is what the grid row above
                  measures. Only one of the two ever runs for a given card. */}
              <SwipeRow {...cardSwipe(card)} onExited={() => runSwipeExit(id)}>
                <ActiveSessionCard
                  card={card}
                  now={now}
                  active={id === currentId}
                  relations={relationsById.get(id) ?? NO_RELATIONS}
                  worktreeDirty={
                    card.session.worktreeId
                      ? worktreeStatuses[card.session.worktreeId]?.dirty
                      : undefined
                  }
                  density={density}
                  clusterExpanded={expandedClusters.has(id)}
                  onOpen={onSelect}
                  onSettle={settleCard}
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
                rows,
                "coordinated",
                card.cluster && settledHistory.includes(id)
                  ? new Set(card.cluster.children.map((c) => c.session.id))
                  : undefined,
              )}
              {/* The fold's history, on request: the peers already settled,
                  put back in the tree where they were spawned. Offered only
                  while the fold is open and has any. */}
              {expandedClusters.has(id) &&
              (card.cluster?.settledCount ?? 0) > 0 ? (
                <button
                  type="button"
                  aria-expanded={settledHistory.includes(id)}
                  onClick={() => toggleSettledHistory(id)}
                  className={`flex ${density === "comfortable" ? "min-h-8" : "min-h-7"} w-full items-center gap-1.5 py-0.5 pl-3 pr-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40`}
                >
                  <ChevronRight
                    size={12}
                    aria-hidden
                    className={`shrink-0 transition-transform ${settledHistory.includes(id) ? "rotate-90" : ""}`}
                  />
                  {settledHistory.includes(id)
                    ? "Hide settled"
                    : `Show ${card.cluster?.settledCount} settled`}
                </button>
              ) : null}
            </div>
          </ExitStage>
        </div>
      );
    });

  // The cold-start message claims this browser has NOTHING, so a live Workflow
  // Run has to count against it: a run in `starting` owns no session yet, and a
  // run whose projection is absent owns none this browser can name — telling the
  // user there is no agent work while one of those is running is exactly the
  // failure the run items exist to remove. It is a message INSIDE the browser
  // rather than instead of it: the bar states the same three counts on a cold
  // start as at any other moment, and a browser that swapped its own header out
  // would be the first thing to move.
  const coldStart =
    sessions.length === 0 &&
    archivedAvailableCount === 0 &&
    view.needsYou.length === 0 &&
    view.active.length === 0;

  return (
    <div ref={containerRef} className="flex flex-col gap-px">
      {/* Background work runs outside any turn and often outside the session you
          are looking at, so the browser states the global count where every
          session list is read, and links to the registry. Derived from the
          session summaries alone — this surface holds no registry subscription. */}
      <SessionInboxBar
        needsYou={view.needsYou.length}
        working={workingCount}
        background={backgroundActive}
        onNeedsYou={focusNeedsYou}
        onOpenBackgroundTasks={onOpenBackgroundTasks}
      />

      {coldStart ? (
        <EmptyBox>No sessions yet. Use “New Session” to start one.</EmptyBox>
      ) : view.empty && archivedSessions.length === 0 ? (
        <EmptyBox>Nothing needs you right now.</EmptyBox>
      ) : null}

      {view.needsYou.length > 0 ? (
        <section
          aria-labelledby="session-inbox-needs-you"
          data-inbox-needs-you
          className="mb-1 flex flex-col gap-px"
        >
          {/* The label without the count: the count is the bar's, where it is
              stated whether or not this block exists. */}
          <h2
            id="session-inbox-needs-you"
            className="px-2 pb-0.5 text-xs font-semibold uppercase tracking-wide text-primary"
          >
            Needs you
          </h2>
          {renderCardList(view.needsYou)}
        </section>
      ) : null}

      {renderCardList(view.active)}

      {view.settledTotal > 0 ? (
        <section
          aria-labelledby="session-inbox-settled"
          className="mt-1 flex flex-col gap-px"
        >
          <button
            type="button"
            id="session-inbox-settled"
            onClick={() => setSettledOpen((value) => !value)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${density === "comfortable" ? "min-h-11" : "py-1.5"}`}
            aria-expanded={settledExpanded}
          >
            <ChevronRight
              size={13}
              className={`transition-transform ${settledExpanded ? "rotate-90" : ""}`}
            />
            {/* No count: "Settled (1573)" stated the size of the history, a
                number with no decision behind it. The shelf's own paging says
                how much more there is once it is open. */}
            <span>Settled</span>
          </button>
          {settledExpanded ? (
            <>
              {view.settled.map((session) => (
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
              ))}
              {view.settledHidden > 0 ? (
                <button
                  type="button"
                  onClick={() =>
                    setSettledLimit((limit) => limit + SETTLED_PAGE_STEP)
                  }
                  className="rounded-md px-2.5 py-1 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Show {Math.min(SETTLED_PAGE_STEP, view.settledHidden)} more
                  settled session
                  {Math.min(SETTLED_PAGE_STEP, view.settledHidden) === 1
                    ? ""
                    : "s"}
                </button>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {archivedAvailableCount > 0 ? (
        <section
          aria-labelledby="session-inbox-archived"
          className="mt-1 flex flex-col gap-px"
        >
          <button
            type="button"
            id="session-inbox-archived"
            onClick={() => setShowArchived((value) => !value)}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${density === "comfortable" ? "min-h-11" : "py-1.5"}`}
            aria-expanded={showArchived}
          >
            <ChevronRight
              size={13}
              className={`transition-transform ${showArchived ? "rotate-90" : ""}`}
            />
            <span>Archived</span>
          </button>
          {showArchived ? (
            archivedSessionsLoaded ? (
              <div className="flex flex-col gap-px">
                {archivedSessions.map((session) => (
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
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                Loading archived sessions…
              </div>
            )
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The two nested stages a row leaves through, so the row leaves BEFORE the list
 * closes behind it: the inner box slides out to the left, then the grid row
 * collapses from 1fr to 0fr and everything below travels up. A row that is not
 * leaving carries no transition at all, so an ordinary list update (a new
 * session, a rename) still lands instantly.
 *
 * `data-session-leaving` is what keeps a row that has left out of keyboard
 * traversal while it is still mounted.
 */
function ExitStage({
  leaving,
  children,
}: {
  leaving: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-session-leaving={leaving ? "true" : undefined}
      inert={leaving}
      className={`grid ${
        leaving
          ? "grid-rows-[0fr] motion-safe:delay-200 motion-safe:duration-150 motion-safe:transition-[grid-template-rows] motion-safe:ease-out"
          : "grid-rows-[1fr]"
      }`}
    >
      <div
        className={`min-h-0 overflow-hidden ${
          leaving
            ? "-translate-x-full opacity-0 motion-safe:duration-200 motion-safe:transition-[transform,opacity] motion-safe:ease-in"
            : ""
        }`}
      >
        {children}
      </div>
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
    const nodes = new Map<string, HTMLElement>();
    const measured: Array<{ id: string; top: number }> = [];
    for (const node of container.querySelectorAll<HTMLElement>(
      "[data-inbox-card]",
    )) {
      const id = node.dataset.inboxCard;
      if (!id) continue;
      nodes.set(id, node);
      measured.push({ id, top: layoutTop(node) });
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
