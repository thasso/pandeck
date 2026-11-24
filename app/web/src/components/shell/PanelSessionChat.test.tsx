// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantActions, UIState } from "../../hooks/useAssistant.ts";
import type { SessionChatHost } from "../../hooks/useSessionChat.tsx";
import type { Composer } from "../Composer.tsx";
import type { MessageList } from "../MessageList.tsx";
import { PanelSessionChat } from "./PanelSessionChat.tsx";

const seen = vi.hoisted(() => ({
  transcript: null as ComponentProps<typeof MessageList> | null,
  composer: null as ComponentProps<typeof Composer> | null,
  realComposer: false,
}));
vi.mock("../MessageList.tsx", () => ({
  MessageList: (props: ComponentProps<typeof MessageList>) => {
    seen.transcript = props;
    return <div data-testid="transcript" />;
  },
}));
vi.mock("../Composer.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Composer.tsx")>();
  return {
    Composer: (props: ComponentProps<typeof Composer>) => {
      seen.composer = props;
      return seen.realComposer ? <actual.Composer {...props} /> : null;
    },
  };
});
// Presentation-only seam: expose the runtime panel while retaining the actual
// Panel -> SessionChat -> Composer -> ModelSelect wiring.
vi.mock("../ChatDockPanel.tsx", () => ({
  ChatDockPanel: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: string;
  }) => (title === "Runtime" ? <div>{children}</div> : null),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = {
  sessionId: "s1",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
} as NonNullable<UIState["session"]>;

function fixtureState(): UIState {
  return {
    connected: true,
    session: SESSION,
    messages: [],
    timeline: [],
    streaming: false,
    runProgress: null,
    models: [],
    settings: {
      appearance: {},
      models: { hidden: [], order: [] },
      speechToText: { enabled: false },
      speechConversation: {},
      speechSynthesis: {},
    },
    speechToText: null,
    slashCommands: [],
    contextInfo: null,
    timelineStart: 0,
    timelineRangePending: null,
    peerPromptCardOverrides: {},
    promptQueueStates: {},
    pullRequestCards: [],
    approvals: [],
    sessionFailures: {},
    backgroundWorkItems: [],
    liveStreams: [],
    skillLibrary: { status: "idle" },
    backgroundStopPending: [],
    backgroundStopAllPending: [],
  } as unknown as UIState;
}

const actions = {
  prompt: vi.fn(),
  forkSession: vi.fn(),
  createDraftSession: vi.fn(),
  setTopics: vi.fn(),
  resolveApproval: vi.fn(),
  respondToQuestion: vi.fn(),
  revealApproval: vi.fn(),
} as unknown as AssistantActions;

const onPanelSessionChange = vi.fn();
const onNavigate = vi.fn();
const onForkSession = vi.fn();
const host = {
  sessions: [],
  view: {},
  accountModels: [],
  credentialProfiles: [],
  onNavigate,
  onOpenSession: vi.fn(),
  onOpenTask: vi.fn(),
  onOpenBackgroundWork: vi.fn(),
  onOpenWorktree: vi.fn(),
  onPanelSessionChange,
  onForkSession,
} as unknown as SessionChatHost;

let container: HTMLDivElement;
let root: Root;

const render = (visible = true, state = fixtureState(), pinned = false) =>
  act(async () => {
    root.render(
      <PanelSessionChat
        state={state}
        actions={actions}
        session={state.session ?? SESSION}
        host={host}
        visible={visible}
        pinned={pinned}
        draftStorageKey="test.panel-draft"
        title="Title"
        onOpenInMain={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  seen.transcript = null;
  seen.composer = null;
  seen.realComposer = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

for (const bound of ["openai-compatible-0123456789ab", "default"]) {
  it(`actual panel Composer disables foreign model controls when started on ${bound}`, async () => {
    seen.realComposer = true;
    Element.prototype.scrollIntoView = vi.fn();
    const endpoint = "openai-compatible-0123456789ab";
    const options = [
      {
        provider: endpoint,
        id: "llama3",
        name: "Endpoint Llama",
        reasoning: false,
        contextWindow: 32000,
      },
      {
        provider: "openai-codex",
        id: "gpt",
        name: "OpenAI GPT",
        reasoning: false,
        contextWindow: 32000,
      },
    ];
    const state = {
      ...fixtureState(),
      models: options,
      session: { ...SESSION, model: options[bound === endpoint ? 0 : 1] },
      messages: [{ role: "user", content: "already started" }],
    } as unknown as UIState;
    const sessionHost = {
      ...host,
      sessions: [{ id: "s1", credentialProfileId: bound }],
      credentialProfiles: [
        {
          id: endpoint,
          name: "Endpoint account",
          provider: "openai-compatible",
          enabled: true,
        },
        {
          id: "default",
          name: "Default OpenAI",
          provider: "openai-codex",
          enabled: true,
        },
      ],
    } as unknown as SessionChatHost;
    await act(async () =>
      root.render(
        <PanelSessionChat
          state={state}
          actions={actions}
          session={state.session!}
          host={sessionHost}
          visible
          draftStorageKey={`picker-${bound}`}
          title="Started"
          onOpenInMain={() => {}}
        />,
      ),
    );
    const trigger = document.body.querySelector<HTMLButtonElement>(
      'button[title="Model"]',
    );
    expect(trigger).toBeTruthy();
    await act(async () => trigger!.click());
    const items = [...document.body.querySelectorAll('[role="option"]')];
    const endpointItem = items.find((item) =>
      item.textContent?.includes("Endpoint Llama"),
    );
    const openaiItem = items.find((item) =>
      item.textContent?.includes("OpenAI GPT"),
    );
    expect(endpointItem).toBeTruthy();
    expect(openaiItem).toBeTruthy();
    expect(endpointItem?.getAttribute("aria-disabled") === "true").toBe(
      bound !== endpoint,
    );
    expect(openaiItem?.getAttribute("aria-disabled") === "true").toBe(
      bound === endpoint,
    );
  });
}

it("lays the transcript in a flex column, the contract of its scroller", async () => {
  await render();
  const transcript = container.querySelector("[data-testid=transcript]");
  expect(transcript?.parentElement?.className).toContain("flex-col");
  expect(transcript?.parentElement?.className).toContain("min-h-0");
});

it("wires the center's approvals and questions to this connection", async () => {
  await render();
  expect(seen.transcript?.onResolveApproval).toBe(actions.resolveApproval);
  seen.transcript?.onRespondToQuestion?.({ requestId: "q" } as never);
  expect(actions.respondToQuestion).toHaveBeenCalledWith({ requestId: "q" });
});

it("sends a prompt to the session it shows and follows it", async () => {
  await render();
  const token = seen.transcript?.pinToBottomToken;
  await act(async () => seen.composer?.onSend("hello"));
  expect(actions.prompt).toHaveBeenCalledWith("hello", []);
  expect(seen.transcript?.pinToBottomToken).not.toBe(token);
});

it("refuses a send while the session's worktree is gone", async () => {
  const state = fixtureState();
  const session = { ...SESSION, worktreeMissing: true };
  await act(async () => {
    root.render(
      <PanelSessionChat
        state={{ ...state, session }}
        actions={actions}
        session={session}
        host={host}
        visible
        draftStorageKey="test.panel-draft"
        title="Title"
        onOpenInMain={() => {}}
      />,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(seen.composer?.disabled).toBe(true);
  seen.composer?.onSend("hello");
  expect(actions.prompt).not.toHaveBeenCalled();
});

it("claims the session's failures only while it is on screen", async () => {
  await render(false);
  expect(onPanelSessionChange).not.toHaveBeenCalled();
  await render(true);
  expect(onPanelSessionChange).toHaveBeenLastCalledWith("s1");
  await render(false);
  expect(onPanelSessionChange).toHaveBeenLastCalledWith(null);
});

it("lands a reveal of its own session here and sends any other to the main pane", async () => {
  await render(true, {
    ...fixtureState(),
    messageReveal: { token: 7, sessionId: "s1", entryId: "e1" },
  } as UIState);
  expect(seen.transcript?.focusEntry).toMatchObject({
    entryId: "e1",
    token: 7,
  });
  expect(onNavigate).not.toHaveBeenCalled();
  await render(true, {
    ...fixtureState(),
    messageReveal: { token: 8, sessionId: "s2", entryId: "e2" },
  } as UIState);
  expect(onNavigate).toHaveBeenCalledWith("/sessions/s2#m-e2");
});

it("forks on the main connection, so this panel stays on its session", async () => {
  await render();
  seen.transcript?.onForkMessage?.("e1", "at");
  expect(onForkSession).toHaveBeenCalledWith("s1", "e1", "at");
  expect(actions.forkSession).not.toHaveBeenCalled();
});

it("creates a draft on its own connection, unless pinned to its session", async () => {
  await render();
  expect(seen.transcript?.onCreateDraftSession).toBe(
    actions.createDraftSession,
  );
  await render(true, fixtureState(), true);
  expect(seen.transcript?.onCreateDraftSession).toBeUndefined();
});

it("subscribes the skills its composer describes, on its own connection", async () => {
  await render();
  expect(actions.setTopics).toHaveBeenLastCalledWith([]);
  const entries = [{ name: "deploy" }];
  await render(true, {
    ...fixtureState(),
    session: { ...SESSION, activeSkills: ["deploy"] },
    skillLibrary: { status: "ready", data: { entries } },
  } as unknown as UIState);
  expect(actions.setTopics).toHaveBeenLastCalledWith(["skills"]);
  expect(seen.composer?.skillSummaries).toEqual(entries);
});

describe("held inputs on the composer's queue strip", () => {
  // A `/skill` a pending runtime selection refused is kept by the SERVER as a
  // held input of the session (`PromptQueueState.held`). The strip offers it
  // back on every device and after every reload, Resend or fork, until the
  // user puts it back or discards it.
  const HELD = "/review-pr 412 --focus security";
  const KEY = "test.panel-draft";
  const queueActions = {
    ...actions,
    promptQueue: vi.fn(),
    retireSessionDraft: vi.fn(),
  } as unknown as AssistantActions;
  const withHeld = (
    held = [{ id: "h1", text: HELD, createdAt: 1 }],
    extra: Partial<UIState> = {},
  ) =>
    ({
      ...fixtureState(),
      session: {
        ...SESSION,
        agentType: "developer",
        promptQueue: { items: [], paused: false, held },
      },
      ...extra,
    }) as unknown as UIState;
  const show = (state: UIState) =>
    act(async () => {
      root.render(
        <PanelSessionChat
          state={state}
          actions={queueActions}
          session={state.session!}
          host={host}
          visible
          pinned={false}
          draftStorageKey={KEY}
          title="Title"
          onOpenInMain={() => {}}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const rows = () =>
    [...container.querySelectorAll<HTMLElement>("[data-held-input]")].map(
      (row) => row.textContent,
    );
  const field = () => container.querySelector("textarea")!;
  const click = async (id: string, label: string) => {
    const button = [
      ...container.querySelectorAll<HTMLButtonElement>(
        `[data-held-input="${id}"] button`,
      ),
    ].find((candidate) => candidate.textContent === label);
    if (!button) throw new Error(`no ${label} on ${id}`);
    await act(async () => button.click());
  };
  const removals = () =>
    vi
      .mocked(queueActions.promptQueue)
      .mock.calls.map(([command]) => command)
      .filter((command) => command.type === "removeHeldInput");

  beforeEach(() => {
    seen.realComposer = true;
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
  });

  it("lists every held input in order, with Put back and Discard", async () => {
    await show(
      withHeld([
        { id: "h1", text: "/first one", createdAt: 1 },
        { id: "h2", text: "/second one", createdAt: 2 },
      ]),
    );
    expect(rows()).toEqual([
      expect.stringContaining("/first one"),
      expect.stringContaining("/second one"),
    ]);
    expect(container.textContent).toContain("2 to put back");
  });

  it("Put back fills an empty field as is, and only then asks the server to drop it", async () => {
    let storedWhenRemoved: string | null = "unset";
    vi.mocked(queueActions.promptQueue).mockImplementation((command) => {
      if (command.type === "removeHeldInput")
        storedWhenRemoved = window.localStorage.getItem(KEY);
    });
    await show(withHeld());
    await click("h1", "Put back");
    expect(field().value).toBe(HELD);
    expect(removals()).toEqual([
      { type: "removeHeldInput", sessionId: "s1", id: "h1" },
    ]);
    expect(storedWhenRemoved).toBe(HELD);
  });

  it("Put back over newer text goes above it on its own line, never replacing it", async () => {
    window.localStorage.setItem(KEY, "typed since");
    await show(withHeld());
    await click("h1", "Put back");
    expect(field().value).toBe(`${HELD}\ntyped since`);
  });

  it("Discard asks the server to drop it and leaves the field alone", async () => {
    window.localStorage.setItem(KEY, "typed since");
    await show(withHeld());
    await click("h1", "Discard");
    expect(removals()).toEqual([
      { type: "removeHeldInput", sessionId: "s1", id: "h1" },
    ]);
    expect(field().value).toBe("typed since");
  });

  it("survives a Resend, a fork elsewhere and a reload: the server keeps offering it", async () => {
    // R2-A2-res2 paths 1-3: each replaced or lost the one browser-only slot
    // the command used to live in.
    await show(withHeld());
    // Resend (or any fork handoff) stages its own draft into this composer.
    await show(
      withHeld(undefined, {
        forkDraft: { sessionId: "s1", text: "resent prompt", token: 9 },
      }),
    );
    expect(field().value).toBe("resent prompt");
    expect(rows()).toEqual([expect.stringContaining(HELD)]);
    // A fork to another session moves the same slot elsewhere.
    await show(
      withHeld(undefined, {
        forkDraft: { sessionId: "other", text: "fork text", token: 10 },
      }),
    );
    expect(rows()).toEqual([expect.stringContaining(HELD)]);
    // Reload: a fresh mount from the server's session state.
    await act(async () => root.unmount());
    root = createRoot(container);
    await show(withHeld());
    expect(rows()).toEqual([expect.stringContaining(HELD)]);
    expect(removals()).toEqual([]);
    await click("h1", "Put back");
    expect(field().value).toBe(`${HELD}\nresent prompt`);
  });
});
