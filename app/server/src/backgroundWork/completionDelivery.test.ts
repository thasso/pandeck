import assert from "node:assert/strict";
import { test } from "vitest";
import { PromptDeliveryReceipt } from "../session/runtime/promptDelivery.ts";
import { ScheduledBackgroundDelivery as BackgroundCompletionDelivery } from "../test/backgroundDelivery.ts";

function appendedReceipt(entryId: string, runId: string) {
  return new PromptDeliveryReceipt(async (receipt) => {
    receipt.appended({ entryId, runId, accepted: true, joined: false });
  });
}
import {
  BackgroundCompletionTurnTracker,
  type BackgroundCompletionDeliveryOptions,
  type BackgroundCompletionOffer,
  type BackgroundDeliveryOutbox,
} from "./completionDelivery.ts";

function notice(id: string) {
  return {
    itemId: id,
    revision: 1,
    label: `work ${id}`,
    state: "completed" as const,
    humanLink: `/background-tasks?task=${id}`,
    // Delivery evidence that reaches `wake` under the default policy: these
    // tests are about the queue, not about which facts deserve a turn.
    backend: "claude-query" as const,
    stopRequested: false,
    ownerTurnRunning: false,
  };
}

/** The task ids an offer carries, in order: what reached the model. */
function carried(offer: BackgroundCompletionOffer): string[] {
  const json = JSON.parse(offer.contextBlock.split("\n")[1]!) as {
    updates: { taskId: string }[];
  };
  return json.updates.map((u) => u.taskId);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("a competing ordinary turn stays protected until background admission", async () => {
  const tracker = new BackgroundCompletionTurnTracker();
  let release!: () => void;
  const running = tracker.run("owner-race", async (accepted) => {
    // sessionSkills may yield here. Another human/peer turn can become active,
    // and it must not be misclassified as our background turn.
    assert.equal(tracker.protectsOrdinaryTurn("owner-race", true), true);
    accepted();
    assert.equal(tracker.protectsOrdinaryTurn("owner-race", true), false);
    await new Promise<void>((resolve) => (release = resolve));
  });
  await flush();
  assert.equal(tracker.protectsOrdinaryTurn("owner-race", true), false);
  release();
  await running;
  assert.equal(tracker.protectsOrdinaryTurn("owner-race", true), true);
});

test("activity is externalized and carries bounded-buffer drops", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, signal) => {
      offered = signal;
      return Promise.resolve("delivered");
    },
  });
  delivery.enqueueActivity("owner-activity", {
    itemId: "monitor-1",
    eventId: "batch-1",
    label: "watch server",
    lineCount: 2,
    bytes: 12,
    droppedEventCount: 3,
    humanLink: "/background-tasks?task=monitor-1",
    output: {
      path: "/tmp/activity/output.txt",
      cleanupPath: "/tmp/activity",
    },
  });
  await delivery.drain("owner-activity");
  assert.ok(offered);
  assert.match(offered.contextBlock, /watch server/);
  assert.match(offered.contextBlock, /\/tmp\/activity\/output.txt/);
  assert.match(offered.contextBlock, /"droppedEventCount":3/);
  assert.doesNotMatch(offered.contextBlock, /ready|changed/);
  assert.equal(offered.visibleText, "Background work updated.");
});

test("prompt caps omit whole updates, keep valid structured data, and owe the rest oldest first", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const all: string[][] = [];
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, signal, _key, attempt) => {
      offered ??= signal;
      all.push(carried(signal));
      attempt.reserve();
      attempt.exposed("entry", "run");
      return Promise.resolve("delivered");
    },
    maxPromptChars: 300,
  });
  delivery.enqueue("owner-truncated", {
    ...notice("first"),
    outcomeSummary: "x".repeat(1_000),
  });
  delivery.enqueue("owner-truncated", notice("second"));
  await delivery.drain("owner-truncated");
  assert.ok(offered);
  assert.ok(offered.contextBlock.length <= 300);
  const json = JSON.parse(offered.contextBlock.split("\n")[1]!) as {
    updates: Array<{ taskId: string }>;
    omittedCount?: number;
  };
  assert.equal(json.updates.length, 1);
  // The oldest goes first, trimmed to fit; the newer one is not dropped, it
  // was not told, so it stays owed and leads the next turn.
  assert.equal(json.updates[0]?.taskId, "first");
  assert.equal(json.omittedCount, 1);
  assert.equal(offered.presentation.omittedCount, 1);
  for (let i = 0; i < 20 && all.length < 2; i += 1) await flush();
  assert.deepEqual(all, [["first"], ["second"]]);
  assert.equal(delivery.queuedCount("owner-truncated"), 0);
});

test("completion replaces final activity when its artifact contains the output", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const discarded: string[] = [];
  let releasePeers!: () => void;
  const held = new BackgroundCompletionDelivery({
    beforeBackground: () =>
      new Promise<void>((resolve) => {
        releasePeers = resolve;
      }),
    offer: (_sessionId, signal) => {
      offered = signal;
      return Promise.resolve("delivered");
    },
    discard: (entry) => {
      if (entry.notice.output?.cleanupPath)
        discarded.push(entry.notice.output.cleanupPath);
    },
  });
  held.enqueueActivity("owner-combined", {
    itemId: "item-1",
    eventId: "activity-1",
    label: "build",
    lineCount: 1,
    bytes: 4,
    droppedEventCount: 0,
    humanLink: "/background-tasks?task=item-1",
    output: { path: "/tmp/activity.txt", cleanupPath: "/tmp/activity" },
  });
  await flush();
  held.enqueue("owner-combined", {
    ...notice("item-1"),
    output: { path: "/data/output.txt", url: "/api/output.txt" },
  });
  releasePeers();
  await held.drain("owner-combined");
  assert.ok(offered);
  assert.doesNotMatch(offered.contextBlock, /\/tmp\/activity.txt/);
  assert.match(offered.contextBlock, /\/data\/output.txt/);
  assert.equal(offered.presentation.updates.length, 1);
  assert.deepEqual(discarded, ["/tmp/activity"]);
});

test("the card carries the command and description; the model block does not", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, signal) => {
      offered = signal;
      return Promise.resolve("delivered");
    },
    discard: () => {},
  });
  delivery.enqueue("owner-command", {
    ...notice("item-cmd"),
    label: "Start dev server",
    description: "Start dev server",
    command: "pnpm dev --port 5174",
    commandTruncated: true,
  });
  await delivery.drain("owner-command");
  assert.ok(offered);
  const update = offered.presentation.updates[0]!;
  assert.equal(update.description, "Start dev server");
  assert.equal(update.command, "pnpm dev --port 5174");
  assert.equal(update.commandTruncated, true);
  assert.doesNotMatch(offered.contextBlock, /pnpm dev --port 5174/);
});

test("the card carries the outcome sentence, which is all a Claude job has", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, signal) => {
      offered = signal;
      return Promise.resolve("delivered");
    },
    discard: () => {},
  });
  delivery.enqueue("owner-outcome", {
    ...notice("item-outcome"),
    state: "failed",
    outcomeSummary: "Exited with code 2",
  });
  await delivery.drain("owner-outcome");
  assert.ok(offered);
  const update = offered.presentation.updates[0]!;
  assert.equal(update.status, "failed");
  // `claude-query` work never reports an exit code, so the card's opened body
  // has nothing else to say about how the job ended.
  assert.equal(update.exitCode, undefined);
  assert.equal(update.outcomeSummary, "Exited with code 2");
});

test("truncated completion output does not hide pending activity", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  let releasePeers!: () => void;
  const delivery = new BackgroundCompletionDelivery({
    beforeBackground: () =>
      new Promise<void>((resolve) => {
        releasePeers = resolve;
      }),
    offer: (_sessionId, signal) => {
      offered = signal;
      return Promise.resolve("delivered");
    },
  });
  delivery.enqueueActivity("owner-truncated-output", {
    itemId: "item-truncated",
    eventId: "activity-middle",
    label: "large build",
    lineCount: 1,
    bytes: 6,
    droppedEventCount: 0,
    humanLink: "/background-tasks?task=item-truncated",
    output: { path: "/tmp/middle.txt", cleanupPath: "/tmp/middle" },
  });
  await flush();
  delivery.enqueue("owner-truncated-output", {
    ...notice("item-truncated"),
    output: {
      path: "/data/head-tail.txt",
      url: "/api/head-tail.txt",
      truncated: true,
    },
  });
  releasePeers();
  await delivery.drain("owner-truncated-output");

  assert.ok(offered);
  assert.match(offered.contextBlock, /\/tmp\/middle.txt/);
  assert.match(offered.contextBlock, /\/data\/head-tail.txt/);
  assert.equal(offered.presentation.updates.length, 2);
});

test("a completion arriving during an offer is delivered by a later batch", async () => {
  const offered: BackgroundCompletionOffer[] = [];
  let releaseFirst!: () => void;
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, signal) => {
      offered.push(signal);
      if (offered.length === 1)
        return new Promise((resolve) => {
          releaseFirst = () => resolve("delivered");
        });
      return Promise.resolve("delivered");
    },
  });

  delivery.enqueue("owner-mid-offer", notice("first"));
  await flush();
  delivery.enqueue("owner-mid-offer", notice("second"));
  releaseFirst();
  await flush();
  await delivery.drain("owner-mid-offer");
  assert.equal(offered.length, 2);
  assert.match(offered[0]!.contextBlock, /work first/);
  assert.doesNotMatch(offered[0]!.contextBlock, /work second/);
  assert.match(offered[1]!.contextBlock, /work second/);
});

test("stopping delivery while peer drain is in flight prevents a new turn", async () => {
  let releasePeers!: () => void;
  let offers = 0;
  const delivery = new BackgroundCompletionDelivery({
    beforeBackground: () =>
      new Promise((resolve) => {
        releasePeers = resolve;
      }),
    offer: () => {
      offers += 1;
      return Promise.resolve("delivered");
    },
  });
  delivery.enqueue("owner-stopping", notice("stopped"));
  await flush();
  delivery.stop();
  releasePeers();
  await flush();
  assert.equal(offers, 0);
});

test("background delivery yields instead of queueing into a busy session", async () => {
  let busy = true;
  let offers = 0;
  const delivery = new BackgroundCompletionDelivery({
    offer: () => {
      offers += 1;
      return Promise.resolve(busy ? "busy" : "delivered");
    },
  });

  delivery.enqueue("owner-2", notice("item-2"));
  await delivery.drain("owner-2");
  assert.equal(offers, 1);
  busy = false;
  await delivery.drain("owner-2");
  assert.equal(
    offers,
    2,
    "the next idle opportunity retries the retained offer",
  );
  await delivery.drain("owner-2");
  assert.equal(offers, 2, "a delivered batch leaves nothing queued");
});

test("a deferred completion offers no turn and rides the next prompt", async () => {
  let offers = 0;
  const delivery = new BackgroundCompletionDelivery({
    offer: () => {
      offers += 1;
      return Promise.resolve("delivered");
    },
    disposition: () => "defer",
  });

  delivery.enqueue("owner-quiet", notice("quiet-1"));
  await delivery.drain("owner-quiet");
  assert.equal(offers, 0, "a deferred fact never starts a turn");

  const pending = delivery.claimDeferredContext("owner-quiet");
  assert.ok(pending, "the fact is held for the next turn");
  assert.match(pending.block, /"taskId":"quiet-1"/);
  assert.match(
    pending.block,
    /not a request/,
    "the block must not read as an instruction for the turn carrying it",
  );
});

test("a claim refused before its append gives the fact back; an appended one keeps it from every other prompt", async () => {
  const delivery = new BackgroundCompletionDelivery({
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
  });
  delivery.enqueue("owner-peek", notice("held"));
  await flush();

  const refused = delivery.claimDeferredContext("owner-peek");
  assert.ok(refused);
  assert.equal(
    delivery.claimDeferredContext("owner-peek"),
    undefined,
    "claimed: no other prompt carries it meanwhile",
  );
  refused.finished(new Error("busy"));
  const accepted = delivery.claimDeferredContext("owner-peek");
  assert.ok(accepted, "a refused turn must not consume the only copy");
  accepted.observe(appendedReceipt("entry", "run"));
  accepted.finished(undefined);
  assert.equal(delivery.claimDeferredContext("owner-peek"), undefined);
});

test("a fact deferred after a claim is not taken with the claimed batch", async () => {
  const delivery = new BackgroundCompletionDelivery({
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
  });
  delivery.enqueue("owner-race", notice("first"));
  await flush();

  const pending = delivery.claimDeferredContext("owner-race");
  assert.ok(pending);
  assert.match(pending.block, /"taskId":"first"/);
  // Arrives after the block was built, so it was never sent.
  delivery.enqueue("owner-race", notice("second"));
  pending.observe(appendedReceipt("entry", "run"));
  pending.finished(undefined);

  const remaining = delivery.claimDeferredContext("owner-race");
  assert.ok(remaining, "the later fact still has to reach a turn");
  assert.match(remaining.block, /"taskId":"second"/);
  assert.doesNotMatch(remaining.block, /"taskId":"first"/);
});

test("a refused claim leaves the deferred fact where it was, in order", async () => {
  const { outbox } = fakeOutbox();
  let refuse = true;
  const delivery = new BackgroundCompletionDelivery({
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
    outbox: {
      ...outbox,
      reserve: (...args) => (refuse ? false : outbox.reserve(...args)),
    },
  });
  delivery.enqueue("owner-refused", notice("a"));
  delivery.enqueue("owner-refused", notice("b"));
  assert.equal(
    delivery.claimDeferredContext("owner-refused"),
    undefined,
    "nothing is carried without its receipt",
  );
  assert.equal(delivery.queuedCount("owner-refused"), 2);
  refuse = false;
  const claimed = delivery.claimDeferredContext("owner-refused");
  assert.ok(claimed);
  assert.match(claimed.block, /"taskId":"a".*"taskId":"b"/);
});

test("deferred output files are cleaned up once their block is exposed", async () => {
  const discarded: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
    discard: (entry) => {
      const path = entry.notice.output?.cleanupPath;
      if (path) discarded.push(path);
    },
  });
  delivery.enqueue("owner-files", {
    ...notice("with-file"),
    output: { cleanupPath: "/tmp/turn-scoped" },
  });
  await flush();
  assert.deepEqual(discarded, []);

  const pending = delivery.claimDeferredContext("owner-files");
  assert.ok(pending);
  pending.observe(appendedReceipt("entry", "run"));
  pending.finished(undefined);
  assert.deepEqual(discarded, ["/tmp/turn-scoped"]);
});

test("stop() discards deferred facts as well as queued ones", async () => {
  const discarded: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
    discard: (entry) => {
      const path = entry.notice.output?.cleanupPath;
      if (path) discarded.push(path);
    },
  });
  delivery.enqueue("owner-drain", {
    ...notice("held"),
    output: { cleanupPath: "/tmp/held" },
  });
  await flush();
  delivery.stop();
  assert.deepEqual(discarded, ["/tmp/held"]);
  assert.equal(delivery.claimDeferredContext("owner-drain"), undefined);
});

test("a Stop's hold keeps a completion pending, unoffered and unconsumed, until it is lifted", async () => {
  let held = true;
  const offered: string[] = [];
  const discarded: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    held: () => held,
    offer: (_sessionId, offer) => {
      offered.push(carried(offer).join(","));
      return Promise.resolve("delivered");
    },
    discard: (entry) => discarded.push(entry.notice.itemId),
  });

  delivery.enqueue("owner-held", notice("item-held"));
  await delivery.drain("owner-held");
  // An idle edge, a later completion's own drain, a resume of the peer phase:
  // none of them offers while the session is held.
  await delivery.requestDrain("owner-held");
  assert.deepEqual(offered, []);
  assert.deepEqual(discarded, [], "nothing consumed");

  held = false;
  await delivery.requestDrain("owner-held");
  await delivery.requestDrain("owner-held");
  assert.deepEqual(offered, ["item-held"], "once");
  assert.deepEqual(discarded, ["item-held"]);
});

test("a Stop racing an offer leaves the completion for Resume instead of consuming it", async () => {
  let held = false;
  const offered: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    held: () => held,
    offer: (_sessionId, offer) => {
      offered.push(carried(offer).join(","));
      // The Stop lands while the offer awaits the session: the run door
      // refuses the turn, which the offer answers as busy.
      if (offered.length === 1) {
        held = true;
        return Promise.resolve("busy");
      }
      return Promise.resolve("delivered");
    },
  });

  delivery.enqueue("owner-race-stop", notice("item-race"));
  await delivery.drain("owner-race-stop");
  assert.equal(offered.length, 1);
  await delivery.drain("owner-race-stop");
  assert.equal(offered.length, 1, "no second offer while held");

  held = false;
  await delivery.requestDrain("owner-race-stop");
  assert.deepEqual(offered, ["item-race", "item-race"]);
  await delivery.requestDrain("owner-race-stop");
  assert.equal(offered.length, 2, "delivered once, then gone");
});

/**
 * An in-memory stand-in for the durable outbox, keyed like the table: each row
 * carries its phase and the attempt and run holding it, with the same
 * compare-and-set transitions (`backgroundDeliveryOutboxStore.ts`).
 */
function fakeOutbox() {
  const rows = new Map<string, "wake" | "defer">();
  const phases = new Map<
    string,
    {
      phase: "owed" | "reserved" | "handling" | "interrupted";
      attemptId?: string;
      runId?: string;
      interruption?: string;
    }
  >();
  const key = (sessionId: string, n: { itemId: string; revision: number }) =>
    `${sessionId}|${n.itemId}:${n.revision}`;
  const ofAttempt = (attemptId: string) =>
    [...phases].filter(([, p]) => p.attemptId === attemptId);
  const outbox: BackgroundDeliveryOutbox = {
    save: (sessionId, n, d) => {
      const k = key(sessionId, n);
      if (phases.has(k)) return true;
      rows.set(k, d);
      phases.set(k, { phase: "owed" });
      return true;
    },
    remove: (sessionId, n) => {
      const k = key(sessionId, n);
      if (phases.get(k)?.phase !== "owed") return;
      rows.delete(k);
      phases.delete(k);
    },
    reserve: (sessionId, attemptId, items, from) => {
      const keys = items.map((n) => key(sessionId, n));
      const recordable = (k: string, i: number) =>
        !phases.has(k) && from === "owed" && items[i]!.unrecorded === true;
      if (
        keys.some((k, i) => !recordable(k, i) && phases.get(k)?.phase !== from)
      )
        return false;
      for (const k of keys) {
        if (!rows.has(k)) rows.set(k, "wake");
        phases.set(k, { ...phases.get(k), phase: "reserved", attemptId });
      }
      return true;
    },
    bind: (_sessionId, attemptId, runId) => {
      for (const [k, p] of ofAttempt(attemptId))
        if (p.phase === "reserved")
          phases.set(k, { ...p, phase: "handling", runId });
    },
    release: (_sessionId, attemptId) => {
      for (const [k, p] of ofAttempt(attemptId))
        if (p.phase === "reserved")
          phases.set(k, {
            phase: p.interruption ? "interrupted" : "owed",
            ...(p.interruption ? { interruption: p.interruption } : {}),
          });
    },
    interrupt: (_sessionId, attemptId, interruption) => {
      for (const [k, p] of ofAttempt(attemptId))
        if (p.phase === "reserved" || p.phase === "handling")
          phases.set(k, { ...p, phase: "interrupted", interruption });
    },
  };
  /** How a run ended: a clean end retires its rows, anything else interrupts. */
  const settleRun = (runId: string, interruption?: string) => {
    for (const [k, p] of [...phases])
      if (p.phase === "handling" && p.runId === runId) {
        if (interruption === undefined) {
          phases.delete(k);
          rows.delete(k);
        } else phases.set(k, { ...p, phase: "interrupted", interruption });
      }
  };
  const phaseOf = (k: string) => phases.get(k)?.phase;
  return { rows, outbox, settleRun, phaseOf };
}

/**
 * An offer that reaches the model the way the facade does: claimed in
 * `admit`, appended into `runId`, then over.
 */
function exposingOffer(
  runId: string,
  log: string[] = [],
): BackgroundCompletionDeliveryOptions["offer"] {
  return (_sessionId, offer, _key, attempt) => {
    log.push(carried(offer).join(","));
    attempt.reserve();
    attempt.exposed(`entry-${runId}`, runId);
    attempt.finished(undefined);
    return Promise.resolve("delivered");
  };
}

test("the outbox keeps an owed completion until the run it reached ends cleanly, and a shutdown keeps it", async () => {
  let held = true;
  const { rows, outbox, settleRun, phaseOf } = fakeOutbox();
  const delivery = new BackgroundCompletionDelivery({
    held: () => held,
    outbox,
    disposition: (n) => (n.stopRequested ? "defer" : "wake"),
    offer: exposingOffer("run-wake"),
  });
  delivery.enqueue("owner-outbox", notice("woken"));
  delivery.enqueue("owner-outbox", {
    ...notice("deferred"),
    stopRequested: true,
  });
  await delivery.drain("owner-outbox");
  assert.deepEqual(
    [...rows],
    [
      ["owner-outbox|woken:1", "wake"],
      ["owner-outbox|deferred:1", "defer"],
    ],
  );

  held = false;
  await delivery.requestDrain("owner-outbox");
  assert.equal(
    phaseOf("owner-outbox|woken:1"),
    "handling",
    "delivered is not handled: it waits for its run",
  );
  settleRun("run-wake");
  assert.deepEqual([...rows.keys()], ["owner-outbox|deferred:1"]);

  const carrier = delivery.claimDeferredContext("owner-outbox")!;
  assert.equal(phaseOf("owner-outbox|deferred:1"), "reserved");
  assert.equal(delivery.queuedCount("owner-outbox"), 0, "claimed, not queued");
  carrier.observe(appendedReceipt("entry-human", "run-human"));
  carrier.finished(undefined);
  assert.equal(phaseOf("owner-outbox|deferred:1"), "handling");
  settleRun("run-human");
  assert.deepEqual([...rows.keys()], [], "handled facts leave the outbox");

  const other = fakeOutbox();
  const stopping = new BackgroundCompletionDelivery({
    held: () => true,
    outbox: other.outbox,
    offer: () => Promise.resolve("delivered"),
  });
  stopping.enqueue("owner-shutdown", notice("kept"));
  stopping.stop();
  assert.deepEqual(
    [...other.rows.keys()],
    ["owner-shutdown|kept:1"],
    "a shutdown leaves it for boot",
  );
});

test("a restored completion is not offered until a drain finds the session unheld, and is not saved twice", async () => {
  let held = true;
  const offered: string[] = [];
  const saved: string[] = [];
  const { outbox } = fakeOutbox();
  const delivery = new BackgroundCompletionDelivery({
    held: () => held,
    outbox: {
      ...outbox,
      save: (_s, n) => {
        saved.push(n.itemId);
        return true;
      },
    },
    offer: exposingOffer("run-restored", offered),
  });
  // Boot restores rows the table already holds.
  outbox.save("owner-restored", notice("from-before"), "wake");
  outbox.save("owner-restored", notice("deferred-before"), "defer");
  delivery.restore("owner-restored", notice("from-before"), "wake");
  delivery.restore("owner-restored", notice("deferred-before"), "defer");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(offered, [], "restore offers nothing by itself");
  held = false;
  await delivery.requestDrain("owner-restored");
  assert.deepEqual(offered, ["from-before"]);
  assert.ok(delivery.claimDeferredContext("owner-restored"));
  assert.deepEqual(saved, [], "already in the outbox");
});

test("an offer that fails or finds the session unavailable before exposure never retires the owed fact", async () => {
  for (const outcome of ["unavailable", "throws"] as const) {
    const { rows, outbox, phaseOf } = fakeOutbox();
    const discarded: string[] = [];
    const delivery = new BackgroundCompletionDelivery({
      outbox,
      discard: (entry) => discarded.push(entry.notice.itemId),
      offer: () =>
        outcome === "throws"
          ? Promise.reject(new Error("provider exploded"))
          : Promise.resolve("unavailable"),
    });
    delivery.enqueue("owner-failed", notice(`failed-${outcome}`));
    await delivery.drain("owner-failed");
    assert.deepEqual(
      [...rows.keys()],
      [`owner-failed|failed-${outcome}:1`],
      `${outcome}: still owed in the outbox`,
    );
    assert.equal(phaseOf(`owner-failed|failed-${outcome}:1`), "owed");
    if (outcome === "unavailable")
      assert.deepEqual(
        discarded,
        [`failed-${outcome}`],
        "its file is released",
      );
    else
      assert.equal(
        delivery.queuedCount("owner-failed"),
        1,
        "never claimed, so still queued",
      );
  }
});

test("the queued count follows real queued work and announces every change", async () => {
  const changes: number[] = [];
  let held = true;
  let answer: "delivered" | "busy" = "busy";
  const delivery: BackgroundCompletionDelivery =
    new BackgroundCompletionDelivery({
      held: () => held,
      disposition: (n) => (n.itemId === "later" ? "defer" : "wake"),
      offer: () => Promise.resolve(answer),
      queueChanged: (sessionId) =>
        changes.push(delivery.queuedCount(sessionId)),
    });

  assert.equal(delivery.queuedCount("owner-count"), 0);
  // Held by a Stop: both wait, and the count says so without any offer.
  delivery.enqueue("owner-count", notice("now"));
  delivery.enqueue("owner-count", notice("later"));
  await flush();
  assert.equal(delivery.queuedCount("owner-count"), 2);
  assert.deepEqual(changes, [1, 2]);

  // Resumed, but the session is busy: the batch is put back, still counted.
  held = false;
  await delivery.drain("owner-count");
  assert.equal(delivery.queuedCount("owner-count"), 2);
  assert.deepEqual(changes.slice(2), [1, 2], "offered, then put back");

  // Delivered: only the deferred update remains, riding the next turn.
  answer = "delivered";
  await delivery.drain("owner-count");
  assert.equal(delivery.queuedCount("owner-count"), 1);
  const carrier = delivery.claimDeferredContext("owner-count")!;
  carrier.observe(appendedReceipt("entry", "run"));
  carrier.finished(undefined);
  assert.equal(delivery.queuedCount("owner-count"), 0);
  assert.equal(changes.at(-1), 0);
  assert.equal(delivery.queuedCount("another-session"), 0);
});

test("under any cap every offered turn carries identities, oversized ones trimmed to the bare id, and the rest follow in order", async () => {
  const offers: Array<{ carried: string[]; block: string }> = [];
  const longId = (tag: string) => `${tag}-${"i".repeat(190)}`;
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, offer, _key, attempt) => {
      offers.push({ carried: carried(offer), block: offer.contextBlock });
      attempt.reserve();
      attempt.exposed("entry", "run");
      return Promise.resolve("delivered");
    },
    // Below the floor: the floor applies.
    maxPromptChars: 160,
  });
  for (const tag of ["a", "b", "c"])
    delivery.enqueue("owner-cap", {
      ...notice(longId(tag)),
      outcomeSummary: "x".repeat(5_000),
      output: { path: `/data/${"p".repeat(400)}/output.txt` },
    });
  for (let i = 0; i < 40 && offers.length < 3; i += 1) await flush();
  assert.deepEqual(
    offers.map((o) => o.carried),
    [[longId("a")], [longId("b")], [longId("c")]],
    "oldest first, one per turn, each by its whole id",
  );
  for (const offer of offers) {
    assert.ok(offer.block.length <= 1_200);
    assert.doesNotMatch(offer.block, /x{100}/, "trimmed, never the body");
  }
  assert.equal(delivery.queuedCount("owner-cap"), 0);
});

test("a cap that fits some but not all updates carries those whole and owes the rest", async () => {
  const offers: string[][] = [];
  const delivery = new BackgroundCompletionDelivery({
    offer: (_sessionId, offer, _key, attempt) => {
      offers.push(carried(offer));
      attempt.reserve();
      attempt.exposed("entry", "run");
      return Promise.resolve("delivered");
    },
    maxPromptChars: 1_200,
  });
  for (const tag of ["one", "two", "three", "four"])
    delivery.enqueue("owner-partial", {
      ...notice(tag),
      outcomeSummary: "y".repeat(300),
    });
  for (let i = 0; i < 40 && offers.flat().length < 4; i += 1) await flush();
  assert.deepEqual(offers.flat(), ["one", "two", "three", "four"]);
  assert.ok(offers.length > 1, "split across turns");
  assert.ok(offers.every((o) => o.length > 0));
});
