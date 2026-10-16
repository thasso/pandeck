/**
 * The `initiatives` topic over the socket: a cold subscribe answers the live
 * snapshot with its revision sidecar, a warm one the digest, `getStateItems`
 * catches up after a diff, and `getInitiative` answers the graph with the
 * revision it is as of and the layout that draws it. Every message passes the
 * client validator first.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  INITIATIVE_LAYOUT_COLLAPSE_LIMIT,
  type BroadcastTopic,
  type ClientMessage,
  type ServerMessage,
} from "@assistant/shared";
import { Connection } from "./connection.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import {
  archiveInitiative,
  createInitiative,
  initiativeRevision,
} from "./initiatives.ts";
import { stopInitiativeLayoutWorker } from "./initiativeLayoutRunner.ts";
import { createTask } from "./tasks.ts";

afterAll(() => stopInitiativeLayoutWorker());

interface ConnectionHandlers {
  onSubscribe(topics: BroadcastTopic[], digests?: BroadcastTopic[]): void;
  onGetStateItems(topic: "initiatives", ids: string[], requestId: string): void;
  onGetInitiative(
    id: string,
    requestId: string,
    collapsed?: readonly string[],
  ): Promise<void>;
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

/** Round-trip a client message through JSON and the validator. */
function valid(message: ClientMessage): ClientMessage {
  const parsed = JSON.parse(JSON.stringify(message)) as ClientMessage;
  const verdict = validateClientMessage(parsed);
  assert.ok(verdict.ok, `rejected: ${JSON.stringify(verdict)}`);
  return parsed;
}

test("subscribe, digest, items and the keyed graph read round-trip", async () => {
  const epic = createTask({
    title: "Wire epic",
    source: { createdBy: "user" },
  });
  const step = createTask({
    title: "Wire step",
    source: { createdBy: "user" },
    parentId: epic.id,
  });
  const live = createInitiative({
    title: "Wire live",
    taskIds: [epic.id],
  }).initiative;
  const archived = createInitiative({ title: "Wire archived" }).initiative;
  archiveInitiative(String(archived.id));
  const liveId = String(live.id);
  const archivedId = String(archived.id);

  valid({ type: "subscribe", topics: ["initiatives"] });
  const cold = makeConnection();
  cold.connection.onSubscribe(["initiatives"]);
  const snapshot = cold.sent.find(
    (message) => message.type === "initiativeList",
  );
  assert.ok(snapshot?.type === "initiativeList");
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    [liveId],
    "the snapshot is the live projection",
  );
  assert.deepEqual(snapshot.revisions, [
    { id: liveId, revision: initiativeRevision(liveId)! },
  ]);
  assert.equal(snapshot.items[0]!.progress.total, 2);

  valid({
    type: "subscribe",
    topics: ["initiatives"],
    digests: ["initiatives"],
  });
  const warm = makeConnection();
  warm.connection.onSubscribe(["initiatives"], ["initiatives"]);
  const digest = warm.sent.find((message) => message.type === "stateDigest");
  assert.ok(digest?.type === "stateDigest" && digest.topic === "initiatives");
  assert.deepEqual(
    digest.entries.map((entry) => entry.id),
    [liveId],
  );

  const items = valid({
    type: "getStateItems",
    topic: "initiatives",
    ids: [liveId, archivedId],
    requestId: "items-1",
  });
  assert.ok(items.type === "getStateItems");
  warm.connection.onGetStateItems("initiatives", items.ids, items.requestId);
  const answer = warm.sent.find((message) => message.type === "stateItems");
  assert.ok(answer?.type === "stateItems" && answer.topic === "initiatives");
  assert.deepEqual(
    answer.events.map((event) => [event.id, event.kind]),
    [
      [liveId, "upsert"],
      [archivedId, "delete"],
    ],
  );

  valid({ type: "getInitiative", id: liveId, requestId: "graph-1" });
  await warm.connection.onGetInitiative(liveId, "graph-1");
  await warm.connection.onGetInitiative("424242", "graph-2");
  const collapse = valid({
    type: "getInitiative",
    id: liveId,
    requestId: "graph-3",
    collapsed: [epic.id],
  });
  assert.ok(collapse.type === "getInitiative");
  await warm.connection.onGetInitiative(
    liveId,
    collapse.requestId,
    collapse.collapsed,
  );
  const details = warm.sent.filter(
    (message) => message.type === "initiativeDetail",
  );
  const found = details[0];
  assert.ok(found?.type === "initiativeDetail");
  assert.equal(found.requestId, "graph-1");
  assert.equal(found.revision, initiativeRevision(liveId));
  assert.deepEqual(
    found.item?.nodes.map((node) => node.id),
    [epic.id, step.id],
  );
  assert.deepEqual(
    found.layout?.nodes.map((node) => [node.id, node.laneId]),
    [
      [epic.id, epic.id],
      [step.id, epic.id],
    ],
  );
  assert.equal(found.layoutError, undefined);
  assert.equal(found.layoutTooLarge, undefined);
  const missing = details[1];
  assert.ok(missing?.type === "initiativeDetail");
  assert.equal(missing.item, null);
  assert.equal(missing.revision, undefined);
  assert.equal(missing.layout, undefined);
  const collapsed = details[2];
  assert.ok(collapsed?.type === "initiativeDetail");
  assert.deepEqual(collapsed.layout?.collapsed, [epic.id]);
  assert.deepEqual(
    collapsed.layout?.nodes.map((node) => [node.kind, node.hiddenTaskIds]),
    [["collapsed", [step.id]]],
  );
  assert.equal(collapsed.layout?.nodes[0]!.progress?.total, 1);
  assert.notEqual(collapsed.layout?.key, found.layout?.key);
});

test("the validator refuses an unknown state-items topic", () => {
  const verdict = validateClientMessage({
    type: "getStateItems",
    topic: "sessions",
    ids: [],
    requestId: "x",
  });
  assert.equal(verdict.ok, false);
  assert.equal(
    validateClientMessage({ type: "getInitiative", requestId: "x" }).ok,
    false,
  );
});

test("the validator bounds a map's collapsed epics", () => {
  const read = (collapsed: unknown) =>
    validateClientMessage({
      type: "getInitiative",
      id: "1",
      requestId: "x",
      collapsed,
    }).ok;
  assert.equal(read(["12", "13"]), true);
  assert.equal(
    read(Array.from({ length: INITIATIVE_LAYOUT_COLLAPSE_LIMIT }, String)),
    true,
  );
  assert.equal(
    read(Array.from({ length: INITIATIVE_LAYOUT_COLLAPSE_LIMIT + 1 }, String)),
    false,
  );
  assert.equal(read([""]), false);
  assert.equal(read(["x".repeat(33)]), false);
  assert.equal(read([12]), false);
  assert.equal(read("12"), false);
});
