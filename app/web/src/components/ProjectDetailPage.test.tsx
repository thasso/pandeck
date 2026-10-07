// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectRecord,
  WorktreeGitStatus,
  WorktreeRecord,
} from "@assistant/shared";
import { ProjectDetailPage } from "./ProjectDetailPage.tsx";
import { beginLoad, idle, ready, type LoadState } from "../lib/loadState.ts";
import { perfSnapshot, setPerfStatsEnabled } from "../lib/perfStats.ts";

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

/**
 * The reference behaviour for R1: this page has always kept "still loading",
 * "not in the registry" and "registry is empty" apart. The assertions exist so
 * the Task-384 migration to `common/load.tsx` kept all three.
 */

function render(options: {
  loaded: boolean;
  projects?: ProjectRecord[];
  selectedId?: string | null;
}): string {
  return renderToStaticMarkup(
    <ProjectDetailPage
      projects={options.projects ?? []}
      loaded={options.loaded}
      selectedId={options.selectedId ?? null}
      onLoad={() => {}}
      onBackToList={() => {}}
      onSave={() => {}}
      onCloneRepo={() => {}}
      onRemoveClone={() => {}}
    />,
  );
}

function worktree(
  partial: Partial<WorktreeRecord> & { id: string },
): WorktreeRecord {
  return {
    projectId: "project",
    mainRepoRoot: "/repo",
    path: `/repo/worktrees/${partial.id}`,
    branch: `recorded/${partial.id}`,
    baseBranch: "main",
    baseCommit: "abc",
    status: "active",
    sessionIds: [],
    taskIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function git(
  worktreeId: string,
  partial: Partial<WorktreeGitStatus> = {},
): WorktreeGitStatus {
  return {
    worktreeId,
    branch: `live/${worktreeId}`,
    head: "abc1234",
    dirty: false,
    filesChanged: 0,
    untracked: 0,
    additions: 0,
    deletions: 0,
    ahead: 0,
    behind: 0,
    merged: false,
    updatedAt: 1,
    fetchedAt: Date.now(),
    ...partial,
  };
}

const WORKTREE_PROJECT: ProjectRecord = {
  id: "project",
  key: "PR",
  name: "Project",
  localPaths: [{ path: "/repo", kind: "repo" }],
};

function renderWorktrees(
  worktrees: WorktreeRecord[],
  worktreeStatuses: Record<string, WorktreeGitStatus>,
): string {
  return renderToStaticMarkup(
    <ProjectDetailPage
      projects={[WORKTREE_PROJECT]}
      loaded
      selectedId={WORKTREE_PROJECT.id}
      detailState={ready(WORKTREE_PROJECT)}
      worktreeState={ready(worktrees)}
      worktreeStatuses={worktreeStatuses}
      onBackToList={() => {}}
      onSave={() => {}}
      onCloneRepo={() => {}}
      onRemoveClone={() => {}}
    />,
  );
}

describe("ProjectDetailPage load states", () => {
  it("loads rather than claiming the registry is empty", () => {
    const html = render({ loaded: false, selectedId: "proj" });
    expect(html).toContain("Loading projects…");
    expect(html).not.toContain("No projects yet");
    expect(html).not.toContain("Project not found");
  });

  it("distinguishes not-found, empty and unselected once loaded", () => {
    expect(render({ loaded: true, selectedId: "proj" })).toContain(
      "Project not found",
    );
    expect(render({ loaded: true })).toContain("No projects yet");
    expect(
      render({
        loaded: true,
        projects: [{ id: "proj", name: "Demo" } as ProjectRecord],
      }),
    ).toContain("Select a project");
  });

  it("structurally resets A-owned draft state before B detail answers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const alpha: ProjectRecord = {
      id: "alpha",
      name: "Alpha",
      key: "AA",
      description: "Alpha body",
    };
    const beta: ProjectRecord = {
      id: "beta",
      name: "Beta",
      key: "BB",
      description: "Beta body",
    };
    const page = (id: string, detailState: LoadState<ProjectRecord | null>) => (
      <ProjectDetailPage
        key={id}
        projects={[alpha, beta]}
        loaded
        selectedId={id}
        detailState={detailState}
        onLoadDetail={() => {}}
        onBackToList={() => {}}
        onSave={() => {}}
        onCloneRepo={() => {}}
        onRemoveClone={() => {}}
      />
    );
    try {
      await act(async () => root.render(page("alpha", ready(alpha))));
      const rename = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Rename Project"]',
      );
      await act(async () => rename?.click());
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Project name"]',
      );
      expect(input).not.toBeNull();
      await act(async () => {
        if (!input) return;
        input.value = "Alpha unsaved draft";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

      await act(async () =>
        root.render(page("beta", beginLoad(idle<ProjectRecord | null>()))),
      );
      expect(container.textContent).toContain("BB");
      expect(container.textContent).not.toContain("Alpha body");
      expect(container.textContent).not.toContain("Alpha unsaved draft");

      await act(async () => root.render(page("alpha", ready(alpha))));
      expect(container.textContent).toContain("Alpha body");
      expect(container.textContent).not.toContain("Beta body");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("ProjectDetailPage worktree rows", () => {
  it("uses a second line for axes while keeping the dirty delta with the branch", () => {
    const row = worktree({ id: "one" });
    const html = renderWorktrees([row], {
      one: git("one", {
        dirty: true,
        filesChanged: 1,
        additions: 14,
        deletions: 3,
        ahead: 2,
        upstream: { ahead: 0, behind: 0, name: "fork/live-one" },
      }),
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const renderedRow = document.querySelector(
      '[data-project-worktree-row="one"]',
    );
    expect(
      renderedRow?.querySelector("[data-worktree-primary]")?.textContent,
    ).toContain("+14−3");
    expect(
      renderedRow?.querySelector("[data-worktree-axes]")?.textContent,
    ).toContain("main ↑2");
  });

  it("collapses to one line when every axis is in sync", () => {
    const row = worktree({ id: "calm" });
    const html = renderWorktrees([row], {
      calm: git("calm", {
        upstream: { ahead: 0, behind: 0, name: "fork/live-calm" },
      }),
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const renderedRow = document.querySelector(
      '[data-project-worktree-row="calm"]',
    );
    expect(
      renderedRow?.querySelector("[data-worktree-primary]"),
    ).not.toBeNull();
    expect(renderedRow?.querySelector("[data-worktree-axes]")).toBeNull();
  });

  it("renders the live branch rather than the recorded branch", () => {
    const row = worktree({ id: "branch", branch: "recorded/stale" });
    const html = renderWorktrees([row], {
      branch: git("branch", {
        branch: "live/renamed",
        upstream: { ahead: 0, behind: 0, name: "fork/live-renamed" },
      }),
    });
    expect(html).toContain("live/renamed");
    expect(html).not.toContain("recorded/stale");
  });

  it("shows all three axes with server-resolved remote names", () => {
    const row = worktree({ id: "axes" });
    const html = renderWorktrees([row], {
      axes: git("axes", {
        ahead: 3,
        behind: 2,
        baseUpstream: { ahead: 0, behind: 7, name: "backup/main" },
        upstream: { ahead: 4, behind: 1, name: "fork/live-axes" },
      }),
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const axes = document.querySelectorAll(
      '[data-project-worktree-row="axes"] [data-worktree-axis]',
    );
    expect(axes).toHaveLength(3);
    const axisSummary = document.querySelector(
      '[data-project-worktree-row="axes"] [data-worktree-axes]',
    );
    expect(axisSummary?.querySelectorAll(".sr-only")).toHaveLength(2);
    expect(axisSummary?.textContent).toContain("↓2\u00a0backup/main");
    expect(axisSummary?.textContent).toContain("↓7\u00a0fork/live-axes");
    expect(
      document
        .querySelector(
          '[data-project-worktree-row="axes"] [data-worktree-axes]',
        )
        ?.classList.contains("truncate"),
    ).toBe(true);
    expect(axes[0]?.getAttribute("title")).toBe(
      "This branch is 3 ahead of main / 2 behind main",
    );
    expect(axes[1]?.getAttribute("title")).toBe("main is 7 behind backup/main");
    expect(axes[2]?.getAttribute("title")).toBe(
      "This branch has 4 to push / 1 to pull against fork/live-axes",
    );
    expect(html).toContain("backup/main");
    expect(html).toContain("fork/live-axes");
    expect(html).not.toContain("origin");
  });

  it("keeps merged as a semantic badge", () => {
    const row = worktree({ id: "merged" });
    const html = renderWorktrees([row], {
      merged: git("merged", {
        ahead: 1,
        merged: true,
        upstream: { ahead: 0, behind: 0, name: "fork/live-merged" },
      }),
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(
      document.querySelector("[data-worktree-primary]")?.textContent,
    ).toContain("merged");
  });

  it("ages remote refs against wall clock time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00Z"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const row = worktree({ id: "stale" });
    const status = git("stale", {
      ahead: 1,
      upstream: { ahead: 0, behind: 0, name: "fork/live-stale" },
      updatedAt: Date.now(),
      fetchedAt: Date.now(),
    });
    try {
      await act(async () =>
        root.render(
          <ProjectDetailPage
            projects={[WORKTREE_PROJECT]}
            loaded
            selectedId={WORKTREE_PROJECT.id}
            detailState={ready(WORKTREE_PROJECT)}
            worktreeState={ready([row])}
            worktreeStatuses={{ stale: status }}
            onBackToList={() => {}}
            onSave={() => {}}
            onCloneRepo={() => {}}
            onRemoveClone={() => {}}
          />,
        ),
      );
      const axes = () =>
        container.querySelector<HTMLElement>("[data-worktree-axes]");
      expect(axes()?.classList.contains("opacity-60")).toBe(false);
      setPerfStatsEnabled(true);
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(
        perfSnapshot().renders.find(
          (render) => render.name === "ProjectWorktreeRow",
        )?.count ?? 0,
      ).toBe(0);
      await act(async () => vi.advanceTimersByTime(15 * 60_000));
      expect(axes()?.classList.contains("opacity-60")).toBe(true);
      expect(
        perfSnapshot().renders.find(
          (render) => render.name === "ProjectWorktreeRow",
        )?.count,
      ).toBe(1);
      expect(
        axes()?.querySelector("[data-worktree-axis]")?.getAttribute("title"),
      ).toContain("remote refs may be out of date");
    } finally {
      setPerfStatsEnabled(false);
      await act(async () => root.unmount());
      container.remove();
      vi.useRealTimers();
    }
  });

  it("re-renders only the changed memoized row on a status broadcast", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const rows = [worktree({ id: "one" }), worktree({ id: "two" })];
    const two = git("two", {
      upstream: { ahead: 0, behind: 0, name: "fork/two" },
    });
    const page = (one: WorktreeGitStatus) => (
      <ProjectDetailPage
        projects={[WORKTREE_PROJECT]}
        loaded
        selectedId={WORKTREE_PROJECT.id}
        detailState={ready(WORKTREE_PROJECT)}
        worktreeState={ready(rows)}
        worktreeStatuses={{ one, two }}
        onBackToList={() => {}}
        onSave={() => {}}
        onCloneRepo={() => {}}
        onRemoveClone={() => {}}
      />
    );
    try {
      await act(async () =>
        root.render(
          page(
            git("one", {
              upstream: { ahead: 0, behind: 0, name: "fork/one" },
            }),
          ),
        ),
      );
      setPerfStatsEnabled(true);
      await act(async () =>
        root.render(
          page(
            git("one", {
              upstream: { ahead: 0, behind: 2, name: "fork/one" },
            }),
          ),
        ),
      );
      expect(
        perfSnapshot().renders.find(
          (render) => render.name === "ProjectWorktreeRow",
        )?.count,
      ).toBe(1);
    } finally {
      setPerfStatsEnabled(false);
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
