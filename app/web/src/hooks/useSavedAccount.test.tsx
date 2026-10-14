// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useSavedAccount } from "./useSavedAccount.ts";

/**
 * The account picked for new sessions is saved as the next default; one an
 * agent definition chose is the draft's (`docs/agent-definitions.md` "UI").
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let saved: string[] = [];
let controls: {
  pick: (id: string) => void;
  agentPick: (id: string) => void;
} | null = null;

function Accounts() {
  const [accountId, setAccountId] = useState("claude-work");
  const [savedAccountId, setSavedAccountId] = useState("claude-work");
  const { markAgentAccount, clearAgentAccount } = useSavedAccount({
    accountId,
    savedAccountId,
    save: (id) => {
      saved.push(id);
      setSavedAccountId(id);
    },
  });
  controls = {
    pick: (id) => {
      clearAgentAccount();
      setAccountId(id);
    },
    agentPick: (id) => {
      markAgentAccount(id);
      setAccountId(id);
    },
  };
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  saved = [];
  root = createRoot(document.createElement("div"));
  act(() => root!.render(<Accounts />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it("saves an explicit pick", () => {
  act(() => controls!.pick("openai-work"));
  expect(saved).toEqual(["openai-work"]);
});

it("does not save the account an agent pick chose", () => {
  act(() => controls!.agentPick("openai-work"));
  expect(saved).toEqual([]);
});

it("saves the same account once the user picks it", () => {
  act(() => controls!.agentPick("openai-work"));
  act(() => controls!.pick("openai-work"));
  expect(saved).toEqual(["openai-work"]);
});
