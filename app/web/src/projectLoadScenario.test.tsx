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
import { writeAppShellCacheRecord } from "./lib/appShellCacheStore.ts";

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

function ProjectHarness({ held = true }: { held?: boolean }) {
  const { actions, state } = useAssistant();
  latestActions = actions;
  latestState = state;
  useEffect(() => actions.setTopics(held ? ["projects"] : []), [actions, held]);
  return null;
}

async function connected() {
  await act(async () => root.render(<ProjectHarness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  return socket;
}

const projectSubscribes = (messages: ClientMessage[]) =>
  messages.filter(
    (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
      message.type === "subscribe" && message.topics.includes("projects"),
  );
const resubscribes = (messages: ClientMessage[]) =>
  messages.filter(
    (message) =>
      (message.type === "subscribe" || message.type === "unsubscribe") &&
      message.topics.includes("projects"),
  );
const snapshotPair: ClientMessage[] = [
  { type: "unsubscribe", topics: ["projects"] },
  { type: "subscribe", topics: ["projects"] },
];
const projectRow = (name: string) => ({ id: "a", name, key: "AA" });
const canonicalList = (seq: number, name = "Alpha", revision = 1) =>
  ({
    type: "projectList",
    list: {
      request: { includeArchived: true },
      projects: [projectRow(name)],
      updatedAt: seq,
    },
    seq,
    revisions: [{ id: "a", revision }],
  }) satisfies ServerMessage;
const itemFetch = (messages: ClientMessage[]) => {
  const fetch = messages.findLast(
    (message) =>
      message.type === "getStateItems" && message.topic === "projects",
  );
  if (fetch?.type !== "getStateItems") throw new Error("no item fetch");
  return fetch;
};
const rejectSave = (socket: ScenarioSocket) => {
  const save = socket.sent.findLast(
    (message) => message.type === "saveProject" && message.id === "a",
  );
  if (save?.type !== "saveProject" || !save.requestId)
    throw new Error("no save");
  socket.receive({
    type: "error",
    requestId: save.requestId,
    message: "Save rejected",
  });
};
const projectName = () => latestState.projectList?.projects[0]?.name;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  writeAppShellCacheRecord({
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

describe("Project socket/reducer scenario", () => {
  it.each(["save", "clone", "remove"])(
    "releases unknown %s, then recovers after subscribe with the current open detail",
    async (operation) => {
      const socket = await connected();
      await act(async () => socket.receive(canonicalList(1)));
      await act(async () => latestActions.setOpenProjectProjection("a"));
      vi.useFakeTimers();
      await act(async () => {
        if (operation === "save")
          latestActions.saveProject("a", { name: "Optimistic" });
        if (operation === "clone") latestActions.provisionProjectRepo("a");
        if (operation === "remove") latestActions.removeProjectRepo("a");
      });
      const oldCommand = socket.sent.at(-1)!;
      await act(async () => socket.close());
      expect(Object.values(latestState.projectMutations)[0]?.status).toBe(
        "idle",
      );
      if (operation === "save") expect(projectName()).toBe("Optimistic");
      expect(latestState.stateEventRevisions.projects?.a).toBeUndefined();
      const at = socket.sent.length;
      await act(async () => vi.advanceTimersByTime(900_000));
      expect(socket.sent.slice(at)).toEqual([]);
      expect(Object.values(latestState.projectMutations)[0]?.status).toBe(
        "idle",
      );
      const next = ScenarioSocket.instances[1]!;
      await act(async () => next.open());
      expect(next.sent.map((message) => message.type)).toEqual([
        "subscribe",
        "getStateItems",
        "getProject",
      ]);
      expect(next.sent[0]).toEqual({ type: "subscribe", topics: ["projects"] });
      await act(async () => next.receive(canonicalList(2)));
      const fetch = itemFetch(next.sent);
      await act(async () =>
        next.receive({
          type: "stateItems",
          topic: "projects",
          requestId: fetch.requestId,
          events: [
            {
              kind: "upsert",
              id: "a",
              revision: 1,
              item: projectRow("Recovered"),
            },
          ],
        }),
      );
      expect(projectName()).toBe("Recovered");
      await act(async () =>
        latestActions.saveProject("a", { name: "New attempt" }),
      );
      if ("requestId" in oldCommand && oldCommand.requestId)
        await act(async () =>
          next.receive({
            type: "mutationSettled",
            requestId: oldCommand.requestId!,
          }),
        );
      expect(latestState.projectMutations["a:name"]?.status).toBe("loading");
    },
  );

  it("never treats an authoritative snapshot or event as a control answer", async () => {
    const socket = await connected();
    await act(async () => socket.receive(canonicalList(1)));
    await act(async () =>
      latestActions.saveProject("a", { name: "Attempted" }),
    );
    await act(async () => socket.receive(canonicalList(2)));
    expect(latestState.projectMutations["a:name"]?.status).toBe("loading");
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "projects",
        seq: 3,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: projectRow("Other writer"),
          },
        ],
      }),
    );
    expect(projectName()).toBe("Other writer");
    expect(latestState.projectMutations["a:name"]?.status).toBe("loading");
  });

  it("recovers an unheld Project without re-holding it or reading a no-longer-open detail", async () => {
    const socket = await connected();
    await act(async () => socket.receive(canonicalList(1)));
    vi.useFakeTimers();
    await act(async () => latestActions.saveProject("a", { name: "Unknown" }));
    await act(async () => socket.close());
    await act(async () => root.render(<ProjectHarness held={false} />));
    await act(async () => latestActions.setOpenProjectProjection("b"));
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(projectSubscribes(next.sent)).toEqual([]);
    expect(
      next.sent.filter((message) => message.type === "getStateItems"),
    ).toHaveLength(1);
    expect(next.sent.some((message) => message.type === "getProject")).toBe(
      false,
    );
    const fetch = itemFetch(next.sent);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () =>
      next.receive({
        type: "error",
        requestId: fetch.requestId,
        message: "Read failed",
      }),
    );
    expect(projectSubscribes(next.sent)).toEqual([]);
    await act(async () => root.render(<ProjectHarness />));
    expect(projectSubscribes(next.sent)).toEqual([
      { type: "subscribe", topics: ["projects"] },
    ]);
  });
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

  it("keeps repo controls pending for 15 minutes and routes their outcomes locally", async () => {
    vi.useFakeTimers();
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
    await act(async () => vi.advanceTimersByTime(899_999));
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
    await act(async () => vi.advanceTimersByTime(1));
    expect(latestState.projectMutations["b:remove"]?.status).toBe("error");
    expect(latestState.projectMutations["a:clone"]?.status).toBe("ready");
    await act(async () => latestActions.provisionProjectRepo("a"));
    const retry = socket.sent.findLast(
      (message) => message.type === "provisionProjectRepo",
    );
    if (retry?.type !== "provisionProjectRepo")
      throw new Error("no clone retry");
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: retry.requestId!,
        message: "Clone refused",
      }),
    );
    expect(latestState.projectMutations["a:clone"]).toMatchObject({
      status: "error",
      error: "Clone refused",
    });
  });

  it("applies a complete digest catch-up and asks for nothing more", async () => {
    const socket = await connected();
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "projects",
        seq: 4,
        entries: [{ id: "a", revision: 2 }],
      }),
    );
    const fetch = itemFetch(socket.sent);
    expect(fetch.ids).toEqual(["a"]);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "projects",
        requestId: fetch.requestId,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: projectRow("Alpha two"),
          },
        ],
      }),
    );
    expect(projectName()).toBe("Alpha two");
    expect(latestState.projectListFresh).toBe(true);
    expect(socket.sent.slice(sentBefore)).toEqual([]);
  });

  it("falls back to a snapshot when a rejected save's recovery answers incompletely", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => {
      latestActions.saveProject("a", { name: "Attempted name" });
    });
    await act(async () => rejectSave(socket));
    const recovery = itemFetch(socket.sent);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "projects",
        requestId: recovery.requestId,
        events: [],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(snapshotPair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] projects recovery fallback: targeted item response was incomplete",
    );
    expect(latestState.stateEventRevisions.projects).not.toHaveProperty("a");
  });

  it("falls back from a digest over an untrusted baseline by resubscribing, not listProjects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A cached list with no revisions is no baseline for a digest.
    writeAppShellCacheRecord({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: {},
      slashCommands: [],
      projectList: {
        request: { includeArchived: true },
        projects: [projectRow("Alpha")],
        updatedAt: 1,
      },
    });
    const socket = await connected();
    expect(projectSubscribes(socket.sent)).toEqual([
      { type: "subscribe", topics: ["projects"] },
    ]);
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "projects",
        seq: 4,
        entries: [{ id: "a", revision: 1 }],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(snapshotPair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] projects digest fallback: cached objects or revisions were invalid",
    );
  });

  /**
   * A recovery that cannot complete leaves the optimistic value on screen with
   * a revision beside it that a digest would trust. Here the topic was let go
   * first, so nothing may be resubscribed: the next subscribe must instead ask
   * for the snapshot that restores the server's value.
   */
  it("makes the next subscribe a snapshot when an unheld recovery times out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => socket.receive(canonicalList(1)));
    vi.useFakeTimers();
    await act(async () => {
      latestActions.saveProject("a", { name: "Attempted name" });
    });
    expect(projectName()).toBe("Attempted name");
    await act(async () => root.render(<ProjectHarness held={false} />));
    expect(
      socket.sent.filter(
        (message) =>
          message.type === "unsubscribe" && message.topics.includes("projects"),
      ),
    ).toHaveLength(1);
    const droppedAt = socket.sent.length;
    await act(async () => rejectSave(socket));
    itemFetch(socket.sent.slice(droppedAt));

    await act(async () => vi.advanceTimersByTime(10_001));
    expect(projectSubscribes(socket.sent.slice(droppedAt))).toEqual([]);
    expect(latestState.stateEventRevisions.projects).not.toHaveProperty("a");
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] projects recovery fallback: targeted item fetch timed out",
    );

    await act(async () => root.render(<ProjectHarness />));
    expect(projectSubscribes(socket.sent.slice(droppedAt))).toEqual([
      { type: "subscribe", topics: ["projects"] },
    ]);
    await act(async () => socket.receive(canonicalList(2)));
    expect(projectName()).toBe("Alpha");

    // The snapshot re-seeded the baseline: a later re-take digests again.
    await act(async () => root.render(<ProjectHarness held={false} />));
    const retakenAt = socket.sent.length;
    await act(async () => root.render(<ProjectHarness />));
    expect(projectSubscribes(socket.sent.slice(retakenAt))).toEqual([
      { type: "subscribe", topics: ["projects"], digests: ["projects"] },
    ]);
  });

  it("makes the reconnect a snapshot when a recovery is open at the disconnect", async () => {
    const socket = await connected();
    vi.useFakeTimers();
    await act(async () => {
      latestActions.saveProject("a", { name: "Attempted name" });
    });
    await act(async () => rejectSave(socket));
    itemFetch(socket.sent);
    await act(async () => socket.close());
    expect(latestState.stateEventRevisions.projects).not.toHaveProperty("a");
    await act(async () => vi.advanceTimersByTime(1_000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(projectSubscribes(next.sent)).toEqual([
      { type: "subscribe", topics: ["projects"] },
    ]);
    // The dropped recovery's timer is gone with it.
    await act(async () => vi.advanceTimersByTime(10_001));
    expect(resubscribes(next.sent)).toHaveLength(1);
  });

  /**
   * A filtered list answers one read; it is no snapshot of the topic. It must
   * neither cancel the catch-up in flight nor rebaseline the seq, which only
   * the canonical list may do.
   */
  it("lets only the canonical list rebaseline the seq or cancel the catch-up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    expect(
      projectSubscribes(socket.sent).some((message) =>
        message.digests?.includes("projects"),
      ),
    ).toBe(true);
    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "projects",
        seq: 4,
        entries: [{ id: "a", revision: 2 }],
      }),
    );
    const fetch = itemFetch(socket.sent);
    await act(async () => {
      socket.receive({
        type: "projectList",
        list: {
          request: { query: "Alpha" },
          projects: [projectRow("Filtered Alpha")],
          updatedAt: 2,
        },
        seq: 99,
        revisions: [{ id: "a", revision: 2 }],
      });
      socket.receive({
        type: "stateItems",
        topic: "projects",
        requestId: fetch.requestId,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: projectRow("Alpha two"),
          },
        ],
      });
    });
    // The catch-up was still open: it applied and settled the list.
    expect(projectName()).toBe("Alpha two");
    expect(latestState.projectListFresh).toBe(true);

    // Seq 5 continues the digest's 4; had 99 been adopted, this would gap.
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "projects",
        seq: 5,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 3,
            item: projectRow("Alpha three"),
          },
        ],
      }),
    );
    expect(resubscribes(socket.sent.slice(sentBefore))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(projectName()).toBe("Alpha three");

    await act(async () => {
      socket.receive(canonicalList(10, "Alpha three", 3));
      socket.receive({
        type: "stateEvents",
        topic: "projects",
        seq: 11,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 4,
            item: projectRow("Alpha four"),
          },
        ],
      });
    });
    expect(resubscribes(socket.sent.slice(sentBefore))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(projectName()).toBe("Alpha four");
  });

  it("resubscribes for a snapshot, never a digest, on a seq gap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = await connected();
    await act(async () => socket.receive(canonicalList(3)));
    const sentBefore = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "projects",
        seq: 5,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 2,
            item: projectRow("Alpha two"),
          },
        ],
      }),
    );
    expect(socket.sent.slice(sentBefore)).toEqual(snapshotPair);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] projects event gap: expected seq 4, got 5; resubscribing.",
    );
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
