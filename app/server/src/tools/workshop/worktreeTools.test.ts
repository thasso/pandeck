import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { runOneShot } from "../../harnesses/oneShot.ts";
import * as worktrees from "../../worktrees/worktrees.ts";
import { resolveWorktreeRow } from "../../worktrees/worktreeResolve.ts";
import { worktreeTools } from "./worktreeTools.ts";

vi.mock("../../harnesses/oneShot.ts", () => ({ runOneShot: vi.fn() }));
vi.mock("../../db/worktreeStore.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/worktreeStore.ts")>()),
  worktreeIdForSession: (sessionId: string) =>
    sessionId === "pa-without-worktree" ? undefined : "source-worktree",
}));
vi.mock("../../worktrees/worktreeResolve.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../worktrees/worktreeResolve.ts")
  >()),
  resolveWorktreeRow: vi.fn(),
}));
vi.mock("../../worktrees/worktrees.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../worktrees/worktrees.ts")>()),
  createWorktree: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const create = worktreeTools.find((tool) => tool.name === "worktree_create")!;
const ctx: ToolCallContext = {
  toolCallId: "pa-create",
  session: {
    sessionId: "pa-without-worktree",
    agentType: "personal-assistant",
    harness: "pi",
  },
};

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

const context: ToolCallContext = {
  toolCallId: "create",
  session: {
    sessionId: "enterprise-actor",
    harness: "pi",
    agentType: "developer",
    cwd: "/repo",
  },
};

test.each(["success", "refusal"] as const)(
  "worktree_create captures actor scope before project resolution and preserves naming %s",
  async (outcome) => {
    const source = vi
      .spyOn(sessionStore, "getIncludingDeleted")
      .mockReturnValue({ requiresEnterprise: true } as never);
    vi.mocked(resolveWorktreeRow).mockImplementation(async () => {
      source.mockReturnValue({ requiresEnterprise: false } as never);
      return { projectId: "project" } as never;
    });
    if (outcome === "success")
      vi.mocked(runOneShot).mockResolvedValue({
        text: "scoped-name",
        usage: {},
      });
    else
      vi.mocked(runOneShot).mockRejectedValue(
        new Error("No enterprise account"),
      );
    vi.mocked(worktrees.createWorktree).mockResolvedValue({
      id: "created",
      path: "/created",
      branch: "branch",
      baseBranch: "main",
      baseCommit: "head",
      projectId: "project",
    } as never);
    await create.execute({} as never, context);
    const request = vi.mocked(runOneShot).mock.calls.at(-1)![0];
    assert.equal(request.requiresEnterprise, true);
    assert.deepEqual(request.sourceSessionIds, [context.session.sessionId]);
    const input = vi.mocked(worktrees.createWorktree).mock.calls.at(-1)![0];
    assert.equal(input.createdBySessionId, context.session.sessionId);
    if (outcome === "success") assert.equal(input.name, "scoped-name");
    else assert.match(input.name, /^wt-[a-z0-9]+$/);
  },
);
