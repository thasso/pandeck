// @vitest-environment jsdom
/**
 * The session inspector's Schedules beside the page or detail, through the
 * real `useAssistant` reducer, effects and socket, with each surface's claims
 * composed per surface by the same helpers `App.tsx` uses
 * (`docs/schedules.md`, Web; AC11):
 * - a surface leaving clears only its own claims, so the inspector keeps a
 *   refusal it renders in place and never sees it announced;
 * - the inspector reopened before a delayed refusal adopts it, with Try
 *   again repeating the attempt; closed with nothing else open, it is
 *   announced;
 * - the inspector claims only its switches, never the detail's Save.
 *   cd app/web && pnpm exec vitest run src/sessionScheduleOwnerScenario.test.tsx
 */
import { act, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { FakeSocket } from "./test/fakeSocket.ts";
import { useAssistant } from "./hooks/useAssistant.ts";
import { dismissToast, getToasts } from "./lib/toast.ts";
import { resetFailureHomes, setFailureHomes } from "./lib/messageArrival.ts";
import {
  NO_SCHEDULE_CLAIMS,
  scheduleClaimedKeys,
  schedulesForSession,
  withScheduleClaim,
  type ScheduleClaimSurface,
} from "./lib/schedules.ts";
import { SchedulesPage } from "./components/schedules/SchedulesPage.tsx";
import { ScheduleDetailPage } from "./components/schedules/ScheduleDetailPage.tsx";
import { SessionSchedulesSection } from "./components/schedules/SessionSchedulesSection.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Main = "page" | "detail" | "away";
let setMain: (main: Main) => void = () => {};
let setInspector: (open: boolean) => void = () => {};
const opened: string[] = [];
const ARCHIVED = { sessions: [], loaded: true, pending: false, error: null };

function Owner({ main: initialMain }: { main: Main }) {
  const { actions, state } = useAssistant();
  const [main, setMainState] = useState<Main>(initialMain);
  const [inspector, setInspectorState] = useState(true);
  setMain = setMainState;
  setInspector = setInspectorState;
  const [claims, setClaims] = useState(NO_SCHEDULE_CLAIMS);
  const claimFor = useCallback(
    (surface: ScheduleClaimSurface) => (keys: readonly string[]) =>
      setClaims((current) => withScheduleClaim(current, surface, keys)),
    [],
  );
  const claimPage = useMemo(() => claimFor("page"), [claimFor]);
  const claimDetail = useMemo(() => claimFor("detail"), [claimFor]);
  const claimInspector = useMemo(() => claimFor("inspector"), [claimFor]);
  const open = useCallback((path: string) => opened.push(path), []);
  useEffect(() => actions.setTopics(["sessions", "schedules"]), [actions]);
  useEffect(() => {
    setFailureHomes({
      viewedSessionId: null,
      stagedSend: null,
      openObjects: {
        project: [],
        task: [],
        schedule: main === "detail" ? ["a"] : [],
      },
      controls: scheduleClaimedKeys(claims),
    });
  }, [claims, main]);
  const answered = state.stateEventRevisions.schedules !== undefined;
  const sessionSchedules = useMemo(
    () => schedulesForSession(state.schedules, "s1"),
    [state.schedules],
  );
  return (
    <>
      {inspector && sessionSchedules.length > 0 ? (
        <aside data-testid="inspector">
          <SessionSchedulesSection
            sessionId="s1"
            schedules={sessionSchedules}
            mutations={state.scheduleMutations}
            attempts={state.scheduleAttempts}
            onSetEnabled={actions.setScheduleEnabled}
            onOpen={open}
            onClaimControls={claimInspector}
          />
        </aside>
      ) : null}
      <main data-testid="main">
        {main === "page" ? (
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
            onClaimControls={claimPage}
          />
        ) : main === "detail" ? (
          <ScheduleDetailPage
            id="a"
            schedule={state.schedules.find((item) => item.id === "a")}
            answered={answered}
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
            onClaimControls={claimDetail}
          />
        ) : null}
      </main>
    </>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  FakeSocket.instances = [];
  opened.length = 0;
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

async function boot(main: Main): Promise<FakeSocket> {
  await act(async () => root.render(<Owner main={main} />));
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
    const items = [
      summary(),
      summary({
        id: "b",
        name: "Other session",
        target: { kind: "session", sessionId: "s2" },
      }),
    ];
    socket.receive({
      type: "scheduleList",
      items,
      seq: 1,
      revisions: items.map((item) => ({ id: item.id, revision: 2 })),
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

const inspector = () => document.querySelector('[data-testid="inspector"]');
const main = () => document.querySelector('[data-testid="main"]')!;

async function go(next: Main) {
  await act(async () => setMain(next));
}

async function showInspector(open: boolean) {
  await act(async () => setInspector(open));
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function inspectorSwitch(): Element {
  return inspector()!.querySelector('[role="switch"]')!;
}

async function refuse(socket: FakeSocket, requestId: string, message: string) {
  await act(async () =>
    socket.receive({
      type: "error",
      requestId,
      message,
      target: { type: "schedule", id: "a" },
    }),
  );
}

const REFUSAL = "Failed to switch Schedule: database is locked";
const SHOWN = "Couldn't save: database is locked";

describe("the inspector's Schedules (AC11)", () => {
  it("lists only this session's Schedules, the switch named by the Schedule, the name linked to its detail", async () => {
    const socket = await boot("away");
    const section = inspector()!;
    expect(section.textContent).toContain("Morning check");
    expect(section.textContent).not.toContain("Other session");
    const toggle = inspectorSwitch();
    const label = document.getElementById(
      toggle.getAttribute("aria-labelledby")!,
    );
    expect(label?.textContent).toBe("Morning check");
    expect(label?.getAttribute("href")).toBe("/schedules/a");
    await click(label!);
    expect(opened).toEqual(["/schedules/a"]);
    await click(toggle);
    expect(sentOf(socket, "setScheduleEnabled")).toMatchObject([
      { id: "a", enabled: false },
    ]);
  });
});

describe("claims compose per surface", () => {
  it("the page leaving keeps the inspector's claim: its refusal stays in place, unannounced", async () => {
    const socket = await boot("page");
    await click(inspectorSwitch());
    await go("away");
    await refuse(
      socket,
      sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      REFUSAL,
    );
    expect(inspector()!.textContent).toContain(SHOWN);
    expect(getToasts()).toHaveLength(0);
  });

  it("a page write the inspector sees pending is shown on both, unannounced", async () => {
    const socket = await boot("page");
    await click(
      main().querySelector('[data-list-row-id="a"] [role="switch"]')!,
    );
    await refuse(
      socket,
      sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      REFUSAL,
    );
    expect(inspector()!.textContent).toContain(SHOWN);
    expect(main().textContent).toContain(SHOWN);
    expect(getToasts()).toHaveLength(0);
  });

  it("the inspector never claims the detail's Save: the detail gone, that refusal is announced", async () => {
    const socket = await boot("detail");
    const prompt = document.getElementById(
      "schedule-prompt",
    ) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(prompt, "Check A");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save",
    )!;
    await click(save);
    await go("away");
    await refuse(
      socket,
      sentOf(socket, "updateSchedule")[0]!.requestId,
      "Failed to update Schedule: Session not found",
    );
    expect(getToasts().map((toast) => toast.message)).toEqual([
      expect.stringContaining("Session not found"),
    ]);
    expect(inspector()!.textContent).not.toContain("Couldn't save");
  });
});

describe("the inspector reopened before a delayed refusal", () => {
  it("adopts it, and Try again repeats what was sent", async () => {
    const socket = await boot("away");
    await click(inspectorSwitch());
    await showInspector(false);
    await showInspector(true);
    await refuse(
      socket,
      sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      REFUSAL,
    );
    expect(inspector()!.textContent).toContain(SHOWN);
    expect(getToasts()).toHaveLength(0);
    const retry = [...inspector()!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    )!;
    await click(retry);
    expect(sentOf(socket, "setScheduleEnabled").at(-1)).toMatchObject({
      id: "a",
      enabled: false,
    });
  });

  it("closed with nothing else open, the refusal is announced", async () => {
    const socket = await boot("away");
    await click(inspectorSwitch());
    await showInspector(false);
    await refuse(
      socket,
      sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      REFUSAL,
    );
    expect(getToasts().map((toast) => toast.message)).toEqual([
      expect.stringContaining("database is locked"),
    ]);
  });
});
