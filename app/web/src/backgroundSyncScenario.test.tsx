// @vitest-environment jsdom
/**
 * The `background` topic through the real socket effect and the replica
 * transport: the subscribe asks for a snapshot, the snapshot sets the sequence
 * baseline, a continuing batch applies quietly, a gap resubscribes while its
 * batch still applies, and a later snapshot rebaselines. Unlike Projects and
 * Initiatives, a gap resubscribes even after the client dropped the topic.
 *   pnpm --filter @assistant/web test src/backgroundSyncScenario.test.tsx
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackgroundWorkItemSummary,
  ServerMessage,
} from "@assistant/shared";
import { useAssistant, type UIState } from "./hooks/useAssistant.ts";
import { FakeSocket } from "./test/fakeSocket.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function work(id: string, label = "pnpm run build"): BackgroundWorkItemSummary {
  return {
    id,
    ownerSessionId: "owner-a",
    backend: "host-process",
    kind: "shell",
    label,
    state: "running",
    stopState: "none",
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    deadlineAt: 1_000,
    settingsGeneration: 1,
  };
}

let latestState: UIState;

function BackgroundHarness({ held = true }: { held?: boolean }) {
  const { actions, state } = useAssistant();
  latestState = state;
  useEffect(
    () => actions.setTopics(held ? ["background"] : []),
    [actions, held],
  );
  return null;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Background socket/reducer scenario", () => {
  it("baselines on each snapshot and resubscribes on a sequence gap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => root.render(<BackgroundHarness />));
    const socket = FakeSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
    });
    const subscribe = socket.sent.find(
      (message) =>
        message.type === "subscribe" && message.topics.includes("background"),
    );
    expect(subscribe).toBeDefined();
    expect(subscribe?.type === "subscribe" && subscribe.digests).toBeFalsy();

    await act(async () => {
      socket.receive({
        type: "backgroundWorkList",
        items: [work("a")],
        seq: 3,
        revisions: [{ id: "a", revision: 1 }],
      });
      socket.receive({
        type: "stateEvents",
        topic: "background",
        seq: 4,
        events: [
          { kind: "upsert", id: "a", revision: 2, item: work("a", "moved") },
        ],
      });
    });
    expect(latestState.backgroundWorkItems.map((row) => row.label)).toEqual([
      "moved",
    ]);
    expect(socket.sent.filter((m) => m.type === "unsubscribe")).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();

    const beforeGap = socket.sent.length;
    await act(async () => {
      socket.receive({
        type: "stateEvents",
        topic: "background",
        seq: 6,
        events: [{ kind: "delete", id: "a", revision: 3 }],
      });
    });
    expect(socket.sent.slice(beforeGap)).toEqual([
      { type: "unsubscribe", topics: ["background"] },
      { type: "subscribe", topics: ["background"] },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] background event gap: expected seq 5, got 6; resubscribing.",
    );
    // The gapped batch still applies; the resubscribe's snapshot settles it.
    expect(latestState.backgroundWorkItems).toEqual([]);

    const beforeSnapshot = socket.sent.length;
    await act(async () => {
      socket.receive({
        type: "backgroundWorkList",
        items: [work("b")],
        seq: 10,
        revisions: [{ id: "b", revision: 1 }],
      });
      socket.receive({
        type: "stateEvents",
        topic: "background",
        seq: 11,
        events: [
          { kind: "upsert", id: "b", revision: 2, item: work("b", "renamed") },
        ],
      });
    });
    // Judged against the snapshot's seq 10, not the gapped batch's 6.
    expect(socket.sent.slice(beforeSnapshot)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(latestState.backgroundWorkItems.map((row) => row.label)).toEqual([
      "renamed",
    ]);
  });

  it("resubscribes on a gap even after the client dropped the topic", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => root.render(<BackgroundHarness />));
    const socket = FakeSocket.instances[0]!;
    await act(async () => {
      socket.open();
      socket.receive(readyMessage());
      socket.receive({
        type: "backgroundWorkList",
        items: [work("a")],
        seq: 3,
        revisions: [{ id: "a", revision: 1 }],
      });
    });
    await act(async () => root.render(<BackgroundHarness held={false} />));
    expect(socket.sent.at(-1)).toEqual({
      type: "unsubscribe",
      topics: ["background"],
    });

    // A batch already in flight when the topic was dropped, after a gap.
    const beforeGap = socket.sent.length;
    await act(async () => {
      socket.receive({
        type: "stateEvents",
        topic: "background",
        seq: 5,
        events: [{ kind: "delete", id: "a", revision: 2 }],
      });
    });
    expect(socket.sent.slice(beforeGap)).toEqual([
      { type: "unsubscribe", topics: ["background"] },
      { type: "subscribe", topics: ["background"] },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[state-sync] background event gap: expected seq 4, got 5; resubscribing.",
    );
  });
});
