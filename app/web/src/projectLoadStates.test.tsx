// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectRecord } from "@assistant/shared";
import { ProjectDetailPage } from "./components/ProjectDetailPage.tsx";
import { beginLoad, failFrom, idle, ready } from "./lib/loadState.ts";

const project: ProjectRecord = {
  id: "project",
  name: "Project",
  key: "PR",
  description: "Readable Project body",
  localPaths: [{ path: "/repo", kind: "repo" }],
};

function render(
  detailState = ready<ProjectRecord | null>(project),
  worktrees: Parameters<typeof ProjectDetailPage>[0]["worktrees"] = [],
  worktreeState?: Parameters<typeof ProjectDetailPage>[0]["worktreeState"],
  failure?: string,
) {
  return renderToStaticMarkup(
    <ProjectDetailPage
      projects={[project]}
      loaded
      selectedId={project.id}
      failure={failure}
      onDismissFailure={() => {}}
      detailState={detailState}
      onLoadDetail={() => {}}
      onLoad={() => {}}
      onBackToList={() => {}}
      onSave={() => {}}
      onCloneRepo={() => {}}
      onRemoveClone={() => {}}
      worktrees={worktrees}
      worktreeState={worktreeState}
      onLoadWorktrees={() => {}}
    />,
  );
}

describe("Project list/detail dependent-source load states", () => {
  it("shows an identity header and reserved detail geometry on a cold detail", () => {
    const html = render(beginLoad(idle<ProjectRecord | null>()), null);
    expect(html).toContain("PR");
    expect(html).toContain('aria-label="Loading Project details"');
    expect(html).not.toContain("Project not found");
    expect(html).not.toContain("No worktrees yet");
  });

  it("retains the same Project document while refreshing", () => {
    const html = render(beginLoad(ready<ProjectRecord | null>(project)));
    expect(html).toContain("Readable Project body");
    expect(html).toContain("Refreshing Project");
  });

  it("retains readable detail and gives a failed refresh an inline retry home", () => {
    const html = render(
      failFrom(ready<ProjectRecord | null>(project), "Project refresh failed"),
    );
    expect(html).toContain("Readable Project body");
    expect(html).toContain("Project refresh failed");
    expect(html).toContain("Retry");
  });

  // A failure about the project ITSELF lives on the project
  // (`docs/messaging.md`), which is what lets the announcer stay quiet while this
  // page is open. It is retired by the dismiss or by the project's next write.
  it("renders the failure this project is carrying, with its dismiss", () => {
    const html = render(
      ready(project),
      [],
      undefined,
      "Failed to clone project repo: no such host",
    );
    expect(html).toContain("Failed to clone project repo: no such host");
    expect(html).toContain("Dismiss");
    // R2: the document it belongs to stays readable underneath.
    expect(html).toContain("Readable Project body");
    expect(render()).not.toContain("Failed to clone project repo");
  });

  it("does not claim empty or enable clone removal before Worktrees answer", () => {
    const html = render(ready(project), null);
    expect(html).toContain("Loading Project worktrees");
    expect(html).toContain("Checking dependent worktrees");
    expect(html).toContain(
      'aria-label="Checking worktrees before clone removal"',
    );
    expect(html).toContain("disabled");
    expect(html).not.toContain("No worktrees yet");
  });

  it("retains rows but withholds destructive conclusions during refresh", () => {
    const html = render(
      ready(project),
      undefined,
      beginLoad(
        ready([
          {
            id: "main",
            projectId: project.id,
            mainRepoRoot: "/repo",
            path: "/repo",
            branch: "main",
            baseBranch: "main",
            baseCommit: "abc",
            status: "active",
            isMain: true,
            sessionIds: [],
            taskIds: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]),
      ),
    );
    expect(html).toContain("main");
    expect(html).toContain("Checking dependent worktrees");
    expect(html).toContain('aria-label="Checking worktrees');
    expect(html).toContain("disabled");
  });

  it("narrates a failed Worktree refresh beside retained rows with retry", () => {
    const rows = [
      {
        id: "main",
        projectId: project.id,
        mainRepoRoot: "/repo",
        path: "/repo",
        branch: "main",
        baseBranch: "main",
        baseCommit: "abc",
        status: "active" as const,
        isMain: true,
        sessionIds: [],
        taskIds: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const html = render(
      ready(project),
      undefined,
      failFrom(ready(rows), "Worktree refresh failed"),
    );
    expect(html).toContain("main");
    expect(html).toContain("Worktree refresh failed");
    expect(html).toContain("Retry");
    expect(html).toContain("disabled");
  });
});
