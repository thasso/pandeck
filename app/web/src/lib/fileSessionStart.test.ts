import { describe, expect, it } from "vitest";
import { fileSessionStart } from "./fileSessionStart.ts";

describe("fileSessionStart", () => {
  it("stages a host file by its viewer route, without the anchor", () => {
    expect(
      fileSessionStart({
        kind: "hostFile",
        path: "/home/me/notes/plan.md",
        anchor: { start: 4 },
      }),
    ).toEqual({
      href: "/files/home/me/notes/plan.md",
      title: "plan.md",
      worktreeId: null,
    });
  });

  it("hands over a worktree file, not its diff, and names its checkout", () => {
    const start = fileSessionStart({
      kind: "worktreeFile",
      worktreeId: "wt-1",
      path: "docs/guide.md",
      view: "diff",
    });
    expect(start.title).toBe("guide.md");
    expect(start.worktreeId).toBe("wt-1");
    expect(start.href).not.toContain("view=diff");
    expect(start.href).toContain("wt-1");
  });

  it("stages a session artifact by its own route", () => {
    expect(
      fileSessionStart({
        kind: "sessionArtifact",
        sessionId: "s1",
        path: "out/report.md",
      }),
    ).toMatchObject({ title: "report.md", worktreeId: null });
  });
});
