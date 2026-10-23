/**
 * A delivered background fact is not a handled one. The production chain —
 * delivery queue, outbox store, prompt facade, the live runtime and its
 * `RunOutcome`, settlement and the user's Recover — with only the provider
 * scripted: what reaches the model, which run a fact is bound to, and what
 * retires, interrupts or gives it back.
 *   pnpm --filter @assistant/server test src/backgroundHandling.test.ts
 */
import assert from "node:assert/strict";
import { installDeliveryTestScheduler } from "./test/deliveryScheduler.ts";
import { setDeliveryWake } from "./deliveryWake.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, test } from "vitest";
import type {
  AdapterEvent,
  AgentRunResult,
  PromptableAdapter,
  PromptOptions,
} from "./session/adapters/contract.ts";

// Nothing here may reach the developer's home, Git identity or network.
const sandbox = mkdtempSync(join(tmpdir(), "background-handling-"));
process.env.HOME = join(sandbox, "home");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(sandbox, "gitconfig");
globalThis.fetch = () =>
  Promise.reject(new Error("network access is denied in this suite"));

const { DATA_DIR } = await import("./config.ts");
const { BackgroundCompletionDelivery } =
  await import("./backgroundWork/completionDelivery.ts");
const notices = await import("./backgroundCompletionNotices.ts");
const hold = await import("./automaticTurnHold.ts");
const { backgroundDeliveryOutboxStore } =
  await import("./db/backgroundDeliveryOutboxStore.ts");
const { backgroundWorkStore } = await import("./db/backgroundWorkStore.ts");
const { getDb } = await import("./db/index.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { promptRuntimeSession, setDeferredBackgroundContextProvider } =
  await import("./session/runtimePrompt.ts");
const { subscribeSessionRunEnded } =
  await import("./session/runtime/liveSession.ts");
const { SteerWithdrawnError } = await import("./session/runtime/errors.ts");
const { updateSettings, getSettings } = await import("./settings.ts");

beforeAll(() => {
  assert.ok(
    DATA_DIR.startsWith(tmpdir()),
    `this suite writes only under a temporary data directory, not ${DATA_DIR}`,
  );
  updateSettings({ memory: { ...getSettings().memory, learningMode: "off" } });
});

/** How every run ends reaches the settlement, as `index.ts` wires it. */
subscribeSessionRunEnded((sessionId, outcome) =>
  notices.settleBackgroundHandling(sessionId, outcome),
);

/**
 * A provider whose turns the test ends by hand (`manual`), or at once with a
 * clean end or a failure. Steers answer through `steer`.
 */
function scripted(capabilities: { steerAcceptance?: "deferred" } = {}): {
  adapter: PromptableAdapter;
  texts: string[];
  mode: "end" | "error" | "manual";
  open: Array<(result: AgentRunResult) => void>;
  steer:
    | ((text: string, options: PromptOptions) => Promise<AgentRunResult>)
    | undefined;
  /** Drive the runtime as the provider would on its own (a native turn). */
  emit: (event: AdapterEvent) => void;
} {
  const state = {
    texts: [] as string[],
    mode: "end" as "end" | "error" | "manual",
    open: [] as Array<(result: AgentRunResult) => void>,
    steer: undefined as
      | ((text: string, options: PromptOptions) => Promise<AgentRunResult>)
      | undefined,
    adapter: undefined as unknown as PromptableAdapter,
    emit: (_event: AdapterEvent) => {},
  };
  let listener: ((event: AdapterEvent) => void) | undefined;
  state.emit = (event) => listener?.(event);
  state.adapter = {
    provider: "scripted",
    capabilities: {
      fork: "none",
      compact: false,
      steer: true,
      attachments: false,
      ...capabilities,
    },
    subscribe: (l: (e: AdapterEvent) => void) => {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    getBinding: () => ({ provider: "scripted", nativeId: "native" }),
    prompt: (text: string, options: PromptOptions = {}) => {
      state.texts.push(text);
      if (options.steer && state.steer) return state.steer(text, options);
      if (state.mode === "end") return Promise.resolve({ stopReason: "end" });
      if (state.mode === "error")
        return Promise.resolve({
          stopReason: "error",
          errorMessage: "provider unavailable",
        });
      return new Promise<AgentRunResult>((resolve) => state.open.push(resolve));
    },
    abort: () => {
      for (const resolve of state.open.splice(0))
        resolve({ stopReason: "aborted" });
    },
    setModel: () => {},
    setReasoning: () => {},
    dispose: () => {},
  };
  return state;
}

const drivers = new Map<string, ReturnType<typeof driverOf>>();
let serial = 0;

function driverOf(sessionId: string, adapter: PromptableAdapter) {
  return {
    id: sessionId,
    key: sessionId,
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
    sessionFile: undefined,
    get isRunning() {
      return sessionRuntime.get(sessionId)?.isRunning ?? false;
    },
    canSteer: true,
    /** Set to stand for a harness its store released meanwhile. */
    released: false,
    contextInfo: () => ({}) as never,
    broadcastState: () => {},
    createRuntimeAdapter: () => adapter,
  };
}

/** A fresh owner session, titled so nothing tries to name it. */
function session(capabilities: { steerAcceptance?: "deferred" } = {}) {
  serial += 1;
  const id = `handling-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "assistant",
    title: `handling ${serial}`,
  });
  const provider = scripted(capabilities);
  sessionRuntime.createSession(id, provider.adapter);
  drivers.set(id, driverOf(id, provider.adapter));
  return { id, provider };
}

/** A finished background job owned by `owner`. */
function finished(
  owner: string,
  options: { stopped?: boolean; outcome?: string; mergeJob?: boolean } = {},
) {
  serial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: options.mergeJob ? "server-task" : "host-process",
    kind: options.mergeJob ? "merge-when-ready" : "shell",
    label: `job ${serial}`,
    sourceRequestId: `${owner}:job:${serial}`,
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "test",
    ownerLimit: 1_000,
  });
  if (options.stopped) {
    backgroundWorkStore.markRunning({ itemId: item.id });
    backgroundWorkStore.requestStop({
      itemId: item.id,
      reason: "asked",
      sourceRequestId: `${owner}:stop:${serial}`,
    });
  }
  return backgroundWorkStore.terminalize({
    itemId: item.id,
    state: options.stopped ? "stopped" : "completed",
    ...(options.outcome ? { outcomeSummary: options.outcome } : {}),
  });
}

/** The production delivery chain around the scripted providers. */
function wire(
  outbox: typeof notices.backgroundDeliveryOutbox = notices.backgroundDeliveryOutbox,
) {
  const acquired: string[] = [];
  const driverFor = (id: string) => {
    acquired.push(id);
    return Promise.resolve(drivers.get(id));
  };
  const delivery = new BackgroundCompletionDelivery({
    disposition: notices.completionDisposition,
    outbox,
    offer: notices.offerBackgroundCompletion(driverFor),
  });
  installDeliveryTestScheduler({
    background: delivery,
    live: (id) => drivers.get(id),
    acquire: driverFor,
  });
  setDeferredBackgroundContextProvider((id) =>
    delivery.claimDeferredContext(id),
  );
  return {
    delivery,
    acquired,
    owe: (_owner: string, item: ReturnType<typeof finished>, running = false) =>
      notices.enqueueCompletionNotice(delivery, item, running),
    recover: (
      id: string,
      refs?: Parameters<typeof notices.recoverBackgroundHandling>[3],
    ) => notices.recoverBackgroundHandling(delivery, id, driverFor, refs),
  };
}

afterEach(() => {
  setDeferredBackgroundContextProvider(undefined);
  setDeliveryWake(undefined);
});

type Phase = { itemId: string; phase: string; interruption: string | null };

/** Every outbox row of one session, as the table holds it. */
function rows(sessionId: string): Phase[] {
  return (
    getDb()
      .prepare(
        "SELECT item_id AS itemId, phase, interruption FROM background_delivery_outbox WHERE session_id=? ORDER BY created_at_ms, rowid",
      )
      .all(sessionId) as unknown as Phase[]
  ).map((row) => ({ ...row }));
}

function runIds(sessionId: string): string[] {
  return (
    getDb()
      .prepare(
        "SELECT DISTINCT run_id FROM background_delivery_outbox WHERE session_id=? AND run_id IS NOT NULL",
      )
      .all(sessionId) as { run_id: string }[]
  ).map((r) => r.run_id);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

test("a failed handling turn leaves its fact interrupted, and an unrelated healthy turn neither carries nor discharges it", async () => {
  const { id, provider } = session();
  const w = wire();
  const item = finished(id);
  provider.mode = "error";
  w.owe(id, item);
  await w.delivery.drain(id);
  await settle();

  assert.equal(provider.texts.length, 1, "exposed once");
  assert.match(provider.texts[0]!, new RegExp(item.id));
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "interrupted", interruption: "failed" },
  ]);
  assert.equal(w.delivery.queuedCount(id), 0, "not queued for another offer");

  provider.mode = "end";
  await promptRuntimeSession(drivers.get(id)!, "what's next?", {
    clientRequestId: `human-${id}`,
  });
  await w.delivery.drain(id);
  assert.equal(provider.texts.length, 2);
  assert.doesNotMatch(provider.texts[1]!, new RegExp(item.id));
  assert.equal(rows(id)[0]?.phase, "interrupted", "still owed to the user");
  assert.equal(notices.unhandledBackground(id).count, 1);
});

test("only the clean end of the bound run retires a fact, and a multi-item batch moves as one", async () => {
  const { id, provider } = session();
  const w = wire();
  hold.holdAutomaticTurns(id);
  const items = [finished(id), finished(id), finished(id)];
  for (const item of items) w.owe(id, item);
  hold.resumeAutomaticTurns(id);
  provider.mode = "manual";
  void w.delivery.requestDrain(id);
  await settle();

  assert.equal(provider.texts.length, 1, "one turn for the whole batch");
  for (const item of items)
    assert.match(provider.texts[0]!, new RegExp(item.id));
  assert.deepEqual(
    rows(id).map((r) => r.phase),
    ["handling", "handling", "handling"],
    "delivered is not handled",
  );
  const [runId] = runIds(id);
  assert.ok(runId);
  assert.equal(runIds(id).length, 1, "bound to one run");

  // Some other session's run ending, or a stale end of this one, moves nothing.
  notices.settleBackgroundHandling("someone-else", {
    runId,
    stopReason: "end",
    abortRequested: false,
  });
  notices.settleBackgroundHandling(id, {
    runId: "an-older-run",
    stopReason: "end",
    abortRequested: false,
  });
  assert.equal(rows(id).length, 3);

  provider.open.shift()!({ stopReason: "end" });
  await settle();
  assert.deepEqual(rows(id), [], "retired together by their run");
});

test("a Stop ends the handling turn as stopped and holds the session; the first recorded end wins", async () => {
  const { id, provider } = session();
  const w = wire();
  const item = finished(id);
  provider.mode = "manual";
  w.owe(id, item);
  await settle();
  assert.equal(rows(id)[0]?.phase, "handling");
  const [runId] = runIds(id);

  // The user's Stop: held first, then the abort (`connection.ts`).
  hold.holdAutomaticTurns(id);
  await sessionRuntime.abort(id);
  await settle();
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "interrupted", interruption: "stopped" },
  ]);

  // A late or duplicate report of the same run cannot relabel it.
  notices.settleBackgroundHandling(id, {
    runId: runId!,
    stopReason: "error",
    abortRequested: false,
  });
  notices.settleBackgroundHandling(id, {
    runId: runId!,
    stopReason: "end",
    abortRequested: false,
  });
  assert.equal(rows(id)[0]?.interruption, "stopped");
  assert.equal(provider.texts.length, 1, "nothing offered again");

  // Resume lifts the hold; it is not the authority to recover.
  hold.resumeAutomaticTurns(id);
  await w.delivery.requestDrain(id);
  await settle();
  assert.equal(provider.texts.length, 1);
  assert.equal(rows(id)[0]?.phase, "interrupted");
});

test("a failure reported first stays a failure when a Stop lands after it", () => {
  const { id } = session();
  backgroundDeliveryOutboxStore.save({
    sessionId: id,
    itemId: "item-first-failure",
    revision: 1,
    disposition: "wake",
    retained: false,
  });
  assert.ok(
    backgroundDeliveryOutboxStore.reserve(
      id,
      "attempt-a",
      [{ itemId: "item-first-failure", revision: 1 }],
      "owed",
    ),
  );
  backgroundDeliveryOutboxStore.bind(id, "attempt-a", "run-a", "entry-a");
  // The runtime reports the failure, then the Stop's abort closes the run.
  notices.settleBackgroundHandling(id, {
    runId: "run-a",
    stopReason: "error",
    abortRequested: false,
  });
  notices.settleBackgroundHandling(id, {
    runId: "run-a",
    stopReason: "aborted",
    abortRequested: true,
  });
  assert.equal(rows(id)[0]?.interruption, "failed");
});

test("a session torn down mid-turn leaves its fact interrupted as stopped", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "manual";
  w.owe(id, finished(id));
  await settle();
  assert.equal(rows(id)[0]?.phase, "handling");
  sessionRuntime.closeForTeardown(id);
  await settle();
  assert.equal(rows(id)[0]?.interruption, "stopped");
});

test("a wake joining a running pi turn is that run's to settle; a steer not taken stays owed", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "manual";
  void promptRuntimeSession(drivers.get(id)!, "long task", {
    clientRequestId: `human-${id}`,
  }).catch(() => {});
  await settle();
  assert.equal(drivers.get(id)!.isRunning, true);

  // Not taken: the turn ended in the driver's view first.
  provider.steer = () => Promise.resolve({ stopReason: "end", steered: false });
  const missed = finished(id);
  w.owe(id, missed);
  await settle();
  assert.equal(rows(id)[0]?.phase, "owed");
  assert.equal(w.delivery.queuedCount(id), 1, "kept for the next idle edge");

  // Taken: bound to the run it joined, which then fails.
  provider.steer = () => Promise.resolve({ stopReason: "end", steered: true });
  await w.delivery.drain(id);
  await settle();
  const live = sessionRuntime.get(id)!;
  assert.equal(rows(id)[0]?.phase, "handling");
  assert.deepEqual(runIds(id), [live.currentRunId]);
  provider.open.shift()!({ stopReason: "error", errorMessage: "boom" });
  await settle();
  assert.equal(rows(id)[0]?.interruption, "failed");
});

test("a deferred fact riding a Claude deferred steer: taken joins the run; withdrawn unread comes back; maybe read is interrupted", async () => {
  for (const answer of ["taken", "unread", "uncertain"] as const) {
    const { id, provider } = session({ steerAcceptance: "deferred" });
    const w = wire();
    provider.mode = "manual";
    void promptRuntimeSession(drivers.get(id)!, "long task", {
      clientRequestId: `human-${id}`,
    }).catch(() => {});
    await settle();
    const item = finished(id, { stopped: true });
    w.owe(id, item);
    assert.equal(w.delivery.queuedCount(id), 1, "deferred, no turn of its own");

    provider.steer = (_text, options) => {
      if (answer === "taken") {
        options.onSteerAccepted?.("steer");
        return Promise.resolve({ stopReason: "end", steerDelivery: "steer" });
      }
      return Promise.resolve({
        stopReason: "end",
        steerWithdrawn: true,
        ...(answer === "uncertain" ? { steerUncertain: true } : {}),
      });
    };
    let thrown: unknown;
    try {
      await promptRuntimeSession(drivers.get(id)!, "approval outcome", {
        clientRequestId: `handoff-${id}`,
        steer: true,
        hidden: true,
        origin: { kind: "system", source: "approval" },
      });
    } catch (error) {
      thrown = error;
    }
    const steered = provider.texts.at(-1)!;
    assert.match(steered, new RegExp(item.id), `${answer}: carried`);
    if (answer === "taken") {
      assert.equal(thrown, undefined);
      assert.equal(rows(id)[0]?.phase, "handling");
      provider.open.shift()!({ stopReason: "end" });
      await settle();
      assert.deepEqual(rows(id), [], "taken: the joined run's clean end");
    } else if (answer === "unread") {
      assert.ok(thrown instanceof SteerWithdrawnError);
      assert.equal(rows(id)[0]?.phase, "owed");
      assert.equal(w.delivery.queuedCount(id), 1, "back for the next turn");
      provider.open.shift()!({ stopReason: "end" });
    } else {
      assert.ok(thrown instanceof SteerWithdrawnError && thrown.uncertain);
      assert.deepEqual(rows(id), [
        { itemId: item.id, phase: "interrupted", interruption: "unknown" },
      ]);
      assert.equal(w.delivery.queuedCount(id), 0, "never offered again");
      provider.open.shift()!({ stopReason: "end" });
    }
    await settle();
  }
});

test("a claim the store refuses exposes nothing, and the fact waits", async () => {
  const { id, provider } = session();
  let refuse = true;
  const w = wire({
    ...notices.backgroundDeliveryOutbox,
    reserve: (...args) => {
      if (refuse) throw new Error("SQLITE_BUSY");
      return notices.backgroundDeliveryOutbox.reserve(...args);
    },
  });
  w.owe(id, finished(id));
  await w.delivery.drain(id);
  await settle();
  assert.equal(provider.texts.length, 0, "nothing reached the provider");
  assert.equal(rows(id)[0]?.phase, "owed");
  assert.equal(w.delivery.queuedCount(id), 1);
  refuse = false;
  await w.delivery.drain(id);
  await settle();
  assert.equal(provider.texts.length, 1);
  assert.deepEqual(rows(id), []);
});

test("a fact whose save never reached the table gets its receipt from the claim", async () => {
  const { id, provider } = session();
  const w = wire({
    ...notices.backgroundDeliveryOutbox,
    save: () => false,
  });
  provider.mode = "manual";
  w.owe(id, finished(id));
  await settle();
  assert.equal(rows(id)[0]?.phase, "handling", "recorded before exposure");
  provider.open.shift()!({ stopReason: "end" });
  await settle();
  assert.deepEqual(rows(id), []);
});

test("Recover carries a bounded reference, never the original block, and only its clean end retires the fact", async () => {
  const { id, provider } = session();
  const w = wire();
  const item = finished(id, { outcome: "ORIGINAL-OUTCOME-MARKER" });
  provider.mode = "error";
  w.owe(id, item);
  await settle();
  assert.match(provider.texts[0]!, /ORIGINAL-OUTCOME-MARKER/);
  assert.equal(rows(id)[0]?.interruption, "failed");
  const firstEntryRun = runIds(id);

  // A recovery that fails too goes back, under the attempt it was.
  const failed = await w.recover(id);
  assert.ok("done" in failed);
  await failed.done;
  assert.equal(provider.texts.length, 2);
  assert.equal(rows(id)[0]?.interruption, "failed");
  assert.notDeepEqual(runIds(id), firstEntryRun, "a NEW bound attempt");

  provider.mode = "end";
  const recovered = await w.recover(id);
  assert.ok("done" in recovered);
  await recovered.done;
  const sent = provider.texts.at(-1)!;
  assert.match(sent, /background_work_recovery/);
  assert.match(sent, new RegExp(item.id));
  assert.match(sent, /earlierEntryId/);
  assert.doesNotMatch(
    sent,
    /ORIGINAL-OUTCOME-MARKER/,
    "not the original block",
  );
  assert.doesNotMatch(sent, /"type":"background_work"/);
  assert.deepEqual(rows(id), []);
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.state,
    "completed",
    "the job itself is untouched",
  );
});

test("Recover is the user's alone: refused while stopped, before and after its last await, and never cold-acquires a held session", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  w.owe(id, finished(id));
  await settle();
  assert.equal(rows(id)[0]?.phase, "interrupted");

  hold.holdAutomaticTurns(id);
  w.acquired.length = 0;
  const early = await w.recover(id);
  assert.deepEqual(early, {
    refused: "The session is stopped; resume it first.",
  });
  assert.deepEqual(w.acquired, [], "a held session is not acquired");

  hold.resumeAutomaticTurns(id);
  const late = await notices.recoverBackgroundHandling(
    w.delivery,
    id,
    async (sessionId) => {
      // A Stop lands while the harness is being acquired.
      hold.holdAutomaticTurns(sessionId);
      return drivers.get(sessionId);
    },
  );
  assert.ok("refused" in late);
  assert.equal(provider.texts.length, 1, "nothing sent");
  assert.equal(rows(id)[0]?.phase, "interrupted");
  assert.equal(hold.automaticTurnsHeld(id), true, "the hold stands");
  hold.resumeAutomaticTurns(id);
});

test("Recover refuses an archived, deleted or running session, and a second Recover racing the first claims nothing", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  w.owe(id, finished(id));
  await settle();

  sessionStore.setArchived(id, true);
  assert.ok("refused" in (await w.recover(id)));
  sessionStore.setArchived(id, false);

  provider.mode = "manual";
  const first = await w.recover(id);
  const second = await w.recover(id);
  assert.ok("done" in first);
  await settle();
  assert.equal(provider.texts.length, 2, "one recovery turn reached the model");
  if ("done" in second) await second.done;
  assert.ok("refused" in (await w.recover(id)), "running: refused");
  provider.open.shift()!({ stopReason: "end" });
  if ("done" in first) await first.done;
  assert.deepEqual(rows(id), []);
});

test("Recover takes the oldest batch first and leaves the rest listed, with every id whole", async () => {
  const { id, provider } = session();
  const items = Array.from(
    { length: notices.BACKGROUND_RECOVERY_BATCH + 2 },
    () => finished(id),
  );
  // Each exposed by an attempt a restart cut off: interrupted, as boot leaves
  // them, and in no delivery queue.
  for (const [index, item] of items.entries()) {
    backgroundDeliveryOutboxStore.save({
      sessionId: id,
      itemId: item.id,
      revision: item.revision,
      disposition: "wake",
      retained: false,
    });
    backgroundDeliveryOutboxStore.reserve(
      id,
      `cut-${id}-${index}`,
      [{ itemId: item.id, revision: item.revision }],
      "owed",
    );
  }
  backgroundDeliveryOutboxStore.interruptUnfinished();
  assert.equal(notices.unhandledBackground(id).count, items.length);
  const w = wire();

  const first = await w.recover(id);
  assert.ok("done" in first);
  await first.done;
  assert.equal(provider.texts.length, 1);
  const sent = provider.texts[0]!;
  for (const item of items.slice(0, notices.BACKGROUND_RECOVERY_BATCH))
    assert.ok(sent.includes(`"taskId":"${item.id}"`), item.id);
  assert.match(sent, /"remainingToRecover":2/);
  assert.match(sent, /"interruption":"restart"/);
  assert.deepEqual(
    rows(id).map((r) => r.itemId),
    items.slice(notices.BACKGROUND_RECOVERY_BATCH).map((i) => i.id),
  );
  const second = await w.recover(id);
  assert.ok("done" in second);
  await second.done;
  assert.equal(provider.texts.length, 2);
  assert.deepEqual(rows(id), []);
});

test("Dismiss lets interrupted facts go and touches nothing still owed", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  w.owe(id, finished(id));
  await settle();
  hold.holdAutomaticTurns(id);
  const owed = finished(id);
  w.owe(id, owed);
  assert.equal(
    notices.dismissBackgroundHandling(id, notices.unhandledBackgroundBatch(id)),
    1,
  );
  assert.deepEqual(rows(id), [
    { itemId: owed.id, phase: "owed", interruption: null },
  ]);
  hold.resumeAutomaticTurns(id);
});

test("one item is one debt: a later revision neither adds a second row nor reopens an exposed one", () => {
  const { id } = session();
  const save = (revision: number) =>
    backgroundDeliveryOutboxStore.save({
      sessionId: id,
      itemId: "item-revisions",
      revision,
      disposition: "wake",
      retained: false,
    });
  save(3);
  save(9);
  assert.deepEqual(rows(id).length, 1);
  assert.ok(
    backgroundDeliveryOutboxStore.reserve(
      id,
      "attempt-rev",
      [{ itemId: "item-revisions", revision: 3 }],
      "owed",
    ),
  );
  save(12);
  assert.equal(rows(id)[0]?.phase, "reserved", "a save never moves a claim");
  assert.equal(
    backgroundDeliveryOutboxStore.reserve(
      id,
      "attempt-again",
      [{ itemId: "item-revisions", revision: 3 }],
      "owed",
    ),
    false,
    "and a second claim cannot take it",
  );
  backgroundDeliveryOutboxStore.remove(id, "item-revisions", 3);
  assert.equal(rows(id).length, 1, "a queue drop cannot erase a claimed row");
});

/** A session's runtime log, to make one of its writes fail. */
function failNextUserAppend(id: string, persistFirst: boolean) {
  const log = (
    sessionRuntime.get(id) as unknown as {
      log: { append: (draft: { type: string; role?: string }) => unknown };
    }
  ).log;
  const append = log.append.bind(log);
  let armed = true;
  log.append = (draft) => {
    if (armed && draft.type === "message" && draft.role === "user") {
      armed = false;
      // As a post-persist bookkeeping failure: the line is written first.
      if (persistFirst) append(draft);
      throw new Error("SQLITE_IOERR");
    }
    return append(draft);
  };
}

test("self-removal settles the requester and keeps a merge job's result when its wake hits the missing-worktree door", async () => {
  const { id, provider } = session();
  const { linkSessionToWorktree } = await import("./db/worktreeStore.ts");
  const { settleSessionsForRemovedWorktree } =
    await import("./sessionActivity.ts");
  const gone = `removed-${id}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  linkSessionToWorktree(id, gone);
  await settleSessionsForRemovedWorktree(gone);
  assert.ok(sessionStore.get(id)?.settledAt);
  const item = finished(id, {
    mergeJob: true,
    outcome: "Merged #42; worktree removed",
  });
  const w = wire();
  w.owe(id, item);
  await w.delivery.drain(id);
  await settle();
  assert.equal(provider.texts.length, 0);
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "owed", interruption: null },
  ]);
  assert.equal(
    backgroundWorkStore.getItem(item.id)?.outcomeSummary,
    "Merged #42; worktree removed",
  );
  assert.equal(w.delivery.queuedCount(id), 0);
});

test("a provider that never had the prompt gives the fact back, even when its entry was persisted first", async () => {
  const { id, provider } = session();
  const w = wire();
  const item = finished(id);
  failNextUserAppend(id, true);
  w.owe(id, item);
  await settle();
  assert.equal(provider.texts.length, 0, "the provider was never called");
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "owed", interruption: null },
  ]);
  assert.equal(w.delivery.queuedCount(id), 0, "unavailable: kept durably");
});

test("a steer the provider took whose entry then failed is possibly read: interrupted, never re-offered", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "manual";
  void promptRuntimeSession(drivers.get(id)!, "long task", {
    clientRequestId: `human-${id}`,
  }).catch(() => {});
  await settle();
  provider.steer = () => Promise.resolve({ stopReason: "end", steered: true });
  failNextUserAppend(id, false);
  const item = finished(id);
  w.owe(id, item);
  await settle();
  assert.equal(provider.texts.length, 2, "the provider took the steer");
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "interrupted", interruption: "unknown" },
  ]);
  assert.equal(w.delivery.queuedCount(id), 0);
  provider.open.shift()!({ stopReason: "end" });
  await settle();
  assert.equal(rows(id)[0]?.phase, "interrupted", "the run's end is not it");
});

test("a binding the store refuses is settled by the attempt: a clean end retires it, a failure interrupts it", async () => {
  for (const end of ["end", "error"] as const) {
    const { id, provider } = session();
    const w = wire();
    const bind = backgroundDeliveryOutboxStore.bind;
    backgroundDeliveryOutboxStore.bind = () => {
      throw new Error("SQLITE_BUSY");
    };
    provider.mode = "manual";
    w.owe(id, finished(id));
    await settle();
    backgroundDeliveryOutboxStore.bind = bind;
    assert.equal(rows(id)[0]?.phase, "reserved", `${end}: still claimed`);
    assert.equal(
      notices.unhandledBackground(id).count,
      0,
      "not offered to the user while its turn runs",
    );
    provider.open.shift()!(
      end === "end"
        ? { stopReason: "end" }
        : { stopReason: "error", errorMessage: "boom" },
    );
    await settle();
    if (end === "end") assert.deepEqual(rows(id), []);
    else assert.equal(rows(id)[0]?.interruption, "failed");
  }
});

test("a settlement the store refuses, and the emitter would swallow, is retried at the next run's end", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "manual";
  w.owe(id, finished(id));
  await settle();
  const settleRun = backgroundDeliveryOutboxStore.settleRun;
  backgroundDeliveryOutboxStore.settleRun = () => {
    throw new Error("SQLITE_BUSY");
  };
  provider.open.shift()!({ stopReason: "end" });
  await settle();
  backgroundDeliveryOutboxStore.settleRun = settleRun;
  assert.equal(rows(id)[0]?.phase, "handling", "not lost, not misread");

  // Any later run's end, of any session, retries it.
  const other = session();
  await promptRuntimeSession(drivers.get(other.id)!, "hello", {
    clientRequestId: `human-${other.id}`,
  });
  await settle();
  assert.deepEqual(rows(id), [], "retired by its own run's outcome");
});

test("a deferred steer the provider accepts after a teardown closed its run is possibly read: interrupted", async () => {
  const { id, provider } = session({ steerAcceptance: "deferred" });
  const w = wire();
  provider.mode = "manual";
  void promptRuntimeSession(drivers.get(id)!, "long task", {
    clientRequestId: `human-${id}`,
  }).catch(() => {});
  await settle();
  const item = finished(id, { stopped: true });
  w.owe(id, item);
  provider.steer = (_text, options) =>
    new Promise((resolve) => {
      // The session is torn down; the CLI's buffered acceptance arrives after.
      sessionRuntime.closeForTeardown(id);
      setTimeout(() => {
        options.onSteerAccepted?.("steer");
        resolve({ stopReason: "end", steerDelivery: "steer" });
      }, 0);
    });
  await assert.rejects(
    promptRuntimeSession(drivers.get(id)!, "approval outcome", {
      clientRequestId: `handoff-${id}`,
      steer: true,
      hidden: true,
      origin: { kind: "system", source: "approval" },
    }),
  );
  await settle();
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "interrupted", interruption: "unknown" },
  ]);
});

test("a run that closes cleanly before the joining steer is recorded cannot retire it", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "manual";
  void promptRuntimeSession(drivers.get(id)!, "long task", {
    clientRequestId: `human-${id}`,
  }).catch(() => {});
  await settle();
  const aimed = sessionRuntime.get(id)!.currentRunId;
  provider.steer = async () => {
    // pi takes the steer, and the run it joined ends before the app records it.
    provider.open.shift()!({ stopReason: "end" });
    await settle();
    return { stopReason: "end", steered: true };
  };
  const item = finished(id);
  w.owe(id, item);
  await settle();
  await settle();
  assert.ok(aimed);
  assert.notEqual(sessionRuntime.get(id)!.currentRunId, aimed);
  assert.deepEqual(rows(id), [
    { itemId: item.id, phase: "interrupted", interruption: "unknown" },
  ]);
});

test("a native provider turn, clean or failed, settles no PA fact; the next PA carrier binds and settles it", async () => {
  const { id, provider } = session();
  const w = wire();
  // A claude-query fact settling inside a live turn defers to the next turn:
  // the CLI injected its own notification there, which PA cannot bind.
  const item = finished(id);
  w.delivery.enqueue(id, {
    itemId: item.id,
    revision: item.revision,
    label: item.label,
    state: "completed",
    humanLink: notices.backgroundWorkHumanLink(item.id),
    backend: "claude-query",
    stopRequested: false,
    ownerTurnRunning: true,
  });
  assert.equal(w.delivery.queuedCount(id), 1, "deferred");

  // The CLI wakes itself for its own task: a turn with no PA entry.
  for (const [run, stopReason] of [
    [1, "end"],
    [2, "error"],
  ] as const) {
    provider.emit({ type: "messageStarted", streamId: `native-${run}`, run });
    provider.emit({ type: "runCompleted", stopReason, run });
    await settle();
    assert.deepEqual(rows(id), [
      { itemId: item.id, phase: "owed", interruption: null },
    ]);
  }
  assert.equal(provider.texts.length, 0);

  provider.mode = "manual";
  void promptRuntimeSession(drivers.get(id)!, "next question", {
    clientRequestId: `human-${id}`,
  }).catch(() => {});
  await settle();
  assert.match(provider.texts[0]!, new RegExp(item.id), "a PA carrier");
  assert.equal(rows(id)[0]?.phase, "handling");
  provider.open.shift()!({ stopReason: "end" });
  await settle();
  assert.deepEqual(rows(id), []);
});

test("Recover and Dismiss act on exactly the identities the user was shown", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  const first = finished(id);
  w.owe(id, first);
  await settle();
  const shown = notices.unhandledBackgroundBatch(id);
  assert.deepEqual(
    shown.map((r) => r.itemId),
    [first.id],
  );

  // Interrupted after the user looked: not theirs to dismiss yet.
  const later = finished(id);
  w.owe(id, later);
  await settle();
  assert.equal(notices.unhandledBackground(id).count, 2);
  assert.equal(notices.dismissBackgroundHandling(id, shown), 1);
  assert.deepEqual(
    rows(id).map((r) => r.itemId),
    [later.id],
  );

  // A stale snapshot recovers nothing; the current one recovers that fact.
  provider.mode = "manual";
  assert.ok("refused" in (await w.recover(id, shown)));
  const current = notices.unhandledBackgroundBatch(id);
  const recovering = await w.recover(id, current);
  assert.ok("done" in recovering);
  await settle();
  assert.equal(rows(id)[0]?.phase, "handling");
  assert.equal(
    notices.dismissBackgroundHandling(id, current),
    0,
    "a Dismiss racing the Recover takes nothing",
  );
  provider.open.shift()!({ stopReason: "error", errorMessage: "again" });
  if ("done" in recovering) await recovering.done;
  assert.equal(
    notices.dismissBackgroundHandling(id, current),
    0,
    "the newer attempt is not the one the user was shown",
  );
  assert.equal(
    notices.dismissBackgroundHandling(id, notices.unhandledBackgroundBatch(id)),
    1,
  );
  assert.deepEqual(rows(id), []);
  assert.equal(
    backgroundWorkStore.getItem(later.id)?.state,
    "completed",
    "Dismiss cancels the receipt, not the job",
  );
});

test("a Recover the run door refuses leaves its facts interrupted as they were, never owed", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  w.owe(id, finished(id));
  await settle();
  const before = rows(id);
  // Held between the acquisition and the run door's last check.
  const refused = await notices.recoverBackgroundHandling(
    w.delivery,
    id,
    async (sessionId) => {
      queueMicrotask(() => hold.holdAutomaticTurns(sessionId));
      return drivers.get(sessionId);
    },
  );
  if ("done" in refused) await refused.done;
  await settle();
  assert.deepEqual(rows(id), before, "still interrupted, as failed");
  assert.equal(w.delivery.queuedCount(id), 0, "never back in the queue");
  assert.equal(provider.texts.length, 1);
  hold.resumeAutomaticTurns(id);
});

test("the recovery reference names the exact revision and how to read the fact, never the fact itself", async () => {
  const { id, provider } = session();
  const w = wire();
  provider.mode = "error";
  const item = finished(id, { outcome: "ORIGINAL-OUTCOME-MARKER" });
  w.owe(id, item);
  await settle();
  // A retained host re-stamps the terminal row: metadata, not a new fact.
  getDb()
    .prepare(
      "UPDATE background_work_items SET revision = revision + 5 WHERE id = ?",
    )
    .run(item.id);
  provider.mode = "end";
  const recovered = await w.recover(id);
  assert.ok("done" in recovered);
  await recovered.done;
  const json = JSON.parse(provider.texts.at(-1)!.split("\n")[1]!) as {
    updates: Array<Record<string, unknown>>;
  };
  assert.equal(json.updates[0]?.taskId, item.id);
  assert.equal(json.updates[0]?.revision, item.revision, "the owed revision");
  assert.match(provider.texts.at(-1)!, /background_tasks/);
  assert.doesNotMatch(provider.texts.at(-1)!, /ORIGINAL-OUTCOME-MARKER/);
});

test("the artifact cap never evicts the output of a fact still owed or unhandled", async () => {
  const { id, provider } = session();
  const w = wire();
  const {
    stageSessionArtifact,
    sessionArtifactFile,
    setArtifactRetentionGuard,
  } = await import("./mcp/toolGroups/packRuntime.ts");
  setArtifactRetentionGuard((sessionId) =>
    backgroundDeliveryOutboxStore.protectedArtifactIds(sessionId),
  );
  const stage = (name: string) =>
    stageSessionArtifact(id, {
      name,
      mimeType: "text/plain",
      kind: "file",
      label: name,
      sourceTool: "test",
      bytes: new TextEncoder().encode(name),
    });
  const unowned = stage("unowned.txt");
  const owned = stage("owned.txt");
  serial += 1;
  const reserved = backgroundWorkStore.reserveItem({
    ownerSessionId: id,
    backend: "host-process",
    kind: "shell",
    label: "with output",
    sourceRequestId: `${id}:output`,
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "test",
    ownerLimit: 1_000,
  });
  const item = backgroundWorkStore.terminalize({
    itemId: reserved.id,
    state: "completed",
    evidence: {
      artifactId: owned.id,
      capturedBytes: 9,
      originalBytes: 9,
      truncated: false,
      text: true,
    },
  });
  provider.mode = "error";
  w.owe(id, item);
  await settle();
  assert.equal(rows(id)[0]?.phase, "interrupted");

  for (let i = 0; i < 85; i += 1) stage(`later-${i}.txt`);
  assert.ok(sessionArtifactFile(id, owned.id), "kept while it is owed");
  assert.equal(
    sessionArtifactFile(id, unowned.id),
    undefined,
    "the cap still applies to everything else",
  );
  setArtifactRetentionGuard(undefined);
});

/* ------------------- review findings: regressions ------------------- */

test("an ordinary Pi steer the real producer refuses after its run closed cleanly keeps the deferred fact owed", async () => {
  // PiLiveSession -> PiAdapter -> prompt facade -> runtime -> SQLite, around
  // a scripted native AgentSession: it settles the running turn while the
  // steer is pending, then refuses the steer. The provider took zero copies.
  const { PiLiveSession } = await import("./piSdk/PiLiveSession.ts");
  serial += 1;
  const id = `handling-pi-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "assistant",
    title: `handling ${serial}`,
  });
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  let streaming = false;
  let resolveRun: (() => void) | undefined;
  let steers = 0;
  const native = {
    sessionId: id,
    sessionName: "Fixture",
    get isStreaming() {
      return streaming;
    },
    sessionManager: { getBranch: () => [] },
    subscribe: (l: (event: Record<string, unknown>) => void) => {
      listener = l;
      return () => {};
    },
    getSessionStats: () => ({
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextSize: 0,
    }),
    prompt: () => {
      streaming = true;
      return new Promise<void>((resolve) => (resolveRun = resolve));
    },
    steer: () => {
      steers += 1;
      streaming = false;
      listener?.({ type: "agent_settled" });
      resolveRun?.();
      return Promise.reject(new Error("Cannot steer while idle"));
    },
    abort: async () => {
      streaming = false;
    },
    dispose: () => {},
  };
  const host = {
    broadcastSessions: async () => {},
    noteRunStarted: () => {},
    checkPendingReload: () => {},
    isReloadQueued: () => false,
    buildSessionState: () => ({}) as never,
  };
  const live = new PiLiveSession(
    "assistant",
    native as never,
    host as never,
    () => {},
  );
  const adapter = live.createRuntimeAdapter();
  sessionRuntime.createSession(id, adapter);
  drivers.set(id, driverOf(id, adapter));
  const w = wire();
  try {
    const run = promptRuntimeSession(drivers.get(id)!, "long turn", {
      clientRequestId: `first-${id}`,
    }).catch(() => {});
    await settle();
    listener?.({ type: "agent_start" });
    assert.equal(drivers.get(id)!.isRunning, true);
    const item = finished(id, { stopped: true });
    w.owe(id, item, true);
    await promptRuntimeSession(drivers.get(id)!, "decision", {
      steer: true,
      hidden: true,
      clientRequestId: `second-${id}`,
      origin: { kind: "system", source: "approval" },
    }).catch(() => {});
    await run;
    await settle();
    assert.equal(steers, 1);
    assert.deepEqual(rows(id), [
      { itemId: item.id, phase: "owed", interruption: null },
    ]);
    assert.equal(w.delivery.queuedCount(id), 1, "back for the next turn");
    // And the next turn can still claim, carry and retire it.
    streaming = false;
    native.prompt = () => Promise.resolve();
    await promptRuntimeSession(drivers.get(id)!, "next", {
      clientRequestId: `third-${id}`,
    });
    await settle();
    assert.deepEqual(rows(id), []);
  } finally {
    w.delivery.stop();
    sessionRuntime.closeForTeardown(id);
    live.dispose();
  }
});

test("an ordinary steer binds only once the provider takes it: before its run closes it is that run's; after, it is unknown", async () => {
  for (const order of ["accept-then-close", "close-then-accept"] as const) {
    const { id, provider } = session();
    const w = wire();
    provider.mode = "manual";
    void promptRuntimeSession(drivers.get(id)!, "long task", {
      clientRequestId: `human-${id}`,
    }).catch(() => {});
    await settle();
    const item = finished(id, { stopped: true });
    w.owe(id, item, true);
    let accept!: () => void;
    provider.steer = () =>
      new Promise((resolve) => {
        accept = () => resolve({ stopReason: "end" });
      });
    const steer = promptRuntimeSession(drivers.get(id)!, "decision", {
      clientRequestId: `steer-${id}`,
      steer: true,
      hidden: true,
      origin: { kind: "system", source: "approval" },
    });
    await settle();
    assert.equal(rows(id)[0]?.phase, "reserved", `${order}: not bound yet`);
    if (order === "accept-then-close") {
      accept();
      await steer;
      assert.equal(rows(id)[0]?.phase, "handling");
      provider.open.shift()!({ stopReason: "end" });
      await settle();
      assert.deepEqual(rows(id), [], "its run's clean end retires it");
    } else {
      provider.open.shift()!({ stopReason: "end" });
      await settle();
      assert.equal(
        rows(id)[0]?.phase,
        "reserved",
        "a clean end before acceptance retires nothing",
      );
      accept();
      await steer;
      assert.deepEqual(rows(id), [
        { itemId: item.id, phase: "interrupted", interruption: "unknown" },
      ]);
    }
  }
});

test("a clean run end the store refuses to record is retried as that outcome, whatever the prompt throws after it", async () => {
  const { id, provider } = session();
  const w = wire();
  const item = finished(id);
  // The adapter reports a clean completion, then the prompt resolves failed.
  provider.mode = "manual";
  provider.adapter.prompt = (text: string) => {
    provider.texts.push(text);
    provider.emit({ type: "runCompleted", stopReason: "end" });
    return Promise.resolve({
      stopReason: "error",
      errorMessage: "late producer error",
    });
  };
  getDb().exec(
    `CREATE TEMP TRIGGER refuse_retire_${serial} BEFORE DELETE ON background_delivery_outbox WHEN OLD.session_id='${id}' BEGIN SELECT RAISE(ABORT,'fixture write refused'); END`,
  );
  try {
    w.owe(id, item);
    await settle();
  } finally {
    getDb().exec(`DROP TRIGGER refuse_retire_${serial}`);
  }
  assert.equal(
    rows(id)[0]?.phase,
    "handling",
    "the late error relabels nothing",
  );
  const other = session();
  await promptRuntimeSession(drivers.get(other.id)!, "unrelated", {
    clientRequestId: `human-${other.id}`,
  });
  await settle();
  assert.deepEqual(rows(id), [], "retired by the clean outcome it had");
});

test("a failure the store refuses to record stays first when a Stop of the same run arrives later; a newer attempt is fenced", async () => {
  const { id } = session();
  backgroundDeliveryOutboxStore.save({
    sessionId: id,
    itemId: "item-fenced",
    revision: 1,
    disposition: "wake",
    retained: false,
  });
  backgroundDeliveryOutboxStore.reserve(
    id,
    "attempt-a",
    [{ itemId: "item-fenced", revision: 1 }],
    "owed",
  );
  backgroundDeliveryOutboxStore.bind(id, "attempt-a", "run-a", "entry-a");
  getDb().exec(
    `CREATE TEMP TRIGGER refuse_interrupt_${serial} BEFORE UPDATE OF phase ON background_delivery_outbox WHEN OLD.session_id='${id}' AND NEW.phase='interrupted' BEGIN SELECT RAISE(ABORT,'fixture write refused'); END`,
  );
  try {
    notices.settleBackgroundHandling(id, {
      runId: "run-a",
      stopReason: "error",
      abortRequested: false,
    });
  } finally {
    getDb().exec(`DROP TRIGGER refuse_interrupt_${serial}`);
  }
  assert.equal(rows(id)[0]?.phase, "handling");
  // A late Stop report of the same run: the failure retry goes first.
  notices.settleBackgroundHandling(id, {
    runId: "run-a",
    stopReason: "aborted",
    abortRequested: true,
  });
  assert.equal(rows(id)[0]?.interruption, "failed");

  // A Recover rebinds it under a new attempt; old run outcomes touch nothing.
  const [ref] = notices.unhandledBackgroundBatch(id);
  assert.ok(
    backgroundDeliveryOutboxStore.reserve(
      id,
      "attempt-b",
      [ref!],
      "interrupted",
    ),
  );
  backgroundDeliveryOutboxStore.bind(id, "attempt-b", "run-b", "entry-b");
  notices.settleBackgroundHandling(id, {
    runId: "run-a",
    stopReason: "end",
    abortRequested: false,
  });
  assert.equal(rows(id)[0]?.phase, "handling", "fenced by its new attempt");
});

test("more than 80 protected completion outputs, each captured before its terminal receipt, all stay readable", async () => {
  const { id } = session();
  const { sessionArtifactFile, setArtifactRetentionGuard } =
    await import("./mcp/toolGroups/packRuntime.ts");
  const { captureTaskOutputArtifact } = await import("./outputPolicy.ts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const outputRoot = join(DATA_DIR, `native-output-${id}`);
  mkdirSync(outputRoot, { recursive: true });
  setArtifactRetentionGuard((sessionId) =>
    backgroundDeliveryOutboxStore.protectedArtifactIds(sessionId),
  );
  const captured: string[] = [];
  try {
    for (let i = 0; i < 83; i += 1) {
      const reserved = backgroundWorkStore.reserveItem({
        ownerSessionId: id,
        backend: "host-process",
        kind: "shell",
        label: `output ${i}`,
        sourceRequestId: `${id}:output:${i}`,
        lifetimeMs: 60_000,
        settingsGeneration: 1,
        bootEpoch: "test",
        ownerLimit: 1_000,
      });
      const output = join(outputRoot, `output-${i}.txt`);
      writeFileSync(output, `original terminal output ${i}`);
      // The producers' order: capture, then evidence and terminal row, then
      // the receipt.
      const evidence = captureTaskOutputArtifact({
        sessionId: id,
        outputFile: output,
        trustedRoot: outputRoot,
        sourceTool: "pi background work",
        artifactLabel: "pi background work output",
      });
      assert.ok(evidence.artifactId);
      captured.push(evidence.artifactId);
      assert.ok(
        sessionArtifactFile(id, evidence.artifactId),
        `${i}: readable right after its capture`,
      );
      const item = backgroundWorkStore.terminalize({
        itemId: reserved.id,
        state: "completed",
        evidence,
      });
      backgroundDeliveryOutboxStore.save({
        sessionId: id,
        itemId: item.id,
        revision: item.revision,
        disposition: "wake",
        retained: false,
      });
      backgroundDeliveryOutboxStore.reserve(
        id,
        `artifact-attempt-${id}-${i}`,
        [{ itemId: item.id, revision: item.revision }],
        "owed",
      );
      backgroundDeliveryOutboxStore.settleAttempt(
        id,
        `artifact-attempt-${id}-${i}`,
        "failed",
      );
    }
    assert.equal(notices.unhandledBackground(id).count, 83);
    for (const artifactId of captured)
      assert.ok(sessionArtifactFile(id, artifactId), artifactId);

    // Work that ended with no debt keeps no protection: once those debts are
    // dismissed, the cap applies again.
    while (notices.unhandledBackground(id).count > 0)
      notices.dismissBackgroundHandling(
        id,
        notices.unhandledBackgroundBatch(id),
      );
    const { stageSessionArtifact } =
      await import("./mcp/toolGroups/packRuntime.ts");
    stageSessionArtifact(id, {
      name: "after.txt",
      mimeType: "text/plain",
      kind: "file",
      label: "after",
      sourceTool: "test",
      bytes: new TextEncoder().encode("after"),
    });
    assert.equal(
      sessionArtifactFile(id, captured[0]!),
      undefined,
      "the oldest unowned output is evicted again",
    );
  } finally {
    setArtifactRetentionGuard(undefined);
  }
});

test("a prompt cap lowered below any update still carries each presented fact by its identity, never as a count", async () => {
  const { id, provider } = session();
  const delivery = new BackgroundCompletionDelivery({
    disposition: notices.completionDisposition,
    outbox: notices.backgroundDeliveryOutbox,
    offer: notices.offerBackgroundCompletion(async (sessionId) =>
      drivers.get(sessionId),
    ),
    maxPromptChars: 160,
  });
  const scheduler = installDeliveryTestScheduler({
    background: delivery,
    live: (key) => drivers.get(key),
    acquire: async (key) => drivers.get(key),
  });
  const item = finished(id, { outcome: "x".repeat(20_000) });
  notices.enqueueCompletionNotice(delivery, item, false);
  await scheduler.wake(id);
  await settle();
  assert.equal(provider.texts.length, 1);
  const json = JSON.parse(provider.texts[0]!.split("\n")[1]!) as {
    updates: Array<{ taskId: string }>;
    omittedCount?: number;
  };
  assert.deepEqual(
    json.updates.map((u) => u.taskId),
    [item.id],
    "the identity the model can read it by",
  );
  assert.equal(json.omittedCount, undefined);
  assert.deepEqual(rows(id), [], "presented, and its turn ended cleanly");
});

test("Recover refused by an archive, a delete or a Stop landing during the facade's last await claims and exposes nothing", async () => {
  for (const race of ["archive", "delete", "hold"] as const) {
    const { id, provider } = session();
    const w = wire();
    provider.mode = "error";
    w.owe(id, finished(id));
    await settle();
    const before = notices.unhandledBackgroundBatch(id);
    assert.equal(before.length, 1);
    provider.mode = "end";
    const result = await notices.recoverBackgroundHandling(
      w.delivery,
      id,
      async (sessionId) => {
        // After Recover's own late check, while the facade awaits.
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (race === "archive") sessionStore.setArchived(sessionId, true);
            else if (race === "delete")
              getDb()
                .prepare("UPDATE session_index SET deleted_at_ms=? WHERE id=?")
                .run(Date.now(), sessionId);
            else hold.holdAutomaticTurns(sessionId);
          }),
        );
        return drivers.get(sessionId);
      },
    );
    if ("done" in result) await result.done;
    await settle();
    assert.equal(provider.texts.length, 1, `${race}: nothing new reached it`);
    assert.deepEqual(
      notices.unhandledBackgroundBatch(id),
      before,
      `${race}: the facts stay as the user was shown them`,
    );
    if (race === "hold") hold.resumeAutomaticTurns(id);
  }
});

/* --------- a Recover that provably never ran keeps the shown receipt --------- */

type Receipt = { attempt_id: string | null; entry_id: string | null };

/** The attempt and transcript locator a row stands under. */
function receipt(sessionId: string, itemId: string): Receipt {
  const row = getDb()
    .prepare(
      "SELECT attempt_id, entry_id FROM background_delivery_outbox WHERE session_id=? AND item_id=?",
    )
    .get(sessionId, itemId) as Receipt | undefined;
  return {
    attempt_id: row?.attempt_id ?? null,
    entry_id: row?.entry_id ?? null,
  };
}

/** A session whose delivery of `count` facts failed in one turn. */
async function failedBatch(count = 1) {
  const { id, provider } = session();
  const w = wire();
  hold.holdAutomaticTurns(id);
  const items = Array.from({ length: count }, () => finished(id));
  for (const item of items) w.owe(id, item);
  provider.mode = "error";
  hold.resumeAutomaticTurns(id);
  await w.delivery.requestDrain(id);
  await settle();
  const refs = notices.unhandledBackgroundBatch(id);
  assert.equal(refs.length, count);
  const before = items.map((item) => receipt(id, item.id));
  for (const r of before) {
    assert.ok(r.attempt_id, "interrupted under the failed attempt");
    assert.ok(r.entry_id, "with the entry that carried it");
  }
  return { id, provider, w, items, refs, before };
}

test("a Recover refused after its claim by a busy runtime or a released harness keeps the failed receipt, its refs and its transcript locator", async () => {
  for (const race of ["busy", "released"] as const) {
    const { id, provider, w, items, refs, before } = await failedBatch(3);
    const prompts = provider.texts.length;
    const result = await notices.recoverBackgroundHandling(
      w.delivery,
      id,
      async (sessionId) => {
        // After Recover's own checks, while the facade awaits its last await:
        // the provider starts a turn of its own, or the harness is released.
        queueMicrotask(() =>
          queueMicrotask(() => {
            if (race === "busy")
              provider.emit({
                type: "messageStarted",
                streamId: `native-${sessionId}`,
              });
            else drivers.get(sessionId)!.released = true;
          }),
        );
        return drivers.get(sessionId);
      },
      refs,
    );
    if ("done" in result) await result.done;
    await settle();
    assert.equal(provider.texts.length, prompts, `${race}: never sent`);
    assert.deepEqual(
      items.map((item) => receipt(id, item.id)),
      before,
      `${race}: every row of the claim is back under its failed attempt`,
    );
    assert.deepEqual(
      rows(id).map((r) => r.interruption),
      ["failed", "failed", "failed"],
    );
    assert.deepEqual(
      notices.unhandledBackgroundBatch(id),
      refs,
      `${race}: the refs the user saved still match`,
    );

    // Those saved refs still work, and the next Recover still points at the
    // entry that carried the facts the first time.
    if (race === "busy")
      provider.emit({ type: "runCompleted", stopReason: "end" });
    drivers.get(id)!.released = false;
    await settle();
    provider.mode = "manual";
    const again = await w.recover(id, refs);
    assert.ok("done" in again, `${race}: the saved refs recover`);
    await settle();
    const sent = provider.texts.at(-1)!;
    for (const r of before)
      assert.ok(sent.includes(`"earlierEntryId":"${r.entry_id}"`), race);
    provider.open.shift()!({ stopReason: "end" });
    await again.done;
    assert.deepEqual(rows(id), []);
  }
});

test("a Recover whose entry write fails before the provider is called keeps the failed receipt; Dismiss by the saved refs then works", async () => {
  const { id, provider, w, items, refs, before } = await failedBatch(2);
  const prompts = provider.texts.length;
  failNextUserAppend(id, true);
  provider.mode = "end";
  const result = await w.recover(id, refs);
  if ("done" in result) await result.done;
  await settle();
  assert.equal(provider.texts.length, prompts, "the provider never had it");
  assert.deepEqual(
    items.map((item) => receipt(id, item.id)),
    before,
  );
  assert.equal(notices.dismissBackgroundHandling(id, refs), 2);
  assert.deepEqual(rows(id), []);
});

test("an older attempt's rollback cannot overwrite a newer exposed attempt, and a restart keeps the transcript locator", () => {
  const { id } = session();
  backgroundDeliveryOutboxStore.save({
    sessionId: id,
    itemId: "item-rollback",
    revision: 1,
    disposition: "wake",
    retained: false,
  });
  const claim = (
    attempt: string,
    from: "owed" | "interrupted",
    prior?: string,
  ) =>
    backgroundDeliveryOutboxStore.reserve(
      id,
      attempt,
      [
        {
          itemId: "item-rollback",
          revision: 1,
          ...(prior !== undefined ? { attemptId: prior } : {}),
        },
      ],
      from,
    );
  assert.ok(claim("attempt-1", "owed"));
  backgroundDeliveryOutboxStore.bind(id, "attempt-1", "run-1", "entry-1");
  backgroundDeliveryOutboxStore.settleRun(id, "run-1", "failed");
  // A Recover whose outcome is unknown: interrupted under its own attempt,
  // still pointing at the entry that carried the fact.
  assert.ok(claim("recover-2", "interrupted", "attempt-1"));
  backgroundDeliveryOutboxStore.settleAttempt(id, "recover-2", "unknown");
  assert.deepEqual(receipt(id, "item-rollback"), {
    attempt_id: "recover-2",
    entry_id: "entry-1",
  });
  // A newer Recover reaches its run; the older one's late rollback is fenced.
  assert.ok(claim("recover-3", "interrupted", "recover-2"));
  backgroundDeliveryOutboxStore.bind(id, "recover-3", "run-3", "entry-3");
  assert.equal(backgroundDeliveryOutboxStore.release(id, "recover-2"), 0);
  assert.equal(rows(id)[0]?.phase, "handling");
  assert.deepEqual(receipt(id, "item-rollback"), {
    attempt_id: "recover-3",
    entry_id: "entry-3",
  });
  // Cut off by a restart while a Recover held it unbound: the earlier entry
  // stays its locator.
  backgroundDeliveryOutboxStore.settleRun(id, "run-3", "failed");
  assert.ok(claim("recover-4", "interrupted", "recover-3"));
  backgroundDeliveryOutboxStore.interruptUnfinished();
  assert.deepEqual(receipt(id, "item-rollback"), {
    attempt_id: "recover-4",
    entry_id: "entry-3",
  });
  assert.equal(rows(id)[0]?.interruption, "restart");
});

/* ------- user-owned and coordinator-owned spawned sessions (#125) ------- */

test("unhandled updates of a coordinator-owned, a born-user-owned and a handed-back child: listed, block Settle and auto-archive, and survive ownership changes", async () => {
  const { listSessions } = await import("./sessions.ts");
  const { settleBlockedReason } = await import("@assistant/shared");
  const { selectSettledArchiveCandidates, SESSION_AUTO_ARCHIVE_AFTER_MS } =
    await import("./sessionRetention.ts");
  const coordinator = session();
  for (const ownership of [
    "coordinator",
    "born-user-owned",
    "handed-back",
  ] as const) {
    const { id, provider, w, refs, before, items } = await failedBatch(1);
    if (ownership === "born-user-owned")
      sessionStore.linkSpawned(
        coordinator.id,
        id,
        sessionStore.get(id)!.createdAt,
        "taken-over",
      );
    else sessionStore.linkSpawned(coordinator.id, id);
    if (ownership === "handed-back") {
      sessionStore.setSpawnedOwnership(id, "taken-over");
      sessionStore.setSpawnedOwnership(id, "coordinator");
    }
    // Ownership is the coordinator's relation to the child; the debt is the
    // child's own and does not move with it.
    assert.deepEqual(receipt(id, items[0]!.id), before[0], ownership);

    const settledLongAgo = Date.now() - SESSION_AUTO_ARCHIVE_AFTER_MS - 60_000;
    sessionStore.setSettled(id, true, settledLongAgo);
    const [row] = await listSessions([], () => 0, {
      includeArchived: true,
      onlyIds: new Set([id]),
    });
    assert.ok(row, ownership);
    assert.equal(row.unhandledBackgroundUpdates, 1, ownership);
    assert.equal(
      settleBlockedReason(row),
      "background updates it was given were not handled.",
      ownership,
    );
    assert.deepEqual(
      selectSettledArchiveCandidates([{ ...row, settledAt: settledLongAgo }], {
        now: Date.now(),
        viewed: new Set(),
        runOwned: new Set(),
      }),
      [],
      `${ownership}: auto-archive keeps it`,
    );

    // Recover works on the child itself, whoever owns it; while its turn
    // runs the row reports the handling count, which also holds Settle.
    provider.mode = "manual";
    const recovering = await w.recover(id, refs);
    assert.ok("done" in recovering, ownership);
    await settle();
    const [running] = await listSessions([], () => 0, {
      includeArchived: true,
      onlyIds: new Set([id]),
    });
    assert.equal(running?.handlingBackgroundUpdates, 1, ownership);
    assert.equal(running?.unhandledBackgroundUpdates, undefined, ownership);
    provider.open.shift()!({ stopReason: "end" });
    await recovering.done;
    const [done] = await listSessions([], () => 0, {
      includeArchived: true,
      onlyIds: new Set([id]),
    });
    assert.equal(done?.unhandledBackgroundUpdates, undefined, ownership);
    assert.equal(done?.handlingBackgroundUpdates, undefined, ownership);
  }
});

test("Recover and Dismiss identities pass client validation only when complete and bounded", async () => {
  const { validateClientMessage } = await import("./validateClientMessage.ts");
  const ref = { itemId: "bgw_1", revision: 2, attemptId: "attempt-1" };
  for (const type of ["recoverBackgroundUpdates", "dismissBackgroundUpdates"]) {
    assert.equal(
      validateClientMessage({ type, sessionId: "s", items: [ref] }).ok,
      true,
      type,
    );
    assert.equal(
      validateClientMessage({
        type,
        sessionId: "s",
        items: [{ ...ref, attemptId: null }],
      }).ok,
      true,
      `${type}: a row interrupted under no attempt`,
    );
    for (const items of [
      [],
      Array.from({ length: 21 }, () => ref),
      [{ ...ref, revision: -1 }],
      [{ ...ref, revision: 1.5 }],
      [{ ...ref, attemptId: "" }],
      [{ ...ref, itemId: "" }],
      [{ itemId: "bgw_1", revision: 2 }],
    ])
      assert.equal(
        validateClientMessage({ type, sessionId: "s", items }).ok,
        false,
        `${type}: ${JSON.stringify(items).slice(0, 60)}`,
      );
    assert.equal(validateClientMessage({ type, sessionId: "s" }).ok, false);
  }
});
