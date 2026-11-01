// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayBlock, ServerMessage, TaskItem } from "@assistant/shared";
import { FakeSocket } from "../test/fakeSocket.ts";
import { useAssistant } from "../hooks/useAssistant.ts";
import { TaskManageToolCard } from "./TaskManageToolCard.tsx";
import {
  TaskLiveSourceProvider,
  useTaskLiveSourceValue,
} from "./TaskLiveState.tsx";

/**
 * A transcript Task card learning, through the real reducer and socket, that
 * the suggestion it recorded has been answered. The detail body cache is
 * bounded at 16 and a long transcript can hold more cards than that, so these
 * pin that an answer is never lost to that cache and never read in a ring —
 * and that the card's record is a last-known value that every later fact
 * (a reconnect, a session summary, a new claim, a delete event) can overtake.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

/** Task `id` as the server holds it; by default, confirmed done. */
function serverTask(
  id: string,
  {
    status = "done",
    claimAt,
    updatedAt = 6,
  }: { status?: "todo" | "done"; claimAt?: number; updatedAt?: number } = {},
): TaskItem {
  return {
    id,
    title: `Task ${id}`,
    status,
    source: { createdBy: "user" },
    description: "",
    createdAt: 1,
    updatedAt,
    ...(claimAt ? { statusSuggestion: { to: "done", at: claimAt } } : {}),
  } as TaskItem;
}

/** A recorded `task_manage` result: an agent says Task `id` is done. */
function suggestionBlock(
  id: string,
  at = 5,
): Extract<DisplayBlock, { kind: "tool" }> {
  return {
    kind: "tool",
    toolId: `toolu_${id}_${at}`,
    name: "mcp__pa__task_manage",
    args: { operations: [{ operation: "update", id, status: "done" }] },
    output: JSON.stringify({
      renderKind: "taskManage",
      version: 1,
      changed: [
        {
          id,
          title: `Task ${id}`,
          status: "todo",
          statusSuggestion: { to: "done", at },
        },
      ],
    }),
    isError: false,
    done: true,
  };
}

function Harness({ ids, at }: { ids: string[]; at?: number }) {
  const { state, actions } = useAssistant();
  const source = useTaskLiveSourceValue(state, actions.requestTaskDetail);
  return (
    <TaskLiveSourceProvider source={source}>
      {ids.map((id) => (
        <div key={id} data-id={id}>
          <TaskManageToolCard
            block={suggestionBlock(id, at)}
            onApplyTaskStatusSuggestion={() => {}}
          />
        </div>
      ))}
    </TaskLiveSourceProvider>
  );
}

const SESSION = {
  sessionId: "s1",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
} as const;

/** The server's hello: only after it does the app count as connected. */
const READY = {
  type: "ready",
  serverBuild: { version: "0.0.0-test" },
  state: SESSION,
  models: [],
  agents: [],
  settings: {},
  speechToText: {
    configured: false,
    availableModelIds: [],
    maxUtteranceSeconds: 120,
  },
  slashCommands: [],
  contextInfo: null,
} as ServerMessage;

async function connect(socket: FakeSocket): Promise<void> {
  await act(async () => socket.open());
  await act(async () => socket.receive(READY));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => String(from + i));

async function mount(ids: string[]): Promise<FakeSocket> {
  await act(async () => root.render(<Harness ids={ids} />));
  const socket = FakeSocket.instances[0]!;
  await connect(socket);
  return socket;
}

function reads(socket: FakeSocket) {
  return socket.sent.filter((message) => message.type === "getTask");
}

/** Answer the LATEST read of `id`: with the done Task, `item`, or an error. */
async function answer(
  socket: FakeSocket,
  id: string,
  reply: { item?: TaskItem | null; error?: string } = {},
) {
  const read = reads(socket).findLast((message) => message.id === id)!;
  await act(async () =>
    socket.receive({
      type: "taskDetail",
      id,
      item: reply.error
        ? null
        : reply.item === undefined
          ? serverTask(id)
          : reply.item,
      requestId: read.requestId,
      ...(reply.error ? { error: reply.error } : {}),
    }),
  );
}

async function receive(socket: FakeSocket, message: unknown) {
  await act(async () => socket.receive(message as ServerMessage));
}

function row(id: string): string {
  return container.querySelector(`[data-id="${id}"]`)!.textContent ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a transcript Task card's live answer", () => {
  it("keeps every answer when more cards load at once than the body cache holds", async () => {
    const ids = range(0, 17);
    const socket = await mount(ids);
    expect(reads(socket)).toHaveLength(17);
    // The first answer arrives while the other 16 are still loading — the
    // body cache prunes it at once, and the card must still have it.
    await answer(socket, "0");
    expect(row("0")).toContain("Confirmed done");
    for (const id of ids.slice(1)) await answer(socket, id);
    for (const id of ids) expect(row(id)).not.toContain("Confirm done");
    expect(reads(socket)).toHaveLength(17);
  });

  it("stays answered when a later card evicts its body, and reads nothing again", async () => {
    const first = range(0, 16);
    const socket = await mount(first);
    for (const id of first) await answer(socket, id);
    await act(async () => root.render(<Harness ids={range(0, 17)} />));
    await answer(socket, "16");
    for (const id of range(0, 17)) expect(row(id)).toContain("Confirmed done");
    expect(reads(socket)).toHaveLength(17);
  });

  it("sends a read the connection lost again on reconnect", async () => {
    vi.useFakeTimers();
    const first = await mount(["0"]);
    expect(reads(first)).toHaveLength(1);
    await act(async () => first.close());
    await act(async () => vi.advanceTimersByTime(1000));
    const second = FakeSocket.instances[1]!;
    await connect(second);
    expect(reads(second)).toHaveLength(1);
    await answer(second, "0");
    expect(row("0")).toContain("Confirmed done");
  });

  it("does not retry a read the server refused while still connected", async () => {
    const socket = await mount(["0"]);
    await answer(socket, "0", { error: "Task store unavailable." });
    // Falls back to what the card recorded rather than asking in a loop.
    expect(row("0")).toContain("Confirm done");
    expect(reads(socket)).toHaveLength(1);
  });

  it("reads a loaded Task again on reconnect, catching a change made while offline", async () => {
    vi.useFakeTimers();
    const first = await mount(["0"]);
    await answer(first, "0", {
      item: serverTask("0", { status: "todo", claimAt: 5 }),
    });
    expect(row("0")).toContain("Confirm done");
    await act(async () => first.close());
    await act(async () => vi.advanceTimersByTime(1000));
    const second = FakeSocket.instances[1]!;
    await connect(second);
    expect(reads(second)).toHaveLength(1);
    await answer(second, "0", { item: serverTask("0", { updatedAt: 9 }) });
    expect(row("0")).toContain("Confirmed done");
  });

  it("follows a newer summary of the viewed session's Tasks", async () => {
    const socket = await mount(["0"]);
    await answer(socket, "0", {
      item: serverTask("0", { status: "todo", claimAt: 5 }),
    });
    expect(row("0")).toContain("Confirm done");
    await receive(socket, {
      type: "state",
      state: { ...SESSION, tasks: [serverTask("0", { updatedAt: 10 })] },
    });
    expect(row("0")).toContain("Confirmed done");
  });

  it("asks a NEW claim even though an older read saw the last one dismissed", async () => {
    const socket = await mount(["0"]);
    await answer(socket, "0", { item: serverTask("0", { status: "todo" }) });
    expect(row("0")).not.toContain("Confirm done");
    // A later agent says done again, at 10; its card is a new question.
    await act(async () => root.render(<Harness ids={["0"]} at={10} />));
    expect(row("0")).toContain("Confirm done");
  });

  it("reads a Task again when it leaves the live list, and drops a deleted one", async () => {
    const socket = await mount(["0"]);
    await answer(socket, "0", {
      item: serverTask("0", { status: "todo", claimAt: 5 }),
    });
    await receive(socket, {
      type: "taskList",
      list: {
        request: {},
        items: [serverTask("0", { status: "todo", claimAt: 5 })],
        updatedAt: 6,
      },
      seq: 1,
      revisions: [{ id: "0", revision: 6 }],
    });
    await receive(socket, {
      type: "stateEvents",
      topic: "tasks",
      seq: 2,
      events: [{ kind: "delete", id: "0", revision: 10 }],
    });
    // Archived or deleted, the event cannot say: the card asks.
    expect(reads(socket)).toHaveLength(2);
    await answer(socket, "0", { item: null });
    expect(row("0")).not.toContain("Confirm done");
    expect(row("0")).not.toContain("says done");
  });

  /** A pending claim read, a canonical list holding it, then a digest without it. */
  async function prunedByDigest(): Promise<FakeSocket> {
    const pending = serverTask("0", { status: "todo", claimAt: 5 });
    const socket = await mount(["0"]);
    await answer(socket, "0", { item: pending });
    await receive(socket, {
      type: "taskList",
      list: { request: {}, items: [pending], updatedAt: 6 },
      seq: 1,
      revisions: [{ id: "0", revision: 6 }],
    });
    // Catch-up after a missed delete: the Task is simply absent.
    await receive(socket, {
      type: "stateDigest",
      topic: "tasks",
      seq: 2,
      entries: [],
    });
    expect(reads(socket)).toHaveLength(2);
    return socket;
  }

  it("reads a Task a digest pruned again, and drops a deleted one", async () => {
    const socket = await prunedByDigest();
    await answer(socket, "0", { item: null });
    expect(row("0")).not.toContain("says done");
  });

  it("reads a Task a digest pruned again, and shows an archived one as it is", async () => {
    const socket = await prunedByDigest();
    await answer(socket, "0", { item: serverTask("0", { updatedAt: 9 }) });
    expect(row("0")).toContain("Confirmed done");
  });
});
