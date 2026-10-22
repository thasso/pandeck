import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, test, vi } from "vitest";
import { DEFAULT_SPEECH_CONVERSATION_SETTINGS } from "@assistant/shared";
import type { SttConnection } from "./sttClient.ts";
import { StreamingSttConnection } from "./streamingSttClient.ts";
import { StreamingSttEngine } from "./streamingSttEngine.ts";

function setup() {
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
  const ready = vi.fn(
    async () => ({ close: vi.fn() }) as unknown as SttConnection,
  );
  const runtime = vi.fn(async () => ({
    ok: true as const,
    binary: "online-server",
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
  }));
  const engine = new StreamingSttEngine({
    spawn: spawnChild as unknown as typeof spawn,
    ready,
    runtime,
  });
  const open = (
    settings = DEFAULT_SPEECH_CONVERSATION_SETTINGS,
    signal?: AbortSignal,
  ) =>
    engine.open(
      settings,
      () => {},
      () => {},
      () => {},
      signal,
    );
  return { engine, child, spawnChild, runtime, ready, connect, open };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("one warm model serves concurrent streams with four threads and endpoint settings", async () => {
  const s = setup();
  try {
    const [first, second] = await Promise.all([s.open(), s.open()]);
    assert.equal(s.spawnChild.mock.calls.length, 1);
    const args = (
      s.spawnChild.mock.calls as unknown as [string, string[]][]
    )[0]![1];
    assert.ok(args.includes("--num-threads=4"));
    assert.ok(args.includes("--rule2-min-trailing-silence=1.2"));
    assert.ok(args.includes("--enable-endpoint=true"));
    await assert.rejects(s.open(), /busy/);
    first.close();
    second.close();
    const third = await s.open();
    third.close();
    assert.equal(s.spawnChild.mock.calls.length, 1);
  } finally {
    s.engine.dispose();
  }
});

test.each([0.3, 1.2, 5])(
  "M1-C2 both silence rules honor %s seconds, with an explicit 120-second hard cap",
  async (silence) => {
    const s = setup();
    try {
      const stream = await s.open({
        ...DEFAULT_SPEECH_CONVERSATION_SETTINGS,
        endpointSilenceSeconds: silence,
      });
      const args = (
        s.spawnChild.mock.calls as unknown as [string, string[]][]
      )[0]![1];
      for (const rule of [1, 2]) {
        assert.ok(
          args.includes(`--rule${rule}-min-trailing-silence=${silence}`),
        );
        assert.ok(args.includes(`--rule${rule}-min-utterance-length=0`));
      }
      assert.ok(args.includes("--rule1-must-contain-nonsilence=false"));
      assert.ok(args.includes("--rule2-must-contain-nonsilence=true"));
      assert.ok(args.includes("--rule3-min-utterance-length=120"));
      assert.ok(args.includes("--rule3-min-trailing-silence=0"));
      assert.ok(args.includes("--rule3-must-contain-nonsilence=false"));
      stream.close();
    } finally {
      s.engine.dispose();
    }
  },
);

test("holds prevent idle release; closing the last stream arms shutdown and escalation", async () => {
  vi.useFakeTimers();
  const s = setup();
  try {
    const stream = await s.open({
      ...DEFAULT_SPEECH_CONVERSATION_SETTINGS,
      idleShutdownSeconds: 1,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(s.child.kill.mock.calls.length, 0);
    stream.close();
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(s.child.kill.mock.calls, [["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(5_000);
    assert.deepEqual(s.child.kill.mock.calls, [["SIGTERM"], ["SIGKILL"]]);
  } finally {
    s.engine.dispose();
  }
});

test("shutdown during model resolution does not spawn a late child", async () => {
  const s = setup();
  const original = await s.runtime();
  let resolve!: (value: typeof original) => void;
  s.runtime.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const opening = s.open();
  s.engine.dispose();
  resolve(original);
  await assert.rejects(opening, /shutting down/);
  assert.equal(s.spawnChild.mock.calls.length, 0);
  await assert.rejects(s.open(), /restarting/);
});

test("startup failure kills the child, tolerates repeated error events, and backs off retry", async () => {
  vi.useFakeTimers();
  const s = setup();
  try {
    s.ready.mockRejectedValueOnce(new Error("cannot connect"));
    await assert.rejects(s.open(), /cannot connect/);
    s.child.emit("error", new Error("first"));
    s.child.emit("error", new Error("second"));
    const retry = s.open();
    await vi.advanceTimersByTimeAsync(4_999);
    assert.equal(s.spawnChild.mock.calls.length, 1);
    await vi.advanceTimersByTimeAsync(1);
    const stream = await retry;
    stream.close();
    assert.equal(s.spawnChild.mock.calls.length, 2);
  } finally {
    s.engine.dispose();
  }
});

test.each([false, true])(
  "M1-C1 connecting cancellation frees admission even at handshake completion: %s",
  async (handshakeComplete) => {
    const s = setup();
    const controller = new AbortController();
    let connected!: () => void;
    s.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    );
    try {
      const pending = s.open(
        DEFAULT_SPEECH_CONVERSATION_SETTINGS,
        controller.signal,
      );
      const rejected = assert.rejects(pending, /cancelled/);
      await vi.waitFor(() => assert.equal(s.connect.mock.calls.length, 1));
      if (handshakeComplete) connected();
      controller.abort();
      await rejected;
      const streams = await Promise.all([s.open(), s.open()]);
      connected();
      await Promise.resolve();
      await assert.rejects(s.open(), /busy/);
      streams.forEach((stream) => stream.close());
      const fresh = await s.open();
      fresh.close();
    } finally {
      s.engine.dispose();
    }
  },
);

test("M1-C1 dispose during restart backoff rejects pending admission immediately", async () => {
  vi.useFakeTimers();
  const s = setup();
  s.ready.mockRejectedValueOnce(new Error("cannot connect"));
  await assert.rejects(s.open(), /cannot connect/);
  const pending = s.open();
  const rejected = assert.rejects(pending, /shutting down/);
  s.engine.dispose();
  await rejected;
  await vi.advanceTimersByTimeAsync(5000);
  assert.equal(s.spawnChild.mock.calls.length, 1);
});

test("settings changes wait for active streams then reload the warm process", async () => {
  const s = setup();
  try {
    const stream = await s.open();
    const settings = { ...DEFAULT_SPEECH_CONVERSATION_SETTINGS, numThreads: 2 };
    await assert.rejects(s.open(settings), /Stop active/);
    stream.close();
    const next = await s.open(settings);
    next.close();
    assert.equal(s.spawnChild.mock.calls.length, 2);
  } finally {
    s.engine.dispose();
  }
});
