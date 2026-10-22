/**
 * Delegation-failure notices end to end: a child's failed turn travels through
 * the REAL runtime (`liveSession.ts`), the real pi adapter or a real
 * `ClaudeSdkSession` over a scripted seam, the runtime's failure hook, the
 * durable notice store and the real peer drain into its coordinator's log.
 * Only the providers are fake. Everything lives under the suite's temporary
 * `DATA_DIR` (`test/setup.ts`); no credential, provider or network is touched.
 */
import assert from "node:assert/strict";
import { installDeliveryTestScheduler } from "./test/deliveryScheduler.ts";
import { setDeliveryWake } from "./deliveryWake.ts";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
  vi,
} from "vitest";
import type { AgentType, Harness } from "@assistant/shared";
import type { PromptOrigin } from "@assistant/shared/session";
import { sessionStore } from "./db/sessionStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import {
  delegationFailureNoticeStore,
  type HeldStartCategory,
} from "./db/delegationFailureNoticeStore.ts";
import { directPeerChildStore } from "./db/directPeerChildStore.ts";
import type { PeerPromptRecord } from "./db/peerPromptStore.ts";
import { updateSettings } from "./settings.ts";
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
  drainJournaledFailureBacklog,
  drainRecipient: requestRecipientDelivery,
  installDelegationFailureNotices,
  runPeerPromptRetention,
  sendPeerPrompt,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
  setPeerPromptDeliveryStoppedForTests: setPeerDeliveryStopped,
  sweepPeerPromptRetries,
  wakeForNotice,
} = await import("./peerPrompt.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSession } = await import("./session/runtimePrompt.ts");
const { setRunFailureHook, setSessionIdleHook, subscribeSessionRunCompleted } =
  await import("./session/runtime/liveSession.ts");
const { createPiAdapter } = await import("./session/adapters/pi.ts");
const { NativeAdapterEventSource } =
  await import("./session/adapters/nativeEvents.ts");
const { ClaudeSdkSession } = await import("./test/claudeSdkSession.ts");
const { holdAutomaticTurns } = await import("./automaticTurnHold.ts");
const {
  HELD_START_REASONS,
  PEER_NOTICE_AGENT_ID,
  deliverableNotices,
  recordHeldStartNotice,
  delegationFailureNoticeLines,
  recordRunFailureNotices,
  recoverJournaledFailuresOnBoot,
  replayJournaledFailures,
} = await import("./delegationFailureNotice.ts");
const journal = await import("./delegationFailureJournal.ts");
const { DATA_DIR } = await import("./config.ts");
const { measureCpuMs, measureCpuMsAsync } = await import("./test/cpuBudget.ts");
const { PiLiveSession } = await import("./piSdk/PiLiveSession.ts");
const { sessionControlTools, setSessionControlRuntimeForTests } =
  await import("./tools/sessions/sessionControlTool.ts");

setHubForTests(fakeHub as never);
let delivery: ReturnType<typeof installDeliveryTestScheduler>;
let deliveryStopped = false;
function setPeerPromptDeliveryStoppedForTests(stopped: boolean) {
  deliveryStopped = stopped;
  setPeerDeliveryStopped(stopped);
}
beforeEach(() => {
  delivery = installDeliveryTestScheduler({
    live: (id) => fakeHub.getLiveById(id) as RuntimePromptDriver | undefined,
    acquire: async (id) =>
      (await fakeHub.acquireById(id)) as RuntimePromptDriver | undefined,
    shutdown: () => deliveryStopped,
  });
  setSessionIdleHook((id, runId) => void delivery.wake(id, runId));
});
const drainRecipient = async (id: string) => {
  await requestRecipientDelivery(id);
  return delivery.drain(id);
};

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
  | { kind: "hold"; then: Step }
  /** Take the prompt and emit nothing: the turn's first message is pending. */
  | { kind: "wait" }
  /** The harness refuses the prompt outright (a genuine startup failure). */
  | { kind: "throw"; message: string }
  /** The harness's own run settles failed before any message (startup). */
  | { kind: "rejectCompletion"; message: string };

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
  /** The harness's native event source, for tests that drive it directly. */
  readonly events = new NativeAdapterEventSource();
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
        if (step.kind === "throw") throw new Error(step.message);
        if (step.kind === "rejectCompletion")
          return {
            outcome: "started" as const,
            completed: Promise.reject(new Error(step.message)),
          };
        if (step.kind !== "wait") setTimeout(() => this.play(step), 0);
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
  get isHeld(): boolean {
    return this.releaseHeld !== undefined;
  }
  release(): void {
    this.releaseHeld?.();
  }
  /** Run a step now, as the harness would for the turn already prompted. */
  play(step: Step): void {
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
  readonly session: InstanceType<typeof ClaudeSdkSession>;
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

/**
 * A REAL `PiLiveSession` over a scripted pi session (only the provider is
 * fake), bound to the runtime as the harness would be.
 */
function realPiChild(parentId: string): {
  id: string;
  live: InstanceType<typeof PiLiveSession>;
  emit: (event: Record<string, unknown>) => void;
} {
  const id = seed("Real pi child");
  sessionStore.linkSpawned(parentId, id);
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const session = {
    sessionId: id,
    sessionName: "Already named",
    isStreaming: false,
    sessionManager: {
      getBranch: () => [],
      getEntries: () => [],
      getHeader: () => undefined,
    },
    subscribe: (l: (event: Record<string, unknown>) => void) => {
      listener = l;
      return () => {};
    },
    getSessionStats: () => ({
      totalMessages: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    settingsManager: {
      getRetrySettings: () => ({ enabled: true, maxRetries: 3 }),
      applyOverrides() {},
    },
    prompt: () => new Promise(() => {}),
    abortRetry() {},
    dispose() {},
  };
  const host = {
    broadcastSessions: async () => {},
    noteRunStarted() {},
    checkPendingReload() {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  };
  const live = new PiLiveSession(
    "assistant",
    session as never,
    host as never,
    () => {},
  );
  sessionRuntime.createSession(id, live.createRuntimeAdapter());
  return { id, live, emit: (event) => listener!(event) };
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

async function until(
  check: () => boolean,
  what: string,
  withinMs = 1_000,
): Promise<void> {
  for (let i = 0; i < withinMs / 5; i++) {
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

/** Notices ever recorded for a coordinator, delivered or not. */
function recordedFor(coordinatorId: string): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM delegation_failure_notices WHERE coordinator_session_id = ?",
      )
      .get(coordinatorId) as { n: number }
  ).n;
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
  setDeliveryWake(undefined);
  setSessionIdleHook(undefined);
  setPeerPromptAutoDeliverForTests(false);
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
    // Match the status code, not an ISO timestamp's incidental `.503Z`.
    assert.doesNotMatch(text, /not accepted|\b503\b|Unavailable/);
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
    // Runtime running precedes the scripted provider's setTimeout(0) hold.
    await until(() => child.isHeld, "the held provider turn");
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
    // Wait until release() can actually finish the scripted provider turn.
    await until(() => child.isHeld, "the held provider turn");
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
    setSessionIdleHook((id) => void delivery.wake(id));
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

  it("the real pi harness records the failure before any of its viewers hears of it", () => {
    const { id: coord } = coordinator();
    const child = realPiChild(coord);
    const seen: string[] = [];
    const pending = () => delegationFailureNoticeStore.pendingFor(coord).length;
    child.live.addViewer({
      send: (e: { type: string; error?: unknown; severity?: unknown }) => {
        if (e.error !== undefined || e.severity === "error")
          seen.push(`${e.type}:${pending()}`);
      },
    } as never);
    const stream = sessionRuntime.openSessionStream(child.id, (e) => {
      if (e.type === "entryAppended") seen.push(`entry:${pending()}`);
    });
    // Retries exhausted, then the turn settles failed.
    child.emit({ type: "agent_start" });
    child.emit({
      type: "auto_retry_end",
      success: false,
      finalError: "429 Too Many Requests",
    });
    child.emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "401 Unauthorized",
      },
    });
    child.emit({ type: "agent_settled" });
    stream.unsubscribe();
    assert.ok(seen.length >= 2, seen.join(" "));
    assert.ok(
      seen.every((s) => s.endsWith(":1")),
      `every failure fanout came after the record: ${seen.join(" ")}`,
    );
    assert.equal(pending(), 1, "one incident, one notice");
  });

  it("the real pi harness records a prompt it could not send before its banner", () => {
    const { id: coord } = coordinator();
    const child = realPiChild(coord);
    const seen: string[] = [];
    child.live.addViewer({
      send: (e: { type: string; error?: unknown; severity?: unknown }) => {
        if (e.error !== undefined || e.severity === "error")
          seen.push(
            `${e.type}:${delegationFailureNoticeStore.pendingFor(coord).length}`,
          );
      },
    } as never);
    // The runtime opened the turn for the prompt the harness then failed.
    void sessionRuntime
      .prompt(child.id, "go", { origin: BACKGROUND })
      .catch(() => {});
    (
      child.live as unknown as {
        finishPromptError(err: unknown, wasRunning: boolean): void;
      }
    ).finishPromptError(new Error("401 Unauthorized"), false);
    assert.deepEqual(seen, ["notice:1", "assistantEnd:1"]);
  });

  it("the real Claude session records the failure before its viewers hear of it", async () => {
    const { id: coord } = coordinator();
    const childId = seed("Claude child", "claude-sdk");
    sessionStore.linkSpawned(coord, childId);
    const child = new ClaudeChild(childId);
    fakeDrivers.set(childId, child);
    const seen: number[] = [];
    child.session.addViewer({
      send: (e: { type: string; error?: unknown }) => {
        if (e.type === "assistantEnd" && e.error !== undefined)
          seen.push(delegationFailureNoticeStore.pendingFor(coord).length);
      },
    } as never);
    await turn(child, "go");
    assert.deepEqual(seen, [1]);
  });

  it("a database that refuses keeps the failure journaled, and the sweep or the next boot records it once", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = vi
      .spyOn(delegationFailureNoticeStore, "record")
      .mockImplementation(() => {
        throw hostileError();
      });
    try {
      child.steps.push({ kind: "error", message: QUOTA });
      await turn(child, "fails");
      // Newer turns, even large ones, cannot bury it: it is not in the log.
      child.steps.push({ kind: "ok" }, { kind: "ok" });
      await turn(child, "later 1");
      await turn(child, "later 2");
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
      // A boot while the database still refuses keeps it owed.
      closeDb();
      getDb();
      assert.equal(recoverJournaledFailuresOnBoot(), 0);
      assertNothingHostileIn(errors.mock.calls);
    } finally {
      refuse.mockRestore();
      errors.mockRestore();
    }
    // A new process: same database, same journal, nothing in memory.
    closeDb();
    getDb();
    assert.equal(recoverJournaledFailuresOnBoot(), 1);
    assert.equal(
      recoverJournaledFailuresOnBoot(),
      0,
      "a second boot adds nothing",
    );
    drainAllQueuedOnBoot();
    await until(() => noticesIn(coord).length === 1, "the recovered notice");
    assert.match(noticesIn(coord)[0]!, /usage, spend or billing limit/);
    // The sweep retries what the database refused while the process lives.
    const later = piChild(coord, "Swept");
    const again = vi
      .spyOn(delegationFailureNoticeStore, "record")
      .mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY");
      });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      later.steps.push({ kind: "error", message: "401 Unauthorized" });
      await turn(later, "fails");
    } finally {
      quiet.mockRestore();
    }
    again.mockRestore();
    sweepPeerPromptRetries();
    await until(() => noticesIn(coord).length === 2, "the swept notice");
  });

  it("only when no store takes it does the runtime hold it in memory, retry it, and say so in fixed words", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = true;
    const hostile = new Error("disk full near sk-ant-api03-LEAKED");
    hostile.name = "Bearer MOCK-LEAK https://mock.invalid/?token=MOCK";
    setRunFailureHook((report) => {
      if (failing) throw hostile;
      recordRunFailureNotices(report);
    });
    try {
      child.steps.push({ kind: "error", message: QUOTA });
      await turn(child, "fails");
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
      const logged = errors.mock.calls.flat().map(String).join(" ");
      assert.match(logged, /could not store the failure of run/);
      for (const secret of [
        "sk-ant",
        "LEAKED",
        "MOCK-LEAK",
        "mock.invalid",
        "Bearer",
      ])
        assert.equal(logged.includes(secret), false, secret);
      failing = false;
      await turn(child, "next");
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
    } finally {
      errors.mockRestore();
      uninstall();
      uninstall = installDelegationFailureNotices();
    }
  });

  it("a write that failed without a crash leaves the sender to the interruption notice, and boot adds nothing", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "start");
    const asked = await sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child.sessionId,
      prompt: "answer me",
      responseRequested: true,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const refuse = vi
      .spyOn(delegationFailureNoticeStore, "record")
      .mockImplementation(() => {
        throw new Error("SQLITE_IOERR");
      });
    try {
      child.steps.push({
        kind: "error",
        message: QUOTA,
        failure: { kind: "quota" },
      });
      await drainRecipient(child.sessionId);
    } finally {
      refuse.mockRestore();
      errors.mockRestore();
    }
    // The process lived on: the peer path saw the failed turn and told the
    // sender itself.
    await until(() => noticesIn(coord).length === 1, "the interruption notice");
    assert.equal(
      peerPromptStore.getById(asked.message.id)?.status,
      "interrupted",
    );
    closeDb();
    getDb();
    assert.equal(recoverJournaledFailuresOnBoot(), 0, "told already");
    drainAllQueuedOnBoot();
    await quiesce();
    assert.equal(noticesIn(coord).length, 1, "one failure, one notice");
  });
});

/* -------------------------------- ownership -------------------------------- */

describe("a completion no run owns belongs to no turn", () => {
  it("a native straggler with no run open neither fails, idles nor answers a new turn awaiting its first message", async () => {
    const { id: coord } = coordinator();
    const child = piChild(coord);
    await turn(child, "first");
    child.steps.push({ kind: "wait" });
    let settled = false;
    const second = promptRuntimeSession(child as never, "second", {
      origin: BACKGROUND,
    }).finally(() => {
      settled = true;
    });
    await until(() => child.prompts === 2, "the second prompt");
    // The first run's end, reported again by the native source.
    child.events.runCompleted("error", "OLD 401 Unauthorized", {
      kind: "auth",
    });
    await quiesce();
    assert.equal(child.isRunning, true);
    assert.equal(settled, false, "the pending prompt is not answered");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
    // The second run's own healthy completion still ends it.
    child.play({ kind: "ok" });
    await second;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("the runtime itself ignores an unowned completion, whatever adapter forwards it", async () => {
    const { id: coord } = coordinator();
    const child = scriptedChild(coord);
    const run = promptRuntimeSession(child as never, "awaiting", {
      origin: BACKGROUND,
    });
    await until(() => child.pending.length === 1, "the prompt");
    // No message yet; a forwarded straggler that belongs to no run.
    child.emit({ type: "runFailing", errorMessage: "OLD 401", unowned: true });
    child.emit({
      type: "messageCompleted",
      streamId: "old",
      content: [],
      stopReason: "error",
      error: "OLD 401",
      unowned: true,
    });
    child.emit({
      type: "runCompleted",
      stopReason: "error",
      errorMessage: "OLD 401",
      unowned: true,
    });
    assert.equal(child.isRunning, true, "the awaiting turn stays open");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
    child.emit({ type: "messageStarted", streamId: "own", run: 1 });
    child.emit({
      type: "messageCompleted",
      streamId: "own",
      content: [],
      run: 1,
    });
    child.emit({ type: "runCompleted", stopReason: "end", run: 1 });
    child.pending.shift()!.resolve({ stopReason: "end" });
    await run;
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("a genuine startup failure still reports, through the prompt that owned it", async () => {
    const { id: coord } = coordinator();
    for (const step of [
      { kind: "throw" as const, message: "401 Unauthorized" },
      { kind: "rejectCompletion" as const, message: "401 Unauthorized" },
    ]) {
      const child = piChild(coord, `Starts badly (${step.kind})`);
      child.steps.push(step);
      await turn(child, "go");
    }
    await until(() => noticesIn(coord).length >= 1, "the notices");
    await quiesce();
    const text = noticesIn(coord).join("\n");
    assert.equal((text.match(/rejected its credentials/g) ?? []).length, 2);
  });
});

/* ------------------------------- real deaths ------------------------------- */

/**
 * Scenarios in separate OS processes that die (exit 73) at a chosen point,
 * then boot (and, where it matters, boot again) on what they left. Every path
 * a child process sees is disposable and asserted before the app is imported;
 * `fetch` fails closed; providers are scripted.
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
const [mode, scenario] = process.argv.slice(1);
const journalPath = root + "/data/delegation-failure-journal.jsonl";
if (mode === "crash" && scenario === "done-lost") {
  // The journal's retirement never reaches the disk; everything else does.
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const fs = createRequire(import.meta.url)("node:fs");
  const append = fs.appendFileSync;
  fs.appendFileSync = function (path, data, ...rest) {
    if (String(path) === journalPath && String(data).includes('"kind":"done"')) throw new Error("retirement refused");
    return append.call(this, path, data, ...rest);
  };
  syncBuiltinESMExports();
}
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
const ERROR = { errorMessage: "401 Unauthorized", failure: { kind: "auth" } };
const refuseDatabase = () => { notices.record = () => { throw new Error("SQLITE_FULL"); }; };
function nativeChild(prompt) {
  const events = new NativeAdapterEventSource();
  sessionRuntime.createSession("Child", { provider: "scripted", capabilities: { fork: "none", compact: false }, subscribe: (l) => events.subscribe(l), getBinding: () => ({ provider: "scripted" }), prompt: prompt ?? (async () => ({ stopReason: "end" })), abort() {}, setModel() {}, setReasoning() {}, dispose() {} });
  return events;
}
const dieAtAssistantEntry = () => sessionRuntime.openSessionStream("Child", (e) => { if (e.type === "entryAppended" && e.entry.role === "assistant") process.exit(73); });
setRunFailureHook(failures.recordRunFailureNotices);
if (mode === "crash") {
  for (const id of ["Coordinator", "Child", "FutureRequester"])
    sessionStore.upsert({ id, harness: "pi", agentType: "assistant", scope: "user", title: id });
  sessionStore.linkSpawned("Coordinator", "Child");
  if (scenario === "torn") { const { mkdirSync, writeFileSync } = await import("node:fs"); mkdirSync(root + "/data", { recursive: true }); writeFileSync(journalPath, '{"kind":"failed","incidentKey":"trunc'); }
  if (scenario === "requested" || scenario === "settled") {
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue({ conversationId: "c", chainId, hop: peerPromptStore.reserveHop(chainId), senderSessionId: "Coordinator", recipientSessionId: "Child", prompt: "answer me", responseRequested: true });
    peerPromptStore.claimNext("Child", "d", 60000);
    peerPromptStore.markAdmitted(m.id);
    peerPromptStore.markAcknowledged(m.id);
    if (scenario === "settled") { peerPromptStore.markCompleted(m.id); sessionStore.setSettled("Child", true); }
  }
  if (!["recorded", "before", "pi-fanout", "claude-fanout", "standdown", "done-lost"].includes(scenario)) refuseDatabase();
  if (scenario === "pi-fanout" || scenario === "pi-fanout-refused") {
    const { PiLiveSession } = await import(src + "piSdk/PiLiveSession.ts");
    let listener;
    const session = { sessionId: "Child", sessionName: "Already named", isStreaming: false, sessionManager: { getBranch: () => [], getEntries: () => [] }, subscribe: (l) => { listener = l; return () => {}; }, getSessionStats: () => ({ totalMessages: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), settingsManager: { getRetrySettings: () => ({ enabled: true, maxRetries: 3 }), applyOverrides() {} }, abortRetry() {}, dispose() {} };
    const host = { broadcastSessions: async () => {}, noteRunStarted() {}, checkPendingReload() {}, isReloadQueued: () => false, buildSessionState: () => ({}) };
    const live = new PiLiveSession("assistant", session, host, () => {});
    sessionRuntime.createSession("Child", live.createRuntimeAdapter());
    live.addViewer({ send: (e) => { if (e.type === "assistantEnd" && e.error) process.exit(73); } });
    listener({ type: "agent_start" });
    listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized" } });
    listener({ type: "agent_settled" });
  } else if (scenario === "claude-fanout") {
    const { ClaudeSdkSession } = await import(src + "test/claudeSdkSession.ts");
    const seam = { query() { return { async *[Symbol.asyncIterator]() {
      yield { type: "assistant", uuid: "s1", session_id: "p", error: "rate_limit", message: { id: "m1", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your org's monthly spend limit" }], usage: { input_tokens: 0, output_tokens: 0 } } };
      yield { type: "result", subtype: "success", session_id: "p", is_error: true, api_error_status: 429, result: "API Error: 429", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} };
    } }; } };
    const live = new ClaudeSdkSession("Child", { seam: () => Promise.resolve(seam) });
    sessionRuntime.createSession("Child", live.createRuntimeAdapter());
    live.addViewer({ send: (e) => { if (e.type === "assistantEnd" && e.error) process.exit(73); } });
    await sessionRuntime.prompt("Child", "go", { origin: { kind: "system", source: "background-work" } });
  } else if (scenario === "no-event" || scenario === "throw") {
    nativeChild(async () => { if (scenario === "throw") throw new Error("401 Unauthorized"); return { stopReason: "error", errorMessage: "401 Unauthorized" }; });
    await sessionRuntime.prompt("Child", "background job finished", { origin: { kind: "system", source: "background-work" } }).catch(() => undefined);
    process.exit(73);
  } else {
    const events = nativeChild();
    if (scenario === "before") sessionRuntime.openSessionStream("Child", (e) => { if (e.type === "messageStarted") process.exit(73); });
    if (!["large", "future-work", "done-lost", "torn"].includes(scenario)) dieAtAssistantEntry();
    events.messageStarted("m");
    if (scenario === "standdown") { failures.noteDelegationStandDown("Child"); await sessionRuntime.abort("Child"); }
    if (scenario === "provider-abort") { events.runFailing("Request was aborted", { kind: "auth" }); events.messageCompleted("m", { ...ERROR, aborted: true }); }
    else events.messageCompleted("m", ERROR);
    if (scenario === "large") { events.messageStarted("n"); events.messageDelta("n", "text", "x".repeat(9 * 1024 * 1024)); events.messageCompleted("n"); process.exit(73); }
    if (scenario === "future-work" || scenario === "done-lost" || scenario === "torn") {
      // Unrelated work the child takes in AFTER the failure.
      const t = Date.now() + 1000;
      const chainId = peerPromptStore.createChain();
      const m = peerPromptStore.enqueue({ conversationId: "later", chainId, hop: peerPromptStore.reserveHop(chainId), senderSessionId: "FutureRequester", recipientSessionId: "Child", prompt: "new work", responseRequested: true }, t);
      peerPromptStore.claimNext("Child", "d", 60000, t);
      peerPromptStore.markAdmitted(m.id, t);
      peerPromptStore.markAcknowledged(m.id, t);
      process.exit(73);
    }
  }
  throw new Error("the crash point was not reached");
} else if (mode === "boot-refused") {
  refuseDatabase();
  const recovered = failures.recoverJournaledFailuresOnBoot();
  const events = nativeChild();
  events.messageStarted("healthy"); events.messageCompleted("healthy");
  console.log(JSON.stringify({ recovered }));
  process.exit(73);
} else {
  const before = notices.pendingFor("Coordinator").length;
  const recovered = failures.recoverJournaledFailuresOnBoot();
  const again = failures.recoverJournaledFailuresOnBoot();
  const after = notices.pendingFor("Coordinator").map((n) => n.category);
  const rows = peerPromptStore.listByParticipant("Child", 10).filter((m) => m.senderSessionId === "Coordinator").map((m) => ({ status: m.status, told: m.senderNotifiedAt !== undefined }));
  const future = peerPromptStore.listByParticipant("FutureRequester", 10).map((m) => ({ status: m.status, told: m.senderNotifiedAt !== undefined, notices: notices.pendingFor("FutureRequester").length }));
  let next;
  if (scenario === "standdown") {
    const events = nativeChild();
    events.messageStarted("next"); events.messageCompleted("next", ERROR);
    next = notices.pendingFor("Coordinator").length;
  }
  console.log(JSON.stringify({ before, recovered, again, after, rows, future, next }));
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
        maxBuffer: 4 * 1024 * 1024,
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

  interface Boot {
    before: number;
    recovered: number;
    again: number;
    after: string[];
    rows: Array<{ status: string; told: boolean }>;
    future: Array<{ status: string; told: boolean; notices: number }>;
    next?: number;
  }

  function scenario(name: string, rebootRefused = false): Boot {
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
      if (rebootRefused) {
        const refused = run(root, "boot-refused", name);
        assert.equal(refused.status, 73, refused.stderr);
        assert.equal(
          JSON.parse(refused.stdout.trim().split("\n").at(-1)!).recovered,
          0,
        );
      }
      const boot = run(root, "boot", name);
      assert.equal(boot.status, 0, boot.stderr);
      return JSON.parse(boot.stdout.trim().split("\n").at(-1)!) as Boot;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("dying at the first fanout leaves the notice committed: native, real pi and real Claude", () => {
    for (const [name, category] of [
      ["recorded", "auth"],
      ["pi-fanout", "auth"],
      ["claude-fanout", "usage_limit"],
    ] as const) {
      const out = scenario(name);
      assert.equal(out.before, 1, name);
      assert.equal(out.recovered, 0, name);
      assert.deepEqual(out.after, [category], name);
    }
  }, 240_000);

  it("a refused database write is recovered at boot once, whatever the failure's path", () => {
    for (const name of [
      "refused",
      "pi-fanout-refused",
      "no-event",
      "throw",
      "large",
      "provider-abort",
    ]) {
      const out = scenario(name);
      assert.equal(out.before, 0, name);
      assert.equal(out.recovered, 1, name);
      assert.equal(out.again, 0, name);
      assert.equal(out.after.length, 1, name);
    }
  }, 360_000);

  it("a requested reply, a settled child with an open request, and repeated refused boots are all recovered", () => {
    const requested = scenario("requested");
    assert.equal(requested.recovered, 1);
    assert.deepEqual(requested.rows, [{ status: "interrupted", told: true }]);
    const settled = scenario("settled");
    assert.equal(settled.recovered, 1);
    const rebooted = scenario("refused", true);
    assert.equal(rebooted.recovered, 1);
  }, 240_000);

  it("later work, a lost retirement and a torn journal tail across real restarts: only the original coordinator, exactly once", () => {
    for (const [name, recovered] of [
      ["future-work", 1],
      ["done-lost", 0],
      ["torn", 1],
    ] as const) {
      const out = scenario(name);
      assert.equal(out.recovered, recovered, name);
      assert.equal(out.again, 0, name);
      assert.deepEqual(out.after, ["auth"], `${name}: the parent, once`);
      assert.deepEqual(
        out.future,
        [{ status: "acknowledged", told: false, notices: 0 }],
        `${name}: later work untouched`,
      );
    }
  }, 240_000);

  it("dying before any failure, or in a run its coordinator stood down, announces nothing; the next run still does", () => {
    const before = scenario("before");
    assert.equal(before.recovered, 0);
    assert.deepEqual(before.after, []);
    const standdown = scenario("standdown");
    assert.equal(standdown.recovered, 0);
    assert.deepEqual(standdown.after, []);
    assert.equal(standdown.next, 1, "a later real failure of the child");
  }, 240_000);
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
    setSessionIdleHook((id) => void delivery.wake(id));
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

describe("a held child refused at start tells its spawner why", () => {
  const categories = Object.keys(HELD_START_REASONS) as HeldStartCategory[];

  function heldRow(
    coord: string,
    child: string,
    responseRequested = true,
  ): PeerPromptRecord {
    return peerPromptStore.enqueueRouted({
      conversationId: `dfn-${n++}`,
      chainId: peerPromptStore.createChain(),
      senderSessionId: coord,
      recipientSessionId: child,
      participants: [coord, child],
      maxHops: 10,
      prompt: "start when there is room",
      responseRequested,
      held: { queueSeq: peerPromptStore.allocateQueueSeq() },
    });
  }

  function registered(coord: string, child: string, agent: boolean): void {
    directPeerChildStore.record({
      childSessionId: child,
      spawnerSessionId: coord,
      costClass: "counted",
      source: agent
        ? { kind: "agent", agentName: "test-reviewer" }
        : { kind: "profile", profileId: "pr_terra" },
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      thinkingLevel: "medium",
      credentialProfileId: "codex-acct",
      createdAt: Date.now(),
    });
  }

  const refuse = (row: PeerPromptRecord, category: HeldStartCategory) =>
    peerPromptStore.refuseHeld(row.id, HELD_START_REASONS[category], (r) => {
      recordHeldStartNotice(r, category);
    });

  it("words every category as a start that never happened, naming the runtime or definition", async () => {
    updateSettings({
      peerSpawnRuntimes: [
        {
          id: "pr_terra",
          name: "Terra implementer",
          relativeCost: "high",
          credentialProfileId: "codex-acct",
          provider: "openai-codex",
          modelId: "gpt-5.6-terra",
          thinkingLevel: "medium",
          enabled: false,
        },
      ],
    });
    try {
      for (const category of categories) {
        const { id: coord } = coordinator();
        const child = seed("Waiting child");
        sessionStore.linkSpawned(coord, child);
        registered(coord, child, category.startsWith("held_agent"));
        const row = heldRow(coord, child);
        assert.equal(refuse(row, category)?.status, "failed", category);
        assert.equal(
          peerPromptStore.getById(row.id)?.failureReason,
          HELD_START_REASONS[category],
        );
        wakeForNotice([coord]);
        await until(() => noticesIn(coord).length === 1, category);
        const text = noticesIn(coord)[0]!;
        assert.match(text, /waiting for a slot/, category);
        assert.match(text, /was NOT started/, category);
        assert.match(text, new RegExp(child), category);
        assert.match(
          text,
          category.startsWith("held_agent")
            ? /"test-reviewer"/
            : /"Terra implementer"/,
          category,
        );
        for (const wrong of [
          /could not be delivered/,
          /repeated attempts/,
          /Its turn/,
        ])
          assert.doesNotMatch(text, wrong, category);
      }
      // A removed roster row is named by its id.
      updateSettings({ peerSpawnRuntimes: [] });
      const { id: coord } = coordinator();
      const child = seed("Orphaned child");
      sessionStore.linkSpawned(coord, child);
      registered(coord, child, false);
      refuse(heldRow(coord, child), "held_runtime_removed");
      wakeForNotice([coord]);
      await until(() => noticesIn(coord).length === 1, "removed row");
      assert.match(noticesIn(coord)[0]!, /"pr_terra"/);
    } finally {
      updateSettings({ peerSpawnRuntimes: [] });
    }
  });

  it("reaches the spawner of a user-owned child wanting no reply, after a takeover and settlement", async () => {
    const { id: coord } = coordinator();
    const child = seed("Handed over");
    sessionStore.linkSpawned(coord, child, Date.now(), "taken-over");
    registered(coord, child, false);
    holdAutomaticTurns(coord);
    refuse(heldRow(coord, child, false), "held_runtime_disabled");
    assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
    sessionStore.setSettled(coord, true);
    sessionStore.setSettled(child, true);
    automaticTurnHoldStore.release(coord);
    wakeForNotice([coord]);
    await until(() => noticesIn(coord).length === 1, "the refused start");
    assert.match(noticesIn(coord)[0]!, /was NOT started/);
  });

  it("is dropped once either side is archived, and an unknown category is never rendered", async () => {
    for (const end of ["coordinator", "child"] as const) {
      const { id: coord } = coordinator();
      const child = seed("Archived later");
      sessionStore.linkSpawned(coord, child);
      registered(coord, child, false);
      holdAutomaticTurns(coord);
      refuse(heldRow(coord, child), "held_agent_changed");
      sessionStore.setArchived(end === "coordinator" ? coord : child, true);
      assert.equal(deliverableNotices(coord).length, 0, end);
      // Retired, not postponed: a restore brings nothing back.
      sessionStore.setArchived(end === "coordinator" ? coord : child, false);
      assert.equal(deliverableNotices(coord).length, 0, end);
      automaticTurnHoldStore.release(coord);
    }
    const { id: coord } = coordinator();
    const child = seed("Future category");
    sessionStore.linkSpawned(coord, child);
    delegationFailureNoticeStore.record([
      {
        incidentKey: `held-start:future-${n++}`,
        childSessionId: child,
        coordinatorSessionId: coord,
        route: "spawn",
        category: "held_from_a_newer_build" as never,
        requestIds: [],
        failedAt: Date.now(),
      },
    ]);
    assert.equal(deliverableNotices(coord).length, 0);
    await quiesce();
    assert.equal(noticesIn(coord).length, 0);
  });

  it("commits the refusal and its notice together or not at all", async () => {
    const { id: coord } = coordinator();
    const child = seed("Refused twice");
    sessionStore.linkSpawned(coord, child);
    registered(coord, child, false);
    holdAutomaticTurns(coord);
    const row = heldRow(coord, child);
    const record = delegationFailureNoticeStore.record;
    delegationFailureNoticeStore.record = () => {
      throw new Error("SQLITE_FULL");
    };
    try {
      assert.throws(() => refuse(row, "held_runtime_changed"), /SQLITE_FULL/);
    } finally {
      delegationFailureNoticeStore.record = record;
    }
    assert.equal(peerPromptStore.getById(row.id)?.status, "held");
    assert.equal(recordedFor(coord), 0);
    assert.equal(refuse(row, "held_runtime_changed")?.status, "failed");
    assert.equal(refuse(row, "held_runtime_changed"), undefined);
    assert.equal(recordedFor(coord), 1);
    automaticTurnHoldStore.release(coord);
  });
});

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

const HOSTILE = ["sk-ant", "LEAKED", "MOCK-LEAK", "mock.invalid", "Bearer"];

/** An error whose message AND name carry what must never be logged. */
function hostileError(): Error {
  const err = new Error("Authorization: Bearer sk-ant-api03-LEAKED body");
  err.name = "Bearer MOCK-LEAK https://mock.invalid/?token=MOCK";
  return err;
}

function assertNothingHostileIn(calls: unknown[][]): void {
  const logged = calls.flat().map(String).join(" ");
  for (const secret of HOSTILE)
    assert.equal(logged.includes(secret), false, `logged: ${secret}`);
}

describe("nothing the provider said reaches a log line", () => {
  it.each(["public re-offer", "new notice", "boot"] as const)(
    "probes failed-retirement exits: %s",
    async (exit) => {
      const { id: coord } = coordinator();
      const child = piChild(coord);
      const retire = vi
        .spyOn(delegationFailureNoticeStore, "markDelivered")
        .mockImplementation(() => {
          throw new Error("retirement refused");
        });
      try {
        child.steps.push({ kind: "error", message: QUOTA });
        await turn(child, "fails");
        await until(() => noticesIn(coord).length === 1, "initial notice");
        await quiesce();
        assert.equal(
          noticesIn(coord).length,
          1,
          "the old lane absorbs its own edge",
        );
        await sendPeerPrompt({
          senderSessionId: piChild(undefined).sessionId,
          targetSessionId: coord,
          prompt: "unrelated incoming work",
          responseRequested: false,
        });
        await drainRecipient(coord);
        assert.equal(
          noticesIn(coord).length,
          2,
          "base retries failed retirement on a later unrelated public drain",
        );
        retire.mockRestore();
        if (exit === "public re-offer") await drainRecipient(coord);
        if (exit === "new notice") {
          const next = piChild(coord);
          next.steps.push({ kind: "error", message: QUOTA });
          await turn(next, "new failure");
        }
        if (exit === "boot") drainAllQueuedOnBoot();
        await until(() => noticesIn(coord).length === 3, "reoffer notice");
        assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
      } finally {
        retire.mockRestore();
      }
    },
  );

  it.each(["unrelated wake", "incoming traffic", "coalesced wake"] as const)(
    "failed retirement reoffers on %s, but not its own idle edge",
    async (cause) => {
      const { id: coord, driver } = coordinator();
      const child = piChild(coord);
      const retire = vi
        .spyOn(delegationFailureNoticeStore, "markDelivered")
        .mockImplementation(() => {
          throw new Error("retirement refused");
        });
      let edges = 0;
      setSessionIdleHook((id, runId) => {
        if (id !== coord) return;
        edges++;
        void delivery.wake(id, runId);
        if (cause === "coalesced wake" && edges === 1) void delivery.wake(id);
      });
      try {
        child.steps.push({ kind: "error", message: QUOTA });
        await turn(child, "fails");
        await quiesce();
        if (cause !== "coalesced wake") {
          assert.equal(
            driver.promptOptions.length,
            1,
            "only the notice's own edge is absorbed",
          );
          if (cause === "unrelated wake") await delivery.wake(coord);
          else {
            setPeerPromptAutoDeliverForTests(true);
            await sendPeerPrompt({
              senderSessionId: piChild(undefined).sessionId,
              targetSessionId: coord,
              prompt: "unrelated incoming work",
              responseRequested: false,
            });
          }
        }
        await until(
          () => noticesIn(coord).length === 2,
          "unrelated offer repeats exposed debt",
        );
        await quiesce();
        assert.equal(
          noticesIn(coord).length,
          2,
          "each notice absorbs only its own edge",
        );
        assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
      } finally {
        retire.mockRestore();
      }
    },
  );

  it("logs fixed words when retiring a delivered notice fails with a hostile error", async () => {
    const { id: coord, driver } = coordinator();
    const child = piChild(coord);
    // One self edge exposes a repeat without leaving a runaway fixture on failure.
    setSessionIdleHook((id, runId) => {
      if (id !== coord) return;
      setSessionIdleHook(undefined);
      void delivery.wake(id, runId);
    });
    const spies = (["log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const retire = vi
      .spyOn(delegationFailureNoticeStore, "markDelivered")
      .mockImplementation(() => {
        throw hostileError();
      });
    try {
      child.steps.push({ kind: "error", message: QUOTA });
      await turn(child, "fails");
      await until(() => driver.promptOptions.length === 1, "initial notice");
      await quiesce();
      assert.equal(
        driver.promptOptions.length,
        1,
        "a failed retirement cannot replay on its own idle edge",
      );
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 1);
      await drainRecipient(coord);
      assert.equal(
        driver.promptOptions.length,
        2,
        "an intentional public re-offer still attempts",
      );
      retire.mockRestore();
      await drainRecipient(coord);
      assert.equal(
        driver.promptOptions.length,
        3,
        "successful retirement clears the debt",
      );
      assert.equal(delegationFailureNoticeStore.pendingFor(coord).length, 0);
      const calls = spies.flatMap((s) => s.mock.calls);
      assert.match(
        calls.flat().map(String).join(" "),
        /could not retire failure notices/,
      );
      assertNothingHostileIn(calls);
    } finally {
      retire.mockRestore();
      for (const s of spies) s.mockRestore();
    }
  });

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
      assert.match(logged, /was not delivered \(provider or harness failure\)/);
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

/* ------------------------- the journal, causally ---------------------------- */

describe("a journaled failure replays only what it was owed when it happened", () => {
  const journalFile = () => join(DATA_DIR, "delegation-failure-journal.jsonl");

  /** Start from an empty journal, as a fresh data directory would. */
  function freshJournal(): void {
    rmSync(journalFile(), { recursive: true, force: true });
    journal.reloadJournal();
  }

  /** A request from `sender` the child took in at `t` — work after the failure. */
  function laterRequest(sender: string, child: string, t: number) {
    const chainId = peerPromptStore.createChain();
    const m = peerPromptStore.enqueue(
      {
        conversationId: `later-${n++}`,
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: sender,
        recipientSessionId: child,
        prompt: "unrelated new work",
        responseRequested: true,
      },
      t,
    );
    peerPromptStore.claimNext(child, "d", 60_000, t);
    peerPromptStore.markAdmitted(m.id, t);
    peerPromptStore.markAcknowledged(m.id, t);
    return m;
  }

  function refusingDatabase(): () => void {
    const refuse = vi
      .spyOn(delegationFailureNoticeStore, "record")
      .mockImplementation(() => {
        throw new Error("SQLITE_BUSY");
      });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    return () => {
      refuse.mockRestore();
      quiet.mockRestore();
    };
  }

  function failureOf(child: string, runId: string, at: number) {
    return {
      sessionId: child,
      runId,
      origin: BACKGROUND,
      errorMessage: "401 Unauthorized",
      failure: { kind: "auth" as const },
      at,
    };
  }

  it("a refused failure replayed after later work reaches only its original coordinator — in the sweep and after a restart", async () => {
    for (const via of ["sweep", "restart"] as const) {
      freshJournal();
      const { id: parent } = coordinator(`Parent (${via})`);
      const { id: later } = coordinator(`Later sender (${via})`);
      const child = piChild(parent, `Child (${via})`);
      const t = Date.now();
      const restore = refusingDatabase();
      try {
        recordRunFailureNotices(failureOf(child.sessionId, `old-${via}`, t));
      } finally {
        restore();
      }
      const future = laterRequest(later, child.sessionId, t + 1_000);
      if (via === "sweep") sweepPeerPromptRetries(t + 2_000);
      else {
        closeDb();
        getDb();
        assert.equal(recoverJournaledFailuresOnBoot(), 1);
      }
      assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 1);
      assert.equal(delegationFailureNoticeStore.pendingFor(later).length, 0);
      const row = peerPromptStore.getById(future.id)!;
      assert.equal(row.status, "acknowledged", "the later work is untouched");
      assert.equal(row.senderNotifiedAt, undefined);
    }
  });

  it("a recorded failure whose retirement was lost grows no new route on replay", async () => {
    for (const planned of [true, false]) {
      freshJournal();
      const { id: parent } = coordinator("Parent");
      const { id: later } = coordinator("Later sender");
      const child = piChild(parent);
      const t = Date.now();
      const runId = `recorded-${planned}`;
      const incidentKey = `run:${child.sessionId}:${runId}`;
      {
        // The exact durable cut: journaled (with its plan, or with none),
        // recorded in SQLite, and its `done` line never written.
        journal.journalFailure({
          incidentKey,
          sessionId: child.sessionId,
          runId,
          category: "auth",
          at: t,
          noticeTurn: false,
          ...(planned
            ? {
                plan: {
                  routes: [
                    { coordinatorId: parent, route: "spawn", requestIds: [] },
                  ],
                  inTurnIds: [],
                },
              }
            : {}),
        });
        delegationFailureNoticeStore.record([
          {
            incidentKey,
            childSessionId: child.sessionId,
            coordinatorSessionId: parent,
            route: "spawn",
            category: "auth",
            requestIds: [],
            failedAt: t,
          },
        ]);
      }
      assert.equal(journal.pendingJournaledFailures().length, 1);
      const future = laterRequest(later, child.sessionId, t + 1_000);
      assert.deepEqual(replayJournaledFailures(t + 2_000), []);
      closeDb();
      getDb();
      assert.equal(recoverJournaledFailuresOnBoot(), 0);
      assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 1);
      assert.equal(delegationFailureNoticeStore.pendingFor(later).length, 0);
      assert.equal(peerPromptStore.getById(future.id)!.status, "acknowledged");
      assert.deepEqual(journal.pendingJournaledFailures(), [], "retired now");
    }
  });

  it("a recorded incident never gains a route its record skipped", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const { id: asker } = coordinator("Asker");
    const child = piChild(parent);
    awaitingRow(asker, child.sessionId);
    const t = Date.now() + 5;
    const restore = refusingDatabase();
    try {
      recordRunFailureNotices(failureOf(child.sessionId, "skipped-route", t));
    } finally {
      restore();
    }
    const written = readFileSync(journalFile(), "utf8");
    assert.ok(written.includes(asker), "the plan names both coordinators");
    // Replayed while the asker was archived: only the parent is recorded.
    sessionStore.setArchived(asker, true);
    assert.deepEqual(
      replayJournaledFailures().map((w) => w.coordinatorSessionId),
      [parent],
    );
    // Its retirement was lost, and the asker is restored since.
    writeFileSync(journalFile(), written);
    journal.reloadJournal();
    sessionStore.setArchived(asker, false);
    assert.deepEqual(replayJournaledFailures(), []);
    assert.equal(delegationFailureNoticeStore.pendingFor(asker).length, 0);
  });

  it("a plan-less failure routes only along the spawn edge, never to current rows", () => {
    for (const skew of [0, -60_000]) {
      freshJournal();
      const { id: parent } = coordinator("Parent");
      const { id: later } = coordinator("Later sender");
      const child = piChild(parent);
      const t = Date.now();
      // The routing cannot be read at the failure.
      const refuse = vi
        .spyOn(peerPromptStore, "openForRecipient")
        .mockImplementation(() => {
          throw new Error("SQLITE_BUSY");
        });
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        recordRunFailureNotices(
          failureOf(child.sessionId, `planless-${skew}`, t),
        );
      } finally {
        refuse.mockRestore();
        quiet.mockRestore();
      }
      // New healthy work in the same millisecond, or under a clock rollback.
      const future = laterRequest(later, child.sessionId, t + skew);
      assert.deepEqual(replayJournaledFailures(t + 2_000), []);
      // The failure was recorded at once along the spawn edge alone.
      assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 1);
      assert.equal(delegationFailureNoticeStore.pendingFor(later).length, 0);
      const row = peerPromptStore.getById(future.id)!;
      assert.equal(row.status, "acknowledged");
      assert.equal(row.senderNotifiedAt, undefined);
    }
  });

  it("a failure no store would take is retried by the runtime exactly as it was seen", async () => {
    for (const readsAtFailure of ["refused", "read"] as const)
      for (const skew of [0, -60_000]) {
        freshJournal();
        const { id: parent } = coordinator("Parent");
        const { id: asker } = coordinator("Asker at the failure");
        const { id: later } = coordinator("Later sender");
        const child = piChild(parent);
        await turn(child, "start");
        awaitingRow(asker, child.sessionId);
        // Journal, database writes and (in one case) reads all refuse.
        rmSync(journalFile(), { force: true });
        mkdirSync(journalFile());
        const spies = [
          vi
            .spyOn(delegationFailureNoticeStore, "record")
            .mockImplementation(() => {
              throw new Error("SQLITE_FULL");
            }),
          ...(readsAtFailure === "refused"
            ? [
                vi
                  .spyOn(peerPromptStore, "openForRecipient")
                  .mockImplementation(() => {
                    throw new Error("SQLITE_BUSY");
                  }),
              ]
            : []),
          vi.spyOn(console, "error").mockImplementation(() => {}),
        ];
        child.steps.push({ kind: "error", message: QUOTA });
        const at = Date.now();
        try {
          await turn(child, "fails");
        } finally {
          for (const spy of spies) spy.mockRestore();
          rmSync(journalFile(), { recursive: true, force: true });
          journal.reloadJournal();
        }
        assert.equal(recordedFor(parent), 0);
        // The stores work again; new healthy work arrives before any retry —
        // in the same millisecond, or under a clock rollback.
        const future = laterRequest(later, child.sessionId, at + skew);
        // The child's next turn retries the old report.
        await turn(child, "next");
        const case_ = `${readsAtFailure} reads, skew ${skew}`;
        assert.equal(recordedFor(parent), 1, case_);
        assert.equal(
          recordedFor(asker),
          readsAtFailure === "read" ? 1 : 0,
          `${case_}: the asker only if the failure's own plan named it`,
        );
        assert.equal(recordedFor(later), 0, case_);
        const row = peerPromptStore.getById(future.id)!;
        assert.equal(row.status, "acknowledged", case_);
        assert.equal(row.senderNotifiedAt, undefined, case_);
        // A real failure of the child later is its own incident, and its
        // plan sees the later sender's open request.
        child.steps.push({ kind: "error", message: QUOTA });
        await turn(child, "fails again");
        assert.equal(
          recordedFor(later),
          1,
          `${case_}: the later sender is told of the later failure`,
        );
      }
  });

  it("a plan known to owe nobody stays empty across reload and compaction", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent, archived at the failure");
    const child = piChild(parent);
    // The cut: journaled with the plan read at the failure — nobody owed,
    // since the parent was archived then — and never retired.
    journal.journalFailure({
      incidentKey: `run:${child.sessionId}:owed-nobody`,
      sessionId: child.sessionId,
      runId: "owed-nobody",
      category: "auth",
      at: Date.now(),
      noticeTurn: false,
      plan: { routes: [], inTurnIds: [] },
    });
    assert.match(readFileSync(journalFile(), "utf8"), /"planParts":0/);
    journal.reloadJournal();
    assert.deepEqual(journal.pendingJournaledFailures()[0]!.plan, {
      routes: [],
      inTurnIds: [],
    });
    journal.compactJournal();
    journal.reloadJournal();
    assert.deepEqual(journal.pendingJournaledFailures()[0]!.plan, {
      routes: [],
      inTurnIds: [],
    });
    // The parent is live now; the failure still owed nobody when it happened.
    assert.deepEqual(replayJournaledFailures(), []);
    assert.equal(recordedFor(parent), 0);
    assert.deepEqual(journal.pendingJournaledFailures(), [], "retired");
  });

  it("a plan-less failure still recovers its original spawn route after a restart", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const { id: later } = coordinator("Later sender");
    const child = piChild(parent);
    const t = Date.now();
    journal.journalFailure({
      incidentKey: `run:${child.sessionId}:planless-boot`,
      sessionId: child.sessionId,
      runId: "planless-boot",
      category: "auth",
      at: t,
      noticeTurn: false,
    });
    const future = laterRequest(later, child.sessionId, t);
    closeDb();
    getDb();
    assert.equal(recoverJournaledFailuresOnBoot(), 1);
    assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 1);
    assert.equal(delegationFailureNoticeStore.pendingFor(later).length, 0);
    assert.equal(peerPromptStore.getById(future.id)!.status, "acknowledged");
  });

  it("every owed coordinator and every unanswered request is kept, however many", () => {
    freshJournal();
    const child = piChild(undefined, "Asked by many");
    const askers: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { id } = coordinator(`Asker ${i}`);
      askers.push(id);
      awaitingRow(id, child.sessionId);
    }
    const { id: patient } = coordinator("Asked six times");
    const six: string[] = [];
    for (let i = 0; i < 6; i++) {
      const before = new Set(
        peerPromptStore.openForRecipient(child.sessionId).map((m) => m.id),
      );
      awaitingRow(patient, child.sessionId);
      six.push(
        peerPromptStore
          .openForRecipient(child.sessionId)
          .find((m) => !before.has(m.id))!.id,
      );
    }
    const rows = recordRunFailureNotices(
      failureOf(child.sessionId, "many-owed", Date.now() + 5),
    );
    assert.equal(rows.length, 41, "every asker is told");
    for (const id of askers)
      assert.equal(delegationFailureNoticeStore.pendingFor(id).length, 1);
    const notice = delegationFailureNoticeStore.pendingFor(patient)[0]!;
    assert.deepEqual([...notice.requestIds].sort(), [...six].sort());
    // The newest five are answered; the oldest is still owed.
    for (const id of six.slice(1))
      peerPromptStore.markReplied(id, `reply-${n++}`);
    const deliverable = deliverableNotices(patient);
    assert.equal(deliverable.length, 1, "one request still waits");
    assert.match(
      delegationFailureNoticeLines(deliverable).join("\n"),
      /and 1 earlier/,
    );
  });

  it("a request the child settled ends its notice like an answer", () => {
    freshJournal();
    const child = piChild(undefined, "Settles instead");
    const { id: asker } = coordinator("Asker");
    awaitingRow(asker, child.sessionId);
    const [request] = peerPromptStore.openForRecipient(child.sessionId);
    recordRunFailureNotices(
      failureOf(child.sessionId, "settled-request", Date.now() + 5),
    );
    assert.equal(delegationFailureNoticeStore.pendingFor(asker).length, 1);
    peerPromptStore.markSettled(child.sessionId, [request!.id], "applied it");
    assert.equal(deliverableNotices(asker).length, 0);
    assert.equal(delegationFailureNoticeStore.pendingFor(asker).length, 0);
  });

  it("a plan of any size is journaled whole in parts, and one missing a part is no plan at all", () => {
    freshJournal();
    const child = piChild(undefined, "Asked very often");
    const { id: asker } = coordinator("Asker");
    for (let i = 0; i < 3_000; i++) awaitingRow(asker, child.sessionId);
    const restore = refusingDatabase();
    try {
      recordRunFailureNotices(
        failureOf(child.sessionId, "huge-plan", Date.now() + 5),
      );
    } finally {
      restore();
    }
    const lines = readFileSync(journalFile(), "utf8")
      .split("\n")
      .filter(Boolean);
    const parts = lines.filter((l) => l.includes('"kind":"plan"'));
    assert.ok(parts.length > 1, `split into ${parts.length} parts`);
    for (const line of lines)
      assert.ok(Buffer.byteLength(line) <= journal.MAX_RECORD_BYTES);
    journal.reloadJournal();
    const [entry] = journal.pendingJournaledFailures();
    assert.equal(entry!.plan!.routes[0]!.requestIds.length, 3_000);
    // A part lost to a crash: the failure stays, its plan does not.
    writeFileSync(
      journalFile(),
      lines.filter((l) => l !== parts[1]).join("\n") + "\n",
    );
    journal.reloadJournal();
    assert.equal(journal.pendingJournaledFailures()[0]!.plan, undefined);
    // Back to the whole file: replay records all 3,000.
    writeFileSync(journalFile(), lines.join("\n") + "\n");
    journal.reloadJournal();
    const [notice] = replayJournaledFailures();
    assert.equal(notice!.requestIds.length, 3_000);
  }, 60_000);

  it("a failure the database keeps refusing goes to the back, so the others still get their turn", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const children = Array.from({ length: 51 }, (_, i) =>
      piChild(parent, `Child ${i}`),
    );
    const t = Date.now();
    for (const [i, child] of children.entries())
      journal.journalFailure({
        incidentKey: `run:${child.sessionId}:fair-${i}`,
        sessionId: child.sessionId,
        runId: `fair-${i}`,
        category: "auth",
        at: t,
        noticeTurn: false,
      });
    const real = delegationFailureNoticeStore.record;
    let attempts = 0;
    const refuse = vi
      .spyOn(delegationFailureNoticeStore, "record")
      .mockImplementation((inputs, ...rest) => {
        attempts += 1;
        if (!inputs[0]!.incidentKey.endsWith("fair-50"))
          throw new Error("refused for this one");
        return real(inputs, ...rest);
      });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      replayJournaledFailures();
      assert.equal(attempts, 50, "one bounded batch");
      replayJournaledFailures();
      assert.equal(attempts, 100);
      assert.deepEqual(
        delegationFailureNoticeStore
          .pendingFor(parent)
          .map((n) => n.incidentKey),
        [`run:${children[50]!.sessionId}:fair-50`],
        "the last one got its turn",
      );
      assert.equal(journal.pendingJournaledFailures().length, 50);
    } finally {
      refuse.mockRestore();
      quiet.mockRestore();
    }
  });

  it("a retirement that cannot be written leaves the failure pending, to be retired by the next replay", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const child = piChild(parent);
    const incidentKey = `run:${child.sessionId}:unretired`;
    journal.journalFailure({
      incidentKey,
      sessionId: child.sessionId,
      runId: "unretired",
      category: "auth",
      at: Date.now(),
      noticeTurn: false,
    });
    const saved = readFileSync(journalFile(), "utf8");
    // The retirement line cannot be written (a directory stands there).
    rmSync(journalFile());
    mkdirSync(journalFile());
    journal.journalDone(incidentKey);
    assert.deepEqual(
      journal.pendingJournaledFailures().map((f) => f.incidentKey),
      [incidentKey],
      "still pending: nothing retired it",
    );
    rmSync(journalFile(), { recursive: true });
    writeFileSync(journalFile(), saved);
    // The next replay records it once and retires it for good.
    assert.equal(replayJournaledFailures().length, 1);
    assert.deepEqual(journal.pendingJournaledFailures(), []);
    journal.reloadJournal();
    assert.deepEqual(journal.pendingJournaledFailures(), []);
  });

  it("a recorded incident is never pruned while the journal still holds it", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const { id: asker } = coordinator("Asker");
    const child = piChild(parent);
    const t = Date.now();
    const incidentKey = `run:${child.sessionId}:kept`;
    // The exact durable cut: journaled with both routes, recorded in SQLite,
    // and its `done` line never written.
    journal.journalFailure({
      incidentKey,
      sessionId: child.sessionId,
      runId: "kept",
      category: "auth",
      at: t,
      noticeTurn: false,
      plan: {
        routes: [
          { coordinatorId: parent, route: "spawn", requestIds: [] },
          { coordinatorId: asker, route: "request", requestIds: [] },
        ],
        inTurnIds: [],
      },
    });
    const notices = delegationFailureNoticeStore.record(
      [parent, asker].map((coordinatorSessionId, i) => ({
        incidentKey,
        childSessionId: child.sessionId,
        coordinatorSessionId,
        route: i === 0 ? ("spawn" as const) : ("request" as const),
        category: "auth" as const,
        requestIds: [],
        failedAt: t,
      })),
    );
    assert.equal(notices.length, 2, "two original routes");
    delegationFailureNoticeStore.markDelivered(notices.map((n) => n.id));
    // Retention, long after: the journal still holds the incident.
    const later = Date.now() + 100 * 24 * 60 * 60_000;
    runPeerPromptRetention(later);
    assert.equal(
      delegationFailureNoticeStore.hasIncident(notices[0]!.incidentKey),
      true,
    );
    // A fresh boot, and the sweep: nothing is announced again; it retires.
    closeDb();
    getDb();
    assert.equal(recoverJournaledFailuresOnBoot(), 0);
    assert.deepEqual(replayJournaledFailures(), []);
    assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 0);
    assert.deepEqual(journal.pendingJournaledFailures(), []);
    // Retired, its rows may go now.
    runPeerPromptRetention(later);
    assert.equal(
      delegationFailureNoticeStore.hasIncident(notices[0]!.incidentKey),
      false,
    );
  });

  it("the record bound is in bytes, checked before any line is parsed, and the writer keeps to it", () => {
    freshJournal();
    const max = journal.MAX_RECORD_BYTES;
    const record = (runId: string, pad: string) =>
      JSON.stringify({
        kind: "failed",
        incidentKey: `run:bound:${runId}`,
        sessionId: "bound",
        runId,
        category: "auth",
        at: 1,
        noticeTurn: false,
        pad,
      });
    const sized = (runId: string, bytes: number, unit = "x") => {
      let pad = "";
      while (
        Buffer.byteLength(record(runId, pad)) + Buffer.byteLength(unit) <=
        bytes
      )
        pad += unit;
      return record(runId, pad);
    };
    const exact = sized("exact", max);
    const over = sized("over", max + 4).slice(0, -2) + 'x"}';
    // Multi-byte characters placed across the 64 KiB read boundary.
    const unicode = sized("unicode", max, "é");
    const parseable80k = record("eighty", "y".repeat(80 * 1024));
    assert.equal(Buffer.byteLength(exact), max);
    assert.ok(Buffer.byteLength(over) > max);
    writeFileSync(
      journalFile(),
      [exact, over, parseable80k, unicode, '{"kind":"failed","torn'].join("\n"),
    );
    journal.reloadJournal();
    assert.deepEqual(
      journal
        .pendingJournaledFailures()
        .map((f) => f.runId)
        .sort(),
      ["exact", "unicode"],
    );
    // The writer refuses a record over the bound rather than truncating it.
    assert.throws(
      () =>
        journal.journalFailure({
          incidentKey: "run:bound:huge",
          sessionId: "bound",
          runId: "z".repeat(max),
          category: "auth",
          at: 1,
          noticeTurn: false,
        }),
      /exceeds its bound/,
    );
  });

  it("a torn tail cannot swallow the next record, a torn retirement only replays once, and compaction keeps every pending fact", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const child = piChild(parent);
    // What a process that died mid-append leaves behind.
    writeFileSync(journalFile(), '{"kind":"failed","incidentKey":"torn');
    const restore = refusingDatabase();
    try {
      recordRunFailureNotices(
        failureOf(child.sessionId, "after-torn", Date.now()),
      );
      // Another torn record, then a second real one.
      appendFileSync(journalFile(), '{"kind":"done","incidentKey":"run:');
      recordRunFailureNotices(
        failureOf(child.sessionId, "after-torn-2", Date.now()),
      );
      // A boot while the database still refuses compacts, but keeps both.
      assert.equal(recoverJournaledFailuresOnBoot(), 0);
    } finally {
      restore();
    }
    journal.reloadJournal();
    assert.deepEqual(
      journal
        .pendingJournaledFailures()
        .map((f) => f.runId)
        .sort(),
      ["after-torn", "after-torn-2"],
    );
    // A retirement torn mid-write leaves its failure pending; replay sees the
    // incident recorded and only retires it.
    assert.equal(
      recoverJournaledFailuresOnBoot(),
      2,
      "one notice per incident",
    );
    const incident = `run:${child.sessionId}:after-torn`;
    journal.journalFailure({
      incidentKey: incident,
      sessionId: child.sessionId,
      runId: "after-torn",
      category: "auth",
      at: Date.now(),
      noticeTurn: false,
    });
    appendFileSync(journalFile(), `{"kind":"done","incidentKey":"${incident}`);
    journal.reloadJournal();
    assert.equal(journal.pendingJournaledFailures().length, 1);
    assert.equal(recoverJournaledFailuresOnBoot(), 0);
    journal.reloadJournal();
    assert.deepEqual(journal.pendingJournaledFailures(), []);
    assert.equal(delegationFailureNoticeStore.pendingFor(parent).length, 2);
  });

  it("an unreadable journal holds up nothing else, is never overwritten, and is recovered once it reads again", () => {
    freshJournal();
    const { id: parent } = coordinator("Parent");
    const child = piChild(parent);
    const { id: sender } = coordinator("Retrying sender");
    // An ordinary peer prompt waiting out its retry backoff.
    const t = Date.now();
    const chainId = peerPromptStore.createChain();
    const retrying = peerPromptStore.enqueue(
      {
        conversationId: `retry-${n++}`,
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: sender,
        recipientSessionId: child.sessionId,
        prompt: "ordinary work",
        responseRequested: false,
      },
      t,
    );
    peerPromptStore.claimNext(child.sessionId, "d", 60_000, t);
    peerPromptStore.markRetryable(retrying.id, "busy", 0, t);
    // The journal path cannot be read (a directory stands there).
    rmSync(journalFile(), { force: true });
    mkdirSync(journalFile());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      assert.equal(recoverJournaledFailuresOnBoot(), 0);
      sweepPeerPromptRetries(t + 1_000);
      assert.notEqual(
        peerPromptStore.getById(retrying.id)!.status,
        "retryable_failed",
        "the queue's own retry went ahead",
      );
      assert.match(
        errors.mock.calls.flat().map(String).join(" "),
        /failure journal could not be read/,
      );
      assert.ok(statSync(journalFile()).isDirectory(), "left as it was");
    } finally {
      errors.mockRestore();
    }
    // It reads again, holding a failure that was pending all along.
    rmSync(journalFile(), { recursive: true });
    writeFileSync(
      journalFile(),
      `\n${JSON.stringify({
        kind: "failed",
        incidentKey: `run:${child.sessionId}:waited`,
        sessionId: child.sessionId,
        runId: "waited",
        category: "auth",
        at: t,
        noticeTurn: false,
      })}\n`,
    );
    assert.equal(recoverJournaledFailuresOnBoot(), 1);
    assert.equal(recoverJournaledFailuresOnBoot(), 0);
  });

  it("a large backlog is read in bounded chunks, replayed a bounded batch per sweep, and never holds up the queue", async () => {
    freshJournal();
    const { id: sender } = coordinator("Retrying sender");
    const child = piChild(sender);
    const BACKLOG = 10_000;
    const lines: string[] = [];
    for (let i = 0; i < BACKLOG; i++)
      lines.push(
        JSON.stringify({
          kind: "failed",
          incidentKey: `run:gone-${i}:r`,
          sessionId: `gone-${i}`,
          runId: "r",
          category: "auth",
          at: 1,
          noticeTurn: false,
        }),
      );
    // An overlong line and a torn tail in the middle must not cost the rest.
    lines.splice(5_000, 0, "x".repeat(1_000_000));
    writeFileSync(journalFile(), `${lines.join("\n")}\n{"kind":"fail`);
    appendFileSync(
      journalFile(),
      `\n${JSON.stringify({
        kind: "failed",
        incidentKey: "run:gone-last:r",
        sessionId: "gone-last",
        runId: "r",
        category: "auth",
        at: 1,
        noticeTurn: false,
      })}\n`,
    );
    const { cpuMs: loadMs } = measureCpuMs(() => journal.reloadJournal());
    assert.equal(
      journal.pendingJournaledFailures().length,
      BACKLOG + 1,
      "nothing valid is dropped",
    );
    // A sweep replays one bounded batch, and the queue's own retry still runs.
    const t = Date.now();
    const chainId = peerPromptStore.createChain();
    const retrying = peerPromptStore.enqueue(
      {
        conversationId: `backlog-${n++}`,
        chainId,
        hop: peerPromptStore.reserveHop(chainId),
        senderSessionId: sender,
        recipientSessionId: child.sessionId,
        prompt: "ordinary work",
        responseRequested: false,
      },
      t,
    );
    peerPromptStore.claimNext(child.sessionId, "d", 60_000, t);
    peerPromptStore.markRetryable(retrying.id, "busy", 0, t);
    const { cpuMs: sweepMs } = measureCpuMs(() =>
      sweepPeerPromptRetries(t + 1_000),
    );
    assert.notEqual(
      peerPromptStore.getById(retrying.id)!.status,
      "retryable_failed",
    );
    assert.equal(journal.pendingJournaledFailures().length, BACKLOG + 1 - 50);
    // Boot records a bounded share, never the whole backlog at once.
    const { cpuMs: bootMs } = measureCpuMs(() =>
      recoverJournaledFailuresOnBoot(),
    );
    const afterBoot = journal.pendingJournaledFailures().length;
    assert.equal(afterBoot, BACKLOG + 1 - 50 - 200);
    // The rest drains in yielding batches: other work runs in between.
    let interleaved = 0;
    const tick = setInterval(() => (interleaved += 1), 0);
    const drained = await measureCpuMsAsync(async () => {
      drainJournaledFailureBacklog();
      await until(
        () => journal.pendingJournaledFailures().length === 0,
        "the drained backlog",
        60_000,
      );
    });
    clearInterval(tick);
    assert.ok(interleaved > 10, `other timers ran ${interleaved} times`);
    assert.ok(
      statSync(journalFile()).size < 1_000,
      "compacted to nothing owed",
    );
    console.info(
      `[journal backlog] load ${loadMs.toFixed(0)}ms, sweep ${sweepMs.toFixed(0)}ms, boot ${bootMs.toFixed(0)}ms, drain ${drained.cpuMs.toFixed(0)}ms CPU for ${BACKLOG} entries; ${interleaved} timer turns during the drain`,
    );
    // Generous ceilings: they catch a quadratic regression, not a busy box.
    assert.ok(loadMs < 5_000, `load ${loadMs}ms`);
    assert.ok(sweepMs < 2_000, `sweep ${sweepMs}ms`);
    assert.ok(bootMs < 2_000, `boot ${bootMs}ms`);
  }, 120_000);

  it("a backlog of failures that are really owed writes every notice, without holding boot", async () => {
    freshJournal();
    const { id: parent } = coordinator("Parent of many");
    const COUNT = 1_000;
    const t = Date.now();
    const children: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const child = piChild(parent, `Failed child ${i}`);
      children.push(child.sessionId);
      journal.journalFailure({
        incidentKey: `run:${child.sessionId}:live-${i}`,
        sessionId: child.sessionId,
        runId: `live-${i}`,
        category: "auth",
        at: t,
        noticeTurn: false,
      });
    }
    const boot = measureCpuMs(() => recoverJournaledFailuresOnBoot());
    assert.equal(boot.value, 200, "boot records its bounded share");
    let interleaved = 0;
    const tick = setInterval(() => (interleaved += 1), 0);
    const drained = await measureCpuMsAsync(async () => {
      drainJournaledFailureBacklog();
      await until(
        () => journal.pendingJournaledFailures().length === 0,
        "the drained backlog",
        60_000,
      );
    });
    clearInterval(tick);
    assert.equal(
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM delegation_failure_notices WHERE coordinator_session_id = ?",
          )
          .get(parent) as { n: number }
      ).n,
      COUNT,
      "every one owed is recorded",
    );
    assert.ok(interleaved > 5, `other timers ran ${interleaved} times`);
    console.info(
      `[journal live backlog] boot ${boot.cpuMs.toFixed(0)}ms for 200, drain ${drained.cpuMs.toFixed(0)}ms CPU for ${COUNT - 200} real notices; ${interleaved} timer turns during the drain`,
    );
  }, 120_000);
});
