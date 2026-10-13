/**
 * How a delivered peer turn ENDED, end to end: queued peer prompts travel
 * through the real peer engine, the real runtime (`liveSession.ts`), the real
 * pi adapter over scripted native events or a real `ClaudeSdkSession` over a
 * scripted seam, and are settled from the runtime's run outcome — never from
 * whether the prompt resolved. Only the providers are fake. Everything lives
 * under the suite's temporary `DATA_DIR` (`test/setup.ts`); no credential,
 * provider or network is touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import type { AgentType, Harness } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { delegationFailureNoticeStore } from "./db/delegationFailureNoticeStore.ts";
import { automaticTurnHoldStore } from "./db/automaticTurnHoldStore.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";
import type {
  AdapterEvent,
  PromptableAdapter,
} from "./session/adapters/contract.ts";
import type { PiDriver } from "./session/adapters/pi.ts";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";

const { fakeDrivers, cardUpdates, fakeHub } = vi.hoisted(() => {
  const fakeDrivers = new Map<string, unknown>();
  const cardUpdates: Array<{
    sessionId: string;
    messageKey: string;
    state: string;
    failureReason?: string;
    interruption?: string;
  }> = [];
  const fakeHub = {
    getLiveById: (id: string) => fakeDrivers.get(id),
    acquireById: async (id: string) => fakeDrivers.get(id),
    broadcastSessions: () => {},
    broadcastPeerPromptCardUpdate: (
      sessionId: string,
      update: {
        messageKey: string;
        state: string;
        failureReason?: string;
        interruption?: string;
      },
    ) => {
      cardUpdates.push({ sessionId, ...update });
    },
    broadcastPeerPromptQueue: () => {},
  };
  return { fakeDrivers, cardUpdates, fakeHub };
});

vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const {
  drainRecipient,
  installDelegationFailureNotices,
  peerPromptQueueField,
  sendPeerPrompt,
  sendQueuedPeerPromptNow,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
} = await import("./peerPrompt.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { createPiAdapter } = await import("./session/adapters/pi.ts");
const { NativeAdapterEventSource } =
  await import("./session/adapters/nativeEvents.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { holdAutomaticTurns, resumeAutomaticTurns } =
  await import("./automaticTurnHold.ts");
const { PEER_NOTICE_AGENT_ID } = await import("./delegationFailureNotice.ts");

setHubForTests(fakeHub as never);

/* ------------------------------- fixtures -------------------------------- */

/** How one scripted pi turn ends once it is released. */
type End =
  | { kind: "ok" }
  | { kind: "aborted"; abortRequested?: boolean }
  | {
      kind: "error";
      message: string;
      aborted?: boolean;
      abortRequested?: true;
    };

/**
 * A pi session whose provider is scripted, driven through the REAL pi adapter
 * (`createPiAdapter`) and the real runtime. Every turn it starts stays open
 * until the test ends it, so a Stop can land while the turn is running; a
 * prompt that arrives while one is open is taken as a steer, as pi does.
 */
class PiRecipient {
  readonly id: string;
  readonly key: string;
  readonly harness: Harness = "pi";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile = undefined;
  readonly canSteer = true;
  readonly events = new NativeAdapterEventSource();
  /** Every prompt the harness received, steers included. */
  prompts = 0;
  /** The adapter's subscriptions, for events no open run would carry. */
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
  private open: string | undefined;
  /** The open turn whose first message the harness has announced. */
  private live: string | undefined;
  private streams = 0;
  constructor(readonly sessionId: string) {
    this.id = sessionId;
    this.key = sessionId;
  }
  get isRunning(): boolean {
    return sessionRuntime.isRunning(this.sessionId);
  }
  contextInfo() {
    return new FakeRuntimeDriver(this.sessionId).contextInfo();
  }
  broadcastState(): void {}
  createRuntimeAdapter(): PromptableAdapter {
    const driver: PiDriver = {
      sessionFile: undefined,
      subscribeAdapterEvents: (listener) => {
        this.listeners.add(listener);
        const unsubscribe = this.events.subscribe(listener);
        return () => {
          this.listeners.delete(listener);
          unsubscribe();
        };
      },
      prompt: () => {
        this.prompts += 1;
        if (this.open)
          return { outcome: "steered" as const, completed: Promise.resolve() };
        const id = `m${++this.streams}`;
        this.open = id;
        setTimeout(() => {
          if (this.open !== id) return;
          this.events.messageStarted(id);
          this.live = id;
        }, 0);
        return "started";
      },
      abort: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
    };
    return createPiAdapter(this.sessionId, driver);
  }
  /** Deliver an event as the harness would, outside the native run counter. */
  straggle(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  /** A turn is open and its first message has started. */
  get turnLive(): boolean {
    return this.open !== undefined && this.live === this.open;
  }
  /** The turn did some work: a tool call that finished before any Stop. */
  ranTool(callId: string): void {
    this.events.toolStarted(callId, "bash", { command: "make" });
    this.events.toolCompleted({
      type: "toolEnd",
      sessionId: this.sessionId,
      id: this.open!,
      toolId: callId,
      output: "built",
      isError: false,
    });
  }
  /** End the open turn the way the harness would report it. */
  end(how: End = { kind: "ok" }): void {
    const id = this.open!;
    this.open = undefined;
    if (how.kind === "ok") {
      this.events.messageDelta(id, "text", "done");
      this.events.messageCompleted(id);
    } else if (how.kind === "aborted") {
      this.events.messageDelta(id, "text", "partial");
      this.events.messageCompleted(id, {
        aborted: true,
        ...(how.abortRequested ? { abortRequested: true } : {}),
      });
    } else {
      this.events.messageCompleted(id, {
        errorMessage: how.message,
        ...(how.aborted ? { aborted: true } : {}),
        ...(how.abortRequested ? { abortRequested: true } : {}),
      });
    }
  }
}

let n = 0;
const created: string[] = [];

function seed(title: string, harness: Harness = "pi"): string {
  const id = `pto-${n++}`;
  sessionStore.upsert({
    id,
    harness,
    agentType: "assistant",
    title,
    scope: "user",
  });
  created.push(id);
  return id;
}

function sender(title = "Coordinator"): FakeRuntimeDriver {
  const id = seed(title);
  const driver = new FakeRuntimeDriver(id);
  fakeDrivers.set(id, driver);
  return driver;
}

function piRecipient(spawnedBy?: string): PiRecipient {
  const id = seed("Worker");
  if (spawnedBy) sessionStore.linkSpawned(spawnedBy, id);
  const recipient = new PiRecipient(id);
  fakeDrivers.set(id, recipient);
  return recipient;
}

async function until(
  check: () => boolean,
  what: string,
  withinMs = 5_000,
): Promise<void> {
  for (let i = 0; i < withinMs / 5; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Let fire-and-forget wakes, drains and broadcasts run to completion. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

async function send(
  from: string,
  to: string,
  prompt: string,
  responseRequested = false,
): Promise<string> {
  const sent = await sendPeerPrompt({
    senderSessionId: from,
    targetSessionId: to,
    prompt,
    responseRequested,
  });
  return sent.message.id;
}

/**
 * Queue several prompts in ONE conversation, as a sender's follow-ups to the
 * same exchange are, so a FIFO drain delivers them as one batch.
 */
function enqueueBatch(
  from: string,
  to: string,
  prompts: Array<{ prompt: string; responseRequested?: boolean }>,
): string[] {
  const chainId = peerPromptStore.createChain();
  const conversationId = `pto-conv-${n++}`;
  return prompts.map(
    (p) =>
      peerPromptStore.enqueue({
        conversationId,
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: from,
        recipientSessionId: to,
        prompt: p.prompt,
        responseRequested: p.responseRequested ?? false,
        ...(p.responseRequested
          ? { expiresAt: Date.now() + 24 * 60 * 60 * 1000 }
          : {}),
      }).id,
  );
}

function row(id: string) {
  const r = peerPromptStore.getById(id);
  assert.ok(r, `row ${id}`);
  return r;
}

/** The durable log of a session, parsed. */
function logOf(sessionId: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(canonicalSessionLogPath(sessionId), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The user entries in a log that carry a peer message's admission key. */
function admissionsOf(sessionId: string, messageId: string): number {
  return logOf(sessionId).filter(
    (e) =>
      e.role === "user" &&
      Array.isArray(e.peerMessageIds) &&
      e.peerMessageIds.includes(`peer:${messageId}`),
  ).length;
}

/** Server notices a session received, delivered as turns of their own. */
function noticesIn(sessionId: string): number {
  return logOf(sessionId).filter(
    (e) =>
      e.role === "user" &&
      (e.origin as { agentId?: string } | undefined)?.agentId ===
        PEER_NOTICE_AGENT_ID,
  ).length;
}

/**
 * Start draining the recipient and wait until its delivered turn is running.
 * The drain comes back WRAPPED: an async function returning a bare promise
 * would adopt it, and awaiting the turn the test has yet to end never ends.
 */
async function deliverAndHold(
  recipient: PiRecipient,
): Promise<{ drained: Promise<void> }> {
  const drained = drainRecipient(recipient.sessionId);
  await until(() => recipient.turnLive, "the delivered turn");
  return { drained };
}

/** The user presses Stop on a running recipient, as `connection.ts` does. */
async function stop(recipient: PiRecipient): Promise<void> {
  holdAutomaticTurns(recipient.sessionId);
  await sessionRuntime.abort(recipient.sessionId);
}

let uninstall: () => void = () => {};
beforeAll(() => {
  setPeerPromptAutoDeliverForTests(false);
  uninstall = installDelegationFailureNotices();
});
afterAll(() => uninstall());

afterEach(async () => {
  await quiesce();
  vi.restoreAllMocks();
  cardUpdates.length = 0;
  for (const id of created.splice(0)) {
    automaticTurnHoldStore.release(id);
    sessionStore.remove(id);
    fakeDrivers.delete(id);
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
  }
});

/* --------------------------------- tests --------------------------------- */

describe("a delivered peer turn is settled by how it ended", () => {
  it("a clean end completes the batch, and a requested reply still waits for its answer", async () => {
    const coord = sender();
    const worker = piRecipient();
    const [note, ask] = enqueueBatch(coord.sessionId, worker.sessionId, [
      { prompt: "context" },
      { prompt: "answer?", responseRequested: true },
    ]) as [string, string];
    const { drained } = await deliverAndHold(worker);
    assert.equal(row(note).status, "acknowledged");
    assert.equal(row(ask).status, "acknowledged");
    worker.end();
    await drained;

    assert.equal(row(note).status, "completed");
    assert.equal(row(ask).status, "awaiting_response");
    assert.equal(row(ask).interruptionKind, undefined);
    assert.equal(admissionsOf(worker.sessionId, note), 1, "one batch entry");
    assert.equal(admissionsOf(worker.sessionId, ask), 1);
    assert.equal(row(note).batchHeadId, note);
    assert.equal(row(ask).batchHeadId, note);
  });

  it("a Stop after the append interrupts the whole batch, keeps what the turn did, and tells nobody", async () => {
    const coord = sender();
    const worker = piRecipient(coord.sessionId);
    const [note, ask] = enqueueBatch(coord.sessionId, worker.sessionId, [
      { prompt: "context" },
      { prompt: "build it", responseRequested: true },
    ]) as [string, string];
    const { drained } = await deliverAndHold(worker);
    worker.ranTool("call-1");
    await stop(worker);
    worker.end({ kind: "aborted" });
    await drained;
    await quiesce();

    // Not completed: the plain row is interrupted, the request still owed.
    const plain = row(note);
    assert.equal(plain.status, "interrupted");
    assert.equal(plain.interruptionKind, "stopped");
    assert.equal(plain.completedAt, undefined);
    const asked = row(ask);
    assert.equal(asked.status, "awaiting_response");
    assert.equal(asked.interruptionKind, "stopped");
    assert.equal(asked.completedAt, undefined);
    assert.equal(asked.failureReason, undefined, "nothing failed");
    // Identity and content survive: one admission entry, the tool's result,
    // the partial reply marked aborted, the bracket closed as aborted.
    const log = logOf(worker.sessionId);
    assert.equal(admissionsOf(worker.sessionId, note), 1);
    assert.equal(admissionsOf(worker.sessionId, ask), 1);
    assert.ok(
      log.some((e) => e.role === "toolResult" && e.toolCallId === "call-1"),
      "the finished tool's result is kept",
    );
    assert.ok(
      log.some((e) => e.role === "assistant" && e.stopReason === "aborted"),
    );
    assert.ok(log.some((e) => e.type === "run.aborted"));
    // The cards say so — both sides, the batch card included — as a Stop,
    // and the request as still owed.
    const senderCards = cardUpdates.filter(
      (u) => u.sessionId === coord.sessionId,
    );
    assert.ok(
      senderCards.some(
        (u) => u.state === "interrupted" && u.interruption === "stopped",
      ),
    );
    assert.ok(
      senderCards.some(
        (u) => u.state === "awaiting_response" && u.interruption === "stopped",
      ),
    );
    const batchCard = cardUpdates
      .filter((u) => u.sessionId === worker.sessionId)
      .at(-1);
    assert.equal(batchCard?.state, "interrupted");
    assert.equal(batchCard?.interruption, "stopped");
    assert.ok(cardUpdates.every((u) => u.failureReason === undefined));
    // Deliberate: no notice of either kind, and the sender is not woken.
    assert.equal(noticesIn(coord.sessionId), 0);
    assert.equal(
      delegationFailureNoticeStore.pendingFor(coord.sessionId).length,
      0,
    );
    assert.equal(coord.promptOptions.length, 0);
    assert.deepEqual(peerPromptStore.interruptedOwingSenderNotice(), []);
  });

  it("a held recipient stays held, and Resume delivers only what was never admitted", async () => {
    const coord = sender();
    const worker = piRecipient();
    const first = await send(coord.sessionId, worker.sessionId, "first", true);
    const { drained } = await deliverAndHold(worker);
    await stop(worker);
    worker.end({ kind: "aborted" });
    await drained;
    const later = await send(coord.sessionId, worker.sessionId, "second");
    await drainRecipient(worker.sessionId);
    await quiesce();
    assert.equal(worker.prompts, 1, "no automatic turn while held");
    assert.equal(row(later).status, "queued");
    assert.equal(row(later).attempts, 0);

    assert.ok(resumeAutomaticTurns(worker.sessionId));
    const resumed = drainRecipient(worker.sessionId);
    await until(() => worker.turnLive, "the resumed delivery");
    worker.end();
    await resumed;

    assert.equal(worker.prompts, 2);
    assert.equal(row(later).status, "completed");
    assert.equal(admissionsOf(worker.sessionId, first), 1, "never re-sent");
    assert.equal(row(first).status, "awaiting_response");
    assert.equal(row(first).interruptionKind, "stopped");
  });

  it("a Stop that kept an earlier attempt's error is still a Stop", async () => {
    const coord = sender();
    const worker = piRecipient(coord.sessionId);
    const ask = await send(coord.sessionId, worker.sessionId, "go", true);
    // pi's agent_settled after a Stop mid-retry: aborted, error retained, and
    // the abort asked for — reported by the harness alone.
    let { drained } = await deliverAndHold(worker);
    worker.end({
      kind: "error",
      message: "401 Unauthorized SECRET",
      aborted: true,
      abortRequested: true,
    });
    await drained;
    assert.equal(row(ask).interruptionKind, "stopped");
    assert.equal(row(ask).status, "awaiting_response");
    assert.equal(row(ask).failureReason, undefined);

    // The runtime's own Stop, on a turn that then reports a plain error.
    const again = await send(coord.sessionId, worker.sessionId, "retry", true);
    ({ drained } = await deliverAndHold(worker));
    await sessionRuntime.abort(worker.sessionId);
    worker.end({ kind: "error", message: "429 quota SECRET" });
    await drained;
    await quiesce();
    assert.equal(row(again).interruptionKind, "stopped");
    assert.equal(row(again).failureReason, undefined);
    assert.equal(noticesIn(coord.sessionId), 0);
    assert.equal(
      delegationFailureNoticeStore.pendingFor(coord.sessionId).length,
      0,
    );
  });

  it("an abort nobody asked for is an interruption the waiting sender hears about once", async () => {
    const coord = sender();
    const worker = piRecipient(coord.sessionId);
    const ask = await send(coord.sessionId, worker.sessionId, "go", true);
    const { drained } = await deliverAndHold(worker);
    worker.end({ kind: "aborted" });
    await drained;
    await until(() => noticesIn(coord.sessionId) === 1, "the notice");
    await quiesce();

    assert.equal(row(ask).status, "interrupted");
    assert.equal(row(ask).interruptionKind, "failure");
    assert.match(row(ask).failureReason!, /cut off/);
    assert.ok(row(ask).senderNotifiedAt !== undefined);
    assert.equal(noticesIn(coord.sessionId), 1, "told once, by one path");
  });

  it("a genuine provider failure stays a failure, told once by the failure notice", async () => {
    const coord = sender();
    const worker = piRecipient(coord.sessionId);
    const ask = await send(coord.sessionId, worker.sessionId, "go", true);
    const { drained } = await deliverAndHold(worker);
    worker.end({
      kind: "error",
      message: "Request was aborted",
      aborted: true,
    });
    await drained;
    await until(() => noticesIn(coord.sessionId) === 1, "the notice");
    await quiesce();

    assert.equal(row(ask).status, "interrupted");
    assert.equal(row(ask).interruptionKind, "failure");
    assert.equal(noticesIn(coord.sessionId), 1);
  });

  it("an answer sent before the Stop keeps the request replied", async () => {
    const coord = sender();
    const worker = piRecipient();
    const ask = await send(coord.sessionId, worker.sessionId, "status?", true);
    const { drained } = await deliverAndHold(worker);
    // The worker answers inside its delivered turn, then the user stops it.
    await send(worker.sessionId, coord.sessionId, "half done");
    assert.equal(row(ask).status, "replied");
    await stop(worker);
    worker.end({ kind: "aborted" });
    await drained;

    assert.equal(row(ask).status, "replied");
    assert.equal(row(ask).failureReason, undefined);
  });

  it("a stopped request stays owed on its own deadline until a later answer settles it", async () => {
    const coord = sender();
    const worker = piRecipient();
    const ask = await send(coord.sessionId, worker.sessionId, "report", true);
    const deadline = row(ask).expiresAt;
    assert.ok(deadline !== undefined);
    const { drained } = await deliverAndHold(worker);
    await stop(worker);
    worker.end({ kind: "aborted" });
    await drained;
    assert.equal(row(ask).status, "awaiting_response");
    assert.equal(row(ask).expiresAt, deadline, "no renewed deadline");
    assert.deepEqual(
      peerPromptStore.outstandingRepliesBySender().get(coord.sessionId),
      [worker.sessionId],
      "still owed in the session list",
    );

    // The user resumes the worker and talks to it; it answers on its own.
    resumeAutomaticTurns(worker.sessionId);
    cardUpdates.length = 0;
    await send(worker.sessionId, coord.sessionId, "here is the report");
    await quiesce();
    assert.equal(row(ask).status, "replied");
    assert.equal(
      peerPromptStore.outstandingRepliesBySender().get(coord.sessionId),
      undefined,
    );
    const settled = cardUpdates.find(
      (u) => u.sessionId === coord.sessionId && u.state === "replied",
    );
    assert.ok(settled, "the request's card moves to replied");
    assert.equal(settled.interruption, undefined, "and no longer reads unpaid");
    assert.equal(worker.prompts, 1, "the stopped prompt was never re-sent");
  });

  it("a stopped request a later real failure leaves unanswered is still reported", async () => {
    const coord = sender();
    const worker = piRecipient();
    const ask = await send(coord.sessionId, worker.sessionId, "report", true);
    const { drained } = await deliverAndHold(worker);
    await stop(worker);
    worker.end({ kind: "aborted" });
    await drained;
    assert.equal(noticesIn(coord.sessionId), 0);

    // Resumed, the worker's next turn fails on the provider.
    resumeAutomaticTurns(worker.sessionId);
    const failing = promptRuntimeSession(worker, "carry on", {
      origin: { kind: "human" },
    }).catch(() => undefined);
    await until(() => worker.turnLive, "the resumed turn");
    worker.end({ kind: "error", message: "429 quota" });
    await failing;
    await until(() => noticesIn(coord.sessionId) === 1, "the failure notice");
    await quiesce();
    assert.equal(noticesIn(coord.sessionId), 1);
    assert.equal(row(ask).status, "awaiting_response");
  });

  it("a Stop after the turn's failure was reported leaves it a failure, told once", async () => {
    const coord = sender();
    const worker = piRecipient(coord.sessionId);
    const ask = await send(coord.sessionId, worker.sessionId, "go", true);
    const { drained } = await deliverAndHold(worker);
    // The harness reports the failure, then the user stops what is left.
    worker.events.runFailing("401 Unauthorized", { kind: "auth" });
    await stop(worker);
    worker.end({ kind: "error", message: "401 Unauthorized" });
    await drained;
    await until(() => noticesIn(coord.sessionId) === 1, "the notice");
    await quiesce();

    assert.equal(row(ask).status, "interrupted");
    assert.equal(row(ask).interruptionKind, "failure");
    assert.equal(noticesIn(coord.sessionId), 1);
  });

  it("a straggler of an earlier run neither settles nor fails the turn running now", async () => {
    const coord = sender();
    const worker = piRecipient();
    const first = await send(coord.sessionId, worker.sessionId, "one");
    let { drained } = await deliverAndHold(worker);
    worker.end();
    await drained;
    assert.equal(row(first).status, "completed");

    const second = await send(coord.sessionId, worker.sessionId, "two");
    ({ drained } = await deliverAndHold(worker));
    // The first run's completion, repeated after its run closed: by its run
    // number, and as an emitter with no run open.
    worker.straggle({ type: "runCompleted", stopReason: "aborted", run: 1 });
    worker.straggle({
      type: "runCompleted",
      stopReason: "error",
      errorMessage: "late SECRET",
      unowned: true,
    });
    await quiesce();
    assert.equal(row(second).status, "acknowledged", "still running");
    assert.equal(row(first).status, "completed", "never rewritten");
    worker.end();
    await drained;
    assert.equal(row(second).status, "completed");
    assert.equal(row(first).status, "completed");
  });
});

describe("a Stop before the batch reached the session leaves it queued", () => {
  it("held before the drain: nothing is claimed", async () => {
    const coord = sender();
    const worker = piRecipient();
    const m = await send(coord.sessionId, worker.sessionId, "wait");
    holdAutomaticTurns(worker.sessionId);
    await drainRecipient(worker.sessionId);
    assert.equal(row(m).status, "queued");
    assert.equal(row(m).attempts, 0);
    assert.equal(worker.prompts, 0);
  });

  it("held between the claim and the append: back in the queue, no attempt spent, nothing admitted", async () => {
    const coord = sender();
    const worker = piRecipient();
    const m = await send(coord.sessionId, worker.sessionId, "race");
    const claim = peerPromptStore.claimBatch.bind(peerPromptStore);
    vi.spyOn(peerPromptStore, "claimBatch").mockImplementation((...args) => {
      const claimed = claim(...args);
      if (claimed.length > 0) holdAutomaticTurns(worker.sessionId);
      return claimed;
    });
    await drainRecipient(worker.sessionId);

    const r = row(m);
    assert.equal(r.status, "queued");
    assert.equal(r.attempts, 0);
    assert.equal(r.acceptedAt, undefined);
    assert.equal(r.batchHeadId, undefined);
    assert.equal(admissionsOf(worker.sessionId, m), 0);
    assert.equal(worker.prompts, 0);
    assert.ok(!r.transitions.some((t) => t.to === "admitted"));
  });

  it("a harness that refuses before the append keeps the retry policy", async () => {
    const coord = sender();
    const id = seed("Released worker");
    const released = new FakeRuntimeDriver(id);
    Object.defineProperty(released, "released", { value: true });
    fakeDrivers.set(id, released);
    const m = await send(coord.sessionId, id, "go");
    await drainRecipient(id);
    assert.equal(row(m).status, "retryable_failed");
    assert.equal(row(m).attempts, 1);
    assert.equal(admissionsOf(id, m), 0);
  });
});

describe("a delivery the user chose settles the same way", () => {
  it("send-now on an idle recipient: a Stop interrupts it, a clean end completes it", async () => {
    const coord = sender();
    const worker = piRecipient();
    const a = await send(coord.sessionId, worker.sessionId, "a", true);
    const [item] = peerPromptQueueField(worker.sessionId).queuedPeerPrompts!;
    const sending = sendQueuedPeerPromptNow(worker.sessionId, item!.id);
    await until(() => worker.turnLive, "the chosen turn");
    await stop(worker);
    worker.end({ kind: "aborted" });
    await sending;
    assert.equal(row(a).status, "awaiting_response");
    assert.equal(row(a).interruptionKind, "stopped");

    resumeAutomaticTurns(worker.sessionId);
    await quiesce();
    const b = await send(coord.sessionId, worker.sessionId, "b");
    const [next] = peerPromptQueueField(worker.sessionId).queuedPeerPrompts!;
    const again = sendQueuedPeerPromptNow(worker.sessionId, next!.id);
    await until(() => worker.turnLive, "the second chosen turn");
    worker.end();
    await again;
    assert.equal(row(b).status, "completed");
    assert.equal(admissionsOf(worker.sessionId, a), 1);
  });

  it("a steer settles with the run it joined, not the idle edge", async () => {
    const coord = sender();
    const worker = piRecipient();
    // A turn of the worker's own is running.
    const running = promptRuntimeSession(worker, "own work", {
      origin: { kind: "system", source: "background-work" },
    }).catch(() => undefined);
    await until(() => worker.turnLive, "the running turn");
    const steered = await send(coord.sessionId, worker.sessionId, "also", true);
    const [item] = peerPromptQueueField(worker.sessionId).queuedPeerPrompts!;
    await sendQueuedPeerPromptNow(worker.sessionId, item!.id);
    assert.equal(row(steered).status, "acknowledged");
    assert.equal(admissionsOf(worker.sessionId, steered), 1);
    await stop(worker);
    worker.end({ kind: "aborted" });
    await running;
    await until(
      () => row(steered).status !== "acknowledged",
      "the steer's settlement",
    );
    assert.equal(row(steered).status, "awaiting_response");
    assert.equal(row(steered).interruptionKind, "stopped");
    assert.equal(noticesIn(coord.sessionId), 0);

    // The next steer joins a run that ends cleanly.
    resumeAutomaticTurns(worker.sessionId);
    const next = promptRuntimeSession(worker, "more own work", {
      origin: { kind: "system", source: "background-work" },
    }).catch(() => undefined);
    await until(() => worker.turnLive, "the next running turn");
    const done = await send(coord.sessionId, worker.sessionId, "fyi");
    const [queued] = peerPromptQueueField(worker.sessionId).queuedPeerPrompts!;
    await sendQueuedPeerPromptNow(worker.sessionId, queued!.id);
    worker.end();
    await next;
    await until(() => row(done).status === "completed", "the clean steer");
  });
});

/* ------------------------------ real Claude ------------------------------ */

/**
 * A Claude seam whose query streams the start of a reply and then waits — as
 * a long turn does — until the session closes it: the shape a Stop meets.
 */
function longTurnSeam(): ClaudeSdkSeam {
  return {
    query() {
      let closed: () => void = () => {};
      const done = new Promise<void>((resolve) => (closed = resolve));
      const stream = (event: unknown) =>
        ({
          type: "stream_event",
          event,
          parent_tool_use_id: null,
          uuid: `evt-${Math.random()}`,
          session_id: "provider-long",
        }) as unknown as ClaudeSdkMessage;
      return {
        close: () => closed(),
        async *[Symbol.asyncIterator]() {
          yield stream({ type: "message_start", message: { id: "msg-long" } });
          yield stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          yield stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "working" },
          });
          await done;
        },
      };
    },
    deleteSession: async () => {},
  } as unknown as ClaudeSdkSeam;
}

class ClaudeRecipient {
  readonly id: string;
  readonly key: string;
  readonly harness: Harness = "claude-sdk";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile = undefined;
  readonly canSteer = false;
  readonly session: InstanceType<typeof ClaudeSdkSession>;
  constructor(readonly sessionId: string) {
    this.id = sessionId;
    this.key = sessionId;
    this.session = new ClaudeSdkSession(sessionId, {
      seam: () => Promise.resolve(longTurnSeam()),
    });
  }
  get isRunning(): boolean {
    return sessionRuntime.isRunning(this.sessionId);
  }
  contextInfo() {
    return new FakeRuntimeDriver(this.sessionId).contextInfo();
  }
  broadcastState(): void {}
  createRuntimeAdapter(): PromptableAdapter {
    return this.session.createRuntimeAdapter();
  }
}

describe("a real Claude session", () => {
  it("a Stop of the delivered turn interrupts it without a notice", async () => {
    const coord = sender();
    const id = seed("Claude worker", "claude-sdk");
    sessionStore.linkSpawned(coord.sessionId, id);
    const worker = new ClaudeRecipient(id);
    fakeDrivers.set(id, worker);
    const ask = await send(coord.sessionId, id, "think hard", true);
    const drained = drainRecipient(id);
    await until(() => worker.isRunning, "the Claude turn");
    await until(() => row(ask).status === "acknowledged", "the admission");
    holdAutomaticTurns(id);
    await sessionRuntime.abort(id);
    await drained;
    await quiesce();

    assert.equal(row(ask).status, "awaiting_response");
    assert.equal(row(ask).interruptionKind, "stopped");
    assert.equal(admissionsOf(id, ask), 1);
    assert.equal(noticesIn(coord.sessionId), 0);
    assert.equal(
      delegationFailureNoticeStore.pendingFor(coord.sessionId).length,
      0,
    );
    worker.session.dispose();
  });
});

/* ------------------------------ real restarts ------------------------------ */

/**
 * Two OS processes over one disposable data directory: the first delivers
 * and stops one batch, admits a second and dies mid-turn, and leaves a third
 * queued; the second boots on what it left. Every path the child sees is
 * disposable and asserted before the app is imported; `fetch` fails closed;
 * providers are scripted.
 */
describe("across a real restart", () => {
  const src = new URL("./", import.meta.url).href;
  const tsxLoader = fileURLToPath(
    new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
  );
  const script = `
const assert = (await import("node:assert/strict")).default;
const root = process.env.PTO_ROOT;
assert.ok(root && root.startsWith(${JSON.stringify(tmpdir())}));
for (const [key, dir] of [["HOME", "home"], ["ASSISTANT_CWD", "cwd"], ["DATA_DIR", "data"], ["ASSISTANT_LEGACY_PI_AGENT_DIR", "legacy"]])
  assert.equal(process.env[key], root + "/" + dir);
assert.equal(process.env.ASSISTANT_CONFIG, root + "/app.json");
globalThis.fetch = async () => { throw new Error("external fetch denied"); };
const mode = process.argv[1];
const src = process.env.PTO_SRC;
const { DATA_DIR } = await import(src + "config.ts");
assert.equal(DATA_DIR, root + "/data");
const { sessionStore } = await import(src + "db/sessionStore.ts");
const { peerPromptStore } = await import(src + "db/peerPromptStore.ts");
const { closeDb } = await import(src + "db/index.ts");
const { sessionRuntime } = await import(src + "session/runtimeInstance.ts");
const { holdAutomaticTurns } = await import(src + "automaticTurnHold.ts");
const { FakeRuntimeDriver } = await import(src + "test/fakeRuntimeDriver.ts");
const peer = await import(src + "peerPrompt.ts");
const drivers = new Map();
const prompts = new Map();
peer.setHubForTests({
  getLiveById: (id) => drivers.get(id),
  acquireById: async (id) => drivers.get(id),
  broadcastPeerPromptCardUpdate() {},
});
peer.setPeerPromptAutoDeliverForTests(false);
function driver(id) {
  const d = new FakeRuntimeDriver(id);
  const make = d.createRuntimeAdapter.bind(d);
  d.createRuntimeAdapter = () => {
    const adapter = make();
    const prompt = adapter.prompt.bind(adapter);
    adapter.prompt = (...args) => { prompts.set(id, (prompts.get(id) ?? 0) + 1); return prompt(...args); };
    let aborted;
    const abort = new Promise((resolve) => { aborted = resolve; });
    adapter.abort = () => aborted();
    const held = adapter.prompt;
    adapter.prompt = async (...args) => {
      const turn = held(...args);
      return Promise.race([turn, abort.then(() => ({ stopReason: "aborted" }))]);
    };
    return adapter;
  };
  drivers.set(id, d);
  return d;
}
const until = async (check) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
const ids = ["Coordinator", "Stopped", "Dies", "Backlog"];
if (mode === "first") {
  for (const id of ids) sessionStore.upsert({ id, harness: "pi", agentType: "assistant", scope: "user", title: id });
  for (const id of ids) driver(id);
  // The store's own enqueue: routing a send would resolve its target through the real hub.
  const send = (to, prompt) => { const chainId = peerPromptStore.createChain(); return peerPromptStore.enqueue({ conversationId: "c-" + to, chainId, hop: peerPromptStore.reserveHop(chainId), senderSessionId: "Coordinator", recipientSessionId: to, prompt, responseRequested: true, expiresAt: Date.now() + 86400000 }); };
  const stopped = await send("Stopped", "will be stopped");
  const release = drivers.get("Stopped").holdTurns();
  const drained = peer.drainRecipient("Stopped");
  await until(() => sessionRuntime.isRunning("Stopped"));
  holdAutomaticTurns("Stopped");
  await sessionRuntime.abort("Stopped");
  await drained;
  release();
  const dies = await send("Dies", "process dies mid-turn");
  drivers.get("Dies").holdTurns();
  void peer.drainRecipient("Dies");
  await until(() => peerPromptStore.getById(dies.id).status === "acknowledged");
  const backlog = await send("Backlog", "never delivered before the restart");
  console.log(JSON.stringify({ stopped: stopped.id, dies: dies.id, backlog: backlog.id, before: peerPromptStore.getById(stopped.id) }));
  process.exit(73);
} else {
  const [stoppedId, diesId, backlogId] = process.argv.slice(2);
  for (const id of ids) driver(id);
  const recovered = peer.recoverPeerPromptsOnBoot();
  peer.drainAllQueuedOnBoot();
  await until(() => peerPromptStore.getById(backlogId).status === "awaiting_response");
  await new Promise((r) => setTimeout(r, 50));
  const pick = (id) => { const r = peerPromptStore.getById(id); return { status: r.status, kind: r.interruptionKind ?? null, told: r.senderNotifiedAt !== undefined }; };
  console.log(JSON.stringify({ recovered, stopped: pick(stoppedId), dies: pick(diesId), backlog: pick(backlogId), prompts: Object.fromEntries(prompts) }));
  closeDb();
}
`;

  function run(root: string, ...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", tsxLoader, "--input-type=module", "-e", script, ...args],
      {
        cwd: join(root, "cwd"),
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          PTO_ROOT: root,
          PTO_SRC: src,
          HOME: join(root, "home"),
          ASSISTANT_CWD: join(root, "cwd"),
          DATA_DIR: join(root, "data"),
          ASSISTANT_CONFIG: join(root, "app.json"),
          ASSISTANT_LEGACY_PI_AGENT_DIR: join(root, "legacy"),
        },
      },
    );
  }

  it("a stopped batch is not replayed or relabeled, a stranded one is a restart, and the backlog drains", () => {
    const root = mkdtempSync(join(tmpdir(), "pto-restart-"));
    try {
      for (const dir of ["home", "cwd", "data", "legacy"])
        mkdirSync(join(root, dir));
      writeFileSync(
        join(root, "app.json"),
        JSON.stringify({ dataDir: join(root, "data") }),
      );
      const first = run(root, "first");
      assert.equal(first.status, 73, first.stderr);
      const ids = JSON.parse(first.stdout.trim().split("\n").at(-1)!) as {
        stopped: string;
        dies: string;
        backlog: string;
        before: { status: string; interruptionKind?: string };
      };
      assert.equal(ids.before.status, "awaiting_response");
      assert.equal(ids.before.interruptionKind, "stopped");

      const boot = run(root, "boot", ids.stopped, ids.dies, ids.backlog);
      assert.equal(boot.status, 0, boot.stderr);
      const out = JSON.parse(boot.stdout.trim().split("\n").at(-1)!) as {
        recovered: { recovered: number; interrupted: number };
        stopped: { status: string; kind: string | null; told: boolean };
        dies: { status: string; kind: string | null; told: boolean };
        backlog: { status: string; kind: string | null };
        prompts: Record<string, number>;
      };
      // Only the one turn the restart cut off is recovered.
      assert.deepEqual(out.recovered, { recovered: 1, interrupted: 1 });
      assert.deepEqual(out.stopped, {
        status: "awaiting_response",
        kind: "stopped",
        told: false,
      });
      assert.equal(out.dies.status, "interrupted");
      assert.equal(out.dies.kind, "restart");
      assert.equal(out.backlog.status, "awaiting_response");
      assert.equal(out.backlog.kind, null);
      // Nothing admitted before the restart is sent again; the backlog is.
      assert.equal(out.prompts.Stopped ?? 0, 0);
      assert.equal(out.prompts.Dies ?? 0, 0);
      assert.equal(out.prompts.Backlog, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 240_000);
});
