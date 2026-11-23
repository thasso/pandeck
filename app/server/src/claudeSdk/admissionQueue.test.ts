/**
 * The Claude session's first-in, first-out admission queue.
 *   pnpm --filter @assistant/server test src/claudeSdk/admissionQueue.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { AdmissionQueue } from "./admissionQueue.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("places are ready in the order they were entered, each after the one before released", async () => {
  const queue = new AdmissionQueue();
  const order: string[] = [];
  const places = ["a", "b", "c"].map((name) => {
    const place = queue.enter();
    void place.ready.then(() => order.push(name));
    return place;
  });
  await tick();
  assert.deepEqual(order, ["a"]);
  // Entered while "a" holds: still behind every earlier place.
  const late = queue.enter();
  void late.ready.then(() => order.push("late"));
  places[0]!.release();
  await tick();
  assert.deepEqual(order, ["a", "b"]);
  places[1]!.release();
  places[2]!.release();
  await tick();
  assert.deepEqual(order, ["a", "b", "c", "late"]);
});

test("waiters released together cannot both pass: the next place waits for the one before it", async () => {
  const queue = new AdmissionQueue();
  const first = queue.enter();
  const second = queue.enter();
  const third = queue.enter();
  let holders = 0;
  let overlap = false;
  const hold = async (place: typeof first) => {
    await place.ready;
    holders += 1;
    if (holders > 1) overlap = true;
    await tick();
    holders -= 1;
    place.release();
  };
  const runs = [hold(second), hold(third)];
  first.release();
  await Promise.all(runs);
  assert.equal(overlap, false);
});

test("a place released before it was ready (a cancel) lets the next one through", async () => {
  const queue = new AdmissionQueue();
  const holder = queue.enter();
  const cancelled = queue.enter();
  const next = queue.enter();
  let nextReady = false;
  void next.ready.then(() => (nextReady = true));
  cancelled.release();
  cancelled.release();
  await tick();
  assert.equal(nextReady, false);
  holder.release();
  await tick();
  assert.equal(nextReady, true);
  next.release();
  assert.equal(queue.busy, false);
});

test("busy while any place is waiting or held; close makes every place ready", async () => {
  const queue = new AdmissionQueue();
  assert.equal(queue.busy, false);
  queue.enter();
  const waiting = queue.enter();
  assert.equal(queue.busy, true);
  let ready = false;
  void waiting.ready.then(() => (ready = true));
  await tick();
  assert.equal(ready, false, "the first holder never released");
  queue.close();
  await tick();
  assert.equal(ready, true);
  let afterClose = false;
  void queue.enter().ready.then(() => (afterClose = true));
  await tick();
  assert.equal(afterClose, true);
});
