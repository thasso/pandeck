// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { SessionInbox } from "./SessionInbox.tsx";
import { dismissToast, getToasts } from "../lib/toast.ts";

/**
 * A coordinator and the peers it still owns are ONE row of this browser. What
 * these tests hold is the other half of that promise: every folded peer stays a
 * real row — openable, focusable, swipeable — the moment the fold is opened, by
 * the user or by a search that matched inside it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const NOW = 1_800_000_000_000;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
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
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
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
    ...container!.querySelectorAll<HTMLElement>("[data-list-row-id]"),
  ].map((row) => row.dataset.listRowId as string);
}

function row(id: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(
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
  const found = [...container!.querySelectorAll<HTMLElement>("button")].find(
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

describe("SessionInbox clusters", () => {
  it("spends one item on a coordinator and the peers it owns", () => {
    render([session("root"), peer("a", "root"), peer("b", "root")]);
    expect(container!.querySelectorAll("[data-inbox-card]")).toHaveLength(1);
    expect(rowIds()).toEqual(["root"]);
  });

  it("shows every folded peer inside the card's shared boundary", () => {
    render([session("root"), peer("a", "root"), peer("b", "root")]);
    click(button("Show the 2 coordinated sessions"));
    expect(rowIds()).toEqual(["root", "a", "b"]);
    // Still ONE item: the peers are rows inside it, not cards beside it.
    const item = container!.querySelector<HTMLElement>(
      '[data-inbox-card="root"]',
    );
    expect(container!.querySelectorAll("[data-inbox-card]")).toHaveLength(1);
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
