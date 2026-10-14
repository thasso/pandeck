import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { PermanentAssistantDelivery } from "./permanentAssistant.ts";

let deliveryListener:
  ((delivery: PermanentAssistantDelivery) => Promise<void>) | undefined;

const enqueue = vi.fn();
const seen = new Set<string>();
vi.mock("./permanentAssistant.ts", () => ({
  capturePermanentAssistantResume: () => undefined,
  enqueuePermanentAssistant: (input: { dedupeKey: string }) => {
    seen.add(input.dedupeKey);
    enqueue(input);
  },
  hasPermanentAssistantMessage: (key: string) => seen.has(key),
  permanentAssistantIsBusy: () => false,
  subscribePermanentAssistant: (
    listener: (delivery: PermanentAssistantDelivery) => Promise<void>,
  ) => {
    deliveryListener = listener;
    return () => {
      deliveryListener = undefined;
    };
  },
}));
vi.mock("./slackSettings.ts", () => ({
  getSlackRuntimeSettings: () => ({
    enabled: true,
    accountUserId: "U1",
    botUserId: "UBOT",
  }),
  getSlackToolConfig: () => ({ enabled: true, token: "xoxb-test" }),
}));
vi.mock("./slackSocketMode.ts", () => ({
  slackSocketMode: { subscribe: () => () => undefined },
}));

import {
  handleSlackAssistantEnvelope,
  slackMrkdwn,
  startSlackAssistantChat,
  stopSlackAssistantChat,
} from "./slackAssistantChat.ts";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  enqueue.mockClear();
  seen.clear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  stopSlackAssistantChat();
  vi.useRealTimers();
});

test("authorized private messages get a placeholder and enter the permanent queue once", async () => {
  const methods: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    methods.push(String(input).split("/").pop()!);
    return new Response(JSON.stringify({ ok: true, ts: "200.1" }));
  }) as typeof fetch;
  const envelope = {
    type: "events_api",
    payload: {
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D1",
        user: "U1",
        ts: "100.1",
        text: "Hello",
      },
    },
  };
  await handleSlackAssistantEnvelope(envelope);
  await handleSlackAssistantEnvelope({ ...envelope, envelope_id: "retry" });
  assert.deepEqual(methods, ["chat.postMessage"]);
  assert.equal(enqueue.mock.calls.length, 1);
  assert.equal(enqueue.mock.calls[0]![0].sourceMetadata.placeholderTs, "200.1");
});

test("acknowledges a Slack turn only after its answer reaches Slack", async () => {
  startSlackAssistantChat();
  const acknowledge = vi.fn();
  const delivery: PermanentAssistantDelivery = {
    item: {
      id: 1,
      dedupeKey: "slack-test",
      source: "slack",
      sourceMetadata: { channel: "D1", placeholderTs: "200.1" },
      text: "Hello",
      status: "completed",
      attempts: 1,
      createdAt: 1,
    },
    state: "completed",
    response: "Hello back",
    acknowledgeSlackDelivery: acknowledge,
  };
  let resolve!: (response: Response) => void;
  globalThis.fetch = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  ) as typeof fetch;
  const delivered = deliveryListener!(delivery);
  assert.equal(acknowledge.mock.calls.length, 0);
  resolve(new Response(JSON.stringify({ ok: true })));
  await delivered;
  assert.equal(acknowledge.mock.calls.length, 1);

  // Exhausted delivery retries must not clear the web indicator.
  acknowledge.mockClear();
  vi.useFakeTimers();
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: false, error: "missing_scope" })),
  ) as typeof fetch;
  const failed = assert.rejects(deliveryListener!(delivery), /missing_scope/);
  await vi.runAllTimersAsync();
  await failed;
  assert.equal(acknowledge.mock.calls.length, 0);
});

test("converts common model Markdown to Slack mrkdwn without changing code", () => {
  assert.equal(
    slackMrkdwn(
      "## Result\n\n**Bold** and [docs](https://example.com).\n\n```md\n**code**\n```",
      1_000,
    ),
    "*Result*\n\n*Bold* and <https://example.com|docs>.\n\n```md\n**code**\n```",
  );
});

test("ignores bot echoes, subtypes, and other users", async () => {
  globalThis.fetch = vi.fn() as typeof fetch;
  const base = {
    type: "message",
    channel_type: "im",
    channel: "D1",
    ts: "100.2",
    text: "Hello",
  };
  await handleSlackAssistantEnvelope({
    type: "events_api",
    payload: { event: { ...base, user: "UBOT", bot_id: "B1" } },
  });
  await handleSlackAssistantEnvelope({
    type: "events_api",
    payload: { event: { ...base, user: "U1", subtype: "message_changed" } },
  });
  await handleSlackAssistantEnvelope({
    type: "events_api",
    payload: { event: { ...base, user: "U2" } },
  });
  assert.equal(enqueue.mock.calls.length, 0);
  assert.equal(vi.mocked(globalThis.fetch).mock.calls.length, 0);
});
