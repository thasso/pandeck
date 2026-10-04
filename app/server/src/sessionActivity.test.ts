/**
 * The Sessions inbox depends on THREE facts this module derives from runtime
 * events, for both harnesses at once: when the current run started (so
 * "Working · 4m" is honest), whether the last run failed (so a failed session is
 * visible without opening it), and which OUTCOMES raise a directly owned
 * session's attention revision — the only thing that pulls a settled session
 * back into the working set — plus the one inbox fact that is not a runtime
 * event at all, a removed worktree settling the sessions that ran in it.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/sessionActivity.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "session-activity-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const {
  installSessionActivityTracking,
  markInterruptedRunsOnBoot,
  sessionRunStartedAt,
} = await import("./sessionActivity.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
type AdapterEvent = import("./session/adapters/contract.ts").AdapterEvent;
type AgentRunResult = import("./session/adapters/contract.ts").AgentRunResult;
type PromptableAdapter =
  import("./session/adapters/contract.ts").PromptableAdapter;

/** A do-nothing adapter whose events the test emits by hand. */
class ScriptedAdapter implements PromptableAdapter {
  readonly provider = "scripted";
  readonly capabilities: import("./session/adapters/contract.ts").ForkCapability =
    { fork: "none", compact: false, steer: false, attachments: false };
  private listeners = new Set<(e: AdapterEvent) => void>();
  subscribe(listener: (e: AdapterEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent): void {
    for (const l of this.listeners) l(event);
  }
  getBinding() {
    return { provider: this.provider, nativeId: "native-1" };
  }
  prompt(): Promise<AgentRunResult> {
    return Promise.resolve({ stopReason: "end" });
  }
  abort(): void {}
  setModel(): void {}
  setReasoning(): void {}
  dispose(): void {
    this.listeners.clear();
  }
}

const uninstall = installSessionActivityTracking();
let counter = 0;

/** A live runtime session plus its persisted metadata row. */
async function liveSession(): Promise<{
  id: string;
  adapter: ScriptedAdapter;
}> {
  const id = `s-${++counter}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant", title: id });
  const adapter = new ScriptedAdapter();
  sessionRuntime.createSession(id, adapter);
  return { id, adapter };
}

afterAll(async () => {
  uninstall();
  await sessionRuntime.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

test("submitting a prompt updates the session, not just finishing the turn", async () => {
  const { id, adapter } = await liveSession();
  sessionStore.updateStats(id, { updatedAt: Date.now() - 60_000 });
  const stale = sessionStore.get(id)?.updatedAt ?? 0;

  adapter.emit({ type: "messageStarted", streamId: "m1" });
  const afterStart = sessionStore.get(id)?.updatedAt ?? 0;
  assert.ok(
    afterStart > stale,
    "the run starting moves the session's activity timestamp, so the inbox re-sorts now",
  );

  sessionStore.updateStats(id, { updatedAt: afterStart + 5_000 });
  adapter.emit({ type: "messageStarted", streamId: "m2" });
  assert.equal(
    sessionStore.get(id)?.updatedAt,
    afterStart + 5_000,
    "the timestamp only ever moves forward",
  );
});

test("putting a session down marks it read: no shelf row can show an unread marker", async () => {
  const settled = await liveSession();
  sessionStore.updateStats(settled.id, { updatedAt: Date.now() });
  sessionStore.setSettled(settled.id, true);
  assert.equal(
    sessionStore.get(settled.id)?.readAt,
    sessionStore.get(settled.id)?.updatedAt,
    "settling reads the session through to its last activity",
  );

  const archived = await liveSession();
  sessionStore.updateStats(archived.id, { updatedAt: Date.now() });
  sessionStore.setArchived(archived.id, true);
  assert.equal(
    sessionStore.get(archived.id)?.readAt,
    sessionStore.get(archived.id)?.updatedAt,
    "archiving does the same",
  );
});

test("a run start is timed, and a failed run is recorded as the session's last error", async () => {
  const { id, adapter } = await liveSession();
  assert.equal(
    sessionRunStartedAt(id),
    undefined,
    "an idle session has no run start time",
  );

  const before = Date.now();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  const startedAt = sessionRunStartedAt(id);
  assert.ok(
    startedAt !== undefined && startedAt >= before,
    "the run start is timed when the runtime goes running",
  );

  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "Provider error: 529 overloaded",
  });
  assert.equal(
    sessionRunStartedAt(id),
    undefined,
    "the run start time is dropped once the run ends",
  );
  assert.equal(
    sessionStore.get(id)?.lastError?.message,
    "Provider error: 529 overloaded",
    "the failure is persisted for the card",
  );
});

test("an aborted run is not a failure", async () => {
  const { id, adapter } = await liveSession();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({ type: "runCompleted", stopReason: "aborted" });
  assert.equal(
    sessionStore.get(id)?.lastError,
    undefined,
    "stopping a turn yourself does not badge the session as failed",
  );
});

test("a new run supersedes the previous failure", async () => {
  const { id, adapter } = await liveSession();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "boom",
  });
  assert.ok(sessionStore.get(id)?.lastError, "failure recorded");

  adapter.emit({ type: "messageStarted", streamId: "m2" });
  assert.equal(
    sessionStore.get(id)?.lastError,
    undefined,
    "starting work clears the stale failure",
  );
});

// The heart of Task-674: Settle acknowledges an OUTCOME, so nothing about a
// session getting on with its work may take that acknowledgement away.
test("a settled session stays settled through its next turn, and wakes on the result", async () => {
  const { id, adapter } = await liveSession();
  sessionStore.setSettled(id, true);
  assert.equal(sessionStore.isSettled(id), true, "settled by the user");

  adapter.emit({ type: "messageStarted", streamId: "m1" });
  assert.equal(
    sessionStore.isSettled(id),
    true,
    "starting the next turn is not news: the session stays on the shelf",
  );
  adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [{ type: "text", text: "a durable answer" }],
    stopReason: "end",
  });
  assert.equal(
    sessionStore.isSettled(id),
    true,
    "and neither is durable content arriving mid-turn",
  );

  adapter.emit({ type: "runCompleted", stopReason: "end" });
  const attention = sessionStore.get(id)?.outcomeAttention;
  assert.equal(attention?.kind, "completed", "the completion is recorded");
  assert.equal(attention?.revision, 1, "as the session's first revision");
  assert.equal(
    attention?.settledRevision,
    0,
    "unacknowledged: the user settled before it happened",
  );
  assert.equal(
    sessionStore.isSettled(id),
    false,
    "so the completion brings the session back into the working set",
  );
});

test("a failure wakes a settled session immediately, before the run's own end", async () => {
  const { id, adapter } = await liveSession();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  sessionStore.setSettled(id, true);

  adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "boom",
  });
  const attention = sessionStore.get(id)?.outcomeAttention;
  assert.equal(attention?.kind, "failed", "the failure is the outcome");
  assert.equal(attention?.revision, 1, "one revision, not two");
  assert.equal(sessionStore.isSettled(id), false, "and it wakes the session");
});

// The reason attention rides the normalized run completion rather than the
// `running -> idle` transition: a synthetic host-command turn also goes idle,
// and a settled session must not be woken by one.
test("a host-command turn raises no attention, however it ends", async () => {
  const { id, adapter } = await liveSession();
  sessionStore.setSettled(id, true);

  adapter.emit({ type: "messageStarted", streamId: "cmd-1" });
  adapter.emit({
    type: "hostCommandResult",
    name: "commit",
    card: {
      kind: "commit",
      id: "cmd-1",
      commit: { renderKind: "commit" } as never,
    },
  });
  assert.equal(
    sessionStore.get(id)?.outcomeAttention,
    undefined,
    "/commit finishing is tool activity, not an outcome",
  );

  adapter.emit({ type: "messageStarted", streamId: "cmd-2" });
  adapter.emit({ type: "hostCommandDiscarded" });
  assert.equal(
    sessionStore.get(id)?.outcomeAttention,
    undefined,
    "and neither is a skipped phase that discards its card",
  );
  assert.equal(
    sessionStore.isSettled(id),
    true,
    "so the session is still settled",
  );
});

test("an aborted run raises no attention: stopping a turn is the user's own decision", async () => {
  const { id, adapter } = await liveSession();
  sessionStore.setSettled(id, true);
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  adapter.emit({ type: "runCompleted", stopReason: "aborted" });

  assert.equal(
    sessionStore.get(id)?.outcomeAttention,
    undefined,
    "no outcome was recorded",
  );
  assert.equal(
    sessionStore.isSettled(id),
    true,
    "so the session is still settled",
  );
});

test("only a directly owned session raises top-level attention", async () => {
  const { getDb } = await import("./db/index.ts");
  /** The spawn edge as each ownership is actually written in production. */
  const spawnAs: Record<string, (parentId: string, childId: string) => void> = {
    manual: () => {},
    coordinator: (parentId, childId) =>
      sessionStore.linkSpawned(parentId, childId),
    "taken-over": (parentId, childId) => {
      sessionStore.linkSpawned(parentId, childId);
      sessionStore.setSpawnedOwnership(childId, "taken-over");
    },
    // An edge from before ownership tracking: no metadata to classify.
    unknown: (parentId, childId) => {
      sessionStore.linkSpawned(parentId, childId);
      getDb()
        .prepare(
          "UPDATE session_links SET metadata_json = NULL WHERE child_session_id = ?",
        )
        .run(childId);
    },
  };
  const wakes: Record<string, boolean> = {
    manual: true,
    "taken-over": true,
    unknown: true,
    coordinator: false,
  };

  for (const [ownership, link] of Object.entries(spawnAs)) {
    const { id, adapter } = await liveSession();
    link((await liveSession()).id, id);
    sessionStore.setSettled(id, true);
    adapter.emit({ type: "messageStarted", streamId: "m1" });
    adapter.emit({ type: "runCompleted", stopReason: "end" });
    assert.equal(
      sessionStore.isSettled(id),
      !wakes[ownership],
      `a ${ownership} session ${wakes[ownership] ? "wakes" : "stays settled"} on completion`,
    );
  }
});

test("a shelved coordinator-owned peer wakes on a failure, and on nothing else", async () => {
  // Put down with its coordinator by a Settle on the cluster, the peer raises
  // no attention of its own — but a failure while it is on the shelf would
  // stay buried under a card that says nothing is wrong, so that one unsettles
  // the peer without a revision: the fold bubbles it, nothing top-level
  // announces it.
  const coordinator = await liveSession();
  const peer = await liveSession();
  sessionStore.linkSpawned(coordinator.id, peer.id);
  sessionStore.setSettled(peer.id, true);

  peer.adapter.emit({ type: "messageStarted", streamId: "m1" });
  peer.adapter.emit({ type: "runCompleted", stopReason: "end" });
  assert.equal(
    sessionStore.isSettled(peer.id),
    true,
    "a completion is the coordinator's to act on; the peer stays put",
  );

  peer.adapter.emit({ type: "messageStarted", streamId: "m2" });
  peer.adapter.emit({
    type: "runCompleted",
    stopReason: "error",
    errorMessage: "boom",
  });
  assert.equal(sessionStore.isSettled(peer.id), false, "a failure wakes it");
  assert.equal(
    sessionStore.get(peer.id)?.outcomeAttention,
    undefined,
    "without a revision: its failure belongs to the cluster, not the top level",
  );
  assert.equal(
    sessionStore.get(peer.id)?.lastError?.message,
    "boom",
    "and the failure it woke for is what the row states",
  );
});

test("an agent-driven parent wakes only after its final expected peer reply", async () => {
  const { peerPromptStore } = await import("./db/peerPromptStore.ts");
  const parent = await liveSession();
  const child = await liveSession();
  const chainId = peerPromptStore.createChain();
  peerPromptStore.enqueue({
    conversationId: `coord-${parent.id}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: parent.id,
    recipientSessionId: child.id,
    prompt: "Report when finished",
    responseRequested: true,
  });
  sessionStore.setSettled(parent.id, true);

  const intermediate = sessionRuntime.prompt(parent.id, "One peer reported", {
    origin: { kind: "agent", agentId: "peer-prompt" },
  });
  parent.adapter.emit({ type: "runCompleted", stopReason: "end" });
  await intermediate;
  assert.equal(
    sessionStore.isSettled(parent.id),
    true,
    "another expected reply keeps an intermediate coordinator wake quiet",
  );

  peerPromptStore.cancelPending(
    child.id,
    "the expected peer reported",
    parent.id,
  );
  const final = sessionRuntime.prompt(parent.id, "The final peer reported", {
    origin: { kind: "agent", agentId: "peer-prompt" },
  });
  parent.adapter.emit({ type: "runCompleted", stopReason: "end" });
  await final;
  assert.equal(
    sessionStore.isSettled(parent.id),
    false,
    "the final expected report raises the coordinator's outcome",
  );
});

test("intermediate parent wakes clear only the unread state they created", async () => {
  const { peerPromptStore } = await import("./db/peerPromptStore.ts");
  const enqueueExpectedReply = (parentId: string, childId: string) => {
    const chainId = peerPromptStore.createChain();
    peerPromptStore.enqueue({
      conversationId: `unread-${parentId}`,
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: parentId,
      recipientSessionId: childId,
      prompt: "Report when finished",
      responseRequested: true,
    });
  };
  const runPeerWake = async (
    parent: Awaited<ReturnType<typeof liveSession>>,
  ) => {
    const turn = sessionRuntime.prompt(
      parent.id,
      "An intermediate peer report",
      {
        origin: { kind: "agent", agentId: "peer-prompt" },
      },
    );
    parent.adapter.emit({ type: "runCompleted", stopReason: "end" });
    // Claude updates and persists its session timestamp after emitting the
    // normalized completion. Reproduce that ordering before the suppression
    // microtask runs, so this test covers both harnesses rather than only pi.
    const afterEvent = sessionStore.get(parent.id)!;
    sessionStore.touch(parent.id, afterEvent.updatedAt + 1);
    await turn;
  };

  const cleanParent = await liveSession();
  const cleanChild = await liveSession();
  enqueueExpectedReply(cleanParent.id, cleanChild.id);
  const cleanBefore = sessionStore.get(cleanParent.id)!;
  sessionStore.markRead(cleanParent.id, cleanBefore.updatedAt);
  await runPeerWake(cleanParent);
  const cleanAfter = sessionStore.get(cleanParent.id)!;
  assert.ok(
    cleanAfter.readAt >= cleanAfter.updatedAt,
    `a read parent does not gain an unread Done state from an intermediate wake (${JSON.stringify({ readAt: cleanAfter.readAt, updatedAt: cleanAfter.updatedAt })})`,
  );

  const unreadParent = await liveSession();
  const unreadChild = await liveSession();
  const unreadBefore = sessionStore.get(unreadParent.id)!;
  sessionStore.updateStats(unreadParent.id, {
    updatedAt: unreadBefore.updatedAt + 1,
  });
  enqueueExpectedReply(unreadParent.id, unreadChild.id);
  await runPeerWake(unreadParent);
  const unreadAfter = sessionStore.get(unreadParent.id)!;
  assert.ok(
    unreadAfter.updatedAt > unreadAfter.readAt,
    "an older unread item remains unread after the automatic wake",
  );
});

test("revisions are monotonic, and a stale settle cannot acknowledge a newer one", async () => {
  const { id, adapter } = await liveSession();
  for (const streamId of ["m1", "m2"]) {
    adapter.emit({ type: "messageStarted", streamId });
    adapter.emit({ type: "runCompleted", stopReason: "end" });
  }
  assert.equal(
    sessionStore.get(id)?.outcomeAttention?.revision,
    2,
    "two completed runs, two revisions",
  );

  // The user is looking at a card rendered after the FIRST completion.
  sessionStore.setSettled(id, true, Date.now(), 1);
  assert.equal(
    sessionStore.isSettled(id),
    false,
    "acknowledging revision 1 leaves revision 2 visible",
  );
  assert.equal(
    sessionStore.get(id)?.outcomeAttention?.settledRevision,
    1,
    "and the acknowledgement is recorded exactly as far as it reached",
  );

  sessionStore.setSettled(id, true, Date.now(), 2);
  assert.equal(sessionStore.isSettled(id), true, "settling what you saw works");

  sessionStore.setSettled(id, true, Date.now(), 99);
  assert.equal(
    sessionStore.get(id)?.outcomeAttention?.settledRevision,
    2,
    "and no client can acknowledge a revision that does not exist yet",
  );
});

// The other order, which two tabs produce all the time: the FRESH
// acknowledgement lands first and the stale one arrives behind it.
test("a late stale settle cannot un-acknowledge what another tab already settled", async () => {
  const { id, adapter } = await liveSession();
  for (const streamId of ["m1", "m2"]) {
    adapter.emit({ type: "messageStarted", streamId });
    adapter.emit({ type: "runCompleted", stopReason: "end" });
  }

  sessionStore.setSettled(id, true, Date.now(), 2);
  assert.equal(sessionStore.isSettled(id), true, "the fresh tab settled it");

  sessionStore.setSettled(id, true, Date.now(), 1);
  assert.equal(
    sessionStore.get(id)?.outcomeAttention?.settledRevision,
    2,
    "the stale tab's older observation cannot move the acknowledgement back",
  );
  assert.equal(
    sessionStore.isSettled(id),
    true,
    "so revision 2 is not resurrected as unseen attention",
  );
});

test("a settle that changes no row reports failure, so the command cannot silently succeed", async () => {
  const { id } = await liveSession();
  assert.equal(
    sessionStore.setSettled("never-existed", true),
    false,
    "an unknown id settles nothing",
  );
  sessionStore.remove(id);
  assert.equal(
    sessionStore.setSettled(id, true),
    false,
    "a tombstoned session settles nothing",
  );
});

test("settling a session leaves archive and read state alone", async () => {
  const { id } = await liveSession();
  sessionStore.setArchived(id, true);
  sessionStore.setSettled(id, true);
  const row = sessionStore.get(id);
  assert.ok(row?.settledAt, "settled");
  assert.ok(row?.archivedAt, "settled and archived stay independent states");
  sessionStore.setSettled(id, false);
  assert.equal(
    sessionStore.get(id)?.settledAt,
    undefined,
    "unsettle clears only settlement",
  );
  assert.ok(sessionStore.get(id)?.archivedAt, "archive survives an unsettle");
});

// The one inbox fact that is not a runtime event, shared by BOTH surfaces that
// remove a checkout (the `/pr` card's cleanup, the worktree page's Remove): the
// live sessions that ran there leave the inbox, and the finished ones are left
// exactly as they are.
test("removing a worktree settles the live sessions that ran in it", async () => {
  const { settleSessionsForRemovedWorktree } =
    await import("./sessionActivity.ts");
  const { linkSessionToWorktree } = await import("./db/worktreeStore.ts");
  const dev = (await liveSession()).id;
  const review = (await liveSession()).id;
  const old = (await liveSession()).id;
  for (const id of [dev, review, old]) linkSessionToWorktree(id, "wt-gone");
  sessionStore.setArchived(old, true);

  await settleSessionsForRemovedWorktree("wt-gone");

  assert.equal(sessionStore.isSettled(dev), true, "the dev session settles");
  assert.equal(
    sessionStore.isSettled(review),
    true,
    "so does the review session beside it — the checkout is gone for both",
  );
  assert.equal(
    sessionStore.isSettled(old),
    false,
    "an archived session is already out of the working set",
  );
});

// The other inbox fact that is not a runtime event: a Workflow Run reached its
// end. A session the run never linked to a checkout needs settlement from the
// terminal run, because no checkout removal can reach it.
const workflowStore = await import("./db/workflowStore.ts");

/** A completed run whose steps were executed by the given sessions, by role. */
function completedRun(sessions: Record<string, string>): number {
  const run = workflowStore.createRun({
    taskId: ++counter,
    recipeId: "code-delivery",
    recipeVersion: 1,
    maxIterations: 2,
    maxReviewPasses: 1,
    actor: { kind: "user" },
  });
  for (const [role, sessionId] of Object.entries(sessions)) {
    const step = workflowStore.appendStep({
      runId: run.id,
      kind: "agent",
      payload: { role },
      actor: { kind: "system" },
    });
    workflowStore.startStep(
      step.id,
      { kind: "session", id: sessionId },
      { kind: "system" },
    );
    workflowStore.completeStep(step.id, {
      status: "completed",
      result: { status: "completed", summary: `${role} done` },
      actor: { kind: "system" },
    });
  }
  workflowStore.setRunLifecycle(run.id, "completed", {
    actor: { kind: "system" },
  });
  return run.id;
}

test("a completed Workflow Run settles the sessions it never gave a checkout", async () => {
  const { settleCompletedWorkflowRunSessions } =
    await import("./sessionActivity.ts");
  const { linkSessionToWorktree } = await import("./db/worktreeStore.ts");
  const coordinator = (await liveSession()).id;
  const implementer = (await liveSession()).id;
  const reviewer = (await liveSession()).id;
  for (const id of [implementer, reviewer]) linkSessionToWorktree(id, "wt-run");
  const runId = completedRun({ coordinator, implementer, reviewer });

  await settleCompletedWorkflowRunSessions(runId);

  assert.equal(
    sessionStore.isSettled(coordinator),
    true,
    "the coordinator session has no checkout to be settled by, so the run's end settles it",
  );
  assert.equal(
    sessionStore.isSettled(implementer),
    false,
    "the sessions that run in the checkout still leave the inbox with it, so cleanup keeps saying exactly what it settles",
  );
  assert.equal(sessionStore.isSettled(reviewer), false, "the same for review");
});

test("the boot catch-up leaves a run session the user has since worked in alone", async () => {
  const { settleCompletedWorkflowRunSessionsOnBoot } =
    await import("./sessionActivity.ts");
  const idle = (await liveSession()).id;
  const revived = (await liveSession()).id;
  const idleRun = completedRun({ coordinator: idle });
  const revivedRun = completedRun({ coordinator: revived });
  // Each session is placed against the end of ITS OWN run. Deriving both from
  // one run's clock would make the test a race: the runs end whenever the
  // machine gets to them, so on a slow one an offset measured from the second
  // run lands AFTER the first ended, and the idle session reads as worked-in.
  const idleEndedAt = workflowStore.getRun(idleRun)!.endedAt!;
  const revivedEndedAt = workflowStore.getRun(revivedRun)!.endedAt!;
  sessionStore.updateStats(idle, { updatedAt: idleEndedAt - 1_000 });
  sessionStore.updateStats(revived, { updatedAt: revivedEndedAt + 1_000 });

  await settleCompletedWorkflowRunSessionsOnBoot();

  assert.equal(
    sessionStore.isSettled(idle),
    true,
    "a run that completed before this rule existed catches up at boot",
  );
  assert.equal(
    sessionStore.isSettled(revived),
    false,
    "activity since the run ended means the user pulled it back; a restart must not take it away again",
  );
});

/**
 * A turn the previous process died inside. Nothing in the transcript records it
 * — both harnesses flush a turn's entries only when it completes — so the boot
 * sweep is the only thing that can tell the user which sessions are waiting.
 */
test("boot marks the sessions holding a turn that never finished", async () => {
  const cut = await liveSession();
  const finished = await liveSession();
  const archived = await liveSession();

  // Open a turn on each, then close only one: exactly the state a crash leaves.
  cut.adapter.emit({ type: "messageStarted", streamId: "m1" });
  archived.adapter.emit({ type: "messageStarted", streamId: "m1" });
  finished.adapter.emit({ type: "messageStarted", streamId: "m1" });
  finished.adapter.emit({
    type: "messageCompleted",
    streamId: "m1",
    content: [],
  });
  finished.adapter.emit({ type: "runCompleted", stopReason: "end" });
  sessionStore.setArchived(archived.id, true);

  const marked = markInterruptedRunsOnBoot();
  assert.ok(marked >= 1);
  assert.ok(
    sessionStore.get(cut.id)?.interruptedRunAt !== undefined,
    "the cut turn is recorded",
  );
  assert.equal(
    sessionStore.get(finished.id)?.interruptedRunAt,
    undefined,
    "a turn that closed is not",
  );
  assert.equal(
    sessionStore.get(archived.id)?.interruptedRunAt,
    undefined,
    "and an archived session is out of the working set, so a badge there is noise",
  );
});

test("a settled session is out of scope, and cannot be a false negative either", async () => {
  const settled = await liveSession();
  settled.adapter.emit({ type: "messageStarted", streamId: "m1" });
  // Putting it down AFTER the turn opened is the only way to reach this state by
  // hand; a real run start would have reactivated it (`reactivate`), which is
  // exactly why skipping settled sessions loses nothing that was running.
  sessionStore.setSettled(settled.id, true);

  markInterruptedRunsOnBoot();

  assert.equal(
    sessionStore.get(settled.id)?.interruptedRunAt,
    undefined,
    "the user put this one down; a badge on it is noise",
  );
});

test("the next run start clears the interrupted mark, whether or not it succeeds", async () => {
  const { id, adapter } = await liveSession();
  adapter.emit({ type: "messageStarted", streamId: "m1" });
  markInterruptedRunsOnBoot();
  assert.ok(sessionStore.get(id)?.interruptedRunAt !== undefined);

  // The user sends "continue": the session goes idle→running again. STARTING is
  // the whole condition — by now they are looking at the session, and a
  // continuation that fails on its own terms has `lastError` to say so.
  adapter.emit({ type: "messageCompleted", streamId: "m1", content: [] });
  adapter.emit({ type: "runCompleted", stopReason: "end" });
  adapter.emit({ type: "messageStarted", streamId: "m2" });
  assert.equal(
    sessionStore.get(id)?.interruptedRunAt,
    undefined,
    "a started run releases the badge",
  );
});
