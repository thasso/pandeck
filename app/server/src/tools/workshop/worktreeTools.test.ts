import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";
import * as worktrees from "../../worktrees/worktrees.ts";
import { worktreeTools } from "./worktreeTools.ts";

const create = worktreeTools.find((tool) => tool.name === "worktree_create")!;
const ctx: ToolCallContext = {
  toolCallId: "pa-create",
  session: {
    sessionId: "pa-without-worktree",
    agentType: "personal-assistant",
    harness: "pi",
  },
};
afterEach(() => vi.restoreAllMocks());

test("a PA without a worktree must name a project", async () => {
  await assert.rejects(
    create.execute({ name: "errand" }, ctx),
    /not linked to a worktree; supply projectId/,
  );
});

test("a PA can create in an explicitly named project", async () => {
  const make = vi.spyOn(worktrees, "createWorktree").mockResolvedValue({
    id: "new-worktree",
    path: "/project/errand",
    branch: "errand",
    projectId: "project",
    baseBranch: "main",
    baseCommit: "abc",
  } as never);
  const result = await create.execute(
    { projectId: "project", name: "errand" },
    ctx,
  );
  assert.equal(make.mock.calls[0]?.[0].projectId, "project");
  assert.equal(
    make.mock.calls[0]?.[0].createdBySessionId,
    ctx.session.sessionId,
  );
  assert.equal((result.details as { id: string }).id, "new-worktree");
});
