import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, test, vi } from "vitest";
import { DEFAULT_SPEECH_CONVERSATION_SETTINGS } from "@assistant/shared";
import { getSettings } from "../settings.ts";
import {
  attachConversationSocket,
  validateConversationClientMessage,
} from "./conversationSocket.ts";
import type { StreamingTranscript } from "./streamingSttClient.ts";

class Socket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  terminate(): void {
    this.close(1006);
  }
  sent: Record<string, unknown>[] = [];
  closeCode: number | undefined;
  send(message: string): void {
    this.sent.push(JSON.parse(message));
  }
  close(code: number): void {
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close");
  }
  json(message: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(message)), false);
  }
  audio(data = Buffer.alloc(3200)): void {
    this.emit("message", data, true);
  }
}

function setup() {
  const ws = new Socket();
  const stream = { sendPcm16: vi.fn(), finish: vi.fn(), close: vi.fn() };
  let transcript: (result: StreamingTranscript) => void = () => {};
  let done: () => void = () => {};
  let failure: (error: Error) => void = () => {};
  const open = vi.fn(async (_settings, onTranscript, onError, onDone) => {
    transcript = onTranscript;
    done = onDone;
    failure = onError;
    return stream;
  });
  const current = getSettings();
  attachConversationSocket(ws as unknown as WebSocket, { open }, () => ({
    ...current,
    speechConversation: { ...DEFAULT_SPEECH_CONVERSATION_SETTINGS },
    speechToText: {
      ...current.speechToText,
      vocabulary: [{ from: "forge joe", to: "Forgejo" }],
    },
  }));
  return {
    ws,
    stream,
    open,
    transcript: (result: StreamingTranscript) => transcript(result),
    done: () => done(),
    failure: (error: Error) => failure(error),
  };
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

test("only the separate conversation union is accepted", () => {
  for (const type of ["start", "stop", "cancel"])
    assert.equal(validateConversationClientMessage({ type }).ok, true);
  for (const value of [
    null,
    [],
    "start",
    {},
    { type: "warm" },
    { type: "start", utteranceId: "offline", sampleRate: 48000 },
  ])
    assert.equal(validateConversationClientMessage(value).ok, false);
});

test("streams audio immediately, rewrites replacement partials, forwards endpoints, and drains stop", async () => {
  const s = setup();
  s.ws.json({ type: "start" });
  assert.deepEqual(s.ws.sent, []);
  await tick();
  assert.deepEqual(s.ws.sent, [{ type: "accepted", sampleRate: 16000 }]);
  const pcm = Buffer.alloc(3200);
  s.ws.audio(pcm);
  assert.equal(s.stream.sendPcm16.mock.calls[0]?.[0], pcm);
  s.transcript({ segment: 0, text: " forge joe ", isFinal: false });
  s.transcript({ segment: 0, text: "forge joe now", isFinal: true });
  assert.deepEqual(s.ws.sent.slice(1), [
    { type: "transcript", segment: 0, text: "Forgejo", isFinal: false },
    { type: "transcript", segment: 0, text: "Forgejo now", isFinal: true },
  ]);
  s.ws.json({ type: "stop" });
  assert.equal(s.stream.finish.mock.calls.length, 1);
  s.done();
  assert.deepEqual(s.ws.sent.at(-1), { type: "stopped" });
  assert.equal(s.stream.close.mock.calls.length, 1);
  s.ws.close(1000);
});

test("cancel during warm-up closes a late stream and ignores its callbacks", async () => {
  const s = setup();
  s.ws.json({ type: "start" });
  s.ws.json({ type: "cancel" });
  await tick();
  s.transcript({ segment: 0, text: "stale", isFinal: true });
  assert.deepEqual(s.ws.sent, [{ type: "stopped" }]);
  assert.equal(s.stream.close.mock.calls.length, 1);
  s.ws.close(1000);
});

test("rejects audio before accepted, odd PCM, oversized frames and accelerated upload", async () => {
  const early = setup();
  early.ws.audio();
  assert.equal(early.ws.closeCode, 1008);
  for (const data of [Buffer.alloc(3), Buffer.alloc(32002)]) {
    const s = setup();
    s.ws.json({ type: "start" });
    await tick();
    s.ws.audio(data);
    assert.equal(s.ws.closeCode, 1008);
  }
  const fast = setup();
  fast.ws.json({ type: "start" });
  await tick();
  fast.ws.audio(Buffer.alloc(32000));
  fast.ws.audio(Buffer.alloc(32000));
  fast.ws.audio(Buffer.alloc(32000));
  assert.equal(fast.ws.closeCode, 1008);
});

test("disconnect releases a stream; errors close it once and suppress late results", async () => {
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  s.failure(new Error("recognizer died"));
  s.failure(new Error("duplicate"));
  s.transcript({ segment: 0, text: "late", isFinal: true });
  assert.equal(s.ws.closeCode, 1011);
  assert.equal(s.stream.close.mock.calls.length, 1);
  assert.equal(s.ws.sent.filter((msg) => msg.type === "error").length, 1);
});

test("a browser that cannot consume transcripts is disconnected without buffering history", async () => {
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  s.ws.bufferedAmount = 1_048_577;
  s.transcript({ segment: 0, text: "hello", isFinal: false });
  assert.equal(s.ws.closeCode, 1006);
  assert.equal(s.stream.close.mock.calls.length, 1);
});

test("stalled browser audio times out and releases the model hold", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(s.ws.closeCode, 1008);
  assert.equal(s.stream.close.mock.calls.length, 1);
});
