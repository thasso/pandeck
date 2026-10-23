// @vitest-environment jsdom
/**
 * The Tasks topic on the replica transport, through the real socket effect:
 * catch-up, the snapshot resubscribe that replaced every `listTasks` sync read,
 * and the silent, coalesced resync a failed optimistic Task mutation sends.
 *   pnpm --filter @assistant/web test src/taskSyncScenario.test.tsx
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  TaskItem,
  TaskSummary,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { writeAppShellCacheRecord } from "./lib/appShellCacheStore.ts";
import { getToasts } from "./lib/toast.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class ScenarioSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: ScenarioSocket[] = [];
  readyState = ScenarioSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    ScenarioSocket.instances.push(this);
  }
  open() {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(source: string) {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  };
}

/** `MUTATION_SETTLE_TIMEOUT_MS` in `useAssistant`. */
const MUTATION_SETTLE_TIMEOUT_MS = 30_000;

let latestActions: AssistantActions;
let latestState: UIState;

function TaskHarness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  useEffect(() => actions.setTopics(["tasks"]), [actions]);
  return null;
}

async function connected() {
  await act(async () => root.render(<TaskHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  return socket;
}

const summary = (
  id: string,
  patch: Partial<TaskSummary> = {},
): TaskSummary => ({
  id,
  title: `Task ${id}`,
  status: "todo",
  createdAt: 1,
  updatedAt: 1,
  source: { createdBy: "user" },
  ...patch,
});
const snapshot = (
  seq: number,
  items: TaskSummary[],
  revisions = items.map(({ id }) => ({ id, revision: 1 })),
) =>
  ({
    type: "taskList",
    list: { request: {}, items, updatedAt: seq },
    seq,
    revisions,
  }) satisfies ServerMessage;
const pair: ClientMessage[] = [
  { type: "unsubscribe", topics: ["tasks"] },
  { type: "subscribe", topics: ["tasks"] },
];
const taskSubscribes = (messages: ClientMessage[]) =>
  messages.filter(
    (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
      message.type === "subscribe" && message.topics.includes("tasks"),
  );
const itemFetch = (messages: ClientMessage[]) => {
  const fetch = messages.findLast(
    (message) => message.type === "getStateItems" && message.topic === "tasks",
  );
  if (fetch?.type !== "getStateItems") throw new Error("no item fetch");
  return fetch;
};
/** The request id of the last `type` command sent. */
const requestOf = (socket: ScenarioSocket, type: ClientMessage["type"]) => {
  const command = socket.sent.findLast((message) => message.type === type);
  const requestId =
    command && "requestId" in command ? command.requestId : undefined;
  if (!requestId) throw new Error(`no ${type}`);
  return requestId;
};
const reject = (socket: ScenarioSocket, type: ClientMessage["type"]) =>
  socket.receive({
    type: "error",
    requestId: requestOf(socket, type),
    message: "Rejected",
  });
const rowIds = () => latestState.taskList?.items.map((item) => item.id);
/** The shell cache's Task admission: a revision for every held row. */
const cacheAdmits = () =>
  Boolean(
    latestState.taskList?.items.every((item) =>
      Number.isSafeInteger(latestState.stateEventRevisions.tasks?.[item.id]),
    ),
  );
/** Drop `tasks` and take it again; what the re-take sent. */
async function retake(socket: ScenarioSocket) {
  await act(async () => latestActions.setTopics([]));
  const at = socket.sent.length;
  await act(async () => latestActions.setTopics(["tasks"]));
  return taskSubscribes(socket.sent.slice(at));
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  // No Task list survives from another case.
  writeAppShellCacheRecord({
    version: 1,
    savedAt: Date.now(),
    models: [],
    agents: [],
    sessions: [],
    settings: {},
    slashCommands: [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Tasks on the replica transport", () => {
  it("catches a digest up with one item fetch and keeps the seq", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "tasks",
        seq: 4,
        entries: [
          { id: "a", revision: 1 },
          { id: "b", revision: 2 },
        ],
      }),
    );
    const fetch = itemFetch(socket.sent);
    expect(fetch.ids).toEqual(["b"]);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "tasks",
        requestId: fetch.requestId,
        events: [
          {
            kind: "upsert",
            id: "b",
            revision: 2,
            item: summary("b", { title: "Changed" }),
          },
        ],
      }),
    );
    expect(latestState.taskList?.items[1]?.title).toBe("Changed");
    expect(latestState.taskListFresh).toBe(true);
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 5,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: summary("a", { title: "Moved" }),
          },
        ],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("resubscribes, not listTasks, when a digest meets an untrusted baseline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () =>
      socket.receive(
        snapshot(3, [summary("a"), summary("b")], [{ id: "a", revision: 1 }]),
      ),
    );
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "tasks",
        seq: 4,
        entries: [{ id: "a", revision: 1 }],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(pair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] tasks digest fallback: cached objects or revisions were invalid",
    );
    expect(socket.sent.some((message) => message.type === "listTasks")).toBe(
      false,
    );
  });

  it("resubscribes when a catch-up answers incompletely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => socket.receive(snapshot(3, [summary("a")])));
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "tasks",
        seq: 4,
        entries: [{ id: "a", revision: 2 }],
      }),
    );
    const fetch = itemFetch(socket.sent);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "tasks",
        requestId: fetch.requestId,
        events: [],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(pair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] tasks digest fallback: targeted item response was incomplete",
    );
  });

  it("resubscribes a gap without a digest, even over a safe baseline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => socket.receive(snapshot(3, [summary("a")])));
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 5,
        events: [],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(pair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] tasks event gap: expected seq 4, got 5; resubscribing.",
    );
  });

  it("sends nothing for a dropped topic's catch-up that times out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => socket.receive(snapshot(3, [summary("a")])));
    vi.useFakeTimers();
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "tasks",
        seq: 4,
        entries: [{ id: "a", revision: 2 }],
      }),
    );
    itemFetch(socket.sent);
    await act(async () => latestActions.setTopics([]));
    const droppedAt = socket.sent.length;
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(socket.sent.slice(droppedAt)).toEqual([]);
  });

  it("refuses a filtered list as a snapshot and keeps the seq", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    const rows = latestState.taskList;
    await act(async () =>
      socket.receive({
        type: "taskList",
        list: {
          request: { status: "done" },
          items: [summary("z")],
          updatedAt: 99,
        },
        seq: 99,
        revisions: [],
      }),
    );
    expect(latestState.taskList).toBe(rows);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 4,
        events: [],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("unknown Task outcomes", () => {
  it.each(["edit", "create", "assignment", "reorder"])(
    "releases %s and joins the reconnect snapshot without replay",
    async (operation) => {
      const socket = await connected();
      await act(async () =>
        socket.receive(snapshot(3, [summary("a"), summary("b")])),
      );
      vi.useFakeTimers();
      const toasts = getToasts();
      await act(async () => {
        if (operation === "edit")
          latestActions.saveTask({
            id: "a",
            title: "Optimistic",
            status: "todo",
          });
        if (operation === "create")
          latestActions.saveTask({ title: "New", status: "todo" });
        if (operation === "assignment")
          latestActions.assignTaskProjects([{ id: "a", projectId: "p" }]);
        if (operation === "reorder")
          latestActions.reorderTasks(
            ["b", "a"],
            [
              { id: "b", parentId: null },
              { id: "a", parentId: null },
            ],
          );
      });
      const optimisticIds = rowIds();
      const optimisticRows = latestState.taskList?.items;
      await act(async () => socket.close());
      expect(
        Object.values(latestState.taskMutations).map((value) => value.status),
      ).toEqual(["idle"]);
      expect(rowIds()).toEqual(optimisticIds);
      expect(latestState.taskList?.items).toBe(optimisticRows);
      expect(cacheAdmits()).toBe(false);
      expect(getToasts()).toEqual(toasts);
      const offlineAt = socket.sent.length;
      await act(async () => vi.advanceTimersByTime(30_000));
      expect(socket.sent.slice(offlineAt)).toEqual([]);
      expect(Object.values(latestState.taskMutations)[0]?.status).toBe("idle");
      const next = ScenarioSocket.instances[1]!;
      await act(async () => next.open());
      expect(next.sent).toEqual([{ type: "subscribe", topics: ["tasks"] }]);
      await act(async () =>
        next.receive(snapshot(4, [summary("a"), summary("b")])),
      );
      expect(latestState.taskList?.items).toEqual([summary("a"), summary("b")]);
      expect(await retake(next)).toEqual([
        { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
      ]);
      expect(getToasts()).toEqual(toasts);
    },
  );

  it("drops an old snapshot wait, coalesces all recovery, and recovers membership-only writes", async () => {
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    vi.useFakeTimers();
    await act(async () => latestActions.saveTask({ id: "a", status: "doing" }));
    await act(async () => reject(socket, "saveTask"));
    await act(async () => {
      latestActions.archiveTask("a");
      latestActions.deleteTask("b");
    });
    expect(rowIds()).toEqual([]);
    await act(async () => socket.close());
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(next.sent).toEqual([{ type: "subscribe", topics: ["tasks"] }]);
    await act(async () =>
      next.receive({
        type: "error",
        message: "Read failed",
        target: { type: "task" },
      }),
    );
    expect(latestState.taskListError).toBe("Read failed");
    expect(next.sent).toHaveLength(1);
    await act(async () => latestActions.saveTask({ id: "a", status: "done" }));
    const at = next.sent.length;
    await act(async () => reject(next, "saveTask"));
    expect(next.sent.slice(at)).toEqual(pair);
    await act(async () => next.close());
    await act(async () => vi.advanceTimersByTime(30_000));
    const third = ScenarioSocket.instances[2]!;
    await act(async () => third.open());
    expect(third.sent).toEqual([{ type: "subscribe", topics: ["tasks"] }]);
  });

  it("does not revive an unheld topic and ignores a retired id beside a new same-key write", async () => {
    const socket = await connected();
    await act(async () => socket.receive(snapshot(3, [summary("a")])));
    vi.useFakeTimers();
    await act(async () =>
      latestActions.saveTask({ id: "a", title: "Unknown", status: "todo" }),
    );
    const oldId = requestOf(socket, "saveTask");
    await act(async () => latestActions.setTopics([]));
    await act(async () => socket.close());
    expect(cacheAdmits()).toBe(false);
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(next.sent).toEqual([]);
    await act(async () => latestActions.setTopics(["tasks"]));
    expect(next.sent).toEqual([{ type: "subscribe", topics: ["tasks"] }]);
    await act(async () =>
      latestActions.saveTask({ id: "a", title: "Retry", status: "todo" }),
    );
    await act(async () =>
      next.receive({ type: "mutationSettled", requestId: oldId }),
    );
    expect(Object.values(latestState.taskMutations)[0]?.status).toBe("loading");
  });
});

describe("a failed optimistic Task mutation", () => {
  it("resyncs silently with one pair that later failures join", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    const start = socket.sent.length;

    await act(async () => {
      latestActions.deleteTask("b");
      latestActions.archiveTask("a");
    });
    expect(rowIds()).toEqual([]);
    let mark = socket.sent.length;
    await act(async () => reject(socket, "deleteTask"));
    expect(socket.sent.slice(mark)).toEqual(pair);
    mark = socket.sent.length;
    await act(async () => reject(socket, "archiveTask"));
    expect(socket.sent.slice(mark)).toEqual([]);
    // A stamped failure naming the collection is a mutation's, not the
    // snapshot read's: it joins the open pair too.
    await act(async () => latestActions.reorderTasks(["b", "a"]));
    mark = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: requestOf(socket, "reorderTasks"),
        message: "Reorder rejected",
        target: { type: "task" },
      }),
    );
    expect(socket.sent.slice(mark)).toEqual([]);
    await act(async () =>
      socket.receive(snapshot(4, [summary("a"), summary("b")])),
    );
    expect(rowIds()).toEqual(["a", "b"]);

    vi.useFakeTimers();
    await act(async () => latestActions.reorderTasks(["b", "a"]));
    mark = socket.sent.length;
    await act(async () => vi.advanceTimersByTime(MUTATION_SETTLE_TIMEOUT_MS));
    expect(socket.sent.slice(mark)).toEqual(pair);
    await act(async () =>
      socket.receive(snapshot(5, [summary("a"), summary("b")])),
    );

    await act(async () =>
      latestActions.saveTask({ title: "New", status: "todo" }),
    );
    expect(rowIds()).toHaveLength(3);
    expect(rowIds()![0]).toMatch(/^optimistic-/);
    mark = socket.sent.length;
    await act(async () => reject(socket, "saveTask"));
    expect(socket.sent.slice(mark)).toEqual(pair);
    await act(async () =>
      socket.receive(snapshot(6, [summary("a"), summary("b")])),
    );
    expect(rowIds()).toEqual(["a", "b"]);

    // Holds are untouched: every unsubscribe belongs to a pair, and nothing
    // read the list.
    const after = socket.sent.slice(start);
    expect(
      after.filter((message) => message.type === "unsubscribe"),
    ).toHaveLength(3);
    expect(taskSubscribes(after)).toEqual([pair[1], pair[1], pair[1]]);
    expect(after.some((message) => message.type === "listTasks")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats other pending mutations against the snapshot as a list read did", async () => {
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    await act(async () =>
      latestActions.saveTask({ id: "a", title: "Edited", status: "todo" }),
    );
    expect(latestState.taskList?.items[0]?.title).toBe("Edited");
    const edit = requestOf(socket, "saveTask");
    await act(async () => latestActions.archiveTask("b"));
    const mark = socket.sent.length;
    await act(async () => reject(socket, "archiveTask"));
    expect(socket.sent.slice(mark)).toEqual(pair);

    await act(async () =>
      socket.receive(snapshot(4, [summary("a"), summary("b")])),
    );
    // The snapshot replaces the edit's optimism, as `taskList` always did.
    expect(latestState.taskList?.items.map((item) => item.title)).toEqual([
      "Task a",
      "Task b",
    ]);
    // The edit is still pending, so a re-take asks for no Task digest.
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"] },
    ]);

    const saved: TaskItem = {
      ...summary("a", { title: "Edited", updatedAt: 2 }),
      description: "",
    };
    await act(async () =>
      socket.receive({
        type: "taskSaved",
        item: saved,
        revision: 2,
        requestId: edit,
      }),
    );
    expect(latestState.taskList?.items[0]?.title).toBe("Edited");
  });

  it("sends nothing while unheld but leaves the list no baseline", async () => {
    const socket = await connected();
    await act(async () => socket.receive(snapshot(3, [summary("a")])));
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);

    await act(async () => latestActions.setTopics([]));
    await act(async () =>
      latestActions.saveTask({ id: "a", title: "Edited", status: "todo" }),
    );
    const mark = socket.sent.length;
    await act(async () => reject(socket, "saveTask"));
    expect(socket.sent.slice(mark)).toEqual([]);
    expect(latestState.stateEventRevisions.tasks).not.toHaveProperty("a");
    expect(latestState.taskList?.items[0]?.title).toBe("Edited");
    expect(cacheAdmits()).toBe(false);

    const takenAt = socket.sent.length;
    await act(async () => latestActions.setTopics(["tasks"]));
    expect(taskSubscribes(socket.sent.slice(takenAt))).toEqual([
      { type: "subscribe", topics: ["tasks"] },
    ]);
    await act(async () => socket.receive(snapshot(4, [summary("a")])));
    expect(latestState.taskList?.items[0]?.title).toBe("Task a");
    expect(latestState.stateEventRevisions.tasks).toEqual({ a: 1 });
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);
  });

  it("sends a fresh pair after the awaited snapshot read failed, and only then", async () => {
    const socket = await connected();
    await act(async () =>
      socket.receive(snapshot(3, [summary("a"), summary("b")])),
    );
    vi.useFakeTimers();
    await act(async () => latestActions.archiveTask("a"));
    let mark = socket.sent.length;
    await act(async () => reject(socket, "archiveTask"));
    expect(socket.sent.slice(mark)).toEqual(pair);

    mark = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to list tasks: boom",
        target: { type: "task" },
      }),
    );
    expect(latestState.taskListError).toBe("Failed to list tasks: boom");
    expect(socket.sent.slice(mark)).toEqual([]);
    // No retry loop.
    await act(async () => vi.advanceTimersByTime(10_001));
    expect(socket.sent.slice(mark)).toEqual([]);

    await act(async () => latestActions.deleteTask("b"));
    mark = socket.sent.length;
    await act(async () => reject(socket, "deleteTask"));
    expect(socket.sent.slice(mark)).toEqual(pair);
    await act(async () =>
      socket.receive(snapshot(4, [summary("a"), summary("b")])),
    );
    expect(rowIds()).toEqual(["a", "b"]);
    expect(latestState.taskListError).toBeNull();
    expect(await retake(socket)).toEqual([
      { type: "subscribe", topics: ["tasks"], digests: ["tasks"] },
    ]);
  });
});
