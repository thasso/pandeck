import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BackgroundCompletionDelivery,
  BackgroundCompletionTurnTracker,
  type BackgroundCompletionOffer,
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("a pending peer batch always finishes before background delivery", async () => {
  const order: string[] = [];
  let releasePeer!: () => void;
  const peer = new Promise<void>((resolve) => {
    releasePeer = resolve;
  });
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: async () => {
      order.push("peer-start");
      await peer;
      order.push("peer-finished");
    },
    offer: () => {
      order.push("background");
      return Promise.resolve("delivered");
    },
  });

  delivery.enqueue("owner-1", notice("item-1"));
  await flush();
  assert.deepEqual(order, ["peer-start"]);
  releasePeer();
  await delivery.drain("owner-1");
  assert.deepEqual(order, ["peer-start", "peer-finished", "background"]);
});

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
    drainPeers: () => Promise.resolve(),
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

test("prompt caps omit whole updates and keep valid structured data", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: () => Promise.resolve(),
    offer: (_sessionId, signal) => {
      offered = signal;
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
  assert.equal(json.updates[0]?.taskId, "second");
  assert.equal(json.omittedCount, 1);
  assert.equal(offered.presentation.omittedCount, 1);
});

test("completion replaces final activity when its artifact contains the output", async () => {
  let offered: BackgroundCompletionOffer | undefined;
  const discarded: string[] = [];
  let releasePeers!: () => void;
  const held = new BackgroundCompletionDelivery({
    drainPeers: () =>
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
    drainPeers: () => Promise.resolve(),
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
    drainPeers: () => Promise.resolve(),
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
    drainPeers: () =>
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
    drainPeers: () => Promise.resolve(),
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
    drainPeers: () =>
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
    drainPeers: () => Promise.resolve(),
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
    drainPeers: () => Promise.resolve(),
    offer: () => {
      offers += 1;
      return Promise.resolve("delivered");
    },
    disposition: () => "defer",
  });

  delivery.enqueue("owner-quiet", notice("quiet-1"));
  await delivery.drain("owner-quiet");
  assert.equal(offers, 0, "a deferred fact never starts a turn");

  const pending = delivery.peekDeferredContext("owner-quiet");
  assert.ok(pending, "the fact is held for the next turn");
  assert.match(pending.block, /"taskId":"quiet-1"/);
  assert.match(
    pending.block,
    /not a request/,
    "the block must not read as an instruction for the turn carrying it",
  );
});

test("peeking is non-destructive until the turn is accepted", async () => {
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: () => Promise.resolve(),
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
  });
  delivery.enqueue("owner-peek", notice("held"));
  await flush();

  const refused = delivery.peekDeferredContext("owner-peek");
  assert.ok(refused);
  // The turn was refused: nothing committed, so the fact survives for the next one.
  assert.ok(
    delivery.peekDeferredContext("owner-peek"),
    "a refused turn must not consume the only copy",
  );

  const accepted = delivery.peekDeferredContext("owner-peek");
  assert.ok(accepted);
  accepted.commit();
  assert.equal(delivery.peekDeferredContext("owner-peek"), undefined);
});

test("a fact deferred between peek and commit is not dropped with the batch", async () => {
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: () => Promise.resolve(),
    offer: () => Promise.resolve("delivered"),
    disposition: () => "defer",
  });
  delivery.enqueue("owner-race", notice("first"));
  await flush();

  const pending = delivery.peekDeferredContext("owner-race");
  assert.ok(pending);
  assert.match(pending.block, /"taskId":"first"/);
  // Arrives after the block was built, so it was never sent.
  delivery.enqueue("owner-race", notice("second"));
  pending.commit();

  const remaining = delivery.peekDeferredContext("owner-race");
  assert.ok(remaining, "the later fact still has to reach a turn");
  assert.match(remaining.block, /"taskId":"second"/);
  assert.doesNotMatch(remaining.block, /"taskId":"first"/);
});

test("deferred output files are cleaned up once their block is committed", async () => {
  const discarded: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: () => Promise.resolve(),
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

  const pending = delivery.peekDeferredContext("owner-files");
  assert.ok(pending);
  pending.commit();
  assert.deepEqual(discarded, ["/tmp/turn-scoped"]);
});

test("stop() discards deferred facts as well as queued ones", async () => {
  const discarded: string[] = [];
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: () => Promise.resolve(),
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
  assert.equal(delivery.peekDeferredContext("owner-drain"), undefined);
});

test("a drain requested while one is in flight runs again after it", async () => {
  // The user's queue gives up an idle edge the peer phase already deferred
  // to: returning the drain in flight would leave that peer with no edge.
  let peerPasses = 0;
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => (releaseFirst = resolve));
  const delivery = new BackgroundCompletionDelivery({
    drainPeers: async () => {
      peerPasses += 1;
      if (peerPasses === 1) await first;
    },
    offer: () => Promise.resolve("delivered"),
  });

  void delivery.drain("owner-rerun");
  await flush();
  void delivery.requestDrain("owner-rerun");
  assert.equal(peerPasses, 1);
  releaseFirst();
  for (let i = 0; i < 20 && peerPasses < 2; i += 1) await flush();
  assert.equal(peerPasses, 2);
});
