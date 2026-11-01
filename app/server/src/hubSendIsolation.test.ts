/**
 * One connection whose `send` throws neither stops the hub's topic broadcast
 * or singleton-unread publication to the others nor goes unnoticed, and a
 * kernel frame it failed stays pending at its revision (`docs/state-sync.md`,
 * Server contract).
 *   pnpm --filter @assistant/server exec vitest run src/hubSendIsolation.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";
import type { Viewer } from "./harness.ts";
import { hub } from "./hub.ts";
import { updateProject, upsertProject } from "./projectRegistry.ts";

const internals = hub as unknown as {
  broadcastTopic(topic: BroadcastTopic, message: ServerMessage): void;
  publishPermanentAssistantUnread(unread: boolean): void;
  lastPermanentAssistantUnread: boolean | undefined;
};

const registered: Viewer[] = [];

/** A connection holding `topics`, recording what it was sent. */
function viewer(topics: readonly BroadcastTopic[]) {
  const sent: ServerMessage[] = [];
  const connection: Viewer = {
    send: (message) => {
      sent.push(message);
    },
    wantsTopic: (topic) => topics.includes(topic),
  };
  hub.register(connection);
  registered.push(connection);
  return { connection, sent };
}

afterEach(() => {
  for (const connection of registered.splice(0)) hub.unregister(connection);
  internals.lastPermanentAssistantUnread = undefined;
  vi.restoreAllMocks();
});

test("a topic broadcast tries every holder, then throws the failures together", () => {
  const failing = viewer(["usage"]);
  const holder = viewer(["usage"]);
  const other = viewer(["tasks"]);
  vi.spyOn(failing.connection, "send").mockImplementation(() => {
    throw new Error("socket closed");
  });
  const message: ServerMessage = { type: "usageIndicators", indicators: [] };
  assert.throws(
    () => internals.broadcastTopic("usage", message),
    (err: unknown) =>
      err instanceof AggregateError &&
      err.errors.length === 1 &&
      /usageIndicators: 1 connection\(s\) failed: socket closed/.test(
        err.message,
      ),
  );
  assert.deepEqual(holder.sent, [message]);
  assert.deepEqual(other.sent, []);
});

test("a kernel frame one connection failed reaches the others and republishes at its revision", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const suffix = Math.random().toString(36).slice(2, 8);
  const [first, second] = [`isolation-a-${suffix}`, `isolation-b-${suffix}`];
  const failing = viewer(["projects"]);
  const holder = viewer(["projects"]);
  const projectEvents = (sent: ServerMessage[]) =>
    sent.flatMap((message) =>
      message.type === "stateEvents" && message.topic === "projects"
        ? message.events.map((event) => [event.id, event.revision] as const)
        : [],
    );
  const send = vi
    .spyOn(failing.connection, "send")
    .mockImplementationOnce(() => {
      throw new Error("one-shot send failure");
    });

  // The write commits; its publication failure never reaches the writer.
  upsertProject({ id: first, name: "Isolation", key: `IA${suffix}` });
  await hub.flushPendingBroadcastsForTests();
  const published = projectEvents(holder.sent);
  assert.deepEqual(
    published.map(([id]) => id),
    [first],
  );
  assert.deepEqual(projectEvents(failing.sent), []);
  assert.equal(send.mock.calls.length, 1);

  // The failed id rides the next ordinary report, at its same revision.
  upsertProject({ id: second, name: "Isolation 2", key: `IB${suffix}` });
  await hub.flushPendingBroadcastsForTests();
  for (const sent of [failing.sent, holder.sent]) {
    const [republished, next] = projectEvents(sent).slice(-2);
    assert.deepEqual(republished, published[0]);
    assert.equal(next?.[0], second);
  }

  // Delivered: nothing is retained any more.
  updateProject(second, { name: "Isolation 2b" });
  await hub.flushPendingBroadcastsForTests();
  assert.deepEqual(
    projectEvents(holder.sent)
      .slice(-1)
      .map(([id]) => id),
    [second],
  );
});

test("the singleton unread reaches every other connection and advances only when all took it", () => {
  const failing = viewer([]);
  const holder = viewer([]);
  const unread = (sent: ServerMessage[]) =>
    sent.flatMap((message) =>
      message.type === "permanentAssistantUnread" ? [message.unread] : [],
    );
  vi.spyOn(failing.connection, "send").mockImplementationOnce(() => {
    throw new Error("one-shot send failure");
  });

  assert.throws(
    () => internals.publishPermanentAssistantUnread(true),
    AggregateError,
  );
  assert.deepEqual(unread(holder.sent), [true]);
  assert.equal(internals.lastPermanentAssistantUnread, undefined);

  // Not spent: the next publication of the same value goes out again.
  internals.publishPermanentAssistantUnread(true);
  assert.deepEqual(unread(failing.sent), [true]);
  assert.deepEqual(unread(holder.sent), [true, true]);
  assert.equal(internals.lastPermanentAssistantUnread, true);

  internals.publishPermanentAssistantUnread(true);
  assert.deepEqual(unread(holder.sent), [true, true]);
});
