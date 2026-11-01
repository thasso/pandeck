import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import type { WebSocket } from "ws";
import type { ClientMessage } from "@assistant/shared";
import { attachClientMessageSocket } from "./clientMessageSocket.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

const subscribe: ClientMessage = {
  type: "subscribe",
  topics: ["sessions", "tasks", "projects"],
  digests: ["tasks", "projects", "sessions"],
};

test("subscribe validation accepts sessions alongside other digest topics", () => {
  assert.equal(validateClientMessage(subscribe).ok, true);
});

test("subscribe digest topics must be supported and a subset of topics", () => {
  assert.deepEqual(
    validateClientMessage({
      type: "subscribe",
      topics: ["sessions"],
      digests: ["background"],
    }),
    {
      ok: false,
      type: "subscribe",
      reason:
        "digests currently supports only tasks, projects, initiatives and sessions",
    },
  );
  assert.deepEqual(
    validateClientMessage({
      type: "subscribe",
      topics: ["tasks"],
      digests: ["sessions"],
    }),
    {
      ok: false,
      type: "subscribe",
      reason: "digests must be a subset of topics",
    },
  );
});

test("session socket admits the multi-topic sessions digest subscribe", () => {
  const ws = new EventEmitter() as EventEmitter & {
    send(source: string): void;
  };
  const sent: unknown[] = [];
  const handled: ClientMessage[] = [];
  ws.send = (source) => sent.push(JSON.parse(source));
  attachClientMessageSocket(ws as unknown as WebSocket, {
    async handle(message) {
      handled.push(message);
    },
  });

  ws.emit("message", Buffer.from(JSON.stringify(subscribe)));

  assert.deepEqual(sent, []);
  assert.deepEqual(handled, [subscribe]);
});
