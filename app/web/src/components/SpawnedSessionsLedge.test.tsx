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
    onToggleSettled?: () => void;
    onDismissSessionFailure?: (id: string) => void;
    includeSettled?: boolean;
  } = {},
) {
  return (
    <SpawnedSessionsLedge
      sessionId="root"
      view={spawnedSessionsView({
        sessions,
        coordinatorId: "root",
        includeSettled: over.includeSettled ?? false,
      })}
      open={over.open ?? false}
      onToggle={() => {}}
      onOpenSession={over.onOpenSession ?? (() => {})}
      onToggleSettled={over.onToggleSettled ?? (() => {})}
      onDismissSessionFailure={over.onDismissSessionFailure ?? (() => {})}
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
    expect(markup).toContain("2 sessions · 1 running");
    // The line carries no verb, exactly as the cluster card's does not; the
    // spoken label is where "coordinates" survives, since this strip has no
    // card title above it to say whose sessions these are.
    expect(markup).not.toContain(">Coordinating");
    // "spawned", not "coordinated": the projection keeps a peer the user has
    // taken over, and the label may not claim a relation that has ended.
    expect(markup).toContain(
      "Show the sessions this chat spawned — 2 sessions · 1 running",
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
    // The spinner carries the accent; the line itself stays muted.
    const accentSpinner = /<svg[^>]*class="[^"]*animate-spin[^"]*text-primary/;
    expect(working).toMatch(accentSpinner);
    const idle = renderToStaticMarkup(ledge([session("a")]));
    expect(idle).not.toContain("animate-spin");
  });

  it("offers to dismiss a bubbled peer failure, even while that peer cannot settle", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const dismissed: string[] = [];
    act(() => {
      root?.render(
        ledge(
          [
            // Queued work blocks the peer's Settle, never the dismissal: the
            // command is the failure's own, not a Settle.
            session("kid", {
              title: "Implementer",
              queuedWork: true,
              lastError: { at: NOW - 1_000, message: "boom" },
            }),
          ],
          { onDismissSessionFailure: (id) => void dismissed.push(id) },
        ),
      );
    });
    const dismiss = container.querySelector<HTMLElement>(
      '[aria-label="Dismiss the failure in “Implementer”"]',
    );
    act(() => dismiss?.click());
    expect(dismissed).toEqual(["kid"]);
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
    expect(markup).toContain("2 sessions · 1 running · 1 waiting");
    expect(markup).toContain("Answer in “Reviewer”");
  });

  it("opens into one row per peer, each a link to that session", () => {
    const markup = renderToStaticMarkup(
      ledge([session("a"), session("b")], { open: true }),
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Session a");
    expect(markup).toContain("Session b");
    // Each row opens its own session; the title itself unfolds the details.
    expect(markup).toContain('aria-label="Open Session a"');
    expect(markup).toContain('aria-label="Open Session b"');
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
      ...(container.querySelectorAll<HTMLElement>("li[data-list-row-id]") ??
        []),
    ];
    expect(rows).toHaveLength(2);
    // Reachable by keyboard: the ledge has no roving focus above these rows.
    expect(
      rows[0]?.querySelector<HTMLButtonElement>('button[title="Open"]')
        ?.tabIndex,
    ).toBe(0);
    act(() => {
      container
        ?.querySelector<HTMLElement>('button[aria-label="Open Session a"]')
        ?.click();
    });
    const bubble = container.querySelector<HTMLElement>(
      '[data-spawned-sessions-ledge] button[title="Open “Session asks”"]',
    );
    act(() => bubble?.click());
    expect(opened).toEqual(["a", "asks"]);
  });

  it("lists the peer waiting on the user first, then the newest created", () => {
    const markup = renderToStaticMarkup(
      ledge(
        [
          session("old", {
            title: "Older",
            createdAt: NOW - 7_200_000,
            updatedAt: NOW - 5_000,
          }),
          session("new", { title: "Newer", createdAt: NOW - 600_000 }),
          session("old-ask", {
            title: "Old question",
            attention: "question",
            createdAt: NOW - 9_000_000,
            updatedAt: NOW - 600_000,
          }),
        ],
        { open: true },
      ),
    );
    // Activity does not move a row — the list holds still while it is read —
    // but a question leads, and is named on the collapsed line as well.
    const order = ["old-ask", "new", "old"].map((id) =>
      markup.indexOf(`data-list-row-id="${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(markup).toContain("Answer in “Old question”");
  });

  it("draws the peers as a tree, each under the session that spawned it", () => {
    const markup = renderToStaticMarkup(
      ledge(
        [
          session("impl", {
            title: "Implementer",
            createdAt: NOW - 3_000_000,
            updatedAt: NOW - 50_000,
          }),
          session("rev", {
            title: "Reviewer",
            spawnedBySessionId: "impl",
            createdAt: NOW - 2_000_000,
            updatedAt: NOW - 1_000,
            backgroundActivity: {
              activeCount: 2,
              shellCount: 2,
              monitorCommandCount: 0,
              monitorWebsocketCount: 0,
              startingCount: 0,
              stoppingCount: 0,
              oldestStartedAt: NOW - 30_000,
            },
          }),
          session("other", {
            title: "Helper",
            createdAt: NOW - 1_000_000,
            updatedAt: NOW - 20_000,
          }),
        ],
        { open: true },
      ),
    );
    // Every depth counts, and background jobs are a fact of their own.
    expect(markup).toContain("3 sessions · 2 jobs");
    // Depth-first, siblings newest created first: the reviewer moved most
    // recently of all, yet it sits right under the implementer that spawned
    // it, indented one step, and the helper created after the implementer
    // leads.
    const order = ["other", "impl", "rev"].map((id) =>
      markup.indexOf(`data-list-row-id="${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // One indent step (0.75rem) per level below the strip's own peers.
    expect(markup).toMatch(
      /data-list-row-id="rev"[^>]*><div[^>]*style="padding-left:0.75rem"/,
    );
    expect(markup).toMatch(
      /data-list-row-id="impl"[^>]*><div[^>]*style="padding-left:0rem"/,
    );
  });

  it("keeps settled peers out of the line and the list until asked", () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const peers = [
      session("live"),
      session("done-1", { settledAt: NOW - 10_000 }),
      session("done-2", { settledAt: NOW - 10_000 }),
    ];
    let asked = 0;
    act(() => {
      root?.render(
        ledge(peers, {
          open: true,
          onToggleSettled: () => {
            asked++;
          },
        }),
      );
    });
    expect(container.textContent).toContain("1 session · 2 settled");
    expect(container.querySelectorAll("li[data-list-row-id]")).toHaveLength(1);
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show 2 settled"),
    );
    // Under the capped scroll box, never inside it: a control past the fold
    // is one the user has to know to scroll for.
    const scrollBox = container.querySelector<HTMLElement>(
      "[data-spawned-sessions-rows]",
    );
    expect(scrollBox?.className).toContain("overflow-y-auto");
    expect(toggle?.closest("[data-spawned-sessions-rows]")).toBeNull();
    expect(scrollBox?.nextElementSibling).toBe(toggle);
    act(() => toggle?.click());
    expect(asked).toBe(1);
    // The host answers with the settled peers included.
    act(() => {
      root?.render(ledge(peers, { open: true, includeSettled: true }));
    });
    expect(container.querySelectorAll("li[data-list-row-id]")).toHaveLength(3);
    expect(container.textContent).toContain("Hide settled");
  });

  it("stays on the composer when every peer is settled", () => {
    const markup = renderToStaticMarkup(
      ledge([session("done", { settledAt: NOW - 10_000 })]),
    );
    expect(markup).toContain("1 settled session");
  });

  it("is just the stall line for a chat that spawned no one but is owed a reply", () => {
    /** A session nothing spawned: the fixture's spawn edge taken off. */
    const plain = (id: string, extra: Partial<SessionListItem>) => {
      const {
        spawnedBySessionId: _parent,
        spawnOwnership: _owner,
        ...rest
      } = session(id, extra);
      return rest as SessionListItem;
    };
    const sessions = [
      plain("root", { awaitingRepliesFrom: ["impl"] }),
      plain("impl", { title: "Implementer" }),
    ];
    const markup = renderToStaticMarkup(ledge(sessions));
    expect(markup).toContain(
      'aria-label="Stalled: No reply from “Implementer”"',
    );
    // It claims no spawned sessions: there is no summary toggle at all.
    expect(markup).not.toContain('aria-expanded="');
    expect(markup).not.toContain("this chat spawned");
  });
});
