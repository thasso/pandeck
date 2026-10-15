import { describe, expect, it } from "vitest";
import { taskSummaryOf, type TaskItem } from "@assistant/shared";
import {
  createInitialState,
  reduceAssistantState,
  TASK_PROJECTION_CACHE_LIMIT,
} from "./useAssistant.ts";
import { dataOf } from "../lib/loadState.ts";

function task(id: string, updatedAt = 1): TaskItem {
  return {
    id,
    title: `Task ${id}`,
    status: "todo",
    source: { createdBy: "user" },
    description: `Body ${id}`,
    createdAt: 1,
    updatedAt,
  };
}

describe("Task keyed projections", () => {
  it("retains a body and marks it refreshing when a newer summary arrives", () => {
    const item = task("1", 1);
    const loaded = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: { type: "taskDetail", id: item.id, item, requestId: "first" },
    });
    const stale = reduceAssistantState(loaded, {
      kind: "server",
      msg: {
        type: "taskList",
        list: {
          items: [taskSummaryOf({ ...item, updatedAt: 2 })],
          updatedAt: 2,
          request: {},
        },
        seq: 1,
        revisions: [{ id: item.id, revision: 2 }],
      },
    });

    expect(stale.taskDetails[item.id]?.status).toBe("refreshing");
    expect(dataOf(stale.taskDetails[item.id]!)).toBe(item);
  });

  it("distinguishes not found from a failed refresh with retained data", () => {
    const item = task("1");
    const loaded = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: { type: "taskDetail", id: item.id, item },
    });
    const failed = reduceAssistantState(loaded, {
      kind: "server",
      msg: {
        type: "taskDetail",
        id: item.id,
        item: null,
        error: "read failed",
      },
    });
    expect(failed.taskDetails[item.id]?.status).toBe("error");
    expect(dataOf(failed.taskDetails[item.id]!)).toBe(item);

    const missing = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: { type: "taskDetail", id: "missing", item: null },
    });
    expect(missing.taskDetails.missing).toEqual({
      status: "ready",
      data: null,
    });
  });

  it("bounds the body cache by least-recently-used key", () => {
    let state = createInitialState();
    for (let index = 0; index <= TASK_PROJECTION_CACHE_LIMIT; index += 1) {
      const id = String(index);
      state = reduceAssistantState(state, {
        kind: "server",
        msg: { type: "taskDetail", id, item: task(id) },
      });
    }

    expect(Object.keys(state.taskDetails)).toHaveLength(
      TASK_PROJECTION_CACHE_LIMIT,
    );
    expect(state.taskDetails["0"]).toBeUndefined();
    expect(
      state.taskDetails[String(TASK_PROJECTION_CACHE_LIMIT)],
    ).toBeDefined();
  });

  it("never evicts the open Task from the ready body cache", () => {
    let state = createInitialState();
    state = reduceAssistantState(state, {
      kind: "server",
      msg: { type: "taskDetail", id: "0", item: task("0") },
    });
    state = reduceAssistantState(state, {
      kind: "setOpenTaskProjection",
      id: "0",
    });

    for (let index = 1; index <= TASK_PROJECTION_CACHE_LIMIT; index += 1) {
      const id = String(index);
      state = reduceAssistantState(state, {
        kind: "server",
        msg: { type: "taskDetail", id, item: task(id) },
      });
    }

    expect(state.taskDetails["0"]).toBeDefined();
    expect(state.taskDetails["1"]).toBeUndefined();
  });

  describe("a body is as fresh as the revision it was read at", () => {
    /** The Backlog list holding `item`, at `revision`. */
    function listed(item: TaskItem, revision: number) {
      return reduceAssistantState(createInitialState(), {
        kind: "server",
        msg: {
          type: "taskList",
          list: {
            items: [taskSummaryOf(item)],
            updatedAt: item.updatedAt,
            request: {},
          },
          seq: 1,
          revisions: [{ id: item.id, revision }],
        },
      });
    }

    function event(item: TaskItem, revision: number) {
      return {
        kind: "server" as const,
        msg: {
          type: "stateEvents" as const,
          topic: "tasks" as const,
          seq: 2,
          events: [
            {
              kind: "upsert" as const,
              id: item.id,
              revision,
              item: taskSummaryOf(item),
            },
          ],
        },
      };
    }

    it("re-reads a body on a newer event whose summary and updatedAt did not move", () => {
      // A linked Task was renamed: this Task's revision moved, nothing else.
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item,
        revision: 4,
      });
      expect(state.taskDetails[item.id]?.status).toBe("ready");

      state = reduceAssistantState(state, event(item, 5));
      expect(state.taskDetails[item.id]?.status).toBe("refreshing");
      expect(dataOf(state.taskDetails[item.id]!)).toBe(item);
    });

    it("keeps a saved body ready when the save's own event echoes it", () => {
      const item = task("1", 1);
      let state = listed(item, 4);
      const saved = { ...item, title: "Renamed", updatedAt: 2 };
      state = reduceAssistantState(state, {
        kind: "taskSaved",
        item: saved,
        revision: 5,
      });
      state = reduceAssistantState(state, event(saved, 5));
      expect(state.taskDetails[item.id]?.status).toBe("ready");
      expect(state.taskDetailRevisions[item.id]).toBe(5);
    });

    it("re-reads a reply that is older than an event already applied", () => {
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, event(item, 6));
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item,
        revision: 5,
      });
      expect(state.taskDetails[item.id]?.status).toBe("refreshing");
    });

    it("keeps the known revision when a refresh fails", () => {
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item,
        revision: 4,
      });
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item: null,
        error: "read failed",
      });
      expect(state.taskDetailRevisions[item.id]).toBe(4);
    });

    /** A full `taskList` snapshot — the reconnect / resync answer. */
    function snapshot(item: TaskItem, revision: number) {
      return {
        kind: "server" as const,
        msg: {
          type: "taskList" as const,
          list: {
            items: [taskSummaryOf(item)],
            updatedAt: item.updatedAt,
            request: {},
          },
          seq: 9,
          revisions: [{ id: item.id, revision }],
        },
      };
    }

    it("re-reads a body a reconnect snapshot carries a newer revision for", () => {
      // A linked Task was renamed while this tab was away: the snapshot has
      // the same summary and updatedAt, and revision 5 — and having advanced
      // the sidecar, it is the last chance to notice.
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item,
        revision: 4,
      });
      const same = reduceAssistantState(state, snapshot(item, 4));
      expect(same.taskDetails[item.id]?.status).toBe("ready");

      const newer = reduceAssistantState(state, snapshot(item, 5));
      expect(newer.taskDetails[item.id]?.status).toBe("refreshing");
      expect(dataOf(newer.taskDetails[item.id]!)).toBe(item);
    });

    it("leaves a body read without a revision to updatedAt", () => {
      // An older server sends no revision: a newer revision alone proves
      // nothing about the body, a newer updatedAt still does.
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: item.id,
        item,
      });
      expect(state.taskDetailRevisions[item.id]).toBeUndefined();

      state = reduceAssistantState(state, event(item, 5));
      expect(state.taskDetails[item.id]?.status).toBe("ready");
      state = reduceAssistantState(state, snapshot(item, 6));
      expect(state.taskDetails[item.id]?.status).toBe("ready");

      state = reduceAssistantState(state, event({ ...item, updatedAt: 2 }, 7));
      expect(state.taskDetails[item.id]?.status).toBe("refreshing");
    });

    it("re-reads an archived Task's body on a newer delete, and after a snapshot", () => {
      // The list never holds an archived Task; its open body hears about a
      // linked Task's change only through the revision a delete carries.
      const archived = { ...task("2", 1), archivedAt: 1 };
      let state = listed(task("1", 1), 4);
      state = reduceAssistantState(state, {
        kind: "taskDetailResult",
        id: archived.id,
        item: archived,
        revision: 3,
      });
      const deleted = reduceAssistantState(state, {
        kind: "server",
        msg: {
          type: "stateEvents",
          topic: "tasks",
          seq: 2,
          events: [{ kind: "delete", id: archived.id, revision: 6 }],
        },
      });
      expect(deleted.taskDetails[archived.id]?.status).toBe("refreshing");
      expect(deleted.taskList?.items.map((t) => t.id)).toEqual(["1"]);

      // A snapshot cannot vouch for a Task outside the live projection.
      const resynced = reduceAssistantState(state, snapshot(task("1", 1), 4));
      expect(resynced.taskDetails[archived.id]?.status).toBe("refreshing");
      expect(resynced.taskDetails["1"]).toBeUndefined();
    });

    it("re-reads a raw taskDetail older than an applied event, like the correlated reply", () => {
      const item = task("1", 1);
      let state = listed(item, 4);
      state = reduceAssistantState(state, event(item, 6));
      state = reduceAssistantState(state, {
        kind: "server",
        msg: { type: "taskDetail", id: item.id, item, revision: 5 },
      });
      expect(state.taskDetails[item.id]?.status).toBe("refreshing");
      expect(state.taskDetailRevisions[item.id]).toBe(5);
    });

    it("prunes the revision sidecar with the body cache", () => {
      let state = createInitialState();
      const reads = TASK_PROJECTION_CACHE_LIMIT + 10;
      for (let index = 0; index < reads; index += 1) {
        const id = String(index);
        state = reduceAssistantState(
          state,
          index % 3 === 0
            ? {
                kind: "server",
                msg: { type: "taskDetail", id, item: task(id), revision: 1 },
              }
            : index % 3 === 1
              ? {
                  kind: "taskDetailResult",
                  id,
                  item: task(id),
                  revision: 1,
                }
              : { kind: "taskSaved", item: task(id), revision: 1 },
        );
      }
      const cached = Object.keys(state.taskDetails).sort();
      expect(cached).toHaveLength(TASK_PROJECTION_CACHE_LIMIT);
      expect(Object.keys(state.taskDetailRevisions).sort()).toEqual(cached);
    });
  });
});
