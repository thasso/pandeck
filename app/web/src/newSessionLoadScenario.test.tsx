// @vitest-environment jsdom
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMessage,
  DisplayMessage,
  ServerMessage,
} from "@assistant/shared";
import type { SessionEntry } from "@assistant/shared/session";
import {
  useAssistant,
  WORKTREE_PROVISION_MESSAGE_ID,
  type HarnessSendInput,
} from "./hooks/useAssistant.ts";
import { useCredentialProfileProjection } from "./hooks/useCredentialProfileProjection.ts";
import { topicsForSurface } from "./lib/broadcastTopics.ts";
import { newSessionShell, stagedTranscript } from "./lib/newSessionShell.ts";
import { PageHeader } from "./components/PageHeader.tsx";
import { SessionBootstrapNarration } from "./components/SessionStage.tsx";
import { SessionTitleText } from "./components/SessionTitleText.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  constructor(_url: string) {
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

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    serverBuild: { version: "0.0.0-test" },
    state: null,
    models: [],
    agents: [],
    sessions: [],
    settings: {},
    speechToText: {
      configured: false,
      availableModelIds: [],
      maxUtteranceSeconds: 120,
    },
    slashCommands: [],
    contextInfo: null,
  };
}

function NewRouteHarness({
  routeName = "new",
  taskPickerOpen = false,
}: {
  routeName?: "new" | "sessions";
  taskPickerOpen?: boolean;
}) {
  const { state, actions } = useAssistant();
  useCredentialProfileProjection({
    connected: state.connected,
    ...(state.credentialProfileProjection != null
      ? { initialData: state.credentialProfileProjection }
      : {}),
    onProjection: actions.setCredentialProfileProjection,
  });
  useEffect(() => {
    actions.setTopics(
      topicsForSurface({
        sidebarVisible: false,
        sidebarSection: "sessions",
        routeName,
        taskPickerOpen,
      }),
    );
  }, [actions, routeName, taskPickerOpen]);
  return null;
}

function CachedSessionRouteHarness() {
  const { state, actions } = useAssistant();
  useEffect(() => {
    if (!state.connected) return;
    // Two consumers can need the same canonical projection (the viewed session
    // and Sessions sidebar). The socket layer collapses them to one read.
    for (let consumer = 0; consumer < 2; consumer += 1) {
      if (!state.taskListFresh) actions.listTasks({});
      if (!state.projectListFresh)
        actions.listProjects({ includeArchived: true });
      if (!state.worktreesFresh) actions.listWorktrees();
    }
  }, [
    actions,
    state.connected,
    state.taskListFresh,
    state.projectListFresh,
    state.worktreesFresh,
  ]);
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  ScenarioSocket.instances = [];
  vi.stubGlobal("WebSocket", ScenarioSocket);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderHarness(
  element: ReactNode = <NewRouteHarness />,
): Promise<ScenarioSocket> {
  await act(async () => root!.render(element));
  return ScenarioSocket.instances[0]!;
}

function projectionResponse(): Response {
  return new Response(JSON.stringify({ profiles: [], modelsByProfile: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("new-session load request counts", () => {
  it("defers the Task subscription until its new-session picker opens", async () => {
    let answer!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const socket = await renderHarness();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      answer(projectionResponse());
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    let declarations = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
        message.type === "subscribe",
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]!.topics).toEqual(
      expect.arrayContaining(["projects", "worktrees"]),
    );
    expect(declarations[0]!.topics).not.toContain("tasks");

    await act(async () => root!.render(<NewRouteHarness taskPickerOpen />));
    declarations = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
        message.type === "subscribe",
    );
    expect(declarations).toHaveLength(2);
    expect(declarations[1]!.topics).toEqual(["tasks"]);

    // Subscribe is the client request for these lists; no parallel explicit
    // commands may race the server's authoritative subscription answers.
    expect(
      socket.sent.filter((message) =>
        ["listTasks", "listProjects", "listWorktrees"].includes(message.type),
      ),
    ).toHaveLength(0);
  });

  it("subscribes and unsubscribes a cold-cache /sessions Task picker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => projectionResponse()),
    );
    const socket = await renderHarness(
      <NewRouteHarness routeName="sessions" taskPickerOpen={false} />,
    );
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    expect(
      socket.sent.filter((message) => message.type === "subscribe"),
    ).toEqual([]);

    await act(async () =>
      root!.render(<NewRouteHarness routeName="sessions" taskPickerOpen />),
    );
    expect(
      socket.sent.filter((message) => message.type === "subscribe"),
    ).toEqual([{ type: "subscribe", topics: ["tasks"] }]);
    expect(
      socket.sent.filter((message) => message.type === "listTasks"),
    ).toEqual([]);

    await act(async () =>
      root!.render(
        <NewRouteHarness routeName="sessions" taskPickerOpen={false} />,
      ),
    );
    expect(
      socket.sent.filter((message) => message.type === "unsubscribe"),
    ).toEqual([{ type: "unsubscribe", topics: ["tasks"] }]);
  });

  it("requests a digest when a settled Task list and sidecar are warm", async () => {
    window.localStorage.setItem(
      "assistant.appShellCache.v1",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        models: [],
        agents: [],
        sessions: [],
        settings: {},
        slashCommands: [],
        taskList: {
          request: {},
          items: [
            {
              id: "413",
              title: "Warm",
              status: "doing",
              source: { createdBy: "user" },
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          updatedAt: 2,
        },
        taskRevisions: { "413": 12 },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => projectionResponse()),
    );
    const socket = await renderHarness(
      <NewRouteHarness routeName="sessions" taskPickerOpen />,
    );
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });

    expect(
      socket.sent.filter((message) => message.type === "subscribe"),
    ).toEqual([{ type: "subscribe", topics: ["tasks"], digests: ["tasks"] }]);

    await act(async () =>
      socket.receive({
        type: "stateDigest",
        topic: "tasks",
        seq: 4,
        entries: [
          { id: "413", revision: 13 },
          { id: "414", revision: 14 },
        ],
      }),
    );
    const fetches = socket.sent.filter(
      (message): message is Extract<ClientMessage, { type: "getStateItems" }> =>
        message.type === "getStateItems",
    );
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.ids).toEqual(["413", "414"]);
    expect(
      socket.sent.filter((message) => message.type === "listTasks"),
    ).toEqual([]);
  });

  it("revalidates cache-seeded lists once on a non-subscribing session surface", async () => {
    window.localStorage.setItem(
      "assistant.appShellCache.v1",
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        models: [],
        agents: [],
        sessions: [],
        settings: {},
        slashCommands: [],
        taskList: { request: {}, items: [], updatedAt: 1 },
        projectList: {
          request: { includeArchived: true },
          projects: [],
          updatedAt: 1,
        },
        worktrees: [],
      }),
    );
    const socket = await renderHarness(<CachedSessionRouteHarness />);
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });

    for (const type of [
      "listTasks",
      "listProjects",
      "listWorktrees",
    ] as const) {
      expect(
        socket.sent.filter((message) => message.type === type),
      ).toHaveLength(1);
    }
  });

  it("issues one projection refresh and one list subscription on reconnect", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () => projectionResponse());
    vi.stubGlobal("fetch", fetch);
    const first = await renderHarness();
    await act(async () => {
      first.open();
      first.receive(readyMessage());
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.close();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const second = ScenarioSocket.instances[1]!;
    await act(async () => second.open());
    await act(async () => {});

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const socket of [first, second]) {
      const subscriptions = socket.sent.filter(
        (message): message is Extract<ClientMessage, { type: "subscribe" }> =>
          message.type === "subscribe",
      );
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]!.topics).toEqual(
        expect.arrayContaining(["projects", "worktrees"]),
      );
      expect(subscriptions[0]!.topics).not.toContain("tasks");
    }
  });

  it("starts a newer projection generation when profiles change mid-request", async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await renderHarness();
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () =>
      window.dispatchEvent(new Event("credentialProfilesChanged")),
    );
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => answers[1]!(projectionResponse()));
    await act(async () => answers[0]!(projectionResponse()));
  });

  it("retries a failed boot projection once when the first socket connects", async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error("server starting"))
      .mockResolvedValueOnce(projectionResponse());
    vi.stubGlobal("fetch", fetch);
    const socket = await renderHarness();
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    await act(async () => {});

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

const STAGED_ID = "pending-pi-session";
const FIRST_PROMPT = "Draft the release notes";
const HANDOFF_PROMPT = "Address these review comments";

function messageText(message: DisplayMessage): string {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.text : ""))
    .join("");
}

/**
 * The new-session surface's bootstrap half, wired the way `App.tsx` wires it:
 * the real reducer behind a real socket, the shell decisions from
 * `lib/newSessionShell.ts`, and the two pieces of chrome they drive.
 *
 * `arm` is the harness's copy of `armStagedSend`, and it is deliberately the
 * ONE way a send leaves here — recording the viewed session with every kind of
 * first send is the contract, and a harness with a second, unrecorded path
 * would be modelling a surface that cannot exist. Both send kinds go through
 * it: the ordinary prompt, which echoes itself optimistically, and the review
 * handoff, which echoes nothing at all.
 */
function BootstrapShellHarness({
  routeAdvanced = false,
}: {
  /** The armed advance has moved the URL onto the session the send created. */
  routeAdvanced?: boolean;
}) {
  const { state, actions } = useAssistant();
  const [stagedSend, setStagedSend] = useState<{
    knownSessionIds: ReadonlySet<string>;
  } | null>(null);
  const arm = (send: () => void) => {
    send();
    // The same capture App makes, and the same one `notifyStagedFirstSend`
    // makes for the URL: the list plus the id in view.
    const knownSessionIds = new Set(state.sessions.map((row) => row.id));
    if (state.session?.sessionId) knownSessionIds.add(state.session.sessionId);
    setStagedSend({ knownSessionIds });
    actions.clearChatError();
  };
  // Leaving the staging route ends the bootstrap: App clears the staged send on
  // the route identity change.
  useEffect(() => {
    if (routeAdvanced) setStagedSend(null);
  }, [routeAdvanced]);
  const firstSendPending = stagedSend !== null;
  const stagedSessionId = routeAdvanced ? null : STAGED_ID;
  const staged = stagedTranscript({
    stagedSessionId,
    optimistic: state.optimistic,
    messages: state.messages,
    provisionMessageId: WORKTREE_PROVISION_MESSAGE_ID,
    provisionOwned: false,
    firstSendPending,
    viewedSessionId: state.session?.sessionId ?? null,
    knownSessionIdsAtSend: stagedSend?.knownSessionIds ?? null,
  });
  const shownOptimistic = Boolean(stagedSessionId) && !staged.adopted;
  const messages = shownOptimistic ? staged.messages : state.messages;
  // The identity follows the rows, exactly as `displaySession` does in App: a
  // staged surface names the session being created, an adopted one names the
  // session it adopted.
  const currentId = shownOptimistic
    ? stagedSessionId
    : state.session?.sessionId;
  const sessionRow = state.sessions.find((row) => row.id === currentId);
  const shell = newSessionShell({
    isNewChatRoute: !routeAdvanced,
    firstSendPending,
    ...(sessionRow
      ? {
          sessionTitle: sessionRow.title,
          sessionTitleGenerationPending:
            sessionRow.titleGenerationPending === true,
        }
      : {}),
    autoNamingEnabled: true,
    modelName: "Sonnet",
    agentResponding: messages.some((message) => message.role === "assistant"),
    worktreeNarrationVisible: false,
    provisionFailed: false,
    error: state.error,
    sendLanded: staged.landed,
  });
  return (
    <>
      <PageHeader
        title={
          <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
            <SessionTitleText
              title={shell.title}
              pending={shell.titleGenerationPending}
            />
          </h2>
        }
        subtitle={shell.subtitle || undefined}
      />
      {/* The rows the reducer holds, so a test can tell "nothing to leak" from
          "leaked nothing". */}
      <div data-testid="transcript" data-live-rows={state.messages.length}>
        {messages.map((message) => (
          <p key={message.id} data-role={message.role} data-id={message.id}>
            {messageText(message)}
          </p>
        ))}
      </div>
      {shell.narration ? (
        <SessionBootstrapNarration
          narration={shell.narration}
          onRetry={() => {}}
        />
      ) : null}
      <button
        type="button"
        onClick={() =>
          arm(() => {
            const input: HarnessSendInput = {
              id: STAGED_ID,
              harness: "pi",
              agentType: "assistant",
              text: FIRST_PROMPT,
            };
            actions.harnessSend(input);
          })
        }
      >
        Send prompt
      </button>
      <button
        type="button"
        onClick={() =>
          arm(() =>
            actions.attachWorktreeComments({
              worktreeId: "w1",
              commentIds: ["c1"],
              target: {
                kind: "new",
                harness: "pi",
                agentType: "developer",
                additionalPrompt: HANDOFF_PROMPT,
              },
            }),
          )
        }
      >
        Send review handoff
      </button>
    </>
  );
}

function transcriptText(): string {
  return (
    container!.querySelector("[data-testid=transcript]")?.textContent ?? ""
  );
}

function transcriptRowIds(): string[] {
  return [...container!.querySelectorAll("[data-testid=transcript] p")].map(
    (node) => node.getAttribute("data-id") ?? "",
  );
}

function liveRowCount(): number {
  return Number(
    container!
      .querySelector("[data-testid=transcript]")
      ?.getAttribute("data-live-rows"),
  );
}

function statusRegions(): string[] {
  return [...container!.querySelectorAll("[role=status]")].map(
    (node) => node.textContent ?? "",
  );
}

function firstSendClientRequestId(socket: ScenarioSocket): string {
  const sent = socket.sent.find(
    (message): message is Extract<ClientMessage, { type: "harnessSend" }> =>
      message.type === "harnessSend",
  );
  return sent!.clientRequestId!;
}

function clickButton(label: string): void {
  const button = [...container!.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  button!.click();
}

function userEntry(id: string, seq: number, text: string): SessionEntry {
  return {
    id,
    seq,
    createdAt: new Date(seq).toISOString(),
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text }],
  };
}

function sessionSnapshot(
  sessionId: string,
  timeline: SessionEntry[] = [],
): ServerMessage {
  return {
    type: "snapshot",
    state: {
      sessionId,
      harness: "pi",
      agentType: "assistant",
      thinkingLevel: "off",
    },
    contextInfo: {
      sessionId,
      updatedAt: 1,
      messageCounts: {
        user: timeline.length,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        total: timeline.length,
      },
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      cost: 0,
    },
    snapshot: {
      sessionId,
      runState: "idle",
      timeline,
      timelineStart: 0,
      totalEntryCount: timeline.length,
      streaming: [],
    },
  };
}

function durableFirstPrompt(clientRequestId: string): ServerMessage {
  return {
    type: "event",
    sessionId: "s-new",
    event: {
      type: "timelineDelta",
      clientRequestId,
      entries: [userEntry("e1", 1, FIRST_PROMPT)],
    },
  };
}

describe("new-session bootstrap shell", () => {
  async function connect(): Promise<ScenarioSocket> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => projectionResponse()),
    );
    const socket = await renderHarness(<BootstrapShellHarness />);
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    return socket;
  }

  async function sendFirstPrompt(): Promise<ScenarioSocket> {
    const socket = await connect();
    await act(async () => clickButton("Send prompt"));
    return socket;
  }

  it("renders the session shell and one progress region while the session is created", async () => {
    const socket = await sendFirstPrompt();

    // The title bar is there the moment the prompt is: the surface is a session
    // being created, not a new-session page any more.
    expect(
      container!.querySelector("[data-title-generation-pending=true]")
        ?.textContent,
    ).toBe("Unlabeled Session");
    expect(container!.querySelector("h2")?.textContent).toContain(
      "naming in progress",
    );
    expect(container!.querySelector("header")?.textContent).toContain("Sonnet");
    expect(transcriptText()).toContain(FIRST_PROMPT);
    // One narration for the one source, and it says what is happening.
    expect(statusRegions()).toEqual(["Starting session…"]);
    // The shell is rendered from what this connect episode already has: the
    // send itself is the only request the bootstrap makes.
    expect(socket.sent.map((message) => message.type)).toEqual(["harnessSend"]);
  });

  it("keeps the prompt through the optimistic → real session handoff", async () => {
    const socket = await sendFirstPrompt();
    const clientRequestId = firstSendClientRequestId(socket);

    // The created session is viewed before it has any entries.
    await act(async () => socket.receive(sessionSnapshot("s-new")));
    expect(transcriptText()).toContain(FIRST_PROMPT);

    expect(transcriptRowIds()).toEqual([`creq-${clientRequestId}`]);

    // The durable echo settles the optimistic row; the URL has not moved yet.
    await act(async () => socket.receive(durableFirstPrompt(clientRequestId)));
    expect(transcriptText()).toContain(FIRST_PROMPT);
    // …under the created session's own row, adopted rather than blanked.
    expect(transcriptRowIds()).toEqual(["e1"]);
    expect(statusRegions()).toEqual(["Starting session…"]);

    // …and the advance onto the created session keeps the prompt in place and
    // takes the bootstrap narration down with it.
    await act(async () =>
      root!.render(<BootstrapShellHarness routeAdvanced />),
    );
    expect(transcriptText()).toContain(FIRST_PROMPT);
    expect(statusRegions()).toEqual([]);
  });

  async function viewingOldChat(): Promise<ScenarioSocket> {
    const socket = await connect();
    await act(async () => {
      socket.receive({
        type: "sessions",
        sessions: [
          {
            id: "s-old",
            harness: "pi",
            agentType: "assistant",
            title: "Old chat",
            createdAt: 0,
            updatedAt: 1,
            messageCount: 1,
          },
          {
            id: "s-other",
            harness: "pi",
            agentType: "assistant",
            title: "Other chat",
            createdAt: 0,
            updatedAt: 2,
            messageCount: 1,
          },
        ],
      });
      socket.receive(
        sessionSnapshot("s-old", [userEntry("old-1", 1, "Earlier question")]),
      );
    });
    return socket;
  }

  it("never paints the session a prompt-less first send left behind", async () => {
    // A review handoff sent from the Knowledge or Worktree page: it echoes no
    // prompt of its own, and the connection is still viewing the chat the user
    // was last in. That combination is what used to make the staged surface
    // adopt the OTHER conversation's rows and its whole identity.
    const socket = await viewingOldChat();
    // The previous conversation's rows are in the reducer, ready to leak: the
    // staging surface itself shows none of them, before or after the send.
    expect(liveRowCount()).toBe(1);
    expect(transcriptRowIds()).toEqual([]);

    await act(async () => clickButton("Send review handoff"));

    // The staged surface stands empty behind its narration rather than showing
    // somebody else's conversation, and the header names the session being
    // created — not "Old chat".
    expect(transcriptRowIds()).toEqual([]);
    expect(transcriptText()).not.toContain("Earlier question");
    expect(
      container!.querySelector("[data-title-generation-pending=true]")
        ?.textContent,
    ).toBe("Unlabeled Session");
    expect(statusRegions()).toEqual(["Starting session…"]);

    // The session the handoff creates IS adopted, as soon as the server views
    // it: that transcript is this send's own answer.
    await act(async () =>
      socket.receive(
        sessionSnapshot("s-new", [userEntry("h1", 1, HANDOFF_PROMPT)]),
      ),
    );
    expect(transcriptText()).toContain(HANDOFF_PROMPT);
    expect(transcriptRowIds()).toEqual(["h1"]);
  });

  it("adopts nothing when a pre-existing session drifts into view mid-bootstrap", async () => {
    // A late loadSession answer, a background session settling, a
    // server-initiated view switch: any of them can move the viewed session
    // while the bootstrap is out. `useSessionRouting` refuses to move the URL
    // onto a session that already existed at the send, and this surface has to
    // refuse the same one — otherwise it paints that conversation under
    // /sessions/create while the address bar says otherwise.
    const socket = await viewingOldChat();
    await act(async () => clickButton("Send prompt"));
    expect(transcriptText()).toContain(FIRST_PROMPT);

    await act(async () =>
      socket.receive(
        sessionSnapshot("s-other", [userEntry("other-1", 1, "Not mine")]),
      ),
    );

    // Nothing of that session reaches the staging surface — not its rows, not
    // its title — and the shell keeps narrating the send it is still waiting
    // on. The prompt itself is gone with the reducer's own pruning of an
    // optimistic echo across a foreign snapshot (`optimisticForSnapshot`,
    // unchanged here): an empty staged shell, which is what this surface
    // showed for that event before the shell existed.
    expect(liveRowCount()).toBe(1);
    expect(transcriptRowIds()).toEqual([]);
    expect(transcriptText()).not.toContain("Not mine");
    expect(
      container!.querySelector("[data-title-generation-pending=true]")
        ?.textContent,
    ).toBe("Unlabeled Session");
    expect(statusRegions()).toEqual(["Starting session…"]);

    // …and the send it was waiting on is still adopted when it does land.
    await act(async () =>
      socket.receive(
        sessionSnapshot("s-new", [userEntry("e1", 1, FIRST_PROMPT)]),
      ),
    );
    expect(transcriptRowIds()).toEqual(["e1"]);
  });

  it("does not narrate a stale error as this bootstrap failing", async () => {
    // A failure the user already dismissed from the banner leaves `state.error`
    // set. Arming a send retires it, so the bootstrap that follows reports its
    // own outcome instead of the previous one's — which it could not retry.
    const socket = await connect();
    await act(async () =>
      socket.receive({ type: "error", message: "Something failed earlier" }),
    );

    await act(async () => clickButton("Send review handoff"));

    expect(container!.querySelector("[role=alert]")).toBeNull();
    expect(statusRegions()).toEqual(["Starting session…"]);
  });

  it("keeps the prompt and offers a retry when the bootstrap fails", async () => {
    const socket = await sendFirstPrompt();

    // The failure NAMES this send, and the reducer retires echoes by that name:
    // the staged one is the exception that survives being named.
    await act(async () =>
      socket.receive({
        type: "error",
        message: "engine did not start",
        failedPromptClientRequestId: firstSendClientRequestId(socket),
      }),
    );

    // The prompt is not dropped with the failed send: the surface says what
    // went wrong under it, with the way to run it again.
    expect(transcriptText()).toContain(FIRST_PROMPT);
    expect(statusRegions()).toEqual([]);
    const failure = container!.querySelector("[role=alert]");
    expect(failure?.textContent).toContain("Could not start the session");
    expect(failure?.textContent).toContain("engine did not start");
    expect(failure?.querySelector("button")?.textContent).toBe("Retry send");
  });
});
