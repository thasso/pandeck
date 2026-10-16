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
  sessions?: SessionListItem[];
  fresh?: boolean;
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
    ]);
    expect(text(view)).toContain("and 52 more");

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

  it("orders Initiatives newest first, above the sessions, and never moves one on a state change", () => {
    const view = mount();
    const { render } = inbox(view, [initiative("3"), initiative("12")], {
      sessions: [session("s-a")],
    });
    const order = () =>
      [
        ...view.container.querySelectorAll<HTMLElement>("[data-inbox-card]"),
      ].map((row) => row.dataset.inboxCard);
    expect(order()).toEqual(["initiative:12", "initiative:3", "s-a"]);
    render([
      initiative("3", {
        state: "done",
        attention: { revision: 1, settledRevision: 0, kind: "done", at: NOW },
      }),
      initiative("12"),
    ]);
    expect(order()).toEqual(["initiative:12", "initiative:3", "s-a"]);
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
  });
});
