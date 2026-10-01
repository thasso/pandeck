import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import type { ToolCallContext } from "../../mcp/tool.ts";
import {
  approvalsForSession,
  resolveApproval,
  setApprovalBroadcastForTests,
} from "../../pendingApprovals.ts";
import { gitPublishTagTool, publishApprovedTag } from "./gitTagTools.ts";

const directories: string[] = [];
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const originalSystemConfig = process.env.GIT_CONFIG_SYSTEM;
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
});
afterEach(() => {
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  if (originalSystemConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = originalSystemConfig;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  setApprovalBroadcastForTests(null);
});

function command(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pa-git-tag-"));
  directories.push(dir);
  const bare = join(dir, "remote.git");
  const checkout = join(dir, "checkout");
  command(dir, "init", "--bare", bare);
  command(dir, "clone", bare, checkout);
  command(checkout, "config", "user.email", "test@example.org");
  command(checkout, "config", "user.name", "Test");
  command(checkout, "checkout", "-b", "main");
  command(checkout, "commit", "--allow-empty", "-m", "Initial");
  command(checkout, "push", "-u", "origin", "main");
  return { bare, checkout, head: command(checkout, "rev-parse", "HEAD") };
}

const context: ToolCallContext = {
  toolCallId: "tag-call",
  session: { sessionId: "git-tag-test", harness: "pi", agentType: "developer" },
};

describe("git_publish_tag", () => {
  test("refuses relative checkout paths", async () => {
    await assert.rejects(
      publishApprovedTag({
        repoPath: "repo",
        tag: "v1",
        expectedHead: "a".repeat(40),
      }),
      /must be absolute/,
    );
  });

  test("stages approval without writing and publishes only on approval", async () => {
    const { bare, checkout, head } = fixture();
    setApprovalBroadcastForTests(() => {});
    const result = await gitPublishTagTool.execute(
      { repoPath: checkout, tag: "v0.1.0", expectedHead: head },
      context,
    );
    assert.equal(result.terminate, true);
    assert.equal(command(checkout, "tag", "--list"), "");
    assert.equal(command(bare, "tag", "--list"), "");
    const card = approvalsForSession(context.session.sessionId).at(-1)!;
    assert.equal(card.status, "pending");
    assert.equal(card.body.kind, "gitTag");
    await resolveApproval(card.id, "approved");
    assert.equal(command(bare, "rev-parse", "refs/tags/v0.1.0"), head);
    assert.equal(command(bare, "rev-parse", "refs/heads/main"), head);
    assert.equal(
      (
        await publishApprovedTag({
          repoPath: checkout,
          tag: "v0.1.0",
          expectedHead: head,
        })
      ).status,
      "already-published",
    );
  });

  test("rejection writes nothing; destination changes after approval are refused", async () => {
    const { bare, checkout, head } = fixture();
    setApprovalBroadcastForTests(() => {});
    const ctx = {
      ...context,
      session: { ...context.session, sessionId: "tag-rejection-test" },
    };
    await gitPublishTagTool.execute(
      { repoPath: checkout, tag: "v1", expectedHead: head },
      ctx,
    );
    const first = approvalsForSession(ctx.session.sessionId).at(-1)!;
    await resolveApproval(first.id, "rejected");
    assert.equal(command(checkout, "tag", "--list"), "");
    assert.equal(command(bare, "tag", "--list"), "");
    await gitPublishTagTool.execute(
      { repoPath: checkout, tag: "v2", expectedHead: head },
      ctx,
    );
    const card = approvalsForSession(ctx.session.sessionId).at(-1)!;
    const other = join(bare, "..", "other.git");
    command(checkout, "init", "--bare", other);
    command(checkout, "push", other, "main");
    command(checkout, "remote", "set-url", "--push", "origin", other);
    const decision = await resolveApproval(card.id, "approved");
    assert.equal(decision.card.status, "failed");
    assert.match(decision.card.error ?? "", /destination changed/);
    assert.equal(command(other, "tag", "--list"), "");
  });

  test("refuses unpublished or stale branch heads and dirty checkouts", async () => {
    const { checkout, bare, head } = fixture();
    command(checkout, "commit", "--allow-empty", "-m", "Unpublished");
    const newer = command(checkout, "rev-parse", "HEAD");
    await assert.rejects(
      publishApprovedTag({
        repoPath: checkout,
        tag: "v1",
        expectedHead: newer,
      }),
      /remote branch/,
    );
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /checkout moved/,
    );
    command(checkout, "reset", "--hard", head);
    writeFileSync(join(checkout, "new-file"), "untracked");
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /clean/,
    );
    assert.equal(command(bare, "tag", "--list"), "");
  });

  test("checks the push URL, not the fetch URL", async () => {
    const { bare, checkout, head } = fixture();
    const other = join(bare, "..", "other.git");
    command(checkout, "init", "--bare", other);
    command(checkout, "remote", "set-url", "--push", "origin", other);
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /remote branch/,
    );
    assert.equal(command(other, "tag", "--list"), "");
  });

  test("refuses detached HEAD, wrong upstream, and multiple push URLs", async () => {
    const { checkout, bare, head } = fixture();
    command(checkout, "branch", "--unset-upstream");
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /track a same-named/,
    );
    command(checkout, "branch", "--set-upstream-to=origin/main");
    command(checkout, "remote", "set-url", "--add", "--push", "origin", bare);
    command(
      checkout,
      "remote",
      "set-url",
      "--add",
      "--push",
      "origin",
      "ssh://example.invalid/other",
    );
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /exactly one push URL/,
    );
    command(checkout, "checkout", "--detach", head);
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /symbolic-ref/,
    );
  });

  test("never moves local or remote tags", async () => {
    const { checkout, head } = fixture();
    command(checkout, "commit", "--allow-empty", "-m", "Other");
    const other = command(checkout, "rev-parse", "HEAD");
    command(checkout, "tag", "v1", other);
    command(checkout, "reset", "--hard", head);
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /local tag/,
    );
    command(checkout, "push", "origin", "refs/tags/v1:refs/tags/v1");
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /remote tag/,
    );
    await assert.rejects(
      publishApprovedTag({
        repoPath: checkout,
        tag: "--all",
        expectedHead: head,
      }),
      /Invalid git tag/,
    );
  });

  test("refuses an existing annotated local tag rather than changing its object", async () => {
    const { checkout, head } = fixture();
    command(checkout, "tag", "-a", "v1", "-m", "Annotated", head);
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /local tag/,
    );
  });

  test("ignores signing/follow-tags config and publishes one lightweight tag", async () => {
    const { checkout, bare, head } = fixture();
    command(checkout, "config", "tag.gpgSign", "true");
    command(checkout, "config", "push.followTags", "true");
    command(checkout, "tag", "-a", "--no-sign", "extra", "-m", "Extra", head);
    const result = await publishApprovedTag({
      repoPath: checkout,
      tag: "v1",
      expectedHead: head,
    });
    assert.equal(result.status, "published");
    assert.equal(command(checkout, "rev-parse", "refs/tags/v1"), head);
    assert.equal(command(bare, "tag", "--list"), "v1");
    command(checkout, "commit", "--allow-empty", "-m", "Later");
    assert.equal(
      (
        await publishApprovedTag({
          repoPath: checkout,
          tag: "v1",
          expectedHead: head,
        })
      ).status,
      "already-published",
    );
  });

  test("a failed push leaves a local tag and can be retried", async () => {
    const { checkout, bare, head } = fixture();
    // The remote remains available for validation but rejects the incoming push.
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await assert.rejects(
      publishApprovedTag({ repoPath: checkout, tag: "v1", expectedHead: head }),
      /failed/,
    );
    assert.equal(command(checkout, "rev-parse", "refs/tags/v1"), head);
    rmSync(hook);
    assert.equal(
      (
        await publishApprovedTag({
          repoPath: checkout,
          tag: "v1",
          expectedHead: head,
        })
      ).status,
      "published",
    );
  });
});
