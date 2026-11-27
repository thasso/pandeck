// @vitest-environment jsdom
/**
 * The Schedules row's named controls and Last session, and the detail's
 * invalid-timing reason, as rendered (`docs/schedules.md`, Web):
 * - F106: the Last cell names and links the session the last occurrence went
 *   to, whatever the Schedule targets now; a deleted one says so; none, none.
 * - F104: every invalid changed timing shows the shared validator's reason,
 *   described on the timing fieldset; an unchanged expired timing still lets
 *   a prompt-only edit save.
 * - Accessibility: each row's switch and delete name their Schedule; the
 *   Active/Done filter is named.
 *   cd app/web && pnpm exec vitest run src/components/schedules/scheduleRowsTiming.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import {
  scheduleTimingError,
  scheduleTimingFutureError,
  type ScheduleSummary,
  type ScheduleTiming,
} from "@assistant/shared/schedules";
import { ready } from "../../lib/loadState.ts";
import { sessionPath } from "../../lib/sessionRoutes.ts";
import { SchedulesPage } from "./SchedulesPage.tsx";
import { ScheduleDetailPage } from "./ScheduleDetailPage.tsx";

const titles = new Map<string, Partial<PaObjectLinkResolution>>();
vi.mock("./useScheduleSessionTitles.ts", () => ({
  useScheduleSessionTitles: () => (id: string) =>
    titles.get(id) as PaObjectLinkResolution | undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopObserver);
  titles.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const WEEKLY: ScheduleTiming = {
  kind: "weekly",
  days: ["mon"],
  time: "11:00",
  timeZone: "Europe/Berlin",
};

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "a",
    name: "Morning check",
    prompt: "Check the build",
    enabled: true,
    timing: WEEKLY,
    target: { kind: "session", sessionId: "s2" },
    createdBy: { kind: "user" },
    controlledBy: { kind: "user" },
    cardless: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function title(id: string, text: string, missing = false) {
  titles.set(id, {
    objectType: "session",
    id,
    title: text,
    existence: missing ? "missing" : "exists",
  } as Partial<PaObjectLinkResolution>);
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No button named ${name}`);
  return found;
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

function renderPage(schedules: ScheduleSummary[], onOpen = vi.fn()) {
  act(() =>
    root.render(
      <SchedulesPage
        schedules={schedules}
        answered
        listError={null}
        onRetry={vi.fn()}
        paused={false}
        mutations={{}}
        attempts={{}}
        onSetPaused={vi.fn()}
        onSetEnabled={vi.fn()}
        onDelete={vi.fn()}
        onOpen={onOpen}
        onClaimControls={vi.fn()}
      />,
    ),
  );
  return onOpen;
}

/** The row's Last cell: the column after Next. */
function lastCell(id: string): HTMLElement {
  const row = document.querySelector(`[data-list-row-id="${id}"]`)!;
  const grid = row.querySelector(".text-sm")!;
  return grid.children[4] as HTMLElement;
}

describe("the Last cell's session (F106)", () => {
  it("names and links the last occurrence's session, not the current target", () => {
    title("s1", "Alpha session");
    title("s2", "Beta session");
    const onOpen = renderPage([
      summary({
        lastOccurrence: {
          id: "o1",
          scheduleId: "a",
          state: "delivered",
          dueAtMs: Date.UTC(2026, 9, 12, 9),
          sessionId: "s1",
        },
      }),
    ]);
    const cell = lastCell("a");
    expect(cell.textContent).toContain("delivered");
    const link = cell.querySelector("a")!;
    expect(link.textContent).toBe("Alpha session");
    expect(link.getAttribute("href")).toBe(sessionPath("s1"));
    expect(cell.textContent).not.toContain("Beta session");
    click(link);
    expect(onOpen).toHaveBeenCalledWith(sessionPath("s1"));
  });

  it("says Deleted session, unlinked, for a deleted one", () => {
    title("s3", "Gone", true);
    renderPage([
      summary({
        lastOccurrence: {
          id: "o1",
          scheduleId: "a",
          state: "failed",
          dueAtMs: Date.UTC(2026, 9, 12, 9),
          sessionId: "s3",
        },
      }),
    ]);
    const cell = lastCell("a");
    expect(cell.textContent).toContain("Deleted session");
    expect(cell.querySelector("a")).toBeNull();
  });

  it("shows no session for an occurrence that reached none", () => {
    title("s2", "Beta session");
    renderPage([
      summary({
        lastOccurrence: {
          id: "o1",
          scheduleId: "a",
          state: "missed",
          dueAtMs: Date.UTC(2026, 9, 12, 9),
        },
      }),
    ]);
    const cell = lastCell("a");
    expect(cell.textContent).toContain("missed");
    expect(cell.querySelector("a")).toBeNull();
    expect(cell.textContent).not.toContain("Beta session");
  });
});

describe("the row's named controls", () => {
  it("names each switch and delete by its Schedule, and the filter", () => {
    renderPage([
      summary(),
      summary({ id: "b", name: "Evening check", enabled: false }),
    ]);
    const switches = [
      ...document.querySelectorAll('[role="switch"][aria-labelledby]'),
    ].map(labelledName);
    expect(switches).toEqual([
      "Pause all",
      "Morning check On",
      "Evening check On",
    ]);
    const deletes = [
      ...document.querySelectorAll("button[aria-labelledby]"),
    ].map(labelledName);
    expect(deletes).toEqual([
      "Delete Schedule Morning check",
      "Delete Schedule Evening check",
    ]);
    const filter = buttonNamed("Active").closest('[role="group"]');
    expect(filter?.getAttribute("aria-label")).toBe("Schedules");
  });
});

function renderDetail(schedule: ScheduleSummary, onSave = vi.fn()) {
  act(() =>
    root.render(
      <ScheduleDetailPage
        id="a"
        schedule={schedule}
        answered
        listError={null}
        onRetry={vi.fn()}
        history={{ load: ready([]), revision: 2 }}
        mutations={{}}
        attempts={{}}
        failure={undefined}
        liveSessions={[]}
        archived={{ sessions: [], loaded: true, pending: false, error: null }}
        onRequestArchived={vi.fn()}
        onSave={onSave}
        onDelete={vi.fn()}
        onOpenHistory={vi.fn()}
        onCloseHistory={vi.fn()}
        onRetryHistory={vi.fn()}
        onOpen={vi.fn()}
        onClaimControls={vi.fn()}
      />,
    ),
  );
  return onSave;
}

function setValue(id: string, value: string) {
  const element = document.getElementById(id) as
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const proto = Object.getPrototypeOf(element) as object;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function timingFieldset(): HTMLFieldSetElement {
  return document.getElementById("schedule-timing-kind")!.closest("fieldset")!;
}

/** The reason shown, described on the fieldset; Save refuses. */
function expectReason(reason: string | null) {
  expect(reason).not.toBeNull();
  const shown = document.getElementById("schedule-timing-error");
  expect(shown?.textContent).toBe(reason);
  const fieldset = timingFieldset();
  expect(fieldset.getAttribute("aria-describedby")).toBe(
    "schedule-timing-error",
  );
  expect(fieldset.getAttribute("aria-invalid")).toBe("true");
  expect(buttonNamed("Save").disabled).toBe(true);
}

describe("an invalid changed timing says why (F104)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 15, 0, 0));
  });

  it("weekly with no days", () => {
    renderDetail(summary());
    click(buttonNamed("Mon"));
    expectReason(scheduleTimingError({ ...WEEKLY, days: [] }));
  });

  it("a cleared time", () => {
    renderDetail(summary());
    setValue("schedule-timing-time", "");
    expectReason(scheduleTimingError({ ...WEEKLY, time: "" }));
  });

  it("a monthly day out of range", () => {
    renderDetail(summary());
    setValue("schedule-timing-kind", "monthly");
    setValue("schedule-timing-day", "32");
    expectReason(
      scheduleTimingError({
        kind: "monthly",
        day: 32,
        time: "11:00",
        timeZone: "Europe/Berlin",
      }),
    );
  });

  it("a reversed date window", () => {
    renderDetail(summary());
    setValue("schedule-timing-starts", "2026-12-31");
    setValue("schedule-timing-ends", "2026-12-01");
    expectReason(
      scheduleTimingError({
        ...WEEKLY,
        startsOn: "2026-12-31",
        endsOn: "2026-12-01",
      }),
    );
  });

  it("a valid timing with no future occurrence keeps the approved text", () => {
    const once: ScheduleTiming = {
      kind: "once",
      date: "2026-01-01",
      time: "11:00",
      timeZone: "Europe/Berlin",
    };
    renderDetail(summary({ timing: once }));
    setValue("schedule-timing-date", "2026-02-01");
    expectReason(
      scheduleTimingFutureError({ ...once, date: "2026-02-01" }, Date.now()),
    );
  });

  it("an unchanged expired timing still saves a prompt-only edit", () => {
    const onSave = renderDetail(
      summary({
        timing: {
          kind: "once",
          date: "2026-01-01",
          time: "11:00",
          timeZone: "Europe/Berlin",
        },
      }),
    );
    setValue("schedule-prompt", "Check the deploy");
    expect(document.getElementById("schedule-timing-error")).toBeNull();
    const fieldset = timingFieldset();
    expect(fieldset.getAttribute("aria-describedby")).toBeNull();
    click(buttonNamed("Save"));
    expect(onSave).toHaveBeenCalledWith("a", { prompt: "Check the deploy" });
  });
});
