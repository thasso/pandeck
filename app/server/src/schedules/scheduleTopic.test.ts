/**
 * The `schedules` topic end to end on the server: store writes publish
 * revisioned upserts, a delete publishes at its tombstone's revision, and a
 * subscribe (snapshot or digest) and `getStateItems` answer through the kernel.
 *   pnpm --filter @assistant/server exec vitest run src/schedules/scheduleTopic.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type {
  BroadcastTopic,
  ServerMessage,
  StateEvent,
} from "@assistant/shared";
import type {
  ScheduleSummary,
  ScheduleTiming,
} from "@assistant/shared/schedules";
import { Connection } from "../connection.ts";
import { scheduleStore } from "../db/scheduleStore.ts";
import { hub } from "../hub.ts";
import { stateTopicFor } from "../stateTopics.ts";
import { validateClientMessage } from "../validateClientMessage.ts";

const DEC1 = Date.parse("2026-12-01T09:00:00Z");
const GRACE = { graceMs: 60 * 60_000, paused: false };

let seq = 0;
function create(
  nowMs = DEC1 - 1,
  timing: ScheduleTiming = { kind: "daily", time: "09:00", timeZone: "UTC" },
): ScheduleSummary {
  seq += 1;
  return scheduleStore.create(
    {
      name: `Topic ${seq}`,
      prompt: `Topic prompt ${seq}`,
      timing,
      target: { kind: "session", sessionId: `topic-target-${seq}` },
      createdBy: { kind: "user" },
      cardless: false,
    },
    nowMs,
  );
}

interface ConnectionHandlers {
  onSubscribe(topics: BroadcastTopic[], digests?: BroadcastTopic[]): void;
  onGetStateItems(topic: "schedules", ids: string[], requestId: string): void;
}

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => ConnectionHandlers
  )(fakeWs);
  return { connection, sent };
}

function scheduleEvents(
  messages: ServerMessage[],
): StateEvent<ScheduleSummary>[] {
  return messages.flatMap((message) =>
    message.type === "stateEvents" && message.topic === "schedules"
      ? message.events
      : [],
  );
}

test("Schedule writes publish revisioned upserts, and a delete at its tombstone's revision", async () => {
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "schedules",
  };
  hub.register(viewer);
  try {
    const schedule = create();
    await hub.flushPendingBroadcastsForTests();
    const [created] = scheduleEvents(messages);
    assert.ok(created?.kind === "upsert" && created.id === schedule.id);
    assert.deepEqual(created.item, schedule);
    assert.equal(created.revision, scheduleStore.revision(schedule.id));

    // A claim is an occurrence change, and it moves the Schedule's revision.
    messages.length = 0;
    scheduleStore.claimDue(schedule.id, DEC1, GRACE);
    await hub.flushPendingBroadcastsForTests();
    const [claimed] = scheduleEvents(messages);
    assert.ok(claimed?.kind === "upsert");
    assert.ok(claimed.revision > created.revision);
    assert.equal(claimed.item.lastOccurrence?.state, "claimed");

    messages.length = 0;
    assert.equal(scheduleStore.delete(schedule.id, DEC1 + 1), true);
    await hub.flushPendingBroadcastsForTests();
    const [deleted] = scheduleEvents(messages);
    assert.ok(deleted?.kind === "delete" && deleted.id === schedule.id);
    assert.ok(deleted.revision > claimed.revision);
    assert.equal(deleted.revision, scheduleStore.revision(schedule.id));
  } finally {
    hub.unregister(viewer);
  }
});

test("a sweep that finds a disabled Schedule expired publishes it done, and 30 days later its delete (A-F001)", async () => {
  const DAY = 24 * 60 * 60_000;
  const DEC3 = DEC1 + 2 * DAY;
  const schedule = create(DEC1 - 1, {
    kind: "daily",
    time: "09:00",
    timeZone: "UTC",
    endsOn: "2026-12-02",
  });
  scheduleStore.claimDue(schedule.id, DEC1, GRACE);
  scheduleStore.setEnabled(schedule.id, false, DEC1 + 1, GRACE);
  const messages: ServerMessage[] = [];
  const viewer = {
    send: (message: ServerMessage) => messages.push(message),
    wantsTopic: (topic: string) => topic === "schedules",
  };
  hub.register(viewer);
  try {
    await hub.flushPendingBroadcastsForTests();
    messages.length = 0;
    const before = scheduleStore.revision(schedule.id)!;
    scheduleStore.runMaintenance(DEC3);
    await hub.flushPendingBroadcastsForTests();
    const done = scheduleEvents(messages).find(
      (event) => event.id === schedule.id,
    );
    assert.ok(done?.kind === "upsert");
    assert.equal(done.item.doneAtMs, DEC3);
    assert.ok(done.revision > before);

    // A sweep that changes nothing for it publishes nothing for it.
    messages.length = 0;
    scheduleStore.runMaintenance(DEC3 + DAY);
    await hub.flushPendingBroadcastsForTests();
    assert.equal(
      scheduleEvents(messages).some((event) => event.id === schedule.id),
      false,
    );

    scheduleStore.runMaintenance(DEC3 + 30 * DAY);
    await hub.flushPendingBroadcastsForTests();
    const deleted = scheduleEvents(messages).find(
      (event) => event.id === schedule.id,
    );
    assert.ok(deleted?.kind === "delete");
    assert.equal(deleted.revision, scheduleStore.revision(schedule.id));
  } finally {
    hub.unregister(viewer);
  }
});

test("a schedules subscribe answers the snapshot, or the digest when asked", () => {
  const live = create();
  const gone = create();
  scheduleStore.delete(gone.id);
  try {
    const snapshot = makeConnection();
    snapshot.connection.onSubscribe(["schedules"]);
    const list = snapshot.sent.find(
      (message) => message.type === "scheduleList",
    );
    assert.ok(list?.type === "scheduleList");
    assert.equal(list.seq, stateTopicFor("schedules")!.seq());
    assert.ok(list.items.some((item) => item.id === live.id));
    assert.ok(!list.items.some((item) => item.id === gone.id));
    assert.deepEqual(
      list.revisions.find((entry) => entry.id === live.id),
      { id: live.id, revision: scheduleStore.revision(live.id) },
    );
    assert.equal(list.revisions.length, list.items.length);

    const digest = makeConnection();
    digest.connection.onSubscribe(["schedules"], ["schedules"]);
    const answer = digest.sent.find(
      (message) => message.type === "stateDigest",
    );
    assert.ok(answer?.type === "stateDigest" && answer.topic === "schedules");
    assert.deepEqual(answer.entries, list.revisions);
    assert.ok(!digest.sent.some((message) => message.type === "scheduleList"));
  } finally {
    scheduleStore.delete(live.id);
  }
});

test("schedules getStateItems upserts members, deletes tombstones and omits unknown ids", () => {
  const live = create();
  const gone = create();
  scheduleStore.delete(gone.id);
  try {
    const { connection, sent } = makeConnection();
    connection.onGetStateItems(
      "schedules",
      [live.id, gone.id, "sch_unknown"],
      "items-1",
    );
    const answer = sent.find((message) => message.type === "stateItems");
    assert.ok(answer?.type === "stateItems" && answer.topic === "schedules");
    assert.equal(answer.requestId, "items-1");
    assert.deepEqual(
      answer.events.map((event) => [event.id, event.kind, event.revision]),
      [
        [live.id, "upsert", scheduleStore.revision(live.id)],
        [gone.id, "delete", scheduleStore.revision(gone.id)],
      ],
    );
  } finally {
    scheduleStore.delete(live.id);
  }
});

test("the client validator admits schedules digests and item reads", () => {
  const subscribe = validateClientMessage({
    type: "subscribe",
    topics: ["schedules"],
    digests: ["schedules"],
  });
  assert.equal(subscribe.ok, true, JSON.stringify(subscribe));
  const items = validateClientMessage({
    type: "getStateItems",
    topic: "schedules",
    ids: ["sch_1"],
    requestId: "r1",
  });
  assert.equal(items.ok, true, JSON.stringify(items));
});
