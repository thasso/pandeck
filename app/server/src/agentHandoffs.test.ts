/**
 * The agent-handoff queue: what happens to a card outcome when the session it
 * belongs to is mid-turn. Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/agentHandoffs.test.ts
 *
 * Driven by real runtime prompts through `FakeRuntimeDriver`, so the run-state
 * gate, the durable log append and the idle edge are the real ones; only the
 * provider turn is faked.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, test, vi } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { agentHandoffStore } from "./db/agentHandoffStore.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";

const drivers = new Map<string, FakeRuntimeDriver>();
/** Sessions the hub refuses to resume, as a deleted/foreign session would be. */
const unavailable = new Set<string>();
const fakeHub = {
  getLiveById: (id: string) =>
    unavailable.has(id) ? undefined : drivers.get(id),
  acquireById: async (id: string) =>
    unavailable.has(id) ? undefined : drivers.get(id),
};
vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const {
  deliverAgentHandoff,
  recoverAgentHandoffsOnBoot,
  registerAgentHandoffOutcome,
  drainAgentHandoffs,
  setAgentHandoffDeliveryStoppedForTests,
  setAgentHandoffHubForTests,
  setAgentHandoffRetryDelayForTests,
  stopAgentHandoffDelivery,
} = await import("./agentHandoffs.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { setSessionIdleHook } = await import("./session/runtime/liveSession.ts");
const { reserveWorktreeForRemoval, setSessionWorktreeResolverForTests } =
  await import("./session/sessionRunLease.ts");

setAgentHandoffHubForTests(fakeHub);

/**
 * A stand-in for the pull-request card that waits to hear what became of its
 * handoff. Registered exactly as `pullRequestActions.ts` registers the real one.
 */
const TEST_OUTCOME = "test-card";
const outcomes: string[] = [];
registerAgentHandoffOutcome(TEST_OUTCOME, {
  delivered: (ref) => outcomes.push(`delivered:${ref.id}`),
  dropped: (ref, reason) => outcomes.push(`dropped:${ref.id}:${reason}`),
});
// Production wires this in `index.ts`; the queue is only ever drained by an
// edge, so a test without it would be testing half the mechanism.
setSessionIdleHook((sessionId) => void drainAgentHandoffs(sessionId));

let n = 0;
const created: string[] = [];

function seed(): FakeRuntimeDriver {
  const id = `handoff-sess-${n++}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "assistant" });
  created.push(id);
  const driver = new FakeRuntimeDriver(id);
  drivers.set(id, driver);
  return driver;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  outcomes.length = 0;
  // Stopping cancels any retry this test left scheduled, so a timer cannot fire
  // into the next one; delivery is then restored for it.
  setAgentHandoffDeliveryStoppedForTests(true);
  setAgentHandoffDeliveryStoppedForTests(false);
  setAgentHandoffRetryDelayForTests(undefined);
  setSessionWorktreeResolverForTests(null);
  for (const id of created.splice(0)) {
    for (const row of agentHandoffStore.listForSession(id))
      agentHandoffStore.remove(row.id);
    sessionStore.remove(id);
    drivers.delete(id);
    unavailable.delete(id);
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
  }
});

describe("agent handoffs", () => {
  it("delivers inline when the session is idle", async () => {
    const driver = seed();
    const outcome = await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1" },
    });
    assert.equal(outcome, "delivered");
    assert.deepEqual(outcomes, ["delivered:card-1"]);
    assert.equal(agentHandoffStore.listForSession(driver.sessionId).length, 0);
    assert.equal(driver.promptOptions.length, 1);
    assert.equal(driver.promptOptions[0]?.hidden, true);
  });

  it("queues a decision a mid-turn session cannot take, and delivers it on the next idle edge", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    // The turn that is holding the session; a test may make it fail, and a
    // failing run of the USER's own prompt is not this queue's business.
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    assert.equal(driver.isRunning, true, "the session is mid-turn");

    const outcome = await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1" },
    });
    assert.equal(outcome, "queued");
    const queued = agentHandoffStore.listForSession(driver.sessionId);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]?.origin, {
      kind: "system",
      source: "approval-decision",
    });
    assert.deepEqual(
      outcomes,
      [],
      "nothing is reported delivered while it waits",
    );
    assert.equal(
      driver.promptOptions.length,
      1,
      "the running turn is untouched",
    );

    release();
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.deepEqual(outcomes, ["delivered:card-1"]);
    assert.equal(
      driver.promptOptions.length,
      2,
      "the decision became its own turn",
    );
    assert.equal(driver.promptOptions[1]?.hidden, true);
  });

  it("keeps FIFO order across several decisions taken during one turn", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    // The turn that is holding the session; a test may make it fail, and a
    // failing run of the USER's own prompt is not this queue's business.
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();

    for (const source of ["approval-decision", "agent-question-response"])
      assert.equal(
        await deliverAgentHandoff({
          sessionId: driver.sessionId,
          driver,
          text: `[${source}]`,
          origin: { kind: "system", source },
        }),
        "queued",
      );
    assert.deepEqual(
      agentHandoffStore
        .listForSession(driver.sessionId)
        .map((row) => row.origin),
      [
        { kind: "system", source: "approval-decision" },
        { kind: "system", source: "agent-question-response" },
      ],
    );

    release();
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.equal(driver.promptOptions.length, 3, "one turn per decision");
  });

  it("resumes a session nobody is viewing rather than dropping the decision", async () => {
    const driver = seed();
    const outcome = await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
    });
    // No driver in hand: the queue resolves the session through the hub, so the
    // decision still reaches the agent.
    assert.equal(outcome, "queued");
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.equal(driver.promptOptions.length, 1);
  });

  it("keeps a later decision behind one still waiting", async () => {
    const driver = seed();
    unavailable.add(driver.sessionId);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "first",
      origin: { kind: "system", source: "approval-decision" },
    });
    unavailable.delete(driver.sessionId);
    // The session is idle and in hand, but something older is still owed: the
    // agent must hear the decisions in the order they were made.
    assert.equal(
      await deliverAgentHandoff({
        sessionId: driver.sessionId,
        driver,
        text: "second",
        origin: { kind: "system", source: "approval-decision" },
      }),
      "queued",
    );
    assert.deepEqual(
      agentHandoffStore
        .listForSession(driver.sessionId)
        .map((row) => row.prompt),
      ["first", "second"],
    );
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.deepEqual(
      driver.promptOptions.map((options) => options?.hidden),
      [true, true],
    );
  });

  it("tells the waiting card even when the handoff outlives the process", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "rebase it yourself",
      origin: { kind: "system", source: "pull-request-rebase" },
      visible: true,
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1", token: "tok-1" },
    });
    // Everything this process holds in memory is gone; only the row is left,
    // exactly as after a restart. The card must still be told.
    outcomes.length = 0;
    release();
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.deepEqual(outcomes, ["delivered:card-1"]);
  });

  it("retries only the DELETE when a delivered row cannot be dropped", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    setAgentHandoffRetryDelayForTests(1);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1" },
    });
    // The delete refuses for as long as `locked` is set — past the append, past
    // the delivering turn's own idle edge, past the drain's rerun. The leftover
    // row therefore outlives every event this session was going to produce,
    // which is the whole reason the queue has to schedule one of its own. The
    // decision is in the session throughout, and none of this may turn into a
    // second turn carrying it.
    const realRemove = agentHandoffStore.remove.bind(agentHandoffStore);
    let locked = true;
    const remove = vi
      .spyOn(agentHandoffStore, "remove")
      .mockImplementation((id: number) => {
        if (locked) throw new Error("database is locked");
        return realRemove(id);
      });
    release();
    await vi.waitFor(() => assert.equal(driver.promptOptions.length, 2));
    assert.deepEqual(outcomes, ["delivered:card-1"]);
    await tick();
    await tick();
    assert.equal(
      agentHandoffStore.listForSession(driver.sessionId).length,
      1,
      "the undeletable row is still there, and still not re-prompted",
    );

    locked = false;
    // Only the queue's own scheduled retry is left to notice; it deletes, and
    // never prompts.
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.equal(
      driver.promptOptions.length,
      2,
      "a row that outlived its delete is never handed to the agent twice",
    );
    assert.deepEqual(outcomes, ["delivered:card-1"]);
    remove.mockRestore();
  });

  it("tells the waiting card when a handoff expires unread", async () => {
    const driver = seed();
    unavailable.add(driver.sessionId);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "rebase it yourself",
      origin: { kind: "system", source: "pull-request-rebase" },
      visible: true,
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1", token: "tok-1" },
    });
    outcomes.length = 0;
    // Boot with a zero-length TTL: every queued handoff is already expired,
    // which is the state a week of nobody being able to take it produces.
    recoverAgentHandoffsOnBoot(0);
    assert.equal(agentHandoffStore.listForSession(driver.sessionId).length, 0);
    assert.equal(outcomes.length, 1, "expiry is reported, not silent");
    assert.match(outcomes[0] ?? "", /^dropped:card-1:.*waited a week/);
  });

  it("gives up on a session that cannot be resumed, instead of asking forever", async () => {
    const driver = seed();
    setAgentHandoffRetryDelayForTests(1);
    unavailable.add(driver.sessionId);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1" },
    });
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.equal(outcomes.length, 1);
    assert.match(outcomes[0] ?? "", /^dropped:card-1:.*could not be resumed/);
  });

  it("delivers a handoff once its session can be resumed again", async () => {
    const driver = seed();
    unavailable.add(driver.sessionId);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
    });
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId)[0]?.attempts,
        1,
        "the unreachable session spends one attempt, not the whole budget",
      ),
    );
    assert.equal(driver.promptOptions.length, 0);

    unavailable.delete(driver.sessionId);
    await drainAgentHandoffs(driver.sessionId);
    assert.equal(agentHandoffStore.listForSession(driver.sessionId).length, 0);
    assert.equal(driver.promptOptions.length, 1);
  });

  it("does not re-deliver a decision whose run then failed", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    // The turn that is holding the session; a test may make it fail, and a
    // failing run of the USER's own prompt is not this queue's business.
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
    });
    driver.behavior = { mode: "error", message: "provider exploded" };
    release();

    // The turn carrying the decision fails, but it was APPENDED: the agent has
    // it, and the row must not come back on the next edge.
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    driver.behavior = { mode: "success" };
    await drainAgentHandoffs(driver.sessionId);
    assert.equal(driver.promptOptions.length, 2);
  });

  it("drops a handoff that is refused before it is ever appended, after its attempt budget", async () => {
    const driver = seed();
    // A worktree held for removal refuses admission at the run boundary, which
    // is the shape of every failure that appends nothing — and produces no idle
    // edge either, so only the module's own backoff comes back for it.
    setAgentHandoffRetryDelayForTests(1);
    setSessionWorktreeResolverForTests(() => "wt-held");
    const releaseHold = reserveWorktreeForRemoval("wt-held", "Removing it.");
    assert.ok(releaseHold);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
      outcomeRef: { kind: TEST_OUTCOME, id: "card-1" },
    });
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
        "a handoff that can never be delivered retries, then stops asking",
      ),
    );
    assert.equal(outcomes.length, 1, "the card is told it was given up on");
    assert.match(outcomes[0] ?? "", /^dropped:card-1:.*Removing it/);
    assert.equal(driver.promptOptions.length, 0);
    releaseHold();
  });

  it("retries a refusal that produced no idle edge, and delivers when it clears", async () => {
    const driver = seed();
    // Long enough that the attempt budget cannot burn through before the hold
    // is released below, short enough not to slow the suite down.
    setAgentHandoffRetryDelayForTests(200);
    setSessionWorktreeResolverForTests(() => "wt-held-briefly");
    const releaseHold = reserveWorktreeForRemoval(
      "wt-held-briefly",
      "Removing it.",
    );
    assert.ok(releaseHold);
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
    });
    // One failed attempt is enough to prove the schedule exists; releasing the
    // hold inside the budget must then land the decision with no idle edge and
    // no further user action.
    await vi.waitFor(
      () =>
        assert.ok(
          (agentHandoffStore.listForSession(driver.sessionId)[0]?.attempts ??
            0) > 0,
        ),
      { interval: 1 },
    );
    releaseHold();
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    assert.equal(driver.promptOptions.length, 1);
  });

  it("carries a human-origin handoff with its model-only context", async () => {
    const driver = seed();
    const release = driver.holdTurns();
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    assert.equal(
      await deliverAgentHandoff({
        sessionId: driver.sessionId,
        driver,
        text: "have a look at these",
        origin: { kind: "human" },
        contextBlock: "<comments>…</comments>",
        visible: true,
      }),
      "queued",
    );
    const queued = agentHandoffStore.listForSession(driver.sessionId)[0];
    assert.deepEqual(queued?.origin, { kind: "human" });
    assert.equal(queued?.contextBlock, "<comments>…</comments>");
    assert.equal(queued?.hidden, false);

    release();
    await vi.waitFor(() =>
      assert.equal(
        agentHandoffStore.listForSession(driver.sessionId).length,
        0,
      ),
    );
    // The user's own words stay in the transcript; the bundle rides the
    // model-only seam, exactly as an immediate send would have done.
    const handoffTurn = driver.promptOptions[1];
    assert.equal(handoffTurn?.hidden, undefined);
  });

  it("goes quiet for a graceful shutdown without losing the row", async () => {
    const driver = seed();
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] approved",
      origin: { kind: "system", source: "approval-decision" },
    });
    // Delivered inline above; queue a second one against a mid-turn session.
    const release = driver.holdTurns();
    // The turn that is holding the session; a test may make it fail, and a
    // failing run of the USER's own prompt is not this queue's business.
    void promptRuntimeSession(driver, "the user's own prompt").catch(() => {});
    await tick();
    await deliverAgentHandoff({
      sessionId: driver.sessionId,
      driver,
      text: "[approval decision] rejected",
      origin: { kind: "system", source: "approval-decision" },
    });
    stopAgentHandoffDelivery();
    release();
    await tick();
    await tick();
    assert.equal(
      agentHandoffStore.listForSession(driver.sessionId).length,
      1,
      "the decision waits for the next boot instead of starting a turn",
    );
  });
});

/**
 * `index.ts` binds a port at import time, so the boot/idle/shutdown wiring is
 * asserted statically, like `peerPromptWiring.test.ts` does for the peer FIFO.
 * A queue nobody drains is a decision nobody delivers.
 */
test("index.ts drains handoffs on the idle edge, at boot, and stops for shutdown", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
    "utf8",
  );
  assert.match(
    source,
    /setSessionIdleHook\s*\(\s*\(sessionId\)\s*=>\s*\{(?:\s*\/\/[^\n]*)*\s*void runAutoApprovals\(sessionId\)\s*\.catch\(\(\) => \{\}\)\s*\.then\(\(\) => drainAgentHandoffs\(sessionId\)\)/,
    "session-granted approvals, then queued handoffs, must take the running→idle edge before the other drains",
  );
  // Each inside its own boot step: a bare mention (a comment, an import) must
  // not satisfy this, and one step's throw must not skip the other.
  assert.match(
    source,
    /\bbootStep\(\s*"[^"]+",\s*\(\)\s*=>\s*recoverAutoApprovalsOnBoot\(\)\s*,?\s*\)/,
    "auto-approvals a restart interrupted must run again at boot, in their own boot step",
  );
  assert.match(
    source,
    /\bbootStep\(\s*"[^"]+",\s*\(\)\s*=>\s*recoverAgentHandoffsOnBoot\(\)\s*,?\s*\)/,
    "handoffs that outlived the process must be offered again at boot, in their own boot step",
  );
  assert.match(
    source,
    /\bstopAgentHandoffDelivery\s*\(\)/,
    "a graceful shutdown must stop waking sessions from the queue",
  );
});

/**
 * The rebase card's outcome handler is a module-load registration, so nothing
 * calls it in a unit test — and a handoff whose `outcomeRef` has no handler
 * only logs. This is what keeps the card's durable report wired.
 */
test("the pull-request rebase outcome is registered where it is written", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "pullRequestActions.ts"),
    "utf8",
  );
  assert.match(
    source,
    /registerAgentHandoffOutcome\(\s*PULL_REQUEST_REBASE_OUTCOME\s*,/,
    "a queued rebase must still reach recordRebaseHandoff after a restart",
  );
});
