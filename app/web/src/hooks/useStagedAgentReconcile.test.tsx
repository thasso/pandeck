// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { EntryLibraryList } from "@assistant/shared";
import {
  leftNewSessionPage,
  stagedSessionRecord,
  type StagedSessionRecord,
} from "../lib/stagedSession.ts";
import { useStagedAgentReconcile } from "./useStagedAgentReconcile.ts";

/**
 * The staged agent follows the agents list on the new-session page, and never
 * undoes what leaving the page spent (`docs/agent-definitions.md` "UI").
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNTS = [
  { id: "claude-work", provider: "claude" },
  { id: "claude-home", provider: "claude" },
];
const OPENAI_ONLY = [{ id: "openai-work", provider: "openai-codex" }];

function list(
  thinkingLevel: "high" | "low",
  persona: "developer" | "assistant" = "developer",
): EntryLibraryList {
  return {
    libraryPath: "/data/agents",
    entries: [
      {
        name: "test-reviewer",
        description: "Reviews tests.",
        path: "test-reviewer/AGENT.md",
      },
    ],
    diagnostics: [],
    agentRuntimes: {
      "test-reviewer": {
        persona,
        provider: "claude-sdk",
        modelId: "opus",
        thinkingLevel,
        models: [],
      },
    },
  };
}

const PICKED = stagedSessionRecord({
  id: "draft",
  harness: "claude-sdk",
  agentType: "developer",
  provider: "claude-sdk",
  modelId: "opus",
  thinkingLevel: "high",
  mode: "plan",
  agent: "test-reviewer",
});

let seen: StagedSessionRecord | null = null;
let seenAccount: string | undefined;

/** App's two writers of the record: leaving the page, then the reconcile. */
function Draft({
  onNewPage,
  agents,
  accounts = ACCOUNTS,
}: {
  onNewPage: boolean;
  agents: EntryLibraryList;
  accounts?: ReadonlyArray<{ id: string; provider: string }>;
}) {
  const [pendingStart, setPendingStart] = useState<StagedSessionRecord | null>(
    PICKED,
  );
  const [accountId, setAccountId] = useState<string>("claude-work");
  useEffect(() => {
    if (!onNewPage) setPendingStart(leftNewSessionPage);
  }, [onNewPage]);
  // App's account sync: an account that is gone falls back to the first.
  useEffect(() => {
    setAccountId((current) =>
      accounts.some((account) => account.id === current)
        ? current
        : (accounts[0]?.id ?? ""),
    );
  }, [accounts]);
  useStagedAgentReconcile({
    active: onNewPage,
    list: agents,
    pendingStart,
    setPendingStart,
    accounts,
    accountId,
    setAccountId,
  });
  seen = pendingStart;
  seenAccount = accountId;
  return null;
}

let root: Root | null = null;

beforeEach(() => {
  seen = null;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

it("restages a pick whose runtime changed, keeping the draft's id and Plan", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));
  expect(seen).toBe(PICKED);

  act(() => root!.render(<Draft onNewPage agents={list("low")} />));
  expect(seen).toMatchObject({
    id: "draft",
    thinkingLevel: "low",
    mode: "plan",
    agent: "test-reviewer",
  });
});

it("stops at the page, so it does not bring back what leaving it spent", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));

  // Navigation away and a changed runtime land in the same render.
  act(() => root!.render(<Draft onNewPage={false} agents={list("low")} />));
  expect(seen?.agent).toBeUndefined();
  expect(seen?.mode).toBeUndefined();
  expect(seen?.thinkingLevel).toBe("high");
});

it("drops a pick whose persona changed instead of switching the draft's persona", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));

  // A hand edit makes the definition an assistant: switching the draft would
  // change which worktree it needs, past a first send held for retry that
  // offers no picker to change it.
  act(() =>
    root!.render(<Draft onNewPage agents={list("high", "assistant")} />),
  );
  expect(seen?.agent).toBeUndefined();
  expect(seen).toMatchObject({ id: "draft", agentType: "developer" });
});

it("keeps the draft on an account of the definition's provider, or drops it", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));
  expect(seenAccount).toBe("claude-work");

  // The picked account is disabled; the next one is another provider's.
  const others = [OPENAI_ONLY[0]!, ACCOUNTS[1]!];
  act(() =>
    root!.render(<Draft onNewPage agents={list("high")} accounts={others} />),
  );
  expect(seenAccount).toBe("claude-home");
  expect(seen?.agent).toBe("test-reviewer");

  // No account of its provider is left.
  act(() =>
    root!.render(
      <Draft onNewPage agents={list("high")} accounts={OPENAI_ONLY} />,
    ),
  );
  expect(seen?.agent).toBeUndefined();
});
