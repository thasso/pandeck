// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import {
  useAssistant,
  taskMutationKey,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { useBacklog, type BacklogState } from "./hooks/useBacklog.ts";
import type { Prefs } from "./hooks/usePrefs.ts";
import { ALL_PROJECT_FILTER } from "./lib/backlogTreeModel.ts";
import { failed } from "./lib/loadState.ts";
import {
  type FailureHomes,
  resetFailureHomes,
  setFailureHomes,
} from "./lib/messageArrival.ts";
import { getToasts, dismissToast } from "./lib/toast.ts";

/**
 * What the user is TOLD about a server message, driven through the socket that
 * delivers it (`docs/messaging.md`).
 *
 * The announcement is raised from the ARRIVAL, beside `appNotification`, which
 * is answered the same way and for the same reason. It used to be an effect over
 * a global `notice` slot in reducer state, and every recurring bug here had that
 * one shape: a persistent store asked to name the current event. These are the
 * shipped regressions, so they are asserted against the real message path rather
 * than against the pure decision alone.
 */

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
    sessions: [
      {
        id: "s1",
        harness: "pi",
        agentType: "assistant",
        title: "Design review",
        createdAt: 0,
        updatedAt: 1,
        messageCount: 0,
      },
    ],
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

let latestActions: AssistantActions;
let latestState: UIState;

function Harness() {
  const assistant = useAssistant();
  latestActions = assistant.actions;
  latestState = assistant.state;
  return null;
}

let root: Root;
let container: HTMLDivElement;
let socket: ScenarioSocket;

const announced = () => getToasts().map((toast) => toast.message);

/** Claim only what a case is about; everything else is off screen. */
function claim(homes: Partial<FailureHomes>): void {
  setFailureHomes({
    viewedSessionId: null,
    stagedSend: null,
    openObjects: { project: [], task: [] },
    ...homes,
  });
}

beforeEach(async () => {
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  resetFailureHomes();
  for (const toast of getToasts()) dismissToast(toast.id);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  resetFailureHomes();
});

describe("what an arriving server message says", () => {
  // Identity is the ARRIVAL, never the words. The same transport failure from a
  // second session, or the same one retried after its toast expired, is a new
  // event the user has to be told about; fingerprinting the text swallows
  // exactly the repeats that matter most.
  it("says the same sentence again when it arrives again", async () => {
    const failure: ServerMessage = {
      type: "error",
      message: "Failed to send prompt: connection lost",
      target: { type: "session", id: "s1" },
      // A prompt send says on the wire which send it was; that fact retires the
      // echo and says nothing about where the failure is SAID, which is the
      // target's business alone.
      failedPromptClientRequestId: "c1",
    };
    await act(async () => socket.receive(failure));
    expect(announced()).toEqual([
      "Design review — Failed to send prompt: connection lost",
    ]);

    // The one toast is REPLACED under its object's key rather than stacking,
    // but the retry is still announced: the arrival happened.
    await act(async () => {
      for (const toast of getToasts()) dismissToast(toast.id);
      socket.receive(failure);
    });
    expect(announced()).toEqual([
      "Design review — Failed to send prompt: connection lost",
    ]);
  });

  // A failure that names an object the user is not looking at is the event case:
  // its surface is gone, so it takes the ephemeral channel and NAMES the object.
  it("names the object a failure is about", async () => {
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to remove worktree: busy",
        target: { type: "worktree", id: "w1" },
      }),
    );
    expect(announced()).toEqual([
      "Worktree w1 — Failed to remove worktree: busy",
    ]);
  });

  // The model's first question: a failure whose object is ON SCREEN is rendered
  // there (above the composer) and must not also be said in passing.
  it("stays quiet about the session the user is looking at", async () => {
    claim({ viewedSessionId: "s1" });
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to send prompt: connection lost",
        target: { type: "session", id: "s1" },
        failedPromptClientRequestId: "c1",
      }),
    );
    expect(announced()).toEqual([]);

    // Another session's failure has no home here and is still announced.
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to rename session: session not found.",
        target: { type: "session", id: "s2" },
      }),
    );
    expect(announced()).toEqual([
      "Session s2 — Failed to rename session: session not found.",
    ]);
  });

  // The in-place note exists for a FAILURE, so a warning naming the very session
  // in view has nowhere else to go.
  it("still announces a warning about the session in view", async () => {
    claim({ viewedSessionId: "s1" });
    await act(async () =>
      socket.receive({
        type: "notice",
        severity: "warning",
        message: "That worktree is no longer available.",
        target: { type: "session", id: "s1" },
      }),
    );
    expect(announced()).toEqual([
      "Design review — That worktree is no longer available.",
    ]);
  });

  // A suppression CONSUMES the arrival rather than deferring it. The owning
  // surface goes away — the user navigates, the pane refetches — and a deferred
  // arrival then announces a failure that is by now long over.
  it("does not announce an owned failure later, once its home is gone", async () => {
    claim({ viewedSessionId: "s1" });
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to send prompt: connection lost",
        target: { type: "session", id: "s1" },
        failedPromptClientRequestId: "c1",
      }),
    );
    expect(announced()).toEqual([]);

    // The user leaves that chat, and unrelated traffic arrives.
    claim({});
    await act(async () => socket.receive({ type: "models", models: [] }));
    expect(announced()).toEqual([]);
  });

  // A list that could not be read is a CONDITION on its collection: the pane
  // renders it whenever the user goes there, so it is never said in passing —
  // and it reaches the pane by TARGET, not by the sentence the server chose.
  it("keeps a list failure on its pane instead of announcing it", async () => {
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to list projects: disk full",
        target: { type: "project" },
      }),
    );
    expect(announced()).toEqual([]);
  });

  // The permanent Assistant's queue states are CONDITIONS on one message, not
  // events: they are rendered on that prompt's own row and never announced.
  // Each of them used to raise an info toast.
  it("never announces a queued prompt's conditions", async () => {
    const queued = {
      type: "permanentAssistantQueue" as const,
      sessionId: "s1",
      clientRequestId: "c1",
    };
    for (const state of ["queued", "working", "completed"] as const)
      await act(async () => socket.receive({ ...queued, state }));
    expect(announced()).toEqual([]);
  });

  // The failure is the one thing here that speaks, and it speaks once: in place
  // when the user is looking at that session, named in passing when they are not.
  it("says a queued prompt's failure once, where it can be seen", async () => {
    claim({ viewedSessionId: "s1" });
    const failure = {
      type: "permanentAssistantQueue" as const,
      sessionId: "s1",
      clientRequestId: "c1",
      state: "failed" as const,
      error: "No model is available for the permanent Personal Assistant",
    };
    await act(async () => socket.receive(failure));
    expect(announced()).toEqual([]);

    claim({});
    await act(async () => socket.receive(failure));
    expect(announced()).toEqual([
      "Design review — No model is available for the permanent Personal Assistant",
    ]);
  });

  // A staged first send is creating the session it is about, so it claims the
  // situation rather than an object — and that claim is made while the send is
  // in flight, because the decision happens when the failure LANDS.
  it("leaves a staged first send to narrate its own failure", async () => {
    claim({ stagedSend: { sessionId: "c1" } });
    // The server's pre-creation refusals name nothing — there is no session to
    // name yet — and a claude-sdk send's own prompt failure names the id that
    // send supplied. Both are the line under the kept prompt.
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Model openai/gpt-5 is not available.",
      }),
    );
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to send prompt: engine did not start",
        target: { type: "session", id: "c1" },
        failedPromptClientRequestId: "creq-1",
      }),
    );
    expect(announced()).toEqual([]);

    // A background session failing during that window is NOT this bootstrap's,
    // and has nowhere on screen to be seen.
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to rename session: session not found.",
        target: { type: "session", id: "s1" },
      }),
    );
    expect(announced()).toEqual([
      "Design review — Failed to rename session: session not found.",
    ]);
  });
});

/**
 * The same rule for the three other objects that own a surface. Each of these is
 * the session case restated, and each was a shipped bug once: a claim wider than
 * what a surface draws, a global slot that lost one object's failure to the next,
 * and a retirement that followed the traffic instead of the object.
 */
describe("a failure about a project or Task", () => {
  const failure = (
    type: "project" | "task",
    id: string,
    message: string,
  ): ServerMessage => ({ type: "error", message, target: { type, id } });

  it("keeps the open object's failure in place and announces the others", async () => {
    claim({
      openObjects: { project: ["p1"], task: ["t1"] },
    });
    await act(async () => {
      socket.receive(
        failure("project", "p1", "Failed to save project: EACCES"),
      );
      socket.receive(failure("task", "t1", "Failed to archive task: locked"));
    });
    expect(announced()).toEqual([]);
    expect(latestState.objectFailures).toEqual({
      project: { p1: "Failed to save project: EACCES" },
      task: { t1: "Failed to archive task: locked" },
    });

    // A member that is only a ROW in a list has no failure surface, so it is
    // announced NAMING the object — never suppressed on the strength of some
    // other member of the same type being open.
    await act(async () =>
      socket.receive(failure("task", "t2", "Failed to delete task: locked")),
    );
    expect(announced()).toEqual(["Task t2 — Failed to delete task: locked"]);
    expect(latestState.objectFailures.task).toEqual({
      t1: "Failed to archive task: locked",
      t2: "Failed to delete task: locked",
    });
  });

  // A claim covers what the surface DRAWS. The object's note exists for a
  // failure, so a warning about that same object still has nowhere to go.
  it("still announces a warning about the object on screen", async () => {
    claim({ openObjects: { project: [], task: ["t1"] } });
    await act(async () =>
      socket.receive({
        type: "notice",
        severity: "warning",
        message: "This Task has no project.",
        target: { type: "task", id: "t1" },
      }),
    );
    expect(announced()).toEqual(["Task t1 — This Task has no project."]);
    expect(latestState.objectFailures.task).toEqual({});
  });

  // Retirement follows the object it names, and survives everything else.
  it("retires one object's failure by that object's own next write", async () => {
    claim({ openObjects: { project: [], task: ["t1"] } });
    await act(async () => {
      socket.receive(failure("task", "t1", "Failed to archive task: locked"));
      socket.receive(failure("task", "t2", "Failed to delete task: locked"));
    });

    // Another Task's write, and unrelated traffic, leave both standing.
    await act(async () => latestActions.archiveTask("t3"));
    await act(async () => socket.receive({ type: "models", models: [] }));
    expect(Object.keys(latestState.objectFailures.task)).toEqual(["t1", "t2"]);

    await act(async () => latestActions.archiveTask("t1"));
    expect(latestState.objectFailures.task).toEqual({
      t2: "Failed to delete task: locked",
    });

    // And the note's own dismiss retires the other one.
    await act(async () => latestActions.dismissObjectFailure("task", "t2"));
    expect(latestState.objectFailures.task).toEqual({});
  });

  // A tracked write is refused ON ITS CONTROL, which renders it: keeping a copy
  // on the object would print the same sentence twice on one page. It is still
  // an arrival, so it is announced when that surface is not on screen.
  it("leaves a refused control's failure to that control", async () => {
    await act(async () =>
      socket.receive({
        type: "taskList",
        list: { request: {}, items: [], updatedAt: 1 },
        seq: 1,
        revisions: [],
      }),
    );
    claim({ openObjects: { project: [], task: ["t1"] } });
    await act(async () => latestActions.saveTask({ id: "t1", title: "Two" }));
    const write = socket.sent.find((message) => message.type === "saveTask");
    const requestId = write?.type === "saveTask" ? write.requestId : undefined;
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to save task: conflict",
        ...(requestId !== undefined ? { requestId } : {}),
        target: { type: "task", id: "t1" },
      }),
    );
    expect(announced()).toEqual([]);
    expect(latestState.objectFailures.task).toEqual({});

    // The same refusal with that Task's page closed reaches the user the only
    // other way there is. It used to return before the announcement, so a write
    // the user had navigated away from was reported nowhere at all.
    claim({});
    await act(async () => latestActions.saveTask({ id: "t1", title: "Three" }));
    const second = socket.sent.filter(
      (message) => message.type === "saveTask",
    )[1];
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to save task: conflict",
        ...(second?.type === "saveTask" ? { requestId: second.requestId } : {}),
        target: { type: "task", id: "t1" },
      }),
    );
    expect(announced()).toEqual(["Task t1 — Failed to save task: conflict"]);
  });

  // A list that could not be read is a condition on the COLLECTION, like the
  // project and worktree lists before it.
  it("keeps a Task list failure on its pane instead of announcing it", async () => {
    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to list tasks: disk full",
        target: { type: "task" },
      }),
    );
    expect(announced()).toEqual([]);
    expect(latestState.taskListError).toBe("Failed to list tasks: disk full");
    expect(latestState.objectFailures.task).toEqual({});
  });
});

/**
 * The Backlog's project assignment is the one tracked Task write with no
 * in-place slot to be refused in: its receipt IS a toast, so its failure is a
 * message like any other and answers to the same rule.
 */
describe("the Backlog's project assignment", () => {
  const prefs = {
    backlogView: "backlog",
    backlogViewMode: "normal",
    backlogProjectFilter: ALL_PROJECT_FILTER,
    backlogStatusFilter: ["todo", "doing", "done"],
  } as Prefs;

  function BacklogHarness({ state }: { state: BacklogState }) {
    useBacklog(
      state,
      { listProjects: () => {} } as unknown as AssistantActions,
      prefs,
      () => {},
    );
    return null;
  }

  it("says a failed assignment at the arrival that reports it", async () => {
    await act(async () =>
      socket.receive({
        type: "taskList",
        list: { request: {}, items: [], updatedAt: 1 },
        seq: 1,
        revisions: [],
      }),
    );
    await act(async () =>
      latestActions.assignTaskProjects([{ id: "t1", projectId: "p1" }]),
    );
    const write = socket.sent.find(
      (message) => message.type === "assignTaskProjects",
    );
    const requestId =
      write?.type === "assignTaskProjects" ? write.requestId : undefined;
    expect(requestId).toBeTruthy();

    await act(async () =>
      socket.receive({
        type: "error",
        message: "Failed to assign task projects: disk full",
        ...(requestId !== undefined ? { requestId } : {}),
      }),
    );
    expect(announced()).toEqual(["Failed to assign task projects: disk full"]);
  });

  // The record of that failure is kept for the surfaces that render it, and
  // keeping it must not be a second way to SAY it: a controller mounted while
  // the record is still `error` would otherwise re-announce a failure that
  // happened before it existed, with no arrival behind it.
  it("does not re-announce a stored failure to a surface that mounts later", async () => {
    const state = {
      connected: true,
      taskList: { items: [], updatedAt: 1 },
      projectList: null,
      taskMutations: {
        [taskMutationKey(null, "assignProjects")]: failed<true>(
          "Failed to assign task projects: disk full",
        ),
      },
      taskProjectsAssignedSeq: 0,
      sessions: [],
      worktreeMerge: {},
    } as unknown as UIState as BacklogState;

    const later = createRoot(
      document.body.appendChild(document.createElement("div")),
    );
    await act(async () => later.render(<BacklogHarness state={state} />));
    expect(announced()).toEqual([]);
    act(() => later.unmount());
  });
});
