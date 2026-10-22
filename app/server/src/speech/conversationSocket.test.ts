import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, test, vi } from "vitest";
import { DEFAULT_SPEECH_CONVERSATION_SETTINGS } from "@assistant/shared";
import { getSettings } from "../settings.ts";
import {
  attachConversationSocket,
  validateConversationClientMessage,
} from "./conversationSocket.ts";
import {
  StreamingSttConnection,
  type StreamingTranscript,
} from "./streamingSttClient.ts";
import { StreamingSttEngine } from "./streamingSttEngine.ts";
import type { SttConnection } from "./sttClient.ts";

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
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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

function pendingRecognizer() {
  const connect = vi
    .spyOn(StreamingSttConnection.prototype, "connect")
    .mockResolvedValue();
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: undefined,
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  const spawnChild = vi.fn(() => child as unknown as ChildProcess);
  const model = {
    ok: true as const,
    binary: "mock",
    version: "1.13.8",
    model: {
      id: "streaming",
      label: "streaming",
      dir: "/model",
      encoder: "/model/encoder",
      decoder: "/model/decoder",
      joiner: "/model/joiner",
      tokens: "/model/tokens",
    },
  };
  const runtime = vi.fn(async () => model);
  const probe = { close: vi.fn() } as unknown as SttConnection;
  let ready!: (probe: SttConnection) => void;
  const readiness = new Promise<SttConnection>((resolve) => {
    ready = resolve;
  });
  const readyProbe = vi
    .fn(async () => probe)
    .mockImplementationOnce(() => readiness);
  const engine = new StreamingSttEngine({
    spawn: spawnChild as unknown as typeof spawn,
    runtime,
    ready: readyProbe,
  });
  const socket = (patch = {}) => {
    const ws = new Socket();
    const current = getSettings();
    attachConversationSocket(ws as unknown as WebSocket, engine, () => ({
      ...current,
      speechConversation: { ...DEFAULT_SPEECH_CONVERSATION_SETTINGS, ...patch },
    }));
    return ws;
  };
  return {
    engine,
    child,
    spawnChild,
    runtime,
    model,
    connect,
    socket,
    ready: () => ready(probe),
  };
}

test("M1-C1 abandoned warm-up starts immediately free both admission slots", async () => {
  const s = pendingRecognizer();
  try {
    const first = s.socket();
    first.json({ type: "start" });
    first.json({ type: "cancel" });
    const second = s.socket();
    second.json({ type: "start" });
    second.close(1000);
    const third = s.socket();
    third.json({ type: "start" });
    await tick();
    assert.deepEqual(
      third.sent,
      [],
      "a live third start waits for readiness, not abandoned holds",
    );
    s.ready();
    await vi.waitFor(() =>
      assert.deepEqual(third.sent, [{ type: "accepted", sampleRate: 16000 }]),
    );
    assert.equal(
      s.connect.mock.calls.length,
      1,
      "abandoned opens never connect when warm-up finishes",
    );
    assert.equal(s.spawnChild.mock.calls.length, 1);
    first.close(1000);
    third.close(1000);
  } finally {
    s.engine.dispose();
  }
});

test("M1-C1 settings changes replace an abandoned pending start without reviving its model", async () => {
  const s = pendingRecognizer();
  let resolved!: (value: typeof s.model) => void;
  s.runtime.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolved = resolve;
      }),
  );
  try {
    const first = s.socket();
    first.json({ type: "start" });
    first.json({ type: "cancel" });
    const next = s.socket({ numThreads: 2 });
    next.json({ type: "start" });
    await tick();
    assert.equal(
      s.runtime.mock.calls.length,
      2,
      "cancelled admission does not block changing settings",
    );
    s.ready();
    await vi.waitFor(() => assert.equal(next.sent[0]?.type, "accepted"));
    resolved(s.model);
    await tick();
    assert.equal(
      s.spawnChild.mock.calls.length,
      1,
      "old runtime completion cannot spawn a stale model",
    );
    assert.equal(s.child.kill.mock.calls.length, 0);
    assert.equal(s.connect.mock.calls.length, 1);
    first.close(1000);
    next.close(1000);
  } finally {
    s.engine.dispose();
  }
});

test("M1-C1 abandoned warm-up idles out and a late readiness cannot stop its replacement", async () => {
  vi.useFakeTimers();
  const s = pendingRecognizer();
  try {
    const first = s.socket({ idleShutdownSeconds: 1 });
    first.json({ type: "start" });
    await vi.advanceTimersByTimeAsync(0);
    first.close(1000);
    await vi.advanceTimersByTimeAsync(1000);
    assert.deepEqual(s.child.kill.mock.calls, [["SIGTERM"]]);
    const next = s.socket({ idleShutdownSeconds: 1 });
    next.json({ type: "start" });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(next.sent[0]?.type, "accepted");
    s.ready();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(
      s.child.kill.mock.calls.length,
      1,
      "stale warm-up cleanup cannot kill the replacement",
    );
    assert.equal(s.spawnChild.mock.calls.length, 2);
    next.close(1000);
  } finally {
    s.engine.dispose();
  }
});

test("M1-C1 dispose releases pending opens before runtime resolution and prevents late spawn", async () => {
  const s = pendingRecognizer();
  let resolved!: (value: typeof s.model) => void;
  s.runtime.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolved = resolve;
      }),
  );
  const ws = s.socket();
  ws.json({ type: "start" });
  s.engine.dispose();
  await vi.waitFor(() =>
    assert.match(String(ws.sent[0]?.message), /shutting down/),
  );
  resolved(s.model);
  await tick();
  assert.equal(s.spawnChild.mock.calls.length, 0);
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

test("F2: sparse keepalives cannot bank more than two seconds of audio credit", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  for (let i = 0; i < 124; i++) {
    await vi.advanceTimersByTimeAsync(29_000);
    s.ws.audio(Buffer.alloc(2));
  }
  await vi.advanceTimersByTimeAsync(100);
  s.stream.sendPcm16.mockClear();
  // The review reproduction banked almost an hour, then sent 100 seconds at once.
  for (let i = 0; i < 100; i++) s.ws.audio(Buffer.alloc(32_000));
  assert.equal(s.stream.sendPcm16.mock.calls.length, 2);
  assert.equal(s.ws.closeCode, 1008);
  assert.match(String(s.ws.sent.at(-1)?.message), /real-time rate/);
});

test("F2: real-time frames with two seconds of jitter keep refilling the bounded credit", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  // A browser may batch ten 200 ms frames after a delayed delivery.
  for (let batch = 0; batch < 10; batch++) {
    for (let frame = 0; frame < 10; frame++) s.ws.audio(Buffer.alloc(6400));
    await vi.advanceTimersByTimeAsync(2000);
  }
  assert.equal(s.stream.sendPcm16.mock.calls.length, 100);
  assert.equal(s.ws.closeCode, undefined);
  s.ws.close(1000);
});

test("F2: restarting on the same socket resets audio credit", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ws.json({ type: "start" });
  await tick();
  s.ws.audio(Buffer.alloc(32_000));
  s.ws.audio(Buffer.alloc(32_000));
  s.ws.json({ type: "cancel" });
  s.ws.json({ type: "start" });
  await tick();
  s.ws.audio(Buffer.alloc(32_000));
  s.ws.audio(Buffer.alloc(32_000));
  assert.equal(s.stream.sendPcm16.mock.calls.length, 4);
  assert.equal(s.ws.closeCode, undefined);
  s.ws.close(1000);
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
