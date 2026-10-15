/**
 * The reducer half of the `initiatives` topic (docs/initiatives.md): the
 * subscribe snapshot is authoritative, events apply by revision through the
 * shared `applyEvent` seam, and an unchanged echo keeps every identity.
 *   pnpm --filter @assistant/web test src/hooks/initiativeStateSync.test.ts
 */
import { describe, expect, it } from "vitest";
import type { InitiativeSummary, ServerMessage } from "@assistant/shared";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

function summary(
  partial: Partial<InitiativeSummary> & { id: string },
): InitiativeSummary {
  return {
    title: `Initiative ${partial.id}`,
    state: "active",
    progress: { total: 3, done: 1, doing: 1, startable: 1, blocked: 0 },
    sessionIds: [],
    updatedAt: 1_800_000_000_000,
    ...partial,
  };
}

const apply = (state = createInitialState(), ...messages: ServerMessage[]) =>
  messages.reduce(
    (current, msg) => reduceAssistantState(current, { kind: "server", msg }),
    state,
  );

const snapshot = (items: InitiativeSummary[]): ServerMessage => ({
  type: "initiativeList",
  items,
  seq: 1,
  revisions: items.map((item) => ({ id: item.id, revision: 1 })),
});

describe("the initiatives projection", () => {
  it("takes the subscribe snapshot as authoritative", () => {
    const state = apply(undefined, snapshot([summary({ id: "1" })]));
    expect(state.initiatives.map((item) => item.id)).toEqual(["1"]);
    expect(state.stateEventRevisions.initiatives).toEqual({ "1": 1 });
  });

  it("applies newer events and keeps identity for an unchanged echo", () => {
    const seeded = apply(
      undefined,
      snapshot([summary({ id: "1" }), summary({ id: "2" })]),
    );
    const untouched = seeded.initiatives[0];
    const moved = apply(seeded, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 2,
      events: [
        {
          kind: "upsert",
          id: "2",
          revision: 2,
          item: summary({
            id: "2",
            progress: { total: 3, done: 2, doing: 0, startable: 1, blocked: 0 },
          }),
        },
        { kind: "upsert", id: "3", revision: 2, item: summary({ id: "3" }) },
      ],
    });
    expect(moved.initiatives[0]).toBe(untouched);
    expect(moved.initiatives.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(moved.initiatives[1]!.progress.done).toBe(2);

    // A stale or equal revision is an exact no-op.
    const stale = apply(moved, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 3,
      events: [{ kind: "delete", id: "2", revision: 2 }],
    });
    expect(stale).toBe(moved);

    // An echo with a newer revision but the same wire value keeps the row.
    const row = moved.initiatives[2];
    const echo = apply(moved, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 3,
      events: [
        { kind: "upsert", id: "3", revision: 3, item: summary({ id: "3" }) },
      ],
    });
    expect(echo.initiatives[2]).toBe(row);
    expect(echo.stateEventRevisions.initiatives?.["3"]).toBe(3);

    const archived = apply(echo, {
      type: "stateItems",
      topic: "initiatives",
      requestId: "r",
      events: [{ kind: "delete", id: "1", revision: 4 }],
    });
    expect(archived.initiatives.map((item) => item.id)).toEqual(["2", "3"]);
  });

  it("leaves Task and Project state alone", () => {
    const seeded = apply(undefined, snapshot([summary({ id: "1" })]));
    const next = apply(seeded, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 2,
      events: [{ kind: "delete", id: "1", revision: 2 }],
    });
    expect(next.taskList).toBe(seeded.taskList);
    expect(next.projectList).toBe(seeded.projectList);
    expect(next.stateEventRevisions.tasks).toBe(
      seeded.stateEventRevisions.tasks,
    );
  });
});
