// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  taskSummaryOf,
  type ClientMessage,
  type InitiativeSummary,
  type ServerMessage,
  type SessionListItem,
  type TaskItem,
} from "@assistant/shared";
import { FakeSocket } from "./test/fakeSocket.ts";
import { writeAppShellCacheRecord } from "./lib/appShellCacheStore.ts";
import { HOSTED_LABS_DETAIL } from "../component-preview/fixtures/initiatives.ts";
import { dismissToast, getToasts } from "./lib/toast.ts";

/**
 * The Task an Initiative page selects (`/initiatives/:id#task-<n>`), measured
 * on the whole app: the panel must show the REAL Task detail with its own body
 * read, not-found, failure, refresh and status lifecycle, because what breaks
 * is the wiring between the fragment, the Task cache and the panel
 * (`docs/initiatives.md`; F022, F027, F029). The Task's actions belong to the
 * panel's Task header alone, and its failures are claimed in place only while
 * that panel is on screen (F032, F033). An Initiative Settle's failure has its
 * inbox card as a home only while the Sessions inbox shows it (F039).
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

function readyMessage(sessions: SessionListItem[] = []): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions,
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

/** A layout query answered as a wide screen, or as a phone. */
function stubLayout(phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: phone && query === "(max-width: 767px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

async function boot(
  path: string,
  {
    phone = false,
    tasks = [LISTED],
    initiatives = [summary()],
    sessions = [],
  }: {
    phone?: boolean;
    tasks?: TaskItem[];
    initiatives?: InitiativeSummary[];
    sessions?: SessionListItem[];
  } = {},
): Promise<FakeSocket> {
  stubLayout(phone);
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
  await connect(socket, tasks, initiatives, sessions);
  return socket;
}

async function connect(
  socket: FakeSocket,
  tasks: TaskItem[] = [LISTED],
  initiatives: InitiativeSummary[] = [summary()],
  sessions: SessionListItem[] = [],
): Promise<void> {
  await act(async () => {
    socket.open();
    socket.receive(readyMessage(sessions));
  });
  await settle(1);
  await act(async () => {
    socket.receive({
      type: "initiativeList",
      items: initiatives,
      seq: 1,
      revisions: initiatives.map((item) => ({ id: item.id, revision: 1 })),
    });
    socket.receive({
      type: "taskList",
      list: {
        request: {},
        items: tasks.map(taskSummaryOf),
        updatedAt: 5,
      },
      seq: 1,
      revisions: tasks.map((task) => ({ id: task.id, revision: 5 })),
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

const status = () => buttonNamed(/^Status: .*Change status$/);
const menuItems = () =>
  [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent ?? "",
  );
const announced = () => getToasts().map((toast) => toast.message);
/** The alerts carrying `message`: its note in place. */
const alertsWith = (message: string) =>
  [...panel().querySelectorAll('[role="alert"]')].filter((alert) =>
    alert.textContent?.includes(message),
  );
/** How an announcement names Task-31: its id, then its title. */
const NAMED_31 = `Task-31 ${LISTED.title}`;
/** What a Task mutation says at its deadline (`useAssistant`). */
const DEADLINE = "The server did not answer this Task change. Try again.";

const OTHER: TaskItem = {
  id: "910",
  title: "Meter schema and retention",
  status: "todo",
  source: { createdBy: "user" },
  description: "The body of Task 910.",
  createdAt: 1,
  updatedAt: 5,
};

/** Wait for the panel's body read of `task` and answer it. */
async function openTask(socket: FakeSocket, task = LISTED): Promise<void> {
  await until(() => readsOf(socket, task.id).length > 0, "the body read");
  await answerTask(socket, task.id, { item: task, revision: 5 });
}

/** Press the button named `name`, wherever it is. */
async function press(name: RegExp): Promise<void> {
  const button = buttonNamed(name);
  expect(button, String(name)).toBeDefined();
  await act(async () => button!.click());
  await settle();
}

/** Change the shown Task's status through its control's menu. */
async function changeStatus(socket: FakeSocket, to = "In progress") {
  const before = sentOf(socket, "saveTask").length;
  await act(async () => status()!.click());
  await settle(1);
  const choice = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent?.includes(to),
  ) as HTMLElement | undefined;
  expect(choice, to).toBeDefined();
  await act(async () => choice!.click());
  await settle(1);
  const saves = sentOf(socket, "saveTask");
  expect(saves).toHaveLength(before + 1);
  return saves.at(-1)!;
}

/** The server's stamped refusal of `save`, naming the Task it was about. */
async function refuse(
  socket: FakeSocket,
  save: { requestId?: string },
  message: string,
  id = "31",
): Promise<void> {
  await act(async () =>
    socket.receive({
      type: "error",
      message,
      requestId: save.requestId!,
      target: { type: "task", id },
    }),
  );
  await settle();
}

/** Move the faked clock past every pending mutation's deadline. */
async function expireMutations(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await settle();
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  stubLayout(false);
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
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.useRealTimers();
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
    await openTask(socket);
    expect(status()?.getAttribute("aria-label")).toBe(
      "Status: To do. Change status",
    );
    const save = await changeStatus(socket);
    expect(save.request).toMatchObject({ id: "31", status: "doing" });
    // The control is busy while the save runs, so a second change waits.
    expect(status()?.getAttribute("aria-busy")).toBe("true");
    expect(status()?.hasAttribute("disabled")).toBe(true);
    // A second press and a keyboard open on the busy control: no menu opens,
    // and nothing more is sent.
    await act(async () => status()!.click());
    await act(async () => {
      status()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle(1);
    expect(menuItems()).toEqual([]);
    expect(sentOf(socket, "saveTask")).toHaveLength(1);

    const refusal = "The server refused this status change.";
    await refuse(socket, save, refusal);
    // The failure stays where it happened, beside the control, once, and the
    // panel showing it is its home: nothing is announced on top.
    expect(text().split(refusal).length - 1).toBe(1);
    expect(alertsWith(refusal)).toHaveLength(1);
    expect(announced()).toEqual([]);
    expect(status()?.getAttribute("aria-busy")).not.toBe("true");
  });

  it("clears a save the server never answers at its deadline, and ignores the late answer (F029)", async () => {
    const socket = await boot("/initiatives/7#task-31");
    await openTask(socket);
    // The mutation's own deadline, on a clock the test moves.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    const first = await changeStatus(socket);
    expect(status()?.getAttribute("aria-busy")).toBe("true");
    await expireMutations();
    expect(status()?.getAttribute("aria-busy")).not.toBe("true");
    expect(status()?.hasAttribute("disabled")).toBe(false);
    expect(alertsWith(DEADLINE)).toHaveLength(1);
    expect(announced()).toEqual([]);

    // The control is free again: a second change is sent and owns it. The
    // abandoned request's late refusal must not settle or fail that one.
    // The list shows the change it was asked for until the recovery read
    // answers, so the second change asks for another status.
    const second = await changeStatus(socket, "Done");
    expect(second.requestId).not.toBe(first.requestId);
    expect(status()?.getAttribute("aria-busy")).toBe("true");
    await refuse(socket, first, "A late refusal of the first change.");
    expect(status()?.getAttribute("aria-busy")).toBe("true");
    const refusal = "The server refused the second change.";
    await refuse(socket, second, refusal);
    expect(status()?.getAttribute("aria-busy")).not.toBe("true");
    expect(alertsWith(refusal)).toHaveLength(1);
    expect(alertsWith(DEADLINE)).toHaveLength(0);
  });

  it.each(["refusal", "deadline"] as const)(
    "keeps a %s on the Task it was made for when the selection moves (F029)",
    async (outcome) => {
      const socket = await boot("/initiatives/7#task-31", {
        tasks: [LISTED, OTHER],
      });
      await openTask(socket);
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });
      const save = await changeStatus(socket);
      // Select another member from the List while that save runs.
      await press(/^List$/);
      await press(/^Meter schema and retention, Task-910\b/);
      expect(window.location.hash).toBe("#task-910");
      await openTask(socket, OTHER);
      expect(text()).toContain("The body of Task 910.");
      // Task-910's control is its own: idle, enabled, no failure.
      expect(status()?.getAttribute("aria-busy")).not.toBe("true");
      expect(status()?.hasAttribute("disabled")).toBe(false);

      const message =
        outcome === "refusal"
          ? "The server refused Task 31's change."
          : DEADLINE;
      if (outcome === "refusal") await refuse(socket, save, message);
      else await expireMutations();
      // Task-31's outcome has no home on screen any more: it is announced,
      // naming Task-31, and Task-910's panel does not wear it.
      expect(announced()).toEqual([`${NAMED_31} — ${message}`]);
      expect(alertsWith(message)).toHaveLength(0);
      expect(status()?.getAttribute("aria-busy")).not.toBe("true");

      // Task-910 keeps its own home: its refusal stays in place, unannounced.
      const own = await changeStatus(socket);
      expect(own.request).toMatchObject({ id: "910", status: "doing" });
      const refusal = "The server refused Task 910's change.";
      await refuse(socket, own, refusal, "910");
      expect(alertsWith(refusal)).toHaveLength(1);
      expect(announced()).toHaveLength(1);
    },
  );
});

/**
 * Ways the panel stops showing the selected Task while the route and its
 * fragment stay put, each with the gesture that shows it again.
 */
const HIDDEN_PANEL: Record<
  string,
  { phone?: boolean; hide: () => Promise<void>; reveal: () => Promise<void> }
> = {
  "the whole panel is shut": {
    hide: () => press(/^Toggle inspector$/),
    reveal: () => press(/^Toggle inspector$/),
  },
  "the panel home is in front": {
    hide: () => press(/^Open a right panel$/),
    reveal: () => press(/^Inspector$/),
  },
  "another panel's tab is in front": {
    hide: async () => {
      await press(/^Open a right panel$/);
      await press(/^Personal Assistant$/);
    },
    reveal: () => press(/^Inspector$/),
  },
  "the Inspector tab is closed": {
    hide: () => press(/^Close Inspector$/),
    reveal: () => press(/^Inspector$/),
  },
  "the phone's dock is collapsed": {
    phone: true,
    hide: () => press(/^Collapse details$/),
    reveal: () => press(/^Open details$/),
  },
};

describe("the selected Task's sessions (F049, F052)", () => {
  const NO_SESSIONS = "No sessions on this Task yet.";
  const session = (id: string, title: string): SessionListItem => ({
    id,
    harness: "claude-sdk",
    agentType: "developer",
    title,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    isStreaming: false,
  });
  const withRefs = (...ids: string[]): TaskItem => ({
    ...LISTED,
    sessionRefs: ids.map((sessionId) => ({
      sessionId,
      origin: "task-start" as const,
    })),
  });

  it("says a Task has none only in the app's inline empty state, once its references are answered", async () => {
    // The shell cache holds the Task without sessions; nothing has answered
    // for this connection yet, so it may be older than the server's.
    writeAppShellCacheRecord({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: {},
      slashCommands: [],
      taskList: { request: {}, items: [taskSummaryOf(LISTED)], updatedAt: 5 },
      taskRevisions: { [LISTED.id]: 5 },
    });
    window.sessionStorage.setItem(
      "assistant.shell.right-panel-open.v1",
      "true",
    );
    window.history.replaceState(null, "", "/initiatives/7#task-31");
    await act(async () => {
      root!.render(
        <ShortcutsProvider>
          <App />
        </ShortcutsProvider>,
      );
    });
    await settle();
    expect(text()).toContain(LISTED.title);
    expect(text()).not.toContain(NO_SESSIONS);

    // The server answers with the same Task and no references: now it is so.
    const socket = FakeSocket.instances.at(-1)!;
    await connect(socket);
    await openTask(socket);
    const empty = [...panel().querySelectorAll('[data-slot="empty"]')].find(
      (box) => box.textContent?.includes(NO_SESSIONS),
    );
    expect(empty).toBeDefined();
    // Its way out is the empty state's own action.
    const start = [...empty!.querySelectorAll("button")].find((button) =>
      /^Start session for this task$/.test(button.textContent ?? ""),
    );
    expect(start).toBeDefined();
  });

  it("never says so for references this browser does not hold, archived ones included", async () => {
    // Its only session is archived: the default list leaves it out.
    const archivedOnly = withRefs("s-archived");
    const socket = await boot("/initiatives/7#task-31", {
      tasks: [archivedOnly],
    });
    await openTask(socket, archivedOnly);
    expect(text()).toContain("The body of Task 31");
    expect(text()).not.toContain(NO_SESSIONS);
  });

  it("lists the sessions it holds and claims nothing about the rest", async () => {
    const partial = withRefs("s-held", "s-archived");
    const socket = await boot("/initiatives/7#task-31", {
      tasks: [partial],
      sessions: [session("s-held", "Metering export run")],
    });
    await openTask(socket, partial);
    expect(text()).toContain("Metering export run");
    expect(text()).not.toContain(NO_SESSIONS);
  });
});

describe("a failure about the selected Task while its panel is not on screen (F033)", () => {
  it.each(Object.keys(HIDDEN_PANEL))(
    "is announced once, naming the Task, when %s",
    async (variant) => {
      const { phone = false, hide, reveal } = HIDDEN_PANEL[variant]!;
      const socket = await boot("/initiatives/7#task-31", { phone });
      // A phone's dock rests collapsed: the user opens it to the Task.
      if (phone) await press(/^Open details$/);
      await openTask(socket);
      const save = await changeStatus(socket);
      await hide();
      expect(window.location.hash).toBe("#task-31");
      const refusal = "The server refused this status change.";
      await refuse(socket, save, refusal);
      expect(announced()).toEqual([`${NAMED_31} — ${refusal}`]);
      // Kept on its object all the same: showing the panel again shows it in
      // place, without announcing it a second time.
      await reveal();
      await until(() => alertsWith(refusal).length === 1, "the note in place");
      expect(status()?.getAttribute("aria-busy")).not.toBe("true");
      expect(announced()).toHaveLength(1);
    },
  );

  it("announces a save's deadline naming the Task when the panel is shut (F029, F033)", async () => {
    const socket = await boot("/initiatives/7#task-31");
    await openTask(socket);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    await changeStatus(socket);
    await press(/^Toggle inspector$/);
    await expireMutations();
    expect(announced()).toEqual([`${NAMED_31} — ${DEADLINE}`]);
    await press(/^Toggle inspector$/);
    expect(alertsWith(DEADLINE)).toHaveLength(1);
    expect(announced()).toHaveLength(1);
  });

  it("keeps the Task page's own failures in place with its panel shut", async () => {
    const socket = await boot("/tasks/31");
    await openTask(socket);
    // The Task page's detail is the main pane: it stays on screen.
    await press(/^Toggle inspector$/);
    const save = await changeStatus(socket);
    const refusal = "The server refused this status change.";
    await refuse(socket, save, refusal);
    expect(alertsWith(refusal)).toHaveLength(1);
    expect(announced()).toEqual([]);
  });
});

describe("the selected Task's actions (F032)", () => {
  /** The page headers naming `name`: the Initiative's, or the Task's id. */
  const headersNamed = (name: string) =>
    [...document.querySelectorAll("header")].filter((header) =>
      header.textContent?.includes(name),
    );
  const labelOf = (button: Element) =>
    button.getAttribute("aria-label") ?? button.textContent ?? "";
  const buttonsIn = (scope: Element, name: RegExp) =>
    [...scope.querySelectorAll("button")].filter((button) =>
      name.test(labelOf(button)),
    );
  const TASK_ACTION =
    /Start session|Inspector actions|Archive|Delete|Run workflow|Status/;
  const initiativeHeader = () => {
    const headers = headersNamed(HOSTED_LABS_DETAIL.title);
    expect(headers).toHaveLength(1);
    return headers[0]!;
  };

  it("are offered by the panel's Task header, never the Initiative's", async () => {
    const socket = await boot("/initiatives/7#task-31");
    await openTask(socket);
    const outer = initiativeHeader();
    const inner = headersNamed("Task-31");
    expect(inner).toHaveLength(1);
    expect(outer.contains(inner[0]!)).toBe(false);
    expect(buttonsIn(outer, TASK_ACTION).map(labelOf)).toEqual([]);
    expect(buttonsIn(inner[0]!, /^Start session for this task$/)).toHaveLength(
      1,
    );
    // Shut, the panel takes the Task's actions with it.
    await press(/^Toggle inspector$/);
    expect(buttonsIn(initiativeHeader(), TASK_ACTION).map(labelOf)).toEqual([]);
    await press(/^Toggle inspector$/);

    // The Task header's own menu holds the Task's actions, aimed at that Task.
    const [taskHeader] = headersNamed("Task-31");
    const menu = buttonsIn(taskHeader!, /^Inspector actions$/);
    expect(menu).toHaveLength(1);
    await act(async () => (menu[0] as HTMLElement).click());
    await settle(1);
    expect(menuItems()).toEqual(
      expect.arrayContaining(["Archive task", "Delete task"]),
    );
    const archive = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "Archive task",
    ) as HTMLElement;
    await act(async () => archive.click());
    await settle();
    expect(sentOf(socket, "archiveTask")).toEqual([
      expect.objectContaining({ id: "31", archived: true }),
    ]);
  });

  it("are offered by the dock on a phone, never the Initiative's header", async () => {
    const socket = await boot("/initiatives/7#task-31", { phone: true });
    await press(/^Open details$/);
    await openTask(socket);
    expect(buttonsIn(initiativeHeader(), TASK_ACTION).map(labelOf)).toEqual([]);
    // The dock's row leads with the Task's Start, collapsed or not; the
    // Initiative's header still has none.
    expect(buttonNamed(/^Start session for this task$/)).toBeDefined();
    await press(/^Collapse details$/);
    expect(buttonNamed(/^Start session for this task$/)).toBeDefined();
    expect(buttonsIn(initiativeHeader(), TASK_ACTION).map(labelOf)).toEqual([]);
    // The expanded sheet lists the rest, aimed at that Task.
    await press(/^Open details$/);
    await press(/^Archive task$/);
    expect(sentOf(socket, "archiveTask")).toEqual([
      expect.objectContaining({ id: "31", archived: true }),
    ]);
  });

  it("stay in the Task page's own header on the Task route", async () => {
    await openTask(await boot("/tasks/31"));
    const [header] = headersNamed("Task-31");
    expect(buttonsIn(header!, /^Start session for this task$/)).toHaveLength(1);
    const menu = buttonsIn(header!, /^Inspector actions$/);
    expect(menu).toHaveLength(1);
    await act(async () => (menu[0] as HTMLElement).click());
    await settle(1);
    expect(menuItems()).toEqual(
      expect.arrayContaining(["Archive task", "Delete task"]),
    );
  });
});
