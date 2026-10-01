// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { FakeSocket } from "./test/fakeSocket.ts";

/**
 * `/sessions/:id#m-<entryId>` — one message, addressed in the URL — measured on
 * the whole app, because the thing that breaks is the wiring between the
 * fragment and the app's route state.
 *
 * A fragment moves UNDER an unchanged route: back/forward between two messages
 * of one session, or leaving a deep link and returning to it later, changes no
 * route field at all. An effect keyed on the route alone therefore never re-runs
 * and the reader is left wherever the transcript happens to sit, which looks
 * exactly like a dead link. Every assertion here is about that: the app ASKS
 * where the addressed message is, once per address it arrives at.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

await import("./components/MessageList.tsx");
const App = (await import("./App.tsx")).default;
const { ShortcutsProvider } = await import("./components/ui/shortcuts.tsx");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const FRAME_MS = 25;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    });
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [
      {
        id: SESSION_ID,
        harness: "pi",
        agentType: "assistant",
        title: "Session",
        updatedAt: 1_700_000_000_000,
        messageCount: 2,
        isStreaming: false,
      },
    ],
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

function snapshotMessage(): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId: SESSION_ID,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: null,
    snapshot: {
      sessionId: SESSION_ID,
      runState: "idle",
      timelineStart: 0,
      streaming: [],
      timeline: Array.from({ length: 4 }, (_, i) => ({
        id: `e${i}`,
        seq: i + 1,
        createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        type: "message",
        role: i % 2 === 0 ? "user" : "assistant",
        ...(i % 2 === 0 ? { origin: { kind: "human" } } : {}),
        content: [{ type: "text", text: `entry ${i}` }],
      })),
      pendingApprovals: [],
      activity: [],
    },
  } as unknown as ServerMessage;
}

/** The addresses the app asked the server to resolve, in order. */
function asked(socket: FakeSocket): string[] {
  return socket.sent
    .filter((msg) => msg.type === "resolveTimelineAnchor")
    .map((msg) => {
      const target = (msg as { target: { kind: string; entryId?: string } })
        .target;
      return `${target.kind}:${target.entryId ?? ""}`;
    });
}

/** Move the browser to `path` the way the back/forward arrows do. */
async function goTo(path: string): Promise<void> {
  await act(async () => {
    window.history.pushState({ navIndex: 1 }, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  });
  await settle(1);
}

async function boot(path: string): Promise<FakeSocket> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root!.render(
      <ShortcutsProvider>
        <App />
      </ShortcutsProvider>,
    );
  });
  await settle();
  const socket = FakeSocket.instances[0]!;
  await act(async () => {
    socket.open();
    socket.receive(readyMessage());
  });
  await act(async () => socket.receive(snapshotMessage()));
  await settle();
  return socket;
}

beforeEach(() => {
  window.localStorage.clear();
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
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

describe("a message addressed in the URL", () => {
  it("asks where it is on arrival, and not again while sitting on it", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}#m-e1`);
    expect(asked(socket)).toEqual(["entry:e1"]);

    await settle();
    expect(asked(socket)).toEqual(["entry:e1"]);
  });

  it("follows the fragment moving under an unchanged route", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}#m-e1`);

    // Back/forward between two messages of the SAME session: the route does not
    // change, only the address does.
    await goTo(`/sessions/${SESSION_ID}#m-e3`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3"]);

    // Leaving the fragment asks nothing…
    await goTo(`/sessions/${SESSION_ID}`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3"]);

    // …and coming back to an address already visited reveals it again, rather
    // than being swallowed as "already done".
    await goTo(`/sessions/${SESSION_ID}#m-e3`);
    expect(asked(socket)).toEqual(["entry:e1", "entry:e3", "entry:e3"]);
  });

  it("ignores a fragment that is not a message address", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}`);
    await goTo(`/sessions/${SESSION_ID}#something-else`);
    expect(asked(socket)).toEqual([]);
  });
});

/**
 * A card waiting on the user is anchored at the tool call that proposed it, so
 * an agent that keeps talking buries it. The composer names it until it is
 * answered, and the agent can link it; both are the SAME jump, asked of the
 * server because the proposing turn may be behind the transcript's window.
 * What a re-emitted card may re-render is counted in
 * `transcriptRedrawScenario.test.tsx`.
 */
describe("pending approval cards", () => {
  const approvalUpdate = (status = "pending"): ServerMessage =>
    ({
      type: "approvalUpdate",
      sessionId: SESSION_ID,
      approval: {
        renderKind: "approval",
        id: "appr_1",
        sessionId: SESSION_ID,
        kind: "commit",
        status,
        title: "Merge #4 into main",
        createdAt: 1_700_000_000_500,
        body: { kind: "commit", message: "wip", files: ["a.ts"] },
      },
    }) as unknown as ServerMessage;

  const approvalAsks = (socket: FakeSocket) =>
    socket.sent.filter(
      (msg) =>
        msg.type === "resolveTimelineAnchor" && msg.target.kind === "approval",
    );

  it("names the card on the composer, jumps to it, and leaves once it is answered", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}`);
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

    await act(async () => socket.receive(approvalUpdate("executing")));
    await settle();
    expect(
      container!.querySelector("[data-pending-approvals-ledge]"),
    ).toBeNull();
  });

  it("renders an agent's card link with the card's live status, and jumps on click", async () => {
    const socket = await boot(`/sessions/${SESSION_ID}`);
    await act(async () =>
      socket.receive({
        type: "snapshot",
        state: {
          sessionId: SESSION_ID,
          harness: "pi",
          agentType: "assistant",
          thinkingLevel: "off",
        },
        contextInfo: null,
        snapshot: {
          sessionId: SESSION_ID,
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
      `/sessions/${SESSION_ID}#m-approval-appr_1`,
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
