import { describe, expect, it } from "vitest";
import { projectSummaryOf, type ProjectRecord } from "./protocol.ts";

describe("ProjectSummary projection", () => {
  it("is lean, allowlisted, and preserves the two derived list facts", () => {
    const project: ProjectRecord = {
      id: "child",
      name: "Child",
      key: "CH",
      color: "#123456",
      status: "active",
      parentId: null,
      sortOrder: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      description: "A long detail-only body",
      localPaths: [
        { path: "/work/parent/child/", kind: "repo", match: "prefix" },
        { path: "/other/private/path", kind: "folder" },
      ],
      jira: [{ projectKey: "CH", role: "primary" }],
      aliases: ["child-project"],
      tags: ["private"],
      worktreeRoot: "/worktrees/child",
      repoUrl: "ssh://git.example/child.git",
    };

    const summary = projectSummaryOf(project);
    expect(Object.keys(summary).sort()).toEqual([
      "color",
      "createdAt",
      "hasRepoPath",
      "id",
      "key",
      "name",
      "parentId",
      "primaryPath",
      "sortOrder",
      "status",
      "updatedAt",
    ]);
    expect(summary.primaryPath).toBe("/work/parent/child");
    expect(summary.hasRepoPath).toBe(true);
    expect(summary).not.toHaveProperty("localPaths");
    expect(summary).not.toHaveProperty("description");
    expect(summary).not.toHaveProperty("repoUrl");
    expect(JSON.stringify(summary).length).toBeLessThan(400);
  });

  it("omits derived flags when no list consumer needs them", () => {
    const summary = projectSummaryOf({
      id: "plain",
      name: "Plain",
      key: "PL",
      localPaths: [{ path: "/notes", kind: "folder" }],
    });
    expect(summary.primaryPath).toBe("/notes");
    expect(summary).not.toHaveProperty("hasRepoPath");
  });
});
