// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  ApprovalGrantsRequestBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

/**
 * An up-front grant request card: one row per key with its scope, card-only
 * operations marked, an optional cap raise, and no "Approve for session" —
 * only the click approves it. Edits travel with Approve, only when changed.
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
  return [...container!.querySelectorAll("button")]
    .filter((element) => element.getAttribute("role") !== "checkbox")
    .map((element) => (element.textContent ?? "").trim());
}

function button(label: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  return match!;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function checkbox(id: string): Element {
  const match = container!.querySelector(`#${CSS.escape(id)}`);
  expect(match, `no checkbox ${id}`).not.toBeNull();
  return match!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const body: ApprovalGrantsRequestBody = {
  kind: "approvalGrantsRequest",
  reason: "Delivering **Task-1** overnight",
  items: [
    {
      key: "jira:edit",
      label: "Jira: edit issues",
      covers: "Change fields on any issue.",
      cardOnly: false,
      inheritable: false,
    },
    {
      key: "managedPullRequestMerge",
      label: "Merge into the default branch",
      covers: "Merge a managed worktree's pull request.",
      cardOnly: true,
      inheritable: true,
    },
  ],
  peerTurnCap: { current: 4, requested: 8 },
};

const pending: ApprovalCardData = {
  renderKind: "approval",
  id: "ap_req",
  sessionId: "session-1",
  kind: "approvalGrantsRequest",
  status: "pending",
  title: "Allow 2 grants and up to 8 concurrent peer turns for this session",
  createdAt: 0,
  body,
};

test("lists each key with its covers text and marks card-only ones, without Approve for session", () => {
  render(<ApprovalCard approval={pending} onResolve={vi.fn()} />);
  const text = container!.textContent ?? "";
  expect(text).toContain("Change fields on any issue.");
  expect(text).toContain("Card-only");
  expect(text).toMatch(
    /Normally approved one card at a time\. Approving grants it without asking for this session and the sessions it starts\./,
  );
  expect(text).toContain("Concurrent peer turns: 4 →");
  expect(container!.querySelector("strong")?.textContent).toBe("Task-1");
  expect(buttonLabels()).toEqual(["Reject", "Approve"]);
});

test("Approve as requested carries no edits", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={pending} onResolve={onResolve} />);
  click(button("Approve"));
  expect(onResolve).toHaveBeenCalledWith(
    "ap_req",
    "approved",
    undefined,
    false,
    false,
  );
});

test("unticking, per-key scope, the all-scope control and the cap become the edits", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={pending} onResolve={onResolve} />);
  click(checkbox("grants-request-all-scope"));
  click(checkbox("grants-request-scope-managedPullRequestMerge"));
  click(checkbox("grants-request-cap"));
  click(button("Approve"));
  expect(onResolve).toHaveBeenLastCalledWith(
    "ap_req",
    "approved",
    {
      kind: "approvalGrantsRequest",
      keys: [
        { key: "jira:edit", inheritable: true },
        { key: "managedPullRequestMerge", inheritable: false },
      ],
    },
    false,
    false,
  );
});

test("Approve is disabled once nothing is ticked", () => {
  render(<ApprovalCard approval={pending} onResolve={vi.fn()} />);
  click(checkbox("grants-request-jira:edit"));
  click(checkbox("grants-request-managedPullRequestMerge"));
  expect(button("Approve").disabled).toBe(false);
  click(checkbox("grants-request-cap"));
  expect(button("Approve").disabled).toBe(true);
});

const result = {
  granted: [{ key: "jira:edit", inheritable: true }],
  declined: ["managedPullRequestMerge"],
};

test("an executed card lists the outcome and offers Revoke for the grants it made", () => {
  const onRevokeGrant = vi.fn();
  render(
    <ApprovalCard
      approval={{
        ...pending,
        status: "executed",
        decision: "approved",
        resultSummary: "Granted: jira:edit (also sessions it starts).",
        body: {
          ...body,
          result: {
            ...result,
            peerTurnCap: { outcome: "raised", from: 4, to: 8 },
          },
        },
      }}
      grants={[
        {
          key: "jira:edit",
          grantedAt: 1,
          sourceApprovalId: "ap_req",
          inheritable: true,
        },
        {
          key: "jira:comment",
          grantedAt: 1,
          sourceApprovalId: "other",
          inheritable: false,
        },
      ]}
      onRevokeGrant={onRevokeGrant}
    />,
  );
  const text = container!.textContent ?? "";
  expect(text).toContain("granted for this session and the sessions it starts");
  expect(text).toContain("not granted");
  expect(text).toContain("raised from 4 to 8");
  click(button("Revoke"));
  expect(onRevokeGrant.mock.calls).toEqual([["session-1", "jira:edit"]]);
});

test("a failed card shows what was granted and the cap error", () => {
  render(
    <ApprovalCard
      approval={{
        ...pending,
        status: "failed",
        decision: "approved",
        error: "Granted: jira:edit. Peer turn cap not raised: gone",
        body: {
          ...body,
          result: {
            ...result,
            peerTurnCap: { outcome: "failed", error: "gone" },
          },
        },
      }}
    />,
  );
  const text = container!.textContent ?? "";
  expect(text).toContain("granted for this session and the sessions it starts");
  expect(text).toContain("not raised: gone");
  expect(text).toContain("Peer turn cap not raised: gone");
});

test("a rejected card offers no Revoke", () => {
  render(
    <ApprovalCard
      approval={{ ...pending, status: "rejected", decision: "rejected" }}
      grants={[
        {
          key: "jira:edit",
          grantedAt: 1,
          sourceApprovalId: "ap_req",
          inheritable: false,
        },
      ]}
      onRevokeGrant={vi.fn()}
    />,
  );
  expect(buttonLabels()).not.toContain("Revoke");
});
