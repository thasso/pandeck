// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskSummaryOf,
  type ClientMessage,
  type InitiativeSummary,
  type ServerMessage,
  type TaskItem,
} from "@assistant/shared";
import { FakeSocket } from "./test/fakeSocket.ts";
import { HOSTED_LABS_DETAIL } from "../component-preview/fixtures/initiatives.ts";

/**
 * The Task an Initiative page selects (`/initiatives/:id#task-<n>`), measured
 * on the whole app: the panel must show the REAL Task detail with its own body
 * read, not-found, failure, refresh and status lifecycle, because what breaks
 * is the wiring between the fragment, the Task cache and the panel
 * (`docs/initiatives.md`; F022, F027, F029).
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const App = (await import("./App.tsx")).default;
const { ShortcutsProvider } = await import("./components/common/shortcuts.tsx");

const FRAME_MS = 25;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
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
  } as unknown as ServerMessage;
}

const LISTED: TaskItem = {
  id: "31",
  title: "Export metering to billing",
  status: "todo",
  source: { createdBy: "user" },
  description: "The body of Task 31, with its **details**.",
  createdAt: 1,
  updatedAt: 5,
};
const ARCHIVED: TaskItem = {
  id: "40",
  title: "An archived member",
  status: "todo",
  source: { createdBy: "user" },
  description: "Archived body, first version.",
  createdAt: 1,
  updatedAt: 5,
  archivedAt: 6,
};

function summary(): InitiativeSummary {
  const {
    description: _d,
    createdAt: _c,
    rootIds: _r,
    nodes: _n,
    externalBlockers: _e,
    edges: _g,
    milestoneIds: _m,
    ...rest
  } = HOSTED_LABS_DETAIL;
  return { ...rest, id: "7" };
}

const sentOf = <T extends ClientMessage["type"]>(socket: FakeSocket, type: T) =>
  socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: T }> =>
      message.type === type,
  );

async function boot(path: string): Promise<FakeSocket> {
  // The object panel is the user's: open, as a selection on the page leaves it.
  window.sessionStorage.setItem("assistant.shell.right-panel-open.v1", "true");
  window.history.replaceState(null, "", path);
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  await settle();
  const socket = FakeSocket.instances.at(-1)!;
  await connect(socket);
  return socket;
}

async function connect(socket: FakeSocket): Promise<void> {
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await settle(1);
  await act(async () => {
    socket.receive({
      type: "initiativeList",
      items: [summary()],
      seq: 1,
      revisions: [{ id: "7", revision: 1 }],
    });
    socket.receive({
      type: "taskList",
      list: {
        request: {},
        items: [taskSummaryOf(LISTED)],
        updatedAt: 5,
      },
      seq: 1,
      revisions: [{ id: "31", revision: 5 }],
    });
  });
  await settle(1);
  for (const read of sentOf(socket, "getInitiative"))
    await act(async () =>
      socket.receive({
        type: "initiativeDetail",
        id: "7",
        item: { ...HOSTED_LABS_DETAIL, id: "7" },
        revision: 1,
        requestId: read.requestId,
      }),
    );
  await settle();
}

/** Wait, through lazy chunks, until `done` holds or a deadline passes. */
async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 160; i++) {
    if (done()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const readsOf = (socket: FakeSocket, id: string) =>
  sentOf(socket, "getTask").filter((read) => read.id === id);

/** Answer the newest body read for `id`. */
async function answerTask(
  socket: FakeSocket,
  id: string,
  answer: { item: TaskItem | null; revision?: number; error?: string },
): Promise<void> {
  const read = sentOf(socket, "getTask")
    .filter((message) => message.id === id)
    .at(-1)!;
  await act(async () =>
    socket.receive({
      type: "taskDetail",
      id,
      item: answer.item,
      ...(answer.revision !== undefined ? { revision: answer.revision } : {}),
      ...(answer.error ? { error: answer.error } : {}),
      requestId: read.requestId,
    }),
  );
  await settle();
}

const panel = () => document.body;
const text = () => panel().textContent ?? "";
const buttonNamed = (name: RegExp) =>
  [...panel().querySelectorAll("button")].find((button) =>
    name.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
  );

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ profiles: [], modelsByProfile: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the Task an Initiative page selects", () => {
  it("embeds the real Task detail: its body read, description, status and sessions (F022)", async () => {
    const socket = await boot("/initiatives/7#task-31");
    // A Task the live list holds is read in full too: the panel shows its body.
    await until(() => readsOf(socket, "31").length > 0, "the body read");
    await answerTask(socket, "31", { item: LISTED, revision: 5 });
    expect(text()).toContain("The body of Task 31");
    expect(text()).toContain("Task-31");
    // The usual status control, and the Task's sessions with a way to start one.
    expect(buttonNamed(/^Status: To do\. Change status$/)).toBeDefined();
    expect(text()).toContain("No sessions on this Task yet.");
    expect(buttonNamed(/^Start session for this task$/)).toBeDefined();
    // The detail lists the Task's Workflow Runs, so the page holds that topic
    // while a Task is selected, and its placeholder resolves on the answer.
    expect(
      sentOf(socket, "subscribe").some((message) =>
        message.topics.includes("workflow"),
      ),
    ).toBe(true);
    await act(async () =>
      socket.receive({
        type: "workflowRunList",
        runs: [],
        cards: {},
        updatedAt: 1,
      }),
    );
    await settle(1);
    expect(
      panel().querySelector('[aria-label="Loading Task workflow runs"]'),
    ).toBeNull();
  });

  it("says a Task that does not exist does not, and offers nothing to do with it (F027)", async () => {
    const socket = await boot("/initiatives/7#task-999");
    await until(() => readsOf(socket, "999").length > 0, "the body read");
    await answerTask(socket, "999", { item: null });
    expect(text()).toContain("Task-999 does not exist.");
    expect(text()).not.toContain("Loading Task");
    expect(buttonNamed(/Start session for this task/)).toBeUndefined();
  });

  it("states a failed read with a retry, and reads again after a reconnect (F027)", async () => {
    const socket = await boot("/initiatives/7#task-40");
    await until(() => readsOf(socket, "40").length > 0, "the body read");
    const failure = "The Task could not be read.";
    await answerTask(socket, "40", { item: null, error: failure });
    expect(text()).toContain(failure);
    expect(text()).not.toContain("Loading Task");
    // The Retry of THIS failure, inside its own note.
    const note = [...panel().querySelectorAll('[role="alert"]')].find((alert) =>
      alert.textContent?.includes(failure),
    );
    const retry = note?.querySelector("button");
    expect(retry?.textContent).toBe("Retry");
    const before = readsOf(socket, "40").length;
    await act(async () => retry!.click());
    await settle(1);
    expect(readsOf(socket, "40").length).toBe(before + 1);

    // The socket drops with that read in flight and comes back: the lost read
    // is asked again on the new connection.
    const sockets = FakeSocket.instances.length;
    await act(async () => socket.close());
    await until(() => FakeSocket.instances.length > sockets, "a new socket");
    const next = FakeSocket.instances.at(-1)!;
    await connect(next);
    await until(() => readsOf(next, "40").length > 0, "the re-read");
    await answerTask(next, "40", { item: ARCHIVED, revision: 6 });
    expect(text()).toContain("Archived body, first version.");
  });

  it("re-reads a held archived body when a newer revision marks it stale (F027)", async () => {
    const socket = await boot("/initiatives/7#task-40");
    await until(() => readsOf(socket, "40").length > 0, "the body read");
    await answerTask(socket, "40", { item: ARCHIVED, revision: 6 });
    expect(text()).toContain("Archived body, first version.");
    const reads = () => sentOf(socket, "getTask").filter((r) => r.id === "40");
    const before = reads().length;
    // A write to an archived Task is reported as a delete with its new revision.
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "tasks",
        seq: 2,
        events: [{ kind: "delete", id: "40", revision: 9 }],
      }),
    );
    await settle();
    expect(reads().length).toBe(before + 1);
    await answerTask(socket, "40", {
      item: {
        ...ARCHIVED,
        description: "Archived body, renamed.",
        updatedAt: 9,
      },
      revision: 9,
    });
    expect(text()).toContain("Archived body, renamed.");
  });

  it("busies the status control while its save runs and keeps a refusal on it (F029)", async () => {
    const socket = await boot("/initiatives/7#task-31");
    await until(() => readsOf(socket, "31").length > 0, "the body read");
    await answerTask(socket, "31", { item: LISTED, revision: 5 });
    const status = () => buttonNamed(/^Status: .*Change status$/);
    expect(status()?.getAttribute("aria-label")).toBe(
      "Status: To do. Change status",
    );
    await act(async () => status()!.click());
    await settle(1);
    const doing = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("In progress"),
    ) as HTMLElement | undefined;
    expect(doing).toBeDefined();
    await act(async () => doing!.click());
    await settle(1);
    const saves = sentOf(socket, "saveTask");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.request).toMatchObject({ id: "31", status: "doing" });
    // The control is busy while the save runs, so a second change waits.
    expect(status()?.getAttribute("aria-busy")).toBe("true");
    expect(status()?.hasAttribute("disabled")).toBe(true);

    const refusal = "The server refused this status change.";
    await act(async () =>
      socket.receive({
        type: "error",
        message: refusal,
        requestId: saves[0]!.requestId!,
        target: { type: "task", id: "31" },
      }),
    );
    await settle();
    // The failure stays where it happened, beside the control, once.
    expect(text().split(refusal).length - 1).toBe(1);
    expect(
      [...panel().querySelectorAll('[role="alert"]')].some((alert) =>
        alert.textContent?.includes(refusal),
      ),
    ).toBe(true);
    expect(status()?.getAttribute("aria-busy")).not.toBe("true");
  });
});
