// @vitest-environment jsdom
/**
 * The Schedules page and detail as rendered (`docs/schedules.md`, Web): the
 * page-owned delete dialog (D1, D2, D5, D6), Pause all, the empty and error
 * states, the detail's draft and preview (AC9), and the target picker's
 * options and archived read (P1–P4).
 *   cd app/web && pnpm exec vitest run src/components/schedules/schedulesSurfaces.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { ScheduleSummary } from "@assistant/shared/schedules";
import { failed, loading, ready, type LoadState } from "../../lib/loadState.ts";
import {
  reduceAssistantState,
  type UIState,
} from "../../hooks/useAssistant.ts";
import { SchedulesPage } from "./SchedulesPage.tsx";
import { ScheduleDetailPage } from "./ScheduleDetailPage.tsx";
import { scheduleTargetOptions } from "./ScheduleTargetPicker.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopObserver);
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

function summary(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "a",
    name: "Morning check",
    prompt: "Check the build",
    enabled: true,
    timing: {
      kind: "weekly",
      days: ["mon"],
      time: "11:00",
      timeZone: "Europe/Berlin",
    },
    target: { kind: "session", sessionId: "s1" },
    createdBy: { kind: "user" },
    controlledBy: { kind: "user" },
    cardless: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

const text = () => document.body.textContent ?? "";

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name,
  );
  if (!button) throw new Error(`No button named ${name}`);
  return button as HTMLButtonElement;
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

interface PageProps {
  schedules?: ScheduleSummary[];
  answered?: boolean;
  listError?: string | null;
  paused?: boolean;
  mutations?: Record<string, LoadState<true>>;
}

function renderPage(props: PageProps, spies: ReturnType<typeof pageSpies>) {
  act(() =>
    root.render(
      <SchedulesPage
        schedules={props.schedules ?? [summary()]}
        answered={props.answered ?? true}
        listError={props.listError ?? null}
        onRetry={spies.onRetry}
        paused={props.paused ?? false}
        mutations={props.mutations ?? {}}
        onSetPaused={spies.onSetPaused}
        onSetEnabled={spies.onSetEnabled}
        onDelete={spies.onDelete}
        onOpen={spies.onOpen}
        onClaimControls={spies.onClaimControls}
      />,
    ),
  );
}

function pageSpies() {
  return {
    onRetry: vi.fn(),
    onSetPaused: vi.fn(),
    onSetEnabled: vi.fn(),
    onDelete: vi.fn(),
    onOpen: vi.fn(),
    onClaimControls: vi.fn(),
  };
}

describe("the Schedules page", () => {
  it("renders the approved columns and cells", () => {
    renderPage({}, pageSpies());
    for (const head of [
      "Name",
      "Target",
      "Timing",
      "Next",
      "Last",
      "Created by",
      "On",
    ])
      expect(text()).toContain(head);
    expect(text()).toContain("Weekly on Mon at 11:00");
    expect(text()).toContain("You");
  });

  it("says empty only once the list answered, per filter", () => {
    renderPage({ schedules: [], answered: false }, pageSpies());
    expect(text()).not.toContain("No Schedules.");
    renderPage({ schedules: [] }, pageSpies());
    expect(text()).toContain(
      "No Schedules. Agents create them for their sessions.",
    );
    click(buttonNamed("Done"));
    expect(text()).toContain("No done Schedules.");
  });

  it("renders the collection error in place with Retry", () => {
    const spies = pageSpies();
    renderPage(
      {
        schedules: [],
        answered: false,
        listError: "Failed to list Schedules: database is locked",
      },
      spies,
    );
    expect(text()).toContain("Failed to list Schedules: database is locked");
    click(buttonNamed("Retry"));
    expect(spies.onRetry).toHaveBeenCalledTimes(1);
  });

  it("D1: Cancel sends nothing", () => {
    const spies = pageSpies();
    renderPage({}, spies);
    click(buttonNamed("Delete Schedule"));
    expect(text()).toContain('Delete "Morning check"?');
    expect(text()).toContain(
      "This deletes the Schedule and its history. To keep them, switch it off instead.",
    );
    click(buttonNamed("Cancel"));
    expect(spies.onDelete).not.toHaveBeenCalled();
    expect(text()).not.toContain('Delete "Morning check"?');
  });

  it("D2/D5/D6: one confirmed send; the dialog outlives the row's removal and retries once", () => {
    const spies = pageSpies();
    renderPage({}, spies);
    click(buttonNamed("Delete Schedule"));
    click(buttonNamed("Delete"));
    expect(spies.onDelete).toHaveBeenCalledTimes(1);
    expect(spies.onDelete).toHaveBeenCalledWith("a");
    expect(spies.onClaimControls).toHaveBeenLastCalledWith([
      "schedules:pause",
      "a:enabled",
      "a:delete",
    ]);

    // The optimistic removal, then the refusal: still mounted, claimed.
    renderPage({ schedules: [], mutations: { "a:delete": loading() } }, spies);
    expect(text()).toContain('Delete "Morning check"?');
    renderPage(
      {
        schedules: [],
        mutations: {
          "a:delete": failed("Failed to delete Schedule: database is locked"),
        },
      },
      spies,
    );
    expect(text()).toContain("Couldn't delete: database is locked");
    expect(spies.onClaimControls).toHaveBeenLastCalledWith([
      "schedules:pause",
      "a:delete",
    ]);
    click(buttonNamed("Try again"));
    expect(spies.onDelete).toHaveBeenCalledTimes(2);

    // Success closes it.
    renderPage(
      { schedules: [], mutations: { "a:delete": ready(true) } },
      spies,
    );
    expect(text()).not.toContain('Delete "Morning check"?');
  });

  it("releases its claims on unmount, so a later refusal is announced", () => {
    const spies = pageSpies();
    renderPage({}, spies);
    act(() => root.unmount());
    root = createRoot(container);
    expect(spies.onClaimControls).toHaveBeenLastCalledWith([]);
  });

  it("Pause all: pending, the approved note, and the refusal with Try again", () => {
    const spies = pageSpies();
    renderPage({}, spies);
    const toggle = document.getElementById("schedules-pause-all")!;
    click(toggle);
    expect(spies.onSetPaused).toHaveBeenCalledWith(true);
    renderPage(
      { paused: true, mutations: { "schedules:pause": loading() } },
      spies,
    );
    expect(text()).toContain(
      "Paused. No new occurrences are claimed: due times are recorded as missed and do not catch up on resume. An occurrence already claimed, including one that fell due just before pausing, may still be delivered.",
    );
    renderPage(
      {
        paused: false,
        mutations: {
          "schedules:pause": failed(
            "Failed to save Schedules settings: disk full",
          ),
        },
      },
      spies,
    );
    expect(text()).toContain("Couldn't change Pause all: disk full");
    click(buttonNamed("Try again"));
    expect(spies.onSetPaused).toHaveBeenLastCalledWith(true);
    expect(spies.onSetPaused).toHaveBeenCalledTimes(2);
  });
});

function detailSpies() {
  return {
    onRequestArchived: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onOpenHistory: vi.fn(),
    onCloseHistory: vi.fn(),
    onRetryHistory: vi.fn(),
    onOpen: vi.fn(),
    onClaimControls: vi.fn(),
  };
}

function renderDetail(
  props: {
    schedule?: ScheduleSummary | undefined;
    answered?: boolean;
    mutations?: Record<string, LoadState<true>>;
  },
  spies: ReturnType<typeof detailSpies>,
) {
  act(() =>
    root.render(
      <ScheduleDetailPage
        id="a"
        schedule={"schedule" in props ? props.schedule : summary()}
        answered={props.answered ?? true}
        history={{ load: ready([]), revision: 2 }}
        mutations={props.mutations ?? {}}
        failure={undefined}
        liveSessions={[]}
        archived={{ sessions: [], loaded: true, pending: false, error: null }}
        {...spies}
      />,
    ),
  );
}

describe("the Schedule detail", () => {
  it("AC9: shows the fixed zone and the next three occurrences in it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 15, 0, 0));
    renderDetail({}, detailSpies());
    expect(text()).toContain("Time zone");
    expect(text()).toContain("Europe/Berlin");
    expect(text()).toContain("Mon 19 Oct 2026 11:00 Europe/Berlin (UTC+02:00)");
    expect(text()).toContain("Mon 26 Oct 2026 11:00 Europe/Berlin (UTC+01:00)");
    expect(text()).toContain("Mon 2 Nov 2026 11:00 Europe/Berlin (UTC+01:00)");
    expect(text()).toContain("No occurrences yet.");
  });

  it("sends only the changed prompt, and keeps the draft through a refusal", () => {
    const spies = detailSpies();
    renderDetail({}, spies);
    const prompt = document.getElementById(
      "schedule-prompt",
    ) as HTMLTextAreaElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(prompt, "Check the deploy");
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(buttonNamed("Save"));
    expect(spies.onSave).toHaveBeenCalledWith("a", {
      prompt: "Check the deploy",
    });
    renderDetail(
      {
        mutations: {
          "a:update": failed("Failed to update Schedule: Session not found"),
        },
      },
      spies,
    );
    expect(text()).toContain("Couldn't save: Session not found");
    expect(
      (document.getElementById("schedule-prompt") as HTMLTextAreaElement).value,
    ).toBe("Check the deploy");
    click(buttonNamed("Try again"));
    expect(spies.onSave).toHaveBeenCalledTimes(2);
  });

  it("D6: no not-found while its own delete is pending; not-found once gone", () => {
    const spies = detailSpies();
    renderDetail({}, spies);
    renderDetail(
      { schedule: undefined, mutations: { "a:delete": loading() } },
      spies,
    );
    expect(text()).not.toContain("Schedule not found");
    expect(text()).toContain("Morning check");
    renderDetail({ schedule: undefined }, spies);
    expect(text()).toContain("Schedule not found");
    expect(text()).toContain("Back to Schedules");
  });

  it("D4: a confirmed delete's success leaves for the index", () => {
    const spies = detailSpies();
    renderDetail({}, spies);
    click(buttonNamed("Delete Schedule"));
    click(buttonNamed("Delete"));
    expect(spies.onDelete).toHaveBeenCalledWith("a");
    renderDetail(
      { schedule: undefined, mutations: { "a:delete": ready(true) } },
      spies,
    );
    expect(spies.onOpen).toHaveBeenCalledWith("/schedules");
  });

  it("opens and closes its history read with the page", () => {
    const spies = detailSpies();
    renderDetail({}, spies);
    expect(spies.onOpenHistory).toHaveBeenCalledWith("a");
    act(() => root.unmount());
    root = createRoot(container);
    expect(spies.onCloseHistory).toHaveBeenCalledWith("a");
  });
});

function session(
  id: string,
  overrides: Partial<SessionListItem> = {},
): SessionListItem {
  return { id, title: `Session ${id}`, ...overrides } as SessionListItem;
}

describe("the target picker's options (P1–P4)", () => {
  const titleOf = (id: string) =>
    id === "gone-from-lists"
      ? {
          uri: `pa://session/${id}`,
          objectType: "session",
          knownType: true,
          id,
          href: `/sessions/${id}`,
          title: "Resolved title",
          typeLabel: "Session",
          existence: "exists" as const,
        }
      : undefined;

  it("P1: titles a current target no list holds through the resolver", () => {
    const { groups } = scheduleTargetOptions({
      live: [session("s1")],
      archived: { sessions: [], loaded: false, pending: true, error: null },
      currentId: "gone-from-lists",
      titleOf,
    });
    expect(groups[0]!.items[0]).toEqual({
      id: "gone-from-lists",
      title: "Resolved title",
    });
  });

  it("P2: offers the archived sessions once the read answered", () => {
    const { groups, archivedStatus } = scheduleTargetOptions({
      live: [session("s1")],
      archived: {
        sessions: [session("old", { archived: true })],
        loaded: true,
        pending: false,
        error: null,
      },
      currentId: "s1",
      titleOf,
    });
    expect(archivedStatus).toEqual({ kind: "ready" });
    expect(groups.map((group) => group.value)).toEqual(["live", "archived"]);
    expect(groups[1]!.items).toEqual([{ id: "old", title: "Session old" }]);
  });

  it("P3: pending reads as loading and a failed release as the error, never an empty group", () => {
    const pending = scheduleTargetOptions({
      live: [],
      archived: { sessions: [], loaded: false, pending: true, error: null },
      currentId: "s1",
      titleOf,
    });
    expect(pending.archivedStatus).toEqual({ kind: "loading" });
    expect(pending.groups.map((group) => group.value)).toEqual(["live"]);
    const failedRead = scheduleTargetOptions({
      live: [],
      archived: {
        sessions: [],
        loaded: false,
        pending: false,
        error: "Failed to load archived sessions: database is locked",
      },
      currentId: "s1",
      titleOf,
    });
    expect(failedRead.archivedStatus).toEqual({
      kind: "failed",
      error: "Failed to load archived sessions: database is locked",
    });
  });

  it("P3: Retry asks for exactly one new archived read", () => {
    const base = {
      archivedReadQueued: false,
      archivedReadFlight: "r1",
      archivedReadError: null,
    } as unknown as UIState;
    const released = reduceAssistantState(base, {
      kind: "archivedReadReleased",
      requestId: "r1",
      error: "Failed to load archived sessions: boom",
    });
    const retried = reduceAssistantState(released, {
      kind: "archivedReadRequested",
    });
    expect(retried.archivedReadQueued).toBe(true);
    expect(
      reduceAssistantState(retried, { kind: "archivedReadRequested" }),
    ).toBe(retried);
  });

  it("P4: never offers the Personal Assistant", () => {
    const { groups } = scheduleTargetOptions({
      live: [session("pa", { agentType: "personal-assistant" }), session("s1")],
      archived: {
        sessions: [
          session("pa-old", {
            archived: true,
            agentType: "personal-assistant",
          }),
        ],
        loaded: true,
        pending: false,
        error: null,
      },
      currentId: "s1",
      titleOf,
    });
    expect(groups.flatMap((group) => group.items.map((o) => o.id))).toEqual([
      "s1",
    ]);
  });
});
