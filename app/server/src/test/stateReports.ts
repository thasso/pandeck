/**
 * Test tools for the change-set hand-off (`db/changeSet.ts`): recorders that
 * stand in for, or forward to, the installed sink, and a fault that fails the
 * Initiative fan-out of a Task write.
 */
import assert from "node:assert/strict";
import { vi } from "vitest";
import type { BroadcastTopic } from "@assistant/shared";
import { setStateChangeSink } from "../db/changeSet.ts";
import { getDb } from "../db/index.ts";
import { initiativeStore } from "../db/initiativeStore.ts";

export interface StateReport {
  topic: BroadcastTopic;
  ids: string[];
  inTransaction: boolean;
}

/**
 * Replace the sink with a recorder until `stop`, which puts the previous one
 * back. A report made inside a transaction fails, so every report recorded
 * here came after a COMMIT. Nothing reaches the kernels meanwhile.
 */
export function recordStateReports(): {
  reports: StateReport[];
  /** The `tasks` ids, one entry per committed change set. */
  tasks: () => string[][];
  stop: () => void;
} {
  const reports: StateReport[] = [];
  const previous = setStateChangeSink((topic, ids) => {
    assert.equal(getDb().isTransaction, false, "reported before COMMIT");
    reports.push({ topic, ids: [...ids], inTransaction: false });
  });
  return {
    reports,
    tasks: () =>
      reports
        .filter((report) => report.topic === "tasks")
        .map((report) => report.ids),
    stop: () => setStateChangeSink(previous),
  };
}

/**
 * Record every report, in a transaction or not, and forward it to the sink
 * installed before, so the kernels still publish it. `stop` restores that sink.
 */
export function forwardStateReports(): {
  reports: StateReport[];
  stop: () => void;
} {
  const reports: StateReport[] = [];
  const previous = setStateChangeSink((topic, ids) => {
    reports.push({
      topic,
      ids: [...ids],
      inTransaction: getDb().isTransaction,
    });
    previous?.(topic, ids);
  });
  return { reports, stop: () => setStateChangeSink(previous) };
}

/**
 * Make `initiativeStore.touchHolders` throw `error`, after running the real
 * fan-out when `callThrough` is set, so its stamps are written before the
 * throw. Returns the restore.
 */
export function failInitiativeFanOut(
  error: Error,
  { callThrough = false }: { callThrough?: boolean } = {},
): () => void {
  const original = initiativeStore.touchHolders;
  const spy = vi
    .spyOn(initiativeStore, "touchHolders")
    .mockImplementation((...args) => {
      if (callThrough) original(...args);
      throw error;
    });
  return () => spy.mockRestore();
}
