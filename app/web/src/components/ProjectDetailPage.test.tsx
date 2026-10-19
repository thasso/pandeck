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
import {
  beginLoad,
  failed,
  idle,
  loading,
  ready,
  type LoadState,
} from "../lib/loadState.ts";
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

/**
 * One worktree's row in the page's tree, split into its two lines: the branch
 * with its line delta and merged badge, and under it the axes or the calm fact.
 */
function worktreeLines(root: ParentNode, id: string) {
  const row = root.querySelector(`[data-list-row-id="worktree:${id}"]`);
  // The row body carries the branch/path tooltip; its second child holds the
  // two lines (the first is the glyph).
  const body = row?.querySelector("[title]")?.children[1];
  return {
    row,
    primary: body?.children[0] ?? null,
    second: body?.children[1] ?? null,
  };
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
      const edit = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Edit",
      );
      await act(async () => edit?.click());
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
    const { primary, second } = worktreeLines(document, "one");
    expect(primary?.textContent).toContain("+14−3");
    expect(second?.querySelector("[data-worktree-axes]")).not.toBeNull();
    expect(second?.textContent).toContain("main ↑2");
  });

  it("states the calm fact on the second line when every axis is in sync", () => {
    const row = worktree({ id: "calm" });
    const html = renderWorktrees([row], {
      calm: git("calm", {
        upstream: { ahead: 0, behind: 0, name: "fork/live-calm" },
      }),
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const lines = worktreeLines(document, "calm");
    const { primary, second } = lines;
    expect(primary?.textContent).toContain("live/calm");
    // Every worktree row keeps two lines, so the rows are one height: with
    // nothing to say on an axis, the second line says there is nothing to do.
    expect(lines.row?.querySelector("[data-worktree-axes]")).toBeNull();
    expect(second?.textContent).toBe("level with main");
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
      '[data-list-row-id="worktree:axes"] [data-worktree-axis]',
    );
    expect(axes).toHaveLength(3);
    const axisSummary = document.querySelector(
      '[data-list-row-id="worktree:axes"] [data-worktree-axes]',
    );
    expect(axisSummary?.querySelectorAll(".sr-only")).toHaveLength(2);
    expect(axisSummary?.textContent).toContain("↓2\u00a0backup/main");
    expect(axisSummary?.textContent).toContain("↓7\u00a0fork/live-axes");
    expect(
      document
        .querySelector(
          '[data-list-row-id="worktree:axes"] [data-worktree-axes]',
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
    const { primary } = worktreeLines(document, "merged");
    expect(primary?.querySelector('[data-slot="badge"]')?.textContent).toBe(
      "merged",
    );
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
      // A minute tick that leaves the row fresh redraws no row: the memo folds
      // the clock down to the stale/fresh bit the row renders.
      setPerfStatsEnabled(true);
      await act(async () => vi.advanceTimersByTime(60_000));
      expect(worktreeRowRenders()).toBe(0);
      expect(axes()?.classList.contains("opacity-60")).toBe(false);
      // The tick that flips it stale redraws that row, once.
      await act(async () => vi.advanceTimersByTime(15 * 60_000));
      expect(axes()?.classList.contains("opacity-60")).toBe(true);
      expect(worktreeRowRenders()).toBe(1);
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
      // A new status for "one" only: "two" keeps its status object, so its
      // memoized row stays as it was.
      await act(async () =>
        root.render(
          page(
            git("one", {
              upstream: { ahead: 0, behind: 2, name: "fork/one" },
            }),
          ),
        ),
      );
      expect(worktreeRowRenders()).toBe(1);
      expect(
        container.querySelector('[data-list-row-id="worktree:one"]')
          ?.textContent,
      ).toContain("↓2");
    } finally {
      setPerfStatsEnabled(false);
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

/** How many times a worktree row (`WorktreeRow`) rendered while the HUD was on. */
function worktreeRowRenders(): number {
  return (
    perfSnapshot().renders.find((render) => render.name === "WorktreeRow")
      ?.count ?? 0
  );
}

async function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keyDown(el: Element, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

/**
 * The name and description editor (one, opened by Edit) and the repository URL
 * editor keep their draft until the correlated `saveProject` succeeds, and
 * show a refusal with a retry.
 */
describe("ProjectDetailPage edits", () => {
  const project: ProjectRecord = {
    id: "alpha",
    name: "Alpha",
    key: "AA",
    description: "Alpha body",
  };

  async function mount(
    onSave: (id: string, patch: object) => void,
    record: ProjectRecord = project,
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const rerender = (mutationStates: Record<string, LoadState<true>>) =>
      act(async () =>
        root.render(
          <ProjectDetailPage
            projects={[record]}
            loaded
            selectedId="alpha"
            detailState={ready(record)}
            mutationStates={mutationStates}
            onLoadDetail={() => {}}
            onBackToList={() => {}}
            onSave={onSave}
            onCloneRepo={() => {}}
            onRemoveClone={() => {}}
          />,
        ),
      );
    await rerender({});
    const button = (name: string) =>
      [...container.querySelectorAll("button")].find(
        (el) =>
          el.getAttribute("aria-label") === name ||
          el.textContent?.trim() === name,
      )!;
    return {
      container,
      rerender,
      button,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  it("renames through Save, holding the draft through a refusal", async () => {
    const onSave = vi.fn();
    const view = await mount(onSave);
    const input = () =>
      view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Project name"]',
      );
    try {
      await act(async () => view.button("Edit").click());
      expect(document.activeElement).toBe(input());
      await typeInto(input()!, " Alpha two ");
      await act(async () => view.button("Save").click());
      // Only the field this edit changed is sent.
      expect(onSave).toHaveBeenLastCalledWith("alpha", { name: "Alpha two" });

      await view.rerender({ "alpha:name": loading() });
      expect(view.button("Save").getAttribute("aria-busy")).toBe("true");
      await keyDown(input()!, { key: "Enter", metaKey: true });
      expect(onSave).toHaveBeenCalledTimes(1);

      await view.rerender({ "alpha:name": failed("Name taken") });
      expect(input()!.value).toBe(" Alpha two ");
      expect(view.container.textContent).toContain("Name taken");

      await act(async () => view.button("Retry").click());
      expect(onSave).toHaveBeenCalledTimes(2);
      await view.rerender({ "alpha:name": loading() });
      await view.rerender({ "alpha:name": ready(true) });
      expect(input()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("saves the description on Cmd/Ctrl+Enter and cancels on Escape", async () => {
    const onSave = vi.fn();
    const view = await mount(onSave);
    const textarea = () =>
      view.container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Project description"]',
      );
    try {
      await act(async () => view.button("Edit").click());
      await typeInto(textarea()!, "Discarded");
      await keyDown(textarea()!, { key: "Escape" });
      expect(textarea()).toBeNull();
      expect(view.container.textContent).toContain("Alpha body");

      await act(async () => view.button("Edit").click());
      await typeInto(textarea()!, "New body\n");
      await keyDown(textarea()!, { key: "Enter", metaKey: true });
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave).toHaveBeenLastCalledWith("alpha", {
        description: "New body",
      });

      await view.rerender({ "alpha:description": loading() });
      expect(view.button("Save").disabled).toBe(true);
      await view.rerender({ "alpha:description": failed("Too long") });
      expect(textarea()!.value).toBe("New body\n");
      expect(view.container.textContent).toContain("Too long");
    } finally {
      await view.unmount();
    }
  });

  const editUrl = () =>
    document.querySelector<HTMLButtonElement>(
      'button[title="Edit clone from"]',
    )!;

  it("commits the repository URL on blur, keeping it open until saved", async () => {
    const onSave = vi.fn();
    const view = await mount(onSave);
    const input = () =>
      view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Repository URL"]',
      );
    try {
      await act(async () => editUrl().click());
      expect(document.activeElement).toBe(input());
      await typeInto(input()!, "git@host:owner/repo.git");
      await act(async () => input()!.blur());
      expect(onSave).toHaveBeenLastCalledWith("alpha", {
        repoUrl: "git@host:owner/repo.git",
      });
      expect(input()).not.toBeNull();

      await view.rerender({ "alpha:field:repoUrl": loading() });
      await view.rerender({ "alpha:field:repoUrl": failed("Bad URL") });
      expect(view.container.textContent).toContain("Bad URL");
      expect(input()!.value).toBe("git@host:owner/repo.git");

      await act(async () => view.button("Retry").click());
      expect(onSave).toHaveBeenCalledTimes(2);
      await view.rerender({ "alpha:field:repoUrl": loading() });
      await view.rerender({ "alpha:field:repoUrl": ready(true) });
      expect(input()).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("clears the repository URL with an empty value", async () => {
    const onSave = vi.fn();
    const view = await mount(onSave, { ...project, repoUrl: "git@old:x.git" });
    try {
      await act(async () => editUrl().click());
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Repository URL"]',
      )!;
      await typeInto(input, "  ");
      await keyDown(input, { key: "Enter" });
      // "" is what the server clears on; an omitted key would be a no-op patch.
      expect(onSave).toHaveBeenLastCalledWith("alpha", { repoUrl: "" });
    } finally {
      await view.unmount();
    }
  });
});
