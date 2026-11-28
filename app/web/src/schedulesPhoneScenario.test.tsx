// @vitest-environment jsdom
/**
 * The Schedules index on the whole app at phone and wide widths
 * (`docs/schedules.md`, Web; F103): a phone's `/schedules` browser screen is
 * the full page, so the Done filter, Pause all and each Schedule's named
 * switch and delete are reachable and not inert; the wide sidebar keeps the
 * minimal browser beside the page; a detail is an ordinary phone screen.
 * F113: a phone detail covered by the expanded object sheet claims nothing,
 * so a Save refusal or no-answer outcome is announced and not shown again;
 * uncovered while pending it adopts the outcome; its delete dialog keeps its
 * own refusal.
 *   cd app/web && pnpm exec vitest run src/schedulesPhoneScenario.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { FakeSocket } from "./test/fakeSocket.ts";
import { dismissToast, getToasts } from "./lib/toast.ts";
import { sessionListMessage } from "./test/sessionTopic.ts";

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

function schedule(
  id: string,
  name: string,
  overrides: Partial<ScheduleSummary> = {},
): ScheduleSummary {
  return {
    id,
    name,
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

const SCHEDULES = [
  schedule("a", "Morning check"),
  schedule("b", "Old report", { doneAtMs: 5, enabled: false }),
];

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

async function boot(path: string, phone: boolean): Promise<FakeSocket> {
  stubLayout(phone);
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
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
    socket.receive(sessionListMessage([]));
  });
  await settle(1);
  await act(async () => {
    socket.receive({
      type: "scheduleList",
      items: SCHEDULES,
      seq: 1,
      revisions: SCHEDULES.map((item) => ({ id: item.id, revision: 1 })),
    });
  });
  await settle();
  return socket;
}

/** Settle until a lazy page renders `selector`, or give up after ~2s. */
async function until(selector: string): Promise<void> {
  for (let i = 0; i < 80 && !document.querySelector(selector); i++)
    await settle(1);
}

/** Elements matching `selector` that a user can reach: not inside `inert`. */
function reachable(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.closest("[inert]") === null,
  );
}

/** The accessible name an `aria-labelledby` list composes. */
function labelledName(element: Element): string {
  return (element.getAttribute("aria-labelledby") ?? "")
    .split(" ")
    .map((id) => {
      const target = document.getElementById(id);
      return (
        target?.getAttribute("aria-label") ?? target?.textContent?.trim() ?? ""
      );
    })
    .join(" ");
}

function buttonNamed(name: string): HTMLElement | undefined {
  return reachable("button").find(
    (button) =>
      button.textContent?.trim() === name ||
      button.getAttribute("aria-label") === name,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
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

describe("the Schedules index on a phone (F103)", () => {
  it("is the full page: Pause all, Done, and each Schedule's named controls are reachable", async () => {
    const socket = await boot("/schedules", true);
    await until("#schedules-pause-all");
    // One page, on the browser screen, and none behind it.
    expect(document.querySelectorAll("#schedules-pause-all")).toHaveLength(1);
    expect(reachable("#schedules-pause-all")).toHaveLength(1);
    const switches = reachable('[role="switch"][aria-labelledby]').filter(
      (element) => labelledName(element) !== "Pause all",
    );
    expect(switches.map(labelledName)).toEqual(["Morning check On"]);
    const remove = reachable("button[aria-labelledby]").map(labelledName);
    expect(remove).toEqual(["Delete Schedule Morning check"]);

    // A row's switch writes from the phone.
    await act(async () => {
      switches[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      socket.sent.filter((message) => message.type === "setScheduleEnabled"),
    ).toHaveLength(1);

    // Done Schedules are found from the index.
    expect(document.body.textContent).not.toContain("Old report");
    await act(async () => {
      buttonNamed("Done")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(
      reachable("a").some((link) => link.textContent === "Old report"),
    ).toBe(true);
  });

  it("opens a detail as an ordinary phone screen", async () => {
    await boot("/schedules/a", true);
    await until("#schedule-prompt");
    expect(reachable("#schedule-prompt")).toHaveLength(1);
    expect(reachable("#schedules-pause-all")).toHaveLength(0);
  });
});

describe("the Schedules index on a wide layout", () => {
  it("keeps the minimal browser in the sidebar beside the one page", async () => {
    await boot("/schedules", false);
    await until("#schedules-pause-all");
    const aside = document.querySelector("aside")!;
    expect(aside.querySelector("#schedules-pause-all")).toBeNull();
    expect(aside.textContent).toContain("Morning check");
    expect(aside.textContent).not.toContain("Old report");
    expect(document.querySelectorAll("#schedules-pause-all")).toHaveLength(1);
    expect(reachable("#schedules-pause-all")).toHaveLength(1);
  });
});

async function click(element: Element | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle(2);
}

/** Edit the detail's prompt and press Save; the update's request id. */
async function editPromptAndSave(socket: FakeSocket): Promise<string> {
  const area = document.querySelector<HTMLTextAreaElement>("#schedule-prompt")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(area, "Check the build and report");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle(1);
  await click(buttonNamed("Save"));
  const sent = socket.sent.filter((m) => m.type === "updateSchedule");
  expect(sent).toHaveLength(1);
  return (sent[0] as { requestId: string }).requestId;
}

async function refuse(
  socket: FakeSocket,
  requestId: string,
  message = "Failed to update Schedule: Session not found: s9",
): Promise<void> {
  await act(async () => {
    socket.receive({
      type: "error",
      message,
      target: { type: "schedule", id: "a" },
      requestId,
    } as ServerMessage);
  });
  await settle(2);
}

const toastMessages = () => getToasts().map((toast) => toast.message);
const shownAnywhere = (text: string) =>
  document.body.textContent?.includes(text) ?? false;
const coveredPrompt = () =>
  document.querySelector("#schedule-prompt")?.closest("[inert]") ?? null;

describe("a phone detail covered by the object sheet (F113)", () => {
  it("claims nothing while covered: a Save refusal is announced, and not shown again", async () => {
    const socket = await boot("/schedules/a", true);
    await until("#schedule-prompt");
    const requestId = await editPromptAndSave(socket);
    await click(buttonNamed("Open details"));
    expect(coveredPrompt()).not.toBeNull();
    await refuse(socket, requestId);
    expect(toastMessages()).toEqual([
      expect.stringContaining("Session not found: s9"),
    ]);
    // Leaving from the sheet, and coming back, repeats nothing.
    await click(buttonNamed("Back to Schedules"));
    expect(window.location.pathname).toBe("/schedules");
    await click(reachable("a").find((a) => a.textContent === "Morning check"));
    await until("#schedule-prompt");
    expect(shownAnywhere("Couldn't save")).toBe(false);
    expect(getToasts()).toHaveLength(1);
  });

  it("claims nothing while covered: a Save with no answer is announced", async () => {
    const socket = await boot("/schedules/a", true);
    await until("#schedule-prompt");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await editPromptAndSave(socket);
    await click(buttonNamed("Open details"));
    expect(coveredPrompt()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await settle(2);
    expect(getToasts()).toHaveLength(1);
  });

  it("revealed while its Save is pending, adopts it: shown in place, unannounced", async () => {
    const socket = await boot("/schedules/a", true);
    await until("#schedule-prompt");
    const requestId = await editPromptAndSave(socket);
    await click(buttonNamed("Open details"));
    expect(coveredPrompt()).not.toBeNull();
    await click(buttonNamed("Collapse details"));
    expect(coveredPrompt()).toBeNull();
    await refuse(socket, requestId);
    expect(
      reachable("[role='alert'], [data-slot='alert']").some((element) =>
        element.textContent?.includes("Couldn't save: Session not found: s9"),
      ),
    ).toBe(true);
    expect(getToasts()).toHaveLength(0);
  });

  it("uncovered, a Save refusal stays in place, unannounced", async () => {
    const socket = await boot("/schedules/a", true);
    await until("#schedule-prompt");
    const requestId = await editPromptAndSave(socket);
    await refuse(socket, requestId);
    expect(coveredPrompt()).toBeNull();
    expect(shownAnywhere("Couldn't save: Session not found: s9")).toBe(true);
    expect(getToasts()).toHaveLength(0);
  });

  it("the delete dialog over the detail keeps its own refusal, unannounced", async () => {
    const socket = await boot("/schedules/a", true);
    await until("#schedule-prompt");
    await click(buttonNamed("Delete Schedule"));
    await click(buttonNamed("Delete"));
    const sent = socket.sent.filter((m) => m.type === "deleteSchedule");
    expect(sent).toHaveLength(1);
    await refuse(
      socket,
      (sent[0] as { requestId: string }).requestId,
      "Failed to delete Schedule: database is locked",
    );
    expect(shownAnywhere("Couldn't delete: database is locked")).toBe(true);
    expect(getToasts()).toHaveLength(0);
  });
});
