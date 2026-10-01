// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  PullRequestInventoryItem,
  SessionListItem,
  TaskSummary,
  WorktreeRecord,
} from "@assistant/shared";
import { PullRequestDetailPage } from "./PullRequestDetailPage.tsx";
import { ready } from "../../lib/loadState.ts";
import type {
  JoinSource,
  PullRequestJoinSources,
} from "../../lib/pullRequestInbox.ts";

/**
 * What the page CLAIMS about the objects a pull request is joined to.
 *
 * The join ids are authoritative and the lists that resolve them are not: they
 * arrive by subscription, go stale on a reconnect, and an archived session or
 * Task is never in them at all. So "no sessions are linked" may only be said
 * when the INVENTORY says so, and "not in this list" only against a FRESH
 * answer — a cold, stale or failed list may say neither (R1/R2).
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const TARGET = {
  projectId: "pa",
  provider: "forgejo" as const,
  repositoryKey: "acme/pa",
  number: 7,
};

function pr(
  patch: Partial<PullRequestInventoryItem> = {},
): PullRequestInventoryItem {
  return {
    projectId: "pa",
    provider: "forgejo",
    repositoryKey: "acme/pa",
    repoWebUrl: "https://forge/acme/pa",
    number: 7,
    url: "https://forge/acme/pa/pulls/7",
    title: "Add the Pull Requests view",
    headBranch: "pull-requests",
    baseBranch: "main",
    mine: true,
    reviewRequested: false,
    state: "open",
    sessionIds: [],
    taskIds: [],
    ...patch,
  };
}

const WORKTREE: WorktreeRecord = {
  id: "wt-1",
  projectId: "pa",
  mainRepoRoot: "/repo",
  path: "/worktrees/wt-1",
  branch: "pull-requests",
  baseBranch: "main",
  baseCommit: "abc",
  status: "active",
  sessionIds: [],
  taskIds: [],
  createdAt: 0,
  updatedAt: 0,
};

const SESSION = {
  id: "s-1",
  title: "Implementing it",
  agentType: "claude",
  updatedAt: 0,
  messageCount: 1,
} as unknown as SessionListItem;

const TASK = { id: "704", title: "Ship the view" } as unknown as TaskSummary;

/** A list that has answered authoritatively for this episode. */
function fresh<T>(rows: T[]): JoinSource<T> {
  return { rows, fresh: true };
}

/** Retained rows from an earlier episode, awaiting this one's answer. */
function stale<T>(rows: T[], error?: string): JoinSource<T> {
  return { rows, fresh: false, ...(error ? { error } : {}) };
}

/** Never answered at all. */
const COLD: JoinSource<never> = { rows: null, fresh: false };

function render(
  item: PullRequestInventoryItem,
  joins: Partial<PullRequestJoinSources> = {},
) {
  act(() =>
    root!.render(
      <PullRequestDetailPage
        target={TARGET}
        state={ready(item)}
        onReload={() => {}}
        projects={[]}
        joins={{
          worktrees: joins.worktrees ?? fresh<WorktreeRecord>([]),
          sessions: joins.sessions ?? fresh<SessionListItem>([]),
          tasks: joins.tasks ?? fresh<TaskSummary>([]),
        }}
        onOpenWorktree={() => {}}
        onOpenSession={() => {}}
        onOpenTask={() => {}}
      />,
    ),
  );
  return container!;
}

const LINKED = {
  worktreeId: "wt-1",
  sessionIds: ["s-1"],
  taskIds: ["704"],
};

describe("the relations block", () => {
  it("claims none only when the INVENTORY says none", () => {
    const el = render(pr());
    expect(el.textContent).toContain("No sessions are linked to it.");
    expect(el.textContent).toContain("No Tasks are linked to it.");
    expect(el.textContent).toContain("No local worktree holds pull-requests.");
  });

  it("reserves a join whose list has not answered yet (cold subscription)", () => {
    // The exact regression: `state.taskList?.items ?? []` on a cold open used
    // to make the page announce that a pull request implements no Task.
    const el = render(pr(LINKED), {
      worktrees: COLD,
      sessions: COLD,
      tasks: COLD,
    });
    expect(el.textContent).not.toContain("No sessions are linked");
    expect(el.textContent).not.toContain("No Tasks are linked");
    expect(el.textContent).not.toContain("No local worktree holds");
    expect(el.textContent).not.toContain("not in this list");
    expect(el.querySelector('[aria-label="Loading tasks"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Loading sessions"]')).not.toBeNull();
    expect(
      el.querySelector('[aria-label="Loading the local worktree"]'),
    ).not.toBeNull();
  });

  it("reserves an id a STALE list is missing, never calls it absent", () => {
    // A reconnect, a refresh in flight: the list is retained but not
    // authoritative, and an object linked a second ago is exactly what it does
    // not have yet.
    const el = render(pr(LINKED), {
      worktrees: stale([]),
      sessions: stale([]),
      tasks: stale([]),
    });
    expect(el.textContent).not.toContain("not in this list");
    expect(el.querySelector('[aria-label="Loading tasks"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Loading sessions"]')).not.toBeNull();
  });

  it("keeps a STALE list's resolved rows readable", () => {
    const el = render(pr(LINKED), {
      worktrees: stale([WORKTREE]),
      sessions: stale([SESSION]),
      tasks: stale([TASK]),
    });
    expect(el.textContent).toContain("Implementing it");
    expect(el.textContent).toContain("Ship the view");
    expect(el.textContent).toContain("pull-requests");
    expect(el.textContent).not.toContain("not in this list");
  });

  it("keeps retained rows under a failed refresh and states the failure", () => {
    // R2: the failure sits beside the data it could not replace, never instead
    // of it — and it cannot promote a missing id to absent either.
    const el = render(pr(LINKED), {
      worktrees: stale([WORKTREE], "Worktree list unavailable"),
      tasks: stale([TASK], "Task list unavailable"),
      sessions: stale([], "Session list unavailable"),
    });
    expect(el.textContent).toContain("Ship the view");
    expect(el.textContent).toContain("Task list unavailable");
    expect(el.textContent).not.toContain("not in this list");
    expect(el.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  });

  it("states an id a FRESH list does not hold, rather than hiding it", () => {
    // An archived session or Task is simply not in these lists and never will
    // be, so a reserved row there would wait forever. The row says what it is.
    const el = render(pr({ ...LINKED, worktreeId: "gone" }), {
      worktrees: fresh([]),
      sessions: fresh([]),
      tasks: fresh([]),
    });
    expect(el.textContent).not.toContain("No sessions are linked");
    expect(el.textContent).not.toContain("No Tasks are linked");
    expect(el.textContent).toContain("s-1");
    expect(el.textContent).toContain("704");
    expect(el.textContent).toContain("not in this list");
    expect(el.querySelector('[aria-label="Loading tasks"]')).toBeNull();
  });

  it("resolves what the lists do hold", () => {
    const el = render(pr(LINKED), {
      worktrees: fresh([WORKTREE]),
      sessions: fresh([SESSION]),
      tasks: fresh([TASK]),
    });
    expect(el.textContent).toContain("Implementing it");
    expect(el.textContent).toContain("Ship the view");
    expect(el.textContent).toContain("Task-704");
    expect(el.textContent).not.toContain("not in this list");
  });
});

describe("the status block", () => {
  it("never renders an unfinished mergeability check as a conflict", () => {
    const el = render(pr({ mergeable: null }));
    expect(el.textContent).toContain("The provider is still checking");
    expect(el.textContent).not.toContain("Conflicts with the base branch");
  });

  it("states an unread CI as unknown rather than as a pass", () => {
    expect(render(pr()).textContent).toContain("CI unknown");
  });

  // The panel's Merge row is disabled with the same sentence as its tooltip,
  // which reaches neither a keyboard nor a phone — so the page says it.
  it("states why a merge is not offered, as text", () => {
    expect(render(pr({ draft: true })).textContent).toContain(
      "#7 is a draft. Mark it ready for review before merging.",
    );
    expect(render(pr({ mergeable: false })).textContent).toContain(
      "#7 conflicts with main. Merging is not offered until the branch is updated.",
    );
    expect(render(pr()).textContent).not.toContain("Merging is not offered");
  });
});
