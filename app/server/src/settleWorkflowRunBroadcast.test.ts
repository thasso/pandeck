/**
 * Settling a formal Workflow Run, through the real command (Task-677): the run's
 * cursor is acknowledged, the role sessions its card projection names are
 * settled with it, an unresolved user decision refuses the whole thing with the
 * shared wording, and every subscribed tab converges on both lists — a Settle on
 * the phone clears the item on the laptop.
 *   pnpm --filter @assistant/server test src/settleWorkflowRunBroadcast.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type {
  BroadcastTopic,
  ClientMessage,
  ServerMessage,
  WorkflowRunSummary,
} from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "settle-workflow-run-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const workflowStore = await import("./db/workflowStore.ts");
const { subagentStore } = await import("./db/subagentStore.ts");
const { CODE_DELIVERY_RECIPE_ID, CODE_DELIVERY_RECIPE_VERSION } =
  await import("./workflow/codeDeliveryRecipe.ts");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const system = { kind: "system" } as const;
const user = { kind: "user" } as const;

/** Minimal open socket: `Connection` only reads `readyState`/`OPEN` and sends. */
function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

/** The session broadcast is debounced (`hub.flushSessionsBroadcast`). */
const settled = () => new Promise((resolve) => setTimeout(resolve, 80));

let counter = 0;
function directSession(title: string): string {
  const id = `wf-role-${++counter}`;
  // A row with no messages projects to nothing, so the list would never carry it.
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title,
    messageCount: 4,
  });
  return id;
}

/** A code-delivery run with a coordinator and an implementer step each. */
function staffedRun(roles: Record<string, string>): number {
  const run = workflowStore.createRun({
    taskId: 677,
    recipeId: CODE_DELIVERY_RECIPE_ID,
    recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 3,
    maxReviewPasses: 1,
    config: {},
    actor: user,
  });
  for (const [role, sessionId] of Object.entries(roles)) {
    const step = workflowStore.appendStep({
      runId: run.id,
      kind: "agent",
      payload: { role, objective: role === "coordinator" ? "plan" : role },
      actor: system,
    });
    workflowStore.startStep(
      step.id,
      { kind: "session", id: sessionId },
      system,
    );
    workflowStore.completeStep(step.id, {
      status: "completed",
      result: { status: "completed", summary: `${role} done` },
      actor: system,
    });
  }
  return run.id;
}

function runFrom(
  messages: ServerMessage[],
  runId: number,
): WorkflowRunSummary | undefined {
  for (const message of [...messages].reverse())
    if (message.type === "workflowRunList")
      return message.runs.find((run) => run.id === String(runId));
  return undefined;
}

function settledFrom(
  messages: ServerMessage[],
  id: string,
): boolean | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type === "sessionUpdated" && message.session.id === id)
      return message.session.settledAt !== undefined;
    if (message.type === "sessions") {
      const row = message.sessions.find((session) => session.id === id);
      if (row) return row.settledAt !== undefined;
    }
  }
  return undefined;
}

test("settling a completed run settles its roles and reaches every subscribed tab", async () => {
  const coordinator = directSession("Coordinator");
  const implementer = directSession("Implementer");
  const runId = staffedRun({ coordinator, implementer });
  workflowStore.setRunLifecycle(runId, "completed", { actor: system });
  // Both roles ended with outcomes of their own, as workflow-created sessions
  // do: each would be a card of its own without the run.
  assert.equal(sessionStore.recordSessionOutcome(coordinator, "completed"), 1);
  assert.equal(sessionStore.recordSessionOutcome(implementer, "failed"), 1);
  assert.equal(workflowStore.getRun(runId)?.attention?.revision, 1);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  const otherTab: ServerMessage[] = [];
  const listener = {
    send: (message: ServerMessage) => otherTab.push(message),
    wantsTopic: (topic: BroadcastTopic) => topic === "workflow",
  };
  hub.register(listener);

  try {
    await connection.handle({
      type: "settleWorkflowRun",
      runId: String(runId),
      throughRevision: 1,
      requestId: "req-settle-run",
    } as ClientMessage);
    await settled();

    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
      "the settle was accepted",
    );
    assert.equal(
      clicked.some(
        (message) =>
          message.type === "mutationSettled" &&
          message.requestId === "req-settle-run",
      ),
      true,
    );
    const stored = workflowStore.getRun(runId)?.attention;
    assert.equal(stored?.settledRevision, 1, "the run is acknowledged");
    assert.equal(
      sessionStore.isSettled(coordinator),
      true,
      "the coordinator left with the run, through its own current revision",
    );
    assert.equal(
      sessionStore.isSettled(implementer),
      true,
      "and so did the implementer, failure and all",
    );
    assert.equal(
      sessionStore.get(implementer)?.outcomeAttention?.settledRevision,
      1,
    );

    const seen = runFrom(otherTab, runId);
    assert.ok(seen, "the other tab received the run list");
    assert.equal(seen.attention?.settledRevision, 1, "with the run settled");
    assert.equal(
      settledFrom(otherTab, coordinator),
      true,
      "and the session list with the roles on the shelf",
    );
    // The roles leave BEFORE the run does: a tab that received the settled
    // run first would stop folding its still-unsettled roles for a moment and
    // show each of them as a card of its own.
    const sessionsAt = otherTab.findIndex(
      (message) =>
        message.type === "sessions" || message.type === "sessionUpdated",
    );
    const runsAt = otherTab.findIndex(
      (message) => message.type === "workflowRunList",
    );
    assert.ok(sessionsAt >= 0 && runsAt >= 0);
    assert.ok(
      sessionsAt < runsAt,
      `the session list (#${sessionsAt}) reaches the tab before the run list (#${runsAt})`,
    );
  } finally {
    hub.unregister(listener);
    connection.dispose();
  }
});

test("a role that cannot be put down refuses the whole Settle, before anything is written", async () => {
  const coordinator = directSession("Coordinator");
  const implementer = directSession("Implementer");
  const runId = staffedRun({ coordinator, implementer });
  workflowStore.setRunLifecycle(runId, "completed", { actor: system });
  sessionStore.recordSessionOutcome(coordinator, "completed");
  // The implementer still holds active delegated work — one of the durable
  // reasons the shared session predicate refuses a settle.
  const child = `${implementer}-child`;
  sessionStore.upsert({
    id: child,
    scope: "subagent",
    harness: "pi",
    agentType: "developer",
  });
  subagentStore.acceptInitial({
    thread: {
      parentSessionId: implementer,
      sessionId: child,
      profile: {
        roleName: "implementer",
        baseRole: "developer",
        provider: "openai-codex",
        modelId: "gpt-5.6",
        credentialProfileId: "test-profile",
        accountSource: "test",
        defaultThinking: "high",
        hardMaxThinking: "xhigh",
        executionProfileId: "test-execution",
        contractId: "implementation-result",
        contractVersion: 1,
      },
      linkage: { worktreeId: `managed-${runId}`, worktreeRelation: "managed" },
    },
    run: { initiatedBy: "agent", actualThinking: "high" },
    parentLimit: 1,
  });

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "settleWorkflowRun",
      runId: String(runId),
      throughRevision: 1,
    } as ClientMessage);
    await settled();
    const error = clicked.find((message) => message.type === "error");
    assert.ok(error, "the settle was refused");
    assert.equal(
      error.message,
      "Failed to settle workflow run: it still has active delegated work.",
      "in the role's own shared wording, the same the item disables Settle with",
    );
    assert.equal(
      workflowStore.getRun(runId)?.attention?.settledRevision,
      0,
      "the run was not acknowledged",
    );
    assert.equal(
      sessionStore.isSettled(coordinator),
      false,
      "and no other role was put down on its behalf either",
    );
  } finally {
    connection.dispose();
  }
});

test("a stale revision does not acknowledge a newer event, so the run stays awake", async () => {
  const coordinator = directSession("Coordinator");
  const runId = staffedRun({ coordinator });
  workflowStore.setRunLifecycle(runId, "paused", {
    reason: "implementer failed",
    actor: system,
  });
  workflowStore.setRunLifecycle(runId, "active", { actor: user });
  workflowStore.setRunLifecycle(runId, "cancelled", { actor: user });
  assert.equal(workflowStore.getRun(runId)?.attention?.revision, 2);

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "settleWorkflowRun",
      runId: String(runId),
      throughRevision: 1,
    } as ClientMessage);
    await settled();
    assert.equal(
      clicked.some((message) => message.type === "error"),
      false,
    );
    const attention = workflowStore.getRun(runId)?.attention;
    assert.equal(attention?.settledRevision, 1);
    assert.equal(attention?.revision, 2, "the cancellation is still pending");
  } finally {
    connection.dispose();
  }
});

test("a run waiting on an unresolved user decision refuses to settle, with the shared reason", async () => {
  const coordinator = directSession("Coordinator");
  const runId = staffedRun({ coordinator });
  const gate = workflowStore.appendStep({
    runId,
    kind: "user-decision",
    payload: {
      decision: "raise-ceilings",
      blocked: "iterations",
      wanted: "answer the findings raised against bbb",
      allowedChoices: ["raise", "cancel"],
      reviewedHeadCommit: "bbb",
      spent: { iterations: 3, reviewPasses: 1, sessions: 2 },
      headCarriesDiscoveryReview: true,
    },
    actor: system,
  });
  workflowStore.startStep(
    gate.id,
    { kind: "operation", id: "user-decision" },
    system,
  );
  workflowStore.setRunLifecycle(runId, "paused", {
    reason: "Decide how the run should continue.",
    actor: system,
  });
  sessionStore.recordSessionOutcome(coordinator, "completed");

  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "settleWorkflowRun",
      runId: String(runId),
      throughRevision: 1,
      requestId: "req-gated",
    } as ClientMessage);
    await settled();
    const error = clicked.find((message) => message.type === "error");
    assert.ok(error, "the settle was refused");
    assert.equal(
      error.message,
      "Failed to settle workflow run: it is waiting for your decision at its ceiling.",
    );
    assert.deepEqual(error.target, { type: "task", id: "677" });
    assert.equal(
      clicked.some((message) => message.type === "mutationSettled"),
      false,
      "a refused command settles nothing",
    );
    assert.equal(
      workflowStore.getRun(runId)?.attention?.settledRevision,
      0,
      "the run is still awake",
    );
    assert.equal(
      sessionStore.isSettled(coordinator),
      false,
      "and no role was put down on its behalf",
    );
    assert.equal(
      clicked.some((message) => message.type === "workflowRunList"),
      false,
      "the re-sent authoritative list goes to subscribers, of which this fake is none",
    );
  } finally {
    connection.dispose();
  }
});

test("the role cascade writes before it yields, so nothing can slip between preflight and the writes", async () => {
  const { settleWorkflowRunRoleSessions } =
    await import("./sessionActivity.ts");
  const coordinator = directSession("Coordinator");
  const implementer = directSession("Implementer");
  sessionStore.recordSessionOutcome(coordinator, "completed");
  sessionStore.recordSessionOutcome(implementer, "completed");

  // Not awaited yet: the durable state must already be there, or a role could
  // start a turn in the gap and be skipped after the run was acknowledged.
  const broadcasting = settleWorkflowRunRoleSessions([
    coordinator,
    implementer,
  ]);
  assert.equal(sessionStore.isSettled(coordinator), true);
  assert.equal(sessionStore.isSettled(implementer), true);
  await broadcasting;
});

test("an unknown run is refused before anything is touched", async () => {
  const clicked: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(clicked));
  try {
    await connection.handle({
      type: "settleWorkflowRun",
      runId: "nope",
      throughRevision: 0,
    } as ClientMessage);
    assert.match(
      clicked.find((message) => message.type === "error")?.message ?? "",
      /does not exist/,
    );
  } finally {
    connection.dispose();
  }
});
