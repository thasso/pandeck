import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMutationLifecycle } from "./mutationLifecycle.ts";

interface Context {
  topic: string;
  objectIds: readonly string[];
  key: string;
  tempId?: string;
  additionalEffects?: readonly { topic: string }[];
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("client mutation lifecycle contract", () => {
  const context = (key = "a:save"): Context => ({
    topic: "tasks",
    objectIds: ["a"],
    key,
  });
  function fixture() {
    const lifecycle = createMutationLifecycle<Context>();
    const recover = vi.fn();
    const terminal = vi.fn();
    const disconnected = vi.fn();
    const start = (value = context(), timeoutMs = 30_000, migrated = true) =>
      lifecycle.start({
        context: value,
        timeoutMs,
        recover,
        terminal,
        ...(migrated ? { disconnected } : {}),
      });
    return { lifecycle, recover, terminal, disconnected, start };
  }

  it("retains independent identities and context, including multi-domain effects and temp ids", () => {
    const { lifecycle, start } = fixture();
    const value = {
      ...context(),
      tempId: "optimistic-a",
      additionalEffects: [{ topic: "sessions" }],
    };
    const first = start(value);
    const second = start(context(), 30_000, false);
    expect(first).not.toBe(second);
    expect(lifecycle.get(first)).toBe(value);
    expect(lifecycle.get(first)?.tempId).toBe("optimistic-a");
    expect(lifecycle.size).toBe(2);
    expect(lifecycle.pendingTopics()).toEqual(new Set(["tasks", "sessions"]));
    lifecycle.finish(first, { type: "settled" });
    expect(lifecycle.get(second)?.key).toBe("a:save");
    expect(lifecycle.size).toBe(1);
  });

  it.each(["settled", "error", "timeout"] as const)(
    "retires once on %s, before reentrant hooks",
    (type) => {
      const { lifecycle, start, recover, terminal } = fixture();
      const id = lifecycle.start({
        context: context(),
        timeoutMs: 30_000,
        recover,
        terminal: (outcome) => {
          expect(lifecycle.get(id)).toBeUndefined();
          expect(lifecycle.size).toBe(0);
          terminal(outcome);
          start(context());
        },
      });
      if (type === "timeout") vi.advanceTimersByTime(30_000);
      else
        lifecycle.finish(
          id,
          type === "error" ? { type, message: "Refused" } : { type },
        );
      lifecycle.finish(id, { type: "settled" });
      lifecycle.finish(id, { type: "error", message: "Late" });
      lifecycle.finish("unrelated", { type: "settled" });
      expect(lifecycle.size).toBe(1);
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(type === "settled" ? 0 : 1);
      if (type === "error")
        expect(terminal).toHaveBeenCalledWith({ type, message: "Refused" });
      // No cleared deadline can retire the new same-key request early.
      if (type !== "timeout") vi.advanceTimersByTime(29_999);
      expect(lifecycle.size).toBe(1);
    },
  );

  it.each([30_000, 900_000])(
    "keeps the %i ms descriptor deadline",
    (deadline) => {
      const { start, terminal, recover } = fixture();
      start(context(), deadline);
      vi.advanceTimersByTime(deadline - 1);
      expect(terminal).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(deadline);
      expect(terminal).toHaveBeenCalledTimes(1);
    },
  );

  it("disconnect releases only opted-in records and drains recovery once after subscribe", () => {
    const { lifecycle, start, terminal, recover, disconnected } = fixture();
    const id = start({
      ...context(),
      tempId: "optimistic-a",
      additionalEffects: [{ topic: "sessions" }],
    });
    const unrelated = start(
      { ...context("unrelated"), topic: "projects" },
      900_000,
      false,
    );
    const done = start();
    lifecycle.finish(done, { type: "settled" });
    terminal.mockClear();
    lifecycle.disconnect();
    lifecycle.disconnect();
    expect(lifecycle.get(id)).toBeUndefined();
    expect(lifecycle.get(unrelated)).toBeDefined();
    expect(lifecycle.pendingTopics()).toEqual(new Set(["projects"]));
    expect(lifecycle.recoveryTopics()).toEqual(new Set(["tasks"]));
    expect(lifecycle.size).toBe(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]?.[0]).toEqual({ type: "unknown" });
    vi.advanceTimersByTime(30_000);
    expect(recover).not.toHaveBeenCalled();
    const order: string[] = [];
    recover.mockImplementation(() => order.push("recover"));
    order.push("subscribe");
    lifecycle.reconnect();
    lifecycle.reconnect();
    expect(order).toEqual(["subscribe", "recover"]);
    expect(lifecycle.recoveryTopics().size).toBe(0);
    lifecycle.finish(unrelated, { type: "settled" });
    vi.advanceTimersByTime(900_000);
    expect(terminal).toHaveBeenCalledTimes(2);
  });

  it("holds a settled record for fresh evidence, with first-settle policy once", () => {
    const lifecycle = createMutationLifecycle<Context, "idle" | "busy">();
    const terminal = vi.fn();
    const firstSettled = vi.fn();
    const start = () =>
      lifecycle.start({
        context: context(),
        timeoutMs: 900_000,
        recover: vi.fn(),
        terminal,
        firstSettled,
        done: (settled, signal) =>
          signal === "busy" || (settled && signal === "idle"),
      });
    const a = start();
    lifecycle.observe("idle");
    lifecycle.settle(a);
    lifecycle.settle(a);
    expect(firstSettled).toHaveBeenCalledTimes(1);
    expect(lifecycle.get(a)).toBeDefined();
    expect(lifecycle.pendingTopics()).toEqual(new Set(["tasks"]));
    const b = start();
    lifecycle.observe("idle");
    expect(lifecycle.get(a)).toBeUndefined();
    expect(lifecycle.get(b)).toBeDefined();
    lifecycle.observe("busy");
    expect(lifecycle.size).toBe(0);
    expect(terminal).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(900_000);
    expect(terminal).toHaveBeenCalledTimes(2);
  });

  it.each(["error", "timeout", "unknown"] as const)(
    "retires a second-signal wait on %s before reentrant hooks",
    (type) => {
      const lifecycle = createMutationLifecycle<Context, boolean>();
      const firstSettled = vi.fn();
      const recover = vi.fn();
      const terminal = vi.fn();
      const start = () =>
        lifecycle.start({
          context: context(),
          timeoutMs: 900_000,
          recover,
          disconnected: () => {},
          firstSettled,
          done: (settled, signal) => settled && signal === true,
          terminal: (outcome) => {
            expect(lifecycle.pendingTopics().size).toBe(0);
            terminal(outcome);
            start();
          },
        });
      const a = start();
      vi.advanceTimersByTime(899_999);
      lifecycle.settle(a);
      lifecycle.settle(a);
      expect(terminal).not.toHaveBeenCalled();
      if (type === "timeout") vi.advanceTimersByTime(1);
      else if (type === "unknown") lifecycle.disconnect();
      else lifecycle.finish(a, { type, message: "Refused" });
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(firstSettled).toHaveBeenCalledTimes(1);
      lifecycle.settle(a);
      expect(lifecycle.size).toBe(1);
      lifecycle.observe(true); // The new same-key write is not settled.
      expect(lifecycle.size).toBe(1);
      if (type === "unknown") {
        expect(recover).not.toHaveBeenCalled();
        lifecycle.reconnect();
        lifecycle.reconnect();
      }
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  it("does not observe records started reentrantly in the same pass", () => {
    const lifecycle = createMutationLifecycle<Context, boolean>();
    const start = () =>
      lifecycle.start({
        context: context(),
        timeoutMs: 30_000,
        recover: vi.fn(),
        done: (_settled, signal) => signal === true,
        terminal: () => {
          start();
        },
      });
    start();
    lifecycle.observe(true);
    expect(lifecycle.size).toBe(1);
  });

  it("settles simple records immediately and gives receipt-only records no effects", () => {
    const lifecycle = createMutationLifecycle<{
      topic?: string;
      key: string;
    }>();
    const terminal = vi.fn();
    const start = (topic?: string) =>
      lifecycle.start({
        context: { key: "receipt", ...(topic ? { topic } : {}) },
        timeoutMs: 30_000,
        recover: vi.fn(),
        terminal,
        disconnected: () => {},
      });
    const receipt = start();
    expect(lifecycle.size).toBe(1);
    expect(lifecycle.pendingTopics().size).toBe(0);
    lifecycle.disconnect();
    expect(lifecycle.recoveryTopics().size).toBe(0);
    expect(terminal.mock.calls[0]?.[0]).toEqual({ type: "unknown" });
    lifecycle.settle(receipt);
    const ordinary = start("projects");
    start();
    expect(lifecycle.pendingTopics()).toEqual(new Set(["projects"]));
    lifecycle.settle(ordinary);
    expect(lifecycle.pendingTopics().size).toBe(0);
    expect(lifecycle.size).toBe(1);
    lifecycle.cleanup();
    vi.advanceTimersByTime(30_000);
    expect(terminal).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])(
    "remembers domain outcome before settle, with early refusal=%s",
    (refused) => {
      const lifecycle = createMutationLifecycle<Context, "busy" | "outcome">();
      const terminal = vi.fn();
      const recover = vi.fn();
      let outcomeSeen = false;
      const id = lifecycle.start({
        context: { ...context(), additionalEffects: [{ topic: "sessions" }] },
        timeoutMs: 30_000,
        recover,
        disconnected: () => {},
        done: (settled, observation) => {
          if (observation === "outcome") outcomeSeen = true;
          return outcomeSeen && (settled || refused);
        },
        terminal: () => {
          expect(lifecycle.pendingTopics().size).toBe(0);
          if (refused) recover();
          terminal();
        },
      });
      lifecycle.observe("busy");
      expect(lifecycle.pendingTopics()).toEqual(new Set(["tasks", "sessions"]));
      vi.advanceTimersByTime(29_999);
      lifecycle.observe("outcome");
      expect(terminal).toHaveBeenCalledTimes(refused ? 1 : 0);
      lifecycle.settle(id);
      lifecycle.settle(id);
      lifecycle.observe("outcome");
      vi.advanceTimersByTime(1);
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(recover).toHaveBeenCalledTimes(refused ? 1 : 0);
    },
  );

  it("selects only the oldest matching context, even when incomplete or reentrant", () => {
    const lifecycle = createMutationLifecycle<Context, string>();
    const calls: string[] = [];
    let complete = false;
    const start = (key: string) =>
      lifecycle.start({
        context: context(key),
        timeoutMs: 30_000,
        recover: vi.fn(),
        done: (_settled, observation) => {
          calls.push(key);
          return observation === "card" && complete;
        },
        terminal: () => {
          start("card");
        },
      });
    start("workflow");
    const a = start("card");
    const b = start("card");
    const match = (value: Context) => value.key === "card";
    lifecycle.observeFirst("card", match);
    expect(calls).toEqual(["card"]);
    expect(lifecycle.get(a)).toBeDefined();
    complete = true;
    lifecycle.observeFirst("card", match);
    expect(calls).toEqual(["card", "card"]);
    expect(lifecycle.get(a)).toBeUndefined();
    expect(lifecycle.get(b)).toBeDefined();
    lifecycle.observeFirst("card", match);
    expect(lifecycle.get(b)).toBeUndefined();
    expect(calls).toEqual(["card", "card", "card"]);
    lifecycle.observeFirst("other", (value) => value.key === "other");
    expect(calls).toHaveLength(3);
  });

  it("cleanup drops migrated timers and obligations but leaves the instance reusable", () => {
    const { lifecycle, start, terminal, recover } = fixture();
    start();
    lifecycle.disconnect();
    start();
    const legacy = start(context("legacy"), 900_000, false);
    terminal.mockClear();
    lifecycle.cleanup();
    expect(terminal).toHaveBeenCalledTimes(1);
    terminal.mockClear();
    lifecycle.reconnect();
    vi.advanceTimersByTime(30_000);
    expect(recover).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    expect(lifecycle.size).toBe(1);
    lifecycle.finish(legacy, { type: "settled" });
    const fresh = start();
    lifecycle.finish(fresh, { type: "settled" });
    expect(terminal).toHaveBeenCalledTimes(2);
  });
});
