// @vitest-environment jsdom
/**
 * Failure homes that must be ON SCREEN, through the real owners: `useAssistant`
 * with its socket, `AppShell` keeping the right panel mounted while shut (as
 * `App` does), `RightPanelTabs` keeping the Inspector behind another tab, the
 * section's own collapse, and the detail page (`docs/messaging.md`; F108,
 * F109):
 * - a session inspector that is shut, behind another tab, folded, or a
 *   phone's dock not expanded claims nothing, so its refusal is announced,
 *   and revealing it does not show that refusal again;
 * - hidden, it never adopts a page's pending write, so the page leaving
 *   announces it; reopened while a write is pending, it still adopts it;
 * - a detail route whose Schedules list failed shows the failure with Retry
 *   in place, unannounced, over the summary it still holds.
 *   cd app/web && pnpm exec vitest run src/scheduleVisibilityScenario.test.tsx
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
import { AppShell } from "./components/shell/AppShell.tsx";
import { RightPanelTabs } from "./components/shell/RightPanelTabs.tsx";
import type { PanelId } from "./components/shell/RightPanelTabs.tsx";

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
let setPanelOpen: (open: boolean) => void = () => {};
let requestPanel: (panel: PanelId) => void = () => {};
const ARCHIVED = { sessions: [], loaded: true, pending: false, error: null };

function Owner({ main: initialMain, mobile }: { main: Main; mobile: boolean }) {
  const { actions, state } = useAssistant();
  const [main, setMainState] = useState<Main>(initialMain);
  const [open, setOpen] = useState(true);
  const [request, setRequest] = useState<
    { panel: PanelId; nonce: number } | undefined
  >();
  setMain = setMainState;
  setPanelOpen = setOpen;
  requestPanel = (panel) =>
    setRequest((current) => ({ panel, nonce: (current?.nonce ?? 0) + 1 }));
  const [claims, setClaims] = useState(NO_SCHEDULE_CLAIMS);
  const claimFor = useCallback(
    (surface: ScheduleClaimSurface) => (keys: readonly string[]) =>
      setClaims((current) => withScheduleClaim(current, surface, keys)),
    [],
  );
  const claimPage = useMemo(() => claimFor("page"), [claimFor]);
  const claimDetail = useMemo(() => claimFor("detail"), [claimFor]);
  const claimInspector = useMemo(() => claimFor("inspector"), [claimFor]);
  const noop = useCallback(() => {}, []);
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
  const inspector =
    sessionSchedules.length > 0 ? (
      <aside data-testid="inspector">
        <SessionSchedulesSection
          sessionId="s1"
          schedules={sessionSchedules}
          mutations={state.scheduleMutations}
          attempts={state.scheduleAttempts}
          onSetEnabled={actions.setScheduleEnabled}
          onOpen={noop}
          onClaimControls={claimInspector}
        />
      </aside>
    ) : null;
  return (
    <AppShell
      mobile={mobile}
      right={{
        open,
        width: 320,
        minWidth: 240,
        onResize: noop,
        label: "inspector",
        // As `App`: the panel stays mounted while shut, a phone's is a dock.
        keepMountedWhenClosed: true,
        mobilePresentation: "dock",
        onExpand: () => setOpen(true),
        onDismiss: () => setOpen(false),
        content: mobile ? (
          inspector
        ) : (
          <RightPanelTabs
            visible={open}
            chatHost={{} as never}
            worktree={<div data-testid="worktree-panel" />}
            status={null}
            inspector={inspector}
            openRequest={request}
          />
        ),
      }}
    >
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
            onOpen={noop}
            onClaimControls={claimPage}
          />
        ) : main === "detail" ? (
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
            onRequestArchived={noop}
            onSave={actions.updateSchedule}
            onDelete={actions.deleteSchedule}
            onOpenHistory={actions.openScheduleHistory}
            onCloseHistory={actions.closeScheduleHistory}
            onRetryHistory={actions.retryScheduleHistory}
            onOpen={noop}
            onClaimControls={claimDetail}
          />
        ) : null}
      </main>
    </AppShell>
  );
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  FakeSocket.instances = [];
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("ResizeObserver", NoopObserver);
  window.localStorage.clear();
  window.sessionStorage.clear();
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

async function boot(
  main: Main,
  { answered = true, mobile = false } = {},
): Promise<FakeSocket> {
  await act(async () => root.render(<Owner main={main} mobile={mobile} />));
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
    if (answered) {
      const items = [summary()];
      socket.receive({
        type: "scheduleList",
        items,
        seq: 1,
        revisions: items.map((item) => ({ id: item.id, revision: 2 })),
      });
    }
  });
  return socket;
}

function sentOf<T extends ClientMessage["type"]>(socket: FakeSocket, type: T) {
  return socket.sent.filter(
    (message): message is Extract<ClientMessage, { type: T }> =>
      message.type === type,
  );
}

const inspector = () =>
  document.querySelector<HTMLElement>('[data-testid="inspector"]');
const main = () => document.querySelector('[data-testid="main"]')!;

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flipInInspector() {
  await click(inspector()!.querySelector('[role="switch"]')!);
}

async function refuseSwitch(socket: FakeSocket) {
  await act(async () =>
    socket.receive({
      type: "error",
      requestId: sentOf(socket, "setScheduleEnabled")[0]!.requestId,
      message: REFUSAL,
      target: { type: "schedule", id: "a" },
    }),
  );
}

const REFUSAL = "Failed to switch Schedule: database is locked";
const SHOWN = "Couldn't save: database is locked";
const toastMessages = () => getToasts().map((toast) => toast.message);

describe("a hidden session inspector claims nothing (F108)", () => {
  it("shut while its write is pending: the refusal is announced, and not shown again on reopening", async () => {
    const socket = await boot("away");
    await flipInInspector();
    await act(async () => setPanelOpen(false));
    // Still mounted, as App keeps it: the gate is visibility, not mounting.
    expect(inspector()).not.toBeNull();
    await refuseSwitch(socket);
    expect(toastMessages()).toEqual([
      expect.stringContaining("database is locked"),
    ]);
    await act(async () => setPanelOpen(true));
    expect(inspector()!.textContent).not.toContain(SHOWN);
  });

  it("behind another right-panel tab: the refusal is announced", async () => {
    const socket = await boot("away");
    await flipInInspector();
    await act(async () => requestPanel("worktree"));
    expect(
      document.querySelector('[data-testid="worktree-panel"]'),
    ).not.toBeNull();
    expect(inspector()).not.toBeNull();
    await refuseSwitch(socket);
    expect(toastMessages()).toEqual([
      expect.stringContaining("database is locked"),
    ]);
  });

  it("its Schedules section folded: the refusal is announced", async () => {
    const socket = await boot("away");
    await flipInInspector();
    const heading = [...inspector()!.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Schedules",
    )!;
    await click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    await refuseSwitch(socket);
    expect(toastMessages()).toEqual([
      expect.stringContaining("database is locked"),
    ]);
  });

  it("on a phone with the dock not expanded: the refusal is announced", async () => {
    const socket = await boot("away", { mobile: true });
    await flipInInspector();
    await act(async () => setPanelOpen(false));
    await refuseSwitch(socket);
    expect(toastMessages()).toEqual([
      expect.stringContaining("database is locked"),
    ]);
  });

  it("hidden, it never adopts the page's pending write: the page leaving announces it", async () => {
    const socket = await boot("page");
    await act(async () => setPanelOpen(false));
    await click(
      main().querySelector('[data-list-row-id="a"] [role="switch"]')!,
    );
    await act(async () => setMain("away"));
    await refuseSwitch(socket);
    expect(toastMessages()).toEqual([
      expect.stringContaining("database is locked"),
    ]);
  });

  it("reopened while the write is pending, it adopts it: shown in place, unannounced", async () => {
    const socket = await boot("away");
    await flipInInspector();
    await act(async () => setPanelOpen(false));
    await act(async () => setPanelOpen(true));
    await refuseSwitch(socket);
    expect(inspector()!.textContent).toContain(SHOWN);
    expect(getToasts()).toHaveLength(0);
  });

  it("visible beside the page, both show the page's refusal, unannounced", async () => {
    const socket = await boot("page");
    await click(
      main().querySelector('[data-list-row-id="a"] [role="switch"]')!,
    );
    await refuseSwitch(socket);
    expect(inspector()!.textContent).toContain(SHOWN);
    expect(main().textContent).toContain(SHOWN);
    expect(getToasts()).toHaveLength(0);
  });
});

const LIST_FAILED = "Failed to list Schedules: database is locked";

async function failList(socket: FakeSocket) {
  await act(async () =>
    socket.receive({
      type: "error",
      message: LIST_FAILED,
      target: { type: "schedule" },
    }),
  );
}

function retryButton(): HTMLButtonElement | undefined {
  return [...main().querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Retry",
  );
}

describe("a detail whose Schedules list failed (F109)", () => {
  it("unanswered: the failure with Retry in place of Loading, unannounced; Retry asks again", async () => {
    const socket = await boot("detail", { answered: false });
    await failList(socket);
    expect(main().textContent).toContain(LIST_FAILED);
    expect(main().textContent).not.toContain("Schedule not found");
    expect(
      main().querySelector('[role="status"]')?.textContent ?? "",
    ).not.toMatch(/Loading/);
    expect(getToasts()).toHaveLength(0);
    const sentBefore = socket.sent.length;
    await click(retryButton()!);
    expect(socket.sent.length).toBeGreaterThan(sentBefore);
  });

  it("unanswered on a phone, with no browser anywhere: the same in-place failure", async () => {
    const socket = await boot("detail", { answered: false, mobile: true });
    await failList(socket);
    expect(main().textContent).toContain(LIST_FAILED);
    expect(retryButton()).toBeDefined();
    expect(getToasts()).toHaveLength(0);
  });

  it("a failed refresh keeps the held summary and says so above it", async () => {
    const socket = await boot("detail");
    await failList(socket);
    expect(main().textContent).toContain(LIST_FAILED);
    expect(retryButton()).toBeDefined();
    expect(
      (document.getElementById("schedule-prompt") as HTMLTextAreaElement).value,
    ).toBe("Check the build");
    expect(getToasts()).toHaveLength(0);
  });

  it("still loading without a failure, and not found once answered without it", async () => {
    await boot("detail", { answered: false });
    expect(main().querySelector('[role="status"]')?.textContent).toContain(
      "Loading",
    );
    expect(main().textContent).not.toContain("Schedule not found");
    expect(retryButton()).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(container);
    FakeSocket.instances = [];
    const socket = await boot("detail", { answered: false });
    await act(async () =>
      socket.receive({
        type: "scheduleList",
        items: [],
        seq: 1,
        revisions: [],
      }),
    );
    expect(main().textContent).toContain("Schedule not found");
    expect(retryButton()).toBeUndefined();
  });
});
