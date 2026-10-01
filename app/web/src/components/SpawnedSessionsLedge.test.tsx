// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SessionListItem } from "@assistant/shared";
import { SpawnedSessionsLedge } from "./SpawnedSessionsLedge.tsx";
import { spawnedSessionsView } from "../lib/sessionInbox.ts";

/**
 * The composer's second strip: what this chat spawned, and every peer one click
 * away. It holds the promise the fold in the Sessions inbox makes — a summary
 * may hide how much is running, never what needs answering — on the surface the
 * user is actually typing into.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

// The strip owns its ticker (`useElapsedNow`), so the clock is pinned here.
beforeAll(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterAll(() => {
  vi.restoreAllMocks();
});

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
    spawnedBySessionId: "root",
    spawnOwnership: "coordinator",
    ...extra,
  } as SessionListItem;
}

function ledge(
  sessions: SessionListItem[],
  over: {
    open?: boolean;
    onOpenSession?: (id: string) => void;
    onShowAll?: () => void;
    onSettleSession?: (id: string, settled: boolean) => void;
    limit?: number;
  } = {},
) {
  return (
    <SpawnedSessionsLedge
      sessionId="root"
      view={spawnedSessionsView({
        sessions,
        coordinatorId: "root",
        ...(over.limit === undefined ? {} : { limit: over.limit }),
      })}
      open={over.open ?? false}
      onToggle={() => {}}
      onOpenSession={over.onOpenSession ?? (() => {})}
      onShowAll={over.onShowAll ?? (() => {})}
      onSettleSession={over.onSettleSession ?? (() => {})}
    />
  );
}

describe("the composer's spawned-session ledge", () => {
  it("rests as one line that states what this chat is coordinating", () => {
    const markup = renderToStaticMarkup(
      ledge([
        session("a", { isStreaming: true, runStartedAt: NOW - 12_000 }),
        session("b"),
      ]),
    );
    expect(markup).toContain("2 sessions · 1 working");
    // The line carries no verb, exactly as the cluster card's does not; the
    // spoken label is where "coordinates" survives, since this strip has no
    // card title above it to say whose sessions these are.
    expect(markup).not.toContain(">Coordinating");
    // "spawned", not "coordinated": the projection keeps a peer the user has
    // taken over, and the label may not claim a relation that has ended.
    expect(markup).toContain(
      "Show the sessions this chat spawned — 2 sessions · 1 working",
    );
    expect(markup).toContain('aria-expanded="false"');
    // Collapsed is a summary, not a list.
    expect(markup).not.toContain("Session a");
  });

  it("shows peers at work as motion in the accent, not as a count alone", () => {
    const working = renderToStaticMarkup(
      ledge([session("a", { isStreaming: true })]),
    );
    // The session you are typing into is usually quiet while its peers run, so
    // this strip is the only place that run is visible.
    expect(working).toContain("animate-spin");
    expect(working).toContain("text-accent hover:text-accent");
    const idle = renderToStaticMarkup(ledge([session("a")]));
    expect(idle).not.toContain("animate-spin");
    expect(idle).toContain("text-muted hover:text-fg");
  });

  it("offers to dismiss a bubbled peer failure, and settles that peer", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const settled: Array<[string, boolean]> = [];
    act(() => {
      root?.render(
        ledge(
          [
            session("kid", {
              title: "Implementer",
              lastError: { at: NOW - 1_000, message: "boom" },
            }),
          ],
          { onSettleSession: (id, value) => void settled.push([id, value]) },
        ),
      );
    });
    const dismiss = container.querySelector<HTMLElement>(
      '[aria-label="Dismiss the failure in “Implementer”"]',
    );
    expect(dismiss?.getAttribute("title")).toBe(
      "Dismiss — settle “Implementer”",
    );
    act(() => dismiss?.click());
    expect(settled).toEqual([["kid", true]]);
  });

  it("never offers to dismiss a peer that is waiting on the user", () => {
    const markup = renderToStaticMarkup(
      ledge([session("asks", { title: "Reviewer", attention: "question" })]),
    );
    // Answering is the only way through a question.
    expect(markup).toContain("Answer in “Reviewer”");
    expect(markup).not.toContain("Dismiss");
  });

  it("names the peer waiting on the user while it is still collapsed", () => {
    const markup = renderToStaticMarkup(
      ledge([
        session("a", { isStreaming: true }),
        session("asks", { title: "Reviewer", attention: "question" }),
      ]),
    );
    expect(markup).toContain("2 sessions · 1 working · 1 waiting");
    expect(markup).toContain("Answer in “Reviewer”");
  });

  it("opens into one row per peer, each a link to that session", () => {
    const markup = renderToStaticMarkup(
      ledge([session("a"), session("b")], { open: true }),
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Session a");
    expect(markup).toContain("Session b");
    expect(markup).toContain("Open coordinated");
    // The strip owns no lifecycle action; those stay in the Sessions inbox.
    expect(markup).not.toContain("Settle");
    expect(markup).not.toContain("Archive");
  });

  it("opens the peer the row names, and the one it bubbles", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const opened: string[] = [];
    act(() => {
      root?.render(
        ledge([session("a"), session("asks", { attention: "question" })], {
          open: true,
          onOpenSession: (id) => opened.push(id),
        }),
      );
    });
    const rows = [
      ...(container.querySelectorAll<HTMLElement>("[data-session-row]") ?? []),
    ];
    expect(rows).toHaveLength(2);
    // Reachable by keyboard: the ledge has no roving focus above these rows.
    expect(rows[0]?.tabIndex).toBe(0);
    act(() => {
      rows.find((row) => row.dataset.listRowId === "a")?.click();
    });
    const bubble = container.querySelector<HTMLElement>(
      "[data-spawned-sessions-ledge] button:not([aria-expanded])",
    );
    act(() => bubble?.click());
    expect(opened).toEqual(["a", "asks"]);
  });

  it("lists the newest peer first, whatever its state", () => {
    const markup = renderToStaticMarkup(
      ledge(
        [
          session("old-ask", {
            title: "Old question",
            attention: "question",
            updatedAt: NOW - 600_000,
          }),
          session("fresh", { title: "Just finished", updatedAt: NOW - 5_000 }),
        ],
        { open: true },
      ),
    );
    // The rows run by activity, not by tier: the list is a feed of what the
    // peers last did. The question is not lost — it is named on the collapsed
    // line above the rows.
    expect(markup.indexOf('data-list-row-id="fresh"')).toBeLessThan(
      markup.indexOf('data-list-row-id="old-ask"'),
    );
    expect(markup).toContain("Answer in “Old question”");
  });

  it("folds the peers past its cut behind a Show-more under the list", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const many = Array.from({ length: 12 }, (_, index) =>
      session(`peer-${index}`, { updatedAt: NOW - index * 1_000 }),
    );
    act(() => {
      root?.render(ledge(many, { open: true, limit: 10 }));
    });
    expect(container.textContent).toContain("12 sessions");
    expect(container.textContent).not.toContain("Sessions inbox");
    const more = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 2 more"),
    );
    expect(more).toBeDefined();
    // The rows scroll in a capped box; the button sits UNDER that box, never
    // inside it. Ten rows fill the box on a laptop, and a control past the
    // fold is one the user has to know to scroll for. Showing every peer then
    // changes what is in the box, never how tall the composer's shelf is.
    const scrollBox = container.querySelector<HTMLElement>(
      "[data-spawned-sessions-rows]",
    );
    expect(scrollBox?.className).toContain("overflow-y-auto");
    expect(scrollBox?.querySelectorAll("[data-session-row]")).toHaveLength(10);
    expect(more?.closest("[data-spawned-sessions-rows]")).toBeNull();
    expect(scrollBox?.nextElementSibling).toBe(more);
    // And it is part of the region the toggle controls.
    expect(more?.closest("#spawned-sessions-ledge-root")).not.toBeNull();
  });

  it("asks the host for every peer on Show-more, and hides the button once it has them", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const many = Array.from({ length: 12 }, (_, index) =>
      session(`peer-${index}`, { updatedAt: NOW - index * 1_000 }),
    );
    let asked = 0;
    act(() => {
      root?.render(
        ledge(many, {
          open: true,
          limit: 10,
          onShowAll: () => {
            asked++;
          },
        }),
      );
    });
    const more = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 2 more"),
    );
    act(() => more?.click());
    expect(asked).toBe(1);
    // The host answers with an uncut view; nothing is hidden, so no button.
    act(() => {
      root?.render(ledge(many, { open: true }));
    });
    expect(container.querySelectorAll("[data-session-row]")).toHaveLength(12);
    expect(container.textContent).not.toContain("Show 2 more");
  });
});
