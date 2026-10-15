/**
 * The reducer half of the `initiatives` topic (docs/initiatives.md): the
 * subscribe snapshot is authoritative, events apply by revision through the
 * shared `applyEvent` seam, and an unchanged echo keeps every identity.
 *   pnpm --filter @assistant/web test src/hooks/initiativeStateSync.test.ts
 */
import { describe, expect, it } from "vitest";
import type { InitiativeSummary, ServerMessage } from "@assistant/shared";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
} from "../../component-preview/fixtures/initiatives.ts";

function summary(
  partial: Partial<InitiativeSummary> & { id: string },
): InitiativeSummary {
  return {
    title: `Initiative ${partial.id}`,
    state: "active",
    progress: { total: 3, done: 1, doing: 1, startable: 1, blocked: 0 },
    sessionIds: [],
    sessionCount: 0,
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

describe("the keyed Initiative read", () => {
  const read = (state: ReturnType<typeof createInitialState>, id = "1") =>
    state.initiativeDetails[id];
  const answer = (
    state: ReturnType<typeof createInitialState>,
    revision: number | undefined,
    partial: Partial<{ layoutError: string; item: null; error: string }> = {},
  ) =>
    reduceAssistantState(state, {
      kind: "initiativeDetailResult",
      id: "1",
      read:
        partial.item === null
          ? null
          : {
              item: { ...HOSTED_LABS_DETAIL, id: "1" },
              ...(partial.layoutError
                ? { layoutError: partial.layoutError }
                : { layout: HOSTED_LABS_LAYOUT }),
            },
      ...(revision !== undefined ? { revision } : {}),
      ...(partial.error ? { error: partial.error } : {}),
    });
  const loaded = () => {
    const seeded = apply(undefined, snapshot([summary({ id: "1" })]));
    const loading = reduceAssistantState(seeded, {
      kind: "initiativeDetailLoad",
      id: "1",
    });
    expect(read(loading)?.status).toBe("loading");
    return answer(loading, 1);
  };

  it("re-reads on a newer Initiative revision and keeps the old graph meanwhile", () => {
    const held = loaded();
    expect(read(held)?.status).toBe("ready");
    const bumped = apply(held, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 2,
      events: [
        { kind: "upsert", id: "1", revision: 2, item: summary({ id: "1" }) },
      ],
    });
    const refreshing = read(bumped);
    expect(refreshing?.status).toBe("refreshing");
    expect(refreshing && "data" in refreshing && refreshing.data?.layout).toBe(
      HOSTED_LABS_LAYOUT,
    );
  });

  it("reads again when an answer predates a revision this tab already holds", () => {
    const held = loaded();
    const bumped = apply(held, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 2,
      events: [
        { kind: "upsert", id: "1", revision: 3, item: summary({ id: "1" }) },
      ],
    });
    // The read in flight was taken at revision 2: shown, and marked stale.
    expect(read(answer(bumped, 2))?.status).toBe("refreshing");
    expect(read(answer(bumped, 3))?.status).toBe("ready");
  });

  it("is not touched by a Task event: the Tasks topic recolours the map", () => {
    const held = loaded();
    const next = apply(held, {
      type: "stateEvents",
      topic: "tasks",
      seq: 1,
      events: [
        {
          kind: "upsert",
          id: HOSTED_LABS_DETAIL.nodes[1]!.id,
          revision: 9,
          item: {
            id: HOSTED_LABS_DETAIL.nodes[1]!.id,
            title: "x",
            status: "done",
            source: { createdBy: "user" },
            createdAt: 1,
            updatedAt: 2,
          },
        },
      ],
    });
    expect(next.initiativeDetails).toBe(held.initiativeDetails);
  });

  it("lets a snapshot that leaves an Initiative out re-read it", () => {
    const held = loaded();
    const resubscribed = apply(held, snapshot([summary({ id: "2" })]));
    expect(read(resubscribed)?.status).toBe("refreshing");
    // An unchanged revision in the snapshot re-reads nothing.
    const same = apply(held, snapshot([summary({ id: "1" })]));
    expect(same.initiativeDetails).toBe(held.initiativeDetails);
  });

  it("answers a deleted Initiative as ready(null) after its delete event", () => {
    const held = loaded();
    const deleted = apply(held, {
      type: "stateEvents",
      topic: "initiatives",
      seq: 2,
      events: [{ kind: "delete", id: "1", revision: 2 }],
    });
    expect(read(deleted)?.status).toBe("refreshing");
    const gone = answer(deleted, undefined, { item: null });
    expect(read(gone)).toEqual({ status: "ready", data: null });
  });

  it("keeps the graph with a layout error, and the data through a failure", () => {
    const seeded = apply(undefined, snapshot([summary({ id: "1" })]));
    const failedLayout = answer(seeded, 1, {
      layoutError: "The layout timed out; it is laid out again shortly.",
    });
    const value = read(failedLayout);
    expect(value?.status).toBe("ready");
    expect(value && "data" in value ? value.data?.layoutError : null).toMatch(
      /timed out/,
    );
    const lost = answer(
      reduceAssistantState(failedLayout, {
        kind: "initiativeDetailLoad",
        id: "1",
      }),
      undefined,
      { item: null, error: "Connection lost while loading this Initiative." },
    );
    const kept = read(lost);
    expect(kept?.status).toBe("error");
    expect(kept && "data" in kept ? kept.data?.item.id : null).toBe("1");
  });

  it("keeps at most a few reads, never the open one", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "setOpenInitiative",
      id: "open",
    });
    for (const id of ["open", "a", "b", "c", "d", "e", "f", "g", "h"])
      state = reduceAssistantState(state, {
        kind: "initiativeDetailResult",
        id,
        read: null,
        revision: 1,
      });
    expect(Object.keys(state.initiativeDetails)).toContain("open");
    expect(Object.keys(state.initiativeDetails).length).toBeLessThanOrEqual(7);
    expect(Object.keys(state.initiativeDetailRevisions).sort()).toEqual(
      Object.keys(state.initiativeDetails).sort(),
    );
  });
});
