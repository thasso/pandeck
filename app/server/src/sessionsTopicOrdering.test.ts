/**
 * V12: what a command sends relative to its rows' `sessions` events
 * (`docs/session-list.md`, "Republishing a row"). A refusal re-sends the
 * authoritative row before its `error`, a route reply follows the new row's
 * event, and a placement's events precede its `mutationSettled`. Also the
 * server half of V10: a failed archived read answers its `requestId`.
 *   pnpm --filter @assistant/server test src/sessionsTopicOrdering.test.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { hub } from "./hub.ts";
import { backgroundWorkStore } from "./db/backgroundWorkStore.ts";
import { peerPromptStore } from "./db/peerPromptStore.ts";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";
import { sessionStore } from "./db/sessionStore.ts";
import * as list from "./harnesses/sessionList.ts";
import { harnessRegistry } from "./harnesses/registry.ts";
import { sessionListClient } from "./test/sessionListClient.ts";

let serial = 0;
function seed(
  label: string,
  agentType: "assistant" | "personal-assistant" = "assistant",
): string {

  const id = `ordering-${label}-${++serial}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType,
    title: id,
    messageCount: 2,
  });
  return id;
}

const flush = () => hub.flushPendingBroadcastsForTests();

/** Index of the first `sessions` event batch naming `id`, or -1. */
function eventAt(sent: readonly ServerMessage[], id: string): number {
  return sent.findIndex(
    (message) =>
      message.type === "stateEvents" &&
      message.topic === "sessions" &&
      message.events.some((event) => event.id === id),
  );
}
const typeAt = (sent: readonly ServerMessage[], type: ServerMessage["type"]) =>
  sent.findIndex((message) => message.type === type);

afterEach(async () => {
  vi.restoreAllMocks();
  await flush();
});

test("a blocked settle sends the row before the error", async () => {
  const [coordinator, peer] = [seed("settle-root"), seed("settle-peer")];
  sessionStore.linkSpawned(coordinator, peer);
  sessionStore.recordSessionOutcome(coordinator, "completed");
  const chainId = peerPromptStore.createChain(`ordering-chain-${serial}`);
  peerPromptStore.enqueue({
    conversationId: `ordering-conv-${serial}`,
    chainId,
    hop: peerPromptStore.reserveHop(chainId),
    senderSessionId: coordinator,
    recipientSessionId: peer,
    prompt: "keep going",
    responseRequested: false,
  });
  const client = sessionListClient();
  try {
    await flush();
    client.clear();
    await client.connection.handle({
      type: "settleSession",
      id: coordinator,
      settled: true,
      throughRevision: 1,
      requestId: "req-ordering-settle",
    } as ClientMessage);
    const error = typeAt(client.sent, "error");
    assert.ok(error >= 0, "the settle was refused");
    const row = eventAt(client.sent, coordinator);
    assert.ok(row >= 0 && row < error, "the row came first");
  } finally {
    peerPromptStore.cancelPending(peer, "test cleanup");
    client.close();
  }
});

test("a refused delete sends the row before the error", async () => {
  const id = seed("delete");
  const client = sessionListClient();
  await flush();
  client.clear();
  vi.spyOn(backgroundWorkStore, "deleteOwnerSession").mockImplementation(() => {
    throw new Error("injected delete failure");
  });
  await client.connection.handle({ type: "deleteSession", id });
  const error = typeAt(client.sent, "error");
  assert.ok(error >= 0, "the delete was refused");
  const row = eventAt(client.sent, id);
  assert.ok(row >= 0 && row < error, "the row came first");
  assert.ok(client.row(id), "and the client still lists it");
  client.close();
});

test("a stale failure dismissal sends the newer row before the error", async () => {
  const id = seed("dismiss");
  sessionStore.recordRunFailure(id, "boom", 5_000);
  sessionStore.recordSessionOutcome(id, "failed", 5_001);
  sessionStore.recordRunFailure(id, "again", 6_000);
  sessionStore.recordSessionOutcome(id, "failed", 6_001);
  const client = sessionListClient();
  await flush();
  client.clear();
  await client.connection.handle({
    type: "dismissSessionFailure",
    id,
    errorAt: 5_000,
    outcomeRevision: 1,
  } as ClientMessage);
  const error = typeAt(client.sent, "error");
  assert.ok(error >= 0, "the click is told");
  const row = eventAt(client.sent, id);
  assert.ok(row >= 0 && row < error, "the row came first");
  assert.equal(client.row(id)?.lastError?.message, "again");
  client.close();
});

test("a draft reply follows its new row's event", async () => {
  const client = sessionListClient();
  await flush();
  client.clear();
  await client.connection.handle({
    type: "createDraftSession",
    agentType: "assistant",
    draftText: "draft",
  } as ClientMessage);
  const reply = client.sent.find(
    (m): m is Extract<ServerMessage, { type: "draftSession" }> =>
      m.type === "draftSession",
  );
  assert.ok(reply, "the draft opened");
  const id = reply.state.sessionId!;
  const row = eventAt(client.sent, id);
  assert.ok(row >= 0 && row < client.sent.indexOf(reply), "the row came first");
  assert.ok(client.row(id), "so the route names a listed session");
  client.close();
});

test("permanentAssistantOpened follows the singleton's pending event", async () => {
  vi.spyOn(harnessRegistry, "cwdForSession").mockReturnValue(
    join(process.env.ASSISTANT_CWD!, "data", "personal-assistant"),
  );
  const previous = permanentAssistantStore.sessionId();
  const client = sessionListClient();
  try {
    await flush();
    client.clear();
    // Not flushed: the singleton's touches are pending when the open runs.
    const id = seed("singleton", "personal-assistant");
    permanentAssistantStore.setSessionId(id);
    await client.connection.handle({ type: "openPermanentAssistant" });
    const reply = typeAt(client.sent, "permanentAssistantOpened");
    assert.ok(reply >= 0, "the assistant opened");
    const row = eventAt(client.sent, id);
    assert.ok(row >= 0 && row < reply, "its event came first");
    assert.equal(client.row(id), undefined, "as a delete: never listed");
    await client.connection.handle({
      type: "releasePermanentAssistant",
      sessionId: id,
    });
  } finally {
    if (previous) permanentAssistantStore.setSessionId(previous);
    else permanentAssistantStore.clearSessionId();
    client.close();
  }
});

test("an inbox placement sends its sessions' events, then mutationSettled", async () => {
  const [first, second] = [seed("place-a"), seed("place-b")];
  const client = sessionListClient();
  await flush();
  client.clear();
  await client.connection.handle({
    type: "setInboxPositions",
    positions: [
      { kind: "session", id: first, position: 2 },
      { kind: "session", id: second, position: 1 },
    ],
    requestId: "req-ordering-place",
  } as ClientMessage);
  const settled = client.sent.findIndex(
    (m) => m.type === "mutationSettled" && m.requestId === "req-ordering-place",
  );
  assert.ok(settled >= 0);
  for (const id of [first, second]) {
    const row = eventAt(client.sent, id);
    assert.ok(row >= 0 && row < settled, `${id} came first`);
  }
  client.close();
});

test("a failed archived read answers an error with the read's requestId", async () => {
  const client = sessionListClient();
  await flush();
  client.clear();
  vi.spyOn(list, "mergedSessionList").mockImplementation(() => {
    throw new Error("injected archive build failure");
  });
  await client.connection.handle({
    type: "loadArchivedSessions",
    requestId: "req-archive-1",
  } as ClientMessage);
  const answers = client.sent.filter(
    (m) =>
      m.type === "archivedSessions" ||
      (m.type === "error" && m.requestId === "req-archive-1"),
  );
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.type, "error");
  assert.match(
    (answers[0] as Extract<ServerMessage, { type: "error" }>).message,
    /Failed to load archived sessions: injected/,
  );
  client.close();
});
