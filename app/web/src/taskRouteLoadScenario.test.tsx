// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskSummaryOf,
  type ClientMessage,
  type ServerMessage,
  type TaskItem,
} from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { dataOf } from "./lib/loadState.ts";
import { topicsForSurface } from "./lib/broadcastTopics.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TaskScenarioSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: TaskScenarioSocket[] = [];

  readyState = TaskScenarioSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    TaskScenarioSocket.instances.push(this);
  }

  open(): void {
    this.readyState = TaskScenarioSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(source: string): void {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const TASK_A = task("a", 1);
const TASK_B = task("b", 1);

function task(id: string, updatedAt: number): TaskItem {
  return {
    id,
    title: `Task ${id.toUpperCase()}`,
    status: "todo",
    source: { createdBy: "user" },
    description: `Body ${id.toUpperCase()}`,
    createdAt: 1,
    updatedAt,
  };
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

function taskListMessage(
  items: TaskItem[] = [TASK_A, TASK_B],
): Extract<ServerMessage, { type: "taskList" }> {
  return {
    type: "taskList",
    list: {
      request: {},
      items: items.map(taskSummaryOf),
      updatedAt: Math.max(...items.map((item) => item.updatedAt)),
    },
    seq: 1,
    revisions: items.map((item) => ({
      id: item.id,
      revision: item.updatedAt,
    })),
  };
}

let latestState: UIState;
let latestActions: AssistantActions;

/**
 * The Task route's real socket/reducer seam, reduced to its ownership effects:
 * route topics, selected-id cache pin, and the freshness-aware detail read.
 * Rendering the full page would only add static
 * chrome and make protocol counts less legible.
 */
function TaskRouteHarness({ selectedId }: { selectedId: string | null }) {
  const { state, actions } = useAssistant();
  latestState = state;
  latestActions = actions;

  useEffect(() => {
    actions.setTopics(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName: "tasks",
      }),
    );
  }, [actions]);

  useEffect(() => {
    actions.setOpenTaskProjection(selectedId);
    return () => actions.setOpenTaskProjection(null);
  }, [actions, selectedId]);

  const detailState = selectedId ? state.taskDetails[selectedId] : undefined;
  useEffect(() => {
    if (!selectedId || !state.connected) return;
    if (
      !detailState ||
      detailState.status === "idle" ||
      detailState.status === "refreshing" ||
      (detailState.status === "error" &&
        detailState.error.startsWith("Connection lost"))
    )
      actions.requestTaskDetail(selectedId);
  }, [actions, detailState, selectedId, state.connected]);

  const detail = detailState ? dataOf(detailState) : undefined;
  return (
    <div>
      <span data-testid="selected-detail">{detail?.title ?? "pending"}</span>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  TaskScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", TaskScenarioSocket);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderHarness(element: ReactNode): Promise<TaskScenarioSocket> {
  await act(async () => root!.render(element));
  return TaskScenarioSocket.instances[0]!;
}

function sentOf<T extends ClientMessage["type"]>(
  socket: TaskScenarioSocket,
  type: T,
): Array<Extract<ClientMessage, { type: T }>> {
  return socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: T }> =>
      message.type === type,
  );
}

async function openReady(socket: TaskScenarioSocket): Promise<void> {
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive(taskListMessage());
  });
}

describe("Task-route socket load scenario", () => {
  it("owns one narrow subscription and one keyed read per cold/reconnect episode", async () => {
    vi.useFakeTimers();
    const first = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(first);

    expect(sentOf(first, "subscribe")).toEqual([
      { type: "subscribe", topics: ["tasks", "projects", "workflow"] },
    ]);
    expect(sentOf(first, "listTasks")).toEqual([]);
    expect(sentOf(first, "listProjects")).toEqual([]);
    expect(sentOf(first, "getTask")).toHaveLength(1);
    expect(sentOf(first, "subscribe")[0]!.topics).not.toContain("worktrees");
    await act(async () => {
      first.receive({
        type: "commentsSnapshot",
        target: {
          kind: "worktree",
          worktreeId: "wt-open",
          path: "",
          side: "new",
          revision: "",
        },
        threads: [],
        revisions: [],
      });
      first.close();
    });
    expect(latestState.taskDetails.a?.status).toBe("error");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const second = TaskScenarioSocket.instances[1]!;
    await act(async () => second.open());
    await act(async () => {});

    expect(sentOf(second, "subscribe")).toHaveLength(1);
    expect(sentOf(second, "subscribe")[0]!.topics).toEqual([
      "tasks",
      "projects",
      "workflow",
    ]);
    expect(sentOf(second, "subscribe")[0]!.digests).toEqual(["tasks"]);
    expect(sentOf(second, "getTask")).toHaveLength(1);
    expect(sentOf(second, "listComments")).toEqual([
      expect.objectContaining({
        type: "listComments",
        target: {
          kind: "worktree",
          worktreeId: "wt-open",
          path: "",
          side: "new",
          revision: "",
        },
        requestId: expect.any(String),
      }),
    ]);
    expect(sentOf(second, "listTasks")).toEqual([]);
    expect(sentOf(second, "listProjects")).toEqual([]);
  });

  it("uses one digest subscription for a warm canonical Backlog", async () => {
    window.localStorage.setItem(
      "assistant.appShellCache.v1",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        models: [],
        agents: [],
        sessions: [],
        settings: {},
        slashCommands: [],
        taskList: taskListMessage().list,
        taskRevisions: { a: 1, b: 1 },
      }),
    );
    const socket = await renderHarness(<TaskRouteHarness selectedId={null} />);
    await act(async () => socket.open());

    expect(sentOf(socket, "subscribe")).toEqual([
      {
        type: "subscribe",
        topics: ["tasks", "projects", "workflow"],
        digests: ["tasks"],
      },
    ]);
    expect(sentOf(socket, "listTasks")).toEqual([]);
    expect(sentOf(socket, "listProjects")).toEqual([]);
  });

  it("switches A→B without leaking A and reuses fresh A detail", async () => {
    const socket = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(socket);
    const detailA = sentOf(socket, "getTask")[0]!;

    await act(async () => root!.render(<TaskRouteHarness selectedId="b" />));
    expect(sentOf(socket, "getTask")).toHaveLength(2);

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: TASK_A,
        requestId: detailA.requestId,
      });
    });
    expect(container!.textContent).toContain("pending");
    expect(container!.textContent).not.toContain("Task A");
    expect(dataOf(latestState.taskDetails.a!)).toEqual(TASK_A);

    const detailB = sentOf(socket, "getTask")[1]!;
    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "b",
        item: TASK_B,
        requestId: detailB.requestId,
      });
    });
    expect(container!.textContent).toContain("Task B");

    await act(async () => root!.render(<TaskRouteHarness selectedId="a" />));
    // A's body answer was safe to cache by id, so returning reads nothing.
    expect(container!.textContent).toContain("Task A");
    expect(sentOf(socket, "getTask")).toHaveLength(2);

    await act(async () => {
      socket.receive(taskListMessage([task("a", 2), TASK_B]));
    });
    expect(sentOf(socket, "getTask")).toHaveLength(3);
    expect(sentOf(socket, "getTask")[2]!.id).toBe("a");
  });

  it("drops superseded same-id detail answers", async () => {
    const socket = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(socket);
    const firstDetail = sentOf(socket, "getTask")[0]!;

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: null,
        requestId: firstDetail.requestId,
        error: "first detail failed",
      });
      latestActions.requestTaskDetail("a");
    });
    const secondDetail = sentOf(socket, "getTask")[1]!;
    expect(secondDetail.requestId).not.toBe(firstDetail.requestId);

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: task("a", 99),
        requestId: firstDetail.requestId,
      });
    });
    expect(latestState.taskDetails.a?.status).toBe("loading");
    expect(container!.textContent).toContain("pending");

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: TASK_A,
        requestId: secondDetail.requestId,
      });
    });
    expect(dataOf(latestState.taskDetails.a!)).toEqual(TASK_A);
    expect(container!.textContent).toContain("Task A");
  });
});
