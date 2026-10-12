/**
 * Delegation-failure notices end to end: a child's failed turn travels through
 * the REAL runtime (`liveSession.ts`), the real pi adapter or a real
 * `ClaudeSdkSession` over a scripted seam, the runtime's failure hook, the
 * durable notice store and the real peer drain into its coordinator's log.
 * Only the providers are fake. Everything lives under the suite's temporary
 * `DATA_DIR` (`test/setup.ts`); no credential, provider or network is touched.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import type { AgentType, Harness } from "@assistant/shared";
import type { PromptOrigin } from "@assistant/shared/session";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { delegationFailureNoticeStore } from "./db/delegationFailureNoticeStore.ts";
import { automaticTurnHoldStore } from "./db/automaticTurnHoldStore.ts";
import { closeDb, getDb } from "./db/index.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";
import type {
  PromptableAdapter,
  RunFailureFacts,
} from "./session/adapters/contract.ts";
import type { PiDriver } from "./session/adapters/pi.ts";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";

const { fakeDrivers, deadIds, acquired, fakeHub } = vi.hoisted(() => {
  const fakeDrivers = new Map<string, unknown>();
  const deadIds = new Set<string>();
  /** Every session the drain had to cold-acquire, in order. */
  const acquired: string[] = [];
  const fakeHub = {
    getLiveById: (id: string) => fakeDrivers.get(id),
    acquireById: async (id: string) => {
      acquired.push(id);
      if (deadIds.has(id)) throw new Error("no on-disk state to resume from");
      return fakeDrivers.get(id);
    },
    broadcastSessions: () => {},
    broadcastPeerPromptCardUpdate: () => {},
    broadcastPeerPromptQueue: () => {},
  };
  return { fakeDrivers, deadIds, acquired, fakeHub };
});

vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const {
  RETRY_MAX_ATTEMPTS,
  cancelQueuedPeerPrompts,
  drainAllQueuedOnBoot,
  drainRecipient,
  installDelegationFailureNotices,
  sendPeerPrompt,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
  setPeerPromptDeliveryStoppedForTests,
  sweepPeerPromptRetries,
} = await import("./peerPrompt.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { setSessionIdleHook, subscribeSessionRunCompleted } =
  await import("./session/runtime/liveSession.ts");
const { createPiAdapter } = await import("./session/adapters/pi.ts");
const { NativeAdapterEventSource } =
  await import("./session/adapters/nativeEvents.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { holdAutomaticTurns } = await import("./automaticTurnHold.ts");
const { PEER_NOTICE_AGENT_ID } = await import("./delegationFailureNotice.ts");
const { sessionControlTools, setSessionControlRuntimeForTests } =
  await import("./tools/sessions/sessionControlTool.ts");

setHubForTests(fakeHub as never);

/* ------------------------------- fixtures -------------------------------- */

/** What one fake pi turn does. */
type Step =
  | { kind: "ok" }
  | {
      kind: "error";
      message: string;
      failure?: RunFailureFacts;
      /** Report the completion twice, as a duplicated provider event would. */
      duplicate?: boolean;
    }
  | { kind: "retryThenOk" }
  | { kind: "aborted" }
  /** Keep the turn running until `release()`, then end it with `then`. */
  | { kind: "hold"; then: Step };

/**
 * A pi session whose provider is scripted, driven through the REAL pi adapter
 * (`createPiAdapter`) and the real runtime: completions arrive as native
 * adapter events, exactly as `PiLiveSession` emits them.
 */
class PiChild {
  readonly id: string;
  readonly key: string;
  readonly harness: Harness = "pi";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile = undefined;
  readonly canSteer = false;
  readonly steps: Step[] = [];
  prompts = 0;
  private readonly events = new NativeAdapterEventSource();
  private streams = 0;
  private releaseHeld: (() => void) | undefined;
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
      subscribeAdapterEvents: (listener) => this.events.subscribe(listener),
      prompt: () => {
        this.prompts += 1;
        const step = this.steps.shift() ?? { kind: "ok" };
        setTimeout(() => this.play(step), 0);
        return "started";
      },
      abort: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
    };
    return createPiAdapter(this.sessionId, driver);
  }
  /** A turn the harness starts on its own (no prompt from us). */
  outOfBand(step: Step): void {
    this.play(step);
  }
  release(): void {
    this.releaseHeld?.();
  }
  private play(step: Step): void {
    if (step.kind === "hold") {
      const id = `m${++this.streams}`;
      this.events.messageStarted(id);
      this.releaseHeld = () => {
        this.releaseHeld = undefined;
        this.finish(id, step.then);
      };
      return;
    }
    const id = `m${++this.streams}`;
    this.events.messageStarted(id);
    this.finish(id, step);
  }
  private finish(id: string, step: Step): void {
    if (step.kind === "retryThenOk") {
      this.events.providerRetry({ attempt: 1, maxAttempts: 3, delayMs: 10 });
      this.events.messageDelta(id, "text", "done after a retry");
      this.events.messageCompleted(id);
      return;
    }
    if (step.kind === "aborted") {
      this.events.messageCompleted(id, { aborted: true });
      return;
    }
    if (step.kind === "error") {
      this.events.messageCompleted(id, {
        errorMessage: step.message,
        ...(step.failure ? { failure: step.failure } : {}),
      });
      if (step.duplicate)
        this.events.runCompleted("error", step.message, step.failure);
      return;
    }
    this.events.messageDelta(id, "text", "ok");
    this.events.messageCompleted(id);
  }
}

/** The CLI's real shape of an org spend limit: a synthetic message, then `is_error`. */
function spendLimitSeam(): ClaudeSdkSeam {
  return {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            uuid: `synthetic-${Math.random()}`,
            session_id: "sess-spend",
            error: "rate_limit",
            message: {
              id: `synthetic-${Math.random()}`,
              role: "assistant",
              model: "<synthetic>",
              content: [
                {
                  type: "text",
                  text: "You've hit your org's monthly spend limit · see https://console.example.invalid/billing?token=SECRET-TOKEN-123",
                },
              ],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          } as unknown as ClaudeSdkMessage;
          yield {
            type: "result",
            subtype: "success",
            session_id: "sess-spend",
            is_error: true,
            api_error_status: 429,
            result: "API Error: 429",
            total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            modelUsage: {},
          } as unknown as ClaudeSdkMessage;
        },
      };
    },
  } as unknown as ClaudeSdkSeam;
}

/** A Claude session over a scripted seam, behind the runtime driver surface. */
class ClaudeChild {
  readonly id: string;
  readonly key: string;
  readonly harness: Harness = "claude-sdk";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile = undefined;
  readonly canSteer = false;
  private readonly session: InstanceType<typeof ClaudeSdkSession>;
  constructor(readonly sessionId: string) {
    this.id = sessionId;
    this.key = sessionId;
    this.session = new ClaudeSdkSession(sessionId, {
      seam: () => Promise.resolve(spendLimitSeam()),
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

let n = 0;
const created: string[] = [];

function seed(title: string, harness: Harness = "pi"): string {
  const id = `dfn-${n++}`;
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

function coordinator(title = "Coordinator"): {
  id: string;
  driver: FakeRuntimeDriver;
} {
  const id = seed(title);
  const driver = new FakeRuntimeDriver(id);
  fakeDrivers.set(id, driver);
  return { id, driver };
}

function piChild(parentId: string | undefined, title = "Child"): PiChild {
  const id = seed(title);
  if (parentId) sessionStore.linkSpawned(parentId, id);
  const child = new PiChild(id);
  fakeDrivers.set(id, child);
  return child;
}

/** The notice turns a session received, as their durable user entries' text. */
function noticesIn(sessionId: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(canonicalSessionLogPath(sessionId), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (e) =>
        e.role === "user" &&
        (e.origin as { agentId?: string } | undefined)?.agentId ===
          PEER_NOTICE_AGENT_ID,
    )
    .map((e) =>
      (e.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(""),
    );
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Let fire-and-forget wakes and drains run to completion. */
async function quiesce(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

/** A request `sender` made that `recipient` took and has not answered. */
function awaitingRow(sender: string, recipient: string): void {
  const chainId = peerPromptStore.createChain();
  const m = peerPromptStore.enqueue({
    conversationId: `dfn-${n++}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: sender,
    recipientSessionId: recipient,
    prompt: "please answer",
    responseRequested: true,
  });
  peerPromptStore.claimNext(recipient, "d", 60_000);
  peerPromptStore.markAdmitted(m.id);
  peerPromptStore.markAcknowledged(m.id);
  peerPromptStore.markCompleted(m.id);
  assert.equal(peerPromptStore.getById(m.id)?.status, "awaiting_response");
}

/** Run a turn on a child and swallow its expected failure. */
async function turn(
  driver: PiChild | ClaudeChild,
  text: string,
  origin: PromptOrigin = { kind: "system", source: "background-work" },
): Promise<void> {
  await promptRuntimeSession(driver as never, text, { origin }).catch(
    () => undefined,
  );
}

let uninstall: () => void = () => {};
beforeAll(() => {
  setPeerPromptAutoDeliverForTests(false);
  uninstall = installDelegationFailureNotices();
});
afterAll(() => uninstall());

afterEach(async () => {
  setSessionIdleHook(undefined);
  setPeerPromptDeliveryStoppedForTests(false);
  setSessionControlRuntimeForTests(undefined);
  await quiesce();
  for (const id of created.splice(0)) {
    automaticTurnHoldStore.release(id);
    sessionStore.remove(id);
    fakeDrivers.delete(id);
    deadIds.delete(id);
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
  }
  acquired.length = 0;
});

const QUOTA =
  "Model usage limit reached (anthropic/claude): org monthly spend limit";

/* --------------------------------- tests --------------------------------- */

describe("a failed child turn notifies its immediate coordinator", () => {
  it("reports a spend limit on a background turn after an intermediate reply, once and safely", async () => {
    const { id: coord, driver: coordDriver } = coordinator();
    const child = piChild(coord, "AWS tests");
    const asked = await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "run the AWS suite and report",
      responseRequested: true,
    });
    await drainRecipient(child.sessionId);
    // The intermediate reply: the request reads as answered from here on.
    await sendPeerPrompt({
      senderSessionId: child.sessionId,
      targetSessionId: coord,
      prompt: "tests are running in the background; will report",
      responseRequested: false,
    });
    assert.equal(
      peerPromptStore.getById(asked.message.id)?.status,
      "replied",
      "the coordinator's request is answered by the intermediate reply",
    );
    await drainRecipient(coord);
    const before = coordDriver.promptOptions.length;

    // The background job finished; delivering that fact fails on the limit.
    child.steps.push({
      kind: "error",
      message: QUOTA,
      failure: { kind: "quota" },
    });
    await turn(child, "background job finished");
    await until(() => noticesIn(coord).length === 1, "the failure notice");
    await quiesce();

    const [notice] = noticesIn(coord);
    assert.match(notice!, new RegExp(`session \`${child.sessionId}\``));
    assert.match(notice!, /usage, spend or billing limit/);
    assert.match(notice!, /needs no reply/);
    assert.doesNotMatch(notice!, /monthly spend limit|anthropic\/claude/);
    assert.doesNotMatch(notice!, /resets at/, "no reset was reported");
    assert.equal(coordDriver.promptOptions.length, before + 1);
    assert.equal(
      delegationFailureNoticeStore.pendingFor(coord).length,
      0,
      "the notice is retired once its turn reached the log",
    );

    // A later drain, another idle edge or a boot drain never repeats it.
    await drainRecipient(coord);
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(noticesIn(coord).length, 1);
    assert.equal(child.prompts, 2, "the failed turn is never run again");
  });

  it("reports a Claude child's spend limit through the real Claude session", async () => {
    const { id: coord } = coordinator();
    const childId = seed("Claude reviewer", "claude-sdk");
    sessionStore.linkSpawned(coord, childId);
    const child = new ClaudeChild(childId);
    fakeDrivers.set(childId, child);
    await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: childId,
      prompt: "review the branch",
      responseRequested: false,
    });

    await drainRecipient(childId);
    await until(() => noticesIn(coord).length === 1, "the failure notice");
    await quiesce();

    const [notice] = noticesIn(coord);
    assert.match(notice!, /usage, spend or billing limit/);
    assert.doesNotMatch(notice!, /SECRET-TOKEN|console\.example|spend limit ·/);
    const row = JSON.stringify(
      getDb()
        .prepare(
          "SELECT * FROM delegation_failure_notices WHERE child_session_id = ?",
        )
        .all(childId),
    );
    assert.doesNotMatch(row, /SECRET-TOKEN|console\.example|monthly/);
    assert.match(row, /"route":"spawn"/);
  });

  it("leaves a requested reply that failed in its own turn to the one interruption notice", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    child.steps.push({
      kind: "error",
      message: QUOTA,
      failure: { kind: "quota" },
    });
    const { message } = await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "answer me",
      responseRequested: true,
    });
    await drainRecipient(child.sessionId);
    await until(() => noticesIn(coord).length === 1, "the notice");
    await quiesce();

    assert.equal(peerPromptStore.getById(message.id)?.status, "interrupted");
    assert.equal(noticesIn(coord).length, 1, "one failure, one notice");
    assert.match(noticesIn(coord)[0]!, /usage, spend or billing limit/);
    assert.doesNotMatch(noticesIn(coord)[0]!, /monthly spend limit/);
    assert.equal(
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM delegation_failure_notices WHERE child_session_id = ?",
        )
        .get(child.sessionId)!.n,
      0,
    );
  });

  it("tells only the immediate coordinator in a nested tree", async () => {
    const { id: root, driver: rootDriver } = coordinator("Root");
    const { id: implementer } = coordinator("Implementer");
    sessionStore.linkSpawned(root, implementer);
    const reviewer = piChild(implementer, "Reviewer");
    reviewer.steps.push({ kind: "ok" });
    await turn(reviewer, "start");
    reviewer.steps.push({
      kind: "error",
      message: "401 Unauthorized: OAuth token has expired",
    });
    await turn(reviewer, "review");
    await until(() => noticesIn(implementer).length === 1, "the notice");
    await quiesce();

    assert.match(noticesIn(implementer)[0]!, /rejected its credentials/);
    assert.equal(noticesIn(root).length, 0, "the grandparent is not told");
    assert.equal(rootDriver.promptOptions.length, 0);
  });

  it("reports a turn the harness started on its own", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    child.outOfBand({
      kind: "error",
      message: QUOTA,
      failure: { kind: "quota" },
    });
    await until(() => noticesIn(coord).length === 1, "the notice");
  });

  it("reports a harness that throws, or fails a turn without a completion event", async () => {
    const { id: coord } = coordinator();
    for (const behavior of [
      {
        mode: "reject" as const,
        message: "Prompt was not accepted by the pi session.",
      },
      { mode: "error" as const, message: "503 Service Unavailable" },
    ]) {
      const childId = seed("Fake harness child");
      sessionStore.linkSpawned(coord, childId);
      const child = new FakeRuntimeDriver(childId);
      fakeDrivers.set(childId, child);
      child.behavior = behavior;
      await promptRuntimeSession(child, "background job finished", {
        origin: { kind: "system", source: "background-work" },
      }).catch(() => undefined);
    }
    await until(() => noticesIn(coord).length >= 1, "the notices");
    await quiesce();
    const text = noticesIn(coord).join("\n");
    assert.equal(
      (text.match(/The provider or harness failed/g) ?? []).length,
      2,
    );
    assert.doesNotMatch(text, /not accepted|503|Unavailable/);
  });

  it("tells a sender that never got its delivery through, when the child cannot start", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord, "Never starts");
    deadIds.add(child.sessionId);
    fakeDrivers.delete(child.sessionId);
    // Enqueued as `session_spawn` does, before the child ever ran.
    const chainId = peerPromptStore.createChain();
    const message = peerPromptStore.enqueue({
      conversationId: `dfn-${n++}`,
      chainId,
      hop: peerPromptStore.reserveHop(chainId),
      senderSessionId: coord,
      recipientSessionId: child.sessionId,
      prompt: "do the thing",
      responseRequested: false,
    });
    let now = Date.now();
    for (let i = 0; i <= RETRY_MAX_ATTEMPTS + 1; i++) {
      await drainRecipient(child.sessionId);
      now += 60 * 60_000;
      sweepPeerPromptRetries(now);
      await quiesce();
      if (peerPromptStore.getById(message.id)?.status === "failed") break;
    }
    assert.equal(peerPromptStore.getById(message.id)?.status, "failed");
    await until(() => noticesIn(coord).length === 1, "the delivery notice");
    assert.match(noticesIn(coord)[0]!, /could not be delivered/);
    assert.doesNotMatch(noticesIn(coord)[0]!, /on-disk state/);
  });
});

describe("what is not a failure, or not this coordinator's", () => {
  it("stays silent for retries that recover, ordinary ends and aborts", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    child.steps.push(
      { kind: "retryThenOk" },
      { kind: "ok" },
      { kind: "aborted" },
    );
    await turn(child, "one");
    await turn(child, "two");
    await turn(child, "three");
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
  });

  it("stays silent when the user stopped the child", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    child.steps.push({ kind: "hold", then: { kind: "error", message: QUOTA } });
    const running = turn(child, "long");
    await until(() => child.isRunning, "the child turn");
    holdAutomaticTurns(child.sessionId);
    child.release();
    await running;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("stays silent when the coordinator stands the child down", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    child.steps.push({ kind: "hold", then: { kind: "error", message: QUOTA } });
    const running = turn(child, "long");
    await until(() => child.isRunning, "the child turn");
    setSessionControlRuntimeForTests({
      isRunning: () => true,
      abort: () => child.release(),
    });
    await sessionControlTools()[0]!.execute(
      { operation: "stop", targetSessionId: child.sessionId },
      {
        toolCallId: "t",
        session: {
          sessionId: coord,
          harness: "pi",
          agentType: "assistant",
          title: "Coordinator",
        },
      } as never,
    );
    await running;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);

    // The stand-down covered that turn only.
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "again");
    await until(() => noticesIn(coord).length === 1, "the next failure");
  });

  it("stays silent for a settled, taken-over or deleted delegation", async () => {
    const { id: coord } = coordinator();
    const settled = piChild(coord, "Settled");
    sessionStore.setSettled(settled.sessionId, true);
    settled.steps.push({ kind: "error", message: QUOTA });
    await turn(settled, "late background fact");

    const taken = piChild(coord, "Taken over");
    sessionStore.setSpawnedOwnership(taken.sessionId, "taken-over");
    taken.steps.push({ kind: "error", message: QUOTA });
    await turn(taken, "user turn");

    const unrelated = piChild(undefined, "Not delegated");
    unrelated.steps.push({ kind: "error", message: QUOTA });
    await turn(unrelated, "own work");
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);

    // A deleted child's pending notice is dropped, not delivered.
    const { id: busyCoord, driver: busyDriver } = coordinator("Busy");
    const doomed = piChild(busyCoord, "Doomed");
    const release = busyDriver.holdTurns();
    const busyTurn = promptRuntimeSession(busyDriver, "busy", {
      origin: { kind: "human" },
    });
    doomed.steps.push({ kind: "error", message: QUOTA });
    await turn(doomed, "fails");
    assert.equal(delegationFailureNoticeStore.pendingFor(busyCoord).length, 1);
    delegationFailureNoticeStore.dropForSession(doomed.sessionId, "deleted");
    release();
    await busyTurn;
    await drainRecipient(busyCoord);
    assert.equal(noticesIn(busyCoord).length, 0);
  });

  it("makes no notice for a cancelled delivery", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "never mind",
      responseRequested: true,
    });
    cancelQueuedPeerPrompts({
      senderSessionId: coord,
      recipientSessionId: child.sessionId,
      reason: "Cancelled by the sending session before delivery.",
    });
    await drainRecipient(child.sessionId);
    await quiesce();
    assert.equal(child.prompts, 0);
    assert.equal(noticesIn(coord).length, 0);
  });
});

describe("delivery keeps the hold, busy and restart guarantees", () => {
  it("waits for a busy coordinator's idle edge instead of steering", async () => {
    const { id: coord, driver } = coordinator();
    setSessionIdleHook((id) => void drainRecipient(id));
    const child = piChild(coord);
    const release = driver.holdTurns();
    const busy = promptRuntimeSession(driver, "busy", {
      origin: { kind: "human" },
    });
    await until(() => driver.isRunning, "the coordinator turn");
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    await quiesce();
    assert.equal(noticesIn(coord).length, 0, "nothing joins a running turn");
    assert.equal(driver.promptOptions.length, 1);
    release();
    await busy;
    await until(() => noticesIn(coord).length === 1, "the idle-edge notice");
  });

  it("keeps the fact for a held coordinator across a restart, and delivers after Resume even if the process dies first", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    holdAutomaticTurns(coord);
    fakeDrivers.delete(coord); // cold, as after a restart
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    await quiesce();
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
    assert.equal(
      acquired.includes(coord),
      false,
      "a held parent is never acquired",
    );

    // Restart while held: still nothing, still owed.
    closeDb();
    getDb();
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(acquired.includes(coord), false);
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);

    // Resume lifts the hold, and the process dies before the offer ran.
    automaticTurnHoldStore.release(coord);
    fakeDrivers.set(coord, driver);
    closeDb();
    getDb();
    drainAllQueuedOnBoot();
    await until(() => noticesIn(coord).length === 1, "the restored notice");
    assert.equal(child.prompts, 1, "the child's failed turn is not rerun");
  });

  it("survives a crash right after the failure was recorded, and never replays a delivered notice", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    // The failure is durable before any completion listener runs.
    const seenByListeners: number[] = [];
    const unsubscribe = subscribeSessionRunCompleted((sessionId, stop) => {
      if (sessionId === child.sessionId && stop === "error")
        seenByListeners.push(
          delegationFailureNoticeStore.pendingFor(coord).length,
        );
    });
    // The process dies right after the commit: no wake, no drain happens.
    setPeerPromptDeliveryStoppedForTests(true);
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    unsubscribe();
    await quiesce();
    assert.deepEqual(seenByListeners, [1]);
    assert.equal(noticesIn(coord).length, 0);

    // A new process: same database file, fresh connection.
    setPeerPromptDeliveryStoppedForTests(false);
    closeDb();
    getDb();
    drainAllQueuedOnBoot();
    await until(() => noticesIn(coord).length === 1, "the notice after boot");

    closeDb();
    getDb();
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(
      noticesIn(coord).length,
      1,
      "a delivered notice is not replayed",
    );
  });

  it("announces no historical failure on boot", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    sessionStore.recordRunFailure(child.sessionId, QUOTA);
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
    assert.equal(acquired.includes(coord), false);
  });
});

describe("one incident, one notice, and nothing that loops", () => {
  it("dedupes a duplicated completion and keeps runs apart", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    child.steps.push({
      kind: "error",
      message: QUOTA,
      failure: { kind: "quota" },
      duplicate: true,
    });
    await turn(child, "fails twice over");
    await until(() => noticesIn(coord).length === 1, "the first notice");
    await quiesce();
    assert.equal(driver.promptOptions.length, 1);

    // A later healthy run implicates nothing; a later failure is its own.
    child.steps.push({ kind: "ok" });
    await turn(child, "fine");
    await quiesce();
    assert.equal(noticesIn(coord).length, 1);
    child.steps.push({ kind: "error", message: "401 Unauthorized" });
    await turn(child, "auth now");
    await until(() => noticesIn(coord).length === 2, "the second notice");
    assert.match(noticesIn(coord)[1]!, /rejected its credentials/);
    assert.doesNotMatch(noticesIn(coord)[1]!, /billing limit/);
  });

  it("gathers repeated failures behind a busy coordinator into one entry", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    const release = driver.holdTurns();
    const busy = promptRuntimeSession(driver, "busy", {
      origin: { kind: "human" },
    });
    for (let i = 0; i < 2; i++) {
      child.steps.push({ kind: "error", message: QUOTA });
      await turn(child, `fails ${i}`);
    }
    release();
    await busy;
    await drainRecipient(coord);
    await until(() => noticesIn(coord).length === 1, "the notice");
    assert.match(noticesIn(coord)[0]!, /failed 2 times/);
  });

  it("keeps provider wording, credentials and URLs out of every stored and delivered byte", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    const hostile =
      'Provider error: Authorization: Bearer sk-ant-api03-LEAKED {"error":{"body":"PRIVATE BODY"}} see https://auth.example.invalid/oauth?code=LEAKCODE';
    child.steps.push({ kind: "error", message: hostile });
    await turn(child, "fails");
    await until(() => noticesIn(coord).length === 1, "the notice");
    const stored = JSON.stringify(
      getDb().prepare("SELECT * FROM delegation_failure_notices").all(),
    );
    const delivered = readFileSync(canonicalSessionLogPath(coord), "utf8");
    for (const secret of [
      "sk-ant",
      "LEAKED",
      "PRIVATE BODY",
      "auth.example",
      "LEAKCODE",
    ]) {
      assert.equal(stored.includes(secret), false, `stored: ${secret}`);
      assert.equal(delivered.includes(secret), false, `delivered: ${secret}`);
    }
  });

  it("states a reset time only when the harness reported one as a field", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    const resetAtMs = Date.UTC(2031, 0, 2, 3, 4, 5);
    child.steps.push({
      kind: "error",
      message: "usage limit reached; resets in 3 hours",
      failure: { kind: "quota", resetAtMs },
    });
    await turn(child, "fails");
    await until(() => noticesIn(coord).length === 1, "the notice");
    assert.match(noticesIn(coord)[0]!, /resets at 2031-01-02T03:04:05\.000Z/);

    const { id: other } = coordinator("Other");
    const prose = piChild(other);
    prose.steps.push({
      kind: "error",
      message: "usage limit reached; resets in 3 hours",
    });
    await turn(prose, "fails");
    await until(() => noticesIn(other).length === 1, "the notice");
    assert.doesNotMatch(noticesIn(other)[0]!, /resets/);
  });

  it("never notifies itself, and two sessions waiting on each other cannot trade notices", async () => {
    const { id: a, driver: aDriver } = coordinator("A");
    const bDriver = piChild(undefined, "B");
    const b = bDriver.sessionId;
    // Each asked the other for a reply that is still owed.
    awaitingRow(a, b);
    awaitingRow(b, a);
    const rowsBefore = peerPromptStore.listByParticipant(a, 200).length;

    // A's notice turn will fail too, as a shared limit would make it.
    aDriver.behavior = { mode: "error", message: QUOTA };
    bDriver.steps.push({ kind: "error", message: QUOTA });
    await turn(bDriver, "background fact");
    await until(() => noticesIn(a).length === 1, "A's notice");
    await quiesce();
    assert.equal(
      noticesIn(b).length,
      0,
      "a notice turn's failure goes nowhere by request",
    );
    assert.equal(
      peerPromptStore.listByParticipant(a, 200).length,
      rowsBefore,
      "a notice is no peer message and owes no reply",
    );
  });

  it("carries a failed notice turn up the spawn tree once per level, ending at the root", async () => {
    const { id: root, driver: rootDriver } = coordinator("Root");
    const { id: mid, driver: midDriver } = coordinator("Mid");
    sessionStore.linkSpawned(root, mid);
    const leaf = piChild(mid, "Leaf");
    midDriver.behavior = { mode: "error", message: QUOTA };
    rootDriver.behavior = { mode: "error", message: QUOTA };
    leaf.steps.push({ kind: "error", message: QUOTA });
    await turn(leaf, "fails");
    await until(() => noticesIn(root).length === 1, "the root's notice");
    await quiesce();
    assert.equal(noticesIn(mid).length, 1);
    assert.equal(noticesIn(root).length, 1);
    assert.equal(noticesIn(leaf.sessionId).length, 0, "nothing flows down");
    assert.match(noticesIn(root)[0]!, new RegExp(`session \`${mid}\``));
  });
});
