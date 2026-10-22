/**
 * The reducer half of the background registry ([Task-486](pa://task/486)): what
 * the `background` topic's snapshot and events do to held state, and what a
 * human Stop's answer is — and is not — allowed to change. The generic event
 * rules belong to the replica (`lib/stateReplica.test.ts`); this file keeps
 * Background's own policy: placement, the window flag, and Stop.
 *   pnpm --filter @assistant/web test src/hooks/backgroundWorkStateSync.test.ts
 */
import { describe, expect, it } from "vitest";
import type {
  BackgroundWorkItemSummary,
  ServerMessage,
} from "@assistant/shared";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

const NOW = 1_800_000_000_000;

function item(
  partial: Partial<BackgroundWorkItemSummary> & { id: string },
): BackgroundWorkItemSummary {
  return {
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label: "pnpm run build",
    state: "running",
    stopState: "none",
    createdAt: NOW - 600_000,
    updatedAt: NOW - 60_000,
    startedAt: NOW - 600_000,
    deadlineAt: NOW + 1_800_000,
    settingsGeneration: 7,
    ...partial,
  };
}

const apply = (state = createInitialState(), ...messages: ServerMessage[]) =>
  messages.reduce(
    (current, msg) => reduceAssistantState(current, { kind: "server", msg }),
    state,
  );

const snapshot = (items: BackgroundWorkItemSummary[]): ServerMessage => ({
  type: "backgroundWorkList",
  items,
  seq: 1,
  revisions: items.map((row) => ({ id: row.id, revision: 1 })),
});

describe("the background registry projection", () => {
  it("takes the subscribe snapshot as authoritative", () => {
    const state = apply(undefined, snapshot([item({ id: "a" })]));
    expect(state.backgroundWorkItems.map((row) => row.id)).toEqual(["a"]);
    expect(state.stateEventRevisions.background).toEqual({ a: 1 });
  });

  it("carries a bounded snapshot's own admission that it is a window", () => {
    const whole = apply(undefined, snapshot([item({ id: "a" })]));
    expect(whole.backgroundWorkTruncated).toBe(false);
    const windowed = apply(undefined, {
      ...snapshot([item({ id: "a" })]),
      truncated: true,
    } as ServerMessage);
    expect(windowed.backgroundWorkTruncated).toBe(true);
    // A later complete snapshot retires the admission: the flag is a fact about
    // the answer in hand, never a sticky mode the surface stays stuck in.
    expect(
      apply(windowed, snapshot([item({ id: "a" })])).backgroundWorkTruncated,
    ).toBe(false);
  });

  it("puts a row it has not held yet first", () => {
    const seeded = apply(undefined, snapshot([item({ id: "a" })]));
    const next = apply(seeded, {
      type: "stateEvents",
      topic: "background",
      seq: 2,
      events: [
        { kind: "upsert", id: "b", revision: 1, item: item({ id: "b" }) },
      ],
    });
    // New work is the newest work: the surfaces read the list newest first.
    expect(next.backgroundWorkItems.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

describe("a human Stop's answer", () => {
  it("retires the pending control and writes no row", () => {
    const seeded = apply(undefined, snapshot([item({ id: "a" })]));
    const sent = reduceAssistantState(seeded, {
      kind: "backgroundStopSent",
      itemId: "a",
    });
    expect(sent.backgroundStopPending).toEqual(["a"]);
    const answered = apply(sent, {
      type: "backgroundWorkStopAnswer",
      requestId: "r1",
      items: [{ itemId: "a", outcome: "stop-unconfirmed" }],
    });
    expect(answered.backgroundStopPending).toEqual([]);
    // The ROW is untouched: only a `background` event may move it, so an
    // unconfirmed Stop still reads as running.
    expect(answered.backgroundWorkItems[0]?.state).toBe("running");
    expect(answered.backgroundWorkItems[0]?.stopState).toBe("none");
  });

  it("records a protected-turn wait for the owner, and clears it later", () => {
    const sent = reduceAssistantState(createInitialState(), {
      kind: "backgroundStopSent",
      ownerSessionId: "owner-a",
    });
    expect(sent.backgroundStopAllPending).toEqual(["owner-a"]);
    const waiting = apply(sent, {
      type: "backgroundWorkStopAnswer",
      requestId: "r2",
      ownerSessionId: "owner-a",
      items: [],
      hostCloseWaiting: { protectedTurn: true },
    });
    expect(waiting.backgroundStopAllPending).toEqual([]);
    expect(waiting.backgroundHostCloseWaiting).toEqual(["owner-a"]);

    const cleared = apply(waiting, {
      type: "backgroundWorkStopAnswer",
      requestId: "r3",
      ownerSessionId: "owner-a",
      items: [],
    });
    expect(cleared.backgroundHostCloseWaiting).toEqual([]);
  });

  it("does not treat a deferred close with no protected turn as one", () => {
    const waiting = apply(createInitialState(), {
      type: "backgroundWorkStopAnswer",
      requestId: "r4",
      ownerSessionId: "owner-a",
      items: [],
      hostCloseWaiting: { protectedTurn: false },
    });
    expect(waiting.backgroundHostCloseWaiting).toEqual([]);
  });
});
