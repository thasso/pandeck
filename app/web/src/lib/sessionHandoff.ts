/**
 * What a NEW session opened FOR an existing object inherits: starting a session
 * in a worktree (`startSessionInWorktree`), the worktree comment-review draft
 * (`startWorktreeReviewDraft`) and the `/review` handoff (an agent reviews a
 * session's work) resolve their staged Task / project / persona through the ONE
 * rule stated here.
 *
 * Pure, and separate from `App.tsx`, because it is a DERIVATION RULE rather
 * than staging mechanics: flows staging "the context a session about X needs"
 * must not disagree about what that context is. Degradation is owned here too
 * — no worktree, no Task, an AMBIGUOUS Task (attach none rather than guess) —
 * so callers stage exactly what comes back.
 */
import { REVIEW_REPORT_CONVENTION } from "@assistant/shared";
import type {
  SessionAgentType,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";

export interface SessionHandoffContext {
  worktreeId?: string;
  projectId?: string;
  /** The Task the new session should attach through the ordinary task-start path. */
  task?: { taskId: string; title: string };
}

/** The record behind a worktree id, only while it still exists as a checkout. */
function liveWorktree(
  worktreeId: string,
  worktrees: WorktreeRecord[] | null,
): WorktreeRecord | undefined {
  const record = (worktrees ?? []).find((item) => item.id === worktreeId);
  return record && !record.removedAt ? record : undefined;
}

/**
 * Exactly one unarchived candidate, or none: a new session must not guess which
 * of several Tasks the work belongs to, so ambiguity attaches nothing.
 */
function unambiguousTask(
  candidates: TaskSummary[],
): { taskId: string; title: string } | undefined {
  const open = candidates.filter((task) => !task.archivedAt);
  const only = open.length === 1 ? open[0] : undefined;
  return only ? { taskId: only.id, title: only.title } : undefined;
}

/**
 * The Task a worktree implements — the inverse of `worktrees.ts`'s
 * `worktreeForTask`, and it takes the same two rules, strongest first:
 *
 * 1. the `task —in_worktree→ worktree` edge the record carries (`taskIds`)
 * 2. a Task that claims a session which itself runs in this worktree
 *
 * Rule 2 exists because that edge is only written when a worktree is created
 * FOR a Task; picking the same Task up later in an existing checkout links the
 * SESSION, not the Task, and without this rule a worktree that has been worked
 * for days still looks Task-less. Unlike `worktreeForTask` neither rule breaks
 * ties on recency: several Tasks in one checkout is genuine ambiguity about
 * what a new session is FOR, and guessing would attach the wrong Task's context
 * and put the session on the wrong Task's trace.
 */
function taskForWorktree(
  record: WorktreeRecord | undefined,
  tasks: TaskSummary[],
  sessions: SessionListItem[],
): { taskId: string; title: string } | undefined {
  if (!record) return undefined;
  // An edge that names only archived Tasks is spent, so rule 2 still applies:
  // the checkout was made for work that is finished and has since been reused.
  const linked = tasks.filter(
    (task) => record.taskIds.includes(task.id) && !task.archivedAt,
  );
  if (linked.length > 0) return unambiguousTask(linked);
  const inWorktree = new Set(
    sessions
      .filter((session) => session.worktreeId === record.id)
      .map((session) => session.id),
  );
  if (inWorktree.size === 0) return undefined;
  return unambiguousTask(
    tasks.filter((task) =>
      (task.sessionRefs ?? []).some((ref) => inWorktree.has(ref.sessionId)),
    ),
  );
}

/**
 * Context a new session about a WORKTREE inherits. The worktree id itself is
 * kept even without a live record — the caller was invoked for that checkout —
 * but project and Task derive only from a record that still exists.
 */
export function sessionContextForWorktree(
  worktreeId: string,
  worktrees: WorktreeRecord[] | null,
  sessions: SessionListItem[],
  tasks: TaskSummary[],
): SessionHandoffContext {
  const record = liveWorktree(worktreeId, worktrees);
  const task = taskForWorktree(record, tasks, sessions);
  return {
    worktreeId,
    ...(record ? { projectId: record.projectId } : {}),
    ...(task ? { task } : {}),
  };
}

/** What the SERVER answered about a pull request's checkout, plus its own links. */
export interface PullRequestReviewSource {
  worktreeId: string;
  /** The project the pull request belongs to; authoritative, from the item. */
  projectId: string;
  /**
   * The Tasks linked to this CHECKOUT, as the checkout endpoint reported them.
   * An empty array is the authoritative "it has none" — that is the whole
   * reason it is on the wire.
   */
  checkoutTaskIds: readonly string[];
  /** The pull request's own Task ids from the inventory (checkout ∪ `/pr` cards). */
  pullRequestTaskIds: readonly string[];
}

/**
 * The two client lists this derivation may consult, WITH what is known about
 * their currency — the same rule the Pull Requests view's join rows follow.
 */
export interface PullRequestReviewLists {
  sessions: { rows: SessionListItem[] | null; fresh: boolean };
  tasks: { rows: TaskSummary[] | null; fresh: boolean };
}

/**
 * Context a new session about a PULL REQUEST inherits, once its checkout
 * exists.
 *
 * The precedence is the one every other handoff here uses — the CHECKOUT's own
 * Task first, the pull request's links only as a fallback — but which Task that
 * is may never be decided from a list whose freshness this cannot vouch for.
 * That is why the checkout's ids arrive from the SERVER: `[]` is an answer,
 * while "my Tasks list has not loaded" is not, and a cold list previously made
 * the two look identical — the same absence-versus-unknown failure the view's
 * join rows exist to prevent.
 *
 * So: the server's ids decide WHICH Task, and the lists are consulted only for
 * what they can answer — the title, and the one rule that is genuinely
 * client-side (a Task claiming a session that runs in this checkout), which is
 * skipped entirely unless BOTH lists are fresh. An unknown answer there stops
 * the derivation rather than falling through to the pull request's links, since
 * falling through would let a `/pr` card's Task overrule a checkout-owned one
 * that was merely not visible yet.
 */
export function pullRequestReviewContext(
  source: PullRequestReviewSource,
  lists: PullRequestReviewLists,
): SessionHandoffContext {
  const task = reviewTask(source, lists);
  return {
    worktreeId: source.worktreeId,
    projectId: source.projectId,
    ...(task ? { task } : {}),
  };
}

function reviewTask(
  source: PullRequestReviewSource,
  lists: PullRequestReviewLists,
): { taskId: string; title: string } | undefined {
  // Tier by tier, strongest relationship first.
  //
  // 1. the checkout's own edges, as the server answered them;
  // 2. a Task claiming a session that runs in the checkout — the one genuinely
  //    client-side rule, so it is skipped unless both lists are current and its
  //    UNKNOWN stops the derivation rather than falling through;
  // 3. the pull request's own links, for a Task reached through its `/pr` card.
  //
  // A tier with no LIVE candidate is spent — an edge whose Tasks have all been
  // archived is not a reason to attach nothing, which is the rule the worktree
  // handoff already followed — so the next tier gets its turn. A tier with
  // SEVERAL is ambiguity, and that stops here rather than guessing on a weaker
  // link.
  const own = liveCandidates(source.checkoutTaskIds, lists);
  if (own.length > 0) return pickOne(own, lists);
  const claiming = claimingTaskIds(source.worktreeId, lists);
  if (claiming === "unknown") return undefined;
  const claimed = liveCandidates(claiming, lists);
  if (claimed.length > 0) return pickOne(claimed, lists);
  return pickOne(liveCandidates(source.pullRequestTaskIds, lists), lists);
}

/**
 * The ids a session may still be attached to.
 *
 * A FRESH Tasks list is the live projection, and an archived Task is not IN it
 * — the server's `taskSummaryFor` answers `null` for one, so it leaves the
 * list rather than appearing with an `archivedAt`. Absence there is therefore
 * the answer "spent", not "unknown", and the id drops out. A cold or stale list
 * knows nothing either way, so every id survives it: they come from the server,
 * and dropping one because a browser has not caught up is the loss this whole
 * shape exists to prevent. (A row that DOES carry `archivedAt` is dropped too,
 * so a list that ever includes archived Tasks cannot reintroduce the bug.)
 */
function liveCandidates(
  ids: readonly string[],
  lists: PullRequestReviewLists,
): string[] {
  if (!lists.tasks.fresh) return [...ids];
  const known = taskIndex(lists);
  return ids.filter((id) => {
    const row = known.get(id);
    return row !== undefined && !row.archivedAt;
  });
}

/** Exactly one candidate or none, as everywhere here. */
function pickOne(
  ids: readonly string[],
  lists: PullRequestReviewLists,
): { taskId: string; title: string } | undefined {
  const only = ids.length === 1 ? ids[0] : undefined;
  if (!only) return undefined;
  // `Task-<id>` is the canonical label the rest of the UI uses for a Task it
  // can name but not read — never an invented title. It is reachable only from
  // a list that has not answered, since a fresh one that does not hold the id
  // has already ruled it out above.
  return {
    taskId: only,
    title: taskIndex(lists).get(only)?.title ?? `Task-${only}`,
  };
}

function taskIndex(lists: PullRequestReviewLists): Map<string, TaskSummary> {
  return new Map((lists.tasks.rows ?? []).map((task) => [task.id, task]));
}

/** Task ids claiming a session that runs in this checkout, or `"unknown"`. */
function claimingTaskIds(
  worktreeId: string,
  lists: PullRequestReviewLists,
): string[] | "unknown" {
  if (!lists.sessions.fresh || !lists.tasks.fresh) return "unknown";
  const inWorktree = new Set(
    (lists.sessions.rows ?? [])
      .filter((session) => session.worktreeId === worktreeId)
      .map((session) => session.id),
  );
  if (inWorktree.size === 0) return [];
  return (lists.tasks.rows ?? [])
    .filter((task) =>
      (task.sessionRefs ?? []).some((ref) => inWorktree.has(ref.sessionId)),
    )
    .map((task) => task.id);
}

/**
 * The review draft for a pull request. Everything in it is a FACT from the
 * inventory item the button was on — number, title, repository, the range and
 * the URL — because the agent lands in a checkout and prose is all it gets to
 * know which change it is looking at. Deliberately short and editable, like the
 * `/review` draft: it is a prefilled prompt, not a hidden injection.
 */
export function buildPullRequestReviewPrompt(pullRequest: {
  number: number;
  title: string;
  url: string;
  repositoryKey: string;
  baseBranch: string;
  headBranch: string;
}): string {
  return (
    `Review pull request #${pullRequest.number} of ${pullRequest.repositoryKey}: ` +
    `"${pullRequest.title}".\n\n` +
    `This worktree stands on its head branch \`${pullRequest.headBranch}\`; ` +
    `the change is the range \`${pullRequest.baseBranch}...${pullRequest.headBranch}\` ` +
    `(\`git diff ${pullRequest.baseBranch}...${pullRequest.headBranch}\`). ` +
    `${pullRequest.url}\n\n` +
    "Read the changed code itself and do not modify it. Report what you find " +
    "to me here."
  );
}

export interface ReviewSessionSource {
  sessionId: string;
  /** The worktree the session executes in (its `in_worktree` edge), if any. */
  worktreeId?: string;
  /** The primary Project the session was started with, if linked. */
  projectId?: string;
  /** The Task the session was started from, if any — the strongest Task link. */
  originTask?: { id: string; title: string };
}

/**
 * Context a new session about a SESSION inherits, strongest Task link first:
 * the origin Task, then a single Task claiming the session (`sessionRefs`),
 * then the worktree rule above. The project falls back the same way — the
 * session's own link, its worktree's project, the Task's project.
 */
export function reviewContextForSession(
  source: ReviewSessionSource,
  worktrees: WorktreeRecord[] | null,
  sessions: SessionListItem[],
  tasks: TaskSummary[],
): SessionHandoffContext {
  const record = source.worktreeId
    ? liveWorktree(source.worktreeId, worktrees)
    : undefined;
  const task = source.originTask
    ? { taskId: source.originTask.id, title: source.originTask.title }
    : (unambiguousTask(
        tasks.filter((item) =>
          (item.sessionRefs ?? []).some(
            (ref) => ref.sessionId === source.sessionId,
          ),
        ),
      ) ?? taskForWorktree(record, tasks, sessions));
  const projectId =
    source.projectId ??
    record?.projectId ??
    (task
      ? tasks.find((item) => item.id === task.taskId)?.projectId
      : undefined);
  return {
    ...(source.worktreeId ? { worktreeId: source.worktreeId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(task ? { task } : {}),
  };
}

/**
 * The persona a review session starts as. A worktree implies the coding
 * persona (the caller says which coding persona its picker offers); without
 * one a Developer session cannot be sent at all (it requires a worktree), so
 * that degrades to the generic assistant.
 */
export function reviewAgentType(
  context: Pick<SessionHandoffContext, "worktreeId">,
  codingAgentType: SessionAgentType,
): SessionAgentType {
  if (context.worktreeId) return codingAgentType;
  return codingAgentType === "developer" ? "assistant" : codingAgentType;
}

/** Append the shared convention only when the staged `/review` draft is sent. */
export function appendReviewReportConvention(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes(REVIEW_REPORT_CONVENTION)) return trimmed;
  return `${trimmed}\n\n${REVIEW_REPORT_CONVENTION}`;
}

/**
 * The `/review` draft. The source session id is the ONLY fact that must live
 * in the text — everything else rides as staged context the app already knows.
 * `/review <extra text>` appends the args as a second paragraph. Deliberately
 * short: it is an editable draft, not a hidden injection, and it must not grow
 * into a mini agent config. It states the review FLOW only — that the reviewer
 * sends its review and then ends its turn — never how peer delivery works;
 * `session_send_prompt`'s own description owns that.
 */
export function buildSessionReviewPrompt(
  sessionId: string,
  extraText = "",
): string {
  const base =
    `Code-review the changes made in session \`${sessionId}\`. ` +
    "Focus on the changed code itself. Do not modify code. " +
    "Send your review to that session with session_send_prompt (request a " +
    "response) — it is there to receive it and act on it. Then end your " +
    "turn; its replies reach you as new messages. Iterate by replying until " +
    "you can accept the change, and when you accept, say so explicitly in " +
    "your reply.";
  const extra = extraText.trim();
  return extra ? `${base}\n\n${extra}` : base;
}
