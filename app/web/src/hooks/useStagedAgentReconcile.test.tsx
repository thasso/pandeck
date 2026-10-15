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

/** App's two writers of the record: leaving the page, then the reconcile. */
function Draft({
  onNewPage,
  agents,
}: {
  onNewPage: boolean;
  agents: EntryLibraryList;
}) {
  const [pendingStart, setPendingStart] = useState<StagedSessionRecord | null>(
    PICKED,
  );
  useEffect(() => {
    if (!onNewPage) setPendingStart(leftNewSessionPage);
  }, [onNewPage]);
  useStagedAgentReconcile({
    active: onNewPage,
    list: agents,
    pendingStart,
    setPendingStart,
  });
  seen = pendingStart;
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

it("leaves the runtime alone when the definition's changes: the pickers stand", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));
  expect(seen).toBe(PICKED);

  act(() => root!.render(<Draft onNewPage agents={list("low")} />));
  expect(seen).toBe(PICKED);
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

it("drops a pick whose definition is gone", () => {
  act(() => root!.render(<Draft onNewPage agents={list("high")} />));
  act(() =>
    root!.render(
      <Draft
        onNewPage
        agents={{ ...list("high"), entries: [], agentRuntimes: {} }}
      />,
    ),
  );
  expect(seen?.agent).toBeUndefined();
  expect(seen).toMatchObject({ id: "draft", modelId: "opus", mode: "plan" });
});
