/**
 * V9: a peer request crossing its reply deadline (`docs/session-list.md`,
 * "Deadline watermark"). Fake time, the production sweep off, retention run
 * only where a step says so. Every step asserts the sink's touched ids and the
 * rows a viewer was sent separately: every touched id is published, and an
 * untouched one is not.
 *   pnpm --filter @assistant/server test src/sessionListDeadline.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { ServerMessage, SessionListItem } from "@assistant/shared";
import { hub } from "./hub.ts";
import { getDb } from "./db/index.ts";
import {
  DUE_DEADLINE_PARTICIPANTS_SQL,
  advancePeerDeadlines,
  armedPeerDeadlineForTests,
  deadlineWatermark,
  resetPeerDeadlineClockForTests,
  startPeerDeadlineClock,
} from "./db/peerDeadlineClock.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { runPeerPromptRetention } from "./peerPrompt.ts";
import { getSettings, updateSettings } from "./settings.ts";
import {
  recordSessionRowTouches,
  type SessionRowTouchRecorder,
} from "./test/sessionRowTouches.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
let serial = 0;
let sent: ServerMessage[] = [];
const viewer = {
  send: (message: ServerMessage) => sent.push(message),
  wantsTopic: (topic: string) => topic === "sessions",
};
let touches: SessionRowTouchRecorder | undefined;
let reminderLimit: number;

beforeEach(async () => {
  // Past every deadline an earlier test left behind (see afterEach), so each
  // test arms only its own.
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout"],
    now: Math.max(Date.now(), deadlineWatermark()) + MINUTE,
  });
  // The clock restarts on the fake timers, as at boot.
  resetPeerDeadlineClockForTests(Date.now());
  startPeerDeadlineClock();
  reminderLimit = getSettings().sessionPeerPromptReminderLimit;
  hub.register(viewer);
  await hub.flushPendingBroadcastsForTests();
});

afterEach(async () => {
  touches?.stop();
  touches = undefined;
  hub.unregister(viewer);
  updateSettings({ sessionPeerPromptReminderLimit: reminderLimit });
  advancePeerDeadlines(Date.now() + 31 * DAY);
  await hub.flushPendingBroadcastsForTests();
  vi.useRealTimers();
  resetPeerDeadlineClockForTests(Math.max(Date.now(), deadlineWatermark()));
  startPeerDeadlineClock();
  await hub.flushPendingBroadcastsForTests();
});

function seed(label: string): string {
  serial += 1;
  const id = `dl-${label}-${serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: `${label} ${serial}`,
    scope: "user",
    messageCount: 2,
  });
  return id;
}

function request(sender: string, recipient: string, expiresAt: number) {
  const chainId = peerPromptStore.createChain(`dl-${++serial}`);
  return peerPromptStore.enqueue({
    conversationId: `dl-conv-${serial}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: sender,
    recipientSessionId: recipient,
    prompt: "report back",
    responseRequested: true,
    expiresAt,
  });
}

/** Claimed and admitted: the recipient's turn has it. */
function admitted(sender: string, recipient: string, expiresAt: number) {
  const r = request(sender, recipient, expiresAt);
  peerPromptStore.claimNext(recipient, "d", 1000);
  peerPromptStore.markAdmitted(r.id);
  return r;
}

/**
 * `sender` owed by `recipient` through a `replied` row whose reply was
 * cancelled before admission (`db/peerPromptStore.test.ts`, lost reply).
 */
function lostReply(sender: string, recipient: string, request: { id: string }) {
  const chainId = peerPromptStore.createChain(`dl-reply-${++serial}`);
  peerPromptStore.enqueueRouted({
    conversationId: `dl-reply-${serial}`,
    chainId,
    fallbackChainId: `dl-fb-${serial}`,
    senderSessionId: recipient,
    recipientSessionId: sender,
    prompt: "report",
    responseRequested: false,
    markRepliedIds: [request.id],
    participants: [recipient, sender],
    maxHops: 100,
  });
  peerPromptStore.cancelPending(sender, "test", recipient);
}

async function rows(): Promise<Map<string, SessionListItem>> {
  const list = await hub.listSessions({ includeArchived: true });
  return new Map(list.map((row) => [row.id, row as SessionListItem]));
}

const owes = async (sender: string, recipient: string) =>
  (await rows())
    .get(sender)
    ?.awaitingRepliesFrom?.some(
      (entry) =>
        entry === recipient || (entry as { id?: string }).id === recipient,
    ) ?? false;

const unansweredFrom = async (recipient: string, sender: string) =>
  JSON.stringify(
    (await rows()).get(recipient)?.unansweredRequestsFrom ?? [],
  ).includes(sender);

/** Drain the pending flush, then start recording touches and sent rows. */
async function baseline(): Promise<SessionRowTouchRecorder> {
  await hub.flushPendingBroadcastsForTests();
  sent = [];
  touches?.stop();
  touches = recordSessionRowTouches();
  return touches;
}

function sentRows(): Set<string> {
  const ids = new Set<string>();
  for (const message of sent) {
    if (message.type === "stateEvents" && message.topic === "sessions")
      for (const event of message.events) ids.add(event.id);
    if (message.type === "sessionList") ids.add("<full list>");
  }
  return ids;
}

/**
 * Run timers up to the armed deadline's fire. `vi.setSystemTime` moves the
 * wall clock without bringing a timer forward, so this advances timer by
 * timer rather than to the target time.
 */
async function fireDeadlineTimer(): Promise<void> {
  const target = armedPeerDeadlineForTests();
  assert.ok(target !== undefined, "a deadline timer is armed");
  await hub.flushPendingBroadcastsForTests();
  const w = deadlineWatermark();
  for (
    let i = 0;
    i < 10 &&
    deadlineWatermark() === w &&
    armedPeerDeadlineForTests() === target;
    i++
  )
    await vi.advanceTimersToNextTimerAsync();
}

describe("an owed request crossing its deadline", () => {
  test("only the timer moves it, touching its participants first; retention then changes nothing", async () => {
    updateSettings({ sessionPeerPromptReminderLimit: 1 });
    const [a, b, c, d] = [seed("a"), seed("b"), seed("c"), seed("d")];
    const deadline = Date.now() + 10 * MINUTE;
    // 1 (a): A owed by B through a lost reply.
    const toB = admitted(a, b, deadline);
    peerPromptStore.markCompleted(toB.id);
    lostReply(a, b, toB);
    // 1 (b): A→C awaiting a response, reminded to the limit.
    const toC = admitted(a, c, deadline);
    peerPromptStore.markCompleted(toC.id);
    peerPromptStore.markReminded([toC.id]);
    assert.ok(await owes(a, b), "A waits on B");
    assert.ok(await owes(a, c), "A waits on C");
    assert.ok(await unansweredFrom(c, a), "C has A's unanswered request");
    const recorder = await baseline();

    // 2: the wall clock passes both deadlines; no timer runs.
    vi.setSystemTime(deadline + MINUTE);
    sessionStore.markRead(d, Date.now());
    await hub.flushPendingBroadcastsForTests();
    assert.deepEqual([...recorder.ids()], [d]);
    assert.deepEqual([...sentRows()], [d]);
    assert.ok(await owes(a, b), "W unchanged: A still waits on B");
    assert.ok(await owes(a, c), "W unchanged: A still waits on C");
    assert.ok(await unansweredFrom(c, a));

    // 3: the timer fires.
    recorder.clear();
    sent = [];
    await fireDeadlineTimer();
    assert.deepEqual(
      recorder.touches,
      [[a, b, c].sort()],
      "one synchronous touch",
    );
    await hub.flushPendingBroadcastsForTests();
    assert.ok(deadlineWatermark() > deadline);
    assert.equal(await owes(a, b), false);
    assert.equal(await owes(a, c), false);
    assert.equal(await unansweredFrom(c, a), false);
    const afterFire = sentRows();
    assert.ok(
      afterFire.has(a) && afterFire.has(c),
      "A's and C's rows went out",
    );
    // B was touched, so it is published again although its row is equal.
    assert.ok(afterFire.has(b));
    assert.equal(afterFire.has(d), false);

    // 4: retention expires the awaiting row; no row content changes.
    recorder.clear();
    sent = [];
    runPeerPromptRetention(Date.now());
    assert.equal(peerPromptStore.getById(toC.id)?.status, "expired");
    assert.ok(recorder.ids().has(a) && recorder.ids().has(c));
    await hub.flushPendingBroadcastsForTests();
    // Touched ids are published again, value-equal; nothing else is.
    assert.deepEqual([...sentRows()].sort(), [...recorder.ids()].sort());
    recorder.clear();
    sent = [];
    runPeerPromptRetention(Date.now());
    await hub.flushPendingBroadcastsForTests();
    assert.deepEqual(recorder.touches, []);
    assert.deepEqual([...sentRows()], []);
  });
});

describe("a request that becomes owed after an earlier fire", () => {
  for (const variant of ["completed", "stopped", "lost reply"] as const)
    test(`${variant}: the timer alone ends it at its unchanged deadline`, async () => {
      const [a, e, f, g] = [seed("a"), seed("e"), seed("f"), seed("g")];
      const d1 = Date.now() + 5 * MINUTE;
      const d2 = Date.now() + 10 * MINUTE;
      // 5: R is still queued when the earlier deadline fires.
      const r = request(a, e, d2);
      assert.equal(peerPromptStore.getById(r.id)?.status, "queued");
      const s = admitted(f, g, d1);
      peerPromptStore.markCompleted(s.id);
      assert.equal(armedPeerDeadlineForTests(), d1);
      const recorder = await baseline();
      await fireDeadlineTimer();
      assert.deepEqual(recorder.touches, [[f, g].sort()]);
      assert.equal(
        armedPeerDeadlineForTests(),
        d2,
        "R is scheduled while queued",
      );

      peerPromptStore.claimNext(e, "d", 1000);
      peerPromptStore.markAdmitted(r.id);
      if (variant === "stopped") peerPromptStore.markStopped(r.id);
      else peerPromptStore.markCompleted(r.id);
      if (variant === "lost reply") lostReply(a, e, r);
      assert.equal(peerPromptStore.getById(r.id)?.expiresAt, d2);
      assert.ok(await owes(a, e), "A waits on E");
      await baseline();

      await fireDeadlineTimer();
      assert.ok(touches!.ids().has(a) && touches!.ids().has(e));
      assert.equal(deadlineWatermark(), Date.now(), "W is the fire time");
      assert.ok(deadlineWatermark() >= d2);
      await hub.flushPendingBroadcastsForTests();
      assert.equal(await owes(a, e), false);
      assert.ok(sentRows().has(a));
    });
});

describe("arming", () => {
  test("a 30-day deadline arms a clamped timer whose early fires only re-arm", async () => {
    const [a, b] = [seed("a"), seed("b")];
    const deadline = Date.now() + 30 * DAY;
    owedAt(a, b, deadline);
    assert.equal(armedPeerDeadlineForTests(), deadline);
    const recorder = await baseline();
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    assert.ok(Date.now() < deadline);
    assert.deepEqual(recorder.touches, [], "an early fire touches nothing");
    assert.equal(armedPeerDeadlineForTests(), deadline, "and re-arms");
    await fireDeadlineTimer();
    assert.deepEqual(recorder.touches, [[a, b].sort()]);
  });

  test("an earlier deadline, inserted or patched onto a held row, re-arms earlier", async () => {
    const [a, b, c] = [seed("a"), seed("b"), seed("c")];
    const late = Date.now() + 20 * MINUTE;
    request(a, b, late);
    assert.equal(armedPeerDeadlineForTests(), late);
    const earlier = Date.now() + 10 * MINUTE;
    request(a, c, earlier);
    assert.equal(armedPeerDeadlineForTests(), earlier);

    const chainId = peerPromptStore.createChain(`dl-held-${++serial}`);
    const heldRow = peerPromptStore.enqueueRouted({
      conversationId: `dl-held-${serial}`,
      chainId,
      fallbackChainId: `dl-held-fb-${serial}`,
      senderSessionId: a,
      recipientSessionId: c,
      prompt: "start",
      responseRequested: true,
      participants: [a, c],
      maxHops: 100,
      held: { queueSeq: peerPromptStore.allocateQueueSeq() },
    });
    const earliest = Date.now() + 5 * MINUTE;
    peerPromptStore.promoteHeld(heldRow.id, earliest);
    assert.equal(armedPeerDeadlineForTests(), earliest);
  });

  test("a failed advance keeps W and retries after 60 s", async () => {
    const [a, b] = [seed("a"), seed("b")];
    const deadline = Date.now() + MINUTE;
    owedAt(a, b, deadline);
    const recorder = await baseline();
    const before = deadlineWatermark();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = getDb();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql === DUE_DEADLINE_PARTICIPANTS_SQL) throw new Error("disk I/O");
      return prepare(sql);
    });
    await fireDeadlineTimer();
    assert.equal(deadlineWatermark(), before, "W stays put");
    assert.deepEqual(recorder.touches, []);
    assert.ok(
      warn.mock.calls.some((call) =>
        String(call[0]).includes("advancing peer reply deadlines failed"),
      ),
    );
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(60_000);
    assert.deepEqual(recorder.touches, [[a, b].sort()]);
    assert.ok(deadlineWatermark() > deadline);
  });
});

describe("the watermark", () => {
  test("never moves backwards with the wall clock", async () => {
    const [a, b] = [seed("a"), seed("b")];
    const deadline = Date.now() + MINUTE;
    owedAt(a, b, deadline);
    await fireDeadlineTimer();
    await hub.flushPendingBroadcastsForTests();
    assert.equal(await owes(a, b), false);
    const w = deadlineWatermark();
    const recorder = await baseline();
    vi.setSystemTime(w - 10 * MINUTE);
    advancePeerDeadlines();
    assert.equal(deadlineWatermark(), w);
    assert.deepEqual(recorder.touches, []);
    assert.equal(await owes(a, b), false, "a request past W stays not owed");
  });
});

function owedAt(sender: string, recipient: string, deadline: number) {
  const r = admitted(sender, recipient, deadline);
  peerPromptStore.markCompleted(r.id);
  return r;
}
