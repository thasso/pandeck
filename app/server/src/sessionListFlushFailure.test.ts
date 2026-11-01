/**
 * The `sessions` topic's failure policy (Task-1310; `docs/state-sync.md`,
 * "Failure boundary"): a row read or a frame that fails stays in the topic.
 * The ids are retained and publish on the next ordinary report, the command
 * that caused the flush still succeeds, and only a missed-reporter invariant
 * reaches anyone.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import * as list from "./harnesses/sessionList.ts";
import * as workflowRuns from "./workflowRuns.ts";
import * as workflowStore from "./db/workflowStore.ts";
import { getDb } from "./db/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { touchSessionRows } from "./db/sessionListChanges.ts";
import {
  setSessionsBatchMaxForTests,
  resetSessionListAuditBaselineForTests,
} from "./sessionsTopic.ts";
import { stateTopicFor } from "./stateTopics.ts";
import { takeStateTopicInvariantsForTests } from "./stateTopicKernel.ts";
import {
  CODE_DELIVERY_RECIPE_ID,
  CODE_DELIVERY_RECIPE_VERSION,
} from "./workflow/codeDeliveryRecipe.ts";
import { sessionListClient } from "./test/sessionListClient.ts";

let serial = 0;
const system = { kind: "system" } as const;
const user = { kind: "user" } as const;

function seed(): string {
  const id = `flush-failure-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title: id,
    messageCount: 2,
  });
  return id;
}

/** A completed code-delivery run whose only role is `coordinator`. */
function settleableRun(coordinator: string): number {
  const run = workflowStore.createRun({
    taskId: 1310,
    recipeId: CODE_DELIVERY_RECIPE_ID,
    recipeVersion: CODE_DELIVERY_RECIPE_VERSION,
    maxIterations: 3,
    maxReviewPasses: 1,
    config: {},
    actor: user,
  });
  const step = workflowStore.appendStep({
    runId: run.id,
    kind: "agent",
    payload: { role: "coordinator", objective: "plan" },
    actor: system,
  });
  workflowStore.startStep(
    step.id,
    { kind: "session", id: coordinator },
    system,
  );
  workflowStore.completeStep(step.id, {
    status: "completed",
    result: { status: "completed", summary: "done" },
    actor: system,
  });
  workflowStore.setRunLifecycle(run.id, "completed", { actor: system });
  sessionStore.recordSessionOutcome(coordinator, "completed");
  return run.id;
}

/**
 * The topic's bounded row build (`summaries`) throws while on; the commands'
 * own list reads, and the audit's full build, do not.
 */
function failRowReads() {
  const original = list.mergedSessionList;
  let failing = true;
  const spy = vi
    .spyOn(list, "mergedSessionList")
    .mockImplementation((opts = {}) => {
      if (
        failing &&
        opts.onlyIds &&
        new Error().stack?.includes("sessionsTopic.ts")
      )
        throw new Error("injected row read failure");
      return original(opts);
    });
  return {
    spy,
    stop: () => {
      failing = false;
    },
  };
}

const errors = (sent: ServerMessage[]) =>
  sent.filter((message) => message.type === "error");

afterEach(async () => {
  vi.restoreAllMocks();
  setSessionsBatchMaxForTests();
  await hub.flushPendingBroadcastsForTests();
});

test("a failed row read reaches neither command; its ids publish on the next report", async () => {
  const [capped, coordinator, later] = [seed(), seed(), seed()];
  const runId = settleableRun(coordinator);
  const client = sessionListClient();
  await client.connection.handle({ type: "subscribe", topics: ["workflow"] });
  await hub.flushPendingBroadcastsForTests();
  client.clear();
  const runList = vi.spyOn(workflowRuns, "broadcastWorkflowRuns");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const reads = failRowReads();
  const originalSettle = sessionStore.setSettled;
  let capStarted = false;
  const capDone = new Promise<void>((resolve, reject) => {
    vi.spyOn(sessionStore, "setSettled").mockImplementation((...args) => {
      const result = originalSettle(...args);
      if (args[0] === coordinator && !capStarted) {
        capStarted = true;
        // The role write is pending, while its dynamic hub import has not yet
        // resumed. Start the second command in that same debounce window.
        queueMicrotask(() => {
          client.connection
            .handle({
              type: "setSessionPeerTurnCap",
              sessionId: capped,
              cap: 4,
              requestId: "req-cap-1310",
            } as ClientMessage)
            .then(resolve, reject);
        });
      }
      return result;
    });
  });
  try {
    const settleDone = client.connection.handle({
      type: "settleWorkflowRun",
      runId: String(runId),
      throughRevision: 1,
      requestId: "req-settle-1310",
    } as ClientMessage);
    await Promise.all([settleDone, capDone]);
  } finally {
    reads.stop();
  }
  assert.deepEqual(errors(client.sent), [], "no command reported the read");
  assert.ok(
    client.sent.some(
      (m) => m.type === "mutationSettled" && m.requestId === "req-settle-1310",
    ),
  );
  assert.ok(
    client.sent.some(
      (m) => m.type === "mutationSettled" && m.requestId === "req-cap-1310",
    ),
  );
  assert.ok(
    reads.spy.mock.calls.some(
      ([opts]) => opts?.onlyIds?.has(capped) && opts.onlyIds.has(coordinator),
    ),
    "both callers' ids were coalesced in the failing row build",
  );
  assert.equal(sessionStore.get(capped)?.peerTurnCap, 4);
  assert.equal(sessionStore.isSettled(coordinator), true);
  assert.ok(runList.mock.calls.length > 0, "the run list followed settlement");
  assert.ok(
    client.sent.some(
      (m) =>
        m.type === "workflowRunList" &&
        m.runs.some(
          (run) =>
            run.id === String(runId) &&
            run.attention?.settledRevision === run.attention?.revision,
        ),
    ),
    "the settled run reached the workflow subscriber despite the row failure",
  );
  assert.ok(
    logged.mock.calls.some((call) =>
      String(call[0]).includes("[sessions] flush failed"),
    ),
  );
  assert.deepEqual(client.upserted(), [], "nothing partial was published");

  touchSessionRows([later]);
  await hub.flushPendingBroadcastsForTests();
  assert.deepEqual(
    new Set(client.upserted()),
    new Set([capped, coordinator, later]),
  );
  assert.equal(client.row(capped)?.peerTurnCap, 4);
  assert.ok(client.row(coordinator)?.settledAt !== undefined);
  assert.deepEqual(takeStateTopicInvariantsForTests(), []);
  client.close();
});

test("a frame one connection cannot take is retained and repeated; the command still succeeds", async () => {
  const [first, capped, later] = [seed(), seed(), seed()];
  const [steady, failing] = [sessionListClient(), sessionListClient()];
  await hub.flushPendingBroadcastsForTests();
  steady.clear();
  failing.clear();
  setSessionsBatchMaxForTests(1);
  const outcomes: boolean[] = [];
  stateTopicFor("sessions")!.onPublished(({ delivered }) => {
    outcomes.push(delivered);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const send = failing.connection.send.bind(failing.connection);
  let frames = 0;
  vi.spyOn(failing.connection, "send").mockImplementation((message) => {
    if (message.type === "stateEvents" && ++frames === 2)
      throw new Error("injected send failure");
    send(message);
  });
  const revision = (id: string) =>
    (
      getDb()
        .prepare(
          "SELECT revision FROM session_list_revisions WHERE session_id = ?",
        )
        .get(id) as { revision: number }
    ).revision;

  touchSessionRows([first]);
  await steady.connection.handle({
    type: "setSessionPeerTurnCap",
    sessionId: capped,
    cap: 3,
  });
  assert.deepEqual(errors(steady.sent), []);
  assert.equal(steady.events().length, 2, "the flush spanned two frames");
  assert.equal(failing.events().length, 1, "the second frame failed there");
  assert.equal(outcomes.at(-1), false);
  const seqs = steady.events().map((batch) => batch.seq);

  touchSessionRows([later]);
  await hub.flushPendingBroadcastsForTests();
  assert.equal(outcomes.at(-1), true);
  const repeated = steady
    .events()
    .slice(2)
    .flatMap((batch) => batch.events);
  for (const id of [first, capped])
    assert.equal(
      repeated.find((event) => event.id === id)?.revision,
      revision(id),
      `${id} was repeated at the same revision`,
    );
  assert.ok(repeated.some((event) => event.id === later));
  // The failing connection missed one seq; its client resubscribes on the gap
  // (web `stateReplica` test). It still got every later frame.
  const missed = failing.events().map((batch) => batch.seq);
  assert.equal(missed[0], seqs[0]);
  assert.ok(!missed.includes(seqs[1]!));
  assert.equal(missed.length, steady.events().length - 1);
  steady.close();
  failing.close();
});

test("an archived-count signal that fails to send is sent again by the next publication", async () => {
  const [archived, later] = [seed(), seed()];
  const client = sessionListClient();
  await hub.flushPendingBroadcastsForTests();
  client.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const broadcast = (
    hub as unknown as {
      broadcastTopic: (topic: string, message: ServerMessage) => void;
    }
  ).broadcastTopic.bind(hub);
  let failed = false;
  vi.spyOn(
    hub as unknown as { broadcastTopic: typeof broadcast },
    "broadcastTopic",
  ).mockImplementation((topic, message) => {
    if (message.type === "archivedSessionCount" && !failed) {
      failed = true;
      throw new Error("injected count send failure");
    }
    broadcast(topic, message);
  });
  sessionStore.setArchived(archived, true);
  await hub.flushPendingBroadcastsForTests();
  assert.equal(failed, true);
  assert.equal(
    client.sent.filter((m) => m.type === "archivedSessionCount").length,
    0,
  );
  touchSessionRows([later]);
  await hub.flushPendingBroadcastsForTests();
  assert.deepEqual(
    client.sent.filter((m) => m.type === "archivedSessionCount"),
    [{ type: "archivedSessionCount", count: hub.archivedSessionCount() }],
  );
  client.close();
});

test("at the command boundary an unreported change is an invariant, an ordinary read failure is not", async () => {
  const [capped, quiet] = [seed(), seed()];
  const client = sessionListClient();
  await hub.flushPendingBroadcastsForTests();
  // Behind every reporter's back: the audit's next run sees it unstamped.
  getDb()
    .prepare("UPDATE session_index SET title = ? WHERE id = ?")
    .run("silently retitled", quiet);
  await client.connection
    .handle({ type: "setSessionPeerTurnCap", sessionId: capped, cap: 5 })
    .catch(() => {});
  const violations = takeStateTopicInvariantsForTests();
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, new RegExp(`${quiet} title`));
  resetSessionListAuditBaselineForTests();

  vi.spyOn(console, "error").mockImplementation(() => {});
  const reads = failRowReads();
  try {
    await client.connection.handle({
      type: "setSessionPeerTurnCap",
      sessionId: capped,
      cap: 6,
    });
  } finally {
    reads.stop();
  }
  assert.deepEqual(takeStateTopicInvariantsForTests(), []);
  assert.deepEqual(
    errors(client.sent).filter((m) => m.message.includes("injected")),
    [],
  );
  touchSessionRows([capped]);
  await hub.flushPendingBroadcastsForTests();
  client.close();
});
