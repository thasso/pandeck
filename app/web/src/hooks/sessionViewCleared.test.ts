import { describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceAssistantState,
  type UIState,
} from "./useAssistant.ts";

function viewedState(sessionId: string): UIState {
  return {
    ...createInitialState(),
    session: { sessionId } as UIState["session"],
    contextInfo: { sessionId } as UIState["contextInfo"],
    historySessionId: sessionId,
    timeline: [{ id: "entry-1" }] as UIState["timeline"],
    liveStreams: [
      {
        streamId: "stream-1",
        kind: "message",
        role: "assistant",
        content: [],
      },
    ],
    approvals: [{ id: "approval-1" }] as UIState["approvals"],
    runState: "running",
    streaming: true,
  };
}

describe("sessionViewCleared", () => {
  it("returns the viewed chat to a sessionless staged surface", () => {
    const next = reduceAssistantState(viewedState("s1"), {
      kind: "server",
      msg: { type: "sessionViewCleared", sessionId: "s1", reason: "archived" },
    });

    expect(next.session).toBeNull();
    expect(next.viewCleared).toEqual({ sessionId: "s1", reason: "archived" });
    expect(next.contextInfo).toBeNull();
    expect(next.historySessionId).toBeNull();
    expect(next.timeline).toEqual([]);
    expect(next.liveStreams).toEqual([]);
    expect(next.approvals).toEqual([]);
    expect(next.runState).toBe("idle");
    expect(next.streaming).toBe(false);
  });

  it("leaves the chat alone for a session not on show, but records the clear for the route", () => {
    // A session this connection was only LOADING (deleted elsewhere, or a load
    // the archive superseded): nothing to clear here — the route may still
    // name it, though, and learns from the record.
    const state = viewedState("newer");
    const next = reduceAssistantState(state, {
      kind: "server",
      msg: {
        type: "sessionViewCleared",
        sessionId: "older",
        reason: "deleted",
      },
    });

    expect(next.viewCleared).toEqual({ sessionId: "older", reason: "deleted" });
    expect({ ...next, viewCleared: null }).toEqual({
      ...state,
      viewCleared: null,
    });
  });
});
