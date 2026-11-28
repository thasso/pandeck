// @vitest-environment jsdom
/**
 * The Schedules web state through the real reducer, effects and socket
 * (`docs/schedules.md`, Web): the history read's failed-attempt barrier
 * (H1–H8), the optimistic write contract (F007), the delete lifecycle the
 * page dialog relies on (D1, D2, D5, D6), and the Pause write. "Flush" is
 * five render/effect flushes plus one unrelated reducer action.
 *   cd app/web && pnpm exec vitest run src/scheduleWebScenario.test.tsx
 */
import { act, memo, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type {
  ScheduleOccurrenceSummary,
  ScheduleSummary,
} from "@assistant/shared/schedules";
import {
  SCHEDULES_PAUSE_KEY,
  scheduleMutationKey,
  useAssistant,
  type AssistantActions,
  type UIState,
} from "./hooks/useAssistant.ts";
import { dismissToast, getToasts } from "./lib/toast.ts";
import { resetFailureHomes, setFailureHomes } from "./lib/messageArrival.ts";

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
    onboarding: "complete",
    serverBuild: { version: "0.0.0-test" },
    state: null,
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
  };
}

let latestState: UIState;
let latestActions: AssistantActions;
let rowRenders = 0;

/**
 * A memoized stand-in row: it renders only on a new summary object, so its
 * count proves the replica's identity for unchanged Schedules. It is not
 * the page's `ScheduleRow`, which is not memoized, so it says nothing about
 * that row's redraws.
 */
const Row = memo(function Row({ schedule }: { schedule: ScheduleSummary }) {
  rowRenders += 1;
  return <span>{schedule.name}</span>;
});

function Harness() {
  const { actions, state } = useAssistant();
  latestState = state;
  latestActions = actions;
  useEffect(() => actions.setTopics(["sessions", "schedules"]), [actions]);
  return (
    <>
      {state.schedules.map((schedule) => (
        <Row key={schedule.id} schedule={schedule} />
      ))}
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  ScenarioSocket.instances = [];
  rowRenders = 0;
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.stubGlobal("WebSocket", ScenarioSocket);
  window.localStorage.clear();
  resetFailureHomes();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFailureHomes();
});

function summary(
  id: string,
  overrides: Partial<ScheduleSummary> = {},
): ScheduleSummary {
  return {
    id,
    name: `Schedule ${id}`,
    prompt: "Check the build",
    enabled: true,
    timing: { kind: "daily", time: "11:00", timeZone: "Europe/Berlin" },
    target: { kind: "session", sessionId: "s1" },
    createdBy: { kind: "session", sessionId: "s1" },
    controlledBy: { kind: "session", sessionId: "s1" },
    cardless: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function occurrence(id: string): ScheduleOccurrenceSummary {
  return {
    id,
    scheduleId: "a",
    state: "delivered",
    dueAtMs: 1_000,
    sessionId: "s1",
  };
}

let seq = 5;

function list(items: ScheduleSummary[], revision = 2): ServerMessage {
  seq += 1;
  return {
    type: "scheduleList",
    items,
    seq,
    revisions: items.map((item) => ({ id: item.id, revision })),
  };
}

function upsert(item: ScheduleSummary, revision: number): ServerMessage {
  seq += 1;
  return {
    type: "stateEvents",
    topic: "schedules",
    seq,
    events: [{ kind: "upsert", id: item.id, revision, item }],
  };
}

function remove(id: string, revision: number): ServerMessage {
  seq += 1;
  return {
    type: "stateEvents",
    topic: "schedules",
    seq,
    events: [{ kind: "delete", id, revision }],
  };
}

async function connected(items: ScheduleSummary[] = [summary("a")]) {
  seq = 5;
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive(list(items));
  });
  return socket;
}

function sentOf<T extends ClientMessage["type"]>(
  socket: ScenarioSocket,
  type: T,
): Extract<ClientMessage, { type: T }>[] {
  return socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: T }> =>
      message.type === type,
  );
}

const historyRequests = (socket: ScenarioSocket) =>
  sentOf(socket, "getScheduleHistory");

/** Five render/effect flushes and one unrelated reducer action. */
async function flush(socket: ScenarioSocket) {
  for (let i = 0; i < 5; i += 1) await act(async () => {});
  await act(async () =>
    socket.receive({ type: "mutationSettled", requestId: "unrelated" }),
  );
}

async function answerHistory(
  socket: ScenarioSocket,
  requestId: string,
  answer: Partial<Extract<ServerMessage, { type: "scheduleHistory" }>>,
) {
  await act(async () =>
    socket.receive({
      type: "scheduleHistory",
      id: "a",
      requestId,
      items: [],
      ...answer,
    } as ServerMessage),
  );
}

/** Open the detail's history and answer its first read at revision 2. */
async function openWithHistory(socket: ScenarioSocket) {
  await act(async () => latestActions.openScheduleHistory("a"));
  const first = historyRequests(socket);
  expect(first).toHaveLength(1);
  await answerHistory(socket, first[0]!.requestId, {
    revision: 2,
    items: [occurrence("o1")],
  });
  expect(latestState.scheduleHistory.a?.load).toMatchObject({
    status: "ready",
    data: [occurrence("o1")],
  });
}

describe("the history read (H1–H8)", () => {
  it("H1: a failed refresh keeps its items, blocks re-requests, and Retry asks once", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    const requests = historyRequests(socket);
    expect(requests).toHaveLength(2);
    await answerHistory(socket, requests[1]!.requestId, {
      items: null,
      error: "database is locked",
    });
    expect(latestState.scheduleHistory.a?.load).toMatchObject({
      status: "error",
      data: [occurrence("o1")],
      error: "database is locked",
    });
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(2);

    await act(async () => latestActions.retryScheduleHistory("a"));
    const retried = historyRequests(socket);
    expect(retried).toHaveLength(3);
    await answerHistory(socket, retried[2]!.requestId, {
      revision: 3,
      items: [occurrence("o2")],
    });
    expect(latestState.scheduleHistory.a?.load).toEqual({
      status: "ready",
      data: [occurrence("o2")],
    });
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(3);
  });

  it("H2: a timeout fails the attempt; a late matching answer is adopted with no send", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    vi.useFakeTimers();
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    const timedOut = historyRequests(socket)[1]!;
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(latestState.scheduleHistory.a?.load).toMatchObject({
      status: "error",
      error: "The server did not answer. Try again.",
      data: [occurrence("o1")],
    });
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(2);
    await answerHistory(socket, timedOut.requestId, {
      revision: 3,
      items: [occurrence("o2")],
    });
    expect(latestState.scheduleHistory.a?.load).toEqual({
      status: "ready",
      data: [occurrence("o2")],
    });
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(2);
  });

  it("H2: Retry after a timeout asks once, and the earlier late answer is then ignored", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    vi.useFakeTimers();
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    const timedOut = historyRequests(socket)[1]!;
    await act(async () => vi.advanceTimersByTime(10_000));
    await act(async () => latestActions.retryScheduleHistory("a"));
    expect(historyRequests(socket)).toHaveLength(3);
    const before = latestState.scheduleHistory.a;
    await answerHistory(socket, timedOut.requestId, {
      revision: 3,
      items: [occurrence("late")],
    });
    expect(latestState.scheduleHistory.a).toBe(before);
  });

  it("H3: a newer generation lifts the barrier once; failing it again blocks again", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    await answerHistory(socket, historyRequests(socket)[1]!.requestId, {
      items: null,
      error: "boom",
    });
    await act(async () => socket.receive(upsert(summary("a"), 4)));
    expect(historyRequests(socket)).toHaveLength(3);
    expect(historyRequests(socket)[2]).toMatchObject({ id: "a" });
    await answerHistory(socket, historyRequests(socket)[2]!.requestId, {
      items: null,
      error: "boom",
    });
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(3);
  });

  it("H4: a failure survives the disconnect and catch-up re-arms exactly one request", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    await answerHistory(socket, historyRequests(socket)[1]!.requestId, {
      items: null,
      error: "boom",
    });
    vi.useFakeTimers();
    await act(async () => socket.close());
    expect(historyRequests(socket)).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    await flush(next);
    expect(historyRequests(next)).toHaveLength(0);
    await act(async () => next.receive(list([summary("a")], 3)));
    expect(historyRequests(next)).toHaveLength(1);
    await flush(next);
    expect(historyRequests(next)).toHaveLength(1);
  });

  it("H4: an attempt in flight at the disconnect fails, sends nothing offline, and asks once after catch-up", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    expect(historyRequests(socket)).toHaveLength(2);
    vi.useFakeTimers();
    await act(async () => socket.close());
    expect(latestState.scheduleHistory.a?.attempt?.status).toBe("failed");
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    expect(historyRequests(next)).toHaveLength(0);
    await act(async () => next.receive(list([summary("a")], 3)));
    expect(historyRequests(next)).toHaveLength(1);
  });

  it("H5: a newer event waits for the read in flight, then asks once for the newer revision", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    await act(async () => socket.receive(upsert(summary("a"), 4)));
    expect(historyRequests(socket)).toHaveLength(2);
    await answerHistory(socket, historyRequests(socket)[1]!.requestId, {
      revision: 3,
      items: [occurrence("o2")],
    });
    expect(latestState.scheduleHistory.a?.load).toMatchObject({
      data: [occurrence("o2")],
    });
    expect(historyRequests(socket)).toHaveLength(3);
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(3);
  });

  it("H6: a superseded answer changes nothing", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    const before = latestState;
    await answerHistory(socket, "someone-elses", {
      revision: 9,
      items: [occurrence("x")],
    });
    expect(latestState.scheduleHistory).toBe(before.scheduleHistory);
  });

  it("H7: a topic delete drops the entry and its late answer; `items: null` is not-found", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => socket.receive(upsert(summary("a"), 3)));
    const pending = historyRequests(socket)[1]!;
    await act(async () => socket.receive(remove("a", 4)));
    expect(latestState.scheduleHistory.a).toBeUndefined();
    await answerHistory(socket, pending.requestId, {
      revision: 3,
      items: [occurrence("late")],
    });
    expect(latestState.scheduleHistory.a).toBeUndefined();

    const other = await reconnectFresh([summary("a")]);
    await act(async () => latestActions.openScheduleHistory("a"));
    await answerHistory(other, historyRequests(other)[0]!.requestId, {
      items: null,
    });
    expect(latestState.scheduleHistory.a?.load).toEqual({
      status: "ready",
      data: null,
    });
    await flush(other);
    expect(historyRequests(other)).toHaveLength(1);
  });

  it("H8: closing and reopening starts over with exactly one fresh request", async () => {
    const socket = await connected();
    await openWithHistory(socket);
    await act(async () => latestActions.closeScheduleHistory("a"));
    expect(latestState.scheduleHistory.a).toBeUndefined();
    await act(async () => latestActions.openScheduleHistory("a"));
    expect(historyRequests(socket)).toHaveLength(2);
    expect(latestState.scheduleHistory.a?.load.status).toBe("loading");
    await flush(socket);
    expect(historyRequests(socket)).toHaveLength(2);
  });
});

/** A second, independent hook instance on a fresh socket. */
async function reconnectFresh(items: ScheduleSummary[]) {
  act(() => root.unmount());
  root = createRoot(container);
  const index = ScenarioSocket.instances.length;
  await act(async () => root.render(<Harness />));
  const socket = ScenarioSocket.instances[index]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive(list(items));
  });
  return socket;
}

describe("the optimistic write contract (F007)", () => {
  it("settles a no-op on/off at the held revision: sidecar advanced, identity kept, no extra render", async () => {
    const socket = await connected();
    await act(async () => latestActions.setScheduleEnabled("a", true));
    const [sent] = sentOf(socket, "setScheduleEnabled");
    expect(sent).toMatchObject({ id: "a", enabled: true });
    const guessed = latestState.schedules[0]!;
    // R1: the user's on/off takes control even when nothing else changes.
    expect(guessed.controlledBy).toEqual({ kind: "user" });

    const reply = summary("a", { controlledBy: { kind: "user" } });
    await act(async () =>
      socket.receive({
        type: "scheduleSaved",
        item: reply,
        revision: 3,
        requestId: sent!.requestId,
      }),
    );
    expect(latestState.stateEventRevisions.schedules?.a).toBe(3);
    expect(latestState.schedules[0]).toBe(guessed);

    const count = rowRenders;
    const schedules = latestState.schedules;
    await act(async () => socket.receive(upsert(reply, 3)));
    expect(latestState.schedules).toBe(schedules);
    expect(rowRenders).toBe(count);
  });

  it("keeps identity when the event at the same revision lands before the reply", async () => {
    const socket = await connected();
    await act(async () => latestActions.setScheduleEnabled("a", false));
    const [sent] = sentOf(socket, "setScheduleEnabled");
    const reply = summary("a", {
      enabled: false,
      controlledBy: { kind: "user" },
    });
    await act(async () => socket.receive(upsert(reply, 3)));
    const held = latestState.schedules[0]!;
    const count = rowRenders;
    await act(async () =>
      socket.receive({
        type: "scheduleSaved",
        item: reply,
        revision: 3,
        requestId: sent!.requestId,
      }),
    );
    expect(latestState.schedules[0]).toBe(held);
    expect(latestState.stateEventRevisions.schedules?.a).toBe(3);
    expect(rowRenders).toBe(count);
  });

  it("ignores a second click on the same control while the first is pending", async () => {
    const socket = await connected();
    // Two clicks are two events, with a render between them.
    await act(async () => latestActions.setScheduleEnabled("a", false));
    await act(async () => latestActions.setScheduleEnabled("a", true));
    expect(sentOf(socket, "setScheduleEnabled")).toHaveLength(1);
  });

  it("recovers the Schedule after a stamped refusal and keeps the refusal on its control", async () => {
    const socket = await connected();
    setFailureHomes({
      viewedSessionId: null,
      panelSessionId: null,
      stagedSend: null,
      openObjects: { project: [], task: [] },
      controls: [scheduleMutationKey("a", "enabled")],
    });
    await act(async () => latestActions.setScheduleEnabled("a", false));
    const [sent] = sentOf(socket, "setScheduleEnabled");
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: sent!.requestId,
        message: "Failed to switch Schedule: Schedule not found",
        target: { type: "schedule", id: "a" },
      }),
    );
    expect(sentOf(socket, "getStateItems")).toMatchObject([
      { topic: "schedules", ids: ["a"] },
    ]);
    expect(
      latestState.scheduleMutations[scheduleMutationKey("a", "enabled")],
    ).toMatchObject({
      status: "error",
      error: "Failed to switch Schedule: Schedule not found",
    });
    // In place: not announced, not the chat's, not the object's leftover.
    expect(getToasts()).toEqual([]);
    expect(latestState.error).toBeNull();
    expect(latestState.objectFailures.schedule).toEqual({});
  });

  it("announces the refusal once its control is gone (navigation released the claim)", async () => {
    const socket = await connected();
    await act(async () => latestActions.setScheduleEnabled("a", false));
    const [sent] = sentOf(socket, "setScheduleEnabled");
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: sent!.requestId,
        message: "Failed to switch Schedule: Schedule not found",
        target: { type: "schedule", id: "a" },
      }),
    );
    expect(getToasts().map((toast) => toast.message)).toEqual([
      expect.stringContaining("Schedule not found"),
    ]);
  });

  it("recovers after a timeout, with the generic no-answer reason on the control", async () => {
    const socket = await connected();
    vi.useFakeTimers();
    await act(async () => latestActions.setScheduleEnabled("a", false));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sentOf(socket, "getStateItems")).toMatchObject([
      { topic: "schedules", ids: ["a"] },
    ]);
    expect(
      latestState.scheduleMutations[scheduleMutationKey("a", "enabled")],
    ).toMatchObject({
      status: "error",
      error: "The server did not answer. Try again.",
    });
  });

  it("recovers a write sent before a disconnect; an unsent one stays pending until reconnect", async () => {
    const socket = await connected();
    vi.useFakeTimers();
    await act(async () =>
      latestActions.updateSchedule("a", { prompt: "Sent before the drop" }),
    );
    expect(sentOf(socket, "updateSchedule")).toHaveLength(1);
    await act(async () => socket.close());
    // Offline: the next write is queued, not lost and not sent.
    await act(async () => latestActions.setScheduleEnabled("a", false));
    expect(
      latestState.scheduleMutations[scheduleMutationKey("a", "enabled")]
        ?.status,
    ).toBe("loading");
    await act(async () => vi.advanceTimersByTime(1000));
    const next = ScenarioSocket.instances[1]!;
    await act(async () => next.open());
    // The sent write's fate is unknown: it is recovered, not resent.
    expect(sentOf(next, "updateSchedule")).toHaveLength(0);
    expect(sentOf(next, "setScheduleEnabled")).toHaveLength(1);
  });

  it("sends only the changed fields of an edit (R4)", async () => {
    const socket = await connected();
    await act(async () =>
      latestActions.updateSchedule("a", { prompt: "New prompt" }),
    );
    expect(sentOf(socket, "updateSchedule")).toMatchObject([
      { id: "a", patch: { prompt: "New prompt" } },
    ]);
    expect(latestState.schedules[0]?.prompt).toBe("New prompt");
  });
});

describe("the delete lifecycle (D2, D5, D6)", () => {
  it("D2/D5/D6: one correlated send, a refusal restores the row, Try again sends once more", async () => {
    const socket = await connected([summary("a"), summary("b")]);
    setFailureHomes({
      viewedSessionId: null,
      panelSessionId: null,
      stagedSend: null,
      openObjects: { project: [], task: [] },
      controls: [scheduleMutationKey("a", "delete")],
    });
    await act(async () => latestActions.deleteSchedule("a"));
    const deletes = sentOf(socket, "deleteSchedule");
    expect(deletes).toEqual([
      { type: "deleteSchedule", id: "a", requestId: expect.any(String) },
    ]);
    // Optimistic removal; the sibling stays.
    expect(latestState.schedules.map((row) => row.id)).toEqual(["b"]);
    expect(
      latestState.scheduleMutations[scheduleMutationKey("a", "delete")]?.status,
    ).toBe("loading");

    await act(async () =>
      socket.receive({
        type: "error",
        requestId: deletes[0]!.requestId,
        message: "Failed to delete Schedule: database is locked",
        target: { type: "schedule", id: "a" },
      }),
    );
    expect(getToasts()).toEqual([]);
    expect(
      latestState.scheduleMutations[scheduleMutationKey("a", "delete")],
    ).toMatchObject({
      status: "error",
      error: "Failed to delete Schedule: database is locked",
    });
    const [recovery] = sentOf(socket, "getStateItems");
    expect(recovery).toMatchObject({ topic: "schedules", ids: ["a"] });
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "schedules",
        requestId: recovery!.requestId,
        events: [{ kind: "upsert", id: "a", revision: 2, item: summary("a") }],
      }),
    );
    expect(latestState.schedules.map((row) => row.id).sort()).toEqual([
      "a",
      "b",
    ]);

    await act(async () => latestActions.deleteSchedule("a"));
    expect(sentOf(socket, "deleteSchedule")).toHaveLength(2);
  });
});

describe("Pause all", () => {
  it("guesses the new value, ignores a repeated click, and recovers settings on a refusal", async () => {
    const socket = await connected();
    await act(async () => latestActions.setSchedulesPaused(true));
    await act(async () => latestActions.setSchedulesPaused(true));
    const sent = sentOf(socket, "setSchedulesPaused");
    expect(sent).toEqual([
      {
        type: "setSchedulesPaused",
        paused: true,
        requestId: expect.any(String),
      },
    ]);
    expect(latestState.settings.schedules.paused).toBe(true);
    const before = socket.sent.length;
    await act(async () =>
      socket.receive({
        type: "error",
        requestId: sent[0]!.requestId,
        message: "Failed to save Schedules settings: disk full",
      }),
    );
    expect(latestState.scheduleMutations[SCHEDULES_PAUSE_KEY]).toMatchObject({
      status: "error",
      error: "Failed to save Schedules settings: disk full",
    });
    // Recovery re-reads the settings; nothing lands in the chat.
    expect(socket.sent.slice(before).map((message) => message.type)).toContain(
      "requestSettings",
    );
    expect(latestState.error).toBeNull();
  });
});
