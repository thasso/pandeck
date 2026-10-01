import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import type {
  AcceptInitialSubagentInput,
  FrozenSubagentProfile,
  SubagentRun,
  SubagentStateChange,
} from "./subagentStore.ts";

const dataDir = mkdtempSync(join(tmpdir(), "subagent-store-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const {
  SUBAGENT_PUBLIC_WRITE_PATHS,
  SubagentCapacityError,
  SubagentValidationError,
  setSubagentStateChangeNotifier,
  subagentStore,
} = await import("./subagentStore.ts");
const { sessionStore } = await import("./sessionStore.ts");
const { peerPromptStore } = await import("./peerPromptStore.ts");
const { getDb } = await import("./index.ts");

const profile: FrozenSubagentProfile = {
  roleName: "implementer",
  baseRole: "developer",
  provider: "openai-codex",
  modelId: "gpt-5.6",
  credentialProfileId: "openai-work",
  accountSource: "role-slot",
  defaultThinking: "high",
  hardMaxThinking: "xhigh",
  executionProfileId: "developer-build-v1",
  contractId: "implementation-result",
  contractVersion: 1,
};

let serial = 0;
function sessionId(kind: string): string {
  serial += 1;
  return `${kind}-${Date.now()}-${serial}`;
}

function makeParent(id = sessionId("parent")): string {
  assert.equal(
    sessionStore.upsert({
      id,
      scope: "user",
      harness: "pi",
      agentType: "developer",
    }),
    true,
  );
  return id;
}

function makeChild(id = sessionId("child")): string {
  assert.equal(
    sessionStore.upsert({
      id,
      scope: "subagent",
      harness: "pi",
      agentType: "developer",
      credentialProfileId: profile.credentialProfileId,
    }),
    true,
  );
  return id;
}

function initialInput(
  parentSessionId: string,
  childSessionId: string,
  parentLimit: number,
  suffix = sessionId("admission"),
): AcceptInitialSubagentInput {
  return {
    thread: {
      id: `thread-${suffix}`,
      parentSessionId,
      sessionId: childSessionId,
      profile,
      linkage: {
        cwd: "/tmp/worktree",
        worktreeId: `worktree-${suffix}`,
        worktreeRelation: "managed",
        worktreeProvenance: { owner: "workflow" },
        taskId: 493,
        projectId: "personal-assistant",
      },
    },
    run: {
      id: `run-${suffix}`,
      initiatedBy: "human",
      actualThinking: "high",
      phase: "pending-dispatch",
    },
    parentLimit,
  };
}

function terminalize(
  run: SubagentRun,
  status: "failed" | "lost" | "unreported" = "failed",
): SubagentRun {
  subagentStore.recordQuiescence(run.id, `quiescent-${run.id}`);
  return subagentStore.finalizeRun({
    runId: run.id,
    status,
    reason: "test cleanup",
  });
}

function revisionOf(kind: "thread" | "run", id: string): number {
  const row =
    kind === "thread" ? subagentStore.getThread(id) : subagentStore.getRun(id);
  assert.ok(row, `${kind} ${id} must exist`);
  return row.revision;
}

function assertRevisionMoved(
  kind: "thread" | "run",
  id: string,
  before: number,
): void {
  assert.ok(
    revisionOf(kind, id) > before,
    `${kind} ${id} revision did not move`,
  );
}

test("initial acceptance freezes a complete profile and rejects ineligible or partial sessions", () => {
  const parent = makeParent();
  const child = makeChild();
  sessionStore.setArchived(parent, true, 11);
  sessionStore.setSettled(parent, true, 12);
  const accepted = subagentStore.acceptInitial(initialInput(parent, child, 2));

  const thread = subagentStore.getThread(accepted.thread.id)!;
  const run = subagentStore.getRun(accepted.run.id)!;
  assert.deepEqual(thread.profile, profile);
  assert.equal(thread.sessionId, child);
  assert.equal(
    subagentStore.getThreadBySessionId(child)?.id,
    accepted.thread.id,
  );
  assert.match(thread.peerConversationId, /^subagent-peer:thread-/);
  assert.deepEqual(
    subagentStore.listThreads({ search: "%" }),
    [],
    "LIKE metacharacters in user search are treated literally",
  );
  assert.equal(run.contractId, profile.contractId);
  assert.equal(run.contractVersion, profile.contractVersion);
  assert.equal(thread.inheritedArchivedAt, 11);
  assert.equal(thread.inheritedSettledAt, 12);
  assert.deepEqual(run.openingUsage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.ok(thread.revision > 0);
  assert.equal(thread.revision, run.revision);

  assert.throws(
    () =>
      subagentStore.acceptInitial({
        ...initialInput(parent, makeChild(), 2),
        thread: {
          ...initialInput(parent, makeChild(), 2).thread,
          sessionId: makeChild(),
          profile: { ...profile, modelId: "" },
        },
      }),
    SubagentValidationError,
  );

  const subagentParent = makeChild();
  assert.throws(
    () =>
      subagentStore.acceptInitial(initialInput(subagentParent, makeChild(), 2)),
    /cannot own another subagent thread/,
  );

  const internalParent = sessionId("internal-parent");
  sessionStore.upsert({
    id: internalParent,
    scope: "internal",
    harness: "pi",
    agentType: "developer",
  });
  assert.throws(
    () =>
      subagentStore.acceptInitial(initialInput(internalParent, makeChild(), 2)),
    /not a durable workflow executor/,
  );

  terminalize(run);
});

// Settlement is inherited EFFECTIVELY (Task-674): the parent carries a
// settlement mark, but an outcome raised after it already put the parent back
// in the user's working set, so a thread accepted now must not be born claiming
// its parent was put down.
test("a thread does not inherit a settlement its parent's outcome superseded", () => {
  const parent = makeParent();
  const child = makeChild();
  sessionStore.setSettled(parent, true, 12);
  sessionStore.recordSessionOutcome(parent, "completed", 13);
  assert.equal(sessionStore.isSettled(parent), false, "the parent is awake");

  const accepted = subagentStore.acceptInitial(initialInput(parent, child, 2));
  assert.equal(
    subagentStore.getThread(accepted.thread.id)?.inheritedSettledAt,
    undefined,
    "so nothing about that stale mark is inherited",
  );
});

test("injected parent capacity and the one-active-run invariant are durable", () => {
  const parent = makeParent();
  const first = subagentStore.acceptInitial(
    initialInput(parent, makeChild(), 2),
  );
  const second = subagentStore.acceptInitial(
    initialInput(parent, makeChild(), 2),
  );
  assert.throws(
    () => subagentStore.acceptInitial(initialInput(parent, makeChild(), 2)),
    SubagentCapacityError,
  );
  assert.throws(
    () =>
      subagentStore.acceptContinuation({
        threadId: first.thread.id,
        parentLimit: 3,
        run: { initiatedBy: "agent", actualThinking: "medium" },
      }),
    /already has active run/,
  );

  terminalize(first.run);
  const continuation = subagentStore.acceptContinuation({
    threadId: first.thread.id,
    parentLimit: 2,
    run: {
      initiatedBy: "agent",
      actualThinking: "medium",
      optionalResultCorrelationId: "peer-result-1",
    },
  });
  assert.equal(continuation.sequence, 2);
  assert.equal(continuation.contractId, profile.contractId);
  assert.equal(continuation.optionalResultCorrelationId, "peer-result-1");

  assert.throws(
    () =>
      subagentStore.acceptContinuation({
        threadId: first.thread.id,
        parentLimit: 0,
        run: { initiatedBy: "human", actualThinking: "high" },
      }),
    /positive safe integer/,
  );
  terminalize(continuation);
  terminalize(second.run);
});

test("separate SQLite connections serialize concurrent capacity admission", async () => {
  const parent = makeParent();
  const inputs = [
    initialInput(parent, makeChild(), 1, sessionId("race-a")),
    initialInput(parent, makeChild(), 1, sessionId("race-b")),
  ];
  // Ensure this process has applied every migration before workers race on the
  // same WAL database. Each worker then performs the count and insert under its
  // own BEGIN IMMEDIATE connection.
  getDb();
  const storeUrl = new URL("./subagentStore.ts", import.meta.url).href;
  const script = `
    const input = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
    const { subagentStore } = await import(${JSON.stringify(storeUrl)});
    subagentStore.acceptInitial(input);
  `;
  const runWorker = (input: AcceptInitialSubagentInput) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        Buffer.from(JSON.stringify(input)).toString("base64url"),
      ],
      {
        env: {
          ...process.env,
          DATA_DIR: dataDir,
          ASSISTANT_CWD: dataDir,
        },
      },
    );
  const results = await Promise.allSettled(inputs.map(runWorker));
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(
    subagentStore.listThreads({ parentSessionId: parent }).length,
    1,
  );
});

test("result and stop decisions are irreversible CAS operations with first-writer precedence", () => {
  const parent = makeParent();
  const resultFirst = subagentStore.acceptInitial(
    initialInput(parent, makeChild(), 3),
  ).run;
  assert.throws(
    () =>
      subagentStore.acceptResult({
        runId: resultFirst.id,
        reportedStatus: "completed",
        summary: "x".repeat(4_001),
        payload: null,
        hostFacts: null,
      }),
    /accepted result summary exceeds 4000 characters/,
  );
  const accepted = subagentStore.acceptResult({
    runId: resultFirst.id,
    reportedStatus: "completed",
    summary: "done",
    payload: { commit: "abc" },
    hostFacts: { target: "parent-session" },
  });
  assert.equal(accepted?.activePhase, "result-accepted");
  assert.equal(subagentStore.requestStop(resultFirst.id), undefined);
  subagentStore.recordQuiescence(resultFirst.id, "provider-result-first");
  assert.throws(
    () =>
      subagentStore.finalizeRun({
        runId: resultFirst.id,
        status: "failed",
      }),
    /wins terminalization as submitted/,
  );
  const submitted = subagentStore.finalizeRun({
    runId: resultFirst.id,
    status: "submitted",
    resultMessageId: "peer-result-message-1",
  });
  assert.equal(submitted.status, "submitted");
  assert.deepEqual(submitted.acceptedResult?.payload, { commit: "abc" });
  assert.equal(
    subagentStore.requestStop(resultFirst.id),
    undefined,
    "a terminal row cannot be changed by the stop CAS",
  );

  const stopFirst = subagentStore.acceptInitial(
    initialInput(parent, makeChild(), 3),
  ).run;
  assert.equal(
    subagentStore.requestStop(stopFirst.id, "cancel")?.activePhase,
    "stop-requested",
  );
  assert.equal(
    subagentStore.acceptResult({
      runId: stopFirst.id,
      reportedStatus: "completed",
      summary: "late",
      payload: null,
      hostFacts: null,
    }),
    undefined,
  );
  subagentStore.recordQuiescence(stopFirst.id, "provider-stop-first");
  assert.throws(
    () =>
      subagentStore.finalizeRun({
        runId: stopFirst.id,
        status: "lost",
      }),
    /wins terminalization as stopped/,
  );
  assert.equal(
    subagentStore.finalizeRun({
      runId: stopFirst.id,
      status: "stopped",
    }).status,
    "stopped",
  );
});

test("required parent response correlation and watchdog state remain monotonic", () => {
  const accepted = subagentStore.acceptInitial(
    initialInput(makeParent(), makeChild(), 1),
  );
  const runId = accepted.run.id;
  subagentStore.transitionExecution({
    runId,
    status: "running",
    phase: "provider-admitted",
  });
  const awaiting = subagentStore.awaitParent(runId, "question-message-1");
  assert.deepEqual(awaiting.requiredResponse, {
    messageId: "question-message-1",
    state: "outstanding",
  });
  assert.equal(
    subagentStore.resumeFromParent(runId, "wrong-question", "answer-message-1"),
    undefined,
  );
  subagentStore.recordQuiescence(runId, "question-completion");
  const resumed = subagentStore.resumeFromParent(
    runId,
    "question-message-1",
    "answer-message-1",
  )!;
  assert.deepEqual(resumed.requiredResponse, {
    messageId: "question-message-1",
    state: "answered",
    answerMessageId: "answer-message-1",
  });
  assert.equal(resumed.executionQuiescent, false);
  assert.equal(resumed.quiescenceCompletionId, undefined);

  assert.equal(
    subagentStore.reserveWatchdog(runId, "completion-trigger")?.watchdogState,
    "reserved",
  );
  // Ordinary execution/restart reconciliation cannot reset watchdog state.
  subagentStore.transitionExecution({
    runId,
    status: "running",
    phase: "safe-idle",
  });
  assert.equal(subagentStore.getRun(runId)?.watchdogState, "reserved");
  assert.equal(
    subagentStore.reserveWatchdog(runId, "second-trigger"),
    undefined,
  );
  assert.equal(
    subagentStore.admitWatchdog(runId, "completion-admitted")?.watchdogState,
    "admitted",
  );
  assert.equal(
    subagentStore.completeWatchdog(runId, "completion-finished")?.watchdogState,
    "completed",
  );
  assert.equal(
    subagentStore.getRun(runId)?.quiescenceCompletionId,
    "completion-finished",
  );
  subagentStore.transitionExecution({
    runId,
    status: "running",
    phase: "provider-admitted",
  });
  assert.equal(subagentStore.getRun(runId)?.watchdogState, "completed");
  assert.equal(subagentStore.getRun(runId)?.quiescenceCompletionId, undefined);
  subagentStore.transitionExecution({
    runId,
    status: "running",
    phase: "safe-idle",
  });
  assert.equal(
    subagentStore.getRun(runId)?.executionQuiescent,
    false,
    "a phase label alone cannot revive stale quiescence evidence",
  );
  assert.throws(
    () => subagentStore.finalizeRun({ runId, status: "failed" }),
    /no durable quiescence evidence/,
  );
  subagentStore.recordQuiescence(runId, "newest-provider-completion");
  assert.throws(
    () => subagentStore.recordQuiescence(runId, "conflicting-completion"),
    /already quiescent on different completion evidence/,
  );
  assert.equal(
    subagentStore.admitWatchdog(runId, "completion-retry"),
    undefined,
  );
  subagentStore.finalizeRun({ runId, status: "failed" });

  const abandoned = subagentStore.acceptContinuation({
    threadId: accepted.thread.id,
    parentLimit: 1,
    run: { initiatedBy: "human", actualThinking: "high" },
  });
  subagentStore.transitionExecution({
    runId: abandoned.id,
    status: "running",
    phase: "provider-admitted",
  });
  subagentStore.awaitParent(abandoned.id, "abandoned-question");
  subagentStore.recordQuiescence(abandoned.id, "abandoned-completion");
  const terminal = subagentStore.finalizeRun({
    runId: abandoned.id,
    status: "unreported",
  });
  assert.equal(terminal.requiredResponse, undefined);
});

test("every public write path stamps revisions and emits one post-commit touched set", () => {
  const changes: SubagentStateChange[] = [];
  setSubagentStateChangeNotifier((change) => changes.push(change));
  try {
    const publicReadPaths = [
      "getThread",
      "getThreadBySessionId",
      "getRun",
      "latestRun",
      "activeRun",
      "listThreads",
      "listRuns",
      "parentUsageTotals",
      "delegationSummaries",
      "delegationObligations",
      "threadRevisions",
      "runRevisions",
    ] as const;
    assert.deepEqual(Object.keys(subagentStore), [
      ...SUBAGENT_PUBLIC_WRITE_PATHS,
      ...publicReadPaths,
    ]);
    for (const name of SUBAGENT_PUBLIC_WRITE_PATHS) {
      assert.match(
        subagentStore[name].toString(),
        /\b(?:mutation|watchdogCas)\(/,
        `${name} must enter the transaction-aware revision seam`,
      );
    }

    const parent = makeParent();
    let beforeChanges = changes.length;
    const accepted = subagentStore.acceptInitial(
      initialInput(parent, makeChild(), 2),
    );
    assert.equal(changes.length, beforeChanges + 1);
    assert.deepEqual(changes.at(-1)?.runIds, [accepted.run.id]);
    assert.deepEqual(changes.at(-1)?.threadIds, [accepted.thread.id]);
    assert.deepEqual(changes.at(-1)?.parentSessionIds, [parent]);

    let beforeRun = revisionOf("run", accepted.run.id);
    let beforeThread = revisionOf("thread", accepted.thread.id);
    subagentStore.updateRunGovernance({
      runId: accepted.run.id,
      governingLeaseId: "lease-1",
      predecessorTurnId: "parent-turn-1",
      reviewTarget: { pullRequest: 12 },
    });
    assertRevisionMoved("run", accepted.run.id, beforeRun);
    assertRevisionMoved("thread", accepted.thread.id, beforeThread);

    beforeThread = revisionOf("thread", accepted.thread.id);
    subagentStore.updateThreadLinkage({
      threadId: accepted.thread.id,
      worktreeId: null,
      worktreeRelation: null,
    });
    assertRevisionMoved("thread", accepted.thread.id, beforeThread);

    beforeThread = revisionOf("thread", accepted.thread.id);
    subagentStore.setParentLifecycle(
      parent,
      {
        archivedAt: 100,
        settledAt: 200,
      },
      300,
    );
    assertRevisionMoved("thread", accepted.thread.id, beforeThread);
    assert.equal(
      subagentStore.getThread(accepted.thread.id)?.inheritedArchivedAt,
      100,
    );
    assert.equal(sessionStore.get(parent)?.archivedAt, 100);
    assert.equal(sessionStore.get(accepted.thread.sessionId)?.settledAt, 200);
    assert.equal(
      sessionStore.get(parent)?.readAt,
      sessionStore.get(parent)?.updatedAt,
    );
    assert.equal(
      sessionStore.get(accepted.thread.sessionId)?.readAt,
      sessionStore.get(accepted.thread.sessionId)?.updatedAt,
    );
    subagentStore.setParentLifecycle(
      parent,
      { archivedAt: null, settledAt: null },
      400,
    );
    assert.equal(sessionStore.get(parent)?.archivedAt, undefined);
    assert.equal(
      sessionStore.get(accepted.thread.sessionId)?.settledAt,
      undefined,
    );
    assert.equal(
      sessionStore.get(accepted.thread.sessionId)?.readAt,
      sessionStore.get(accepted.thread.sessionId)?.updatedAt,
      "restore and unsettle do not roll inherited read state back",
    );

    beforeRun = revisionOf("run", accepted.run.id);
    beforeThread = revisionOf("thread", accepted.thread.id);
    subagentStore.recordUsage({
      threadId: accepted.thread.id,
      runId: accepted.run.id,
      completionId: "usage-completion-1",
      cumulative: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costMicros: 42,
      },
      state: "current",
      completeness: "complete",
    });
    assertRevisionMoved("run", accepted.run.id, beforeRun);
    assertRevisionMoved("thread", accepted.thread.id, beforeThread);
    const afterUsageRevision = revisionOf("run", accepted.run.id);
    const beforeNoopNotifications = changes.length;
    subagentStore.recordUsage({
      threadId: accepted.thread.id,
      runId: accepted.run.id,
      completionId: "usage-completion-1",
      cumulative: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costMicros: 42,
      },
      state: "current",
      completeness: "complete",
    });
    assert.equal(revisionOf("run", accepted.run.id), afterUsageRevision);
    assert.equal(changes.length, beforeNoopNotifications);

    beforeRun = revisionOf("run", accepted.run.id);
    subagentStore.transitionExecution({
      runId: accepted.run.id,
      status: "running",
      phase: "safe-idle",
    });
    assertRevisionMoved("run", accepted.run.id, beforeRun);

    terminalize(subagentStore.getRun(accepted.run.id)!);
    const priorTerminalRevision = revisionOf("run", accepted.run.id);
    const continuation = subagentStore.acceptContinuation({
      threadId: accepted.thread.id,
      parentLimit: 2,
      run: { initiatedBy: "agent", actualThinking: "medium" },
    });
    assert.ok(continuation.sequence > accepted.run.sequence);
    assert.equal(
      revisionOf("run", accepted.run.id),
      priorTerminalRevision,
      "continuation must not rewrite terminal history",
    );
    terminalize(continuation);

    beforeChanges = changes.length;
    const tombstone = subagentStore.tombstoneParentTree(parent);
    assert.equal(changes.length, beforeChanges + 1);
    assert.deepEqual(tombstone.threadIds, [accepted.thread.id]);
    assert.equal(subagentStore.getThread(accepted.thread.id), undefined);
    assert.equal(subagentStore.getRun(accepted.run.id), undefined);
    assert.equal(
      subagentStore
        .threadRevisions()
        .find((row) => row.id === accepted.thread.id)?.member,
      false,
    );
    assert.equal(
      subagentStore
        .runRevisions(accepted.thread.id)
        .every((row) => !row.member),
      true,
    );

    const scrubbed = getDb()
      .prepare(
        "SELECT session_id, role_name, provider FROM subagent_threads WHERE id = ?",
      )
      .get(accepted.thread.id) as {
      session_id: string;
      role_name: null;
      provider: null;
    };
    assert.equal(scrubbed.session_id, accepted.thread.sessionId);
    assert.equal(scrubbed.role_name, null);
    assert.equal(scrubbed.provider, null);
    assert.throws(
      () =>
        subagentStore.acceptInitial(
          initialInput(parent, accepted.thread.sessionId, 2),
        ),
      (error: unknown) =>
        error instanceof SubagentValidationError &&
        /already belongs to subagent thread/.test(error.message),
      "a tombstone keeps a typed non-resurrection session identity guard",
    );
  } finally {
    setSubagentStateChangeNotifier(undefined);
  }
});

test("usage baselines, parent roll-up, delegation counts, and obligations stay compositional", () => {
  const parent = makeParent();
  sessionStore.recordUsageTurn(parent, {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheCreationTokens: 0,
    costUSD: 0.000005,
  });
  const accepted = subagentStore.acceptInitial(
    initialInput(parent, makeChild(), 2),
  );
  assert.deepEqual(subagentStore.delegationSummaries().get(parent), {
    activeCount: 1,
    startingCount: 1,
    workingCount: 0,
    awaitingParentCount: 0,
  });

  subagentStore.recordUsage({
    threadId: accepted.thread.id,
    runId: accepted.run.id,
    completionId: "first-usage",
    cumulative: {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costMicros: 20,
    },
    state: "current",
    completeness: "complete",
  });
  assert.deepEqual(subagentStore.getRun(accepted.run.id)?.usageDelta, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costMicros: 20,
  });
  terminalize(accepted.run);

  const next = subagentStore.acceptContinuation({
    threadId: accepted.thread.id,
    parentLimit: 2,
    run: { initiatedBy: "agent", actualThinking: "medium" },
  });
  assert.deepEqual(next.openingUsage, {
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    costMicros: 20,
  });
  subagentStore.transitionExecution({
    runId: next.id,
    status: "running",
    phase: "provider-admitted",
  });
  assert.deepEqual(subagentStore.delegationSummaries().get(parent), {
    activeCount: 1,
    startingCount: 0,
    workingCount: 1,
    awaitingParentCount: 0,
  });
  subagentStore.recordUsage({
    threadId: accepted.thread.id,
    runId: next.id,
    completionId: "second-usage",
    cumulative: {
      inputTokens: 17,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      costMicros: 29,
    },
    state: "current",
    completeness: "partial",
  });
  assert.deepEqual(subagentStore.getRun(next.id)?.usageDelta, {
    inputTokens: 7,
    outputTokens: 3,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    costMicros: 9,
  });
  assert.deepEqual(subagentStore.parentUsageTotals(parent), {
    inputTokens: 20,
    outputTokens: 9,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    costMicros: 34,
  });

  subagentStore.awaitParent(next.id, "question-2");
  assert.deepEqual(subagentStore.delegationSummaries().get(parent), {
    activeCount: 1,
    startingCount: 0,
    workingCount: 0,
    awaitingParentCount: 1,
  });
  subagentStore.acceptResult({
    runId: next.id,
    reportedStatus: "completed",
    summary: "done",
    payload: null,
    hostFacts: null,
  });
  assert.deepEqual(subagentStore.delegationObligations(parent), {
    activeRunCount: 1,
    unadmittedResultCount: 1,
    ownedManagedWorktreeCount: 1,
  });
  subagentStore.recordQuiescence(next.id, "second-quiescence");
  subagentStore.finalizeRun({
    runId: next.id,
    status: "submitted",
    resultMessageId: "parent-result-entry",
  });
  assert.deepEqual(subagentStore.delegationObligations(parent), {
    activeRunCount: 0,
    unadmittedResultCount: 0,
    ownedManagedWorktreeCount: 1,
  });
  assert.equal(subagentStore.delegationSummaries().has(parent), false);
  subagentStore.updateThreadLinkage({
    threadId: accepted.thread.id,
    worktreeId: null,
    worktreeRelation: null,
  });
  assert.deepEqual(subagentStore.delegationObligations(parent), {
    activeRunCount: 0,
    unadmittedResultCount: 0,
    ownedManagedWorktreeCount: 0,
  });
});

test("result peer rows stay retention-pinned until confirmed parent-tree deletion", () => {
  const parent = makeParent();
  const child = makeChild();
  const conversationId = sessionId("retained-conversation");
  const chainId = peerPromptStore.createChain(sessionId("retained-chain"));
  const peer = peerPromptStore.enqueue({
    conversationId,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: child,
    recipientSessionId: parent,
    prompt: "terminal result",
    responseRequested: false,
  });
  peerPromptStore.claimNext(parent, "test-drainer", 1_000);
  peerPromptStore.markAdmitted(peer.id);
  peerPromptStore.markCompleted(peer.id);

  const input = initialInput(parent, child, 1);
  input.run.optionalResultCorrelationId = peer.id;
  const accepted = subagentStore.acceptInitial(input);
  terminalize(accepted.run);
  peerPromptStore.pruneTerminal(Date.now() + 10_000);
  assert.ok(peerPromptStore.getById(peer.id));

  subagentStore.tombstoneParentTree(parent);
  peerPromptStore.pruneTerminal(Date.now() + 10_000);
  assert.equal(peerPromptStore.getById(peer.id), undefined);
});

test("the additive migration preserves existing session rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE session_index (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'internal', 'subagent')),
      deleted_at_ms INTEGER
    );
    CREATE TABLE sequences (entity_type TEXT PRIMARY KEY, next_id INTEGER NOT NULL);
    INSERT INTO session_index (id, scope, deleted_at_ms) VALUES
      ('legacy-user', 'user', NULL),
      ('legacy-internal', 'internal', NULL),
      ('future-child', 'subagent', NULL);
  `);
  const sql = readFileSync(
    new URL("./migrations/0048_subagent_threads_runs.sql", import.meta.url),
    "utf8",
  );
  db.exec("BEGIN IMMEDIATE");
  db.exec(sql);
  db.exec("COMMIT");
  const rows = db
    .prepare("SELECT id, scope FROM session_index ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { id: "future-child", scope: "subagent" },
    { id: "legacy-internal", scope: "internal" },
    { id: "legacy-user", scope: "user" },
  ]);
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_runs'",
      )
      .get(),
  );
  db.close();
});
