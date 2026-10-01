// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@assistant/shared";
import type { RowDensity } from "../lib/rowDensity.ts";
import { SessionInbox } from "./SessionInbox.tsx";

/**
 * Density is the host's decision, and the browser has to pass it to EVERY row it
 * lays out: a phone whose cards grew thumb targets while its shelf rows and
 * folded peers stayed at rail size would be exactly the drift a single prop
 * exists to prevent. The tests render the same list at both densities and read
 * the size classes off each kind of row, so a row that stops taking the prop
 * fails here rather than on a phone.
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
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
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
  const found = [...container!.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.getAttribute("title") === label ||
      node.textContent === label,
  );
  if (!found) throw new Error(`no button “${label}”`);
  return found;
}

function row(id: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(
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

describe("SessionInbox density", () => {
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
    expect(container!.innerHTML).not.toContain("min-h-11");
  });

  it("heads both shelves without a count", () => {
    render("tight");
    // The size of the history is not a decision, so neither heading states it;
    // the settled shelf's paging says how much more there is once it is open.
    expect(button("Settled").textContent).toBe("Settled");
    expect(button("Archived").textContent).toBe("Archived");
  });
});
