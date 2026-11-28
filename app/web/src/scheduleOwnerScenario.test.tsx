// @vitest-environment jsdom
/**
 * The Schedules page and detail driven through the real `useAssistant`
 * reducer, effects and socket, with claims fed to the arrival rules the way
 * `App.tsx` feeds them (`docs/schedules.md`, Web):
 * - F102: a save's success clears only the fields it sent, keeping newer
 *   edits, through a refusal and a concurrent summary too.
 * - F105: a page or detail reopened while its write is pending adopts the
 *   outcome, shows it with Try again repeating what was sent, and a refusal
 *   whose control is gone is announced, never neither.
 * - F111: Try again passes Save's guards: no send for an invalid timing or an
 *   empty prompt, and it sends the current draft.
 *   cd app/web && pnpm exec vitest run src/scheduleOwnerScenario.test.tsx
 */
import { act, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { FakeSocket } from "./test/fakeSocket.ts";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";
import { dismissToast, getToasts } from "./lib/toast.ts";
import { resetFailureHomes, setFailureHomes } from "./lib/messageArrival.ts";
import { SchedulesPage } from "./components/schedules/SchedulesPage.tsx";
import { ScheduleDetailPage } from "./components/schedules/ScheduleDetailPage.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type View = "page" | "detail" | "away";
let showView: (view: View) => void = () => {};
let latestState: UIState;
const ARCHIVED = { sessions: [], loaded: true, pending: false, error: null };

/** One App-like owner: the hook, the claims, and one surface at a time. */
function Owner({ initial }: { initial: View }) {
  const { actions, state } = useAssistant();
  latestState = state;
  const [view, setView] = useState<View>(initial);
  showView = setView;
  const [claims, setClaims] = useState<readonly string[]>([]);
  const claim = useCallback((keys: readonly string[]) => setClaims(keys), []);
  const open = useCallback(() => {}, []);
  useEffect(() => actions.setTopics(["sessions", "schedules"]), [actions]);
  useEffect(() => {
    setFailureHomes({
      viewedSessionId: null,
      stagedSend: null,
      openObjects: {
        project: [],
        task: [],
        schedule: view === "detail" ? ["a"] : [],
      },
      controls: claims,
    });
  }, [claims, view]);
  const answered = state.stateEventRevisions.schedules !== undefined;
  if (view === "page")
    return (
      <SchedulesPage
        schedules={state.schedules}
        answered={answered}
        listError={state.scheduleListError}
        onRetry={actions.retrySchedules}
        paused={state.settings.schedules.paused}
        mutations={state.scheduleMutations}
        attempts={state.scheduleAttempts}
        onSetPaused={actions.setSchedulesPaused}
        onSetEnabled={actions.setScheduleEnabled}
        onDelete={actions.deleteSchedule}
        onOpen={open}
        onClaimControls={claim}
      />
    );
  if (view === "detail")
    return (
      <ScheduleDetailPage
        id="a"
        schedule={state.schedules.find((item) => item.id === "a")}
        answered={answered}
        listError={state.scheduleListError}
        onRetry={actions.retrySchedules}
        history={state.scheduleHistory.a}
        mutations={state.scheduleMutations}
        attempts={state.scheduleAttempts}
        failure={state.objectFailures.schedule.a}
        liveSessions={state.liveSessions}
        archived={ARCHIVED}
        onRequestArchived={actions.loadArchivedSessions}
        onSave={actions.updateSchedule}
        onDelete={actions.deleteSchedule}
        onOpenHistory={actions.openScheduleHistory}
        onCloseHistory={actions.closeScheduleHistory}
        onRetryHistory={actions.retryScheduleHistory}
        onOpen={open}
        onClaimControls={claim}
      />
    );
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  FakeSocket.instances = [];
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  window.localStorage.clear();
  resetFailureHomes();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.unstubAllGlobals();
  resetFailureHomes();
});

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "a",
    name: "Morning check",
    prompt: "Check the build",
    enabled: true,
    timing: { kind: "daily", time: "11:00", timeZone: "Europe/Berlin" },
    target: { kind: "session", sessionId: "s1" },
    createdBy: { kind: "user" },
    controlledBy: { kind: "user" },
    cardless: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

let seq = 1;
async function boot(view: View): Promise<FakeSocket> {
  seq = 1;
  await act(async () => root.render(<Owner initial={view} />));
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive({
      type: "ready",
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
    } as unknown as ServerMessage);
    socket.receive({
      type: "scheduleList",
      items: [summary()],
      seq,
      revisions: [{ id: "a", revision: 2 }],
    });
  });
  return socket;
}

function sentOf<T extends ClientMessage["type"]>(socket: FakeSocket, type: T) {
  return socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: T }> =>
      message.type === type,
  );
}

const text = () => document.body.textContent ?? "";

async function go(view: View) {
  await act(async () => showView(view));
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name,
  );
  if (!found) throw new Error(`No button ${name}`);
  return found;
}

async function type(id: string, value: string) {
  const element = document.getElementById(id) as
    HTMLTextAreaElement | HTMLInputElement;
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const promptValue = () =>
  (document.getElementById("schedule-prompt") as HTMLTextAreaElement).value;

async function saved(
  socket: FakeSocket,
  requestId: string,
  item: ScheduleSummary,
  revision: number,
) {
  await act(async () => {
    socket.receive({ type: "scheduleSaved", item, revision, requestId });
    socket.receive({ type: "mutationSettled", requestId });
  });
}

async function refuse(socket: FakeSocket, requestId: string, message: string) {
  await act(async () =>
    socket.receive({
      type: "error",
      requestId,
      message,
      ...(message.includes("Schedules settings")
        ? {}
        : { target: { type: "schedule" as const, id: "a" } }),
    }),
  );
}

describe("a save's success keeps newer edits (F102)", () => {
  it("clears only what it sent; a prompt and a timing edited while pending stay and save next", async () => {
    const socket = await boot("detail");
    await type("schedule-prompt", "Check A");
    await click(button("Save"));
    const first = sentOf(socket, "updateSchedule");
    expect(first.map((message) => message.patch)).toEqual([
      { prompt: "Check A" },
    ]);
    await type("schedule-prompt", "Check B");
    await type("schedule-timing-time", "12:00");
    await saved(
      socket,
      first[0]!.requestId,
      summary({ prompt: "Check A", controlledBy: { kind: "user" } }),
      3,
    );
    expect(promptValue()).toBe("Check B");
    expect(
      (document.getElementById("schedule-timing-time") as HTMLInputElement)
        .value,
    ).toBe("12:00");
    await click(button("Save"));
    expect(sentOf(socket, "updateSchedule").at(-1)!.patch).toEqual({
      prompt: "Check B",
      timing: { kind: "daily", time: "12:00" },
    });
  });

  it("keeps the newer edit through a refusal, and Try again sends it", async () => {
    const socket = await boot("detail");
    await type("schedule-prompt", "Check A");
    await click(button("Save"));
    const first = sentOf(socket, "updateSchedule")[0]!;
    await type("schedule-prompt", "Check B");
    await refuse(
      socket,
      first.requestId,
      "Failed to update Schedule: Session not found",
    );
    expect(text()).toContain("Couldn't save: Session not found");
    expect(promptValue()).toBe("Check B");
    expect(getToasts()).toHaveLength(0);
    await click(button("Try again"));
    expect(sentOf(socket, "updateSchedule").at(-1)!.patch).toEqual({
      prompt: "Check B",
    });
  });

  it("Try again keeps Save's guards: no send for an invalid timing or an empty prompt (F111)", async () => {
    const socket = await boot("detail");
    await type("schedule-prompt", "Check A");
    await click(button("Save"));
    await refuse(
      socket,
      sentOf(socket, "updateSchedule")[0]!.requestId,
      "Failed to update Schedule: Session not found",
    );
    expect(text()).toContain("Couldn't save: Session not found");
    const tryAgain = () =>
      [...document.querySelectorAll("button")].find(
        (element) => element.textContent?.trim() === "Try again",
      );
    // An invalid timing: Save is off, and so is Try again.
    await type("schedule-timing-time", "");
    expect(button("Save").disabled).toBe(true);
    expect(tryAgain()).toBeUndefined();
    await type("schedule-timing-time", "11:00");
    // An emptied prompt: the same.
    await type("schedule-prompt", "  ");
    expect(button("Save").disabled).toBe(true);
    expect(tryAgain()).toBeUndefined();
    expect(sentOf(socket, "updateSchedule")).toHaveLength(1);
    // Valid again, Try again repeats the attempt with the current draft.
    await type("schedule-prompt", "Check B");
    expect(text()).toContain("Couldn't save: Session not found");
    await click(tryAgain()!);
    expect(sentOf(socket, "updateSchedule")).toHaveLength(2);
    expect(sentOf(socket, "updateSchedule").at(-1)!.patch).toEqual({
      prompt: "Check B",
    });
    expect(getToasts()).toHaveLength(0);
  });

  it("keeps the newer edit when another write's summary lands meanwhile", async () => {
    const socket = await boot("detail");
    await type("schedule-prompt", "Check A");
    await click(button("Save"));
    const first = sentOf(socket, "updateSchedule")[0]!;
    await type("schedule-prompt", "Check B");
    seq += 1;
    await act(async () =>
      socket.receive({
        type: "stateEvents",
        topic: "schedules",
        seq,
        events: [
          {
            kind: "upsert",
            id: "a",
            revision: 3,
            item: summary({ prompt: "Check C", name: "Renamed" }),
          },
        ],
      }),
    );
    expect(promptValue()).toBe("Check B");
    await saved(socket, first.requestId, summary({ prompt: "Check A" }), 4);
    expect(promptValue()).toBe("Check B");
  });
});

describe("a reopened surface adopts its pending write (F105)", () => {
  it("Pause all: reopened before the refusal, shows it and Try again repeats it", async () => {
    const socket = await boot("page");
    await click(document.getElementById("schedules-pause-all")!);
    await go("away");
    await go("page");
    const sent = sentOf(socket, "setSchedulesPaused");
    await refuse(
      socket,
      sent[0]!.requestId,
      "Failed to save Schedules settings: disk full",
    );
    expect(text()).toContain("Couldn't change Pause all: disk full");
    expect(getToasts()).toHaveLength(0);
    await click(button("Try again"));
    expect(sentOf(socket, "setSchedulesPaused").at(-1)!.paused).toBe(true);

    // Shown once: a later visit does not resurrect it.
    await go("away");
    await go("page");
    expect(text()).not.toContain("Couldn't change Pause all");
  });

  it("Pause all: staying away announces the refusal", async () => {
    const socket = await boot("page");
    await click(document.getElementById("schedules-pause-all")!);
    await go("away");
    await refuse(
      socket,
      sentOf(socket, "setSchedulesPaused")[0]!.requestId,
      "Failed to save Schedules settings: disk full",
    );
    expect(getToasts().map((toast) => toast.message)).toEqual([
      expect.stringContaining("disk full"),
    ]);
  });

  it("a row's switch: reopened before the refusal, shows it and Try again repeats it", async () => {
    const socket = await boot("page");
    const row = document.querySelector(
      '[data-list-row-id="a"] [role="switch"]',
    )!;
    await click(row);
    await go("away");
    await go("page");
    await refuse(
      socket,
      sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      "Failed to switch Schedule: database is locked",
    );
    expect(text()).toContain("Couldn't save: database is locked");
    expect(getToasts()).toHaveLength(0);
    await click(button("Try again"));
    expect(sentOf(socket, "setScheduleEnabled").at(-1)!.enabled).toBe(false);
  });

  it("the detail's Save: reopened before the refusal, puts the sent edit back under it", async () => {
    const socket = await boot("detail");
    await type("schedule-prompt", "Check A");
    await click(button("Save"));
    await go("away");
    await go("detail");
    await refuse(
      socket,
      sentOf(socket, "updateSchedule")[0]!.requestId,
      "Failed to update Schedule: Session not found",
    );
    expect(text()).toContain("Couldn't save: Session not found");
    expect(promptValue()).toBe("Check A");
    expect(getToasts()).toHaveLength(0);
    // Once recovery restores the server's prompt, the edit differs again and
    // Try again repeats it (until then nothing differs, so it is not offered).
    const [recovery] = sentOf(socket, "getStateItems");
    await act(async () =>
      socket.receive({
        type: "stateItems",
        topic: "schedules",
        requestId: recovery!.requestId,
        events: [{ kind: "upsert", id: "a", revision: 3, item: summary() }],
      }),
    );
    expect(promptValue()).toBe("Check A");
    await click(button("Try again"));
    expect(sentOf(socket, "updateSchedule")).toHaveLength(2);
    expect(sentOf(socket, "updateSchedule").at(-1)!.patch).toEqual({
      prompt: "Check A",
    });
  });

  it("the delete dialog does not survive leaving: its refusal is announced", async () => {
    const socket = await boot("page");
    await click(button("Delete Schedule"));
    await click(button("Delete"));
    await go("away");
    await go("page");
    await refuse(
      socket,
      sentOf(socket, "deleteSchedule")[0]!.requestId,
      "Failed to delete Schedule: database is locked",
    );
    expect(getToasts().map((toast) => toast.message)).toEqual([
      expect.stringContaining("database is locked"),
    ]);
    // The optimistic removal recovers authoritatively, not by inverse.
    expect(latestState.scheduleMutations["a:delete"]).toBeDefined();
    expect(sentOf(socket, "getStateItems").at(-1)).toMatchObject({
      topic: "schedules",
      ids: ["a"],
    });
  });
});
