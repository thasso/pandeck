import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorktreeRecord } from "@assistant/shared";
import {
  StagedContextBar,
  StagedContextPanel,
  type StagedContextData,
} from "./StagedContext.tsx";
import { Composer } from "./Composer.tsx";

const worktree: WorktreeRecord = {
  id: "wt1",
  projectId: "proj",
  branch: "feature/thing",
  baseBranch: "main",
  path: "/tmp/wt1",
  createdAt: 0,
} as WorktreeRecord;

function panelData(
  overrides: Partial<StagedContextData> = {},
): StagedContextData {
  return {
    value: { projectId: null, worktreeId: null, task: null },
    projects: [],
    worktrees: [worktree],
    tasks: [],
    projectsLoaded: true,
    worktreesLoaded: true,
    tasksLoaded: true,
    onChangeProject: () => {},
    onChangeWorktree: () => {},
    onChangeTask: () => {},
    ...overrides,
  };
}

describe("StagedContextBar", () => {
  it("renders a removable structured review bundle beside its worktree", () => {
    const html = renderToStaticMarkup(
      <StagedContextBar
        value={{
          projectId: "proj",
          worktreeId: "wt1",
          task: null,
          review: { commentCount: 3 },
        }}
        projects={[]}
        worktrees={[worktree]}
        onOpen={() => {}}
        onChangeProject={() => {}}
        onChangeWorktree={() => {}}
        onChangeTask={() => {}}
        onChangeReview={() => {}}
      />,
    );
    expect(html).toContain("3 review comments");
    expect(html).toContain("feature/thing");
    expect(html).toContain("Remove 3 review comments");
  });

  it("renders a staged + New worktree as its own removable chip", () => {
    const html = renderToStaticMarkup(
      <StagedContextBar
        value={{
          projectId: "proj",
          worktreeId: null,
          newWorktree: true,
          task: null,
        }}
        projects={[]}
        worktrees={[worktree]}
        onOpen={() => {}}
        onChangeProject={() => {}}
        onChangeWorktree={() => {}}
        onChangeNewWorktree={() => {}}
        onChangeTask={() => {}}
      />,
    );
    expect(html).toContain("New worktree");
    expect(html).toContain("Remove New worktree");
    // The project is not "implied" by a worktree that does not exist yet, so it
    // stays removable — and removing it cancels the new worktree (App.tsx).
    expect(html).toContain("Remove proj");
  });
});

describe("StagedContextPanel", () => {
  it("starts on the Project field when nothing is staged", () => {
    const html = renderToStaticMarkup(<StagedContextPanel {...panelData()} />);
    expect(html).toContain("No projects in the registry yet.");
    expect(html).not.toContain("feature/thing");
  });

  // R1: the host asks for these lists only when the sheet opens, so the frames
  // before the answer are exactly when "none yet" would be a lie.
  it("reserves the Project rows instead of claiming an empty registry", () => {
    const html = renderToStaticMarkup(
      <StagedContextPanel {...panelData({ projectsLoaded: false })} />,
    );
    expect(html).not.toContain("No projects in the registry yet.");
    expect(html).toContain('aria-label="Loading projects"');
    expect(html).toContain("animate-pulse");
  });

  it("reserves the Worktree rows instead of claiming there are none", () => {
    const html = renderToStaticMarkup(
      <StagedContextPanel
        {...panelData({ worktrees: [], worktreesLoaded: false })}
        initialField="worktree"
      />,
    );
    expect(html).not.toContain("No worktrees yet.");
    expect(html).toContain('aria-label="Loading worktrees"');
  });

  it("reserves the Task rows instead of claiming there are none", () => {
    const html = renderToStaticMarkup(
      <StagedContextPanel
        {...panelData({ tasksLoaded: false })}
        initialField="task"
      />,
    );
    expect(html).not.toContain("No tasks yet.");
    expect(html).toContain('aria-label="Loading Tasks"');
  });

  it("shows each empty label once its list has answered with nothing", () => {
    const html = renderToStaticMarkup(<StagedContextPanel {...panelData()} />);
    expect(html).toContain("No projects in the registry yet.");
    expect(html).not.toContain('aria-label="Loading projects"');
  });

  it("opens the requested initialField (Worktree after picking Developer)", () => {
    const html = renderToStaticMarkup(
      <StagedContextPanel {...panelData()} initialField="worktree" />,
    );
    expect(html).toContain("feature/thing");
    expect(html).not.toContain("No projects in the registry yet.");
  });

  it("offers + New worktree in the Worktree field only with a project staged", () => {
    const withoutProject = renderToStaticMarkup(
      <StagedContextPanel
        {...panelData({ onChangeNewWorktree: () => {} })}
        initialField="worktree"
      />,
    );
    expect(withoutProject).not.toContain("New worktree");

    const withProject = renderToStaticMarkup(
      <StagedContextPanel
        {...panelData({
          value: { projectId: "proj", worktreeId: null, task: null },
          onChangeNewWorktree: () => {},
        })}
        initialField="worktree"
      />,
    );
    expect(withProject).toContain("New worktree");

    const staged = renderToStaticMarkup(
      <StagedContextPanel
        {...panelData({
          value: {
            projectId: "proj",
            worktreeId: null,
            newWorktree: true,
            task: null,
          },
          onChangeNewWorktree: () => {},
        })}
      />,
    );
    // The collapsed field reads back what is staged, like any other value.
    expect(staged).toContain("New worktree");
  });
});

describe("Composer send gating", () => {
  function renderComposer(sendBlockedReason?: string): string {
    return renderToStaticMarkup(
      <Composer
        onSend={() => {}}
        onAbort={() => {}}
        streaming={false}
        disabled={false}
        contextInfo={null}
        session={null}
        models={[]}
        slashCommands={[]}
        actions={{} as never}
        contextBar={panelData()}
        sendBlockedReason={sendBlockedReason}
      />,
    );
  }

  it("renders the worktree-required hint in the reserved slot above the composer", () => {
    const html = renderComposer(
      "Developer sessions run in a worktree — pick one to continue.",
    );
    expect(html).toContain("Developer sessions run in a worktree");
    expect(html).toContain('aria-live="polite"');
  });

  it("keeps the hint slot reserved on staged-context surfaces so toggling never shifts layout", () => {
    const html = renderComposer(undefined);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("Developer sessions run in a worktree");
  });
});
