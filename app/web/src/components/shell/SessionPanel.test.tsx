// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionChatHost } from "../../hooks/useSessionChat.tsx";
import { SessionPanel } from "./SessionPanel.tsx";

const fixture = vi.hoisted(() => ({
  state: {
    connected: true,
    session: null as { sessionId: string } | null,
    unopenableSessions: {} as Record<string, string>,
    forkDraft: null as { sessionId: string; token: number } | null,
  },
  actions: { loadSession: vi.fn(), releaseSessionView: vi.fn() },
}));
vi.mock("../../hooks/useAssistant.ts", () => ({ useAssistant: () => fixture }));
vi.mock("./PanelSessionChat.tsx", async (original) => ({
  ...(await original<typeof import("./PanelSessionChat.tsx")>()),
  PanelSessionChat: ({ session }: { session: { sessionId: string } }) => (
    <div>Chat of {session.sessionId}</div>
  ),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const HOST = {
  sessions: [{ id: "s1", title: "First", updatedAt: 1 }],
} as unknown as SessionChatHost;

let container: HTMLDivElement;
let root: Root;

const onSelectSession = vi.fn();
const render = (sessionId: string | null, visible = true) =>
  act(async () =>
    root.render(
      <SessionPanel
        host={HOST}
        sessionId={sessionId}
        visible={visible}
        onSelectSession={(id) => onSelectSession(id)}
      />,
    ),
  );

beforeEach(() => {
  fixture.state.connected = true;
  fixture.state.session = null;
  fixture.state.unopenableSessions = {};
  fixture.state.forkDraft = null;
  onSelectSession.mockClear();
  fixture.actions.loadSession.mockClear();
  fixture.actions.releaseSessionView.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("asks for a session to show and views nothing until one is picked", async () => {
  await render(null);
  expect(container.textContent).toContain("Choose a session");
  expect(fixture.actions.loadSession).not.toHaveBeenCalled();
});

it("views the picked session on its own connection", async () => {
  await render("s1");
  expect(fixture.actions.loadSession).toHaveBeenCalledWith("s1");
  expect(container.textContent).toContain("Opening session");
  fixture.state.session = { sessionId: "s1" };
  await render("s1");
  expect(container.textContent).toContain("Chat of s1");
});

it("never shows the previous session under the new one's title", async () => {
  fixture.state.session = { sessionId: "old" };
  await render("s1");
  expect(container.textContent).not.toContain("Chat of");
  expect(container.textContent).toContain("Opening session");
});

it("releases the view while hidden and asks again when shown", async () => {
  fixture.state.session = { sessionId: "s1" };
  await render("s1");
  fixture.actions.loadSession.mockClear();
  await render("s1", false);
  expect(fixture.actions.releaseSessionView).toHaveBeenCalledWith("s1");
  expect(fixture.actions.loadSession).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Chat of s1");
  await render("s1");
  expect(fixture.actions.loadSession).toHaveBeenCalledWith("s1");
});

it("views the session again after the connection comes back", async () => {
  await render("s1");
  fixture.actions.loadSession.mockClear();
  fixture.state.connected = false;
  await render("s1");
  expect(fixture.actions.loadSession).not.toHaveBeenCalled();
  fixture.state.connected = true;
  await render("s1");
  expect(fixture.actions.loadSession).toHaveBeenCalledWith("s1");
});

it("says why a session cannot be opened", async () => {
  fixture.state.unopenableSessions = { s1: "It is gone." };
  await render("s1");
  expect(container.textContent).toContain("It is gone.");
  expect(container.textContent).not.toContain("Opening session");
});

it("goes with a new draft its connection moved to", async () => {
  fixture.state.session = { sessionId: "s1" };
  await render("s1");
  expect(onSelectSession).not.toHaveBeenCalled();
  fixture.state.session = { sessionId: "draft" };
  fixture.state.forkDraft = { sessionId: "draft", token: 1 };
  await render("s1");
  expect(onSelectSession).toHaveBeenCalledWith("draft");
});
