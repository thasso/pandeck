import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createObservations,
  type Observation,
  type ObservationAnswer,
  type ObservationBatch,
} from "./observations.ts";

const boot = "a".repeat(32);
const observation = (n: number): Observation => ({
  rid: `${boot}:${n}`,
  at: 100,
  host: "localhost",
  method: "POST",
  path: "/v1/messages",
  status: 502,
  outcome: "failed",
  reason: "ECONNRESET",
  clientCredential: "none",
  clientCookie: false,
  requestBytes: 7,
  responseBytes: 3,
  durationMs: 10,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}
afterEach(() => vi.useRealTimers());

test("admission includes unfinished requests; release and conversion dispose exactly once", async () => {
  vi.useFakeTimers();
  const sent: ObservationBatch[] = [];
  const queue = createObservations({
    boot,
    capacity: 5,
    log() {},
    send: async (batch) => {
      sent.push(batch);
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  await tick();
  const slots = Array.from({ length: 4 }, () => queue.reserve()!);
  assert.ok(slots.every(Boolean));
  assert.equal(queue.reserve(), undefined);
  queue.overflow();
  queue.overflow();
  slots[0]!.record(observation(1));
  slots[0]!.release();
  slots[0]!.record(observation(99));
  assert.equal(queue.reserve(), undefined);
  slots[1]!.release();
  slots[1]!.release();
  slots[1]!.record(observation(98));
  slots[2]!.record(observation(3));
  slots[3]!.record(observation(4));
  await tick();
  const entries = sent.flatMap((batch) => batch.records);
  assert.deepEqual(
    entries
      .filter((entry) => "rid" in entry)
      .map((entry) => "rid" in entry && entry.rid),
    [1, 3, 4].map((n) => `${boot}:${n}`),
  );
  assert.deepEqual(
    entries.filter((entry) => "note" in entry && entry.note === "overflow"),
    [{ d: 3, note: "overflow", count: 2, from: Date.now(), to: Date.now() }],
  );
  await queue.close(10);
});

test("d is completion order, not rid order; only one batch is in flight", async () => {
  vi.useFakeTimers();
  const pending: ReturnType<typeof deferred<ObservationAnswer>>[] = [];
  const sent: ObservationBatch[] = [];
  const queue = createObservations({
    boot,
    log() {},
    send: (batch) => {
      sent.push(batch);
      const wait = deferred<ObservationAnswer>();
      pending.push(wait);
      return wait.promise;
    },
  });
  const first = queue.reserve()!;
  const second = queue.reserve()!;
  second.record(observation(2));
  await tick();
  first.record(observation(1));
  await tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0]!.records.map((entry) => entry.d),
    [1, 2],
  );
  pending[0]!.resolve({ status: 200, ack: 2 });
  await tick();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]!.records, [{ ...observation(1), d: 3 }]);
  pending[1]!.resolve({ status: 200, ack: 3 });
  await tick();
  await queue.close(10);
});

test("lost ack retries the same rid-less restart note, then advances to the fallback", async () => {
  vi.useFakeTimers();
  const sent: ObservationBatch[] = [];
  const queue = createObservations({
    boot,
    log() {},
    retryMs: 1000,
    send: async (batch) => {
      sent.push(batch);
      if (sent.length === 1 || sent.length === 3) throw new Error("lost ack");
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  await tick();
  await tick(999);
  assert.equal(sent.length, 1);
  await tick(1);
  assert.deepEqual(sent[0], sent[1]);
  queue.reserve()!.record(observation(1));
  await tick();
  assert.equal(sent[2]!.records[0]!.d, 2);
  await tick(1000);
  assert.deepEqual(sent[2], sent[3]);
  await queue.close(10);
});

test("network and 5xx failures back off from one to thirty seconds", async () => {
  vi.useFakeTimers();
  const times: number[] = [];
  const queue = createObservations({
    boot,
    log() {},
    send: async () => {
      times.push(Date.now());
      return { status: 503 };
    },
  });
  await tick();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000])
    await tick(delay);
  assert.deepEqual(
    times.slice(1).map((at, i) => at - times[i]!),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
  const close = queue.close(0);
  await tick();
  await close;
});

test("invalid acks retain records; a 400 drops only that batch and counts it", async () => {
  vi.useFakeTimers();
  const sent: ObservationBatch[] = [];
  const lines: string[] = [];
  const queue = createObservations({
    boot,
    log: (line) => lines.push(line),
    send: async (batch) => {
      sent.push(batch);
      return sent.length === 1 ? { status: 200, ack: 900 } : { status: 400 };
    },
  });
  await tick();
  await tick(1000);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(queue.rejected, 1);
  assert.deepEqual(lines, ["observations: invalid batch dropped"]);
  await queue.close(0);
});

test("batch count and serialized bytes are bounded and partial acks retain the tail", async () => {
  vi.useFakeTimers();
  const sent: ObservationBatch[] = [];
  const queue = createObservations({
    boot,
    log() {},
    send: async (batch) => {
      sent.push(batch);
      return {
        status: 200,
        ack: sent.length === 1 ? 1 : batch.records.at(-1)!.d,
      };
    },
  });
  for (let n = 1; n <= 240; n++)
    queue.reserve()!.record({
      ...observation(n),
      path: "/" + "x".repeat(199),
      host: "x".repeat(253),
    });
  await tick();
  assert.ok(
    sent.every(
      (batch) =>
        batch.records.length <= 100 &&
        Buffer.byteLength(JSON.stringify(batch)) <= 64 * 1024,
    ),
  );
  assert.equal(sent[1]!.records[0]!.d, 2);
  assert.equal(sent.at(-1)!.records.at(-1)!.d, 241);
  await queue.close(10);
});

test("close aborts at its deadline, logs counts once including overflow, and is idempotent", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  let signal: AbortSignal | undefined;
  const queue = createObservations({
    boot,
    capacity: 3,
    log: (line) => lines.push(line),
    send: (_batch, bounded) => {
      signal = bounded;
      return new Promise((_resolve, reject) =>
        bounded.addEventListener("abort", () => reject(new Error("stop"))),
      );
    },
  });
  queue.reserve()!.record(observation(1));
  assert.equal(queue.reserve(), undefined);
  queue.overflow();
  queue.overflow();
  await tick();
  const close = queue.close(50);
  assert.equal(queue.close(500), close);
  await tick(49);
  assert.equal(signal!.aborted, false);
  await tick(1);
  await close;
  assert.equal(signal!.aborted, true);
  assert.deepEqual(lines, [
    "observations: 3 not delivered at close overflow 2",
  ]);
  assert.equal(queue.reserve(), undefined);
});
