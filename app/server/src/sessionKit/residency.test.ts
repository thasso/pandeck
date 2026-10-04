/**
 * `SessionResidency`: the viewer set and idle clock both engine sessions share.
 *   pnpm --filter @assistant/server test src/sessionKit/residency.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { HARNESS_IDLE_EVICT_MS, type Viewer } from "../harness.ts";
import { SessionResidency } from "./residency.ts";

afterEach(() => vi.useRealTimers());

function viewer(received: ServerMessage[] = []): Viewer {
  return { send: (message) => received.push(message) };
}

/** A residency whose idleness and release a test steers, counting releases. */
function residency(options: { idle?: () => boolean; keep?: () => boolean }) {
  const released: number[] = [];
  const r = new SessionResidency(options.idle ?? (() => true));
  r.hold(() => {
    if (options.keep?.()) return false;
    released.push(Date.now());
    return true;
  });
  return { r, released };
}

test("an unviewed idle session is released once, after the full grace", () => {
  vi.useFakeTimers();
  const { r, released } = residency({});
  r.arm();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
  assert.equal(released.length, 0);
  vi.advanceTimersByTime(1);
  assert.equal(released.length, 1);

  // Released for good, even by a release that does not close it itself.
  r.arm();
  r.removeViewer(viewer());
  assert.equal(vi.getTimerCount(), 0);
});

test("a closed residency never runs its clock again", () => {
  vi.useFakeTimers();
  const { r, released } = residency({});
  const v = viewer();
  r.addViewer(v);
  r.close();
  // A late acquisition, or a viewer leaving the released session.
  r.arm();
  r.removeViewer(v);
  assert.equal(vi.getTimerCount(), 0);

  // Closing also stops a clock already running.
  const pending = residency({});
  pending.r.arm();
  pending.r.close();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 2);
  assert.deepEqual([released.length, pending.released.length], [0, 0]);
});

test("no clock runs while no store holds the session", () => {
  vi.useFakeTimers();
  const r = new SessionResidency(() => true);
  r.arm();
  assert.equal(vi.getTimerCount(), 0);
});

test("a viewer stops the clock, and leaving restarts it in full", () => {
  vi.useFakeTimers();
  const { r, released } = residency({});
  const v = viewer();
  r.arm();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
  r.addViewer(v);
  r.arm();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 2);
  assert.equal(released.length, 0, "never released while viewed");

  r.removeViewer(v);
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
  assert.equal(released.length, 0);
  vi.advanceTimersByTime(1);
  assert.equal(released.length, 1);
});

test("a busy session, or one its store keeps, gets a full grace again", () => {
  vi.useFakeTimers();
  let busy = true;
  let kept = false;
  const { r, released } = residency({ idle: () => !busy, keep: () => kept });
  r.arm();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(released.length, 0, "busy when the clock ran out");

  busy = false;
  kept = true;
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(released.length, 0, "the store kept it");

  kept = false;
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS - 1);
  assert.equal(released.length, 0);
  vi.advanceTimersByTime(1);
  assert.equal(released.length, 1);
});

test("cancel stops the clock until it is armed again", () => {
  vi.useFakeTimers();
  const { r, released } = residency({});
  r.arm();
  r.cancel();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS * 2);
  assert.equal(released.length, 0);
  r.arm();
  vi.advanceTimersByTime(HARNESS_IDLE_EVICT_MS);
  assert.equal(released.length, 1);
});

test("a broadcast reaches every viewer", () => {
  const { r } = residency({});
  const a: ServerMessage[] = [];
  const b: ServerMessage[] = [];
  r.addViewer(viewer(a));
  r.addViewer(viewer(b));
  const message = {
    type: "sessions",
    sessions: [],
  } as unknown as ServerMessage;
  r.broadcast(message);
  assert.deepEqual([a, b], [[message], [message]]);
});
