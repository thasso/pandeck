import { expect, it } from "vitest";
import { createInitialState, reduceAssistantState } from "./useAssistant.ts";

it("replays and clears authoritative login alerts independently of object failures", () => {
  const initial = createInitialState();
  expect(initial.accountLoginAlerts).toEqual([]);
  const accounts = [
    { profileId: "a", name: "Claude Private", provider: "claude" as const },
  ];
  const state = reduceAssistantState(
    { ...initial, error: "other failure" },
    { kind: "server", msg: { type: "accountLoginAlerts", accounts } },
  );
  expect(state.accountLoginAlerts).toBe(accounts);
  expect(state.error).toBe("other failure");
  const cleared = reduceAssistantState(state, {
    kind: "server",
    msg: { type: "accountLoginAlerts", accounts: [] },
  });
  expect(cleared.accountLoginAlerts).toEqual([]);
  expect(cleared.error).toBe("other failure");
});
