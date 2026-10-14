import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { sessionStore } from "./db/sessionStore.ts";
import { runOneShot } from "./harnesses/oneShot.ts";
import { generateCommitMessageJson } from "./commitAgent.ts";
import { generatePullRequestJson } from "./prAgent.ts";
import { generateWorktreeSuffix } from "./worktrees/worktreeNaming.ts";
import { getSettings } from "./settings.ts";

vi.mock("./harnesses/oneShot.ts", () => ({ runOneShot: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

test.each(["commit", "pr", "worktree"] as const)(
  "%s helper uses canonical enterprise provenance despite caller false",
  async (helper) => {
    vi.spyOn(sessionStore, "getIncludingDeleted").mockReturnValue({
      requiresEnterprise: true,
    } as never);
    vi.mocked(runOneShot).mockResolvedValue({
      text:
        helper === "worktree"
          ? "scoped-name"
          : JSON.stringify({
              status: "commit",
              subject: "Scoped commit",
              title: "Scoped PR",
              body: [],
              blockers: [],
              warnings: [],
            }),
      usage: {},
    });
    const source = {
      sourceSessionId: "enterprise-source",
      requiresEnterprise: false,
    };
    const settings = getSettings();
    if (helper === "commit")
      await generateCommitMessageJson(
        "transcript",
        settings.commitAgent,
        source,
      );
    else if (helper === "pr")
      await generatePullRequestJson("transcript", settings.prAgent, source);
    else
      await generateWorktreeSuffix(
        "transcript",
        settings.worktrees.namingAgent,
        source,
      );
    const request = vi.mocked(runOneShot).mock.calls.at(-1)![0];
    assert.equal(request.requiresEnterprise, true);
    assert.deepEqual(request.sourceSessionIds, ["enterprise-source"]);
  },
);

test("worktree naming refusal keeps the timestamp fallback", async () => {
  vi.spyOn(sessionStore, "getIncludingDeleted").mockReturnValue({
    requiresEnterprise: true,
  } as never);
  vi.mocked(runOneShot).mockRejectedValue(new Error("No enterprise account"));
  const suffix = await generateWorktreeSuffix(
    "transcript",
    getSettings().worktrees.namingAgent,
    { sourceSessionId: "enterprise-source" },
  );
  assert.match(suffix, /^wt-[a-z0-9]+$/);
});
