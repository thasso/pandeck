import { describe, expect, it } from "vitest";
import { resolveSessionDockContext } from "./sessionDockContext.ts";

describe("resolveSessionDockContext", () => {
  it("offers nothing when the session hangs off no object", () => {
    expect(resolveSessionDockContext({ hasUserPrompt: true })).toBeUndefined();
  });

  it("prefers the worktree over every other tier", () => {
    expect(
      resolveSessionDockContext({
        worktreeId: "wt-1",
        originTaskId: "task-9",
        hasUserPrompt: true,
      }),
    ).toEqual({ kind: "worktree", id: "wt-1" });
  });

  it("falls through task, knowledge, then project", () => {
    expect(
      resolveSessionDockContext({
        originTaskId: "task-9",
        hasUserPrompt: true,
      }),
    ).toEqual({ kind: "task", id: "task-9" });
    expect(
      resolveSessionDockContext({
        hasUserPrompt: false,
        staged: { knowledgeEntryId: "kb-1", projectId: "proj-1" },
      }),
    ).toEqual({ kind: "knowledge", id: "kb-1" });
    expect(
      resolveSessionDockContext({
        hasUserPrompt: false,
        staged: { projectId: "proj-1" },
      }),
    ).toEqual({
      kind: "project",
      id: "proj-1",
    });
  });

  it("counts a draft's staged context, since that is what the session is about", () => {
    expect(
      resolveSessionDockContext({
        hasUserPrompt: false,
        staged: { worktreeId: "wt-staged", taskId: "task-staged" },
      }),
    ).toEqual({ kind: "worktree", id: "wt-staged" });
  });

  it("ignores staged context once a prompt exists: it outlives the send it was made for", () => {
    expect(
      resolveSessionDockContext({
        hasUserPrompt: true,
        staged: { worktreeId: "wt-stale", taskId: "task-stale" },
      }),
    ).toBeUndefined();
    // The session's OWN worktree still wins, and the stale staging cannot outrank it.
    expect(
      resolveSessionDockContext({
        worktreeId: "wt-real",
        hasUserPrompt: true,
        staged: { worktreeId: "wt-stale" },
      }),
    ).toEqual({ kind: "worktree", id: "wt-real" });
  });
});
