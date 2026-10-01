/**
 * The ONE place that turns live runtime events into the Sessions inbox's
 * lifecycle facts: when the current run started (in memory, because run state is
 * never persisted), whether the last run failed (persisted, so a failure is
 * still visible after a restart), and which OUTCOMES raise a session's durable
 * attention revision.
 *
 * Attention is event-based (Task-674): a user-facing PROVIDER RUN outcome
 * raises a revision, and nothing else here does. Coordinator-owned children
 * and intermediate peer-driven parent wakes are not user-facing outcomes. A
 * turn starting, streaming, tool activity, a synthetic host command, a
 * durable entry landing, reading the transcript or routing to the session are
 * all deliberately silent, so a settled session can run its next turn without
 * climbing back out of the shelf and only its result brings it back.
 *
 * It listens on the harness-neutral `sessionRuntime` event feed, so pi and
 * Claude SDK sessions behave identically and no harness has to remember to
 * report any of this itself. The facts that are not runtime events live here
 * too, for the same reason — one place decides what moves a session in and out
 * of the inbox: {@link settleSessionsForRemovedWorktree} for a removed
 * checkout, {@link settleCompletedWorkflowRunSessions} for a Workflow Run that
 * reached its end.
 */
import { attentionUnknownReason } from "./attentionAvailability.ts";
import {
  settleBlockedReason,
  spawnClusterDescendantIds,
  spawnClusterForest,
  spawnClusterMembers,
  spawnClusterSettleBlockedReason,
  type SessionOutcomeKind,
  type WorkflowRunCard,
} from "@assistant/shared";
import type { AgentStopReason, PromptOrigin } from "@assistant/shared/session";
import { sessionRuntime } from "./session/runtimeInstance.ts";
import {
  subscribeSessionRunCompleted,
  subscribeSessionRunStarted,
} from "./session/runtime/liveSession.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { sessionRunOutcomeDisposition } from "./sessionOutcomePolicy.ts";
import {
  listRuns,
  listSteps,
  type WorkflowRunRow,
} from "./db/workflowStore.ts";
import {
  liveSessionIdsForWorktree,
  sessionIdsForWorktree,
  worktreeIdForSession,
} from "./db/worktreeStore.ts";
import { workflowRunCardFor, workflowRunSummaryOf } from "./workflowRuns.ts";

/** Run start times for currently running sessions; volatile by design. */
const runStartedAt = new Map<string, number>();

/** The unread boundary before each current run touched its session row. */
const runReadBaselines = new Map<
  string,
  { updatedAt: number; readAt: number }
>();

/** When the given session's current run started, if it is running right now. */
export function sessionRunStartedAt(sessionId: string): number | undefined {
  return runStartedAt.get(sessionId);
}

/**
 * A finished PROVIDER RUN becomes one attention revision when its result is the
 * user's own.
 *
 * The signal is `subscribeSessionRunCompleted`, deliberately NOT the
 * `runStateChanged: idle` transition. Idle is a superset: a synthetic host
 * command (`/commit`, a `/pr` phase that skipped) ends its wrapper turn by
 * going idle without any provider run, and waking a settled session for one
 * would be exactly the tool activity this feature promises to ignore. The
 * runtime already normalizes the real thing and reports its `stopReason`, which
 * is also why no verdict has to be tracked across events here.
 *
 * `aborted` raises nothing — stopping your own turn is not news to you — and
 * every other reason is an outcome: `error` is the failure the card states,
 * anything else is a completion.
 *
 * A coordinator-owned spawned child raises nothing either: its result belongs
 * to the run above it. A child failure still unshelves a child that was settled
 * with its coordinator, without raising a top-level revision, so the fold can
 * surface that failure. Nor does a successful agent-driven parent wake while
 * another peer reply it requested is still outstanding. That wake clears only
 * the unread state it introduced. The parent raises one outcome after the final
 * expected report, while a direct human turn or a failure remains its own
 * outcome.
 */
function broadcastSessionList(): void {
  void (async () => {
    // Imported here, not at module scope: `hub.ts` reaches back into this
    // module through `sessions.ts`.
    const { hub } = await import("./hub.ts");
    await hub.broadcastSessions();
  })().catch(() => undefined);
}

/**
 * Clear only the unread state this intermediate automatic turn created.
 * Anything already unread when the turn began remains unread unless the user
 * read through that older boundary while the turn was running.
 */
function suppressIntermediateUnread(
  sessionId: string,
  baseline: { updatedAt: number; readAt: number } | undefined,
): void {
  if (!baseline) return;
  const current = sessionStore.get(sessionId);
  if (!current) return;
  const priorUnreadStillOutstanding =
    baseline.updatedAt > baseline.readAt && current.readAt < baseline.updatedAt;
  if (priorUnreadStillOutstanding) return;
  if (sessionStore.markRead(sessionId, current.updatedAt))
    broadcastSessionList();
}

function recordRunOutcome(
  sessionId: string,
  stopReason: AgentStopReason,
  origin: PromptOrigin | undefined,
): void {
  const baseline = runReadBaselines.get(sessionId);
  runReadBaselines.delete(sessionId);
  const disposition = sessionRunOutcomeDisposition(
    sessionId,
    stopReason,
    origin,
  );
  if (disposition === "intermediate-peer-wake") {
    // Claude persists its completion timestamp immediately AFTER emitting the
    // normalized completion. Wait for that synchronous finishTurn tail, then
    // read the final timestamp instead of marking only through the run start.
    queueMicrotask(() => suppressIntermediateUnread(sessionId, baseline));
    return;
  }
  if (disposition === "coordinator-owned") {
    if (
      stopReason === "error" &&
      sessionStore.isSettled(sessionId) &&
      sessionStore.setSettled(sessionId, false)
    )
      broadcastSessionList();
    return;
  }
  if (disposition !== "raise") return;
  const kind: SessionOutcomeKind =
    stopReason === "error" ? "failed" : "completed";
  if (sessionStore.recordSessionOutcome(sessionId, kind) === undefined) return;
  // The row's own `runStateChanged` already asks for a session-list broadcast,
  // but this must not DEPEND on that ordering: a new revision is a change to
  // the row every subscribed tab has to converge on, so it asks for its own.
  // `broadcastSessions` is debounced and idempotent, so the two coalesce.
  broadcastSessionList();
}

let installed = false;

/**
 * Subscribe to the runtime event feed and to normalized run completions. Called
 * once at boot; the returned unsubscribe exists for tests. Repeated calls are
 * ignored so a second boot path cannot double-count run starts.
 */
export function installSessionActivityTracking(): () => void {
  if (installed) return () => {};
  installed = true;
  const unsubscribe = sessionRuntime.subscribeEvents((sessionId, event) => {
    switch (event.type) {
      case "runStateChanged": {
        if (event.runState === "running") {
          const startedAt = Date.now();
          runStartedAt.set(sessionId, startedAt);
          // A new run supersedes the previous one's failure MESSAGE, and it is
          // an UPDATE to the session: the prompt that started it is already
          // part of the conversation, so the list must re-sort now rather than
          // when the turn happens to finish. It is deliberately NOT attention:
          // a settled session stays settled while its next turn runs.
          sessionStore.touch(sessionId, startedAt);
          sessionStore.clearRunFailure(sessionId);
          // A started run is the user acting on the interrupted turn (or moving
          // past it); either way the badge has done its job.
          sessionStore.clearInterruptedRun(sessionId);
        } else {
          runStartedAt.delete(sessionId);
          // Provider completion follows this idle event in the same call stack
          // and consumes the baseline. Synthetic host turns have no completion,
          // so discard theirs after that stack unwinds. A synchronously chained
          // run replaces the boundary and keeps `runStartedAt` present.
          queueMicrotask(() => {
            if (!runStartedAt.has(sessionId))
              runReadBaselines.delete(sessionId);
          });
        }
        return;
      }
      case "runStatus": {
        // The failure MESSAGE the card shows. `aborted` is a user decision, not
        // a failure worth badging. Attention is NOT raised here: the run's own
        // normalized completion carries the same verdict, and raising it twice
        // would spend two revisions on one outcome.
        if (event.status === "error")
          sessionStore.recordRunFailure(
            sessionId,
            event.message ?? "The agent run failed.",
          );
        return;
      }
      default:
        return;
    }
  });
  const unsubscribeStarted = subscribeSessionRunStarted((sessionId) => {
    const before = sessionStore.get(sessionId);
    if (before)
      runReadBaselines.set(sessionId, {
        updatedAt: before.updatedAt,
        readAt: before.readAt,
      });
  });
  const unsubscribeCompleted = subscribeSessionRunCompleted(recordRunOutcome);
  return () => {
    installed = false;
    runStartedAt.clear();
    runReadBaselines.clear();
    unsubscribeCompleted();
    unsubscribeStarted();
    unsubscribe();
  };
}

/**
 * The other direction, for the one event that is not a runtime event: a
 * WORKTREE was removed, so the sessions that ran in it have nothing left to
 * show for it and leave the inbox.
 *
 * Both removal surfaces call this — the `/pr` card's cleanup and the worktree
 * page's Remove — so "the checkout is gone, what happens to its sessions" has
 * ONE answer. Only live sessions are settled (a settled or archived one is
 * already gone from the working set), while EVERY linked session is refreshed:
 * a session viewing a dead worktree must raise its `worktreeMissing` banner
 * whether or not it settles. Settling is soft — the session's next OUTCOME
 * pulls it straight back — so nothing here is lost by acting on a session the
 * user is about to acknowledge into the app directory.
 */
export async function settleSessionsForRemovedWorktree(
  worktreeId: string,
): Promise<void> {
  const linked = sessionIdsForWorktree(worktreeId);
  for (const sessionId of liveSessionIdsForWorktree(worktreeId))
    sessionStore.setSettled(sessionId, true);
  // Imported here, not at module scope: `hub.ts` reaches back into this module
  // through `sessions.ts`.
  const { hub } = await import("./hub.ts");
  for (const sessionId of linked) hub.getLiveById(sessionId)?.broadcastState();
  if (linked.length) await hub.broadcastSessions();
}

/**
 * The same direction for a WORKFLOW RUN that reached its end: the run completed,
 * so the sessions it created that never had a checkout of their own have nothing
 * left to do and leave the inbox. Code-delivery roles, including the coordinator,
 * all belong to the run's checkout and leave the inbox with it instead.
 *
 * A completed run is terminal, so no later step can ever assign a run-only
 * session again. Implementer, reviewer, and coordinator sessions are NOT settled
 * here: they run in the run's worktree and leave the inbox with it
 * ({@link settleSessionsForRemovedWorktree}), which is also the consequence both
 * removal surfaces state before the click. So each session settles with the
 * thing it actually belongs to, and one worktree cleanup keeps meaning exactly
 * "the sessions that ran in this checkout".
 *
 * Nothing is destroyed here, so a session that is somehow still busy is SKIPPED
 * rather than refusing anything: it answers the same `settleBlockedReason`
 * predicate every other settlement surface uses, and settling is soft — the
 * session's next outcome pulls it straight back.
 */
export async function settleCompletedWorkflowRunSessions(
  runId: number,
): Promise<void> {
  await settleIdleSessions(runOnlySessionIds(runId));
}

/**
 * The cascade a Settle on a run promises (Task-677): the sessions the run's
 * card projection names leave the inbox with it, each acknowledged through its
 * CURRENT outcome revision — the server-side privilege, taken here because the
 * user acknowledged the run that owns them.
 *
 * Deliberately NOT {@link settleIdleSessions}: that helper re-asks the shared
 * predicate per session and yields to the event loop while it does, which is
 * exactly the window in which a role could start a turn and be skipped after
 * the run was already acknowledged. The caller has refused the whole Settle
 * for any blocked role BEFORE writing anything, so this writes every role
 * synchronously — no recheck, no await — and only then broadcasts, resolving
 * once the session list has actually been flushed to every tab. Settling
 * stays soft: any later outcome pulls a settled role straight back.
 */
export async function settleWorkflowRunRoleSessions(
  sessionIds: readonly string[],
): Promise<void> {
  const settled = sessionIds.filter((sessionId) =>
    sessionStore.setSettled(sessionId, true),
  );
  if (settled.length === 0) return;
  // Imported here, not at module scope: `hub.ts` reaches back into this module
  // through `sessions.ts`.
  const { hub } = await import("./hub.ts");
  for (const sessionId of settled) hub.getLiveById(sessionId)?.broadcastState();
  await hub.broadcastSessions();
}

/**
 * The same cascade for a COORDINATOR the user settled from its own row: the
 * peers it still owns leave the inbox with it. Membership is the shared spawn
 * forest over the same projected rows the browser folds — unarchived, minus
 * the roles of every working-set Workflow Run — so what the card showed folded
 * is exactly what leaves, and the refusal is the same aggregate reason the
 * card disabled its Settle with ({@link spawnClusterSettleBlockedReason}):
 * the coordinator's own, else the first blocked peer's, in forest order.
 *
 * Answers one of three things. `blocked`: nothing was written, and the reason
 * is the shared wording. `written: false`: the preflight passed but the store
 * could not update every row, and — because the write is ONE transaction
 * ({@link sessionStore.settleWithPeers}) — none of them changed. `written:
 * true`: coordinator and peers are down, and the session list has been
 * flushed to every tab. Between the preflight's list read and the write there
 * is no await, so no peer can start a turn in between; settling stays soft
 * regardless, since a peer's later failure unsettles it
 * ({@link recordRunOutcome}).
 */
export async function settleSessionWithPeers(
  sessionId: string,
  throughRevision: number,
): Promise<{ blocked: string } | { written: boolean }> {
  // Imported here, not at module scope: `hub.ts` reaches back into this module
  // through `sessions.ts`.
  const { hub } = await import("./hub.ts");
  const rows = await hub.listSessions({ includeArchived: true });
  if (!rows.some((row) => row.id === sessionId))
    return { blocked: "it could not be resolved." };
  // Attention that cannot be read is not absent: refuse rather than settle a
  // cluster that may hold an unanswered approval or Task pick.
  const unknown = attentionUnknownReason();
  if (unknown) return { blocked: unknown };
  const runs = listRuns();
  const cards: Record<string, WorkflowRunCard> = {};
  for (const run of runs) {
    const card = workflowRunCardFor(run);
    if (card) cards[String(run.id)] = card;
  }
  const members = spawnClusterMembers(
    rows,
    runs.map(workflowRunSummaryOf),
    cards,
  );
  const forest = spawnClusterForest(members);
  // Every projected row, not only the members: a coordinator that is no
  // member itself — archived, or a run's role — still answers its own reason.
  const blocked = spawnClusterSettleBlockedReason(
    sessionId,
    new Map(rows.map((row) => [row.id, row])),
    forest,
  );
  if (blocked) return { blocked };
  const peers = spawnClusterDescendantIds(sessionId, forest);
  if (!sessionStore.settleWithPeers(sessionId, throughRevision, peers))
    return { written: false };
  for (const id of [sessionId, ...peers]) hub.getLiveById(id)?.broadcastState();
  await hub.broadcastSessions();
  return { written: true };
}

/**
 * Catch up runs that completed while this rule did not exist yet, beside the
 * other boot reconcilers. A completed run's coordinator session can never be
 * assigned again, so it belongs on the shelf however long ago the run ended.
 *
 * The activity guard is what makes repeating this at every boot safe: a session
 * that has been touched SINCE its run ended was pulled back into the working set
 * by something the user did, and settling it again would take it away from them
 * on the next restart.
 */
export async function settleCompletedWorkflowRunSessionsOnBoot(): Promise<void> {
  for (const run of listRuns({ lifecycles: ["completed"] }))
    await settleIdleSessions(
      runOnlySessionIds(run.id).filter((sessionId) =>
        untouchedSinceRunEnded(sessionId, run),
      ),
    );
}

/**
 * Record which sessions hold a turn the previous process died inside, so the
 * session list can show it. Returns how many were marked.
 *
 * Called ONCE at boot, before anything is live. That ordering is what makes the
 * answer honest: while the server is up, a log ending on an open run bracket is
 * just a turn that is still going, and only a process that never closed one
 * leaves the bracket behind.
 *
 * Scoped to the inbox WORKING SET — not archived, not settled — because a badge
 * on a session the user has put down is noise nobody will act on. That scope is
 * also what keeps this affordable: it is a handful of logs walked backwards,
 * not every transcript on disk.
 *
 * Settlement is asked EFFECTIVELY ({@link sessionStore.isSettled}), which
 * matters more since Task-674 than it did when this was written: a settled
 * session may now have been RUNNING when the process died — its next turn no
 * longer wakes it — so "settled" here means "put down, and no outcome raised
 * since", the same conjunction the list projects. The interrupted run itself
 * raises no attention: it produced no outcome, and inventing one would announce
 * a result that never happened.
 */
export function markInterruptedRunsOnBoot(): number {
  let marked = 0;
  for (const meta of sessionStore.list()) {
    if (meta.archivedAt !== undefined || sessionStore.isSettled(meta.id))
      continue;
    const at = sessionRuntime.interruptedRunAt(meta.id);
    if (at === undefined) continue;
    sessionStore.recordInterruptedRun(meta.id, at);
    marked += 1;
  }
  return marked;
}

/** Settle the ones that may leave, and broadcast only if any of them did. */
async function settleIdleSessions(sessionIds: string[]): Promise<void> {
  const settled: string[] = [];
  for (const sessionId of sessionIds) {
    if (await sessionSettleBlockedReason(sessionId)) continue;
    if (sessionStore.setSettled(sessionId, true)) settled.push(sessionId);
  }
  if (settled.length === 0) return;
  // Imported here, not at module scope: `hub.ts` reaches back into this module
  // through `sessions.ts`.
  const { hub } = await import("./hub.ts");
  for (const sessionId of settled) hub.getLiveById(sessionId)?.broadcastState();
  await hub.broadcastSessions();
}

/**
 * The run's still-live sessions that hold no worktree edge — the ones no
 * checkout removal will ever settle. Settled, archived and deleted sessions are
 * already out of the working set.
 */
function runOnlySessionIds(runId: number): string[] {
  const seen = new Set<string>();
  for (const step of listSteps(runId))
    if (step.executor?.kind === "session") seen.add(step.executor.id);
  return [...seen].filter((sessionId) => {
    if (worktreeIdForSession(sessionId)) return false;
    // `get` already hides deleted sessions; `isSettled` is the EFFECTIVE
    // question, so a session woken by its own outcome counts as still in the
    // working set even though it carries a settlement mark.
    const session = sessionStore.get(sessionId);
    return Boolean(
      session && !session.archivedAt && !sessionStore.isSettled(sessionId),
    );
  });
}

/** Whether nothing has happened on this session since its run ended. */
function untouchedSinceRunEnded(
  sessionId: string,
  run: WorkflowRunRow,
): boolean {
  const session = sessionStore.get(sessionId);
  const endedAt = run.endedAt ?? run.updatedAt;
  return Boolean(session && session.updatedAt <= endedAt);
}

/**
 * Why a session may NOT leave the inbox yet, in the shared wording, or
 * `undefined` when it may.
 *
 * The SAME projected row the browser saw, archived rows included, exactly as
 * `connection.onSettleSession` evaluates it: "still running" is not the only
 * thing that is not done enough to leave — a queued prompt and a pending
 * approval/question are not either. A session that projects to no row at all is
 * not blocked — it is not running and has nothing queued — unless a card store
 * is unavailable, which blocks every session alike.
 */
export async function sessionSettleBlockedReason(
  sessionId: string,
): Promise<string | undefined> {
  const { hub } = await import("./hub.ts");
  const row = (
    await hub.listSessions({
      includeArchived: true,
      onlyIds: new Set([sessionId]),
    })
  ).find((item) => item.id === sessionId);
  // No projected row is not proof of nothing pending: a persisted session
  // outside the default list scope (a run's internal role) projects none, yet
  // an unavailable card store may still hold its approval.
  if (!row) return attentionUnknownReason();
  return settleBlockedReason(row) ?? attentionUnknownReason();
}

/**
 * The same question asked of a whole CHECKOUT: why the sessions still live in
 * it may not have it taken away yet, or `undefined` when it may go.
 *
 * Removing a worktree settles those sessions ({@link
 * settleSessionsForRemovedWorktree}), so both removal surfaces owe them this
 * predicate before any git side effect — settling a session that is mid-run,
 * or holding a queued prompt or an unanswered approval, would be settling work
 * that is not done. One list read for all of them; the first blocker answers.
 */
export async function worktreeSettleBlockedReason(
  worktreeId: string,
): Promise<string | undefined> {
  const live = liveSessionIdsForWorktree(worktreeId);
  if (live.length === 0) return undefined;
  // Removal settles these sessions; unreadable attention blocks that.
  const unknown = attentionUnknownReason();
  if (unknown) return unknown;
  const { hub } = await import("./hub.ts");
  const rows = await hub.listSessions({
    includeArchived: true,
    onlyIds: new Set(live),
  });
  for (const sessionId of live) {
    const row = rows.find((item) => item.id === sessionId);
    const blocked = row ? settleBlockedReason(row) : undefined;
    if (blocked) return blocked;
  }
  return undefined;
}
