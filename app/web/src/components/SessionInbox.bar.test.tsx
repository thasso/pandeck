// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { SessionInbox } from "./SessionInbox.tsx";

/**
 * The browser's header is a promise about MOVEMENT: whatever the counts do, the
 * list under them stays where it is. Background work is the case that motivated
 * it — it starts and ends with no act of the user behind it, several times a
 * minute — so the tests measure the DOM between the top of the browser and its
 * first card, and require it to be identical either way.
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
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
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
  const found = container!.querySelector<HTMLElement>(`[title="${label}"]`);
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
  const card = container!.querySelector("[data-inbox-card]");
  if (!card) throw new Error("no card to measure against");
  const parts: string[] = [];
  for (const node of container!.firstElementChild?.children ?? []) {
    if (node.contains(card)) break;
    for (const element of [node, ...node.querySelectorAll("*")])
      parts.push(element.tagName);
  }
  return parts.join("|");
}

describe("SessionInbox bar", () => {
  it("states all three counts on a browser with nothing in it", () => {
    render([]);
    expect(chip("Nothing is waiting for you")).toBeTruthy();
    expect(chip("No sessions are running")).toBeTruthy();
    expect(chip("No background processes running")).toBeTruthy();
    // The cold-start message is INSIDE the browser rather than instead of it.
    expect(container!.textContent).toContain("No sessions yet");
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
      container!.querySelector("#session-inbox-needs-you")?.textContent,
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
