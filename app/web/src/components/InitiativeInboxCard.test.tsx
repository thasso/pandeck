// @vitest-environment jsdom
/**
 * Initiatives in the Sessions inbox, as the user meets them
 * (`docs/initiatives.md`, The attention list; `app/web/docs/ui-shell.md`): the
 * card's facts from the summary, Settle on a paused or done one only, the
 * session disclosure whose rows keep their own cards, controls that never
 * open the Initiative by accident, keyboard reach, and the inbox's loading,
 * error and empty claims with Initiatives counted.
 *   pnpm --filter @assistant/web test src/components/InitiativeInboxCard.test.tsx
 */
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InitiativeSummary, SessionListItem } from "@assistant/shared";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { mount, type Mounted } from "../test/mount.tsx";
import { SessionInbox } from "./SessionInbox.tsx";
import type { RowDensity } from "../lib/rowDensity.ts";
import {
  createSessionInboxBarStore,
  type SessionInboxBarStore,
} from "../lib/sessionInboxBarStore.ts";

stubMatchMedia();

const NOW = Date.now();

function session(id: string, extra: Partial<SessionListItem> = {}) {
  return {
    id,
    harness: "pi",
    agentType: "developer",
    title: `Session ${id}`,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    ...extra,
  } as SessionListItem;
}

function initiative(
  id: string,
  extra: Partial<InitiativeSummary> = {},
): InitiativeSummary {
  return {
    id,
    title: `Initiative ${id}`,
    state: "active",
    progress: { total: 10, done: 4, doing: 2, startable: 3, blocked: 1 },
    sessionIds: [],
    sessionCount: 0,
    // Creation follows the id, as the sequence that allots both does.
    createdAt: NOW - 10_000_000 + Number(id),
    updatedAt: NOW - 120_000,
    ...extra,
  };
}

interface Calls {
  opened: string[];
  settled: Array<[string, number]>;
  selected: string[];
  retried: number;
}

interface Options {
  animate?: boolean;
  barStore?: SessionInboxBarStore;
  onSetInboxPositions?: () => void;
  sessions?: SessionListItem[];
  fresh?: boolean;
  refreshing?: boolean;
  error?: string | null;
  density?: RowDensity;
}

function inbox(
  view: Mounted,
  initiatives: InitiativeSummary[],
  options: Options = {},
) {
  const calls: Calls = { opened: [], settled: [], selected: [], retried: 0 };
  // `view.render` acts itself.
  const render = (next: InitiativeSummary[], more: Options = {}) =>
    view.render(
      <SessionInbox
        barStore={options.barStore}
        onSetInboxPositions={options.onSetInboxPositions}
        sessions={more.sessions ?? options.sessions ?? []}
        archivedSessionCount={0}
        archivedSessionsLoaded
        currentId={undefined}
        readCurrentId={undefined}
        projects={[]}
        worktrees={[]}
        tasks={[]}
        workflowRuns={[]}
        workflowCards={{}}
        worktreeStatuses={{}}
        animateListChanges={more.animate ?? options.animate ?? false}
        density={more.density ?? options.density ?? "tight"}
        onSelect={(id) => calls.selected.push(id)}
        onSettle={() => {}}
        onArchive={() => {}}
        onDeleteSession={() => {}}
        onRenameSession={() => {}}
        onLoadArchivedSessions={() => {}}
        onOpenBackgroundTasks={() => {}}
        onOpenProject={() => {}}
        onOpenTask={() => {}}
        onOpenWorkflowRun={() => {}}
        onSettleWorkflowRun={() => {}}
        initiatives={next}
        initiativesFresh={more.fresh ?? options.fresh ?? true}
        initiativesRefreshing={more.refreshing ?? options.refreshing ?? false}
        initiativeListError={more.error ?? options.error ?? null}
        onRetryInitiatives={() => {
          calls.retried += 1;
        }}
        onOpenInitiative={(id) => calls.opened.push(id)}
        onSettleInitiative={(id, revision) =>
          calls.settled.push([id, revision])
        }
        onOpenWorktree={() => {}}
      />,
    );
  render(initiatives);
  return { calls, render };
}

function card(view: Mounted, id: string): HTMLElement | null {
  return view.container.querySelector<HTMLElement>(
    `[data-list-row-id="initiative:${id}"]`,
  );
}

function within(view: Mounted, id: string, selector: string) {
  return card(view, id)?.querySelector<HTMLElement>(selector) ?? null;
}

/** Every top-level item, in the order the inbox shows them. */
function order(view: Mounted): Array<string | undefined> {
  return [
    ...view.container.querySelectorAll<HTMLElement>("[data-inbox-card]"),
  ].map((row) => row.dataset.inboxCard);
}

/** The items of Needs you, in order. */
function needsYou(view: Mounted): Array<string | undefined> {
  return [
    ...view.container.querySelectorAll<HTMLElement>(
      "[data-inbox-needs-you] [data-inbox-card]",
    ),
  ].map((row) => row.dataset.inboxCard);
}

function text(view: Mounted): string {
  return view.container.textContent ?? "";
}

describe("Initiative items in the Sessions inbox", () => {
  it("states title, progress, ready, blocked and the next milestone", () => {
    const view = mount();
    inbox(view, [
      initiative("7", {
        title: "Hosted Labs",
        progress: { total: 32, done: 5, doing: 5, startable: 4, blocked: 18 },
        nextMilestone: { id: "931", title: "First hosted release" },
      }),
    ]);
    const item = card(view, "7")!;
    expect(item.textContent).toContain("Hosted Labs");
    expect(item.textContent).toContain("5/32");
    expect(item.textContent).toContain("4 ready");
    expect(item.textContent).toContain("18 blocked");
    expect(item.textContent).toContain("First hosted release");
    const label = item.getAttribute("aria-label")!;
    expect(label).toContain("Open Initiative Hosted Labs");
    expect(label).toContain("Active");
    expect(label).toContain("5 of 32 Tasks done");
    expect(label).toContain("4 ready to start");
    expect(label).toContain("18 blocked");
    expect(label).toContain("next milestone First hosted release");
  });

  it("renders the agent-written title and milestone as inline Markdown", () => {
    const view = mount();
    inbox(view, [
      initiative("7", {
        title: "Ship `TaskItem` sync",
        nextMilestone: { id: "931", title: "**First** release" },
      }),
    ]);
    const item = card(view, "7")!;
    expect(item.innerHTML).toContain("Ship <code>TaskItem</code> sync");
    expect(item.innerHTML).toContain("<strong>First</strong> release");
    expect(item.textContent).not.toContain("**");
  });

  it("offers Settle on an unsettled outcome only, with the rendered revision", () => {
    const view = mount();
    const { calls } = inbox(view, [
      initiative("1"),
      initiative("2", {
        state: "paused",
        attention: { revision: 3, settledRevision: 2, kind: "paused", at: NOW },
      }),
      initiative("3", {
        state: "done",
        attention: { revision: 1, settledRevision: 1, kind: "done", at: NOW },
      }),
      // Active with an old, unsettled pause: still no Settle on active work.
      initiative("4", {
        attention: { revision: 1, settledRevision: 0, kind: "paused", at: NOW },
      }),
    ]);
    expect(card(view, "1")).not.toBeNull();
    expect(within(view, "1", 'button[aria-label^="Settle"]')).toBeNull();
    expect(card(view, "3"), "a settled outcome is not an item").toBeNull();
    expect(within(view, "4", 'button[aria-label^="Settle"]')).toBeNull();

    act(() => within(view, "2", 'button[aria-label^="Settle"]')!.click());
    expect(calls.settled).toEqual([["2", 3]]);
    expect(calls.opened, "Settle does not open the Initiative").toEqual([]);

    // The keyboard path settles too, from the focused card.
    const paused = card(view, "2")!;
    act(() => {
      paused.focus();
      paused.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", bubbles: true }),
      );
    });
    expect(calls.settled).toEqual([
      ["2", 3],
      ["2", 3],
    ]);
  });

  it("sends the revision captured at the click after the exit, not a newer one", () => {
    vi.useFakeTimers();
    try {
      const view = mount();
      const pausedAt = (revision: number) =>
        initiative("2", {
          state: revision === 1 ? "paused" : "done",
          attention: {
            revision,
            settledRevision: 0,
            kind: revision === 1 ? "paused" : "done",
            at: NOW,
          },
        });
      const { calls, render } = inbox(view, [pausedAt(1)], { animate: true });
      act(() => within(view, "2", 'button[aria-label^="Settle"]')!.click());
      expect(calls.settled, "sent when the exit has played").toEqual([]);
      // Done lands while the card slides out.
      render([pausedAt(2)]);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(calls.settled).toEqual([["2", 1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a Settle exactly once whether its exit or the inbox ends first (F037)", () => {
    vi.useFakeTimers();
    try {
      const outcome = initiative("2", {
        state: "paused",
        attention: { revision: 1, settledRevision: 0, kind: "paused", at: NOW },
      });
      // The section switch comes first: the exit never finishes.
      const left = mount();
      const first = inbox(left, [outcome], { animate: true });
      act(() => within(left, "2", 'button[aria-label^="Settle"]')!.click());
      act(() => {
        vi.advanceTimersByTime(100);
      });
      act(() => left.root.unmount());
      expect(first.calls.settled).toEqual([["2", 1]]);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(first.calls.settled).toEqual([["2", 1]]);

      // The exit finishes first, then the inbox goes.
      const stayed = mount();
      const second = inbox(stayed, [outcome], { animate: true });
      act(() => within(stayed, "2", 'button[aria-label^="Settle"]')!.click());
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      act(() => stayed.root.unmount());
      expect(second.calls.settled).toEqual([["2", 1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the Initiative from the card, by click and by Enter", () => {
    const view = mount();
    const { calls } = inbox(view, [initiative("7")]);
    act(() => card(view, "7")!.click());
    act(() => {
      card(view, "7")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(calls.opened).toEqual(["7", "7"]);
  });

  it("lists its sessions on request; each keeps its own card, in every Initiative", () => {
    const view = mount();
    const sessions = [session("s-a"), session("s-b"), session("s-c")];
    const { calls } = inbox(
      view,
      [
        initiative("7", { sessionIds: ["s-a", "s-b"], sessionCount: 54 }),
        initiative("8", { sessionIds: ["s-b"], sessionCount: 1 }),
      ],
      { sessions },
    );
    const toggle = within(view, "7", "button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("54 sessions");
    act(() => toggle.click());
    expect(calls.opened, "the disclosure does not open the card").toEqual([]);
    expect(
      within(view, "7", "button[aria-expanded]")!.getAttribute("aria-expanded"),
    ).toBe("true");

    const listed = view.container.querySelectorAll<HTMLElement>(
      '[data-list-row-id^="initiative:7:"]',
    );
    expect([...listed].map((row) => row.dataset.listRowId)).toEqual([
      "initiative:7:s-a",
      "initiative:7:s-b",
      "initiative:7:more",
    ]);
    expect(listed[2]!.textContent).toContain("and 52 more");

    // The other Initiative lists the shared session as well.
    act(() => within(view, "8", "button[aria-expanded]")!.click());
    expect(
      view.container.querySelector('[data-list-row-id="initiative:8:s-b"]'),
    ).not.toBeNull();

    // No folding: every session still has its own card, exactly once.
    for (const id of ["s-a", "s-b", "s-c"])
      expect(
        view.container.querySelectorAll(`[data-list-row-id="${id}"]`),
      ).toHaveLength(1);

    // A listed row opens that session, not the Initiative.
    act(() => listed[1]!.click());
    expect(calls.selected).toEqual(["s-b"]);
    expect(calls.opened).toEqual([]);
    expect(
      listed[1]!.getAttribute("aria-label"),
      "the row offers none of the session's own lifecycle keys",
    ).toContain("Open working");
  });

  it("moves through cards and listed rows with the arrow keys", () => {
    const view = mount();
    inbox(view, [initiative("7", { sessionIds: ["s-a"], sessionCount: 1 })], {
      sessions: [session("s-a")],
    });
    act(() => within(view, "7", "button[aria-expanded]")!.click());
    const rows = [
      ...view.container.querySelectorAll<HTMLElement>("[data-session-row]"),
    ].map((row) => row.dataset.listRowId);
    expect(rows).toEqual(["initiative:7", "initiative:7:s-a", "s-a"]);
    act(() => {
      card(view, "7")!.focus();
      card(view, "7")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.listRowId,
    ).toBe("initiative:7:s-a");
  });

  it("follows each new summary: title, counts, milestone and leaving", () => {
    const view = mount();
    const { render } = inbox(view, [initiative("7")]);
    render([
      initiative("7", {
        title: "Hosted Labs v2",
        progress: { total: 12, done: 6, doing: 1, startable: 2, blocked: 0 },
        nextMilestone: { id: "9", title: "Beta" },
      }),
    ]);
    const item = card(view, "7")!;
    expect(item.textContent).toContain("Hosted Labs v2");
    expect(item.textContent).toContain("6/12");
    expect(item.textContent).toContain("2 ready");
    expect(item.textContent).not.toContain("blocked");
    expect(item.textContent).toContain("Beta");
    render([]);
    expect(card(view, "7")).toBeNull();
  });

  it("orders active Initiatives newest first in their block above the sessions", () => {
    const view = mount();
    inbox(view, [initiative("3"), initiative("12")], {
      sessions: [session("s-a")],
    });
    expect(order(view)).toEqual(["initiative:12", "initiative:3", "s-a"]);
    expect(
      card(view, "12")!.closest("[data-inbox-initiatives]"),
      "active work is its own block",
    ).not.toBeNull();
  });

  it("is not empty with only an Initiative, and claims nothing before the list answers", () => {
    const view = mount();
    const { render, calls } = inbox(view, [initiative("7")]);
    expect(text(view)).not.toContain("No sessions yet");
    expect(text(view)).not.toContain("Nothing needs you");

    render([], { fresh: false });
    expect(
      view.container.querySelector('[role="status"]')?.textContent,
    ).toContain("Loading Initiatives…");
    expect(text(view)).not.toContain("No sessions yet");

    render([], { fresh: true });
    expect(text(view)).toContain("No sessions yet");

    render([initiative("7")], {
      fresh: false,
      error: "Failed to list Initiatives: offline",
    });
    expect(text(view)).toContain("Failed to list Initiatives: offline");
    expect(card(view, "7"), "held items stay under the failure").not.toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Retry"),
    )!;
    act(() => retry.click());
    expect(calls.retried).toBe(1);
  });

  it("refreshes a held empty answer without claiming it or loading anew (F055)", () => {
    const view = mount();
    const { render } = inbox(view, [], { fresh: false, refreshing: true });
    const status = [...view.container.querySelectorAll('[role="status"]')];
    expect(status.map((el) => el.textContent)).toEqual([
      "Refreshing Initiatives",
    ]);
    expect(text(view)).not.toContain("Loading Initiatives");
    expect(text(view)).not.toContain("No sessions yet");
    expect(text(view)).not.toContain("Nothing needs you");

    render([initiative("7")], { fresh: false, refreshing: true });
    expect(
      card(view, "7"),
      "held items stay while it refreshes",
    ).not.toBeNull();
    expect(text(view)).not.toContain("Nothing needs you");

    render([], { fresh: true, refreshing: false });
    expect(text(view)).toContain("No sessions yet");
    expect(view.container.querySelector('[role="status"]')).toBeNull();
  });

  it("claims no emptiness when the first Initiative read failed (F040)", () => {
    const view = mount();
    const error = "Failed to list Initiatives: offline";
    const { render, calls } = inbox(view, [], { fresh: false, error });
    expect(text(view)).toContain(error);
    expect(text(view), "a failed read is not a zero result").not.toContain(
      "No sessions yet",
    );
    expect(text(view)).not.toContain("Nothing needs you");
    expect(view.container.querySelector('[role="status"]')).toBeNull();
    const retry = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Retry"),
    )!;
    act(() => retry.click());
    expect(calls.retried).toBe(1);

    // Only settled sessions held: still no "nothing needs you" over the failure.
    render([], {
      fresh: false,
      error,
      sessions: [session("s-old", { settledAt: NOW - 5_000 })],
    });
    expect(text(view)).toContain(error);
    expect(text(view)).not.toContain("Nothing needs you");
    expect(text(view)).not.toContain("No sessions yet");

    // Useful sessions are never hidden by the failure.
    render([], { fresh: false, error, sessions: [session("s-a")] });
    expect(text(view)).toContain(error);
    expect(
      view.container.querySelector('[data-list-row-id="s-a"]'),
    ).not.toBeNull();

    // The list's own answer, empty, is the one that may say so.
    const answered = mount();
    inbox(answered, [], { fresh: true });
    expect(text(answered)).toContain("No sessions yet");
    expect(text(answered)).not.toContain(error);
  });

  it("gives a phone thumb-sized controls", () => {
    const view = mount();
    inbox(
      view,
      [
        initiative("2", {
          state: "paused",
          attention: {
            revision: 1,
            settledRevision: 0,
            kind: "paused",
            at: NOW,
          },
          sessionIds: ["s-a"],
          sessionCount: 1,
        }),
      ],
      { sessions: [session("s-a")], density: "comfortable" },
    );
    const settle = within(view, "2", 'button[aria-label^="Settle"]')!;
    // The comfortable inline action, a 28px target, as on a session card.
    expect(settle.className).toContain("size-7");
    act(() => within(view, "2", "button[aria-expanded]")!.click());
    const row = view.container.querySelector<HTMLElement>(
      '[data-list-row-id="initiative:2:s-a"]',
    )!;
    expect(row.className).toContain("h-10");
    expect(
      card(view, "2")!.closest("[data-inbox-needs-you]"),
      "a paused outcome is in Needs you on a phone too",
    ).not.toBeNull();
  });

  it("puts an unsettled outcome in Needs you, counted, and moves it on every transition", () => {
    const view = mount();
    const barStore = createSessionInboxBarStore();
    const { render, calls } = inbox(view, [initiative("4")], {
      barStore,
      sessions: [session("s-a")],
    });
    const placeOf = () => {
      const item = card(view, "4");
      if (!item) return "none";
      expect(
        view.container.querySelectorAll('[data-list-row-id="initiative:4"]'),
        "one card, never an active and an outcome copy",
      ).toHaveLength(1);
      return item.closest("[data-inbox-needs-you]")
        ? "needs-you"
        : item.closest("[data-inbox-initiatives]")
          ? "active"
          : "elsewhere";
    };
    const count = () => barStore.get()?.needsYou;
    expect([placeOf(), count()]).toEqual(["active", 0]);

    const outcome = (revision: number, settledRevision: number) =>
      initiative("4", {
        state: revision === 2 ? "done" : "paused",
        attention: {
          revision,
          settledRevision,
          kind: revision === 2 ? "done" : "paused",
          at: NOW,
        },
      });
    render([outcome(1, 0)]);
    expect([placeOf(), count()]).toEqual(["needs-you", 1]);
    render([outcome(1, 1)]);
    expect([placeOf(), count()], "settled leaves both places").toEqual([
      "none",
      0,
    ]);
    render([{ ...outcome(1, 1), state: "active" }]);
    expect([placeOf(), count()]).toEqual(["active", 0]);
    expect(within(view, "4", 'button[aria-label^="Settle"]')).toBeNull();
    // A new outcome over the old cursor: back in Needs you, settling what it shows.
    render([outcome(2, 1)]);
    expect([placeOf(), count()]).toEqual(["needs-you", 1]);
    act(() => within(view, "4", 'button[aria-label^="Settle"]')!.click());
    expect(calls.settled).toEqual([["4", 2]]);
  });

  it("is a Needs you of its own with no session at all, and the count leads to it", () => {
    const view = mount();
    const barStore = createSessionInboxBarStore();
    inbox(
      view,
      [
        initiative("4", {
          state: "done",
          attention: { revision: 1, settledRevision: 0, kind: "done", at: NOW },
        }),
      ],
      { barStore },
    );
    expect(needsYou(view)).toEqual(["initiative:4"]);
    expect(barStore.get()?.needsYou).toBe(1);
    expect(text(view)).not.toContain("No sessions yet");
    expect(text(view)).not.toContain("Nothing needs you");
    act(() => barStore.get()!.onNeedsYou());
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.listRowId,
    ).toBe("initiative:4");
  });

  it("orders outcomes among the other Needs you items by creation, arrow keys between them", () => {
    const view = mount();
    const barStore = createSessionInboxBarStore();
    const positions: unknown[] = [];
    inbox(
      view,
      [
        initiative("4", {
          state: "paused",
          attention: {
            revision: 1,
            settledRevision: 0,
            kind: "paused",
            at: NOW,
          },
          createdAt: NOW - 1_000,
        }),
        initiative("5", {
          state: "done",
          attention: { revision: 1, settledRevision: 0, kind: "done", at: NOW },
          createdAt: NOW - 9_000_000,
        }),
        initiative("6"),
      ],
      {
        barStore,
        onSetInboxPositions: () => positions.push("written"),
        sessions: [
          session("asking", {
            createdAt: NOW - 5_000,
            awaitingInput: true,
            attention: "question",
          }),
          session("quiet"),
        ],
      },
    );
    expect(needsYou(view)).toEqual(["initiative:4", "asking", "initiative:5"]);
    expect(barStore.get()?.needsYou).toBe(3);
    // Initiatives are never among the dragged items.
    for (const id of ["4", "5", "6"])
      expect(
        card(view, id)!.closest("[data-inbox-card]")!.className,
      ).not.toContain("touch-manipulation");
    act(() => {
      card(view, "4")!.focus();
      card(view, "4")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.listRowId,
    ).toBe("asking");
    expect(positions).toEqual([]);
  });

  it("lists at most five sessions, needing you first, then one more row to the Initiative", () => {
    const view = mount();
    const rows = Array.from({ length: 50 }, (_, index) =>
      session(`s${String(index).padStart(2, "0")}`, {
        createdAt: NOW - index * 1_000,
      }),
    );
    // The two oldest held sessions are the ones that need you.
    rows[48] = session("s48", {
      createdAt: NOW - 48_000,
      awaitingInput: true,
      attention: "question",
    });
    rows[49] = session("s49", {
      createdAt: NOW - 49_000,
      lastError: { at: NOW - 49_000, message: "boom" },
    });
    const summary = (sessionIds: string[]) =>
      initiative("7", { sessionIds, sessionCount: 57 });
    const { calls, render } = inbox(view, [summary(rows.map((r) => r.id))], {
      sessions: rows,
    });
    act(() => within(view, "7", "button[aria-expanded]")!.click());
    const listed = () =>
      [
        ...view.container.querySelectorAll<HTMLElement>(
          '[data-list-row-id^="initiative:7:"]',
        ),
      ].map((row) => row.dataset.listRowId);
    expect(listed()).toEqual([
      "initiative:7:s48",
      "initiative:7:s49",
      "initiative:7:s00",
      "initiative:7:s01",
      "initiative:7:s02",
      "initiative:7:more",
    ]);
    const more = () =>
      view.container.querySelector<HTMLElement>(
        '[data-list-row-id="initiative:7:more"]',
      )!;
    expect(more().textContent).toContain("and 52 more");

    // The more row opens the Initiative once per gesture, by click and by
    // Enter, and neither closes the fold nor opens a session.
    act(() => more().click());
    act(() => {
      more().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(calls.opened).toEqual(["7", "7"]);
    expect(calls.selected).toEqual([]);
    expect(
      within(view, "7", "button[aria-expanded]")!.getAttribute("aria-expanded"),
    ).toBe("true");

    // A newer session starts needing you: it moves up, and the list stays five.
    const asking = rows.map((row) =>
      row.id === "s03"
        ? { ...row, awaitingInput: true, attention: "question" as const }
        : row,
    );
    render([summary(rows.map((r) => r.id))], { sessions: asking });
    expect(listed().slice(0, 3)).toEqual([
      "initiative:7:s03",
      "initiative:7:s48",
      "initiative:7:s49",
    ]);
    expect(listed()).toHaveLength(6);

    // The summary drops a session that was settled: the row goes with it.
    render([summary(rows.map((r) => r.id).filter((id) => id !== "s03"))], {
      sessions: asking,
    });
    expect(listed()).not.toContain("initiative:7:s03");

    // Closing and reopening keeps the bound.
    act(() => within(view, "7", "button[aria-expanded]")!.click());
    expect(listed()).toEqual([]);
    act(() => within(view, "7", "button[aria-expanded]")!.click());
    expect(listed()).toHaveLength(6);

    // Every session still has its own card exactly once.
    for (const id of ["s00", "s48", "s49"])
      expect(
        view.container.querySelectorAll(`[data-list-row-id="${id}"]`),
      ).toHaveLength(1);
  });

  it("states unlisted sessions truthfully, and offers no more row when all fit", () => {
    const view = mount();
    const { render } = inbox(
      view,
      [initiative("7", { sessionIds: ["x", "y"], sessionCount: 57 })],
      { sessions: [] },
    );
    act(() => within(view, "7", "button[aria-expanded]")!.click());
    const rows = () =>
      [
        ...view.container.querySelectorAll<HTMLElement>(
          '[data-list-row-id^="initiative:7:"]',
        ),
      ].map((row) => [row.dataset.listRowId, row.textContent]);
    expect(rows()).toEqual([["initiative:7:more", "and 57 more"]]);

    render(
      [initiative("7", { sessionIds: ["a", "b", "x"], sessionCount: 57 })],
      {
        sessions: [session("a"), session("b")],
      },
    );
    expect(rows().at(-1)).toEqual(["initiative:7:more", "and 55 more"]);
    expect(rows()).toHaveLength(3);

    render([initiative("7", { sessionIds: ["a", "b"], sessionCount: 2 })], {
      sessions: [session("a"), session("b")],
    });
    expect(rows().map(([id]) => id)).toEqual([
      "initiative:7:a",
      "initiative:7:b",
    ]);
  });
});
