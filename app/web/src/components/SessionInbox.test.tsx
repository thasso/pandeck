// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionListItem,
  TaskSummary,
  WorkflowRunCard,
  WorkflowRunSummary,
} from "@assistant/shared";
import type { RowDensity } from "../lib/rowDensity.ts";
import { dismissToast, getToasts } from "../lib/toast.ts";
import { stubMatchMedia } from "../test/matchMedia.ts";
import { mount, type Mounted } from "../test/mount.tsx";
import { SessionInbox } from "./SessionInbox.tsx";

stubMatchMedia();

/**
 * The browser's header is a promise about MOVEMENT: whatever the counts do, the
 * list under them stays where it is. Background work is the case that motivated
 * it — it starts and ends with no act of the user behind it, several times a
 * minute — so the tests measure the DOM between the top of the browser and its
 * first card, and require it to be identical either way.
 */
describe("SessionInbox bar", () => {
  const NOW = 1_800_000_000_000;

  let view: Mounted | null = null;

  afterEach(() => {
    view = null;
    vi.useRealTimers();
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

  function render(
    sessions: SessionListItem[],
    onOpenBackgroundTasks: () => void = () => {},
  ) {
    view ??= mount();
    act(() => {
      view!.root.render(
        <SessionInbox
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
        />,
      );
    });
  }

  /** A chip by the words it states; both shapes of chip carry them as `title`. */
  function chip(label: string): HTMLElement {
    const found = view!.container.querySelector<HTMLElement>(
      `[title="${label}"]`,
    );
    if (!found) throw new Error(`no chip “${label}”`);
    return found;
  }

  /**
   * The SHAPE of everything the browser draws above its first card: every element
   * in order, without the text or the tone classes that carry no layout. What may
   * not change is the BOX — an element appearing, leaving or changing kind is a
   * row of boxes of a different size, and that is what shoves the list.
   */
  function headerShape(): string {
    const card = view!.container.querySelector("[data-inbox-card]");
    if (!card) throw new Error("no card to measure against");
    const parts: string[] = [];
    for (const node of view!.container.firstElementChild?.children ?? []) {
      if (node.contains(card)) break;
      for (const element of [node, ...node.querySelectorAll("*")])
        parts.push(element.tagName);
    }
    return parts.join("|");
  }

  it("states all three counts on a browser with nothing in it", () => {
    render([]);
    expect(chip("Nothing is waiting for you")).toBeTruthy();
    expect(chip("No sessions are running")).toBeTruthy();
    expect(chip("No background processes running")).toBeTruthy();
    // The cold-start message is INSIDE the browser rather than instead of it.
    expect(view!.container.textContent).toContain("No sessions yet");
  });

  it("does not move the list when background work starts and stops", () => {
    render([session("a")]);
    const before = headerShape();
    render([
      session("a", {
        backgroundActivity: { activeCount: 2, retainedHost: true },
      } as Partial<SessionListItem>),
    ]);
    expect(chip("2 background processes running")).toBeTruthy();
    // The count changed; the box it is stated in did not.
    expect(headerShape()).toBe(before);
    render([session("a")]);
    expect(headerShape()).toBe(before);
  });

  it("owns the Needs you count, leaving the block its label alone", () => {
    render([session("a", { attention: "question" })]);
    expect(chip("1 session is waiting for you")).toBeTruthy();
    expect(
      view!.container.querySelector("#session-inbox-needs-you")?.textContent,
    ).toBe("Needs you");
  });

  it("counts a running turn once, under the state that outranks it", () => {
    render([session("a", { isStreaming: true }), session("b")]);
    expect(chip("1 session running")).toBeTruthy();
    // Streaming AND waiting on the user is ONE session that needs you, not a
    // session that needs you plus a session that is working.
    render([session("a", { isStreaming: true, attention: "approval" })]);
    expect(chip("No sessions are running")).toBeTruthy();
    expect(chip("1 session is waiting for you")).toBeTruthy();
  });

  it("opens the background registry from the bar, with or without work", () => {
    const opened: number[] = [];
    render([session("a")], () => opened.push(1));
    act(() => {
      chip("No background processes running").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(opened).toHaveLength(1);
  });

  it("moves to the first waiting row from the bar", () => {
    render([session("a"), session("b", { attention: "question" })]);
    act(() => {
      chip("1 session is waiting for you").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.listRowId,
    ).toBe("b");
  });
});

/**
 * A coordinator and the peers it still owns are ONE row of this browser. What
 * these tests hold is the other half of that promise: every folded peer stays a
 * real row — openable, focusable, swipeable — the moment the fold is opened, by
 * the user or by a search that matched inside it.
 */
describe("SessionInbox clusters", () => {
  const NOW = 1_800_000_000_000;

  let view: Mounted | null = null;

  afterEach(() => {
    view = null;
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.useRealTimers();
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

  /** A coordinator-owned peer of `parent` — the only shape the inbox folds. */
  function peer(
    id: string,
    parent: string,
    extra: Partial<SessionListItem> = {},
  ): SessionListItem {
    return session(id, {
      spawnedBySessionId: parent,
      spawnOwnership: "coordinator",
      ...extra,
    });
  }

  interface Handlers {
    onSelect?: (id: string) => void;
    onSettle?: (id: string, settled: boolean) => void;
    /** The real preference: a settle then leaves through its exit before it sends. */
    animate?: boolean;
  }

  function render(sessions: SessionListItem[], handlers: Handlers = {}) {
    view ??= mount();
    act(() => {
      view!.root.render(
        <SessionInbox
          sessions={sessions}
          archivedSessionCount={0}
          archivedSessionsLoaded
          onOpenBackgroundTasks={() => {}}
          currentId={undefined}
          readCurrentId={undefined}
          projects={[]}
          worktrees={[]}
          tasks={[]}
          workflowRuns={[]}
          workflowCards={{}}
          worktreeStatuses={{}}
          animateListChanges={handlers.animate ?? false}
          density="tight"
          onSelect={handlers.onSelect ?? (() => {})}
          onSettle={handlers.onSettle ?? (() => {})}
          onArchive={() => {}}
          onDeleteSession={() => {}}
          onRenameSession={() => {}}
          onLoadArchivedSessions={() => {}}
          onOpenProject={() => {}}
          onOpenTask={() => {}}
          onOpenWorkflowRun={() => {}}
          onSettleWorkflowRun={() => {}}
          onOpenWorktree={() => {}}
        />,
      );
    });
  }

  function rowIds(): string[] {
    return [
      ...view!.container.querySelectorAll<HTMLElement>("[data-list-row-id]"),
    ].map((row) => row.dataset.listRowId as string);
  }

  function row(id: string): HTMLElement {
    const found = view!.container.querySelector<HTMLElement>(
      `[data-list-row-id="${id}"]`,
    );
    if (!found) throw new Error(`no row ${id}`);
    return found;
  }

  function click(element: HTMLElement) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function button(label: string): HTMLElement {
    const found = [
      ...view!.container.querySelectorAll<HTMLElement>("button"),
    ].find(
      (node) =>
        node.getAttribute("aria-label") === label ||
        node.getAttribute("title") === label,
    );
    if (!found) throw new Error(`no button “${label}”`);
    return found;
  }

  /** jsdom ships no `PointerEvent`; React reads the fields off the native event. */
  function pointer(type: string, x: number): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType: "touch",
      clientX: x,
      clientY: 40,
    });
    return event;
  }

  function swipeRight(id: string) {
    const host = row(id).closest<HTMLElement>(".touch-pan-y");
    if (!host) throw new Error(`no swipe host for ${id}`);
    act(() => {
      host.dispatchEvent(pointer("pointerdown", 300));
      host.dispatchEvent(pointer("pointermove", 440));
      host.dispatchEvent(pointer("pointerup", 440));
    });
    // The exit `SwipeRow` plays before its `onExited`: slide, then close.
    act(() => void vi.advanceTimersByTime(160));
    act(() => void vi.advanceTimersByTime(180));
  }

  it("spends one item on a coordinator and the peers it owns", () => {
    render([session("root"), peer("a", "root"), peer("b", "root")]);
    expect(view!.container.querySelectorAll("[data-inbox-card]")).toHaveLength(
      1,
    );
    expect(rowIds()).toEqual(["root"]);
  });

  it("shows every folded peer inside the card's shared boundary", () => {
    render([session("root"), peer("a", "root"), peer("b", "root")]);
    click(button("Show the 2 coordinated sessions"));
    expect(rowIds()).toEqual(["root", "a", "b"]);
    // Still ONE item: the peers are rows inside it, not cards beside it.
    const item = view!.container.querySelector<HTMLElement>(
      '[data-inbox-card="root"]',
    );
    expect(view!.container.querySelectorAll("[data-inbox-card]")).toHaveLength(
      1,
    );
    const boundary = [
      ...(item?.querySelectorAll<HTMLElement>("div") ?? []),
    ].find((node) => node.classList.contains("border-b"));
    expect(boundary?.contains(row("root"))).toBe(true);
    expect(boundary?.contains(row("a"))).toBe(true);
    expect(boundary?.contains(row("b"))).toBe(true);
    click(button("Hide the 2 coordinated sessions"));
    expect(rowIds()).toEqual(["root"]);
  });

  it("keeps the disclosure honest about what the click will do", () => {
    render([
      session("root", { title: "coordinator" }),
      peer("kid", "root", { title: "reviewer peer" }),
      peer("other-peer", "root", { title: "implementer peer" }),
    ]);
    // The disclosure is the ONLY way a folded peer is listed, so its label is
    // the whole promise: closed, it offers every peer; open, it hides them all.
    expect(rowIds()).toEqual(["root"]);
    click(button("Show the 2 coordinated sessions"));
    expect(rowIds()).toEqual(["root", "kid", "other-peer"]);
    click(button("Hide the 2 coordinated sessions"));
    expect(rowIds()).toEqual(["root"]);
  });

  it("walks the keyboard through a cluster's rows", () => {
    render([session("root"), peer("a", "root"), peer("b", "root")]);
    click(button("Show the 2 coordinated sessions"));
    act(() => row("root").focus());
    act(() => {
      row("root").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(row("a"));
    act(() => {
      row("a").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(row("b"));
  });

  it("opens a peer from its own row, and from the card that names it", () => {
    const opened: string[] = [];
    render([session("root"), peer("kid", "root", { attention: "question" })], {
      onSelect: (id) => void opened.push(id),
    });
    // One action from the collapsed cluster: the bubbled peer is named on the
    // card and is its own target.
    click(button("Open “Session kid”"));
    expect(opened).toEqual(["kid"]);
    click(button("Show the 1 coordinated session"));
    click(row("kid"));
    expect(opened).toEqual(["kid", "kid"]);
  });

  it("settles the peer that was swiped, not the coordinator", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render([session("root"), peer("kid", "root")], {
      onSettle: (id, value) => void settled.push([id, value]),
    });
    click(button("Show the 1 coordinated session"));
    swipeRight("kid");
    expect(settled).toEqual([["kid", true]]);
  });

  it("dismisses a peer's failure from the collapsed card, keeping the coordinator", () => {
    const settled: Array<[string, boolean]> = [];
    const rows = [
      session("root"),
      peer("kid", "root", { lastError: { at: NOW - 1_000, message: "boom" } }),
    ];
    render(rows, { onSettle: (id, value) => void settled.push([id, value]) });
    // The failure never blocks the coordinator's own Settle: that settles the
    // peer with it, acknowledging the failure.
    expect(
      button("Settle — move out of the working set").hasAttribute("disabled"),
    ).toBe(false);
    // Dismissing is the PEER's settle alone, sent from the card the failure is
    // shown on — the cluster is collapsed, and the peer never had a row to aim
    // at — and the coordinator stays where it is.
    expect(rowIds()).toEqual(["root"]);
    click(button("Dismiss the failure in “Session kid”"));
    expect(settled).toEqual([["kid", true]]);
    render(
      rows.map((row) => (row.id === "kid" ? { ...row, settledAt: NOW } : row)),
      { onSettle: (id, value) => void settled.push([id, value]) },
    );
    expect(rowIds()).toEqual(["root"]);
  });

  it("dismisses through the settle exit, and sends the peer's id after it", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render(
      [
        session("root"),
        peer("kid", "root", {
          lastError: { at: NOW - 1_000, message: "boom" },
        }),
      ],
      {
        animate: true,
        onSettle: (id, value) => void settled.push([id, value]),
      },
    );
    // The real preference: dismissing takes the same exit every settle in this
    // list takes — the peer's own row plays it when the cluster is open, and a
    // collapsed cluster simply has none to play. Either way the command is the
    // PEER's, and it is sent once, when the exit is over.
    click(button("Dismiss the failure in “Session kid”"));
    expect(settled).toEqual([]);
    act(() => void vi.advanceTimersByTime(400));
    expect(settled).toEqual([["kid", true]]);
  });

  it("refuses to settle a cluster whose peer is still waiting for an answer", () => {
    render([session("root"), peer("kid", "root", { attention: "question" })]);
    const settle = button("Cannot settle: it is waiting for your answer.");
    expect(settle.hasAttribute("disabled")).toBe(true);
  });
});

/**
 * Density is the host's decision, and the browser has to pass it to EVERY row it
 * lays out: a phone whose cards grew thumb targets while its shelf rows and
 * folded peers stayed at rail size would be exactly the drift a single prop
 * exists to prevent. The tests render the same list at both densities and read
 * the size classes off each kind of row, so a row that stops taking the prop
 * fails here rather than on a phone.
 */
describe("SessionInbox density", () => {
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

  /** One card with a folded peer, one settled session, and an archived count. */
  function render(density: RowDensity) {
    view ??= mount();
    act(() => {
      view!.root.render(
        <SessionInbox
          sessions={[
            session("root"),
            session("kid", {
              spawnedBySessionId: "root",
              spawnOwnership: "coordinator",
            }),
            session("done", { settledAt: NOW - 1_000 }),
          ]}
          archivedSessionCount={3}
          archivedSessionsLoaded
          currentId={undefined}
          readCurrentId={undefined}
          projects={[]}
          worktrees={[]}
          tasks={[]}
          workflowRuns={[]}
          workflowCards={{}}
          worktreeStatuses={{}}
          animateListChanges={false}
          density={density}
          onSelect={() => {}}
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
          onOpenWorktree={() => {}}
        />,
      );
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = [...view!.container.querySelectorAll("button")].find(
      (node) =>
        node.getAttribute("aria-label") === label ||
        node.getAttribute("title") === label ||
        node.textContent === label,
    );
    if (!found) throw new Error(`no button “${label}”`);
    return found;
  }

  function row(id: string): HTMLElement {
    const found = view!.container.querySelector<HTMLElement>(
      `[data-list-row-id="${id}"]`,
    );
    if (!found) throw new Error(`no row ${id}`);
    return found;
  }

  /** Open the fold and the shelf, so every kind of row is on screen. */
  function openEverything() {
    act(() => button("Show the 1 coordinated session").click());
    act(() => button("Settled").click());
  }

  it("keeps primary rows thumb-sized while folded peers stay compact", () => {
    render("comfortable");
    openEverything();
    // The status row's inline Settle and actions flip.
    expect(button("Settle — move out of the working set").className).toContain(
      "size-8",
    );
    expect(button("Session actions").className).toContain("size-8");
    // Folded peers are subordinate one-line rows, not another stack of cards.
    expect(row("kid").className).toContain("min-h-8");
    expect(row("kid").className).not.toContain("min-h-11");
    // A shelf row and its one action.
    expect(row("done").className).toContain("h-11");
    expect(button("Bring back into the working set").className).toContain(
      "size-9",
    );
    // The shelf disclosures themselves.
    expect(button("Settled").className).toContain("min-h-11");
    expect(button("Archived").className).toContain("min-h-11");
  });

  it("keeps the rail's tight rows when the host says so", () => {
    render("tight");
    openEverything();
    expect(button("Settle — move out of the working set").className).toContain(
      "size-6",
    );
    expect(row("kid").className).toContain("min-h-7");
    expect(row("done").className).toContain("h-7");
    expect(button("Bring back into the working set").className).toContain(
      "size-5",
    );
    expect(view!.container.innerHTML).not.toContain("min-h-11");
  });

  it("heads both shelves without a count", () => {
    render("tight");
    // The size of the history is not a decision, so neither heading states it;
    // the settled shelf's paging says how much more there is once it is open.
    expect(button("Settled").textContent).toBe("Settled");
    expect(button("Archived").textContent).toBe("Archived");
  });
});

/**
 * The Sessions inbox carries an action on each side of a card: a RIGHTWARD pull
 * settles, a LEFTWARD one archives. What these are about is the ORDER — the
 * card has to finish leaving before the command goes, because the command is
 * what removes it from the list, and a list update mid-flight would cut the
 * animation the gesture is made of.
 */
describe("SessionInbox swipe", () => {
  const NOW = 1_800_000_000_000;

  let view: Mounted | null = null;

  afterEach(() => {
    view = null;
    // The toast store is module state: a receipt left standing would be the one
    // the next test reads with `.at(-1)`.
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.useRealTimers();
  });

  function session(id: string, title = `Session ${id}`): SessionListItem {
    return {
      id,
      harness: "pi",
      agentType: "assistant",
      title,
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 60_000,
      messageCount: 2,
    } as SessionListItem;
  }

  interface Handlers {
    onSettle?: (id: string, settled: boolean) => void;
    onArchive?: (id: string, archived: boolean) => void;
  }

  function render(sessions: SessionListItem[], handlers: Handlers = {}) {
    view ??= mount();
    act(() => {
      view!.root.render(
        <SessionInbox
          sessions={sessions}
          archivedSessionCount={0}
          archivedSessionsLoaded
          onOpenBackgroundTasks={() => {}}
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
          onSettle={handlers.onSettle ?? (() => {})}
          onArchive={handlers.onArchive ?? (() => {})}
          onDeleteSession={() => {}}
          onRenameSession={() => {}}
          onLoadArchivedSessions={() => {}}
          onOpenProject={() => {}}
          onOpenTask={() => {}}
          onOpenWorkflowRun={() => {}}
          onSettleWorkflowRun={() => {}}
          onOpenWorktree={() => {}}
        />,
      );
    });
  }

  /** jsdom ships no `PointerEvent`; React reads the fields off the native event. */
  function pointer(type: string, x: number): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType: "touch",
      clientX: x,
      clientY: 40,
    });
    return event;
  }

  /** The swipe surface wrapping a card: `SwipeRow`'s own host. */
  function swipeHost(id: string): HTMLElement {
    const card = view!.container.querySelector<HTMLElement>(
      `[data-inbox-card="${id}"]`,
    );
    if (!card) throw new Error(`no card ${id}`);
    const host = card.querySelector<HTMLElement>(".touch-pan-y");
    if (!host) throw new Error(`no swipe host for ${id}`);
    return host;
  }

  /** A committed swipe: rightward settles, leftward archives. */
  function swipe(id: string, direction: "left" | "right") {
    const host = swipeHost(id);
    const to = direction === "left" ? 160 : 440;
    act(() => {
      host.dispatchEvent(pointer("pointerdown", 300));
      host.dispatchEvent(pointer("pointermove", to));
      host.dispatchEvent(pointer("pointerup", to));
    });
  }

  /** The exit `SwipeRow` plays before its `onExited`: slide, then close. */
  function finishExit() {
    act(() => {
      vi.advanceTimersByTime(160);
    });
    act(() => {
      vi.advanceTimersByTime(180);
    });
  }

  it("settles on a rightward swipe, once the card has finished leaving", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render([session("a"), session("b")], {
      onSettle: (id, value) => void settled.push([id, value]),
    });

    swipe("a", "right");
    // Not yet: the command is what removes the card, and sending it here would
    // unmount the row in the middle of its own exit.
    expect(settled).toEqual([]);

    finishExit();
    expect(settled).toEqual([["a", true]]);
  });

  it("archives on a leftward swipe", () => {
    vi.useFakeTimers();
    const archived: Array<[string, boolean]> = [];
    render([session("a")], {
      onArchive: (id, value) => void archived.push([id, value]),
    });

    swipe("a", "left");
    expect(archived).toEqual([]);

    finishExit();
    expect(archived).toEqual([["a", true]]);
  });

  it("offers Undo on the receipt, and the Undo reverses it", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render([session("a", "Fix the parser")], {
      onSettle: (id, value) => void settled.push([id, value]),
    });

    swipe("a", "right");
    finishExit();

    // The receipt names the card that left, since by now it is gone from view.
    const toast = getToasts().at(-1);
    expect(toast?.message).toContain("Fix the parser");
    expect(toast?.action?.label).toBe("Undo");

    act(() => toast!.action!.onClick());
    expect(settled).toEqual([
      ["a", true],
      ["a", false],
    ]);
  });

  it("names the archive it undoes, not the settle", () => {
    vi.useFakeTimers();
    const archived: Array<[string, boolean]> = [];
    render([session("a")], {
      onArchive: (id, value) => void archived.push([id, value]),
    });

    swipe("a", "left");
    finishExit();

    const toast = getToasts().at(-1);
    expect(toast?.message).toContain("Archived");
    act(() => toast!.action!.onClick());
    expect(archived).toEqual([
      ["a", true],
      ["a", false],
    ]);
  });

  it("acts on the card that was swiped, not on the list", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render([session("a"), session("b"), session("c")], {
      onSettle: (id, value) => void settled.push([id, value]),
    });

    swipe("b", "right");
    finishExit();
    expect(settled).toEqual([["b", true]]);
  });

  it("offers no Settle side on a card that cannot be settled", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    const archived: Array<[string, boolean]> = [];
    // Streaming blocks settling — the same predicate `s` and the gutter button
    // disable themselves on, and the one the SERVER refuses the command with.
    // A swipe that offered it anyway would slide the card away and have the
    // row roll back underneath the receipt.
    render([{ ...session("a"), isStreaming: true } as SessionListItem], {
      onSettle: (id, value) => void settled.push([id, value]),
      onArchive: (id, value) => void archived.push([id, value]),
    });

    swipe("a", "right");
    finishExit();
    expect(settled).toEqual([]);

    // The other side is untouched: archive is always available.
    swipe("a", "left");
    finishExit();
    expect(archived).toEqual([["a", true]]);
  });

  it("still sends the command when the card changes tier mid-exit", () => {
    vi.useFakeTimers();
    const archived: Array<[string, boolean]> = [];
    const handlers = {
      onArchive: (id: string, value: boolean) =>
        void archived.push([id, value]),
    };
    // "Needs you" and the working set are separate parents, so a session that
    // stops waiting on the user while its card is leaving REMOUNTS the row —
    // and the `SwipeRow` that was going to report the exit is gone with it.
    const waiting = {
      ...session("a"),
      attention: "question",
    } as SessionListItem;
    render([waiting, session("b")], handlers);

    swipe("a", "left");
    // The agent answers mid-exit and the card moves to the other section.
    render([session("a"), session("b")], handlers);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // The gesture was made; the command must not be lost with the component.
    expect(archived).toEqual([["a", true]]);
  });

  it("sends a pending command exactly once when the exit does report", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    render([session("a")], {
      onSettle: (id, value) => void settled.push([id, value]),
    });

    swipe("a", "right");
    finishExit();
    // Past the backstop deadline too: whichever ending arrives first wins, and
    // the other must find nothing left to send.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(settled).toEqual([["a", true]]);
  });

  it("sends nothing when the swipe falls short of the threshold", () => {
    vi.useFakeTimers();
    const settled: Array<[string, boolean]> = [];
    const archived: Array<[string, boolean]> = [];
    render([session("a")], {
      onSettle: (id, value) => void settled.push([id, value]),
      onArchive: (id, value) => void archived.push([id, value]),
    });

    const host = swipeHost("a");
    act(() => {
      host.dispatchEvent(pointer("pointerdown", 300));
      // Engaged, but well short of the commit distance, and slowly enough that
      // the release is not a flick either (jsdom stamps every event 0).
      host.dispatchEvent(pointer("pointermove", 330));
      host.dispatchEvent(pointer("pointerup", 330));
    });
    finishExit();
    expect(settled).toEqual([]);
    expect(archived).toEqual([]);
  });
});

/**
 * A live Workflow Run is ONE item of this browser ([Task-676](pa://task/676)),
 * and what these tests hold is the other half of that promise: the run leads to
 * itself on its Task, and every session it folded away is still a real row —
 * findable, focusable and openable — rather than a session that disappeared.
 */
describe("SessionInbox Workflow Run items", () => {
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

  const run: WorkflowRunSummary = {
    id: "r1",
    taskId: "676",
    recipeId: "code-delivery",
    recipeVersion: 1,
    lifecycle: "active",
    limits: { maxIterations: 3, maxReviewPasses: 2 },
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 30_000,
  };

  const card: WorkflowRunCard = {
    runId: "r1",
    phase: "review",
    activity: "running",
    iterationsUsed: 1,
    nextAction: "Start the second review pass.",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: true,
    coordinatorSessionId: "coord",
    implementerSessionId: "impl",
    reviewerSessions: [{ pass: 1, sessionId: "rev-1" }],
  };

  const task = {
    id: "676",
    title: "Surface live Workflow Runs",
    status: "doing",
    createdAt: 1,
    updatedAt: 2,
  } as TaskSummary;

  const roleSessions = [
    session("coord", { title: "Coordination" }),
    session("impl", { title: "Implementation", isStreaming: true }),
    session("rev-1", { title: "First review pass" }),
  ];

  interface Handlers {
    onSelect?: (id: string) => void;
    onOpenWorkflowRun?: (taskId: string, runId: string) => void;
    onSettleWorkflowRun?: (runId: string, throughRevision: number) => void;
  }

  function render(
    sessions: SessionListItem[],
    runs: WorkflowRunSummary[],
    cards: Record<string, WorkflowRunCard>,
    handlers: Handlers = {},
  ) {
    view ??= mount();
    act(() => {
      view!.root.render(
        <SessionInbox
          sessions={sessions}
          archivedSessionCount={0}
          archivedSessionsLoaded
          onOpenBackgroundTasks={() => {}}
          currentId={undefined}
          readCurrentId={undefined}
          projects={[]}
          worktrees={[]}
          tasks={[task]}
          workflowRuns={runs}
          workflowCards={cards}
          worktreeStatuses={{}}
          animateListChanges={false}
          density="tight"
          onSelect={handlers.onSelect ?? (() => {})}
          onSettle={() => {}}
          onArchive={() => {}}
          onDeleteSession={() => {}}
          onRenameSession={() => {}}
          onLoadArchivedSessions={() => {}}
          onOpenProject={() => {}}
          onOpenTask={() => {}}
          onOpenWorkflowRun={handlers.onOpenWorkflowRun ?? (() => {})}
          onSettleWorkflowRun={handlers.onSettleWorkflowRun ?? (() => {})}
          onOpenWorktree={() => {}}
        />,
      );
    });
  }

  function rowIds(): string[] {
    return [
      ...view!.container.querySelectorAll<HTMLElement>("[data-list-row-id]"),
    ].map((element) => element.dataset.listRowId as string);
  }

  function row(id: string): HTMLElement {
    const found = view!.container.querySelector<HTMLElement>(
      `[data-list-row-id="${id}"]`,
    );
    if (!found) throw new Error(`no row ${id}`);
    return found;
  }

  function click(element: HTMLElement) {
    act(() => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function press(element: HTMLElement, key: string) {
    act(() => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  }

  function button(label: string): HTMLElement {
    const found = [
      ...view!.container.querySelectorAll<HTMLElement>("button"),
    ].find(
      (node) =>
        node.getAttribute("aria-label") === label ||
        node.getAttribute("title") === label,
    );
    if (!found) throw new Error(`no button “${label}”`);
    return found;
  }

  /** The run card's spoken label: the state sentence its front leaves out. */
  function runLabel(runId: string): string {
    return (
      view!.container
        .querySelector(`[data-list-row-id="run:${runId}"]`)
        ?.getAttribute("aria-label") ?? ""
    );
  }

  it("spends one item on a run and none on the sessions it owns", () => {
    render(roleSessions, [run], { r1: card });
    expect(view!.container.querySelectorAll("[data-inbox-card]")).toHaveLength(
      1,
    );
    expect(rowIds()).toEqual(["run:r1"]);
    // The run is named by the Task it works on; what it will do next is in
    // its spoken label, and the fold counts its sessions.
    expect(view!.container.textContent).toContain("Surface live Workflow Runs");
    expect(runLabel("r1")).toContain("Start the second review pass.");
    expect(view!.container.textContent).toContain("3 sessions");
  });

  it("names the pull request its owning role session reports", () => {
    const withPr = (state: "pending" | "failure") =>
      roleSessions.map((row) =>
        row.id === "impl"
          ? {
              ...row,
              pullRequest: {
                status: "open" as const,
                number: 9,
                ci: { state, total: 4 },
              },
            }
          : row,
      );
    const prCard: WorkflowRunCard = {
      ...card,
      pullRequest: {
        cardId: "c9",
        sessionId: "impl",
        number: 9,
        url: "https://example.invalid/pr/9",
      },
    };
    render(withPr("pending"), [run], { r1: prCard });
    expect(runLabel("r1")).toContain("pull request:");
    expect(runLabel("r1")).toContain("PR #9");
    const pending = runLabel("r1");
    render(withPr("failure"), [run], { r1: prCard });
    expect(runLabel("r1")).not.toBe(pending);
  });

  it("opens the exact run on its Task", () => {
    const opened: Array<[string, string]> = [];
    render(
      roleSessions,
      [run],
      { r1: card },
      {
        onOpenWorkflowRun: (taskId, runId) => opened.push([taskId, runId]),
      },
    );
    click(row("run:r1"));
    press(row("run:r1"), "Enter");
    expect(opened).toEqual([
      ["676", "r1"],
      ["676", "r1"],
    ]);
  });

  it("lists every role session once the run is opened, and traverses them", () => {
    render(roleSessions, [run], { r1: card });
    click(button("Show the 3 workflow sessions"));
    expect(rowIds()).toEqual(["run:r1", "impl", "coord", "rev-1"]);
    // Still ONE item: the sessions are rows inside it, not cards beside it.
    expect(view!.container.querySelectorAll("[data-inbox-card]")).toHaveLength(
      1,
    );

    row("run:r1").focus();
    press(row("run:r1"), "ArrowDown");
    expect(document.activeElement).toBe(row("impl"));
    press(row("impl"), "ArrowUp");
    expect(document.activeElement).toBe(row("run:r1"));

    click(button("Hide the 3 workflow sessions"));
    expect(rowIds()).toEqual(["run:r1"]);
  });

  it("opens a role session directly from the row the disclosure lists", () => {
    const opened: string[] = [];
    render(
      roleSessions,
      [run],
      { r1: card },
      {
        onSelect: (id) => opened.push(id),
      },
    );
    click(button("Show the 3 workflow sessions"));
    expect(row("rev-1").getAttribute("aria-label")).toContain(
      "Open workflow Assistant session",
    );
    click(row("rev-1"));
    expect(opened).toEqual(["rev-1"]);
  });

  it("keeps every session a card of its own when the run has no projection", () => {
    render(roleSessions, [run], {});
    expect(rowIds()).toEqual(["run:r1", "impl", "coord", "rev-1"]);
    expect(view!.container.querySelectorAll("[data-inbox-card]")).toHaveLength(
      4,
    );
  });

  it("shows a run that owns no listed session at all", () => {
    // A run in `starting`, or one whose projection this browser cannot read,
    // has no session of its own here. The cold-start box would otherwise claim
    // there is no agent work while the run is moving.
    render([], [run], { r1: card });
    expect(view!.container.textContent).not.toContain("No sessions yet");
    expect(rowIds()).toEqual(["run:r1"]);
    expect(view!.container.textContent).toContain("Surface live Workflow Runs");
  });

  /* ------------- across the terminal boundary ([Task-677]) ------------- */

  const ended: WorkflowRunSummary = {
    ...run,
    lifecycle: "completed",
    endedAt: NOW - 10_000,
    attention: {
      revision: 2,
      settledRevision: 1,
      kind: "completed",
      at: NOW - 10_000,
    },
  };

  it("keeps a completed run as one Needs-you item, folds its roles, and settles it in one click", () => {
    const settled: string[] = [];
    render(
      roleSessions.map((s) => ({
        ...s,
        isStreaming: false,
        outcomeAttention: {
          revision: 1,
          settledRevision: 0,
          kind: "completed" as const,
          at: NOW - 20_000,
        },
      })),
      [ended],
      { r1: card },
      { onSettleWorkflowRun: (runId) => settled.push(runId) },
    );
    expect(
      view!.container.querySelector("#session-inbox-needs-you")?.textContent,
    ).toBe("Needs you");
    expect(rowIds()).toEqual(["run:r1"]);
    expect(runLabel("r1")).toContain("Run complete.");

    click(button("Settle — acknowledge the run and put its sessions down"));
    expect(settled).toEqual(["r1"]);
  });

  /** The roles once the run has ended: nothing running. */
  const idleRoles = roleSessions.map((s) => ({ ...s, isStreaming: false }));

  it("settles the focused run from the keyboard, with the revision it rendered", () => {
    const settled: Array<[string, number]> = [];
    render(
      idleRoles,
      [ended],
      { r1: card },
      {
        onSettleWorkflowRun: (runId, revision) =>
          settled.push([runId, revision]),
      },
    );
    press(row("run:r1"), "s");
    expect(settled).toEqual([["r1", 2]]);
  });

  it("disables Settle while a role session is still running, in that role's words", () => {
    render(roleSessions, [ended], { r1: card });
    const settle = button("Cannot settle: it is still running.");
    expect((settle as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Settle at an unresolved user decision and says why", () => {
    const settled: string[] = [];
    render(
      idleRoles,
      [
        {
          ...run,
          lifecycle: "paused",
          lifecycleReason: "Decide how the run should end.",
          attention: {
            revision: 1,
            settledRevision: 0,
            kind: "paused",
            at: NOW - 10_000,
          },
        },
      ],
      {
        r1: {
          ...card,
          phase: "ceiling-decision",
          ceilingDecision: {
            blocked: "review-passes",
            wanted: "another review pass",
            allowedChoices: ["raise", "cancel"],
            ceilings: { maxIterations: 3, maxReviewPasses: 2 },
            spent: { iterations: 1, reviewPasses: 2, sessions: 3 },
            headCarriesDiscoveryReview: false,
            suggestedRaise: 2,
          },
        },
      },
      { onSettleWorkflowRun: (runId) => settled.push(runId) },
    );
    const settle = button(
      "Cannot settle: it is waiting for your decision at its ceiling.",
    );
    expect((settle as HTMLButtonElement).disabled).toBe(true);
    expect(row("run:r1").getAttribute("aria-label")).toContain(
      "Cannot settle: it is waiting for your decision at its ceiling.",
    );
    press(row("run:r1"), "s");
    expect(settled).toEqual([]);
  });

  it("offers no Settle on a live run with nothing to acknowledge, and none once settled", () => {
    render(roleSessions, [run], { r1: card });
    expect(
      [...view!.container.querySelectorAll("button")].some((node) =>
        node.getAttribute("aria-label")?.startsWith("Settle"),
      ),
    ).toBe(false);

    render(
      roleSessions,
      [{ ...ended, attention: { ...ended.attention!, settledRevision: 2 } }],
      { r1: card },
    );
    // Released: the run is gone and its three sessions are rows of their own.
    expect(rowIds().sort()).toEqual(["coord", "impl", "rev-1"]);
  });

  it("puts a paused run under Needs you with its reason", () => {
    render(
      roleSessions,
      [
        {
          ...run,
          lifecycle: "paused",
          lifecycleReason: "Waiting for your merge decision.",
        },
      ],
      { r1: card },
    );
    const heading = view!.container.querySelector("#session-inbox-needs-you");
    expect(heading?.textContent).toBe("Needs you");
    expect(runLabel("r1")).toContain("Waiting for your merge decision.");
  });
});
