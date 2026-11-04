// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AssistantActions, UIState } from "../../hooks/useAssistant.ts";
import type { SessionChatHost } from "../../hooks/useSessionChat.tsx";
import type { Composer } from "../Composer.tsx";
import type { MessageList } from "../MessageList.tsx";
import { PanelSessionChat } from "./PanelSessionChat.tsx";

const seen = vi.hoisted(() => ({
  transcript: null as ComponentProps<typeof MessageList> | null,
  composer: null as ComponentProps<typeof Composer> | null,
}));
vi.mock("../MessageList.tsx", () => ({
  MessageList: (props: ComponentProps<typeof MessageList>) => {
    seen.transcript = props;
    return <div data-testid="transcript" />;
  },
}));
vi.mock("../Composer.tsx", () => ({
  Composer: (props: ComponentProps<typeof Composer>) => {
    seen.composer = props;
    return null;
  },
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
    backgroundStopPending: [],
    backgroundStopAllPending: [],
  } as unknown as UIState;
}

const actions = {
  prompt: vi.fn(),
  setTopics: vi.fn(),
  resolveApproval: vi.fn(),
  respondToQuestion: vi.fn(),
  revealApproval: vi.fn(),
} as unknown as AssistantActions;

const onPanelSessionChange = vi.fn();
const onNavigate = vi.fn();
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
} as unknown as SessionChatHost;

let container: HTMLDivElement;
let root: Root;

const render = (visible = true, state = fixtureState()) =>
  act(async () => {
    root.render(
      <PanelSessionChat
        state={state}
        actions={actions}
        session={SESSION}
        host={host}
        visible={visible}
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
      disconnect() {}
    },
  );
  seen.transcript = null;
  seen.composer = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

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
