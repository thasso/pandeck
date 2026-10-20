import { expect, it } from "vitest";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

/** A session's compaction-window save: busy until answered; only the latest speaks. */
it("tracks the latest save per session and ignores a stale answer", () => {
  type Action = Parameters<typeof reduceAssistantState>[1];
  let state = createInitialState();
  const run = (action: unknown) =>
    (state = reduceAssistantState(state, action as Action));
  run({ kind: "compactionWindowRequested", sessionId: "s", requestId: "a" });
  run({ kind: "compactionWindowRequested", sessionId: "s", requestId: "b" });
  expect(state.compactionWindowEdits.s).toEqual({ requestId: "b", busy: true });
  run({
    kind: "compactionWindowAnswered",
    sessionId: "s",
    requestId: "a",
    error: "late",
  });
  expect(state.compactionWindowEdits.s).toEqual({ requestId: "b", busy: true });
  run({
    kind: "compactionWindowAnswered",
    sessionId: "s",
    requestId: "b",
    error: "refused",
  });
  expect(state.compactionWindowEdits.s).toEqual({
    requestId: "b",
    busy: false,
    error: "refused",
  });
});
