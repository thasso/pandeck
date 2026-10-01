// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { ApprovalCard as ApprovalCardData } from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * "Approve for session": the card offers it beside Approve, a card the
 * session's grants cover waits without buttons, and the card that created a
 * grant is where it can be revoked again.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function buttonLabels(): string[] {
  return [...container!.querySelectorAll("button")].map((element) =>
    (element.textContent ?? "").trim(),
  );
}

function click(label: string): void {
  const match = [...container!.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  act(() => {
    match!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const pending: ApprovalCardData = {
  renderKind: "approval",
  id: "ap_1",
  sessionId: "session-1",
  kind: "githubPullRequest",
  status: "pending",
  title: "Comment on pull request",
  createdAt: 0,
  body: {
    kind: "githubPullRequest",
    operation: "comment",
    repo: "org/repo",
    pullNumber: 7,
    commentBody: "Looks good",
  },
};

test("Approve for session approves and asks for the session grant", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={pending} onResolve={onResolve} />);

  expect(buttonLabels()).toEqual(["Reject", "Approve for session", "Approve"]);
  click("Approve for session");

  expect(onResolve).toHaveBeenCalledWith("ap_1", "approved", undefined, true);
});

test("plain Approve does not ask for a grant", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={pending} onResolve={onResolve} />);

  click("Approve");

  expect(onResolve).toHaveBeenCalledWith("ap_1", "approved", undefined, false);
});

test("an auto-approved card waits without decision buttons", () => {
  render(
    <ApprovalCard
      approval={{ ...pending, autoApproved: true }}
      onResolve={() => {}}
    />,
  );

  expect(container!.textContent).toContain("Queued");
  expect(buttonLabels()).toEqual([]);
});

test("the card that granted an operation can revoke it", () => {
  const onRevokeGrant = vi.fn();
  render(
    <ApprovalCard
      approval={{
        ...pending,
        status: "executed",
        decision: "approved",
        grantedForSession: true,
      }}
      grants={[
        { key: "github:comment", grantedAt: 0, sourceApprovalId: "ap_1" },
        { key: "jira:edit", grantedAt: 0, sourceApprovalId: "ap_other" },
      ]}
      onRevokeGrant={onRevokeGrant}
    />,
  );

  expect(container!.textContent).toContain(
    "Approved for this session: GitHub PR: comment",
  );
  expect(container!.textContent).not.toContain("Jira: edit");
  click("Revoke");

  expect(onRevokeGrant).toHaveBeenCalledTimes(1);
  expect(onRevokeGrant).toHaveBeenCalledWith("session-1", "github:comment");
});
