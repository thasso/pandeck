/**
 * The reducer half of the always-held `schedules` topic (docs/schedules.md):
 * a snapshot is authoritative, a newly seen row goes last, a same-revision echo
 * keeps the held row, a delete removes it, and a digest prunes what it leaves
 * out and its catch-up applies the rest. Nothing renders the list yet. The
 * generic mechanics are the replica contract's (`lib/stateReplica.test.ts`).
 *   pnpm --filter @assistant/web test src/hooks/scheduleStateSync.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

function summary(
  partial: Partial<ScheduleSummary> & { id: string },
): ScheduleSummary {
  return {
    name: `Schedule ${partial.id}`,
    prompt: "Check CI",
    enabled: true,
    timing: { kind: "daily", time: "09:00", timeZone: "UTC" },
    target: { kind: "session", sessionId: "s1" },
    createdBy: { kind: "user" },
    controlledBy: { kind: "user" },
    cardless: false,
    nextDueAtMs: 1_800_000_000_000,
    createdAtMs: 1_799_000_000_000,
    updatedAtMs: 1_799_000_000_000,
    ...partial,
  };
}

const apply = (state = createInitialState(), ...messages: ServerMessage[]) =>
  messages.reduce(
    (current, msg) => reduceAssistantState(current, { kind: "server", msg }),
    state,
  );

const snapshot = (items: ScheduleSummary[]): ServerMessage => ({
  type: "scheduleList",
  items,
  seq: 1,
  revisions: items.map((item) => ({ id: item.id, revision: 1 })),
});

describe("the schedules projection", () => {
  it("starts empty and takes the subscribe snapshot as authoritative", () => {
    expect(createInitialState().schedules).toEqual([]);
    const state = apply(
      undefined,
      snapshot([summary({ id: "sch_1" }), summary({ id: "sch_2" })]),
    );
    expect(state.schedules.map((item) => item.id)).toEqual(["sch_1", "sch_2"]);
    expect(state.stateEventRevisions.schedules).toEqual({
      sch_1: 1,
      sch_2: 1,
    });
  });

  it("appends a new row, keeps a same-revision echo's identity and applies a delete", () => {
    const seeded = apply(
      undefined,
      snapshot([summary({ id: "sch_1" }), summary({ id: "sch_2" })]),
    );
    const echoed = apply(seeded, {
      type: "stateEvents",
      topic: "schedules",
      seq: 2,
      events: [
        {
          kind: "upsert",
          id: "sch_1",
          revision: 1,
          item: summary({ id: "sch_1" }),
        },
      ],
    });
    expect(echoed.schedules[0]).toBe(seeded.schedules[0]);

    const next = apply(seeded, {
      type: "stateEvents",
      topic: "schedules",
      seq: 2,
      events: [
        {
          kind: "upsert",
          id: "sch_3",
          revision: 2,
          item: summary({ id: "sch_3" }),
        },
        { kind: "delete", id: "sch_2", revision: 3 },
      ],
    });
    expect(next.schedules.map((item) => item.id)).toEqual(["sch_1", "sch_3"]);
    expect(next.schedules[0]).toBe(seeded.schedules[0]);
    expect(next.stateEventRevisions.schedules).toMatchObject({
      sch_1: 1,
      sch_3: 2,
    });
  });

  it("prunes what a digest leaves out and applies its catch-up", () => {
    const seeded = apply(
      undefined,
      snapshot([
        summary({ id: "sch_1" }),
        summary({ id: "sch_2" }),
        summary({ id: "sch_3" }),
      ]),
    );
    const digested = apply(seeded, {
      type: "stateDigest",
      topic: "schedules",
      seq: 5,
      entries: [
        { id: "sch_1", revision: 1 },
        { id: "sch_3", revision: 4 },
      ],
    });
    expect(digested.schedules.map((item) => item.id)).toEqual([
      "sch_1",
      "sch_3",
    ]);
    expect(digested.schedules[0]).toBe(seeded.schedules[0]);

    const caughtUp = reduceAssistantState(digested, {
      kind: "replicaItems",
      purpose: "catchUp",
      msg: {
        type: "stateItems",
        topic: "schedules",
        requestId: "r",
        events: [
          {
            kind: "upsert",
            id: "sch_3",
            revision: 4,
            item: summary({ id: "sch_3", name: "Renamed", enabled: false }),
          },
        ],
      },
    });
    expect(caughtUp.schedules.map((item) => item.name)).toEqual([
      "Schedule sch_1",
      "Renamed",
    ]);
    expect(caughtUp.stateEventRevisions.schedules).toEqual({
      sch_1: 1,
      sch_3: 4,
    });
  });

  it("leaves the other topics alone", () => {
    const initial = createInitialState();
    const next = apply(initial, snapshot([summary({ id: "sch_1" })]));
    expect(next.sessions).toBe(initial.sessions);
    expect(next.initiatives).toBe(initial.initiatives);
    expect(next.taskList).toBe(initial.taskList);
  });
});
