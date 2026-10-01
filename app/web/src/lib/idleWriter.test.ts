import { describe, expect, it } from "vitest";
import { createIdleWriter, type IdleWriterEnv } from "./idleWriter.ts";

interface FakeEnv extends IdleWriterEnv {
  advance(ms: number): void;
  runIdle(): void;
  idleCallbacks: number;
}

function fakeEnv(): FakeEnv {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  let idle: Array<() => void> = [];
  return {
    now: () => now,
    setTimer: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    whenIdle: (run) => {
      idle.push(run);
    },
    get idleCallbacks() {
      return idle.length;
    },
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(handle);
        timer.run();
      }
    },
    runIdle() {
      const due = idle;
      idle = [];
      for (const run of due) run();
    },
  };
}

describe("createIdleWriter", () => {
  it("writes only the last value of a burst, and only when idle", () => {
    const env = fakeEnv();
    const written: string[] = [];
    const writer = createIdleWriter<string>((value) => written.push(value), {
      delayMs: 1000,
      maxDelayMs: 5000,
      idleTimeoutMs: 2000,
      env,
    });

    writer.schedule("a");
    env.advance(200);
    writer.schedule("b");
    env.advance(200);
    writer.schedule("c");
    expect(written).toEqual([]);

    env.advance(1000);
    // The delay elapsed, but the write waits for the idle callback.
    expect(written).toEqual([]);
    env.runIdle();
    expect(written).toEqual(["c"]);
    expect(writer.pending).toBe(false);
  });

  it("caps how long a sustained stream can defer the write", () => {
    const env = fakeEnv();
    const written: string[] = [];
    const writer = createIdleWriter<number>(
      (value) => written.push(String(value)),
      { delayMs: 1000, maxDelayMs: 3000, idleTimeoutMs: 2000, env },
    );

    for (let i = 0; i < 20; i += 1) {
      writer.schedule(i);
      env.advance(250);
      env.runIdle();
    }
    expect(written.length).toBeGreaterThan(0);
    // The ceiling is 3000 ms, so ~5 writes over 5000 ms rather than one per update.
    expect(written.length).toBeLessThanOrEqual(3);
  });

  it("flushes synchronously and drops nothing", () => {
    const env = fakeEnv();
    const written: string[] = [];
    const writer = createIdleWriter<string>((value) => written.push(value), {
      delayMs: 1000,
      maxDelayMs: 5000,
      idleTimeoutMs: 2000,
      env,
    });

    writer.schedule("a");
    writer.flush();
    expect(written).toEqual(["a"]);

    // A flushed value is not written twice by the timer that was pending.
    env.advance(5000);
    env.runIdle();
    expect(written).toEqual(["a"]);
  });

  it("cancel drops the pending value", () => {
    const env = fakeEnv();
    const written: string[] = [];
    const writer = createIdleWriter<string>((value) => written.push(value), {
      delayMs: 1000,
      maxDelayMs: 5000,
      idleTimeoutMs: 2000,
      env,
    });

    writer.schedule("a");
    writer.cancel();
    expect(writer.pending).toBe(false);
    env.advance(5000);
    env.runIdle();
    writer.flush();
    expect(written).toEqual([]);
  });
});
