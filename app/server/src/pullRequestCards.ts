/**
 * Durable live PR cards for `/pr`, managed delivery, and workflows. Modeled on
 * {@link import("./pendingApprovals.ts")}: one SQLite row per card
 * (`db/pullRequestCardStore.ts`), cards
 * injected into session snapshots on attach (mirrors `withApprovalBlocks`),
 * updates broadcast as `pullRequestCardUpdate` so a viewer upserts by id, and
 * `sourceToolCallId` anchors a card at the `/pr` synthetic tool call that issued
 * it (client restore/order logic mirrors `mergeApprovalMessages`).
 *
 * Unlike approvals, there is no execute-on-decision seam: `prWorkflow.ts`
 * creates and patches cards directly (drafting + provider calls happen inline),
 * and `pullRequestWatcher.ts` patches them on its poll cadence. This store owns
 * PERSISTENCE, PROJECTION and BROADCAST only.
 *
 * Every record also carries a server-only `context` — the repo root, session
 * identity and PR args needed to (re)draft and create the pull request once a
 * `choosing-task` card's disambiguation prompt is answered, plus watcher
 * bookkeeping (`notifiedHeadSha`, the CI-conclusion push dedupe key). Never sent
 * to the client.
 */
import { randomUUID } from "node:crypto";
import { applyPatch } from "@assistant/shared";
import type {
  DisplayMessage,
  Patch,
  PullRequestCard,
  PullRequestCardStatus,
  SessionPullRequestSummary,
} from "@assistant/shared";
import { inDbTransaction } from "./db/index.ts";
import {
  pullRequestCardStore,
  type PullRequestCardSummaryRow,
  type StoredPullRequestCard,
} from "./db/pullRequestCardStore.ts";
import { pullRequestKey } from "./pullRequestIdentity.ts";

/** Context needed to (re)draft and create the pull request; never sent to the client. */
export interface PullRequestCardContext {
  repoRoot: string;
  sessionKind: import("@assistant/shared").AgentKind;
  sessionId: string;
  headBranch: string;
  baseBranch: string;
  draft: boolean;
  additionalContext?: string;
  /** Explicit caller-authored title for a new PR; absent means use the PR agent's title. */
  explicitTitle?: string;
  /** Named push remote that owns this PR; absent retains the ordinary origin path. */
  remote?: string;
  /** Exact managed-worktree HEAD accepted before provider creation/adoption. */
  acceptedHeadSha?: string;
  /** Head SHA from the latest provider detail poll, persisted for wait recovery. */
  observedHeadSha?: string;
  /** Newest in-flight provider snapshot; older responses may not patch the card. */
  observationToken?: string;
  /** Head SHA a CI-conclusion push notification was already sent for. */
  notifiedHeadSha?: string;
  /**
   * The head the branch stood at when a rebase conflict was handed to the
   * session's agent — the baseline the watcher clears `rebaseHandedOff`
   * against, since the handoff ends when the branch is republished. Written by
   * the action itself (before the prompt is offered), so a poll that lands
   * between the two already knows which head the agent inherited. Missing means
   * no baseline could be established, and the first observation after the
   * handoff ends it rather than disabling the button on a guess.
   */
  rebaseHandoffHeadSha?: string;
  /**
   * Identity of the action that last spoke for this card, minted per action.
   * A LATE write (the conflict handoff's outcome) carries the token it was
   * issued under and is dropped when it no longer matches — the card's
   * `updatedAt` cannot serve here, because the watcher bumps that on every
   * routine CI/review poll and would suppress a perfectly valid outcome.
   */
  actionToken?: string;
}

interface PullRequestCardRecord {
  card: PullRequestCard;
  context: PullRequestCardContext;
}

/* ------------------------------ store access ------------------------------ */

const asRecord = (stored: StoredPullRequestCard): PullRequestCardRecord => ({
  card: stored.card,
  context: stored.context as PullRequestCardContext,
});

/**
 * Write a patched record, unless it says exactly what is stored — the watcher
 * patches every open card on every poll, and most polls learn nothing. `touch`
 * bumps `updatedAt` on a real change; a context-only bookkeeping write (a new
 * observation token) leaves it, as it always has. Returns what is stored.
 */
function persist(
  before: PullRequestCardRecord,
  card: PullRequestCard,
  context: PullRequestCardContext,
  touch: boolean,
): PullRequestCardRecord {
  if (
    JSON.stringify(card) === JSON.stringify(before.card) &&
    JSON.stringify(context) === JSON.stringify(before.context)
  )
    return before;
  const next = {
    card: touch ? { ...card, updatedAt: Date.now() } : card,
    context,
  };
  pullRequestCardStore.update(next);
  staleSessions.add(before.card.sessionId);
  staleSessions.add(next.card.sessionId);
  return next;
}

/** Internal record lookup, context included — used by the workflow and watcher. */
export function pullRequestCardRecord(
  id: string,
): PullRequestCardRecord | undefined {
  const stored = pullRequestCardStore.get(id);
  return stored ? asRecord(stored) : undefined;
}

export function pullRequestCardById(id: string): PullRequestCard | undefined {
  return pullRequestCardRecord(id)?.card;
}

/** All cards for a session, oldest first (re-emitted to a viewer on attach). */
export function cardsForSession(sessionId: string): PullRequestCard[] {
  return pullRequestCardStore
    .forSession(sessionId)
    .map((stored) => stored.card);
}

/** Every card created for one managed worktree, oldest first. */
export function pullRequestCardsForWorktree(
  worktreeId: string,
): PullRequestCard[] {
  return pullRequestCardStore
    .forWorktree(worktreeId)
    .map((stored) => stored.card);
}

/** Cards still claiming an action in flight — boot reconciliation reads this. */
export function pullRequestCardsWithBusyAction(): PullRequestCard[] {
  return pullRequestCardStore.withBusyAction().map((stored) => stored.card);
}

/** Sessions and linked Tasks one provider pull request is reachable from. */
export interface PullRequestCardLinks {
  sessionIds: string[];
  taskIds: string[];
}

/**
 * Which sessions and Tasks each pull request is reachable through, from ONE
 * query — the join the Pull Requests inventory needs, and the reason it does
 * not reach into this store itself.
 *
 * Keyed by `pullRequestIdentity.ts`'s repository-scoped key, read out of the
 * card's own pull-request URL: a card that never reached a real pull request
 * (still drafting, or failed) contributes nothing, and neither does one whose
 * URL proves no repository — joining it on its number alone would hand this
 * session and Task to another repository's #N. Order within each entry is the
 * store's own, which is insert order, and each id appears once.
 */
export function pullRequestCardLinksByPullRequest(): Map<
  string,
  PullRequestCardLinks
> {
  const out = new Map<string, PullRequestCardLinks>();
  for (const card of pullRequestCardStore.links()) {
    if (!card.provider || card.number === undefined || !card.url) continue;
    const key = pullRequestKey(card.provider, card.url, card.number);
    if (!key) continue;
    const links = out.get(key) ?? { sessionIds: [], taskIds: [] };
    if (!links.sessionIds.includes(card.sessionId))
      links.sessionIds.push(card.sessionId);
    const taskId = card.taskId;
    if (taskId && !links.taskIds.includes(taskId)) links.taskIds.push(taskId);
    out.set(key, links);
  }
  return out;
}

/** Every card the watcher must keep polling (adaptive cadence lives in the watcher). */
export function openPullRequestCards(): PullRequestCard[] {
  return pullRequestCardStore.withStatus("open").map((stored) => stored.card);
}

/* ---------------------------- session indexes ----------------------------- */

/**
 * A card that is still MOVING outranks a terminal one, whatever their ages.
 * Within a rung the newest wins, so a re-run `/pr` speaks for the session and
 * the card it superseded goes quiet.
 */
function cardIsLive(status: PullRequestCardStatus): boolean {
  return (
    status === "choosing-task" || status === "creating" || status === "open"
  );
}

/**
 * The ONE card each session's list row states, projected to
 * {@link SessionPullRequestSummary} — the wire type owns which card wins and
 * why.
 *
 * Memoized: the session list is rebuilt up to ~4 times a second while agents
 * stream, and the card table holds every card ever made. The first build reads
 * only the summary fields of every card (SQLite extracts them; no card is
 * parsed here). After that each write in this module marks its session stale,
 * and the next read refreshes just those sessions. Another connection's commit
 * (`PRAGMA data_version`) or a reopened database rebuilds it whole. Callers get
 * the SAME map on every call.
 */
export function pullRequestSummariesBySession(): ReadonlyMap<
  string,
  SessionPullRequestSummary
> {
  const stamp = pullRequestCardStore.foreignWriteStamp();
  if (
    !summaryIndex ||
    summaryIndex.db !== stamp.db ||
    summaryIndex.dataVersion !== stamp.dataVersion
  ) {
    staleSessions.clear();
    summaryIndex = {
      ...stamp,
      summaries: summariesOf(pullRequestCardStore.allSummaries()),
    };
    return summaryIndex.summaries;
  }
  for (const sessionId of staleSessions) {
    const summary = sessionSummary(sessionId);
    if (summary) summaryIndex.summaries.set(sessionId, summary);
    else summaryIndex.summaries.delete(sessionId);
  }
  staleSessions.clear();
  return summaryIndex.summaries;
}

/**
 * Every session blocked on a `choosing-task` card's Task pick, in ONE query —
 * the attention counterpart of `pendingApprovals.ts`'s
 * `pendingApprovalSessionIds`, and read once per session-list build for the
 * same reason.
 *
 * A superseded card counts here even though the row does not state it: the
 * summary above answers "what does this session's row say", while this answers
 * "is a human still being asked something", and an unanswered prompt keeps
 * asking whether or not a newer `/pr` run has taken over the row.
 */
export function choosingTaskSessionIds(): Set<string> {
  return pullRequestCardStore.sessionsWithStatus("choosing-task");
}

/** True while the session has a `choosing-task` card awaiting the user's Task pick. */
export function hasChoosingTaskCard(sessionId: string): boolean {
  return pullRequestCardStore.sessionHasStatus(sessionId, "choosing-task");
}

interface SummaryIndex {
  db: object;
  dataVersion: number;
  summaries: Map<string, SessionPullRequestSummary>;
}

let summaryIndex: SummaryIndex | undefined;
/** Sessions whose cards this process changed since the index last looked. */
const staleSessions = new Set<string>();

function summariesOf(
  rows: PullRequestCardSummaryRow[],
): Map<string, SessionPullRequestSummary> {
  const chosen = new Map<string, PullRequestCardSummaryRow>();
  for (const row of rows) {
    const current = chosen.get(row.sessionId);
    if (current && !supersedes(row, current)) continue;
    chosen.set(row.sessionId, row);
  }
  const summaries = new Map<string, SessionPullRequestSummary>();
  for (const [sessionId, row] of chosen)
    summaries.set(sessionId, summarize(row));
  return summaries;
}

/** One session's summary, read from its own rows only. */
function sessionSummary(
  sessionId: string,
): SessionPullRequestSummary | undefined {
  return summariesOf(pullRequestCardStore.summariesForSession(sessionId)).get(
    sessionId,
  );
}

/* ----------------------------- attention seam ----------------------------- */

type ChangeListener = (sessionId: string) => void;
const choosingTaskListeners = new Set<ChangeListener>();

/**
 * Subscribe to a session gaining or losing a `choosing-task` card (harness
 * attention refresh), mirroring `subscribePendingApprovalChanges`. A live
 * harness folds {@link hasChoosingTaskCard} into its `state()`, so it has to be
 * told when that answer changes under it — every other card transition is a
 * card broadcast, which the session state does not carry.
 */
export function subscribeChoosingTaskCardChanges(
  listener: ChangeListener,
): () => void {
  choosingTaskListeners.add(listener);
  return () => choosingTaskListeners.delete(listener);
}

function emitChoosingTaskChange(sessionId: string): void {
  for (const listener of choosingTaskListeners) listener(sessionId);
}

/**
 * What ONE session's rows currently say, as a comparable value — the gate on
 * the extra session-list broadcast below. The watcher patches an `open` card on
 * every poll whether or not the provider said anything new, and rebuilding the
 * whole list to send nothing is work nobody asked for.
 *
 * A row states TWO things about this store, and the second is not a function of
 * the first: the summary card, and whether the session is still blocked on a
 * Task pick. An older `choosing-task` card being answered while a newer `open`
 * card holds the row moves the attention badge without moving the summary, and
 * gating on the summary alone would leave that row saying "Pick task" (and
 * refusing to settle) until some unrelated rebuild — a hole the approval store
 * does not have, since its broadcast always rebuilds the list.
 */
function sessionRowState(sessionId: string): string {
  return JSON.stringify([
    sessionSummary(sessionId) ?? null,
    hasChoosingTaskCard(sessionId),
  ]);
}

/**
 * What this card currently says about DELIVERY — the fields
 * `workflowRunDeliveryOf` reads onto a Workflow card — as one comparable value,
 * and the gate on the extra run-list broadcast below.
 *
 * The same argument as {@link sessionRowState}, for the other list this store
 * can move: a Task's Workflow card offers merge and cleanup from these fields,
 * so a card that merges, gets cleaned up, starts an action or learns which
 * merge methods the repository allows has to reach the Task — and the watcher's
 * every-poll patch, which changes none of them, must not.
 */
function workflowDeliveryState(card: PullRequestCard): string {
  return JSON.stringify([
    card.status,
    card.worktreeId ?? null,
    card.cleanedUp ?? false,
    card.busyAction ?? null,
    card.actionMessage ?? null,
    card.actionError ?? null,
    card.repositoryCapabilities?.mergeMethods ?? null,
    card.repositoryCapabilities?.defaultMergeMethod ?? null,
  ]);
}

/** What deciding and stating a session's row reads off a card. */
type SummaryFields = Pick<
  PullRequestCard,
  "status" | "createdAt" | "number" | "ci" | "review" | "conflicts" | "draft"
>;

function supersedes(card: SummaryFields, current: SummaryFields): boolean {
  const live = cardIsLive(card.status);
  if (live !== cardIsLive(current.status)) return live;
  return card.createdAt >= current.createdAt;
}

function summarize(card: SummaryFields): SessionPullRequestSummary {
  return {
    status: card.status,
    ...(card.number !== undefined ? { number: card.number } : {}),
    ...(card.ci ? { ci: card.ci } : {}),
    ...(card.review ? { review: card.review } : {}),
    ...(card.conflicts ? { conflicts: true } : {}),
    ...(card.draft ? { draft: true } : {}),
  };
}

/** Project pull-request card display blocks for a session, oldest first. */
function pullRequestCardBlocksForSession(sessionId: string): DisplayMessage[] {
  return cardsForSession(sessionId).map((card) => ({
    id: `pull-request-card-${card.id}`,
    role: "assistant" as const,
    blocks: [{ kind: "pullRequest" as const, pullRequest: card }],
    createdAt: new Date(card.createdAt).toISOString(),
  }));
}

/** Interleave pull-request cards into a legacy DisplayMessage snapshot (mirrors `withApprovalBlocks`). */
export function withPullRequestCardBlocks(
  messages: DisplayMessage[],
  sessionId: string,
): DisplayMessage[] {
  const result = [...messages];
  for (const message of pullRequestCardBlocksForSession(sessionId)) {
    const card = cardFromMessage(message);
    let insertAt = -1;
    if (card?.sourceToolCallId) {
      const anchor = result.findIndex((candidate) =>
        candidate.blocks.some(
          (block) =>
            block.kind === "tool" && block.toolId === card.sourceToolCallId,
        ),
      );
      if (anchor >= 0) {
        insertAt = anchor + 1;
        while (
          insertAt < result.length &&
          cardFromMessage(result[insertAt]!)?.sourceToolCallId ===
            card.sourceToolCallId
        )
          insertAt += 1;
      }
    }
    if (insertAt < 0) {
      const createdAt = card?.createdAt ?? 0;
      insertAt = result.findIndex(
        (candidate) =>
          candidate.createdAt && Date.parse(candidate.createdAt) > createdAt,
      );
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

function cardFromMessage(message: DisplayMessage): PullRequestCard | undefined {
  return message.blocks.find(
    (
      block,
    ): block is Extract<
      (typeof message.blocks)[number],
      { kind: "pullRequest" }
    > => block.kind === "pullRequest",
  )?.pullRequest;
}

/* ----------------------------- creation ---------------------------------- */

export interface CreatePullRequestCardInput {
  sessionId: string;
  sourceToolCallId?: string;
  status: PullRequestCardStatus;
  title: string;
  headBranch: string;
  baseBranch: string;
  draft?: boolean;
  provider?: PullRequestCard["provider"];
  number?: number;
  url?: string;
  body?: string[];
  warnings?: string[];
  linkedTask?: PullRequestCard["linkedTask"];
  taskCandidates?: PullRequestCard["taskCandidates"];
  reused?: boolean;
  /** Worktree the session runs in; gates the card's local actions (stage 3). */
  worktreeId?: string;
}

/** Persist a new card and broadcast it. Returns the card. */
export function createPullRequestCard(
  input: CreatePullRequestCardInput,
  context: PullRequestCardContext,
): PullRequestCard {
  const now = Date.now();
  const card: PullRequestCard = {
    renderKind: "pullRequest",
    id: `pr_${now}_${randomUUID().slice(0, 8)}`,
    sessionId: input.sessionId,
    status: input.status,
    createdAt: now,
    updatedAt: now,
    ...(input.sourceToolCallId
      ? { sourceToolCallId: input.sourceToolCallId }
      : {}),
    title: input.title,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    ...(input.draft ? { draft: true } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.number !== undefined ? { number: input.number } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.body?.length ? { body: input.body } : {}),
    warnings: input.warnings ?? [],
    ...(input.linkedTask ? { linkedTask: input.linkedTask } : {}),
    ...(input.taskCandidates?.length
      ? { taskCandidates: input.taskCandidates }
      : {}),
    ...(input.reused ? { reused: true } : {}),
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
  };
  const rowBefore = sessionRowState(input.sessionId);
  const choosingBefore = hasChoosingTaskCard(input.sessionId);
  pullRequestCardStore.insert({ card, context });
  staleSessions.add(input.sessionId);
  if (choosingBefore !== hasChoosingTaskCard(input.sessionId))
    emitChoosingTaskChange(input.sessionId);
  // No delivery broadcast: a Workflow card names its pull-request card from the
  // run's own publication step, which is appended after this and broadcasts the
  // run list itself. A card that exists before that step names no run.
  void broadcast(card, rowBefore !== sessionRowState(input.sessionId), false);
  return card;
}

/* ----------------------------- mutation ----------------------------------- */

/** Mint ordering before a provider read; only this observation may later land. */
export function beginPullRequestCardObservation(id: string): string {
  const token = randomUUID();
  inDbTransaction(() => {
    const before = pullRequestCardRecord(id);
    if (!before) throw new Error("Pull request card not found.");
    persist(
      before,
      before.card,
      { ...before.context, observationToken: token },
      false,
    );
  });
  return token;
}

/**
 * Land a provider snapshot only while its generation is still newest. A later
 * watcher poll or reactive merge-refusal read invalidates this one before either
 * the client card or a Workflow Run can consume stale state.
 */
export function patchPullRequestCardObservation(
  id: string,
  observationToken: string,
  patch: Patch<PullRequestCard>,
  contextPatch?: Patch<PullRequestCardContext>,
): PullRequestCard | undefined {
  const before = pullRequestCardRecord(id);
  if (!before) throw new Error("Pull request card not found.");
  const rowBefore = sessionRowState(before.card.sessionId);
  const deliveryBefore = workflowDeliveryState(before.card);
  const updated = inDbTransaction(() => {
    const current = pullRequestCardRecord(id);
    if (current?.context.observationToken !== observationToken)
      return undefined;
    return persist(
      current,
      applyPatch(current.card, patch),
      applyPatch(current.context, contextPatch ?? {}),
      true,
    );
  });
  if (!updated) return undefined;
  void broadcast(
    updated.card,
    rowBefore !== sessionRowState(updated.card.sessionId),
    deliveryBefore !== workflowDeliveryState(updated.card),
  );
  return updated.card;
}

/**
 * Patch a card's client-facing fields (and optionally its server-only
 * context) and broadcast the result. Throws if the card is gone — every caller
 * already holds an id it just read or just created.
 */
export function patchPullRequestCard(
  id: string,
  patch: Patch<PullRequestCard>,
  contextPatch?: Patch<PullRequestCardContext>,
): PullRequestCard {
  const cardBefore = pullRequestCardById(id);
  if (!cardBefore) throw new Error("Pull request card not found.");
  const sessionId = cardBefore.sessionId;
  const rowBefore = sessionRowState(sessionId);
  const deliveryBefore = workflowDeliveryState(cardBefore);
  const choosingBefore = hasChoosingTaskCard(sessionId);
  const updated = inDbTransaction(() => {
    const current = pullRequestCardRecord(id);
    if (!current) throw new Error("Pull request card not found.");
    return persist(
      current,
      applyPatch(current.card, patch),
      contextPatch
        ? applyPatch(current.context, contextPatch)
        : current.context,
      true,
    );
  });
  if (choosingBefore !== hasChoosingTaskCard(updated.card.sessionId))
    emitChoosingTaskChange(updated.card.sessionId);
  void broadcast(
    updated.card,
    rowBefore !== sessionRowState(updated.card.sessionId),
    deliveryBefore !== workflowDeliveryState(updated.card),
  );
  return updated.card;
}

/** Test seam: wipe the store. */
export function resetPullRequestCardsStoreForTests(): void {
  pullRequestCardStore.clear();
  summaryIndex = undefined;
  staleSessions.clear();
}

/* ----------------------------- broadcast --------------------------------- */

type BroadcastFn = (
  card: PullRequestCard,
  rowChanged: boolean,
  deliveryChanged: boolean,
) => void;
let broadcastImpl: BroadcastFn | null = null;

/** Test seam: replace the hub broadcast. */
export function setPullRequestCardBroadcastForTests(
  fn: BroadcastFn | null,
): void {
  broadcastImpl = fn;
}

/**
 * `rowChanged` says the session's LIST row now states something different
 * ({@link sessionRowState}). The card update reaches that session's viewers
 * only; every list surface showing the same card carries no such subscription,
 * and nothing else about a session moves when CI turns red on a machine
 * somewhere else — so the list is rebuilt too, but only when it would say
 * something. The watcher patches an open card on every poll regardless.
 *
 * `deliveryChanged` is the same gate for the `workflow` topic
 * ({@link workflowDeliveryState}): a Task's Workflow card offers this card's
 * merge and cleanup, so those two controls have to follow the card wherever it
 * was moved from. Imported at the point of use, like the hub above, because the
 * run list's own projection reads this store — a static edge back would close
 * the cycle.
 */
async function broadcast(
  card: PullRequestCard,
  rowChanged: boolean,
  deliveryChanged: boolean,
): Promise<void> {
  if (broadcastImpl) {
    broadcastImpl(card, rowChanged, deliveryChanged);
    return;
  }
  try {
    const { hub } = await import("./hub.ts");
    hub.broadcastPullRequestCardUpdate(card);
    if (rowChanged) void hub.broadcastSessions();
  } catch {
    // best-effort; the card still resolves from the store on the next snapshot.
  }
  if (!deliveryChanged) return;
  try {
    const { broadcastWorkflowRuns } = await import("./workflowRuns.ts");
    broadcastWorkflowRuns();
  } catch {
    // best-effort; a subscribe re-reads the authoritative list.
  }
}
