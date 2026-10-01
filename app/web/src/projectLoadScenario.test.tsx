// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import {
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";

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

let latestActions: AssistantActions;
let latestState: UIState;

function ProjectHarness() {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  useEffect(() => actions.setTopics(["projects"]), [actions]);
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
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
      projectList: {
        request: { includeArchived: true },
        projects: [{ id: "a", name: "Alpha", key: "AA" }],
        updatedAt: 1,
      },
      projectRevisions: { a: 1 },
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Project socket/reducer scenario", () => {
  it("recovers a rejected save with targeted summary and open-detail reads", async () => {
    await act(async () => root.render(<ProjectHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      latestActions.setOpenProjectProjection("a");
      latestActions.saveProject("a", { name: "Attempted name" });
    });
    const save = socket.sent.find(
      (message) => message.type === "saveProject" && message.id === "a",
    );
    expect(save?.type).toBe("saveProject");
    await act(async () => {
      if (save?.type === "saveProject")
        socket.receive({
          type: "error",
          ...(save.requestId !== undefined
            ? { requestId: save.requestId }
            : {}),
          message: "Save rejected",
        });
    });
    const recovery = socket.sent.find(
      (message) =>
        message.type === "getStateItems" &&
        message.topic === "projects" &&
        message.ids.length === 1 &&
        message.ids[0] === "a",
    );
    expect(recovery?.type).toBe("getStateItems");
    expect(
      socket.sent.some(
        (message) => message.type === "getProject" && message.id === "a",
      ),
    ).toBe(true);
    expect(socket.sent.some((message) => message.type === "listProjects")).toBe(
      false,
    );
    await act(async () => {
      if (recovery?.type === "getStateItems")
        socket.receive({
          type: "stateItems",
          topic: "projects",
          requestId: recovery.requestId,
          events: [
            {
              kind: "upsert",
              id: "a",
              revision: 1,
              item: { id: "a", name: "Alpha", key: "AA" },
            },
          ],
        });
    });
    expect(latestState.projectList?.projects[0]?.name).toBe("Alpha");
    expect(latestState.projectMutations["a:name"]?.status).toBe("error");
  });

  it("settles concurrent repo operations only by their matching request", async () => {
    await act(async () => root.render(<ProjectHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      latestActions.provisionProjectRepo("a");
      latestActions.removeProjectRepo("b");
    });
    const clone = socket.sent.find(
      (message) => message.type === "provisionProjectRepo",
    );
    expect(latestState.projectMutations["a:clone"]?.status).toBe("loading");
    expect(latestState.projectMutations["b:remove"]?.status).toBe("loading");
    await act(async () => {
      socket.receive({
        type: "notice",
        severity: "info",
        message: "Unrelated",
      });
      if (clone?.type === "provisionProjectRepo" && clone.requestId)
        socket.receive({ type: "mutationSettled", requestId: clone.requestId });
    });
    expect(latestState.projectMutations["a:clone"]?.status).toBe("ready");
    expect(latestState.projectMutations["b:remove"]?.status).toBe("loading");
  });

  it("a full snapshot resets digest recovery and the projects seq tripwire", async () => {
    await act(async () => root.render(<ProjectHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    expect(
      socket.sent.some(
        (message) =>
          message.type === "subscribe" &&
          message.topics.includes("projects") &&
          message.digests?.includes("projects"),
      ),
    ).toBe(true);

    await act(async () => {
      socket.receive({
        type: "stateDigest",
        topic: "projects",
        seq: 4,
        entries: [{ id: "a", revision: 2 }],
      });
    });
    const targeted = socket.sent.find(
      (message) =>
        message.type === "getStateItems" && message.topic === "projects",
    );
    expect(targeted?.type).toBe("getStateItems");

    const fullReadsBeforeFiltered = socket.sent.filter(
      (message) => message.type === "listProjects",
    ).length;
    await act(async () => {
      socket.receive({
        type: "projectList",
        list: {
          request: { query: "Alpha" },
          projects: [{ id: "a", name: "Filtered Alpha", key: "AA" }],
          updatedAt: 2,
        },
        seq: 99,
        revisions: [{ id: "a", revision: 2 }],
      });
      if (targeted?.type === "getStateItems")
        socket.receive({
          type: "stateItems",
          topic: "projects",
          requestId: targeted.requestId,
          events: [
            {
              kind: "upsert",
              id: "a",
              revision: 2,
              item: { id: "a", name: "Alpha two", key: "AA" },
            },
          ],
        });
    });
    expect(
      socket.sent.filter((message) => message.type === "listProjects"),
    ).toHaveLength(fullReadsBeforeFiltered);

    await act(async () => {
      socket.receive({
        type: "projectList",
        list: {
          request: { includeArchived: true },
          projects: [{ id: "a", name: "Alpha two", key: "AA" }],
          updatedAt: 2,
        },
        seq: 5,
        revisions: [{ id: "a", revision: 2 }],
      });
      socket.receive({
        type: "stateEvents",
        topic: "projects",
        seq: 6,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 3,
            item: { id: "a", name: "Alpha three", key: "AA" },
          },
        ],
      });
    });

    expect(
      socket.sent.filter(
        (message) =>
          message.type === "unsubscribe" && message.topics.includes("projects"),
      ),
    ).toHaveLength(0);
  });

  /**
   * The Projects pane keeps its list failure as a CONDITION and offers a Retry
   * on it (`docs/messaging.md`). That retry is the canonical read, which is
   * gated once per socket episode — and the gate is set BEFORE the read that
   * failed. Without reopening it the note is permanent for the episode and the
   * button does nothing, which is the same bug the Task and worktree lists
   * already fixed.
   */
  it("reopens the once-per-episode project read when the list fails", async () => {
    await act(async () => root.render(<ProjectHarness />));
    const socket = ScenarioSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    // Subscribing is the authoritative read, so it closes the gate: a canonical
    // read after it is a no-op, which is what makes the pane's Retry dead.
    const readsBeforeFailure = socket.sent.filter(
      (message) => message.type === "listProjects",
    ).length;
    await act(async () => {
      latestActions.listProjects({ includeArchived: true });
    });
    expect(
      socket.sent.filter((message) => message.type === "listProjects"),
    ).toHaveLength(readsBeforeFailure);

    await act(async () => {
      socket.receive({
        type: "error",
        message: "Failed to list projects: boom",
        target: { type: "project" },
      });
    });
    expect(latestState.projectListError).toBe("Failed to list projects: boom");

    // The pane's Retry, which is exactly this call.
    await act(async () => {
      latestActions.listProjects({ includeArchived: true });
    });
    expect(
      socket.sent.filter((message) => message.type === "listProjects"),
    ).toHaveLength(readsBeforeFailure + 1);
  });
});
