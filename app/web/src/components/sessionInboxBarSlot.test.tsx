// @vitest-environment jsdom
import { act, Profiler, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { createSessionInboxBarStore } from "../lib/sessionInboxBarStore.ts";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { mount, type Mounted } from "../test/mount.tsx";
import { SessionInbox } from "./SessionInbox.tsx";
import { SessionInboxBarSlot } from "./SessionInboxBar.tsx";

stubMatchMedia();

/**
 * The Sidebar draws the inbox's counts bar above its scroll container, from
 * facts the inbox publishes (`sessionInboxBarStore`). The point of a store
 * over host state: a count changing redraws the bar, never the host — whose
 * every prop is held stable — and an unchanged count redraws nothing.
 */
describe("the host-drawn Sessions bar", () => {
  const NOW = 1_800_000_000_000;
  let view: Mounted | null = null;

  afterEach(() => {
    view = null;
  });

  function session(
    id: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem {
    return {
      id,
      harness: "pi",
      agentType: "assistant",
      title: `Session ${id}`,
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 60_000,
      messageCount: 2,
      ...extra,
    } as SessionListItem;
  }

  const store = createSessionInboxBarStore();
  const onOpenBackgroundTasks = () => {};
  const hostRender = vi.fn();
  const slotCommit = vi.fn();

  /** The Sidebar's part: draws the slot above the list it is handed. */
  function Host({ children }: { children: ReactNode }) {
    hostRender();
    return (
      <>
        <Profiler id="slot" onRender={slotCommit}>
          <SessionInboxBarSlot
            store={store}
            onOpenBackgroundTasks={onOpenBackgroundTasks}
          />
        </Profiler>
        {children}
      </>
    );
  }

  function inbox(sessions: SessionListItem[], animateListChanges = false) {
    return (
      <SessionInbox
        barStore={store}
        sessions={sessions}
        archivedSessionCount={0}
        archivedSessionsLoaded
        onOpenBackgroundTasks={onOpenBackgroundTasks}
        currentId={undefined}
        readCurrentId={undefined}
        projects={[]}
        worktrees={[]}
        tasks={[]}
        workflowRuns={[]}
        workflowCards={{}}
        worktreeStatuses={{}}
        animateListChanges={animateListChanges}
        density="tight"
        onSelect={() => {}}
        onSettle={() => {}}
        onDismissFailure={() => {}}
        onArchive={() => {}}
        onDeleteSession={() => {}}
        onRenameSession={() => {}}
        onLoadArchivedSessions={() => {}}
        onOpenProject={() => {}}
        onOpenTask={() => {}}
        onOpenWorkflowRun={() => {}}
        onSettleWorkflowRun={() => {}}
        onOpenWorktree={() => {}}
      />
    );
  }

  /** Mount the host once, then hand it the inbox for each session list. */
  function render(sessions: SessionListItem[], animateListChanges = false) {
    view ??= mount();
    act(() =>
      view!.root.render(<Host>{inbox(sessions, animateListChanges)}</Host>),
    );
  }

  const chip = (label: string) =>
    view!.container.querySelector(`[title="${label}"]`);

  it("draws the counts the inbox publishes, before paint, and only once", () => {
    render([session("a", { attention: "question" })]);
    expect(chip("1 session is waiting for you")).not.toBeNull();
    // The list carries no bar of its own while its host draws one.
    expect(
      view!.container.querySelectorAll(
        '[title="1 session is waiting for you"]',
      ),
    ).toHaveLength(1);
  });

  it("redraws the bar, not the host, when a count changes", () => {
    render([session("a", { attention: "question" })]);
    hostRender.mockClear();

    // One host render for the new list; the count it changes reaches the bar
    // through the store, without a second pass over the host.
    render([
      session("a", { attention: "question" }),
      session("b", { attention: "question" }),
    ]);
    expect(chip("2 sessions are waiting for you")).not.toBeNull();
    expect(hostRender).toHaveBeenCalledTimes(1);

    // An answer equal to the last one reaches no one.
    slotCommit.mockClear();
    act(() => {
      const facts = store.get()!;
      store.set({ ...facts, background: { ...facts.background } });
    });
    expect(slotCommit).not.toHaveBeenCalled();
  });

  it("clears the bar once the inbox is gone", () => {
    render([session("a")]);
    expect(store.get()).not.toBeNull();
    act(() => view!.root.render(<Host>{null}</Host>));
    expect(store.get()).toBeNull();
    expect(chip("Nothing is waiting for you")).toBeNull();
  });

  /**
   * The bar appears only after the list's first reorder pass has measured, and
   * on a phone that first pass runs on every return from a chat. The bar then
   * pushes the whole list down without any card moving IN it, and the next
   * repaint must not slide every card down from one bar height above.
   */
  describe("and the cards' reorder animation", () => {
    const BAR_PX = 40;
    const CARD_PX = 80;
    const animate = vi.fn();

    beforeEach(() => {
      animate.mockReset();
      animate.mockImplementation(() => ({
        cancel() {},
        addEventListener() {},
      }));
      // jsdom has no layout: a card stands at its index in the list, and the
      // list stands below the bar once the bar is drawn.
      const list = () =>
        [...view!.container.children].find((child) =>
          child.querySelector("[data-inbox-card]"),
        );
      vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(
        function (this: HTMLElement) {
          return this.dataset.inboxCard ? (list() ?? null) : null;
        },
      );
      vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(
        function (this: HTMLElement) {
          if (this === list()) {
            return view!.container.firstElementChild === this ? 0 : BAR_PX;
          }
          const cards = [
            ...view!.container.querySelectorAll("[data-inbox-card]"),
          ];
          return Math.max(0, cards.indexOf(this)) * CARD_PX;
        },
      );
      Object.defineProperty(HTMLElement.prototype, "animate", {
        value: animate,
        configurable: true,
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    });

    const animated = () =>
      animate.mock.contexts.map(
        (node) => (node as HTMLElement).dataset.inboxCard,
      );

    it("does not move the cards when the bar pushes the list down", () => {
      render([session("a"), session("b")], true);
      expect(chip("Nothing is waiting for you")).not.toBeNull();

      // A repaint that moves no card: one of them is retitled.
      render([session("a", { title: "Renamed" }), session("b")], true);
      expect(animated()).toEqual([]);

      // A real reorder still travels: b now asks, and leads the list.
      render(
        [
          session("a", { title: "Renamed" }),
          session("b", { attention: "question" }),
        ],
        true,
      );
      expect(animated().sort()).toEqual(["a", "b"]);
    });
  });
});
