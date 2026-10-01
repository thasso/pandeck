// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SessionListItem,
  TaskSummary,
  WorkflowRunCard,
  WorkflowRunSummary,
} from "@assistant/shared";
import { SessionInbox } from "./SessionInbox.tsx";

/**
 * A live Workflow Run is ONE item of this browser ([Task-676](pa://task/676)),
 * and what these tests hold is the other half of that promise: the run leads to
 * itself on its Task, and every session it folded away is still a real row —
 * findable, focusable and openable — rather than a session that disappeared.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

const NOW = 1_800_000_000_000;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function session(
  id: string,
  extra: Partial<SessionListItem> = {},
): SessionListItem {
  return {
    id,
    harness: "pi",
    agentType: "assistant",
    title: `Session ${id}`,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    messageCount: 2,
    ...extra,
  } as SessionListItem;
}

const run: WorkflowRunSummary = {
  id: "r1",
  taskId: "676",
  recipeId: "code-delivery",
  recipeVersion: 1,
  lifecycle: "active",
  limits: { maxIterations: 3, maxReviewPasses: 2 },
  createdAt: NOW - 3_600_000,
  updatedAt: NOW - 30_000,
};

const card: WorkflowRunCard = {
  runId: "r1",
  phase: "review",
  activity: "running",
  iterationsUsed: 1,
  nextAction: "Start the second review pass.",
  mergeDecisionReady: false,
  canRebaseAndReview: false,
  canRetry: false,
  canResume: true,
  coordinatorSessionId: "coord",
  implementerSessionId: "impl",
  reviewerSessions: [{ pass: 1, sessionId: "rev-1" }],
};

const task = {
  id: "676",
  title: "Surface live Workflow Runs",
  status: "doing",
  createdAt: 1,
  updatedAt: 2,
} as TaskSummary;

const roleSessions = [
  session("coord", { title: "Coordination" }),
  session("impl", { title: "Implementation", isStreaming: true }),
  session("rev-1", { title: "First review pass" }),
];

interface Handlers {
  onSelect?: (id: string) => void;
  onOpenWorkflowRun?: (taskId: string, runId: string) => void;
  onSettleWorkflowRun?: (runId: string, throughRevision: number) => void;
}

function render(
  sessions: SessionListItem[],
  runs: WorkflowRunSummary[],
  cards: Record<string, WorkflowRunCard>,
  handlers: Handlers = {},
) {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => {
    root!.render(
      <SessionInbox
        sessions={sessions}
        archivedSessionCount={0}
        archivedSessionsLoaded
        onOpenBackgroundTasks={() => {}}
        currentId={undefined}
        readCurrentId={undefined}
        projects={[]}
        worktrees={[]}
        tasks={[task]}
        workflowRuns={runs}
        workflowCards={cards}
        worktreeStatuses={{}}
        animateListChanges={false}
        density="tight"
        onSelect={handlers.onSelect ?? (() => {})}
        onSettle={() => {}}
        onArchive={() => {}}
        onDeleteSession={() => {}}
        onRenameSession={() => {}}
        onLoadArchivedSessions={() => {}}
        onOpenProject={() => {}}
        onOpenTask={() => {}}
        onOpenWorkflowRun={handlers.onOpenWorkflowRun ?? (() => {})}
        onSettleWorkflowRun={handlers.onSettleWorkflowRun ?? (() => {})}
        onOpenWorktree={() => {}}
      />,
    );
  });
}

function rowIds(): string[] {
  return [
    ...container!.querySelectorAll<HTMLElement>("[data-list-row-id]"),
  ].map((element) => element.dataset.listRowId as string);
}

function row(id: string): HTMLElement {
  const found = container!.querySelector<HTMLElement>(
    `[data-list-row-id="${id}"]`,
  );
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function press(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function button(label: string): HTMLElement {
  const found = [...container!.querySelectorAll<HTMLElement>("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.getAttribute("title") === label,
  );
  if (!found) throw new Error(`no button “${label}”`);
  return found;
}

/** The run card's spoken label: the state sentence its front leaves out. */
function runLabel(runId: string): string {
  return (
    container!
      .querySelector(`[data-list-row-id="run:${runId}"]`)
      ?.getAttribute("aria-label") ?? ""
  );
}

describe("SessionInbox Workflow Run items", () => {
  it("spends one item on a run and none on the sessions it owns", () => {
    render(roleSessions, [run], { r1: card });
    expect(container!.querySelectorAll("[data-inbox-card]")).toHaveLength(1);
    expect(rowIds()).toEqual(["run:r1"]);
    // The run is named by the Task it works on; what it will do next is in
    // its spoken label, and the fold counts its sessions.
    expect(container!.textContent).toContain("Surface live Workflow Runs");
    expect(runLabel("r1")).toContain("Start the second review pass.");
    expect(container!.textContent).toContain("3 sessions");
  });

  it("names the pull request its owning role session reports", () => {
    const withPr = (state: "pending" | "failure") =>
      roleSessions.map((row) =>
        row.id === "impl"
          ? {
              ...row,
              pullRequest: {
                status: "open" as const,
                number: 9,
                ci: { state, total: 4 },
              },
            }
          : row,
      );
    const prCard: WorkflowRunCard = {
      ...card,
      pullRequest: {
        cardId: "c9",
        sessionId: "impl",
        number: 9,
        url: "https://example.invalid/pr/9",
      },
    };
    render(withPr("pending"), [run], { r1: prCard });
    expect(runLabel("r1")).toContain("pull request:");
    expect(runLabel("r1")).toContain("PR #9");
    const pending = runLabel("r1");
    render(withPr("failure"), [run], { r1: prCard });
    expect(runLabel("r1")).not.toBe(pending);
  });

  it("opens the exact run on its Task", () => {
    const opened: Array<[string, string]> = [];
    render(
      roleSessions,
      [run],
      { r1: card },
      {
        onOpenWorkflowRun: (taskId, runId) => opened.push([taskId, runId]),
      },
    );
    click(row("run:r1"));
    press(row("run:r1"), "Enter");
    expect(opened).toEqual([
      ["676", "r1"],
      ["676", "r1"],
    ]);
  });

  it("lists every role session once the run is opened, and traverses them", () => {
    render(roleSessions, [run], { r1: card });
    click(button("Show the 3 workflow sessions"));
    expect(rowIds()).toEqual(["run:r1", "impl", "coord", "rev-1"]);
    // Still ONE item: the sessions are rows inside it, not cards beside it.
    expect(container!.querySelectorAll("[data-inbox-card]")).toHaveLength(1);

    row("run:r1").focus();
    press(row("run:r1"), "ArrowDown");
    expect(document.activeElement).toBe(row("impl"));
    press(row("impl"), "ArrowUp");
    expect(document.activeElement).toBe(row("run:r1"));

    click(button("Hide the 3 workflow sessions"));
    expect(rowIds()).toEqual(["run:r1"]);
  });

  it("opens a role session directly from the row the disclosure lists", () => {
    const opened: string[] = [];
    render(
      roleSessions,
      [run],
      { r1: card },
      {
        onSelect: (id) => opened.push(id),
      },
    );
    click(button("Show the 3 workflow sessions"));
    expect(row("rev-1").getAttribute("aria-label")).toContain(
      "Open workflow Assistant session",
    );
    click(row("rev-1"));
    expect(opened).toEqual(["rev-1"]);
  });

  it("keeps every session a card of its own when the run has no projection", () => {
    render(roleSessions, [run], {});
    expect(rowIds()).toEqual(["run:r1", "impl", "coord", "rev-1"]);
    expect(container!.querySelectorAll("[data-inbox-card]")).toHaveLength(4);
  });

  it("shows a run that owns no listed session at all", () => {
    // A run in `starting`, or one whose projection this browser cannot read,
    // has no session of its own here. The cold-start box would otherwise claim
    // there is no agent work while the run is moving.
    render([], [run], { r1: card });
    expect(container!.textContent).not.toContain("No sessions yet");
    expect(rowIds()).toEqual(["run:r1"]);
    expect(container!.textContent).toContain("Surface live Workflow Runs");
  });

  /* ------------- across the terminal boundary ([Task-677]) ------------- */

  const ended: WorkflowRunSummary = {
    ...run,
    lifecycle: "completed",
    endedAt: NOW - 10_000,
    attention: {
      revision: 2,
      settledRevision: 1,
      kind: "completed",
      at: NOW - 10_000,
    },
  };

  it("keeps a completed run as one Needs-you item, folds its roles, and settles it in one click", () => {
    const settled: string[] = [];
    render(
      roleSessions.map((s) => ({
        ...s,
        isStreaming: false,
        outcomeAttention: {
          revision: 1,
          settledRevision: 0,
          kind: "completed" as const,
          at: NOW - 20_000,
        },
      })),
      [ended],
      { r1: card },
      { onSettleWorkflowRun: (runId) => settled.push(runId) },
    );
    expect(
      container!.querySelector("#session-inbox-needs-you")?.textContent,
    ).toBe("Needs you");
    expect(rowIds()).toEqual(["run:r1"]);
    expect(runLabel("r1")).toContain("Run complete.");

    click(button("Settle — acknowledge the run and put its sessions down"));
    expect(settled).toEqual(["r1"]);
  });

  /** The roles once the run has ended: nothing running. */
  const idleRoles = roleSessions.map((s) => ({ ...s, isStreaming: false }));

  it("settles the focused run from the keyboard, with the revision it rendered", () => {
    const settled: Array<[string, number]> = [];
    render(
      idleRoles,
      [ended],
      { r1: card },
      {
        onSettleWorkflowRun: (runId, revision) =>
          settled.push([runId, revision]),
      },
    );
    press(row("run:r1"), "s");
    expect(settled).toEqual([["r1", 2]]);
  });

  it("disables Settle while a role session is still running, in that role's words", () => {
    render(roleSessions, [ended], { r1: card });
    const settle = button("Cannot settle: it is still running.");
    expect((settle as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Settle at an unresolved user decision and says why", () => {
    const settled: string[] = [];
    render(
      idleRoles,
      [
        {
          ...run,
          lifecycle: "paused",
          lifecycleReason: "Decide how the run should end.",
          attention: {
            revision: 1,
            settledRevision: 0,
            kind: "paused",
            at: NOW - 10_000,
          },
        },
      ],
      {
        r1: {
          ...card,
          phase: "ceiling-decision",
          ceilingDecision: {
            blocked: "review-passes",
            wanted: "another review pass",
            allowedChoices: ["raise", "cancel"],
            ceilings: { maxIterations: 3, maxReviewPasses: 2 },
            spent: { iterations: 1, reviewPasses: 2, sessions: 3 },
            headCarriesDiscoveryReview: false,
            suggestedRaise: 2,
          },
        },
      },
      { onSettleWorkflowRun: (runId) => settled.push(runId) },
    );
    const settle = button(
      "Cannot settle: it is waiting for your decision at its ceiling.",
    );
    expect((settle as HTMLButtonElement).disabled).toBe(true);
    expect(row("run:r1").getAttribute("aria-label")).toContain(
      "Cannot settle: it is waiting for your decision at its ceiling.",
    );
    press(row("run:r1"), "s");
    expect(settled).toEqual([]);
  });

  it("offers no Settle on a live run with nothing to acknowledge, and none once settled", () => {
    render(roleSessions, [run], { r1: card });
    expect(
      [...container!.querySelectorAll("button")].some((node) =>
        node.getAttribute("aria-label")?.startsWith("Settle"),
      ),
    ).toBe(false);

    render(
      roleSessions,
      [{ ...ended, attention: { ...ended.attention!, settledRevision: 2 } }],
      { r1: card },
    );
    // Released: the run is gone and its three sessions are rows of their own.
    expect(rowIds().sort()).toEqual(["coord", "impl", "rev-1"]);
  });

  it("puts a paused run under Needs you with its reason", () => {
    render(
      roleSessions,
      [
        {
          ...run,
          lifecycle: "paused",
          lifecycleReason: "Waiting for your merge decision.",
        },
      ],
      { r1: card },
    );
    const heading = container!.querySelector("#session-inbox-needs-you");
    expect(heading?.textContent).toBe("Needs you");
    expect(runLabel("r1")).toContain("Waiting for your merge decision.");
  });
});
