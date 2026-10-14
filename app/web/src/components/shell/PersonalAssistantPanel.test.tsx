// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalAssistantPanel } from "./PersonalAssistantPanel.tsx";

const fixture = vi.hoisted(() => ({
  state: {
    connected: true,
    session: null as { sessionId: string } | null,
    messages: [],
    timeline: [],
    streaming: false,
    runProgress: null,
    settings: { appearance: {} },
    sessions: [],
    models: [],
    contextInfo: null,
    slashCommands: [],
    timelineStart: 0,
    timelineRangePending: null,
  },
  actions: {
    openPermanentAssistant: vi.fn(),
    releasePermanentAssistant: vi.fn(),
  },
}));
vi.mock("../../hooks/useAssistant.ts", () => ({ useAssistant: () => fixture }));
vi.mock("../Composer.tsx", () => ({ Composer: () => null }));
vi.mock("../MessageList.tsx", () => ({
  MessageList: function RetainedTranscript() {
    const [expanded, setExpanded] = useState(false);
    return (
      <button onClick={() => setExpanded(true)}>
        {expanded ? "Expanded history" : "Collapsed history"}
      </button>
    );
  },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fixture.state.connected = true;
  fixture.state.session = null;
  fixture.actions.openPermanentAssistant.mockClear();
  fixture.actions.releasePermanentAssistant.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (visible: boolean) =>
  root.render(<PersonalAssistantPanel visible={visible} />);

it("releases and reopens the server reader without remounting expanded transcript rows", async () => {
  await act(async () => render(true));
  expect(fixture.actions.openPermanentAssistant).toHaveBeenCalledTimes(1);
  fixture.state.session = { sessionId: "pa" };
  await act(async () => render(true));
  const transcript = container.querySelector("button")!;
  await act(async () => transcript.click());
  await act(async () => render(false));
  expect(fixture.actions.releasePermanentAssistant).toHaveBeenCalledWith("pa");
  expect(container.textContent).toContain("Expanded history");
  await act(async () => render(true));
  expect(fixture.actions.openPermanentAssistant).toHaveBeenCalledTimes(2);
  expect(container.querySelector("button")).toBe(transcript);
  expect(container.textContent).toContain("Expanded history");
});

it("releases a late open response that arrives after the panel is hidden", async () => {
  await act(async () => render(true));
  await act(async () => render(false));
  expect(fixture.actions.releasePermanentAssistant).not.toHaveBeenCalled();
  fixture.state.session = { sessionId: "pa" };
  await act(async () => render(false));
  expect(fixture.actions.releasePermanentAssistant).toHaveBeenCalledWith("pa");
});

it("reopens on reconnect only while visible", async () => {
  await act(async () => render(true));
  fixture.state.connected = false;
  await act(async () => render(true));
  fixture.state.connected = true;
  await act(async () => render(true));
  expect(fixture.actions.openPermanentAssistant).toHaveBeenCalledTimes(2);
  fixture.state.connected = false;
  await act(async () => render(false));
  fixture.state.session = { sessionId: "pa" };
  fixture.state.connected = true;
  await act(async () => render(false));
  expect(fixture.actions.openPermanentAssistant).toHaveBeenCalledTimes(2);
  expect(fixture.actions.releasePermanentAssistant).toHaveBeenCalledWith("pa");
});
