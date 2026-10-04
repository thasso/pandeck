/**
 * Pure shaping for the Sessions inbox (no React, no sockets): status
 * classification, attention tiers, the active/settled partition, ordering, time
 * and status labels, third-line metadata priority, and search matching.
 *
 * "Active" means UNSETTLED, not "currently streaming": a finished-but-unread
 * run, a failed run, and a quiet conversation you have not finished with are all
 * still work. Only an explicit Settle (or Archive) takes a session out of the
 * working set, and only an OUTCOME — a run that completed or failed — puts it
 * back, so a settled session runs its next turn without leaving the shelf.
 *
 * Everything here is deterministic over one `SessionListItem` plus an explicit
 * `now`, so the components can re-label on a shared ticker without recomputing
 * the list, and the rules stay testable against malformed/partial rows.
 */
import type {
  SessionListItem,
  SpawnClusterForest,
  WorkflowRunCard,
  WorkflowRunPhase,
  WorkflowRunSummary,
} from "@assistant/shared";
import {
  isDormantInSpawnTree,
  isShelvedSession,
  isTerminalWorkflowRunLifecycle,
  pendingSessionOutcome,
  pendingWorkflowRunAttention,
  settleBlockedReason,
  spawnClusterDescendantIds,
  spawnClusterForest,
  spawnClusterMembers,
  spawnClusterSettleBlockedReason,
  spawnClusterSettleBlockedReasons,
  workflowRunInWorkingSet,
  workflowRunOwnerBySession,
  workflowRunSettleBlockedReason,
} from "@assistant/shared";
import { sessionDeliveryKey } from "./sessionDelivery.ts";
import { backgroundActivityKey } from "./backgroundWork.ts";
import { elapsedLabel, relativeAge } from "./relativeTime.ts";

/** What a session is doing right now, in the order the inbox cares about. */
export type SessionInboxStatus =
  /** An agent question is waiting for an answer. */
  | "question"
  /** An agent-proposed mutation is waiting for approval. */
  | "approval"
  /** A `/pr` card is waiting for the user to pick which Task the PR is for. */
  | "task-choice"
  /** The last run failed and nothing has superseded it. */
  | "failed"
  /** A turn was cut off mid-flight by a restart and is waiting to be continued. */
  | "interrupted"
  /** A response arrived that the user has not seen. */
  | "unread"
  /** A run is active on the server. */
  | "running"
  /**
   * Unsettled, seen, idle — including a successful outcome already read, and a
   * SHELVED session's stored failure, which the user already acknowledged.
   */
  | "quiet";

/** Attention tiers. Human-blocking work always outranks anything else. */
export type SessionInboxTier = "needs-you" | "attention" | "working" | "active";

const TIER_BY_STATUS: Record<SessionInboxStatus, SessionInboxTier> = {
  question: "needs-you",
  approval: "needs-you",
  "task-choice": "needs-you",
  failed: "attention",
  interrupted: "attention",
  unread: "attention",
  running: "working",
  quiet: "active",
};

const TIER_RANK: Record<SessionInboxTier, number> = {
  "needs-you": 0,
  attention: 1,
  working: 2,
  active: 3,
};

/** One unsettled session, shaped for a rich card. */
export interface SessionInboxCard {
  session: SessionListItem;
  status: SessionInboxStatus;
  tier: SessionInboxTier;
  /** Why Settle is unavailable right now; `undefined` means it is allowed. */
  settleBlocked?: string;
  /**
   * The peer sessions this one still coordinates, folded into this card. Absent
   * for every session that spawned none — the ordinary case — so a card without
   * it is exactly the card this inbox always had.
   */
  cluster?: SessionInboxCluster;
  /**
   * How far below the item it is listed under this card sits: 1 for a peer
   * its coordinator spawned directly, 2 for one of that peer's own, and so on.
   * Set only on a row of an expanded fold, which is drawn as a tree.
   */
  depth?: number;
  /**
   * What a folded row's OWN peers are doing, when it coordinates any: the
   * nested half of the tree, stated on the row the way the top-level card
   * states its whole cluster.
   */
  peers?: SessionClusterCounts;
  /**
   * The card's tree is STALLED: nothing in it is moving, and these peers
   * still owe it a reply ({@link spawnTreeStall}). Set only on a top-level
   * card; a stalled tree needs a poke, so it lifts the card to `attention`.
   */
  stall?: SpawnTreeStall;
}

/**
 * A quiet tree that is still owed an answer — the "done, or does it need a
 * poke?" question a coordinator's card has to answer when its own agent is
 * idle. Peers the user can open, newest activity first.
 */
export interface SpawnTreeStall {
  peers: SessionListItem[];
}

/**
 * Whether a session is doing anything right now: a turn, queued work, a
 * background job starting or running, or a retained background host.
 */
function isMoving(session: SessionListItem): boolean {
  const activity = session.backgroundActivity;
  return Boolean(
    session.isStreaming ||
    session.queuedWork ||
    (activity &&
      (activity.activeCount > 0 ||
        activity.startingCount > 0 ||
        activity.retainedHost)),
  );
}

/** Whether a session is waiting on a human decision (its own bubble says so). */
function waitsOnHuman(session: SessionListItem): boolean {
  return Boolean(
    session.awaitingInput ||
    session.attention === "question" ||
    session.attention === "approval" ||
    session.attention === "task-choice",
  );
}

/**
 * Is this tree STALLED, and on whom? `scope` is the root and the sessions in
 * its tree. The tree is stalled when someone in it still owes a reply
 * (`awaitingRepliesFrom`), yet nothing in it — nor any peer that owes it — is
 * moving or waiting on the user: nobody is working, so the reply is not
 * coming without a poke.
 *
 * Read over the WHOLE tree rather than per request, deliberately: a
 * coordinator commonly tells an implementer to report to a reviewer instead
 * of to itself, so the request to the implementer stays open while the work
 * is plainly going on elsewhere in the tree. Only when all of it has stopped
 * does an open request mean a stall. A peer that is archived, settled, deleted
 * or outside this browser's list owes nothing here — the user put it down.
 */
export function spawnTreeStall(
  scope: readonly SessionListItem[],
  byId: ReadonlyMap<string, SessionListItem>,
): SpawnTreeStall | undefined {
  const owed = new Map<string, SessionListItem>();
  for (const session of scope)
    for (const id of session.awaitingRepliesFrom ?? []) {
      const peer = byId.get(id);
      // A peer the user put down — archived or settled — owes nothing here.
      if (peer && !peer.archived && !isShelvedSession(peer)) owed.set(id, peer);
    }
  if (owed.size === 0) return undefined;
  const peers = [...owed.values()];
  if ([...scope, ...peers].some((s) => isMoving(s) || waitsOnHuman(s)))
    return undefined;
  peers.sort((a, b) => activityAt(b) - activityAt(a));
  return { peers };
}

/** What a stall chip draws, as a content key. */
function stallKey(stall: SpawnTreeStall): string {
  return stall.peers.map((peer) => `${peer.id}:${peer.title}`).join("\u001f");
}

/**
 * The stall chip's words: the peer that owes the reply, and how many more do.
 * "No reply from «Reviewer»", or "… +2" when several are owed.
 */
export function stallLabel(stall: SpawnTreeStall): string {
  const more = stallMore(stall);
  return `No reply from “${stallTitle(stall)}”${more ? ` ${more}` : ""}`;
}

/** The first owed peer's title, as the chip names it. */
export function stallTitle(stall: SpawnTreeStall): string {
  return stall.peers[0]?.title.trim() || "a peer";
}

/**
 * "+N" for the further peers that owe a reply, or "" — drawn apart from the
 * title so a long title truncates without hiding how many more there are.
 */
export function stallMore(stall: SpawnTreeStall): string {
  const more = stall.peers.length - 1;
  return more > 0 ? `+${more}` : "";
}

/** A top-level card with its tree's stall, if any, lifting its tier. */
function withStall(
  card: SessionInboxCard,
  scope: readonly SessionListItem[],
  byId: ReadonlyMap<string, SessionListItem>,
): SessionInboxCard {
  const stall = spawnTreeStall(scope, byId);
  return stall
    ? { ...card, stall, tier: higherTier(card.tier, "attention") }
    : card;
}

/**
 * Bounded aggregate state of the descendants folded into one cluster card. The
 * cluster STATES its children rather than rendering them: six peers under one
 * coordinator are one row, and what the row has to answer is "how much of this
 * is moving, and how much of it is stuck".
 */
export interface SessionClusterCounts {
  /** Folded descendants, at every depth. */
  total: number;
  /** Descendants running a turn or busy with background work. */
  working: number;
  /** Descendants whose agent is running a turn right now. */
  running: number;
  /**
   * Background jobs (shell commands and monitors) the descendants own, summed
   * over every one of them — jobs, not sessions, so one peer with three
   * commands running counts three.
   */
  jobs: number;
  /** Descendants blocking on a human decision. */
  waiting: number;
  /** Descendants whose last run failed. */
  failed: number;
}

/**
 * The folded half of a cluster card. Deliberately not exported: it is reached
 * as `SessionInboxCard["cluster"]`, so it cannot drift from the card it hangs
 * off.
 */
interface SessionInboxCluster {
  /**
   * Every folded descendant as a TREE in display order: each peer directly
   * under the one that spawned it, at its {@link SessionInboxCard.depth}, and
   * siblings in the order the top-level list uses.
   */
  children: SessionInboxCard[];
  /**
   * The same tree with the coordinator's SETTLED peers put back where they
   * were spawned: what the fold lists when the user asks for its history. A
   * settled peer is in neither the counts nor the Settle cascade — it is on the
   * shelf, and this is only a view of it.
   */
  childrenWithSettled: SessionInboxCard[];
  /** How many settled peers {@link childrenWithSettled} adds. */
  settledCount: number;
  counts: SessionClusterCounts;
  /**
   * The descendant that lifted this cluster's tier: a child waiting on a human
   * or a child holding a failure. Named on the card and reachable from it in one
   * action, so folding can never bury the one thing that needs answering.
   */
  bubbled?: SessionInboxCard;
}

/**
 * The human DECISIONS a folded child lifts its whole cluster for — the same
 * three that override the Settled shelf for a session's own row
 * ({@link isShelvedSession}).
 */
const GATE_STATUSES: ReadonlySet<SessionInboxStatus> = new Set([
  "question",
  "approval",
  "task-choice",
]);

/**
 * Whether this card carries a failure the user has not dealt with — the fourth
 * thing a folded child lifts its cluster for. `failed` covers both the current
 * run's error record and an unacknowledged failed outcome whose error record a
 * later run start cleared.
 */
function holdsFailure(card: SessionInboxCard): boolean {
  return card.status === "failed";
}

/** Whether this folded child lifts its whole cluster. */
function bubbles(card: SessionInboxCard): boolean {
  return GATE_STATUSES.has(card.status) || holdsFailure(card);
}

/**
 * One session as the card it would be on its own: its status, the tier that
 * status (plus background work) puts it in, and why it may not be settled.
 * Every consumer of a card goes through here, so a cluster peer, a Workflow
 * Run's role and the composer ledge's row can never classify the same session
 * differently.
 */
function inboxCard(
  session: SessionListItem,
  readCurrentId: string | undefined,
): SessionInboxCard {
  const classified = classifySessionStatus(session, readCurrentId);
  // A SHELVED session's failure is one the user already acknowledged: the
  // server withholds `settledAt` from a row whose latest outcome is still
  // open, and a new failure unsettles it. Its stored `lastError` outlives the
  // Settle, so a shelved session still listed live — the bridge to live work
  // below it, or a settled coordinator kept up by its peers — must not count
  // or bubble that history as a failure waiting on the user.
  const status =
    classified === "failed" && isShelvedSession(session) ? "quiet" : classified;
  const blocked = settleBlockedReason(session);
  return {
    session,
    status,
    tier: tierForCard(session, status),
    ...(blocked ? { settleBlocked: blocked } : {}),
  };
}

/**
 * What a bounded set of cards is DOING, in the four numbers every fold states:
 * the same aggregate for a spawn cluster, a Workflow Run's roles and the
 * composer's spawned-session ledge, so the three can never count differently.
 */
function clusterCounts(
  cards: readonly SessionInboxCard[],
): SessionClusterCounts {
  return {
    total: cards.length,
    working: cards.filter((card) => card.tier === "working").length,
    running: cards.filter((card) => card.status === "running").length,
    jobs: cards.reduce((sum, card) => sum + backgroundJobs(card.session), 0),
    waiting: cards.filter((card) => card.tier === "needs-you").length,
    failed: cards.filter((card) => holdsFailure(card)).length,
  };
}

/** No sessions, nothing going on: the start of every sum below. */
function zeroCounts(): SessionClusterCounts {
  return { total: 0, working: 0, running: 0, jobs: 0, waiting: 0, failed: 0 };
}

/** `into` plus `add`, field by field, in place. */
function addCounts(
  into: SessionClusterCounts,
  add: SessionClusterCounts,
): SessionClusterCounts {
  into.total += add.total;
  into.working += add.working;
  into.running += add.running;
  into.jobs += add.jobs;
  into.waiting += add.waiting;
  into.failed += add.failed;
  return into;
}

/**
 * Every node's {@link clusterCounts} over its descendants, in ONE bottom-up
 * sweep: `order` lists parents before children, so walking it backwards has
 * every child's total ready before its parent adds it. With unbounded depth,
 * counting each node's subtree separately is quadratic on a long chain, and
 * this runs on every session broadcast. A node with no children has no entry.
 */
function subtreeCounts(
  order: readonly string[],
  childrenOf: (id: string) => readonly string[],
  cardOf: (id: string) => SessionInboxCard | undefined,
): Map<string, SessionClusterCounts> {
  const below = new Map<string, SessionClusterCounts>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index] as string;
    let sum: SessionClusterCounts | undefined;
    for (const childId of childrenOf(id)) {
      const card = cardOf(childId);
      if (!card) continue;
      sum ??= zeroCounts();
      addCounts(sum, clusterCounts([card]));
      const nested = below.get(childId);
      if (nested) addCounts(sum, nested);
    }
    if (sum) below.set(id, sum);
  }
  return below;
}

/**
 * The counts as a content key: EVERY field, including `working`, which no
 * summary sentence says but the spinner and the accent are drawn from.
 */
function clusterCountsKey(counts: SessionClusterCounts): string {
  return [
    counts.total,
    counts.working,
    counts.running,
    counts.jobs,
    counts.waiting,
    counts.failed,
  ].join(",");
}

/** The background jobs one session owns right now; a retained host is none. */
function backgroundJobs(session: SessionListItem): number {
  return Math.max(0, session.backgroundActivity?.activeCount ?? 0);
}

/**
 * The highest-priority card that speaks for a set: one waiting on a human, or
 * one holding a failure. `cards` is expected in {@link compareSessionCards}
 * order, which is what makes the first match the right one.
 */
function firstBubble(
  cards: readonly SessionInboxCard[],
): SessionInboxCard | undefined {
  return cards.find(bubbles);
}

/**
 * One formal Workflow Run in the working set, as ONE top-level item of this
 * browser ([Task-676](pa://task/676)): a live run, or a run that ENDED and has
 * not been settled ([Task-677](pa://task/677)). A run owns coordinator,
 * implementer, reviewer, fixer and verdict sessions; each of those as a card of
 * its own is the flood this item replaces, so the run states them instead
 * ({@link counts}) and every one of them stays reachable from it.
 *
 * Membership is read from the STRUCTURED session ids on the recipe's card
 * projection and from nothing else — never a title, never a role-like word. A
 * run whose recipe has no projection therefore folds nothing: it is still shown
 * from its summary, and its sessions keep their own cards ({@link card}).
 */
export interface WorkflowRunInboxItem {
  kind: "run";
  run: WorkflowRunSummary;
  /**
   * The recipe's projection, when the server could produce one. Absent means
   * "membership is not structurally known", which is why it is also the switch
   * that decides whether anything is folded at all.
   */
  card?: WorkflowRunCard;
  tier: SessionInboxTier;
  /** The run's Task title, once the browser's Task list carries it. */
  taskTitle?: string;
  /** The run's own sessions, folded out of the top level, in inbox order. */
  roles: SessionInboxCard[];
  counts: SessionClusterCounts;
  /**
   * The role session that lifted this item's tier: one waiting on a human or
   * holding a failure. Named on the item and reachable from it in one action —
   * folding may hide how much work is running, never the work that needs
   * answering.
   */
  bubbled?: SessionInboxCard;
  /**
   * Why Settle is unavailable right now; `undefined` means it is allowed. The
   * run's own gate in the shared wording ({@link workflowRunSettleBlockedReason}),
   * else the first role session in inbox order that its own shared predicate
   * blocks — waiting on a human, still running, queued — in that session's
   * wording. The server refuses the whole Settle on the same two answers, so
   * a role that cannot be put down never leaves the run acknowledged without it.
   */
  settleBlocked?: string;
}

/**
 * Whether the item offers Settle at all: only while the run carries an event
 * the user has not acknowledged. An active run with nothing pending is live
 * work, not an outcome — a Settle there would acknowledge nothing and put
 * nothing down, which is a control that cannot complete.
 */
export function workflowRunSettleOffered(item: WorkflowRunInboxItem): boolean {
  return pendingWorkflowRunAttention(item.run.attention) !== undefined;
}

/**
 * One row of the working set: an unsettled session — the ordinary case — or a
 * Workflow Run that is live or unsettled. The two kinds are ordered together in
 * one list, because a run is not a second-class citizen of the inbox: it is the
 * coarser unit of the same attention.
 */
export type SessionInboxItem =
  { kind: "session"; card: SessionInboxCard } | WorkflowRunInboxItem;

/** The item's identity for React keys, layout measurement and focus. */
export function inboxItemId(item: SessionInboxItem): string {
  return item.kind === "run" ? `run:${item.run.id}` : item.card.session.id;
}

export interface SessionInboxView {
  /** Human-blocking work, rendered as its own labelled block. */
  needsYou: SessionInboxItem[];
  /** Everything else still unsettled, one priority-sorted list. */
  active: SessionInboxItem[];
  /** The compact Settled shelf, newest first, already paged. */
  settled: SessionListItem[];
  /** Settled rows beyond the current page cutoff. */
  settledHidden: number;
  /** Every settled row, before paging. */
  settledTotal: number;
  /** True when there is no unsettled work and no settled row to show. */
  empty: boolean;
}

export interface SessionInboxOptions {
  /** The session open in the main pane: never paged out of the settled shelf. */
  currentId?: string;
  /**
   * The open session once it has been open long enough to count as READ (see
   * `classifySessionStatus`). Deliberately separate from `currentId` and NOT
   * defaulted from it: "routed" and "read" are the two ends of the dwell, and
   * collapsing them here is exactly the jump the dwell exists to remove.
   */
  readCurrentId?: string;
  /** How many settled rows the shelf shows. */
  settledLimit?: number;
  /**
   * Every Workflow Run the browser holds. Absent (the topic is not subscribed,
   * or the snapshot has not landed) shapes exactly the inbox this browser
   * always had — no run items, and no session folded away.
   */
  workflowRuns?: readonly WorkflowRunSummary[];
  /** The recipe projections, by run id, exactly as the server broadcasts them. */
  workflowCards?: Readonly<Record<string, WorkflowRunCard>>;
  /**
   * Task titles by Task id, for the run items alone: a run has no title of its
   * own, so the Task it works on is what it is called and what it is found by.
   */
  taskTitles?: ReadonlyMap<string, string>;
}

export const SETTLED_PAGE_SIZE = 10;
export const SETTLED_PAGE_STEP = 25;

/** Failure text is a card line, not a log; the server bounds it too. */
const MAX_CONTEXT_CHARS = 160;

/**
 * The session's status. `currentId` is what you are already looking at, so it
 * can never be "unread" — the dot would only ever describe the screen you are on.
 *
 * It is the session READ through, not simply the routed one: the browser holds
 * this back for `SESSION_READ_DWELL_MS` after you open a card (the same dwell
 * the server holds the durable read mark back for), so clicking an unread card
 * does not re-sort the list out from under the click.
 */
export function classifySessionStatus(
  session: SessionListItem,
  currentId?: string,
): SessionInboxStatus {
  if (session.attention === "approval") return "approval";
  if (session.attention === "task-choice") return "task-choice";
  if (session.attention === "question" || session.awaitingInput)
    return "question";
  if (session.isStreaming) return "running";
  // A real failure outranks a cut turn: one says something broke, the other says
  // work is waiting. Both are `attention`, so this only decides which sentence
  // the card shows.
  if (session.lastError) return "failed";
  // A durable failure must outrank later unread activity and an interrupted
  // turn after a new run has cleared its `lastError` record. Running still wins
  // above: while that newer turn moves, its current state is what the row says.
  if (pendingSessionOutcome(session.outcomeAttention)?.kind === "failed")
    return "failed";
  if (session.interruptedRun) return "interrupted";
  if (session.unread && session.id !== currentId) return "unread";
  // Reading clears the visible successful-completion signal, not the durable
  // settlement cursor. The card becomes quiet but stays in the working set
  // until Settle acknowledges it.
  return "quiet";
}

export function tierForStatus(status: SessionInboxStatus): SessionInboxTier {
  return TIER_BY_STATUS[status];
}

/**
 * Background work may lift an otherwise QUIET card into the working tier — the
 * session really is busy, just not with a turn — and it may do nothing else. It
 * never becomes the card's `status`, so the provider badge, the Working spinner,
 * `isStreaming`, `runStartedAt` and unread are all untouched: keeping the two
 * apart is the whole point of the separate projection.
 */
function tierForCard(
  session: SessionListItem,
  status: SessionInboxStatus,
): SessionInboxTier {
  const tier = tierForStatus(status);
  if (tier !== "active") return tier;
  const activity = session.backgroundActivity;
  return activity && (activity.activeCount > 0 || activity.retainedHost)
    ? "working"
    : tier;
}

/** Semantic color of a status badge; the renderer maps it to the theme tokens. */
export type SessionStatusTone =
  "accent" | "warning" | "danger" | "success" | "muted";

/** The one-or-two-word state marker at the head of the card's second line. */
export interface SessionStatusBadge {
  label: string;
  tone: SessionStatusTone;
}

/**
 * The card's state, as a SHORT and STABLE coloured badge. Elapsed time belongs
 * to the card's separate age item, so a running badge says "Working" without
 * repainting its label every second. A quiet session gets the neutral Idle
 * badge, so every card states its state in the same place.
 */
export function sessionStatusBadge(
  _session: SessionListItem,
  status: SessionInboxStatus,
  _now: number,
): SessionStatusBadge | undefined {
  switch (status) {
    case "question":
      return { label: "Answer", tone: "accent" };
    case "approval":
      return { label: "Approve", tone: "warning" };
    case "task-choice":
      return { label: "Pick task", tone: "accent" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    // `warning`, not `danger`: nothing is broken and nothing needs deciding —
    // a turn was cut and its work is waiting on the next prompt.
    case "interrupted":
      return { label: "Interrupted", tone: "warning" };
    case "running":
      return { label: "Working", tone: "accent" };
    case "unread":
      return { label: "Done", tone: "success" };
    // Neutral: done and read, nothing is waiting on you.
    case "quiet":
      return { label: "Idle", tone: "muted" };
  }
}

/**
 * The rest of that line: what the badge cannot say. The failure MESSAGE is the
 * reason this line still exists — it is the one thing a card must show without
 * being opened. A quiet session says NOTHING here unless it holds queued work:
 * "Waiting for your next prompt" was the line on nine cards in ten, a sentence
 * that restated the absence the missing badge already stated, and it cost a
 * whole line on every one of them. A quiet card with nothing to say has no
 * second line at all.
 */
export function sessionStatusDetail(
  session: SessionListItem,
  status: SessionInboxStatus,
): string | undefined {
  switch (status) {
    case "question":
      return "Waiting for your answer";
    case "approval":
      return "Waiting for your approval";
    case "task-choice":
      return "Waiting for you to pick a Task for the pull request";
    case "failed":
      return bounded(session.lastError?.message ?? "The last run failed.");
    case "interrupted":
      return "Cut off by a restart — send a prompt to continue";
    case "running":
      return undefined;
    case "unread":
      return "Unread response";
    case "quiet":
      return session.queuedWork ? "Queued work is waiting to run" : undefined;
  }
}

/**
 * The cluster's own line: what this card's peers are doing, as ONE bounded
 * sentence ("5 sessions · 2 running · 3 jobs · 1 waiting"). A count that is zero is left
 * out rather than shown as a zero — the line is read at a glance, and "0 failed"
 * is a word that means nothing happened.
 *
 * It states no VERB. The line sits under a coordinator's own title inside its
 * own card, behind the peer glyph, so "Coordinating" was the one word on it the
 * user already had; the counts are what the line is read for. The spoken label
 * still says it, since a screen reader has no card to read it from.
 */
export function sessionClusterSummary(counts: SessionClusterCounts): string {
  return [
    `${counts.total} session${counts.total === 1 ? "" : "s"}`,
    ...clusterActivityParts(counts),
  ].join(" · ");
}

/**
 * What a fold's sessions are doing right now, as the short facts every fold
 * states after its count: agents running a turn, background jobs, sessions
 * waiting on the user, failures. A zero is left out rather than shown as a
 * zero. Turns and jobs are separate facts on purpose — "an agent is busy" and
 * "a job is still going" are different answers to whether to wait.
 */
function clusterActivityParts(counts: SessionClusterCounts): string[] {
  const parts = clusterLiveParts(counts);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return parts;
}

/**
 * The live half of {@link sessionClusterSummary} that a card shows on its
 * status line next to the count: running turns and background jobs, or an
 * empty string while neither is going. Waiting and failed are left to the
 * bubbled peer's own named badge, which says which session it is.
 */
export function clusterLiveSummary(counts: SessionClusterCounts): string {
  return clusterLiveParts(counts).join(" · ");
}

function clusterLiveParts(counts: SessionClusterCounts): string[] {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.jobs > 0)
    parts.push(`${counts.jobs} job${counts.jobs === 1 ? "" : "s"}`);
  // Busy with neither a turn nor a job — a retained background host — still
  // spins the fold, so the words must say why.
  if (parts.length === 0 && counts.working > 0)
    parts.push(`${counts.working} working`);
  return parts;
}

/**
 * What the bubbled child needs, NAMING it: the same verb its own card would
 * show ("Answer", "Approve", "Pick task", "Failed") plus the child's title, so
 * the cluster says which session is waiting rather than that one of them is.
 */
export function sessionClusterBubbleLabel(
  child: SessionInboxCard,
  now: number,
): string {
  const badge = sessionStatusBadge(child.session, child.status, now);
  const title = child.session.title.trim() || "Untitled session";
  return `${badge?.label ?? "Open"} in “${title}”`;
}

/**
 * Whether the bubbled peer can be put down from the CLUSTER's card — a failure
 * the user has moved on from, dismissed where it is shown rather than by
 * hunting for the peer it belongs to. Dismissing is that peer's own Settle: it
 * acknowledges the failure and takes the peer to the Settled shelf, and the
 * bubble goes with it, while the coordinator stays in the working set.
 *
 * Only a FAILURE. A peer waiting on a human is the other half of the bubble and
 * has no dismissal: settling it is refused by the same rule everywhere
 * ({@link settleBlockedReason}), because the work cannot proceed without the
 * answer — that bubble is dealt with by opening it. A failure whose peer is
 * blocked for another reason (queued work, background work of its own) is not
 * offered either, for exactly the same reason.
 */
export function clusterBubbleDismissible(bubbled: SessionInboxCard): boolean {
  return holdsFailure(bubbled) && bubbled.settleBlocked === undefined;
}

/* --------------------------- formal Workflow Runs -------------------------- */

/**
 * The code-delivery recipe's phase, in the user's words. One vocabulary for the
 * full Workflow card on the Task and for the inbox item that leads to it: two
 * lists would drift, and the run would then be called one thing where it is
 * found and another where it is opened.
 */
export const WORKFLOW_PHASE_LABEL: Record<WorkflowRunPhase, string> = {
  starting: "Starting",
  plan: "Planning",
  implement: "Implementation",
  "commit-sync": "Commit and sync",
  commit: "Commit",
  "base-sync": "Base sync",
  ci: "Push and CI",
  review: "Review",
  "review-decision": "Review decision",
  "ceiling-decision": "Your decision",
  delivery: "Delivery",
  observe: "CI and pull request",
  merge: "Merge decision",
};

/**
 * What the run item is CALLED: the Task it works on. A run has no title of its
 * own — it is one attempt at a piece of the user's work — so the Task is both
 * its name and its destination, and the id alone stands in until the Task list
 * carries the title.
 */
export function workflowRunTitle(item: WorkflowRunInboxItem): string {
  return item.taskTitle?.trim() || `Task ${item.run.taskId}`;
}

/**
 * The run's state as the same short coloured badge a session card carries, so
 * the two kinds of item are read the same way. A run that stopped says so; a
 * gate it stopped AT says what it wants instead, because "Paused" over a
 * ceiling decision describes the machine rather than the ask. A run that ENDED
 * states its outcome: merged where the recipe's card carries the pull request
 * it completed from, otherwise simply completed, or cancelled.
 */
export type WorkflowRunBadgeKind =
  | "merged"
  | "completed"
  | "cancelled"
  | "cancelling"
  | "decide"
  | "merge-decision"
  | "paused"
  | "working"
  | "active";

/** A run badge carries its kind, so the renderer picks its glyph without reading the label. */
export interface WorkflowRunBadge extends SessionStatusBadge {
  kind: WorkflowRunBadgeKind;
}

export function workflowRunBadge(item: WorkflowRunInboxItem): WorkflowRunBadge {
  const { run, card } = item;
  if (run.lifecycle === "completed")
    return card?.pullRequest
      ? { kind: "merged", label: "Merged", tone: "success" }
      : { kind: "completed", label: "Completed", tone: "success" };
  if (run.lifecycle === "cancelled")
    return { kind: "cancelled", label: "Cancelled", tone: "warning" };
  // The user already ended this run, so nothing it could still say is an ask.
  if (card?.cancelRequested)
    return { kind: "cancelling", label: "Cancelling", tone: "warning" };
  if (run.lifecycle === "paused")
    return card?.ceilingDecision
      ? { kind: "decide", label: "Decide", tone: "accent" }
      : card?.mergeDecisionReady
        ? { kind: "merge-decision", label: "Merge?", tone: "accent" }
        : { kind: "paused", label: "Paused", tone: "warning" };
  return card?.activity === "running"
    ? { kind: "working", label: "Working", tone: "accent" }
    : { kind: "active", label: "Active", tone: "accent" };
}

/**
 * The rest of that line: the one sentence a paused run has to show without
 * being opened. A pause always carries a reason (the store refuses a blank
 * one), and an active run says what it will do NEXT instead — never a step it
 * will not take, which is why the pause reason wins wherever both exist.
 */
export function workflowRunDetail(
  item: WorkflowRunInboxItem,
): string | undefined {
  const { run, card } = item;
  // An ended run has one sentence left: its reason where it has one (a
  // cancellation may carry the user's), else what it came to.
  if (run.lifecycle === "completed")
    return bounded(
      run.lifecycleReason ||
        (card?.pullRequest
          ? `Pull request #${card.pullRequest.number} merged.`
          : "Run complete."),
    );
  if (run.lifecycle === "cancelled")
    return bounded(run.lifecycleReason || "Cancelled at your request.");
  if (run.lifecycle === "paused")
    return bounded(run.lifecycleReason || card?.nextAction || "Paused.");
  if (card?.nextAction.trim()) return bounded(card.nextAction);
  // A run with no projection states its lifecycle and nothing it cannot know.
  return card ? undefined : "Running";
}

/**
 * The run's phase line: which phase it is in and whether that phase is moving.
 * Absent without a projection, for the same reason.
 */
export function workflowRunPhaseLine(
  item: WorkflowRunInboxItem,
): string | undefined {
  const { card, run } = item;
  if (!card) return undefined;
  // An ended run has no step moving, whatever an open step row still says.
  if (isTerminalWorkflowRunLifecycle(run.lifecycle))
    return WORKFLOW_PHASE_LABEL[card.phase];
  const activity =
    card.activity === "running"
      ? "working"
      : card.activity === "waiting"
        ? "waiting to start"
        : undefined;
  return activity
    ? `${WORKFLOW_PHASE_LABEL[card.phase]} — ${activity}`
    : WORKFLOW_PHASE_LABEL[card.phase];
}

/**
 * The run's session line: how many of its own sessions it carries and how much
 * of that is moving or stuck. Same shape as {@link sessionClusterSummary} and
 * the same rule — a zero is left out rather than shown as a zero.
 */
export function workflowRunRolesSummary(counts: SessionClusterCounts): string {
  return [
    `${counts.total} workflow session${counts.total === 1 ? "" : "s"}`,
    ...clusterActivityParts(counts),
  ].join(" · ");
}

/** The run's state in words, for an assistive-technology label. */
export function workflowRunStatusText(item: WorkflowRunInboxItem): string {
  return [
    workflowRunBadge(item).label,
    workflowRunPhaseLine(item),
    workflowRunDetail(item),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The role session that owns the run's pull-request card, when the run folded
 * it: its list row carries the live CI and review state the run's own card
 * projection does not.
 */
export function workflowRunPullRequestSession(
  item: WorkflowRunInboxItem,
): SessionListItem | undefined {
  const sessionId = item.card?.pullRequest?.sessionId;
  if (!sessionId) return undefined;
  const role = item.roles.find((card) => card.session.id === sessionId);
  return role?.session.pullRequest ? role.session : undefined;
}

/**
 * The run item's memo identity, on the same contract as {@link sessionCardKey}:
 * the item is rebuilt from scratch on every session AND every workflow
 * broadcast, so it can only memoize on CONTENT — and a field this key omits
 * silently stops updating on the card.
 */
export function workflowRunItemKey(
  item: WorkflowRunInboxItem,
  now: number,
): string {
  const badge = workflowRunBadge(item);
  return [
    item.run.id,
    item.run.taskId,
    workflowRunTitle(item),
    item.run.lifecycle,
    item.run.branch ?? "",
    item.tier,
    `${badge.tone}:${badge.label}`,
    workflowRunPhaseLine(item) ?? "",
    workflowRunDetail(item) ?? "",
    clusterCountsKey(item.counts),
    item.card?.phase ?? "",
    sessionDeliveryKey(workflowRunPullRequestSession(item) ?? {}),
    // Settle is drawn from these three: whether it is offered, whether it is
    // disabled and why, and which revision a click would acknowledge.
    workflowRunSettleOffered(item) ? "1" : "",
    item.settleBlocked ?? "",
    String(item.run.attention?.revision ?? 0),
    // The RENDERED age, not the timestamp: the item shows a label, and a memo
    // that ignores it freezes it at whatever it read on first render.
    relativeAge(item.run.updatedAt, now),
    item.bubbled
      ? `${item.bubbled.session.id}:${sessionClusterBubbleLabel(
          item.bubbled,
          now,
        )}`
      : "",
  ].join("\u0000");
}

/**
 * `memo` comparator for a run item, matching {@link sameSessionCardProps}:
 * every prop by identity except the item itself and the shared ticker it is
 * read with. The exposed role rows carry their own keys, so they are not on
 * this one.
 */
export function sameWorkflowRunItemProps<
  P extends { item: WorkflowRunInboxItem; now: number },
>(prev: P, next: P): boolean {
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    if (key === "item" || key === "now") continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return (
    workflowRunItemKey(prev.item, prev.now) ===
    workflowRunItemKey(next.item, next.now)
  );
}

/**
 * What the session's worktree holds that its base does not, as one sentence:
 * the tooltip and accessible name of the card's diff signal, and a clause of
 * the card's own label. `undefined` when there is nothing to state.
 */
export function worktreeChangesText(
  relations: SessionCardRelations,
): string | undefined {
  const additions = relations.worktreeAdditions ?? 0;
  const deletions = relations.worktreeDeletions ?? 0;
  const ahead = relations.worktreeAhead ?? 0;
  const parts: string[] = [];
  if (additions || deletions)
    parts.push(`${additions} lines added, ${deletions} removed, uncommitted`);
  if (ahead)
    parts.push(`${ahead} commit${ahead === 1 ? "" : "s"} ahead of base`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The card's time label. A running session's `updatedAt` is always "now", so
 * while it runs the label says how long the run has taken instead, at minute
 * resolution so it does not repaint every second.
 */
export function sessionCardAge(
  session: SessionListItem,
  status: SessionInboxStatus,
  now: number,
): { label: string; title: string } {
  if (status === "running" && session.runStartedAt) {
    const ms = now - session.runStartedAt;
    if (ms < 60_000) return { label: "now", title: "Started just now" };
    const minuteMs = ms - (ms % 60_000);
    const label = `for ${elapsedLabel(minuteMs)}`;
    return { label, title: `Running ${label}` };
  }
  const label = relativeAge(session.updatedAt, now);
  return {
    label,
    title: label === "now" ? "Updated just now" : `Updated ${label} ago`,
  };
}

/** The state in words, for an assistive-technology label. */
export function sessionStatusText(
  session: SessionListItem,
  status: SessionInboxStatus,
  now: number,
): string {
  const badge = sessionStatusBadge(session, status, now);
  const detail = sessionStatusDetail(session, status);
  return [badge?.label, detail].filter(Boolean).join(" · ") || "Active";
}

/**
 * Ordering: tier first, then latest meaningful activity, then a stable id
 * tie-break. A card therefore MOVES when its state changes — which is
 * meaningful — instead of churning on every recency update.
 */
function compareSessionCards(a: SessionInboxCard, b: SessionInboxCard): number {
  const tier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (tier !== 0) return tier;
  return compareSessionActivity(a, b);
}

/** Latest activity first, ties broken by id so the order is stable. */
function compareSessionActivity(
  a: SessionInboxCard,
  b: SessionInboxCard,
): number {
  const activity = activityAt(b.session) - activityAt(a.session);
  if (activity !== 0) return activity;
  return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
}

/** Relations resolved by the browser's central Project/Worktree/Task joins. */
export interface SessionCardRelations {
  /** The RESOLVED Project id (the session's own, else its worktree's). */
  projectId?: string;
  /** Short Project key ("PA"), which is what the card shows. */
  projectKey?: string;
  /** Full Project name, for the item's title/tooltip only. */
  projectName?: string;
  /** The Project's registry/derived color, for the item's glyph. */
  projectColor?: string;
  worktreeBranch?: string;
  /** The ONE Task this session belongs to, when exactly one is identifiable. */
  taskId?: string;
  /** That Task's title, for the item's tooltip and label. */
  taskTitle?: string;
  /** Title of the session this one was forked from, when it is still listed. */
  forkedFromTitle?: string;
  /** Uncommitted line changes in the session's worktree. */
  worktreeAdditions?: number;
  worktreeDeletions?: number;
  /** Commits the worktree branch is ahead of its base. */
  worktreeAhead?: number;
}

/** Which relation an item stands for; the renderer keys its glyph on this. */
export type SessionCardMetaKind = "project" | "worktree" | "task" | "fork";

/** One third-line item: the visible label plus what the renderer needs to mark it. */
export interface SessionCardMetaItem {
  kind: SessionCardMetaKind;
  label: string;
  /** Longer text for the item's tooltip, when the label is an abbreviation. */
  title?: string;
  /** Glyph color for the `project` kind; every other kind inherits the row's. */
  color?: string;
  /** The `worktree` kind's edge points at a worktree that is gone (Task 321). */
  missing?: boolean;
}

/**
 * The card's third line, in TRUNCATION PRIORITY order: Project, Worktree, the
 * Task, then fork lineage. The renderer clips from the right, so this
 * order is what survives a narrow sidebar. Every item NAMES an object the
 * session hangs off, which is why the model and the Task progress counter are
 * gone: they were the only two items that stood for nothing, and they cost the
 * line's width. Naming is all a Worktree or Task item does: each has a fixed
 * jump button on the card, and a text link beside a button for the same object
 * was two targets one item apart. The Project item is the one that still opens
 * its object, because it has no button and, first on the line, never clips. The
 * Task is its ID (`#227`) rather than its title for the same reason as the
 * clipping order: the title is already the tooltip, and a long one used to eat
 * the whole line. The PERSONA is deliberately absent too — the card's leading
 * icon is the agent's own icon, so naming it again is duplication. Lineage is
 * METADATA here: the inbox is flat, and the compact fork trees stay in the
 * Project/Worktree relation browsers.
 */
export function sessionCardMeta(
  session: SessionListItem,
  relations: SessionCardRelations = {},
): SessionCardMetaItem[] {
  const items: SessionCardMetaItem[] = [];
  if (relations.projectKey) {
    items.push({
      kind: "project",
      label: relations.projectKey,
      ...(relations.projectName ? { title: relations.projectName } : {}),
      ...(relations.projectColor ? { color: relations.projectColor } : {}),
    });
  }
  if (relations.worktreeBranch) {
    items.push({
      kind: "worktree",
      label: relations.worktreeBranch,
      ...(session.worktreeMissing
        ? {
            missing: true,
            title: `${relations.worktreeBranch} — worktree removed`,
          }
        : {}),
    });
  }
  if (relations.taskId) {
    items.push({
      kind: "task",
      label: `#${relations.taskId}`,
      title: relations.taskTitle ?? `Task ${relations.taskId}`,
    });
  }
  if (session.forkOrigin && relations.forkedFromTitle) {
    items.push({
      kind: "fork",
      label: `Forked from ${relations.forkedFromTitle}`,
    });
  }
  return items;
}

/**
 * The card's memo identity. Same contract as `sessionRows.ts` and
 * `worktreeInbox.ts`, and the same invisible failure: the session list is
 * rebroadcast up to ~4x/second while any agent streams and every broadcast
 * hands back brand-new row objects, so a card can only memoize on CONTENT — and
 * a card that reads a field this key omits silently stops updating.
 *
 * The shared ticker is folded in the same way: rendered labels are on the key
 * rather than `now`, so a tick only re-renders a card when its visible age or
 * another genuinely time-based item changes. The Working badge itself is
 * deliberately static.
 *
 * `relations` is keyed separately by {@link sessionRelationsKey}, since it is
 * resolved by the browser rather than carried on the row.
 *
 * The separator is NUL, matching `sessionRows.ts` (which joins on a raw U+0000
 * and separates its progress counts with U+001F) rather than `worktreeInbox.ts`
 * (`|`). These keys fold in free text — a title, a failure message, a Task
 * title — and a field able to forge a boundary would make two different cards
 * share a key, which fails the silent way: the card simply stops updating. It
 * is written here as the `\u0000` ESCAPE, not as a raw control byte: a raw one
 * reads as whitespace in an editor and makes the file binary to `grep`/`rg`,
 * which is exactly how its use in `sessionRows.ts` gets misread.
 */
export function sessionCardKey(card: SessionInboxCard, now: number): string {
  const { session, status } = card;
  const badge = sessionStatusBadge(session, status, now);
  return [
    session.id,
    session.title,
    session.titleGenerationPending ? "1" : "",
    session.harness ?? "",
    session.agentType ?? "",
    session.archived ? "1" : "",
    session.worktreeId ?? "",
    session.worktreeMissing ? "1" : "",
    session.forkOrigin ? "1" : "",
    status,
    card.settleBlocked ?? "",
    // The RENDERED age, not the timestamp: the card shows a label, and a memo
    // that ignores it freezes every age at whatever it read on first render.
    sessionCardAge(session, status, now).label,
    badge ? `${badge.tone}:${badge.label}` : "",
    // Derived, so key on it directly rather than enumerating every input it
    // might grow.
    sessionStatusDetail(session, status) ?? "",
    // The delivery chip, for the same reason: its state moves on a CI poll,
    // which touches nothing else on this key.
    sessionDeliveryKey(session),
    // The background chip. Separate from every provider field above it, and on
    // the key for the same reason as the badge: it carries a rendered elapsed
    // label that ticks while nothing else about the session moves.
    backgroundActivityKey(session.backgroundActivity, now),
    card.tier,
    // The cluster as the CARD states it: every count it draws from (the
    // summary, the spinner, the live icons) and the bubbled child's own
    // label. A folded child that starts asking repaints the card it is folded
    // into; one that renames itself under a collapsed summary does not,
    // because nothing on the card would read differently — the expanded child
    // rows carry their own keys.
    card.cluster ? clusterCountsKey(card.cluster.counts) : "",
    // The settled-history toggle's count, which the open fold states.
    card.cluster ? String(card.cluster.settledCount) : "",
    // The stall chip: which peers it names, by what they are called.
    card.stall ? stallKey(card.stall) : "",
    // A tree row's place and its own peers, which the row draws.
    String(card.depth ?? ""),
    card.peers ? clusterCountsKey(card.peers) : "",
    card.cluster?.bubbled
      ? `${card.cluster.bubbled.session.id}:${sessionClusterBubbleLabel(
          card.cluster.bubbled,
          now,
        )}:${clusterBubbleDismissible(card.cluster.bubbled) ? "1" : ""}`
      : "",
  ].join("\u0000");
}

/** The browser-resolved half of a card's identity; see {@link sessionCardKey}. */
export function sessionRelationsKey(relations: SessionCardRelations): string {
  return [
    relations.projectId ?? "",
    relations.projectKey ?? "",
    relations.projectName ?? "",
    relations.projectColor ?? "",
    relations.worktreeBranch ?? "",
    relations.taskId ?? "",
    relations.taskTitle ?? "",
    relations.forkedFromTitle ?? "",
    relations.worktreeAdditions ?? "",
    relations.worktreeDeletions ?? "",
    relations.worktreeAhead ?? "",
  ].join("\u0000");
}

/**
 * `memo` comparator for an inbox card: every prop by identity, except the two
 * that are rebuilt from scratch on every broadcast plus the shared ticker they
 * are read with — those go through {@link sessionCardKey} and
 * {@link sessionRelationsKey}.
 *
 * Enumerating the props rather than listing them keeps a newly added prop
 * covered by default — the safe direction, since a missed prop would silently
 * freeze the card. Same shape as `sameSessionRowProps`, deliberately: one
 * contract with two behaviours is how the two drift apart.
 */
export function sameSessionCardProps<
  P extends {
    card: SessionInboxCard;
    relations: SessionCardRelations;
    now: number;
  },
>(prev: P, next: P): boolean {
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    if (key === "card" || key === "relations" || key === "now") continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return (
    sessionCardKey(prev.card, prev.now) ===
      sessionCardKey(next.card, next.now) &&
    sessionRelationsKey(prev.relations) === sessionRelationsKey(next.relations)
  );
}

/**
 * The same contract for the compact row an EXPANDED cluster child is rendered
 * as: it shows no relations, so it keys on the card alone — plus the one fact
 * the row draws that the card does not: its age off `updatedAt`. A card keys a
 * RUNNING session's elapsed run instead, so a peer still running whose
 * `updatedAt` moved would otherwise keep a stale age. Separate from
 * {@link sameSessionCardProps} rather than sharing its body, deliberately —
 * one comparator serving two prop shapes is how a prop stops being compared.
 */
export function sameClusterChildProps<
  P extends { card: SessionInboxCard; now: number },
>(prev: P, next: P): boolean {
  const keys = Object.keys(prev);
  if (keys.length !== Object.keys(next).length) return false;
  for (const key of keys) {
    if (key === "card" || key === "now") continue;
    if (!Object.is(prev[key as keyof P], next[key as keyof P])) return false;
  }
  return (
    sessionCardKey(prev.card, prev.now) ===
      sessionCardKey(next.card, next.now) &&
    relativeAge(prev.card.session.updatedAt, prev.now) ===
      relativeAge(next.card.session.updatedAt, next.now)
  );
}

/** One card that has to travel back to where it was before playing forward. */
export interface SessionCardMove {
  id: string;
  /** The `translateY` the card starts from, in px. */
  from: number;
}

/**
 * The reorder pass's DECISION, split out from the DOM work so it can be tested
 * without layout: given where the cards were and where they now are, which ones
 * moved and by how much, plus the baseline to compare the next pass against.
 *
 * A card with no previous position ARRIVES rather than moves — there is no
 * honest "from" for it, so it simply appears in place — and a card that is gone
 * is dropped from the baseline rather than remembered at a stale position.
 * Sub-pixel differences are not movement.
 */
export function planCardReorder(
  previous: ReadonlyMap<string, number>,
  measured: ReadonlyArray<{ id: string; top: number }>,
): { moves: SessionCardMove[]; next: Map<string, number> } {
  const moves: SessionCardMove[] = [];
  const next = new Map<string, number>();
  for (const { id, top } of measured) {
    next.set(id, top);
    const was = previous.get(id);
    if (was === undefined || Math.abs(was - top) < 1) continue;
    moves.push({ id, from: was - top });
  }
  return { moves, next };
}

/**
 * What a Settle on `id` does beyond `id` itself, for the surfaces that hold no
 * built inbox: the peers it shelves ({@link spawnClusterDescendantIds}) and why
 * it is refused ({@link spawnClusterSettleBlockedReason}), read off the same
 * list, runs and cards the inbox folds — so the optimistic settle shelves what
 * the card folded, and the inspector's Settle is disabled for the reason the
 * card's is. One forest per call; a Settle is a click, not a render loop.
 */
export function sessionSettleCascade(
  id: string,
  sessions: readonly SessionListItem[],
  workflowRuns: readonly WorkflowRunSummary[] | null | undefined,
  workflowCards: Readonly<Record<string, WorkflowRunCard>>,
): { peerIds: string[]; blocked?: string } {
  const members = spawnClusterMembers(
    sessions,
    workflowRuns ?? [],
    workflowCards,
  );
  const forest = spawnClusterForest(members);
  const blocked = spawnClusterSettleBlockedReason(
    id,
    new Map(sessions.map((session) => [session.id, session])),
    forest,
  );
  return {
    peerIds: spawnClusterDescendantIds(id, forest),
    ...(blocked ? { blocked } : {}),
  };
}

/**
 * Shape the whole browser: unarchived sessions become cards or settled rows,
 * and the currently routed session stays visible even when it falls outside the
 * settled page (a deep link must never land on a surface with no selected row).
 *
 * The cards are FOLDED along the durable spawn edges (see
 * {@link foldSpawnClusters}) — a coordinator and the peers it still owns are one
 * top-level item, not six. A spawner that is archived or gone is a different
 * case: there is nothing to fold into, so its child stands on its own.
 *
 * A formal Workflow Run in the working set ({@link workflowRunInWorkingSet}) —
 * live, or ended and not yet settled — is the second kind of item, and it is
 * taken out FIRST: the sessions its recipe projection names are the run's, so
 * they are never a card, a cluster or a shelf row of their own while the run
 * is an item — they are stated by the run and reachable from it, across its
 * terminal boundary. That fold is structural or it does not happen: a run whose
 * projection is absent or unsupported folds nothing, and its sessions stay
 * exactly the items they were, because an item this browser cannot describe
 * must never be an item that disappears. A run that is SETTLED folds nothing
 * either: it and its sessions are released to what they would be on their own.
 */
export function buildSessionInbox(
  sessions: SessionListItem[],
  options: SessionInboxOptions = {},
): SessionInboxView {
  const limit = options.settledLimit ?? SETTLED_PAGE_SIZE;
  const needsYou: SessionInboxItem[] = [];
  const active: SessionInboxItem[] = [];
  const settledRows: SessionListItem[] = [];

  const runCards = options.workflowCards ?? {};
  const runs = (options.workflowRuns ?? []).filter((run) =>
    workflowRunInWorkingSet(run, runCards[run.id]),
  );
  const runByRoleSession = workflowRunOwnerBySession(runs, runCards);

  const nodes = new Map<string, ClusterNode>();
  /** Role cards by run id, kept out of the forest the clusters are folded from. */
  const roleCards = new Map<string, SessionInboxCard[]>();
  for (const session of sessions) {
    if (session.archived) continue;
    const card = inboxCard(session, options.readCurrentId);
    const runId = runByRoleSession.get(session.id);
    if (runId !== undefined) {
      // A run's own session belongs to the run, wherever it would otherwise
      // have landed — a card, a cluster, or the Settled shelf.
      const existing = roleCards.get(runId);
      if (existing) existing.push(card);
      else roleCards.set(runId, [card]);
      continue;
    }
    nodes.set(session.id, { card, settled: isShelvedSession(session) });
  }

  for (const card of foldSpawnClusters(
    nodes,
    settledRows,
    new Map(sessions.map((session) => [session.id, session])),
  )) {
    const item: SessionInboxItem = { kind: "session", card };
    if (card.tier === "needs-you") needsYou.push(item);
    else active.push(item);
  }
  for (const run of runs) {
    const item = workflowRunItem(
      run,
      runCards[run.id],
      roleCards.get(run.id) ?? [],
      options.taskTitles?.get(run.taskId),
    );
    if (item.tier === "needs-you") needsYou.push(item);
    else active.push(item);
  }

  needsYou.sort(compareInboxItems);
  active.sort(compareInboxItems);
  settledRows.sort(
    (a, b) => (b.settledAt ?? b.updatedAt) - (a.settledAt ?? a.updatedAt),
  );

  const settled = settledRows.slice(0, Math.max(0, limit));
  // A directly routed settled session stays reachable regardless of the cutoff.
  if (
    options.currentId &&
    !settled.some((session) => session.id === options.currentId)
  ) {
    const routed = settledRows.find(
      (session) => session.id === options.currentId,
    );
    if (routed) settled.push(routed);
  }

  return {
    needsYou,
    active,
    settled,
    settledHidden: Math.max(0, settledRows.length - settled.length),
    settledTotal: settledRows.length,
    empty:
      needsYou.length === 0 && active.length === 0 && settledRows.length === 0,
  };
}

/* ------------------------ the spawned-session ledge ------------------------ */

/** The peers one session spawned, as the composer's ledge states them. */
export interface SpawnedSessionsView {
  /**
   * The peers as a TREE, depth-first, each under the session that spawned it,
   * siblings by latest activity, newest first. Live peers always (a settled
   * peer running or holding jobs again is live); dormant history only when
   * the view was asked to include it, after its live siblings.
   */
  rows: SessionInboxCard[];
  /** Over every LIVE peer at every depth, whether or not history is shown. */
  counts: SessionClusterCounts;
  /** Dormant peers in the tree: the history `includeSettled` lists. */
  settled: number;
  /** Whether {@link rows} includes that history. */
  settledShown: boolean;
  /**
   * The chat's tree is stalled — nothing in it moving, a reply still owed
   * ({@link spawnTreeStall}) — and on whom.
   */
  stall?: SpawnTreeStall;
  /**
   * The peer that speaks for the set — one waiting on a human, or one holding
   * a failure. Named on the collapsed line for the same reason a cluster card
   * names it: a summary may hide how much is running, never what needs
   * answering.
   */
  bubbled?: SessionInboxCard;
}

/**
 * Every peer ONE session spawned, at every depth, shaped for the composer's
 * ledge.
 *
 * Membership is the durable spawn edge (`spawnedBySessionId`) and nothing else
 * — no title, no role word. Unlike the inbox's fold it does NOT filter on
 * ownership: the question the ledge answers is "what did this chat start",
 * which a peer the user has since taken over is still an answer to, and so is
 * whatever that peer started in turn. Archived peers are out, because the user
 * put them away; a spawn cycle is walked once.
 *
 * The tree splits into LIVE peers and DORMANT history, on the forest's own
 * predicate ({@link isDormantInSpawnTree}). Live is every peer not put down,
 * a settled peer running a turn or holding background jobs again, and a
 * dormant peer that live work hangs below (the branch it hangs from) — listed
 * and counted always. Dormant history is listed only when `includeSettled`
 * asks for it, and never counted: that flag adds rows, not numbers.
 *
 * Every row is the card that session would be on its own ({@link inboxCard}),
 * so the ledge, the inbox and the cluster fold state the same session
 * identically. The ORDER is not the inbox's: siblings are listed by latest
 * activity alone, newest first, because the ledge is read as "what just
 * happened among my peers", and the tiering the inbox sorts by is already
 * stated on this strip's collapsed line — as the counts, and as the bubbled
 * peer, which is still picked in tier order so the one that needs answering
 * is named whatever it last did.
 */
export function spawnedSessionsView(options: {
  sessions: readonly SessionListItem[];
  /** The session whose ledge this is. */
  coordinatorId: string;
  /** List the settled peers in the tree too. */
  includeSettled?: boolean;
  /**
   * The Workflow Runs the inbox folds, so a peer's Settle is refused for
   * exactly the reason the inbox and the server would refuse it.
   */
  workflowRuns?: readonly WorkflowRunSummary[] | null;
  workflowCards?: Readonly<Record<string, WorkflowRunCard>>;
}): SpawnedSessionsView {
  const { sessions, coordinatorId } = options;
  const includeSettled = Boolean(options.includeSettled);
  const spawned = new Map<string, SessionListItem[]>();
  for (const session of sessions) {
    const parentId = session.spawnedBySessionId;
    if (session.archived || !parentId || parentId === session.id) continue;
    const siblings = spawned.get(parentId);
    if (siblings) siblings.push(session);
    else spawned.set(parentId, [session]);
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  // The runs the inbox shows as items: a session one of them owns is that
  // run's, so it raises no stall of its own, exactly as it has no card.
  const runCards = options.workflowCards ?? {};
  const runs = (options.workflowRuns ?? []).filter((run) =>
    workflowRunInWorkingSet(run, runCards[run.id]),
  );
  const ownedByRun = workflowRunOwnerBySession(runs, runCards).has(
    coordinatorId,
  );
  const coordinator = ownedByRun ? undefined : byId.get(coordinatorId);

  // Almost every session on screen spawned nothing: answer that before
  // building the forest this view otherwise reads on every broadcast. Such a
  // chat may still be owed a reply — `session_send_prompt` asks existing
  // sessions too — so its stall is read over the chat alone.
  if (!spawned.has(coordinatorId)) {
    const stall = coordinator ? spawnTreeStall([coordinator], byId) : undefined;
    return {
      rows: [],
      counts: zeroCounts(),
      settled: 0,
      settledShown: includeSettled,
      ...(stall ? { stall } : {}),
    };
  }

  // A peer's Settle settles what the INBOX folds under it — coordinator-owned
  // peers at every depth, along the shared forest — not this strip's
  // ownership-blind tree. So the refusal each card carries (and with it
  // whether a bubbled failure is dismissible) is the forest's, read for every
  // member in one sweep; a session the forest does not hold answers alone.
  const members = spawnClusterMembers(sessions, runs, runCards);
  const forest = spawnClusterForest(members);
  const reasons = spawnClusterSettleBlockedReasons(byId, forest);
  const memberIds = new Set(members.map((session) => session.id));
  const peerCard = (session: SessionListItem): SessionInboxCard => {
    // No `readCurrentId`: the ledge belongs to the session on screen, and a
    // peer of it is by definition not the session being read.
    const card = inboxCard(session, undefined);
    if (!memberIds.has(session.id)) return card;
    const { settleBlocked: _own, ...rest } = card;
    const blocked = reasons.get(session.id);
    return { ...rest, ...(blocked ? { settleBlocked: blocked } : {}) };
  };
  // Breadth-first from the coordinator: each peer is reached once, through
  // the first spawner that leads to it, so a cycle cannot list it twice.
  const cards = new Map<string, SessionInboxCard>();
  const treeChildren = new Map<string, string[]>();
  const order: string[] = [];
  const queue = [coordinatorId];
  const seen = new Set([coordinatorId]);
  for (let head = 0; head < queue.length; head += 1) {
    const parentId = queue[head] as string;
    for (const session of spawned.get(parentId) ?? []) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      cards.set(session.id, peerCard(session));
      const siblings = treeChildren.get(parentId);
      if (siblings) siblings.push(session.id);
      else treeChildren.set(parentId, [session.id]);
      order.push(session.id);
      queue.push(session.id);
    }
  }

  // Live bottom-up: not dormant (a settled peer running again is live), or a
  // spawner of something live — the forest's own rule, without ownership.
  const live = new Set<string>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index] as string;
    const card = cards.get(id) as SessionInboxCard;
    if (
      !isDormantInSpawnTree(card.session) ||
      (treeChildren.get(id) ?? []).some((childId) => live.has(childId))
    )
      live.add(id);
  }
  const liveBelow = subtreeCounts(
    order,
    (id) => (treeChildren.get(id) ?? []).filter((childId) => live.has(childId)),
    (id) => cards.get(id),
  );

  const rows = depthFirst(coordinatorId, (parentId, depth) => {
    const kids = (treeChildren.get(parentId) ?? [])
      .filter((id) => includeSettled || live.has(id))
      .map((id) => {
        const nested = live.has(id) ? liveBelow.get(id) : undefined;
        return {
          ...(cards.get(id) as SessionInboxCard),
          depth,
          ...(nested ? { peers: nested } : {}),
        };
      })
      .sort(compareSessionActivity);
    // History after what is live, among the same siblings.
    return [
      ...kids.filter((card) => live.has(card.session.id)),
      ...kids.filter((card) => !live.has(card.session.id)),
    ];
  });
  const liveCards = order
    .filter((id) => live.has(id))
    .map((id) => cards.get(id) as SessionInboxCard)
    .sort(compareSessionCards);
  const bubbled = firstBubble(liveCards);
  // The stall is judged over the tree the inbox CARD folds — this chat and
  // the coordinator-owned peers under it — not this strip's ownership-blind
  // rows: a peer the user took over, or a run's role, is not this chat's work,
  // and its activity must not hide the chat's stall (nor its quiet raise one).
  const stall = coordinator
    ? spawnTreeStall(
        [
          coordinator,
          ...spawnClusterDescendantIds(coordinatorId, forest)
            .map((id) => byId.get(id))
            .filter((row): row is SessionListItem => row !== undefined),
        ],
        byId,
      )
    : undefined;
  return {
    rows,
    counts: clusterCounts(liveCards),
    settled: order.length - live.size,
    settledShown: includeSettled,
    ...(stall ? { stall } : {}),
    ...(bubbled ? { bubbled } : {}),
  };
}

/**
 * The ledge's collapsed line: what this session is coordinating, in the
 * cluster card's own words ({@link sessionClusterSummary}) so the two surfaces
 * never call the same relation two things, and how many settled peers sit
 * behind it.
 */
export function spawnedSessionsSummary(view: SpawnedSessionsView): string {
  if (view.counts.total === 0)
    return `${view.settled} settled session${view.settled === 1 ? "" : "s"}`;
  const summary = sessionClusterSummary(view.counts);
  return view.settled > 0 ? `${summary} · ${view.settled} settled` : summary;
}

/**
 * What one peer is DRAWN from, as {@link ClusterChildRow} draws it: the agent,
 * title, state, the state's own sentence, and the timestamp behind its age.
 * The Working badge is static, so `runStartedAt` is deliberately absent.
 *
 * Those timestamps are RAW, unlike {@link sessionRowKey}'s bucketed
 * `relativeTime`, and the difference is the consumer rather than taste. A
 * bucketed label is sound for a `memo` comparator, which re-reads the old row
 * against the new one at the current time; this key gates a value that is
 * RETAINED, and a bucket that keeps answering "now" for a live row while the
 * held one ages would let the strip drift arbitrarily far from the truth.
 *
 * The state's sentence goes in through {@link sessionStatusDetail} rather than
 * as a list of fields, so a row that starts saying something new — queued work
 * waiting to run, a failure message, an outcome that failed rather than
 * finished — cannot say it while the gate holds the old view.
 */
function spawnedPeerKey(card: SessionInboxCard): string {
  const { session } = card;
  return [
    session.id,
    session.title,
    session.titleGenerationPending ? "1" : "",
    session.agentType ?? "",
    card.status,
    sessionStatusDetail(session, card.status) ?? "",
    String(session.updatedAt),
    // The row's place in the tree and what it shows beside its title.
    String(card.depth ?? ""),
    card.peers ? clusterCountsKey(card.peers) : "",
    String(backgroundJobs(session)),
  ].join("\u001f");
}

/**
 * Content key for the ledge: everything it DRAWS, which is why `open` is part
 * of the question. The session list is rebroadcast several times a second with
 * brand-new row objects, so the host holds the strip on this rather than on the
 * projection's identity; the composer is memoized, and a node rebuilt on every
 * broadcast re-renders the whole card for a line whose text did not change.
 * Same rule, and the same silent failure, as {@link sessionCardKey}: a strip
 * that reads a fact this key omits simply stops updating.
 *
 * COLLAPSED, the strip draws counts and the bubble, and nothing it draws is
 * derived from a clock. Every status badge is static. That is what makes the
 * hot path free: a peer streaming tokens moves its
 * `updatedAt` several times a second and changes nothing on a closed strip.
 *
 * OPEN, every listed peer is on screen with its own age, so the rows join the
 * key and a moved timestamp rebuilds the node. That is the honest cost of a
 * live list the user has explicitly opened, and it is bounded by how long they
 * leave it open. The alternative — holding the rows and re-labelling them from
 * a retained view — is exactly the drift this split exists to prevent.
 *
 * Opening or closing therefore changes the key by itself, so the strip is
 * handed a CURRENT view the moment its rows become visible.
 */
export function spawnedSessionsKey(
  view: SpawnedSessionsView,
  open: boolean,
): string {
  return [
    clusterCountsKey(view.counts),
    String(view.settled),
    view.stall ? stallKey(view.stall) : "",
    view.settledShown ? "1" : "",
    // The bubble's own facts are keyed raw as well. Its label is time-free
    // today; a bubbled peer that ever carried an elapsed one would otherwise
    // freeze, and the peers that bubble are idle, so nothing here churns.
    view.bubbled
      ? `${spawnedPeerKey(view.bubbled)}:${
          clusterBubbleDismissible(view.bubbled) ? "1" : ""
        }`
      : "",
    ...(open ? view.rows.map(spawnedPeerKey) : []),
  ].join("\u0000");
}

/**
 * One run as the browser shows it: the run's own state and a bounded statement
 * of the sessions under it.
 *
 * A paused run is a decision waiting on the user, and an ended run is an
 * outcome waiting to be acknowledged, so both start in `needs-you`; an active
 * one starts in the working set. A role session asking, awaiting approval,
 * waiting on a Task choice or holding an unresolved failure LIFTS the item the
 * same way a folded peer lifts its cluster: the run's own lifecycle says what
 * the recipe is doing, and it may never speak for a session that is stuck
 * asking.
 *
 * Settle on the run acknowledges the run AND puts down every role it owns, so
 * a role's failure never blocks it — acknowledging that is what the Settle is
 * for. A role that cannot be put down does — waiting on a human, still
 * running, queued — in that role's own wording, because the server refuses the
 * whole Settle rather than acknowledge the run and leave that role up as a card
 * of its own. Roles are read in inbox order, so a human gate outranks a run.
 */
function workflowRunItem(
  run: WorkflowRunSummary,
  card: WorkflowRunCard | undefined,
  roles: SessionInboxCard[],
  taskTitle: string | undefined,
): WorkflowRunInboxItem {
  const sorted = [...roles].sort(compareSessionCards);
  const counts = clusterCounts(sorted);
  const bubbled = firstBubble(sorted);
  const lifecycleTier: SessionInboxTier =
    run.lifecycle === "active" ? "working" : "needs-you";
  const settleBlocked =
    workflowRunSettleBlockedReason(run, card) ??
    sorted.find((role) => role.settleBlocked)?.settleBlocked;
  return {
    kind: "run",
    run,
    ...(card ? { card } : {}),
    tier: bubbled ? higherTier(lifecycleTier, bubbled.tier) : lifecycleTier,
    ...(taskTitle ? { taskTitle } : {}),
    roles: sorted,
    counts,
    ...(bubbled ? { bubbled } : {}),
    ...(settleBlocked ? { settleBlocked } : {}),
  };
}

/**
 * Ordering across BOTH kinds of item, on the same rule the cards alone used:
 * tier first, then latest meaningful activity, then a stable id tie-break. A
 * run is ordered by when it last moved, never by its phase — a formal run is
 * not more urgent than a question just for being formal.
 */
function compareInboxItems(a: SessionInboxItem, b: SessionInboxItem): number {
  const tier = TIER_RANK[itemTier(a)] - TIER_RANK[itemTier(b)];
  if (tier !== 0) return tier;
  const activity = itemActivityAt(b) - itemActivityAt(a);
  if (activity !== 0) return activity;
  const left = inboxItemId(a);
  const right = inboxItemId(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function itemTier(item: SessionInboxItem): SessionInboxTier {
  return item.kind === "run" ? item.tier : item.card.tier;
}

function itemActivityAt(item: SessionInboxItem): number {
  return item.kind === "run"
    ? item.run.updatedAt
    : activityAt(item.card.session);
}

/** One candidate session while the spawn forest is being folded. */
interface ClusterNode {
  /**
   * The card this session would be on its own, before any bubble lifts it —
   * carrying the CLUSTER's settle block ({@link spawnClusterSettleBlockedReason})
   * once the forest is known, so a folded peer's own row refuses what a Settle
   * on it would refuse.
   */
  card: SessionInboxCard;
  settled: boolean;
}

/**
 * Fold the candidates along their spawn edges and return the TOP-LEVEL cards,
 * pushing every settled coordinator onto `settledRows` on the way.
 *
 * Membership is the shared forest's ({@link spawnClusterForest}) and nothing
 * else — no title, no role word — because the server settles a coordinator's
 * descendants along the very same forest: what this fold shows under a card
 * is exactly what a Settle on that card shelves.
 */
function foldSpawnClusters(
  nodes: Map<string, ClusterNode>,
  settledRows: SessionListItem[],
  allById: ReadonlyMap<string, SessionListItem>,
): SessionInboxCard[] {
  const sessions = [...nodes.values()].map((node) => node.card.session);
  const forest = spawnClusterForest(sessions);
  // Settling a session settles every peer it still owns, so a peer the shared
  // predicate still blocks — running, queued, waiting on a human — blocks it in
  // that peer's own wording, exactly as a Workflow Run's roles block its
  // Settle, and in the same order the server's refusal reads. A peer's FAILURE
  // never blocks it: acknowledging that is what the Settle is for.
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const reasons = spawnClusterSettleBlockedReasons(byId, forest);
  for (const [id, node] of nodes) {
    const blocked = reasons.get(id);
    if (blocked === node.card.settleBlocked) continue;
    const { settleBlocked: _own, ...rest } = node.card;
    node.card = { ...rest, ...(blocked ? { settleBlocked: blocked } : {}) };
  }

  const bubbleOf = resolveBubbles(nodes, forest);
  // Which members have a session below them the user has NOT put down — what
  // keeps a settled coordinator's card up. A settled peer merely running
  // again does not: it runs from the shelf, like its coordinator's own turn.
  const unsettledBelow = new Set<string>();
  for (let index = forest.order.length - 1; index >= 0; index -= 1) {
    const id = forest.order[index] as string;
    if (
      (forest.childrenOf.get(id) ?? []).some(
        (childId) =>
          unsettledBelow.has(childId) || nodes.get(childId)?.settled === false,
      )
    )
      unsettledBelow.add(id);
  }
  const peerCounts = subtreeCounts(
    forest.order,
    (id) => forest.childrenOf.get(id) ?? [],
    (id) => nodes.get(id)?.card,
  );
  const shelvedChildrenOf = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    const { session } = node.card;
    const parentId = session.spawnedBySessionId;
    if (!node.settled || session.spawnOwnership !== "coordinator") continue;
    if (!parentId || parentId === id || !nodes.has(parentId)) continue;
    // Only a shelf row: a settled session that folds (live work below it) or
    // roots a card of its own is already listed where it is live.
    if (forest.parentOf.has(id) || forest.childrenOf.has(id)) continue;
    const siblings = shelvedChildrenOf.get(parentId);
    if (siblings) siblings.push(id);
    else shelvedChildrenOf.set(parentId, [id]);
  }
  const cards: SessionInboxCard[] = [];
  const context: EmitContext = {
    nodes,
    forest,
    bubbleOf,
    peerCounts,
    unsettledBelow,
    allById,
    shelvedChildrenOf,
    cards,
    settledRows,
  };
  for (const id of forest.order) {
    if (!forest.parentOf.has(id)) emitCluster(id, context);
  }
  return cards;
}

/**
 * The one descendant that speaks for each node: the highest-priority child (at
 * any depth) waiting on a human or holding a failure. Computed bottom-up over
 * the reversed visit order, so it costs one sweep rather than a walk per card.
 */
function resolveBubbles(
  nodes: Map<string, ClusterNode>,
  forest: SpawnClusterForest,
): Map<string, ClusterNode | undefined> {
  const bubbleOf = new Map<string, ClusterNode | undefined>();
  for (let index = forest.order.length - 1; index >= 0; index -= 1) {
    const id = forest.order[index] as string;
    let best: ClusterNode | undefined;
    for (const childId of forest.childrenOf.get(id) ?? []) {
      const child = nodes.get(childId);
      if (!child) continue;
      const candidates = [
        bubbles(child.card) ? child : undefined,
        bubbleOf.get(childId),
      ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (!best || compareSessionCards(candidate.card, best.card) < 0)
          best = candidate;
      }
    }
    bubbleOf.set(id, best);
  }
  return bubbleOf;
}

/** What one emit pass needs; a parameter list this long is a bug magnet. */
interface EmitContext {
  nodes: Map<string, ClusterNode>;
  forest: SpawnClusterForest;
  bubbleOf: Map<string, ClusterNode | undefined>;
  /** What each member's own folded descendants are doing ({@link subtreeCounts}). */
  peerCounts: Map<string, SessionClusterCounts>;
  /** Members with an unsettled session folded somewhere below them. */
  unsettledBelow: ReadonlySet<string>;
  /** Every listed session, for the peers a stalled tree is waiting on. */
  allById: ReadonlyMap<string, SessionListItem>;
  /**
   * Shelf rows by the session that spawned them, along `coordinator`-owned
   * edges: the settled history a fold puts back on request. Never part of a
   * cluster's counts or its Settle.
   */
  shelvedChildrenOf: Map<string, string[]>;
  /** Top-level cards, in no particular order; the caller sorts. */
  cards: SessionInboxCard[];
  /** Settled coordinators, for the shelf; the caller sorts and pages them. */
  settledRows: SessionListItem[];
}

/**
 * Turn one root into what the browser shows: a cluster card carrying its
 * descendants, a card of its own, or a Settled shelf row.
 *
 * An unsettled root with anything folded under it is a CARD. A SETTLED root
 * is a card only while its fold holds a session the user has not put down —
 * an unsettled peer at any depth — or one that bubbles: that is work going on
 * in its tree, and the top level is where it is shown, under the session that
 * started it rather than released as cards of its own. Otherwise the root
 * takes the shelf with its whole fold. A settled peer running again is not
 * enough on its own: it runs from the shelf raising no outcome, exactly as the
 * coordinator's own next turn does, and a card that came and went with every
 * peer turn would flicker in and out of the working set.
 *
 * A Settle from the cluster's own card shelves the peers with it (server-side,
 * through their current revisions — `spawnClusterDescendantIds`), so a settled
 * coordinator comes back here only for a peer that came back on its own (one
 * woken by a later failure) or one it spawned after it was put down.
 */
function emitCluster(id: string, context: EmitContext): void {
  const {
    nodes,
    bubbleOf,
    peerCounts,
    unsettledBelow,
    allById,
    cards,
    settledRows,
  } = context;
  const node = nodes.get(id) as ClusterNode;
  const counts = peerCounts.get(id);
  const bubbled = bubbleOf.get(id);
  if (!counts) {
    if (node.settled) settledRows.push(node.card.session);
    else cards.push(withStall(node.card, [node.card.session], allById));
    return;
  }
  // Put down, and nothing under it is unsettled or waiting on the user: the
  // whole fold stays on the shelf, each session as its own shelf row, so none
  // leaves the shelf while a settled peer runs. Those peers run from there,
  // exactly as the coordinator's own next turn would.
  if (node.settled && !bubbled && !unsettledBelow.has(id)) {
    settledRows.push(node.card.session);
    for (const childId of spawnClusterDescendantIds(id, context.forest)) {
      const child = nodes.get(childId);
      if (child) settledRows.push(child.card.session);
    }
    return;
  }

  const children = clusterTree(id, context, false);
  const childrenWithSettled = clusterTree(id, context, true);
  cards.push(
    withStall(
      {
        ...node.card,
        tier: bubbled
          ? higherTier(node.card.tier, bubbled.card.tier)
          : node.card.tier,
        cluster: {
          children,
          childrenWithSettled,
          settledCount: childrenWithSettled.length - children.length,
          counts,
          ...(bubbled ? { bubbled: bubbled.card } : {}),
        },
      },
      [node.card.session, ...children.map((child) => child.session)],
      allById,
    ),
  );
}

/**
 * A root's folded descendants as the TREE the expanded fold draws: depth-first,
 * each peer directly under the session that spawned it, siblings in inbox
 * order. A peer that coordinates peers of its own carries their counts and is
 * lifted by its own bubble, so a nested question sorts its branch up the same
 * way it lifts the top-level card. With `withSettled`, the shelf rows spawned
 * anywhere in the tree are put back under their spawners too, after the live
 * siblings.
 *
 * Iterative rather than recursive: depth is unbounded, and the forest has
 * already broken every cycle, so the `seen` guard only keeps a malformed
 * shelf edge from listing a session twice.
 */
function clusterTree(
  rootId: string,
  context: EmitContext,
  withSettled: boolean,
): SessionInboxCard[] {
  const { nodes, forest, bubbleOf, peerCounts, shelvedChildrenOf } = context;
  const seen = new Set([rootId]);
  const childrenOf = (parentId: string, depth: number): SessionInboxCard[] => {
    const kids: SessionInboxCard[] = [];
    for (const childId of forest.childrenOf.get(parentId) ?? []) {
      const child = nodes.get(childId);
      if (!child || seen.has(childId)) continue;
      seen.add(childId);
      const nested = peerCounts.get(childId);
      const bubbled = bubbleOf.get(childId);
      kids.push({
        ...child.card,
        depth,
        ...(bubbled
          ? { tier: higherTier(child.card.tier, bubbled.card.tier) }
          : {}),
        ...(nested ? { peers: nested } : {}),
      });
    }
    kids.sort(compareSessionCards);
    if (!withSettled) return kids;
    // History after what is live, among the same siblings.
    const settled: SessionInboxCard[] = [];
    for (const childId of shelvedChildrenOf.get(parentId) ?? []) {
      const child = nodes.get(childId);
      if (!child || seen.has(childId)) continue;
      seen.add(childId);
      settled.push({ ...child.card, depth });
    }
    return [...kids, ...settled.sort(compareSessionCards)];
  };
  return depthFirst(rootId, childrenOf);
}

/**
 * Depth-first, parents before children, over a children function that already
 * orders each set of siblings — the one walk both the inbox fold and the
 * composer ledge draw their trees with. Uses an explicit stack, so a long
 * chain costs memory rather than call depth.
 */
function depthFirst(
  rootId: string,
  childrenOf: (parentId: string, depth: number) => SessionInboxCard[],
): SessionInboxCard[] {
  const rows: SessionInboxCard[] = [];
  const stack = childrenOf(rootId, 1).reverse();
  while (stack.length > 0) {
    const card = stack.pop() as SessionInboxCard;
    rows.push(card);
    stack.push(...childrenOf(card.session.id, (card.depth ?? 1) + 1).reverse());
  }
  return rows;
}

/** The more urgent of two tiers. */
function higherTier(
  a: SessionInboxTier,
  b: SessionInboxTier,
): SessionInboxTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/** The newest meaningful moment on a session, used for in-tier ordering. */
function activityAt(session: SessionListItem): number {
  return Math.max(
    session.updatedAt || 0,
    session.runStartedAt ?? 0,
    session.lastError?.at ?? 0,
    session.interruptedRun?.at ?? 0,
  );
}

function bounded(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "The last run failed.";
  return clean.length > MAX_CONTEXT_CHARS
    ? `${clean.slice(0, MAX_CONTEXT_CHARS - 1)}…`
    : clean;
}
