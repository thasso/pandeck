// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskSummaryOf,
  type ClientMessage,
  type CommentThread,
  type ServerMessage,
  type TaskComment,
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

function comment(taskId: string, body: string): TaskComment {
  return {
    id: `${taskId}-${body}`,
    taskId,
    author: { kind: "user", name: "User" },
    body,
    createdAt: 1,
  };
}

function commentThread(taskId: string, body: string): CommentThread {
  const row = comment(taskId, body);
  return {
    id: row.id,
    target: { kind: "task", taskId },
    status: "open",
    root: {
      id: row.id,
      author: row.author,
      body: row.body,
      createdAt: row.createdAt,
    },
    replies: [],
    handoffSessionIds: [],
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
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
 * route topics, selected-id cache pin, freshness-aware detail read, and the
 * open/close Activity watch. Rendering the full page would only add static
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

  useEffect(() => {
    if (!selectedId) return;
    return () => actions.unwatchTaskComments(selectedId);
  }, [actions, selectedId]);

  useEffect(() => {
    if (!selectedId || !state.connected) return;
    actions.listTaskComments(selectedId);
  }, [actions, selectedId, state.connected]);

  const detail = detailState ? dataOf(detailState) : undefined;
  const commentsState = selectedId ? state.taskComments[selectedId] : undefined;
  const comments = commentsState ? dataOf(commentsState) : undefined;
  return (
    <div>
      <span data-testid="selected-detail">{detail?.title ?? "pending"}</span>
      <span data-testid="selected-comments">
        {comments?.map((entry) => entry.body).join(",") ?? "pending"}
      </span>
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
    expect(sentOf(first, "listComments")).toHaveLength(1);
    expect(sentOf(first, "subscribe")[0]!.topics).not.toContain("worktrees");
    const commentsRequest = sentOf(first, "listComments")[0]!;
    await act(async () => {
      first.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "cached across reconnect")],
        revisions: [{ id: "a-cached across reconnect", revision: 1 }],
        ...(commentsRequest.requestId !== undefined
          ? { requestId: commentsRequest.requestId }
          : {}),
      });
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
    expect(latestState.taskComments.a).toMatchObject({
      status: "ready",
      data: [expect.objectContaining({ body: "cached across reconnect" })],
    });
    expect(container!.textContent).toContain("cached across reconnect");

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
        target: { kind: "task", taskId: "a" },
        requestId: expect.any(String),
      }),
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

  it("does not let an event queued after teardown resurrect the target", async () => {
    const socket = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(socket);
    const request = sentOf(socket, "listComments")[0]!;
    await act(async () => {
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "visible")],
        revisions: [{ id: "a-visible", revision: 1 }],
        ...(request.requestId !== undefined
          ? { requestId: request.requestId }
          : {}),
      });
      root!.render(<TaskRouteHarness selectedId={null} />);
    });
    expect(latestState.commentTargets["task:a"]).toBeUndefined();

    await act(async () => {
      socket.receive({
        type: "commentEvents",
        target: { kind: "task", taskId: "a" },
        seq: 2,
        events: [
          {
            kind: "upsert",
            id: "a-late",
            revision: 2,
            item: commentThread("a", "late"),
          },
        ],
      });
    });

    expect(latestState.commentTargets["task:a"]).toBeUndefined();
    expect(latestState.taskComments.a).toBeUndefined();
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

  it("switches A→B without leaking A, unwatches, and reuses fresh A detail", async () => {
    const socket = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(socket);
    const detailA = sentOf(socket, "getTask")[0]!;
    const commentsA = sentOf(socket, "listComments")[0]!;

    await act(async () => root!.render(<TaskRouteHarness selectedId="b" />));
    expect(sentOf(socket, "unwatchComments").at(-1)).toEqual({
      type: "unwatchComments",
      target: { kind: "task", taskId: "a" },
    });
    expect(sentOf(socket, "getTask")).toHaveLength(2);
    expect(sentOf(socket, "listComments")).toHaveLength(2);

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: TASK_A,
        requestId: detailA.requestId,
      });
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "late A")],
        revisions: [],
        ...(commentsA.requestId !== undefined
          ? { requestId: commentsA.requestId }
          : {}),
      });
    });
    expect(container!.textContent).toContain("pendingpending");
    expect(container!.textContent).not.toContain("Task A");
    expect(dataOf(latestState.taskDetails.a!)).toEqual(TASK_A);

    const detailB = sentOf(socket, "getTask")[1]!;
    const commentsB = sentOf(socket, "listComments")[1]!;
    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "b",
        item: TASK_B,
        requestId: detailB.requestId,
      });
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "b" },
        threads: [commentThread("b", "ready B")],
        revisions: [],
        ...(commentsB.requestId !== undefined
          ? { requestId: commentsB.requestId }
          : {}),
      });
    });
    expect(container!.textContent).toContain("Task Bready B");

    await act(async () => root!.render(<TaskRouteHarness selectedId="a" />));
    // A's body answer was safe to cache by id, while its Activity read was
    // cancelled by unwatch and starts a fresh generation on return.
    expect(container!.textContent).toContain("Task Apending");
    expect(sentOf(socket, "getTask")).toHaveLength(2);
    expect(sentOf(socket, "listComments")).toHaveLength(3);
    const returnedCommentsA = sentOf(socket, "listComments")[2]!;
    await act(async () => {
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "current A")],
        revisions: [],
        ...(returnedCommentsA.requestId !== undefined
          ? { requestId: returnedCommentsA.requestId }
          : {}),
      });
    });
    expect(container!.textContent).toContain("Task Acurrent A");

    await act(async () => {
      socket.receive(taskListMessage([task("a", 2), TASK_B]));
    });
    expect(sentOf(socket, "getTask")).toHaveLength(3);
    expect(sentOf(socket, "getTask")[2]!.id).toBe("a");

    await act(async () => root!.render(<TaskRouteHarness selectedId={null} />));
    expect(sentOf(socket, "unwatchComments").at(-1)).toEqual({
      type: "unwatchComments",
      target: { kind: "task", taskId: "a" },
    });
  });

  it("drops superseded same-id detail and comment answers", async () => {
    const socket = await renderHarness(<TaskRouteHarness selectedId="a" />);
    await openReady(socket);
    const firstDetail = sentOf(socket, "getTask")[0]!;
    const firstComments = sentOf(socket, "listComments")[0]!;

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: null,
        requestId: firstDetail.requestId,
        error: "first detail failed",
      });
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [],
        revisions: [],
        ...(firstComments.requestId !== undefined
          ? { requestId: firstComments.requestId }
          : {}),
        error: "first comments failed",
      });
      latestActions.requestTaskDetail("a");
      latestActions.listTaskComments("a");
    });
    const secondDetail = sentOf(socket, "getTask")[1]!;
    const secondComments = sentOf(socket, "listComments")[1]!;
    expect(secondDetail.requestId).not.toBe(firstDetail.requestId);
    expect(secondComments.requestId).not.toBe(firstComments.requestId);

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: task("a", 99),
        requestId: firstDetail.requestId,
      });
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "stale")],
        revisions: [],
        ...(firstComments.requestId !== undefined
          ? { requestId: firstComments.requestId }
          : {}),
      });
    });
    expect(latestState.taskDetails.a?.status).toBe("loading");
    expect(latestState.taskComments.a?.status).toBe("loading");
    expect(container!.textContent).not.toContain("stale");

    await act(async () => {
      socket.receive({
        type: "taskDetail",
        id: "a",
        item: TASK_A,
        requestId: secondDetail.requestId,
      });
      socket.receive({
        type: "commentsSnapshot",
        target: { kind: "task", taskId: "a" },
        threads: [commentThread("a", "current")],
        revisions: [],
        ...(secondComments.requestId !== undefined
          ? { requestId: secondComments.requestId }
          : {}),
      });
    });
    expect(container!.textContent).toContain("Task Acurrent");
  });
});
