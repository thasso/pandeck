// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  PullRequestCard as PullRequestCardData,
  WorkflowRunSummary,
} from "@assistant/shared";
import type {
  ClientWorkflowRunCard,
  ClientWorkflowRunDelivery,
} from "../hooks/useAssistant.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { PullRequestCard } from "./PullRequestCard.tsx";
import { WorkflowRunCard } from "./WorkflowRunCard.tsx";
import { CommitWorktreeDialog } from "./worktree/WorktreeDialogs.tsx";
import { DialogProvider } from "./common/dialogs.tsx";

/**
 * How a MUTATION says it is running (`app/web/docs/loading-states.md` R5,
 * Task-361 Phase 4).
 *
 * One rule, four surfaces: the control the user pressed spins, disables itself
 * and reports `aria-busy`, and NOTHING around it is hidden or replaced. The
 * failure mode this guards is the opposite reflex — swapping the card, the row
 * or the dialog for a spinner, which takes away the context the user needs to
 * decide what to do when the write comes back. The second half is where the
 * failure lands: a write that has a home on screen reports it there, as an
 * `ErrorNote` (`role="alert"`), never only as a toast.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

/** The one `<button>` whose trimmed text is exactly `label`. */
function button(label: string): HTMLButtonElement {
  const match = [...container!.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  return match as HTMLButtonElement;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const approval: ApprovalCardData = {
  renderKind: "approval",
  id: "ap_1",
  sessionId: "session-1",
  kind: "commit",
  status: "pending",
  title: "Commit changes",
  createdAt: 0,
  body: {
    kind: "commit",
    message: "Standardize busy states",
    files: ["app/web/src/components/ui/Button.tsx"],
  },
};

it("busies only the approval decision that was pressed, and keeps the proposal readable", () => {
  render(<ApprovalCard approval={approval} onResolve={() => undefined} />);

  click(button("Approve"));

  expect(button("Approve").getAttribute("aria-busy")).toBe("true");
  expect(button("Approve").disabled).toBe(true);
  // The other decision is off — one approval is one decision — but it is NOT
  // the thing that is running, so it does not claim to be.
  expect(button("Reject").disabled).toBe(true);
  expect(button("Reject").getAttribute("aria-busy")).toBe(null);
  // R5: the proposal itself stays on screen. Deciding to approve is not a
  // reason to take away what was approved.
  expect(container!.textContent).toContain("Standardize busy states");
});

it("puts a failed approval inline, as an alert, with the card intact", () => {
  render(
    <ApprovalCard
      approval={{ ...approval, status: "failed", error: "remote rejected it" }}
    />,
  );

  const alert = container!.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("remote rejected it");
  expect(container!.textContent).toContain("Standardize busy states");
});

const pullRequest: PullRequestCardData = {
  renderKind: "pullRequest",
  id: "pr_1",
  sessionId: "session-1",
  status: "open",
  createdAt: 0,
  updatedAt: 0,
  provider: "github",
  number: 42,
  title: "Add /pr",
  headBranch: "feature",
  baseBranch: "main",
  worktreeId: "wt-1",
  warnings: [],
  busyAction: "merge",
};
const { busyAction: _busyAction, ...idlePullRequest } = pullRequest;

it("busies the pull request action the SERVER is running, not the card", () => {
  render(
    <PullRequestCard pullRequest={pullRequest} onAction={() => undefined} />,
  );

  expect(button("Merge").getAttribute("aria-busy")).toBe("true");
  // Everything else is still there and still says what it would do — the card
  // is the reason the user can tell whether to wait or to update the branch.
  expect(button("Update with main").getAttribute("aria-busy")).toBe(null);
  expect(container!.textContent).toContain("feature");
  expect(container!.textContent).toContain("main");
});

it("busies a card action immediately, before the server reports it durable", () => {
  render(
    <PullRequestCard
      pullRequest={{
        ...idlePullRequest,
        pendingAction: "update-with-main",
      }}
      onAction={() => undefined}
    />,
  );

  expect(button("Update with main").getAttribute("aria-busy")).toBe("true");
  expect(button("Merge").getAttribute("aria-busy")).toBe(null);
});

it("drops a refused linked-Task overlay so its retry control returns", () => {
  const linkedTask = {
    id: "625",
    title: "Optimistic card action",
    status: "todo" as const,
    source: { createdBy: "user" as const },
    createdAt: 1,
    updatedAt: 1,
  };
  const merged = {
    ...idlePullRequest,
    status: "merged" as const,
    linkedTask,
  };
  render(
    <PullRequestCard
      pullRequest={{
        ...merged,
        pendingAction: "mark-task-done",
        optimisticLinkedTask: { ...linkedTask, status: "done" },
      }}
      onAction={() => undefined}
    />,
  );
  expect(container!.textContent).not.toContain("Mark Task-625 done");

  act(() => {
    root!.render(
      <PullRequestCard
        pullRequest={{ ...merged, actionError: "Server restarting." }}
        onAction={() => undefined}
      />,
    );
  });
  expect(button("Mark Task-625 done")).not.toBeNull();
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
    "restarting",
  );
});

it("renders a refused card action inline with its controls", () => {
  render(
    <PullRequestCard
      pullRequest={{
        ...idlePullRequest,
        actionError: "The branch is not contained in main.",
      }}
      onAction={() => undefined}
    />,
  );

  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
    "not contained",
  );
  expect(button("Merge")).not.toBeNull();
});

const workflowRun: WorkflowRunSummary = {
  id: "7",
  taskId: "370",
  recipeId: "code-delivery",
  recipeVersion: 4,
  branch: "t370-card",
  lifecycle: "completed",
  limits: { maxIterations: 3, maxReviewPasses: 1 },
  createdAt: 1,
  updatedAt: 2,
};

/** A finished run whose checkout is still there, so Clean up is offered. */
function deliveredRunCard(
  delivery: ClientWorkflowRunDelivery,
): ClientWorkflowRunCard {
  return {
    runId: "7",
    phase: "merge",
    iterationsUsed: 1,
    nextAction: "the run is complete",
    mergeDecisionReady: false,
    canRebaseAndReview: false,
    canRetry: false,
    canResume: false,
    pullRequest: {
      cardId: "pr-1",
      sessionId: "impl-1",
      number: 42,
      url: "https://example.test/pull/42",
      delivery,
    },
  };
}

function renderRun(delivery: ClientWorkflowRunDelivery) {
  return (
    <DialogProvider>
      <WorkflowRunCard
        run={workflowRun}
        card={deliveredRunCard(delivery)}
        sessions={[]}
        onOpenSession={() => undefined}
        onPause={() => undefined}
        onResume={() => undefined}
        onCancel={() => undefined}
        onDelete={() => undefined}
        onRetry={() => undefined}
        onAnswerCeiling={() => undefined}
        onRebaseAndReview={() => undefined}
        onMerge={() => undefined}
        onCleanUp={() => undefined}
      />
    </DialogProvider>
  );
}

it("busies a run's delivery control on the click, before the run list echoes it", () => {
  // The run's `busyAction` is the pull-request card's, re-projected onto the
  // run list and broadcast from there. Waiting for that echo is what made this
  // button look dead; the click's own overlay is what the user sees first.
  const host = render(
    renderRun({
      canMerge: false,
      canCleanUp: true,
      settleStillNeeded: false,
      pendingAction: "cleanup",
    }),
  );

  expect(button("Clean up").getAttribute("aria-busy")).toBe("true");
  expect(button("Clean up").disabled).toBe(true);
  // R5: what the click does is still spelled out beside it — a delivery is
  // finished from this block, so it may not empty itself while it runs.
  expect(host.textContent).toContain("settles the run itself");

  // The server's own answer takes the same control over, and says the same
  // thing: one action, one spinner, however many viewers.
  act(() => {
    root!.render(
      renderRun({
        canMerge: false,
        canCleanUp: true,
        settleStillNeeded: false,
        busyAction: "cleanup",
      }),
    );
  });
  expect(button("Clean up").getAttribute("aria-busy")).toBe("true");
  expect(button("Clean up").disabled).toBe(true);
});

it("shows the failure a pressed delivery control is still carrying, not the last one", () => {
  // The card clears its stored refusal only when the server dequeues the next
  // action, so this sentence is the PREVIOUS cleanup's — already answered by
  // the click that is running now.
  const stale = {
    canMerge: false,
    canCleanUp: true,
    settleStillNeeded: false,
    error: "main does not contain t370-card yet.",
  } satisfies ClientWorkflowRunDelivery;
  const host = render(renderRun({ ...stale, pendingAction: "cleanup" }));
  expect(host.querySelector('[role="alert"]')).toBeNull();

  // Hidden, never dropped: once the click stops owning the control, whatever
  // failure the card is carrying is the one that stands.
  act(() => root!.render(renderRun(stale)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "does not contain t370-card",
  );
});

it("busies a dialog's confirm button and leaves the dialog usable", () => {
  const host = render(
    <CommitWorktreeDialog
      busy
      error="pre-commit hook failed"
      onCommit={() => undefined}
      onClose={() => undefined}
    />,
  );

  expect(button("Commit").getAttribute("aria-busy")).toBe("true");
  expect(button("Commit").disabled).toBe(true);
  // The message the commit is running with stays editable-looking and present;
  // the failure is an alert in the dialog, where the retry is.
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "pre-commit hook failed",
  );
});
