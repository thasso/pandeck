/**
 * A delivered background fact is not a handled one. The production chain —
 * delivery queue, outbox store, prompt facade, the live runtime and its
 * `RunOutcome`, settlement and the user's Recover — with only the provider
 * scripted: what reaches the model, which run a fact is bound to, and what
 * retires, interrupts or gives it back.
 *   pnpm --filter @assistant/server test src/backgroundHandling.test.ts
 */
import assert from "node:assert/strict";
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
  options: { stopped?: boolean; outcome?: string } = {},
) {
  serial += 1;
  const item = backgroundWorkStore.reserveItem({
    ownerSessionId: owner,
    backend: "host-process",
    kind: "shell",
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
    drainPeers: () => Promise.resolve(),
    held: hold.automaticTurnsHeld,
    disposition: notices.completionDisposition,
    outbox,
    offer: notices.offerBackgroundCompletion(driverFor),
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

afterEach(() => setDeferredBackgroundContextProvider(undefined));

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
    backgroundDeliveryOutboxStore.owedArtifactIds(sessionId),
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
