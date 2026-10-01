// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type {
  AccountModelOption,
  ApprovalCard as ApprovalCardData,
  ApprovalResolutionEdits,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * The session-spawn card is the human's model authority
 * ([Task-553](pa://task/553)), so what matters here is that the card stays the
 * agent's PROPOSAL while the user's changes ride along with Approve — a card
 * that mutated as they clicked would make "what was proposed" unreadable after
 * a reload.
 */

const models: AccountModelOption[] = [
  {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Claude Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
    credentialProfileId: "claude-default",
    accountName: "Work",
  },
];

const card = (patch: Partial<ApprovalCardData> = {}): ApprovalCardData => ({
  renderKind: "approval",
  id: "appr_1",
  sessionId: "spawner",
  kind: "sessionSpawn",
  status: "pending",
  title: "Start 2 sessions",
  createdAt: Date.now(),
  body: {
    kind: "sessionSpawn",
    items: [
      {
        rowId: "row_a",
        title: "Reviewer: auth",
        agentType: "assistant",
        prompt: "Review the auth refactor.",
        responseRequested: true,
        provider: "claude-sdk",
        modelId: "sonnet",
        modelName: "Claude Sonnet",
        credentialProfileId: "claude-default",
        accountName: "Work",
        thinkingLevel: "medium",
      },
      {
        rowId: "row_b",
        title: "Implementer: auth",
        agentType: "developer",
        prompt: "Implement the auth refactor.",
        responseRequested: false,
        provider: "claude-sdk",
        modelId: "opus",
        credentialProfileId: "claude-default",
        thinkingLevel: "high",
        modelWarning:
          "claude-sdk/opus-9 is not available on any enabled account.",
        worktreeId: "wt-1",
        worktreeName: "auth-refactor",
        taskId: "553",
        taskTitle: "Agent-spawned peer sessions",
      },
    ],
  },
  ...patch,
});

let host: HTMLDivElement;
let root: Root;
const resolved: Array<{
  decision: string;
  edits: ApprovalResolutionEdits | undefined;
}> = [];

function render(data: ApprovalCardData) {
  act(() => {
    root.render(
      <ApprovalCard
        approval={data}
        accountModels={models}
        onResolve={(_id, decision, edits) => resolved.push({ decision, edits })}
      />,
    );
  });
}

const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === label,
  );

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  resolved.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("shows every proposed session, its target and its runtime", () => {
  render(card());

  expect(host.textContent).toContain("Reviewer: auth");
  expect(host.textContent).toContain("Implementer: auth");
  expect(host.textContent).toContain("auth-refactor");
  expect(host.textContent).toContain("Task-553");
  expect(host.textContent).toContain("is not available on any enabled account");
});

test("the opening message is collapsed until asked for", () => {
  render(card());

  expect(host.textContent).not.toContain("Review the auth refactor.");
  act(() => button("more…")?.click());
  expect(host.textContent).toContain("Review the auth refactor.");
});

test("approving with no changes sends no edits", () => {
  render(card());

  act(() => button("Approve")?.click());

  expect(resolved).toEqual([{ decision: "approved", edits: undefined }]);
});

test("a skipped row rides along with the approval, leaving the card untouched", () => {
  const data = card();
  render(data);

  act(() => button("Skip")?.click());
  act(() => button("Approve")?.click());

  expect(resolved[0]?.edits).toEqual({
    kind: "sessionSpawn",
    items: [{ rowId: "row_a", skip: true }],
  });
  // The proposal itself never changed — only the decision carried the edit.
  expect(data.body.kind === "sessionSpawn" && data.body.items[0]?.skipped).toBe(
    undefined,
  );
});

test("a resolved card no longer offers the controls", () => {
  render(card({ status: "executed", resultSummary: "Spawned 2 sessions" }));

  expect(button("Approve")).toBeUndefined();
  expect(button("Skip")).toBeUndefined();
});

test("a refused decision re-enables Approve as soon as the card comes back", () => {
  render(card());
  act(() => button("Approve")?.click());
  expect(button("Approve")?.disabled).toBe(true);

  // The server refused (a withdrawn model, a rejected edit) and re-sent the
  // card, still pending. "Fix it and approve again" is a designed flow, so the
  // buttons must come back with the error, not 15 seconds later.
  render(card());

  expect(button("Approve")?.disabled).toBe(false);
  expect(button("Reject")?.disabled).toBe(false);
});

test("the Task is shown by title, not by a bare id", () => {
  render(card());

  expect(host.textContent).toContain("Task-553: Agent-spawned peer sessions");
});

test("a stand-in model lends its ladder but never its account name", () => {
  // The row's own account is gone, but the same model is offered on another.
  // That is enough to know the thinking ladder and not enough to claim the row
  // runs on "Other" — display must stay with what the server resolved.
  const other: AccountModelOption = {
    ...models[0]!,
    credentialProfileId: "other-account",
    accountName: "Other",
  };
  act(() => {
    root.render(
      <ApprovalCard
        approval={card({ status: "executed" })}
        accountModels={[other]}
        onResolve={() => undefined}
      />,
    );
  });

  expect(host.textContent).toContain("Work");
  expect(host.textContent).not.toContain("Other");
});

test("thinking is locked, not silently downgraded, when no model matches", () => {
  // Row B is on `opus`, which this account list does not offer — the ladder is
  // unknown, and an open picker would offer only `off`.
  render(card());

  const thinking = [...host.querySelectorAll("button")].filter((element) =>
    /thinking/i.test(element.getAttribute("title") ?? ""),
  );
  expect(thinking).toHaveLength(2);
  expect(thinking[0]?.disabled).toBe(false);
  expect(thinking[1]?.disabled).toBe(true);
});
