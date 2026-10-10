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
});
