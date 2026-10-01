// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectSummaryOf } from "@assistant/shared";
import type {
  ProjectRecord,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { ProjectTreePane } from "./ProjectTreePane.tsx";

/** The sidebar Projects tab's R1 gate (`app/web/docs/loading-states.md`). */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

beforeEach(() => window.localStorage.clear());

function render(projects: ProjectRecord[], loading: boolean): string {
  return renderToStaticMarkup(
    <ProjectTreePane
      projects={projects}
      loading={loading}
      onReorder={() => {}}
      onOpenProject={() => {}}
    />,
  );
}

describe("ProjectTreePane first load", () => {
  it("reserves tree rows instead of claiming an empty registry", () => {
    const html = render([], true);
    expect(html).not.toContain("No projects in the registry yet.");
    expect(html).toContain('aria-label="Loading projects"');
    expect(html).toContain("animate-pulse");
  });

  it("preserves legacy path-derived nesting from lean summaries", () => {
    const parent: ProjectRecord = {
      id: "parent",
      name: "Parent",
      key: "PA",
      localPaths: [{ path: "/work/parent", kind: "workspace" }],
    };
    const child: ProjectRecord = {
      id: "child",
      name: "Child",
      key: "CH",
      localPaths: [{ path: "/work/parent/child", kind: "repo" }],
    };
    const html = render(
      [projectSummaryOf(parent), projectSummaryOf(child)],
      false,
    );
    expect(html).toMatch(
      /data-list-row-id="child"[^>]*role="treeitem"[^>]*aria-level="2"/,
    );
    expect(html).not.toContain("/work/parent/child");
  });

  it("reports only worktrees rendered below expanded Projects", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const seen: string[][] = [];
    const project: ProjectRecord = {
      id: "project",
      name: "Project",
      key: "PR",
    };
    const worktree: WorktreeRecord = {
      id: "worktree",
      projectId: project.id,
      mainRepoRoot: "/repo",
      path: "/repo/worktrees/one",
      branch: "one",
      baseBranch: "main",
      baseCommit: "abc",
      status: "active",
      sessionIds: [],
      taskIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const status: WorktreeGitStatus = {
      worktreeId: worktree.id,
      branch: "live-one",
      head: "abc",
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      ahead: 1,
      behind: 0,
      upstream: { ahead: 2, behind: 0, name: "backup/live-one" },
      merged: false,
      updatedAt: 1,
      fetchedAt: Date.now(),
    };
    try {
      await act(async () =>
        root.render(
          <ProjectTreePane
            projects={[project]}
            loading={false}
            worktrees={[worktree]}
            worktreeStatuses={{ [worktree.id]: status }}
            onReorder={() => {}}
            onOpenProject={() => {}}
            onVisibleWorktreeIdsChange={(ids) => seen.push(ids)}
          />,
        ),
      );
      expect(seen.at(-1)).toEqual([worktree.id]);
      expect(container.textContent).toContain("live-one");
      expect(container.textContent).toContain("backup/live-one");
      const collapse = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Collapse"]',
      );
      await act(async () => collapse?.click());
      expect(seen.at(-1)).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("ages worktree axes against wall clock time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const project: ProjectRecord = {
      id: "project",
      name: "Project",
      key: "PR",
    };
    const worktree: WorktreeRecord = {
      id: "worktree",
      projectId: project.id,
      mainRepoRoot: "/repo",
      path: "/repo/worktrees/one",
      branch: "one",
      baseBranch: "main",
      baseCommit: "abc",
      status: "active",
      sessionIds: [],
      taskIds: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const status: WorktreeGitStatus = {
      worktreeId: worktree.id,
      branch: "one",
      head: "abc",
      dirty: false,
      filesChanged: 0,
      untracked: 0,
      additions: 0,
      deletions: 0,
      ahead: 1,
      behind: 0,
      upstream: { ahead: 0, behind: 0, name: "backup/one" },
      merged: false,
      updatedAt: Date.now(),
      fetchedAt: Date.now(),
    };
    try {
      await act(async () =>
        root.render(
          <ProjectTreePane
            projects={[project]}
            loading={false}
            worktrees={[worktree]}
            worktreeStatuses={{ [worktree.id]: status }}
            onReorder={() => {}}
            onOpenProject={() => {}}
          />,
        ),
      );
      const axes = () =>
        container.querySelector<HTMLElement>("[data-worktree-axes]");
      expect(axes()?.classList.contains("opacity-60")).toBe(false);
      await act(async () => vi.advanceTimersByTime(16 * 60_000));
      expect(axes()?.classList.contains("opacity-60")).toBe(true);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it("names the empty registry once the list has answered", () => {
    const html = render([], false);
    expect(html).toContain("No projects in the registry yet.");
    expect(html).not.toContain("animate-pulse");
    // The empty box is the shared one, not a hand-rolled dashed div.
    expect(html).toContain("border-dashed");
  });
});
