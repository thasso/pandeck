/**
 * The reducer half of the inspector's account picker (Task-1415): only the
 * latest list answer lands, a move's control is pending until its own answer
 * or a lost connection, and a refusal is the session's failure.
 *   pnpm --filter @assistant/web test src/hooks/accountMoveState.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@assistant/shared";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";
import { dataOf, errorOf, isPending } from "../lib/loadState.ts";

type State = ReturnType<typeof createInitialState>;

const server = (state: State, msg: ServerMessage) =>
  reduceAssistantState(state, { kind: "server", msg });

const listed = (requestId: string, sessionId = "s1"): ServerMessage => ({
  type: "sessionAccountMoveTargets",
  requestId,
  sessionId,
  accounts: [{ id: `cp-${requestId}`, name: requestId, enterprise: false }],
});

describe("the account picker's state", () => {
  it("takes only the latest list request's answer", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "accountMoveTargetsRequested",
      sessionId: "s1",
      requestId: "old",
    });
    state = reduceAssistantState(state, {
      kind: "accountMoveTargetsRequested",
      sessionId: "s2",
      requestId: "new",
    });
    expect(isPending(state.accountMoveTargets!.targets)).toBe(true);

    state = server(state, listed("old"));
    expect(isPending(state.accountMoveTargets!.targets)).toBe(true);

    state = server(state, listed("new", "s2"));
    expect(state.accountMoveTargets!.sessionId).toBe("s2");
    expect(dataOf(state.accountMoveTargets!.targets)).toEqual([
      { id: "cp-new", name: "new", enterprise: false },
    ]);

    state = reduceAssistantState(state, {
      kind: "accountMoveTargetsRequested",
      sessionId: "s2",
      requestId: "again",
    });
    state = server(state, {
      type: "sessionAccountMoveTargets",
      requestId: "again",
      sessionId: "s2",
      error: "This session has no model to move with.",
    });
    expect(errorOf(state.accountMoveTargets!.targets)).toBe(
      "This session has no model to move with.",
    );
  });

  it("keeps a move pending until its own answer, which puts a refusal on the session", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "accountMoveSent",
      sessionId: "s1",
      requestId: "m2",
    });
    expect(state.accountMovePending).toEqual({ s1: "m2" });

    // An answer to an earlier move does not retire the one in flight.
    state = server(state, {
      type: "sessionAccountMoveAnswer",
      requestId: "m1",
      sessionId: "s1",
    });
    expect(state.accountMovePending).toEqual({ s1: "m2" });

    state = server(state, {
      type: "sessionAccountMoveAnswer",
      requestId: "m2",
      sessionId: "s1",
      error: "Account B needs login.",
    });
    expect(state.accountMovePending).toEqual({});
    expect(state.sessionFailures.s1).toBe("Account B needs login.");
  });

  it("retires the pending controls when the connection drops", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "accountMoveSent",
      sessionId: "s1",
      requestId: "m1",
    });
    state = reduceAssistantState(state, {
      kind: "accountMoveTargetsRequested",
      sessionId: "s1",
      requestId: "l1",
    });
    state = reduceAssistantState(state, { kind: "status", connected: false });
    expect(state.accountMovePending).toEqual({});
    expect(errorOf(state.accountMoveTargets!.targets)).toBe(
      "The connection was lost before the accounts arrived.",
    );
  });

  it("keeps a successful move silent", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "accountMoveSent",
      sessionId: "s1",
      requestId: "m1",
    });
    state = server(state, {
      type: "sessionAccountMoveAnswer",
      requestId: "m1",
      sessionId: "s1",
    });
    expect(state.accountMovePending).toEqual({});
    expect(state.sessionFailures.s1).toBeUndefined();
  });
});
