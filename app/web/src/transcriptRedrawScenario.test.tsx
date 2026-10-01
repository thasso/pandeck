// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

/**
 * What an open transcript is allowed to REDRAW, measured on the whole app.
 *
 * The other scenario files count what the reducer and the row keys produce;
 * this one counts what the browser is actually told to change, because that is
 * the quantity the reader feels. A DOM mutation inside a transcript row throws
 * away whatever that DOM was holding — the horizontal scroll of a wide code
 * block being read, a selection, a lazily highlighted `CodeBlock` — and no
 * amount of restoring it afterwards is as good as not doing it.
 *
 * The session list is sorted by `updatedAt` and rebroadcast up to ~4x/second
 * while any agent anywhere runs, so its ORDER changes constantly; that is the
 * event this pins. Every assertion is a count, never a duration.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Every test here mounts the WHOLE app into jsdom and drives it through real
// socket frames: under a second each on an idle machine, but a CI runner that
// is also linting and building has stretched the file four-fold and past the
// 5 s default. The counts being asserted never depend on time, so the budget
// only has to be generous enough that a slow run is still a run.
vi.setConfig({ testTimeout: 20_000 });

// The one clock the app runs on its own: the viewed session counts as read
// after `SESSION_READ_DWELL_MS` (3 s), a state change in `App` that redraws
// the transcript. On an idle machine every window measured below closes long
// before it fires; on a loaded runner a test stretches past 3 s and the tick
// lands INSIDE the window, counting a render no broadcast caused. Nothing here
// asserts read marks, so the dwell is held off entirely.
vi.mock("./hooks/useSessionReadDwell.ts", () => ({
  useSessionReadDwell: () => undefined,
}));

class ScenarioSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: ScenarioSocket[] = [];
  readyState = ScenarioSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    ScenarioSocket.instances.push(this);
  }
  open(): void {
    this.readyState = ScenarioSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(source: string): void {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

// The transcript renderer is lazily imported by `App`; loading it here first
// means the Suspense boundary resolves within the act() below instead of
// leaving the fallback on screen for the whole test. The pull-request card is
// lazy inside it for the same reason.
await import("./components/MessageList.tsx");
await import("./components/PullRequestCard.tsx");
const App = (await import("./App.tsx")).default;
const { ShortcutsProvider } = await import("./components/ui/shortcuts.tsx");
const { perfSnapshot, setPerfStatsEnabled } =
  await import("./lib/perfStats.ts");

const ROW_COUNT = 40;
const SESSION_COUNT = 10;
/** The socket batches streaming deltas to an animation frame; jsdom runs those on a timer. */
const FRAME_MS = 25;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 4): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
}

beforeEach(() => {
  window.localStorage.clear();
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ profiles: [], modelsByProfile: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function timelineEntries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    seq: i + 1,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    type: "message",
    role: i % 2 === 0 ? "user" : "assistant",
    ...(i % 2 === 0 ? { origin: { kind: "human" } } : {}),
    content: [
      { type: "text", text: `entry ${i} with a \`wide code span\` in it` },
    ],
  }));
}

/** Real session ids are UUIDs, and the transcript's autolink only matches those. */
function sessionId(index: number): string {
  return `00000000-0000-4000-8000-00000000000${index}`;
}

function sessionRows(updatedAt: (index: number) => number) {
  return Array.from({ length: SESSION_COUNT }, (_, i) => ({
    id: sessionId(i),
    harness: "pi",
    agentType: "assistant",
    title: `Session ${i}`,
    updatedAt: updatedAt(i),
    messageCount: 0,
    isStreaming: false,
  }));
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: sessionRows((i) => 1_700_000_000_000 + i),
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  } as unknown as ServerMessage;
}

function snapshotMessage(id = sessionId(0)): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: id,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: id,
      runState: "idle",
      timelineStart: 0,
      streaming: [],
      timeline: timelineEntries(ROW_COUNT),
      pendingApprovals: [],
      activity: [],
    },
  } as unknown as ServerMessage;
}

/** Boot the app on the viewed chat, with the session list already sorted. */
async function openChat(): Promise<ScenarioSocket> {
  window.history.replaceState(null, "", `/sessions/${sessionId(0)}`);
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  await settle();
  const socket = ScenarioSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => socket.receive(snapshotMessage()));
  // The list arrives sorted once before measuring, so what follows is the
  // steady state the reader sits in rather than the first sort.
  await act(async () =>
    socket.receive({
      type: "sessions",
      sessions: sessionRows((i) => 1_700_000_000_000 + i),
    } as unknown as ServerMessage),
  );
  await settle();
  return socket;
}

/**
 * The same list, with two of the rows spawned BY the chat on screen — so the
 * composer carries the spawned-session ledge while the rest of this runs.
 */
function peerSessionRows(updatedAt: (index: number) => number) {
  return sessionRows(updatedAt).map((row, i) =>
    i === 1 || i === 2
      ? {
          ...row,
          spawnedBySessionId: sessionId(0),
          spawnOwnership: "coordinator",
          // Peer 1 is RUNNING, which is the state the strip exists to show:
          // the server moves a streaming session's `updatedAt` on every one of
          // these broadcasts. The Working badge is static; only the row's
          // separate age changes what the open strip draws.
          ...(i === 1
            ? { isStreaming: true, runStartedAt: 1_700_000_000_000 }
            : {}),
        }
      : row,
  );
}

/** Another session finished a turn: same rows, same titles, new ORDER. */
function reorderedSessions(): ServerMessage {
  return {
    type: "sessions",
    sessions: sessionRows((i) =>
      i === 3 ? 1_700_000_009_999 : 1_700_000_000_000 + i,
    ),
  } as unknown as ServerMessage;
}

function countOf(
  snapshot: { renders: Array<{ name: string; count: number }> },
  name: string,
): number {
  return snapshot.renders.find((entry) => entry.name === name)?.count ?? 0;
}

/** Mutations the observer saw inside a rendered transcript row. */
function countTranscriptMutations(records: MutationRecord[]): number {
  return records.filter((record) => {
    const element =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement;
    return Boolean(element?.closest("[data-message-id]"));
  }).length;
}

describe("transcript redraws", () => {
  it("leaves the rendered transcript untouched when the session list re-sorts", async () => {
    const socket = await openChat();
    const rows = container!.querySelectorAll("[data-message-id]");
    expect(rows.length).toBe(ROW_COUNT);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(container!, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    // The event that used to rebuild every row.
    await act(async () => socket.receive(reorderedSessions()));
    await settle();
    observer.disconnect();

    expect(countTranscriptMutations(records)).toBe(0);
    // The rows are the same DOM nodes, so what they were holding is still there.
    expect([...container!.querySelectorAll("[data-message-id]")]).toEqual([
      ...rows,
    ]);
  });

  it("touches only the streaming row for a token delta", async () => {
    const socket = await openChat();
    await act(async () =>
      socket.receive({
        type: "event",
        sessionId: sessionId(0),
        event: { type: "messageStarted", streamId: "st1" },
      } as unknown as ServerMessage),
    );
    await settle();

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(container!, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    await act(async () =>
      socket.receive({
        type: "event",
        sessionId: sessionId(0),
        event: {
          type: "messageDelta",
          streamId: "st1",
          delta: { kind: "text", text: "hello" },
        },
      } as unknown as ServerMessage),
    );
    await settle();
    observer.disconnect();

    const touchedRows = new Set(
      records
        .map((record) => {
          const element =
            record.target instanceof Element
              ? record.target
              : record.target.parentElement;
          return element
            ?.closest("[data-message-id]")
            ?.getAttribute("data-message-id");
        })
        .filter((id): id is string => Boolean(id)),
    );
    expect([...touchedRows]).toEqual(["live"]);
  });
});

/**
 * What a broadcast may RE-RENDER, from the app's own counters
 * (`lib/perfStats.ts` — the ones the dev HUD shows, so the number a developer
 * reads while using the app is the number this pins).
 *
 * The DOM assertions above say the reader sees nothing move; these say the work
 * was not done at all. A re-render with no DOM change is invisible and still
 * costs a phone a frame — and the composer's is a whole toolbar of pickers,
 * re-rendered once per streamed animation frame before it was memoized.
 */
describe("what a broadcast re-renders", () => {
  it("re-renders neither the composer nor the turn-stats rows for an unrelated session broadcast", async () => {
    const socket = await openChat();
    // The rows exist to begin with: a count of zero must mean "did not
    // re-render", never "was never there".
    setPerfStatsEnabled(true);
    try {
      await act(async () => socket.receive(snapshotMessage()));
      await settle();
      const mounted = perfSnapshot();
      expect(countOf(mounted, "TurnStatsRow")).toBeGreaterThan(0);
      expect(countOf(mounted, "Composer")).toBeGreaterThan(0);

      setPerfStatsEnabled(false);
      setPerfStatsEnabled(true);
      await act(async () => socket.receive(reorderedSessions()));
      await settle();
      const after = perfSnapshot();
      expect(countOf(after, "TurnStatsRow")).toBe(0);
      expect(countOf(after, "Composer")).toBe(0);
      expect(countOf(after, "MessageList")).toBe(1);
    } finally {
      setPerfStatsEnabled(false);
    }
  });

  it("re-renders no composer for a rebroadcast the spawned ledge does not draw", async () => {
    const socket = await openChat();
    const peers = (message: ServerMessage) =>
      act(async () => socket.receive(message));
    await peers({
      type: "sessions",
      sessions: peerSessionRows((i) => 1_700_000_000_000 + i),
    } as unknown as ServerMessage);
    await settle();
    // The strip is on screen to begin with: a count of zero must mean "did not
    // re-render", never "was never mounted".
    expect(
      container!.querySelector("[data-spawned-sessions-ledge]"),
    ).not.toBeNull();
    setPerfStatsEnabled(true);
    try {
      // Row 3 moved; it is not one of the peers, so nothing the strip draws
      // changed — and the list is rebroadcast like this several times a second.
      await peers({
        type: "sessions",
        sessions: peerSessionRows((i) =>
          i === 3 ? 1_700_000_009_999 : 1_700_000_000_000 + i,
        ),
      } as unknown as ServerMessage);
      await settle();
      expect(countOf(perfSnapshot(), "Composer")).toBe(0);
      // And the case the strip is actually FOR: a peer of THIS chat streaming.
      // The server moves its `updatedAt` on every broadcast, and while the
      // strip is CLOSED none of that is on screen — the collapsed line states
      // counts and a bubble, neither of which reads a clock — so not one of
      // them may reach the composer. The moves here even cross what would be a
      // rendered age boundary, which is the case a bucketed gate would miss.
      const streamingPeer = (at: number) =>
        peers({
          type: "sessions",
          sessions: peerSessionRows((i) =>
            i === 1 ? at : 1_700_000_000_000 + i,
          ),
        } as unknown as ServerMessage);
      await streamingPeer(Date.now() - 90_000);
      await settle();
      setPerfStatsEnabled(false);
      setPerfStatsEnabled(true);
      await streamingPeer(Date.now() - 1_500);
      await streamingPeer(Date.now() - 1_000);
      await settle();
      expect(countOf(perfSnapshot(), "Composer")).toBe(0);
    } finally {
      setPerfStatsEnabled(false);
    }
  });

  it("re-renders neither for a streamed token", async () => {
    const socket = await openChat();
    await act(async () =>
      socket.receive({
        type: "event",
        sessionId: sessionId(0),
        event: { type: "messageStarted", streamId: "st1" },
      } as unknown as ServerMessage),
    );
    await settle();
    setPerfStatsEnabled(true);
    try {
      await act(async () =>
        socket.receive({
          type: "event",
          sessionId: sessionId(0),
          event: {
            type: "messageDelta",
            streamId: "st1",
            delta: { kind: "text", text: "hello" },
          },
        } as unknown as ServerMessage),
      );
      await settle();
      const after = perfSnapshot();
      // The transcript re-renders — it is what the token is FOR — but nothing
      // beside it does.
      expect(countOf(after, "MessageList")).toBe(1);
      expect(countOf(after, "TurnStatsRow")).toBe(0);
      expect(countOf(after, "Composer")).toBe(0);
    } finally {
      setPerfStatsEnabled(false);
    }
  });
});

/**
 * Naming a session is not an edit to the chat you are reading.
 *
 * The server names a session from its first prompt, so every session anyone
 * starts arrives as a title change on the shared list — and the transcript's
 * link references were built from that whole list, which made each one a
 * content change for every message on screen. They are narrowed to the objects
 * the rendered text actually mentions instead; the second test here is the half
 * that keeps that honest, because a filter that dropped everything would pass
 * the first one.
 */
describe("link references", () => {
  it("does not re-render the transcript when an unmentioned session is named", async () => {
    const socket = await openChat();
    setPerfStatsEnabled(true);
    try {
      await act(async () =>
        socket.receive({
          type: "sessions",
          sessions: sessionRows((i) => 1_700_000_000_000 + i).map((row, i) =>
            i === 5 ? { ...row, title: "Named by its first prompt" } : row,
          ),
        } as unknown as ServerMessage),
      );
      await settle();
      expect(countOf(perfSnapshot(), "MessageRow")).toBe(0);
    } finally {
      setPerfStatsEnabled(false);
    }
  });

  it("does re-render it when the named session is one the transcript links to", async () => {
    const socket = await openChat();
    // A message that names session 5 by id — what the autolink resolves.
    await act(async () =>
      socket.receive({
        type: "snapshot",
        state: {
          sessionId: sessionId(0),
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        },
        contextInfo: null,
        snapshot: {
          sessionId: sessionId(0),
          runState: "idle",
          timelineStart: 0,
          streaming: [],
          timeline: [
            {
              id: "mention",
              seq: 1,
              createdAt: new Date(1_700_000_000_000).toISOString(),
              type: "message",
              role: "user",
              origin: { kind: "human" },
              content: [{ type: "text", text: `see ${sessionId(5)}` }],
            },
          ],
          pendingApprovals: [],
          activity: [],
        },
      } as unknown as ServerMessage),
    );
    await settle();
    setPerfStatsEnabled(true);
    try {
      await act(async () =>
        socket.receive({
          type: "sessions",
          sessions: sessionRows((i) => 1_700_000_000_000 + i).map((row, i) =>
            i === 5 ? { ...row, title: "Named by its first prompt" } : row,
          ),
        } as unknown as ServerMessage),
      );
      await settle();
      expect(countOf(perfSnapshot(), "MessageRow")).toBeGreaterThan(0);
    } finally {
      setPerfStatsEnabled(false);
    }
  });
});

/**
 * A live card is a CONTROL, not a rendered row: unmounting it drops the merge
 * method and the delete-branch choice the user made on it, and blinks it off
 * the screen for a frame.
 *
 * Store-backed cards do not travel on the timeline — the server re-emits them
 * as their own messages right after the atomic snapshot — so a re-attach of the
 * session already in view (a reconnect, and a merge is exactly when one lands:
 * refreshing the base checkout restarts a dev server) is the one event that can
 * take a card out of a transcript whose every other row stays put. What the
 * reader sees is one card disappearing and coming back on its own.
 */
describe("live cards", () => {
  const pullRequestCard = (
    patch: Record<string, unknown> = {},
  ): ServerMessage =>
    ({
      type: "pullRequestCardUpdate",
      sessionId: sessionId(0),
      card: {
        renderKind: "pullRequest",
        id: "pr-1",
        sessionId: sessionId(0),
        status: "open",
        createdAt: 1_700_000_100_000,
        updatedAt: 1_700_000_100_000,
        number: 7,
        provider: "forgejo",
        title: "A pull request",
        headBranch: "feature",
        baseBranch: "main",
        worktreeId: "wt-1",
        warnings: [],
        repositoryCapabilities: {
          mergeMethods: ["merge", "squash"],
          defaultMergeMethod: "merge",
        },
        ...patch,
      },
    }) as unknown as ServerMessage;

  /** The card's own element, not its row: a remount replaces this node. */
  const cardElement = () =>
    container!.querySelector(
      '[data-message-id="pull-request-card-pr-1"] .rounded-xl',
    );

  it("keeps the pull-request card mounted when its session re-attaches", async () => {
    const socket = await openChat();
    await act(async () => socket.receive(pullRequestCard()));
    await settle();
    const card = cardElement();
    expect(card).not.toBeNull();

    const removed: Node[] = [];
    const observer = new MutationObserver((batch) => {
      for (const record of batch) removed.push(...record.removedNodes);
    });
    observer.observe(container!, { childList: true, subtree: true });

    // The re-attach: the same session's snapshot, then the store-backed
    // re-emit that follows it on the wire.
    await act(async () => socket.receive(snapshotMessage()));
    await settle();
    expect(cardElement()).toBe(card);
    await act(async () =>
      socket.receive(pullRequestCard({ status: "merged", updatedAt: 2 })),
    );
    await settle();
    observer.disconnect();

    // Not "it is back", but "it never left": the node is the same one, and
    // nothing containing it was ever taken out of the DOM.
    expect(cardElement()).toBe(card);
    expect(removed.some((node) => node.contains(card))).toBe(false);
  });

  it("does not carry a card into the session it switches to", async () => {
    const socket = await openChat();
    await act(async () => socket.receive(pullRequestCard()));
    await settle();
    expect(cardElement()).not.toBeNull();

    await act(async () => socket.receive(snapshotMessage(sessionId(1))));
    await settle();
    expect(cardElement()).toBeNull();
  });
});

/**
 * A card waiting on the user is anchored at the tool call that proposed it, so
 * an agent that keeps talking buries it. The composer names it until it is
 * answered, and the agent can link it; both are the SAME jump, asked of the
 * server because the proposing turn may be behind the transcript's window.
 */
describe("pending approval cards", () => {
  const approvalUpdate = (status = "pending"): ServerMessage =>
    ({
      type: "approvalUpdate",
      sessionId: sessionId(0),
      approval: {
        renderKind: "approval",
        id: "appr_1",
        sessionId: sessionId(0),
        kind: "commit",
        status,
        title: "Merge #4 into main",
        createdAt: 1_700_000_000_500,
        body: { kind: "commit", message: "wip", files: ["a.ts"] },
      },
    }) as unknown as ServerMessage;

  const approvalAsks = (socket: ScenarioSocket) =>
    socket.sent.filter(
      (msg) =>
        msg.type === "resolveTimelineAnchor" && msg.target.kind === "approval",
    );

  it("names the card on the composer, jumps to it, and leaves once it is answered", async () => {
    const socket = await openChat();
    expect(
      container!.querySelector("[data-pending-approvals-ledge]"),
    ).toBeNull();

    await act(async () => socket.receive(approvalUpdate()));
    await settle();
    const strip = container!.querySelector("[data-pending-approvals-ledge]");
    expect(strip?.textContent).toContain("Merge #4 into main");

    await act(async () => strip!.querySelector("button")!.click());
    expect(approvalAsks(socket)).toMatchObject([
      { target: { kind: "approval", approvalId: "appr_1" } },
    ]);

    // The server re-emits every card on each re-attach: the same card again
    // is nothing the strip draws, so the composer does not re-render for it.
    setPerfStatsEnabled(true);
    try {
      await act(async () => socket.receive(approvalUpdate()));
      await settle();
      expect(countOf(perfSnapshot(), "Composer")).toBe(0);
    } finally {
      setPerfStatsEnabled(false);
    }

    await act(async () => socket.receive(approvalUpdate("executing")));
    await settle();
    expect(
      container!.querySelector("[data-pending-approvals-ledge]"),
    ).toBeNull();
  });

  it("renders an agent's card link with the card's live status, and jumps on click", async () => {
    const socket = await openChat();
    await act(async () =>
      socket.receive({
        type: "snapshot",
        state: {
          sessionId: sessionId(0),
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        },
        contextInfo: null,
        snapshot: {
          sessionId: sessionId(0),
          runState: "idle",
          timelineStart: 0,
          streaming: [],
          timeline: [
            {
              id: "ask",
              seq: 1,
              createdAt: new Date(1_700_000_001_000).toISOString(),
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Please approve [the merge](pa://approval/appr_1).",
                },
              ],
            },
          ],
          pendingApprovals: [],
          activity: [],
        },
      } as unknown as ServerMessage),
    );
    await act(async () => socket.receive(approvalUpdate()));
    await settle();
    const link = container!.querySelector<HTMLAnchorElement>(
      '[data-message-id="ask"] a',
    );
    expect(link?.textContent).toBe("the merge · pending approval");
    expect(link?.getAttribute("href")).toBe(
      `/sessions/${sessionId(0)}#m-approval-appr_1`,
    );

    await act(async () => link!.click());
    expect(approvalAsks(socket)).toHaveLength(1);

    await act(async () => socket.receive(approvalUpdate("executed")));
    await settle();
    expect(
      container!.querySelector('[data-message-id="ask"] a')?.textContent,
    ).toBe("the merge · done");
  });
});
