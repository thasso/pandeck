/**
 * `hostCommandTurn.ts`: what a synthetic host-command turn shows its viewers
 * and its runtime adapter, the same for both engines.
 *   pnpm --filter @assistant/server test src/sessionKit/hostCommandTurn.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { AdapterEvent } from "../session/adapters/contract.ts";
import { NativeAdapterEventSource } from "../session/adapters/nativeEvents.ts";
import {
  discardHostCommandTurn,
  finishHostCommandCard,
  finishHostCommandTool,
  hostCommandTurn,
  openHostCommandTurn,
  updateHostCommandTool,
  type HostCommandResult,
} from "./hostCommandTurn.ts";

/** A turn opened on a target that records what it is shown. */
function openTurn() {
  const sent: ServerMessage[] = [];
  const events: AdapterEvent[] = [];
  const adapterEvents = new NativeAdapterEventSource();
  adapterEvents.subscribe((event) => events.push(event));
  const target = {
    sessionId: "s1",
    broadcast: (message: ServerMessage) => sent.push(message),
    adapterEvents,
  };
  const turn = hostCommandTurn("a1", "t1", "/commit", { rawArgs: "" });
  openHostCommandTurn(target, turn);
  return { target, turn, sent, events };
}

test("opening shows the turn with its tool starting", () => {
  const { turn, sent, events } = openTurn();
  assert.deepEqual(
    sent.map((m) => m.type),
    ["assistantStart", "toolStart", "toolUpdate"],
  );
  assert.ok(sent.every((m) => (m as { id?: string }).id === "a1"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["messageStarted", "toolStarted", "toolUpdated"],
  );
  assert.equal(turn.streaming, true);
  assert.deepEqual(turn.blocks, [
    {
      kind: "tool",
      toolId: "t1",
      name: "/commit",
      args: { rawArgs: "" },
      output: "Starting…",
      isError: false,
      done: false,
    },
  ]);
});

test("progress streams into the tool block", () => {
  const { target, turn, sent } = openTurn();
  updateHostCommandTool(target, turn, "t1", "Generating…");
  assert.deepEqual(sent.at(-1), {
    type: "toolUpdate",
    sessionId: "s1",
    id: "a1",
    toolId: "t1",
    output: "Generating…",
  });
  assert.equal((turn.blocks[0] as { output: string }).output, "Generating…");
});

test("a tool finish ends the turn, an error output as its error", () => {
  const { target, turn, sent, events } = openTurn();
  finishHostCommandTool(target, turn, "t1", "nothing to commit", true);
  assert.deepEqual(sent.slice(-2), [
    {
      type: "toolEnd",
      sessionId: "s1",
      id: "a1",
      toolId: "t1",
      output: "nothing to commit",
      isError: true,
    },
    {
      type: "assistantEnd",
      sessionId: "s1",
      id: "a1",
      error: "nothing to commit",
    },
  ]);
  // The adapter lands the tool result after the message, then ends the run.
  assert.deepEqual(
    events.slice(-3).map((e) => e.type),
    ["messageCompleted", "toolCompleted", "runCompleted"],
  );
  assert.equal(turn.streaming, false);
  assert.deepEqual(turn.blocks[0], {
    kind: "tool",
    toolId: "t1",
    name: "/commit",
    args: { rawArgs: "" },
    output: "nothing to commit",
    isError: true,
    done: true,
  });
});

test("a discarded turn ends without an entry", () => {
  const { target, turn, sent, events } = openTurn();
  discardHostCommandTurn(target, turn);
  assert.deepEqual(sent.at(-1), {
    type: "assistantEnd",
    sessionId: "s1",
    id: "a1",
  });
  assert.equal(events.at(-1)?.type, "hostCommandDiscarded");
});

test("every card replaces the tool block and lands under its own envelope and entry name", () => {
  const cards: Array<{
    result: HostCommandResult;
    envelope: string;
    name: string;
  }> = [
    {
      result: { kind: "commit", commit: { status: "committed" } as never },
      envelope: "commitResult",
      name: "commit",
    },
    {
      result: { kind: "push", push: { output: "pushed" } as never },
      envelope: "pushResult",
      name: "push",
    },
    {
      result: {
        kind: "compaction",
        compaction: { summary: "s", tokensBefore: 1 } as never,
      },
      envelope: "compactionResult",
      name: "compaction",
    },
    {
      result: { kind: "contextClear", contextClear: {} },
      envelope: "contextClearResult",
      name: "contextClear",
    },
    {
      result: {
        kind: "worktreeProvision",
        provision: { state: "ready" } as never,
      },
      envelope: "worktreeProvisionResult",
      name: "worktree",
    },
  ];
  for (const { result, envelope, name } of cards) {
    const { target, turn, sent, events } = openTurn();
    const landed = finishHostCommandCard(target, turn, result);
    assert.deepEqual(landed, { name, card: { ...result, id: "a1" } });
    assert.deepEqual(turn.blocks, [result], result.kind);
    assert.equal(turn.streaming, false);
    const payload = Object.entries(result).find(([key]) => key !== "kind")!;
    assert.deepEqual(sent.slice(-2), [
      { type: envelope, sessionId: "s1", id: "a1", [payload[0]]: payload[1] },
      { type: "assistantEnd", sessionId: "s1", id: "a1" },
    ]);
    assert.equal(events.at(-2)?.type, "passthrough", result.kind);
    // The adapter lands the card as the turn's durable entry, under its name.
    assert.deepEqual(events.at(-1), {
      type: "hostCommandResult",
      name,
      card: { ...result, id: "a1" },
    });
  }
});
