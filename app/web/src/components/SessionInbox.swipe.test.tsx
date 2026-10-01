// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { SessionInbox } from "./SessionInbox.tsx";
import { dismissToast, getToasts } from "../lib/toast.ts";

/**
 * The Sessions inbox carries an action on each side of a card: a RIGHTWARD pull
 * settles, a LEFTWARD one archives. What these are about is the ORDER — the
 * card has to finish leaving before the command goes, because the command is
 * what removes it from the list, and a list update mid-flight would cut the
 * animation the gesture is made of.
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
  const card = container!.querySelector<HTMLElement>(
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

describe("SessionInbox swipe", () => {
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
