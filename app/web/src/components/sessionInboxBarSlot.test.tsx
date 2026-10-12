// @vitest-environment jsdom
import { act, Profiler, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  function inbox(sessions: SessionListItem[]) {
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
        animateListChanges={false}
        density="tight"
        onSelect={() => {}}
        onSettle={() => {}}
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
  function render(sessions: SessionListItem[]) {
    view ??= mount();
    act(() => view!.root.render(<Host>{inbox(sessions)}</Host>));
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
});
