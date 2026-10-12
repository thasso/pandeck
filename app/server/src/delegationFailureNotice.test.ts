/**
 * Delegation-failure notices end to end: a child's failed turn travels through
 * the REAL runtime (`liveSession.ts`), the real pi adapter or a real
 * `ClaudeSdkSession` over a scripted seam, the runtime's failure hook, the
 * durable notice store and the real peer drain into its coordinator's log.
 * Only the providers are fake. Everything lives under the suite's temporary
 * `DATA_DIR` (`test/setup.ts`); no credential, provider or network is touched.
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
import type { PromptOrigin } from "@assistant/shared/session";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { delegationFailureNoticeStore } from "./db/delegationFailureNoticeStore.ts";
import { automaticTurnHoldStore } from "./db/automaticTurnHoldStore.ts";
import { closeDb, getDb } from "./db/index.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { FakeRuntimeDriver } from "./test/fakeRuntimeDriver.ts";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
  RunFailureFacts,
} from "./session/adapters/contract.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { runFailureFacts } from "./providerErrors.ts";
import type { PiDriver } from "./session/adapters/pi.ts";
import type { ClaudeSdkMessage, ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";

const { fakeDrivers, deadIds, acquired, duringAcquire, fakeHub } = vi.hoisted(
  () => {
    const fakeDrivers = new Map<string, unknown>();
    const deadIds = new Set<string>();
    /** Every session the drain had to cold-acquire, in order. */
    const acquired: string[] = [];
    /** Runs inside an acquisition, as other work may while it is awaited. */
    const duringAcquire: { run?: (id: string) => void } = {};
    const fakeHub = {
      getLiveById: (id: string) => fakeDrivers.get(id),
      acquireById: async (id: string) => {
        acquired.push(id);
        await Promise.resolve();
        duringAcquire.run?.(id);
        if (deadIds.has(id)) throw new Error("no on-disk state to resume from");
        return fakeDrivers.get(id);
      },
      broadcastSessions: () => {},
      broadcastPeerPromptCardUpdate: () => {},
      broadcastPeerPromptQueue: () => {},
    };
    return { fakeDrivers, deadIds, acquired, duringAcquire, fakeHub };
  },
);

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
const { setRunFailureHook, setSessionIdleHook, subscribeSessionRunCompleted } =
  await import("./session/runtime/liveSession.ts");
const { createPiAdapter } = await import("./session/adapters/pi.ts");
const { NativeAdapterEventSource } =
  await import("./session/adapters/nativeEvents.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { holdAutomaticTurns } = await import("./automaticTurnHold.ts");
const {
  PEER_NOTICE_AGENT_ID,
  delegationFailureNoticeLines,
  recordRunFailureNotices,
  recoverRunFailureNoticesOnBoot,
} = await import("./delegationFailureNotice.ts");
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
      /** End it as aborted, as pi does when its run was stopped. */
      aborted?: boolean;
      /** That abort was asked for (pi's `explicitAbortRequested`). */
      abortRequested?: boolean;
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
        ...(step.aborted ? { aborted: true } : {}),
        ...(step.abortRequested ? { abortRequested: true } : {}),
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
  delete duringAcquire.run;
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

  it("tells a sender whose requested reply failed in its own turn once, with the row taken over in the same write", async () => {
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

    const row = peerPromptStore.getById(message.id)!;
    assert.equal(row.status, "interrupted");
    assert.equal(row.interruptionKind, "failure");
    assert.notEqual(row.senderNotifiedAt, undefined, "told by this notice");
    assert.doesNotMatch(row.failureReason ?? "", /monthly spend limit/);
    assert.equal(noticesIn(coord).length, 1, "one failure, one notice");
    assert.match(noticesIn(coord)[0]!, /usage, spend or billing limit/);
    assert.match(noticesIn(coord)[0]!, /Left unanswered: your message sent/);
    assert.doesNotMatch(noticesIn(coord)[0]!, /monthly spend limit/);
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
    const resetAtMs = Math.floor(Date.now() / 1000) * 1000 + 3 * 60 * 60_000;
    child.steps.push({
      kind: "error",
      message: "usage limit reached; resets in 3 hours",
      failure: { kind: "quota", resetAtMs },
    });
    await turn(child, "fails");
    await until(() => noticesIn(coord).length === 1, "the notice");
    assert.ok(
      noticesIn(coord)[0]!.includes(
        `resets at ${new Date(resetAtMs).toISOString()}`,
      ),
    );

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

/* ------------------------- runs and their stragglers ------------------------ */

/**
 * A child whose adapter is driven event by event, with run ids, and whose
 * prompts resolve only when the test says — so an earlier run's late answer
 * can arrive while a newer run is open.
 */
class ScriptedChild {
  readonly id: string;
  readonly key: string;
  readonly harness: Harness = "pi";
  readonly agentType: AgentType = "assistant";
  readonly sessionFile = undefined;
  readonly canSteer = false;
  readonly pending: Array<{
    resolve: (r: AgentRunResult) => void;
    reject: (e: Error) => void;
  }> = [];
  private readonly listeners = new Set<(event: AdapterEvent) => void>();
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
  emit(event: AdapterEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  createRuntimeAdapter(): PromptableAdapter {
    return {
      provider: "scripted",
      capabilities: { fork: "none", compact: false, attachments: false },
      subscribe: (listener: (event: AdapterEvent) => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      getBinding: () => ({ provider: "scripted" }),
      prompt: () =>
        new Promise<AgentRunResult>((resolve, reject) =>
          this.pending.push({ resolve, reject }),
        ),
      abort: () => {},
      setModel: () => {},
      setReasoning: () => {},
      dispose: () => {},
    } as unknown as PromptableAdapter;
  }
}

function scriptedChild(parentId: string): ScriptedChild {
  const id = seed("Scripted child");
  sessionStore.linkSpawned(parentId, id);
  const child = new ScriptedChild(id);
  fakeDrivers.set(id, child);
  return child;
}

const BACKGROUND: PromptOrigin = { kind: "system", source: "background-work" };

describe("a straggler of an earlier run implicates nothing newer", () => {
  it("an old run's failed completion neither fails nor ends a healthy newer run", async () => {
    const { id: coord } = coordinator();
    const child = scriptedChild(coord);
    const first = promptRuntimeSession(child as never, "first", {
      origin: BACKGROUND,
    });
    await until(() => child.pending.length === 1, "the first prompt");
    child.emit({ type: "messageStarted", streamId: "a", run: 1 });
    child.emit({
      type: "messageCompleted",
      streamId: "a",
      content: [],
      run: 1,
    });
    child.emit({ type: "runCompleted", stopReason: "end", run: 1 });
    child.pending.shift()!.resolve({ stopReason: "end" });
    await first;

    const second = promptRuntimeSession(child as never, "second", {
      origin: BACKGROUND,
    });
    await until(() => child.pending.length === 1, "the second prompt");
    child.emit({ type: "messageStarted", streamId: "b", run: 2 });
    // Run 1's end, reported again with an error, after run 2 opened.
    child.emit({
      type: "messageCompleted",
      streamId: "a",
      content: [],
      stopReason: "error",
      error: "OLD 401 Unauthorized",
      run: 1,
    });
    child.emit({
      type: "runCompleted",
      stopReason: "error",
      errorMessage: "OLD 401 Unauthorized",
      run: 1,
    });
    assert.equal(child.isRunning, true, "run 2 keeps running");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);

    child.emit({
      type: "messageCompleted",
      streamId: "b",
      content: [],
      run: 2,
    });
    child.emit({ type: "runCompleted", stopReason: "end", run: 2 });
    child.pending.shift()!.resolve({ stopReason: "end" });
    await second;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("an old prompt's late failed result or throw neither fails nor idles a newer run", async () => {
    const { id: coord } = coordinator();
    const child = scriptedChild(coord);
    for (const late of ["result", "throw"] as const) {
      const old: Promise<unknown> = promptRuntimeSession(
        child as never,
        `old ${late}`,
        {
          origin: BACKGROUND,
        },
      ).catch(() => "failed");
      await until(() => child.pending.length === 1, "the old prompt");
      const oldRun = child.pending.shift()!;
      const r = late === "result" ? 10 : 20;
      child.emit({ type: "messageStarted", streamId: `o${r}`, run: r });
      child.emit({
        type: "messageCompleted",
        streamId: `o${r}`,
        content: [],
        run: r,
      });
      child.emit({ type: "runCompleted", stopReason: "end", run: r });

      const newer = promptRuntimeSession(child as never, `new ${late}`, {
        origin: BACKGROUND,
      });
      await until(() => child.pending.length === 1, "the newer prompt");
      child.emit({ type: "messageStarted", streamId: `n${r}`, run: r + 1 });
      if (late === "result")
        oldRun.resolve({ stopReason: "error", errorMessage: "OLD late 401" });
      else oldRun.reject(new Error("OLD late 401"));
      assert.equal(await old, "failed");
      assert.equal(
        child.isRunning,
        true,
        `the newer run survives a late ${late}`,
      );
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);

      child.emit({
        type: "messageCompleted",
        streamId: `n${r}`,
        content: [],
        run: r + 1,
      });
      child.emit({ type: "runCompleted", stopReason: "end", run: r + 1 });
      child.pending.shift()!.resolve({ stopReason: "end" });
      await newer;
    }
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("the real pi adapter drops an earlier run's completion instead of failing the pending one", async () => {
    let listener: ((event: AdapterEvent) => void) | undefined;
    const adapter = createPiAdapter("pi-stale", {
      sessionFile: undefined,
      subscribeAdapterEvents: (l) => {
        listener = l;
        return () => {};
      },
      prompt: () => "started",
      abort: () => {},
      setModel: () => {},
      setThinkingLevel: () => {},
    });
    const first = adapter.prompt("first");
    listener!({ type: "messageStarted", streamId: "a", run: 1 });
    listener!({ type: "runCompleted", stopReason: "end", run: 1 });
    assert.equal((await first).stopReason, "end");
    let settled = false;
    const second = adapter.prompt("second").then((r) => {
      settled = true;
      return r;
    });
    listener!({ type: "messageStarted", streamId: "b", run: 2 });
    listener!({
      type: "runCompleted",
      stopReason: "error",
      errorMessage: "OLD",
      run: 1,
    });
    await quiesce();
    assert.equal(settled, false, "run 2's prompt is not answered by run 1");
    listener!({ type: "runCompleted", stopReason: "end", run: 2 });
    assert.equal((await second).stopReason, "end");
  });
});

/* -------------------------- the durable boundary --------------------------- */

describe("the failure is durable before anyone hears of it", () => {
  it("the notice exists before the error entry is appended or announced", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const seen: number[] = [];
    const stream = sessionRuntime.openSessionStream(child.sessionId, (e) => {
      if (e.type === "entryAppended" && e.entry.role === "assistant")
        seen.push(delegationFailureNoticeStore.pendingFor(coord).length);
    });
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    stream.unsubscribe();
    assert.deepEqual(seen, [1], "the earliest observer already sees the row");
  });

  it("a failed write is kept, retried, named on the run markers, and logs no provider text", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = true;
    setRunFailureHook((report) => {
      if (failing)
        throw new Error("SQLITE_FULL disk full near sk-ant-api03-LEAKED");
      recordRunFailureNotices(report);
    });
    try {
      child.steps.push({
        kind: "error",
        message: "401 https://auth.example.invalid/?code=LEAKCODE",
      });
      await turn(child, "fails");
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
      assert.equal(
        sessionRuntime.runsToRecheck(child.sessionId).length,
        1,
        "the newest marker names the unrecorded run",
      );
      const logged = errors.mock.calls.flat().join(" ");
      assert.match(logged, /could not record the failure/);
      for (const secret of ["sk-ant", "LEAKED", "auth.example", "LEAKCODE"])
        assert.equal(logged.includes(secret), false, secret);

      // The database recovers; the next turn boundary records it.
      failing = false;
      await turn(child, "next");
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
      assert.deepEqual(
        sessionRuntime.runsToRecheck(child.sessionId),
        [],
        "once recorded, newer markers no longer name it",
      );
    } finally {
      errors.mockRestore();
      uninstall();
      uninstall = installDelegationFailureNotices();
    }
  });

  it("a write that keeps failing past newer turns is still recovered at boot, once", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setRunFailureHook(() => {
      throw new Error("SQLITE_FULL");
    });
    try {
      child.steps.push({ kind: "error", message: QUOTA });
      await turn(child, "fails");
      // Newer runs open and close while the database still refuses.
      await turn(child, "later 1");
      await turn(child, "later 2");
    } finally {
      errors.mockRestore();
      uninstall();
      uninstall = installDelegationFailureNotices();
    }
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);

    // A new process: same database, the same logs, nothing in memory.
    closeDb();
    getDb();
    assert.equal(recoverRunFailureNoticesOnBoot(), 1);
    assert.equal(
      recoverRunFailureNoticesOnBoot(),
      0,
      "a second boot adds nothing",
    );
    drainAllQueuedOnBoot();
    await until(() => noticesIn(coord).length === 1, "the recovered notice");
    assert.match(noticesIn(coord)[0]!, /usage, spend or billing limit/);
  });

  it("a write that failed without a crash leaves the sender to the interruption notice, and boot adds nothing", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    // The coordinator's request is answered in the failing turn.
    const asked = await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "answer me",
      responseRequested: true,
    });
    setRunFailureHook(() => {
      throw new Error("SQLITE_IOERR");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      child.steps.push({
        kind: "error",
        message: QUOTA,
        failure: { kind: "quota" },
      });
      await drainRecipient(child.sessionId);
    } finally {
      errors.mockRestore();
      uninstall();
      uninstall = installDelegationFailureNotices();
    }
    // The process lived on: the peer path saw the failed turn and told the
    // sender itself.
    await until(() => noticesIn(coord).length === 1, "the interruption notice");
    assert.equal(
      peerPromptStore.getById(asked.message.id)?.status,
      "interrupted",
    );

    // A new process: same database, the same logs, nothing in memory.
    closeDb();
    getDb();
    assert.equal(recoverRunFailureNoticesOnBoot(), 0, "told already");
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(noticesIn(coord).length, 1, "one failure, one notice");
  });
});

/* ------------------------------- real deaths ------------------------------- */

/**
 * One scenario in a separate OS process that dies (exit 73) at a chosen point,
 * then another that boots on what it left. Every path the child processes see
 * is disposable and asserted before the app is imported; `fetch` fails closed.
 */
describe("a process that dies mid-failure", () => {
  const src = new URL("./", import.meta.url).href;
  const tsxLoader = fileURLToPath(
    new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
  );
  const script = `
const assert = (await import("node:assert/strict")).default;
const root = process.env.DFN_ROOT;
assert.ok(root && root.startsWith(${JSON.stringify(tmpdir())}));
for (const [key, dir] of [["HOME", "home"], ["ASSISTANT_CWD", "cwd"], ["DATA_DIR", "data"], ["ASSISTANT_LEGACY_PI_AGENT_DIR", "legacy"]])
  assert.equal(process.env[key], root + "/" + dir);
assert.equal(process.env.ASSISTANT_CONFIG, root + "/app.json");
globalThis.fetch = async () => { throw new Error("external fetch denied"); };
const src = process.env.DFN_SRC;
const { DATA_DIR } = await import(src + "config.ts");
assert.equal(DATA_DIR, root + "/data");
const { sessionStore } = await import(src + "db/sessionStore.ts");
const { peerPromptStore } = await import(src + "db/peerPromptStore.ts");
const { delegationFailureNoticeStore: notices } = await import(src + "db/delegationFailureNoticeStore.ts");
const { closeDb } = await import(src + "db/index.ts");
const { sessionRuntime } = await import(src + "session/runtimeInstance.ts");
const { setRunFailureHook } = await import(src + "session/runtime/liveSession.ts");
const { NativeAdapterEventSource } = await import(src + "session/adapters/nativeEvents.ts");
const failures = await import(src + "delegationFailureNotice.ts");
const [mode, scenario] = process.argv.slice(1);
if (mode === "crash") {
  for (const id of ["Coordinator", "Child"])
    sessionStore.upsert({ id, harness: "pi", agentType: "assistant", scope: "user", title: id });
  sessionStore.linkSpawned("Coordinator", "Child");
  if (scenario === "requested") {
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({ conversationId: "c", chainId, hop: peerPromptStore.reserveHop(chainId), senderSessionId: "Coordinator", recipientSessionId: "Child", prompt: "answer me", responseRequested: true });
    peerPromptStore.claimNext("Child", "d", 60000);
    peerPromptStore.markAdmitted(m.id);
    peerPromptStore.markAcknowledged(m.id);
  }
  const events = new NativeAdapterEventSource();
  sessionRuntime.createSession("Child", { provider: "scripted", capabilities: { fork: "none", compact: false }, subscribe: (l) => events.subscribe(l), getBinding: () => ({ provider: "scripted" }), prompt: async () => ({ stopReason: "end" }), abort() {}, setModel() {}, setReasoning() {}, dispose() {} });
  setRunFailureHook(scenario === "write-fails" || scenario === "requested"
    ? () => { throw new Error("SQLITE_FULL"); }
    : (report) => { failures.recordRunFailureNotices(report); });
  sessionRuntime.openSessionStream("Child", (e) => {
    if (scenario === "before" && e.type === "messageStarted") process.exit(73);
    if (e.type === "entryAppended" && e.entry.role === "assistant") process.exit(73);
  });
  events.messageStarted("m");
  events.messageCompleted("m", { errorMessage: "401 Unauthorized", failure: { kind: "auth" } });
  throw new Error("the crash point was not reached");
} else {
  const before = notices.pendingFor("Coordinator").length;
  const recovered = failures.recoverRunFailureNoticesOnBoot();
  const again = failures.recoverRunFailureNoticesOnBoot();
  const after = notices.pendingFor("Coordinator").map((n) => n.category);
  const rows = peerPromptStore.listByParticipant("Child", 10).map((m) => ({ status: m.status, told: m.senderNotifiedAt !== undefined }));
  console.log(JSON.stringify({ before, recovered, again, after, rows }));
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
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          NODE_ENV: "test",
          DFN_ROOT: root,
          DFN_SRC: src,
          HOME: join(root, "home"),
          ASSISTANT_CWD: join(root, "cwd"),
          DATA_DIR: join(root, "data"),
          ASSISTANT_CONFIG: join(root, "app.json"),
          ASSISTANT_LEGACY_PI_AGENT_DIR: join(root, "legacy"),
        },
      },
    );
  }

  function scenario(name: string) {
    const root = mkdtempSync(join(tmpdir(), "dfn-death-"));
    try {
      for (const dir of ["home", "cwd", "data", "legacy"])
        mkdirSync(join(root, dir));
      writeFileSync(
        join(root, "app.json"),
        JSON.stringify({ dataDir: join(root, "data") }),
      );
      const crash = run(root, "crash", name);
      assert.equal(crash.status, 73, crash.stderr);
      const boot = run(root, "boot");
      assert.equal(boot.status, 0, boot.stderr);
      return JSON.parse(boot.stdout.trim().split("\n").at(-1)!) as {
        before: number;
        recovered: number;
        again: number;
        after: string[];
        rows: Array<{ status: string; told: boolean }>;
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("dying at the first fanout of the failure leaves the notice already committed", () => {
    const out = scenario("recorded");
    assert.equal(out.before, 1);
    assert.equal(out.recovered, 0, "nothing to recover: it was written first");
    assert.deepEqual(out.after, ["auth"]);
  }, 120_000);

  it("dying after a failed write recovers the notice from the run's log at boot, once", () => {
    const out = scenario("write-fails");
    assert.equal(out.before, 0);
    assert.equal(out.recovered, 1);
    assert.equal(out.again, 0);
    assert.deepEqual(out.after, ["auth"]);
  }, 120_000);

  it("recovers a requested reply's failure as one notice, the row interrupted and told", () => {
    const out = scenario("requested");
    assert.equal(out.recovered, 1);
    assert.deepEqual(out.rows, [{ status: "interrupted", told: true }]);
  }, 120_000);

  it("dying before any failure was seen announces nothing", () => {
    const out = scenario("before");
    assert.equal(out.before, 0);
    assert.equal(out.recovered, 0);
    assert.deepEqual(out.after, []);
  }, 120_000);
});

/* ---------------------------------- aborts --------------------------------- */

describe("an abort someone asked for is no failure", () => {
  it("is silent when the abort was asked for, even with an error retained", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    // pi's agent_settled after a Stop: aborted, with an earlier attempt's error.
    child.steps.push({
      kind: "error",
      message: "401 Unauthorized",
      failure: { kind: "auth" },
      aborted: true,
      abortRequested: true,
    });
    await turn(child, "stopped while retrying");
    // The runtime's own abort during a turn that then reports an error.
    child.steps.push({ kind: "hold", then: { kind: "error", message: QUOTA } });
    const running = turn(child, "stopped by the runtime");
    await until(() => child.isRunning, "the turn");
    await sessionRuntime.abort(child.sessionId);
    child.release();
    await running;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
  });

  it("still reports a provider-side abort and a plain error", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    child.steps.push({
      kind: "error",
      message: "Request was aborted",
      aborted: true,
    });
    await turn(child, "transport dropped");
    await until(() => noticesIn(coord).length === 1, "the notice");
  });
});

/* ------------------------- eligibility at delivery ------------------------- */

describe("a delegation the user ended after the failure is not announced", () => {
  async function recordedBehindHold(): Promise<{
    coord: string;
    driver: FakeRuntimeDriver;
    child: PiChild;
  }> {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    holdAutomaticTurns(coord);
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
    return { coord, driver, child };
  }

  async function restartAndResume(coord: string): Promise<void> {
    closeDb();
    getDb();
    automaticTurnHoldStore.release(coord);
    drainAllQueuedOnBoot();
    await quiesce();
  }

  it("drops it when the child was taken over or deleted, or both sides settled", async () => {
    const cases: Array<[string, (c: string, k: string) => void]> = [
      [
        "taken over",
        (_c, k) => sessionStore.setSpawnedOwnership(k, "taken-over"),
      ],
      [
        "settled",
        (c, k) => {
          sessionStore.setSettled(c, true);
          sessionStore.setSettled(k, true);
        },
      ],
      ["deleted", (_c, k) => void backgroundWorkStore.deleteOwnerSession(k)],
    ];
    for (const [what, end] of cases) {
      const { coord, child } = await recordedBehindHold();
      end(coord, child.sessionId);
      await restartAndResume(coord);
      assert.equal(noticesIn(coord).length, 0, what);
      assert.equal(
        delegationFailureNoticeStore.pendingFor(coord).length,
        0,
        what,
      );
    }
  });

  it("keeps it for a settled delegation whose request is still unanswered", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    holdAutomaticTurns(coord);
    child.steps.push({ kind: "error", message: QUOTA });
    await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "answer me",
      responseRequested: true,
    });
    await drainRecipient(child.sessionId);
    sessionStore.setSettled(coord, true);
    sessionStore.setSettled(child.sessionId, true);
    await restartAndResume(coord);
    await until(() => noticesIn(coord).length === 1, "the notice");
  });

  it("drops a request notice once the request is answered", async () => {
    const { id: coord } = coordinator();
    const child = piChild(undefined, "Asked, not spawned");
    awaitingRow(coord, child.sessionId);
    holdAutomaticTurns(coord);
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
    await sendPeerPrompt({
      senderSessionId: child.sessionId,
      targetSessionId: coord,
      prompt: "here is the answer after all",
      responseRequested: false,
    });
    await restartAndResume(coord);
    assert.equal(
      noticesIn(coord).filter((t) => /stopped on a failure/.test(t)).length,
      0,
    );
  });

  it("drops it when the delegation ends while a busy coordinator finishes its turn", async () => {
    const { id: coord, driver } = coordinator();
    setSessionIdleHook((id) => void drainRecipient(id));
    const child = piChild(coord);
    const release = driver.holdTurns();
    const busy = promptRuntimeSession(driver, "busy", {
      origin: { kind: "human" },
    });
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    sessionStore.setSpawnedOwnership(child.sessionId, "taken-over");
    release();
    await busy;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("drops it when the delegation ends while the coordinator is being acquired", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    fakeDrivers.delete(coord);
    holdAutomaticTurns(coord);
    child.steps.push({ kind: "error", message: QUOTA });
    await turn(child, "fails");
    fakeDrivers.set(coord, driver);
    // Cold, so the drain acquires it; the user takes the child over meanwhile.
    const cold = fakeDrivers.get(coord);
    fakeDrivers.delete(coord);
    duringAcquire.run = (id) => {
      if (id !== coord) return;
      sessionStore.setSpawnedOwnership(child.sessionId, "taken-over");
      fakeDrivers.set(coord, cold);
    };
    automaticTurnHoldStore.release(coord);
    await drainRecipient(coord);
    await quiesce();
    assert.ok(acquired.includes(coord));
    assert.equal(noticesIn(coord).length, 0);
  });

  it("refuses a turn whose admission check fails, appending nothing", async () => {
    const { id: coord, driver } = coordinator();
    await assert.rejects(
      promptRuntimeSession(driver, "must not land", {
        origin: { kind: "agent", agentId: PEER_NOTICE_AGENT_ID },
        admit: () => {
          throw new Error("changed");
        },
      }),
      /changed/,
    );
    assert.equal(driver.promptOptions.length, 0);
    assert.equal(noticesIn(coord).length, 0);
  });
});

/* ------------------------------- reset times ------------------------------- */

describe("a reset time is stated only when it is a real, plausible date", () => {
  it("drops non-finite, overflowing and out-of-range resets at the source", () => {
    const quota = (resetAt: number) =>
      runFailureFacts({
        kind: "quota",
        title: "",
        summary: "",
        rawMessage: "",
        resetAt,
      });
    for (const bad of [NaN, Infinity, -Infinity, 1e20, 1e13, -5, 0])
      assert.equal(quota(bad).resetAtMs, undefined, String(bad));
    assert.equal(quota(2_000_000_000).resetAtMs, 2_000_000_000_000);
  });

  it("delivers the notice without a reset that is not a date it can state", () => {
    const { id: coord } = coordinator();
    const now = Date.now();
    for (const resetAtMs of [
      1e20,
      NaN,
      Infinity,
      8.64e15 + 1,
      now - 24 * 60 * 60_000,
      now + 2 * 366 * 24 * 60 * 60_000,
    ]) {
      const child = piChild(coord);
      const rows = recordRunFailureNotices(
        {
          sessionId: child.sessionId,
          runId: `run-${resetAtMs}`,
          origin: BACKGROUND,
          errorMessage: "quota",
          failure: { kind: "quota", resetAtMs },
          at: now,
        },
        now,
      );
      assert.equal(rows.length, 1, String(resetAtMs));
      assert.equal(rows[0]!.resetAt, undefined, String(resetAtMs));
      const text = delegationFailureNoticeLines(rows).join("\n");
      assert.match(text, /usage, spend or billing limit/);
      assert.doesNotMatch(text, /resets at/);
    }
    const child = piChild(coord);
    const good = now + 60 * 60_000;
    const [row] = recordRunFailureNotices(
      {
        sessionId: child.sessionId,
        runId: "run-good",
        origin: BACKGROUND,
        errorMessage: "quota",
        failure: { kind: "quota", resetAtMs: good },
        at: now,
      },
      now,
    );
    assert.match(
      delegationFailureNoticeLines([row!]).join("\n"),
      new RegExp(
        `resets at ${new Date(good).toISOString().replace(/\./g, "\\.")}`,
      ),
    );
  });
});

/* --------------------------------- privacy --------------------------------- */

describe("nothing the provider said reaches a log line", () => {
  it("logs no provider text when a child fails and the coordinator's notice turn fails too", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    const hostile =
      'Authorization: Bearer sk-ant-api03-LEAKED https://auth.example.invalid/oauth?code=LEAKCODE {"body":"PRIVATE BODY"}';
    driver.behavior = { mode: "error", message: hostile };
    const spies = (["log", "warn", "error", "info", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      child.steps.push({ kind: "error", message: hostile });
      await turn(child, "fails");
      await until(() => noticesIn(coord).length === 1, "the notice");
      await quiesce();
      const logged = spies
        .flatMap((s) => s.mock.calls.flat())
        .map(String)
        .join(" ");
      assert.match(logged, /was not delivered \(RunFailedError\)/);
      for (const secret of [
        "sk-ant",
        "LEAKED",
        "auth.example",
        "LEAKCODE",
        "PRIVATE BODY",
      ])
        assert.equal(logged.includes(secret), false, secret);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
