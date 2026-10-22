import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { DEFAULT_SPEECH_SYNTHESIS_SETTINGS } from "@assistant/shared";
import { TtsEngine, TtsBusyError } from "./ttsEngine.ts";

function frame(header: object, pcm = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length);
  return Buffer.concat([len, json, pcm]);
}
function setup(autoReady = true) {
  const children: ReturnType<typeof fakeChild>[] = [];
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      pid: undefined,
      stdin: Object.assign(new EventEmitter(), {
        write: vi.fn((_value: string) => true),
      }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn((signal: string) => {
        child.signalCode = signal;
        queueMicrotask(() => child.emit("exit", null, signal));
        return true;
      }),
    });
    if (autoReady)
      queueMicrotask(() => child.stdout.emit("data", frame({ type: "ready" })));
    return child;
  }
  const spawnChild = vi.fn(() => {
    const child = fakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const runtime = vi.fn(() => ({
    ok: true as const,
    python: "/python",
    modelDir: "/model",
    modelId: "kokoro-v1-fp32",
  }));
  const engine = new TtsEngine({
    spawn: spawnChild as unknown as typeof spawn,
    runtime,
  });
  const controller = new AbortController();
  const run = (patch = {}) =>
    engine.synthesize(
      "Hello.",
      { ...DEFAULT_SPEECH_SYNTHESIS_SETTINGS, ...patch },
      controller.signal,
    );
  const child = () => children.at(-1)!;
  const tick = () =>
    vi.waitFor(() => expect(child().stdin.write).toHaveBeenCalled());
  const reply = (id = 1) =>
    child().stdout.emit(
      "data",
      frame(
        { type: "audio", id, bytes: 2, sampleRate: 24000 },
        Buffer.alloc(2),
      ),
    );
  return {
    engine,
    children,
    child,
    spawnChild,
    runtime,
    controller,
    run,
    tick,
    reply,
  };
}
const engines: TtsEngine[] = [];
function fixture(autoReady = true) {
  const s = setup(autoReady);
  engines.push(s.engine);
  return s;
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.useRealTimers();
});

test("lazy warm model, voice mapping, single-flight admission and reuse", async () => {
  const s = fixture();
  expect(s.spawnChild).not.toHaveBeenCalled();
  const result = s.run();
  await s.tick();
  await expect(s.run()).rejects.toBeInstanceOf(TtsBusyError);
  const request = JSON.parse(s.child().stdin.write.mock.calls[0]![0]);
  expect(request).toEqual({
    type: "synthesize",
    id: 1,
    text: "Hello.",
    sid: 3,
    speed: 1,
  });
  s.reply();
  expect(await result).toEqual(Buffer.alloc(2));
  const second = s.run({ voice: "bm_lewis", speed: 1.5 });
  await vi.waitFor(() =>
    expect(s.child().stdin.write).toHaveBeenCalledTimes(2),
  );
  expect(JSON.parse(s.child().stdin.write.mock.calls[1]![0])).toMatchObject({
    sid: 27,
    speed: 1.5,
  });
  s.reply(2);
  await second;
  expect(s.spawnChild).toHaveBeenCalledTimes(1);
});

test("abort sends cooperative cancellation and keeps the model warm after acknowledgement", async () => {
  const s = fixture();
  const result = s.run();
  const rejected = assert.rejects(result, /cancelled/);
  await s.tick();
  s.controller.abort();
  expect(JSON.parse(s.child().stdin.write.mock.calls[1]![0])).toEqual({
    type: "cancel",
    id: 1,
  });
  s.child().stdout.emit("data", frame({ type: "cancelled", id: 1 }));
  await rejected;
  expect(s.child().kill).not.toHaveBeenCalled();
});

test("idle shutdown, thread changes and shutdown never overlap model children", async () => {
  const s = fixture();
  const result = s.run();
  await s.tick();
  s.reply();
  await result;
  const old = s.child();
  const next = s.run({ numThreads: 2 });
  await vi.waitFor(() => expect(s.children).toHaveLength(2));
  await s.tick();
  expect(old.kill).toHaveBeenCalledWith("SIGTERM");
  s.reply(2);
  await next;
  vi.useFakeTimers();
  const third = s.run({ numThreads: 2, idleShutdownSeconds: 1 });
  await vi.advanceTimersByTimeAsync(0);
  s.reply(3);
  await third;
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.child().kill).toHaveBeenCalledWith("SIGTERM");
  s.engine.dispose();
  await expect(s.run()).rejects.toThrow(/restarting/);
});

test("dispose during warm-up rejects and repeated child errors are handled", async () => {
  const s = fixture(false);
  const result = s.run();
  const rejected = assert.rejects(result, /shutting down/);
  await vi.waitFor(() => expect(s.children).toHaveLength(1));
  s.engine.dispose();
  await rejected;
  s.child().emit("error", new Error("late one"));
  s.child().emit("error", new Error("late two"));
  expect(s.spawnChild).toHaveBeenCalledTimes(1);
});

test("unexpected exit backs off before restart and fails the pending request", async () => {
  const s = fixture();
  const result = s.run();
  const rejected = assert.rejects(result, /exited/);
  await s.tick();
  vi.useFakeTimers();
  s.child().exitCode = 1;
  s.child().emit("exit", 1);
  await rejected;
  const next = s.run();
  await vi.advanceTimersByTimeAsync(4999);
  expect(s.children).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(s.children).toHaveLength(2);
  s.reply(2);
  await next;
});

test("hung cancellation escalates and generation/startup are time-bounded", async () => {
  const s = fixture();
  const result = s.run();
  const rejected = assert.rejects(result, /cancelled/);
  await s.tick();
  vi.useFakeTimers();
  s.child().kill.mockImplementation(() => true);
  s.controller.abort();
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  expect(s.child().kill).toHaveBeenCalledWith("SIGTERM");
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.child().kill).toHaveBeenCalledWith("SIGKILL");
  const cold = fixture(false);
  const warm = cold.run();
  const failed = assert.rejects(warm, /warm-up timed out/);
  await vi.advanceTimersByTimeAsync(60000);
  await failed;
});

test("generation timeout and failed exec cannot strand later requests", async () => {
  vi.useFakeTimers();
  const s = fixture();
  const result = s.run();
  const rejected = assert.rejects(result, /timed out/);
  await s.tick();
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(s.child().kill).toHaveBeenCalledWith("SIGTERM");
  vi.useRealTimers();

  const failed = fixture(false);
  const first = failed.run();
  const firstRejected = assert.rejects(first, /Cannot start/);
  await vi.waitFor(() => expect(failed.children).toHaveLength(1));
  vi.useFakeTimers();
  failed.child().kill.mockImplementation(() => true);
  failed.child().emit("error", new Error("ENOENT"));
  failed.child().emit("close", -2);
  await firstRejected;
  const retry = failed.run();
  await vi.advanceTimersByTimeAsync(5000);
  expect(failed.children).toHaveLength(2);
  failed.child().stdout.emit("data", frame({ type: "ready" }));
  await vi.advanceTimersByTimeAsync(0);
  failed.reply();
  await retry;
});

test("aborted admission and unavailable runtime never spawn", async () => {
  const s = fixture();
  s.controller.abort();
  await expect(s.run()).rejects.toThrow();
  expect(s.spawnChild).not.toHaveBeenCalled();
  const other = fixture();
  other.runtime.mockReturnValue({ ok: false, reason: "missing" } as never);
  await expect(other.run()).rejects.toThrow(/missing/);
  expect(other.spawnChild).not.toHaveBeenCalled();
});
