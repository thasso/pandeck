/**
 * Anchoring tests for worktree review comments against a real temp git repo:
 * line shifts (hunk block mapping), shared selector fallback, renames,
 * orphaning on deletion, revival on revert, and the agent reply/resolve flow.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "worktree-comments-test-"));
process.env.ASSISTANT_CWD = tmp;

const { createWorktree, removeWorktree, WorktreeBranchCleanupError } =
  await import("./worktrees.ts");
const { mainWorktreeId } = await import("./worktreeResolve.ts");
const {
  addWorktreeComment,
  createWorktreeReviewSet,
  listWorktreeComments,
  listWorktreeReviewSets,
  reanchorWorktreeComments,
  resolveWorktreeComment,
  MAIN_COMMENT_RETENTION_DAYS,
  purgeMainCommentsForBranchSubject,
  setAfterAnchorHeadForTests,
  setBeforeCommentInsertForTests,
  sweepMainWorktreeCommentRetention,
} = await import("./worktreeComments.ts");
const { buildReviewHandoffPrompt } = await import("./reviewHandoff.ts");
const { projectStore } = await import("../db/projectStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const {
  deleteWorktreeComments,
  getComment,
  getWorktree,
  insertComment,
  linkSessionToWorktree,
  listComments,
  markWorktreeRemovedForTests,
  reassignCommentWorktreeForTests,
  reparentCommentForTests,
  setCommentRetentionFieldsForTests,
  updateWorktree,
} = await import("../db/worktreeStore.ts");
const { sweepOrphanedWorktreeComments } =
  await import("../db/sweepWorktreeComments.ts");
const { setWorktreeBroadcaster } = await import("./worktreeEvents.ts");
const { setCommentChangeNotifier } =
  await import("../comments/commentChanges.ts");
const { worktreeReviewTools } =
  await import("../tools/workshop/worktreeReviewTools.ts");
const { Connection } = await import("../connection.ts");
const { notifyCommentChanges } = await import("../comments/commentEvents.ts");

/**
 * Run git in the fixture repo. The repo is also watched by the always-on
 * git-state tier (`createWorktree` registers it, like any real worktree), so a
 * commit made here triggers a background status refresh and re-anchor pass —
 * git processes of their own, in the same repo, that hold `index.lock` for a
 * moment. A CI runner under load has had the next `add -A` collide with one;
 * git's own advice for that is to retry, and nothing here depends on which
 * process goes first, so index-lock contention is retried briefly rather than
 * failing the case.
 */
function sh(cwd: string, ...args: string[]): string {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return execFileSync(
        "git",
        ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? "");
      if (attempt >= 40 || !stderr.includes("index.lock")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function gitObjectExists(cwd: string, oid: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", oid], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const repoPath = join(tmp, "commentsrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
const CODE = [
  "function alpha() {",
  "  return 1;",
  "}",
  "",
  "function beta() {",
  "  return 2;",
  "}",
  "",
].join("\n");
writeFileSync(join(repoPath, "code.ts"), CODE);
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

projectStore.put({
  id: "cm-proj",
  name: "Comments Project",
  key: "CM",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const record = await createWorktree({ projectId: "cm-proj", name: "review" });

test("comments on the main checkout key off the canonical worktree id", async () => {
  // Add via an ALIASED main id; it must persist + list under the canonical one.
  const created = await addWorktreeComment({
    worktreeId: "main:CM-PROJ",
    body: "review the main checkout",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  assert.equal(created.worktreeId, mainWorktreeId("cm-proj"));
  const listed = await listWorktreeComments(mainWorktreeId("cm-proj"));
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.body, "review the main checkout");
  assert.deepEqual(listed[0]?.author, { kind: "user" });
  assert.equal(listed[0]?.severity, undefined);
});

test("review sets are refused on the synthetic main checkout", () => {
  assert.throws(
    () =>
      createWorktreeReviewSet({
        worktreeId: mainWorktreeId("cm-proj"),
        authorSessionId: "main-reviewer",
        blind: false,
      }),
    /not available on the main checkout/i,
  );
  assert.deepEqual(listWorktreeReviewSets(mainWorktreeId("cm-proj")), []);
});

test("synthetic-main ownership captures exclusive commits and refuses shared or ambiguous commits", async () => {
  const owner = await createWorktree({
    projectId: "cm-proj",
    name: "comment-owner",
  });
  writeFileSync(join(owner.path, "owned.txt"), "owned branch line\n");
  sh(owner.path, "add", "owned.txt");
  sh(owner.path, "commit", "-m", "owner commit");
  const ownerOid = sh(owner.path, "rev-parse", "HEAD").trim();
  const mainId = mainWorktreeId("cm-proj");

  const owned = await addWorktreeComment({
    worktreeId: mainId,
    body: "owned branch root",
    author: { kind: "user" },
    anchor: {
      path: "owned.txt",
      side: "new",
      line: 1,
      ref: ownerOid,
    },
  });
  assert.deepEqual(
    {
      worktreeId: getComment(owned.id)?.ownerWorktreeId,
      branch: getComment(owned.id)?.ownerBranch,
      source: getComment(owned.id)?.ownerSource,
    },
    {
      worktreeId: owner.id,
      branch: owner.branch,
      source: "branch-exclusive",
    },
  );
  const reply = await addWorktreeComment({
    worktreeId: mainId,
    parentId: owned.id,
    body: "reply follows the owner root",
    author: { kind: "user" },
  });
  assert.equal(getComment(reply.id)?.ownerWorktreeId, null);

  const shared = await addWorktreeComment({
    worktreeId: mainId,
    body: "base-shared root",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1, ref: "main" },
  });
  assert.equal(getComment(shared.id)?.ownerWorktreeId, null);

  const stacked = await createWorktree({
    projectId: "cm-proj",
    name: "stacked-comment-owner",
  });
  sh(stacked.path, "reset", "--hard", ownerOid);
  const ambiguous = await addWorktreeComment({
    worktreeId: mainId,
    body: "ambiguous stacked root",
    author: { kind: "user" },
    anchor: {
      path: "owned.txt",
      side: "new",
      line: 1,
      ref: ownerOid,
    },
  });
  assert.equal(getComment(ambiguous.id)?.ownerWorktreeId, null);

  insertStoredComment("legacy-ownerless-main", mainId);
  await removeWorktree(stacked.id, { force: true, deleteBranch: true });
  await removeWorktree(owner.id, { force: true, deleteBranch: true });
  assert.equal(getComment(owned.id), undefined);
  assert.equal(getComment(reply.id), undefined);
  assert.ok(getComment(shared.id));
  assert.ok(getComment(ambiguous.id));
  assert.ok(getComment("legacy-ownerless-main"));
});

test("merge-in-flight ownership takes precedence and chooses the newest merge", async () => {
  const older = await createWorktree({
    projectId: "cm-proj",
    name: "older-merge-owner",
  });
  const newer = await createWorktree({
    projectId: "cm-proj",
    name: "newer-merge-owner",
  });
  updateWorktree(older.id, {
    mergeStateJson: JSON.stringify({
      strategy: "merge",
      phase: "merging",
      startedAt: 10,
    }),
  });
  updateWorktree(newer.id, {
    mergeStateJson: JSON.stringify({
      strategy: "merge",
      phase: "conflicts",
      startedAt: 20,
    }),
  });

  const comment = await addWorktreeComment({
    worktreeId: mainWorktreeId("cm-proj"),
    body: "newest merge subject",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  assert.equal(getComment(comment.id)?.ownerWorktreeId, newer.id);
  assert.equal(getComment(comment.id)?.ownerSource, "merge-in-flight");

  updateWorktree(older.id, { mergeStateJson: null });
  updateWorktree(newer.id, { mergeStateJson: null });
  const touched: string[][] = [];
  setCommentChangeNotifier((_target, ids) => {
    touched.push([...ids]);
  });
  try {
    assert.equal(
      purgeMainCommentsForBranchSubject(getWorktree(newer.id)!, "merged"),
      1,
    );
  } finally {
    setCommentChangeNotifier(() => undefined);
  }
  assert.deepEqual(touched, [[comment.id]]);
  await removeWorktree(older.id, { force: true, deleteBranch: true });
  await removeWorktree(newer.id, { force: true, deleteBranch: true });
});

test("branch-subject comments survive removal when branch deletion is disabled", async () => {
  const owner = await createWorktree({
    projectId: "cm-proj",
    name: "keep-owner-branch",
  });
  writeFileSync(join(owner.path, "kept-owner.txt"), "keep branch\n");
  sh(owner.path, "add", "kept-owner.txt");
  sh(owner.path, "commit", "-m", "kept owner commit");
  const comment = await addWorktreeComment({
    worktreeId: mainWorktreeId("cm-proj"),
    body: "keep while the subject ref exists",
    author: { kind: "user" },
    anchor: {
      path: "kept-owner.txt",
      side: "new",
      line: 1,
      ref: owner.branch,
    },
  });

  await removeWorktree(owner.id, { force: true, deleteBranch: false });
  assert.ok(getComment(comment.id));
  sh(repoPath, "branch", "-D", owner.branch);
});

test("removal purges when the subject branch was already absent", async () => {
  const owner = await createWorktree({
    projectId: "cm-proj",
    name: "already-absent-owner",
  });
  writeFileSync(join(owner.path, "absent-owner.txt"), "absent branch\n");
  sh(owner.path, "add", "absent-owner.txt");
  sh(owner.path, "commit", "-m", "absent owner commit");
  const comment = await addWorktreeComment({
    worktreeId: mainWorktreeId("cm-proj"),
    body: "purge after external deletion",
    author: { kind: "user" },
    anchor: {
      path: "absent-owner.txt",
      side: "new",
      line: 1,
      ref: owner.branch,
    },
  });

  sh(repoPath, "worktree", "remove", "--force", owner.path);
  sh(repoPath, "branch", "-D", owner.branch);
  await removeWorktree(owner.id, { force: true, deleteBranch: true });
  assert.equal(getComment(comment.id), undefined);
});

test("a branch-subject purge failure does not fail branch deletion", async () => {
  const owner = await createWorktree({
    projectId: "cm-proj",
    name: "purge-failure-owner",
  });
  writeFileSync(join(owner.path, "purge-failure.txt"), "purge failure\n");
  sh(owner.path, "add", "purge-failure.txt");
  sh(owner.path, "commit", "-m", "purge failure owner commit");
  const mainId = mainWorktreeId("cm-proj");
  const root = await addWorktreeComment({
    worktreeId: mainId,
    body: "root with corrupt cross-scope reply",
    author: { kind: "user" },
    anchor: {
      path: "purge-failure.txt",
      side: "new",
      line: 1,
      ref: owner.branch,
    },
  });
  const reply = await addWorktreeComment({
    worktreeId: mainId,
    parentId: root.id,
    body: "corrupt reply",
    author: { kind: "user" },
  });
  reassignCommentWorktreeForTests(reply.id, "main:other-scope");

  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    await removeWorktree(owner.id, { force: true, deleteBranch: true });
  } finally {
    warning.mockRestore();
  }
  assert.equal(getWorktree(owner.id)?.status, "removed");
  assert.ok(getComment(root.id));

  reassignCommentWorktreeForTests(reply.id, mainId);
  assert.equal(
    purgeMainCommentsForBranchSubject(getWorktree(owner.id)!, "branch-deleted"),
    2,
  );
});

test("main retention purges only freshly orphaned, old resolved roots and their replies", async () => {
  const retentionRepo = join(tmp, "retention-repo");
  mkdirSync(retentionRepo, { recursive: true });
  sh(retentionRepo, "init", "-b", "main");
  const originalLines = [
    "eligible passage",
    "open orphan passage",
    "anchored resolved passage",
    "young orphan passage",
    "stale verdict passage",
    "",
  ];
  writeFileSync(join(retentionRepo, "retention.txt"), originalLines.join("\n"));
  sh(retentionRepo, "add", "-A");
  sh(retentionRepo, "commit", "-m", "retention fixture");
  projectStore.put({
    id: "retention-proj",
    name: "Retention Project",
    key: "RETENTION",
    description: "",
    status: "active",
    localPaths: [{ path: retentionRepo, kind: "repo", match: "prefix" }],
    worktreeRoot: join(tmp, "retention-wt-root"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const worktreeId = mainWorktreeId("retention-proj");
  const roots = await Promise.all(
    originalLines.slice(0, 5).map((line, index) =>
      addWorktreeComment({
        worktreeId,
        body: line,
        author: { kind: "user" },
        anchor: { path: "retention.txt", side: "new", line: index + 1 },
      }),
    ),
  );
  const [eligible, open, anchored, young, stale] = roots;
  const reply = await addWorktreeComment({
    worktreeId,
    parentId: eligible!.id,
    body: "reply follows eligible root",
    author: { kind: "user" },
  });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const oldResolvedAt = now - (MAIN_COMMENT_RETENTION_DAYS + 1) * dayMs;
  const youngResolvedAt = now - (MAIN_COMMENT_RETENTION_DAYS - 1) * dayMs;
  setCommentRetentionFieldsForTests(eligible!.id, {
    resolvedAt: oldResolvedAt,
  });
  // Open + orphaned is the important negative case.
  setCommentRetentionFieldsForTests(open!.id, { resolvedAt: null });
  setCommentRetentionFieldsForTests(anchored!.id, {
    resolvedAt: oldResolvedAt,
  });
  setCommentRetentionFieldsForTests(young!.id, {
    resolvedAt: youngResolvedAt,
  });
  // Persist a stale orphan verdict for text that still exists. The sweep must
  // re-anchor it to its moved live position before selecting deletions.
  setCommentRetentionFieldsForTests(stale!.id, {
    resolvedAt: oldResolvedAt,
    anchorState: "orphaned",
    updatedAt: now - 2 * dayMs,
  });
  // Historical rows without a complete immutable anchor cannot receive a
  // fresh verdict and therefore cannot be retention candidates.
  const incompleteId = "retention-stale-incomplete";
  insertStoredComment(incompleteId, worktreeId);
  setCommentRetentionFieldsForTests(incompleteId, {
    resolvedAt: oldResolvedAt,
    anchorState: "orphaned",
    updatedAt: now - 2 * dayMs,
  });

  writeFileSync(
    join(retentionRepo, "retention.txt"),
    [
      "replacement one",
      "replacement two",
      "anchored resolved passage",
      "replacement four",
      "stale verdict passage",
      "",
    ].join("\n"),
  );
  const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  const touched: string[][] = [];
  setCommentChangeNotifier((_target, ids) => {
    touched.push([...ids]);
  });
  let result: Awaited<ReturnType<typeof sweepMainWorktreeCommentRetention>>;
  let retentionLog = "";
  try {
    result = await sweepMainWorktreeCommentRetention(now);
    retentionLog = info.mock.calls.map((call) => String(call[0])).join("\n");
  } finally {
    setCommentChangeNotifier(() => undefined);
    info.mockRestore();
  }

  assert.equal(touched.length, 1);
  assert.ok(touched[0]!.includes(eligible!.id));
  assert.equal(result.purgedRoots, 1);
  assert.equal(result.purgedComments, 2);
  const remaining = listComments(worktreeId);
  assert.ok(!remaining.some((comment) => comment.id === eligible!.id));
  assert.ok(!remaining.some((comment) => comment.id === reply.id));
  assert.equal(
    remaining.find((comment) => comment.id === open!.id)?.anchorState,
    "orphaned",
  );
  assert.equal(
    remaining.find((comment) => comment.id === anchored!.id)?.anchorState,
    "moved",
  );
  assert.equal(
    remaining.find((comment) => comment.id === young!.id)?.anchorState,
    "orphaned",
  );
  assert.equal(
    remaining.find((comment) => comment.id === stale!.id)?.anchorState,
    "moved",
  );
  assert.equal(
    remaining.find((comment) => comment.id === incompleteId)?.anchorState,
    "orphaned",
  );
  assert.match(retentionLog, /orphaned-and-resolved-for-30-days=2/);
});

test("a connection can mutate a thread learned from another actor's event", async () => {
  const root = await addWorktreeComment({
    worktreeId: record.id,
    body: "agent-authored root",
    author: { kind: "agent", sessionId: "agent-1" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const target = {
    kind: "worktree" as const,
    worktreeId: record.id,
    path: "code.ts",
    side: "new" as const,
    revision: root.anchor?.commit ?? "",
  };
  await notifyCommentChanges(target, [root.id]);

  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  try {
    await connection.handle({
      type: "replyComment",
      threadId: root.id,
      body: "reply without a local snapshot",
    });
    const rows = await listWorktreeComments(record.id);
    const reply = rows.find((comment) => comment.parentId === root.id);
    assert.equal(reply?.body, "reply without a local snapshot");

    await connection.handle({
      type: "resolveComment",
      threadId: root.id,
      resolved: true,
    });
    assert.ok(getComment(root.id)?.resolvedAt);

    await connection.handle({ type: "deleteComment", threadId: root.id });
    assert.equal(getComment(root.id), undefined);
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
    );
  } finally {
    connection.dispose();
  }
});

test("comments re-anchor across edits, commits, renames, and revert", async () => {
  // Anchor on `return 2;` (line 6).
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "Should this be 3?",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 6 },
  });
  assert.equal(comment.anchorState, "anchored");
  assert.equal(comment.anchor?.dirty, false);
  assert.equal(comment.anchor?.selectors.quote.exact, "  return 2;");
  assert.deepEqual(comment.anchor?.selectors.block, {
    id: "6",
    occurrence: 1,
  });
  assert.deepEqual(comment.anchor?.selectors.position, {
    start: CODE.indexOf("  return 2;"),
    end: CODE.indexOf("  return 2;") + "  return 2;".length,
  });

  // Insert 3 lines above → the anchor should shift by +3 (hunk offset path).
  writeFileSync(
    join(record.path, "code.ts"),
    ["// header", "// header", "// header", CODE].join("\n"),
  );
  await reanchorWorktreeComments(record.id);
  let [root] = await listWorktreeComments(record.id);
  assert.equal(root?.current?.line, 9);
  assert.equal(root?.anchorState, "moved");

  // Commit the shift, then rename the file → the path should follow.
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "headers");
  sh(record.path, "mv", "code.ts", "logic.ts");
  sh(record.path, "commit", "-am", "rename");
  await reanchorWorktreeComments(record.id);
  [root] = await listWorktreeComments(record.id);
  assert.equal(root?.current?.path, "logic.ts");
  assert.equal(root?.current?.line, 9);

  // Rewrite the anchored line → no exact text anywhere → orphaned.
  const lines = ["// header", "// header", "// header", ...CODE.split("\n")];
  lines[8] = "  return 42; // changed";
  writeFileSync(join(record.path, "logic.ts"), lines.join("\n"));
  await reanchorWorktreeComments(record.id);
  [root] = await listWorktreeComments(record.id);
  assert.equal(root?.anchorState, "orphaned");
  assert.equal(root?.current, undefined);

  // Revert the rewrite → the anchor revives via fuzzy matching.
  lines[8] = "  return 2;";
  writeFileSync(join(record.path, "logic.ts"), lines.join("\n"));
  await reanchorWorktreeComments(record.id);
  [root] = await listWorktreeComments(record.id);
  assert.equal(root?.anchorState, "moved");
  assert.equal(root?.current?.line, 9);
});

test("blank-line gutter anchors follow hunk mapping instead of freezing", async () => {
  const text = ["before", "", "after", ""].join("\n");
  writeFileSync(join(record.path, "blank.txt"), text);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "blank-line fixture");
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "blank line spacing",
    author: { kind: "user" },
    anchor: { path: "blank.txt", side: "new", line: 2 },
  });
  assert.equal(comment.anchor?.selectors.quote.exact, "");

  writeFileSync(join(record.path, "blank.txt"), `inserted\n${text}`);
  await reanchorWorktreeComments(record.id);
  let moved = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(moved?.current?.line, 3);
  assert.equal(moved?.anchorState, "moved");

  writeFileSync(
    join(record.path, "blank.txt"),
    ["inserted", "before", "now occupied", "after", ""].join("\n"),
  );
  await reanchorWorktreeComments(record.id);
  moved = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(moved?.anchorState, "orphaned");
  assert.equal(moved?.current, undefined);
});

test("anchor dirty state stays relative to the captured HEAD", async () => {
  const base = ["before", "after", ""].join("\n");
  writeFileSync(join(record.path, "head-race.txt"), base);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "head race base");
  const capturedHead = sh(record.path, "rev-parse", "HEAD").trim();
  const displayed = ["before", "", "after", ""].join("\n");
  writeFileSync(join(record.path, "head-race.txt"), displayed);
  setAfterAnchorHeadForTests(async () => {
    sh(record.path, "add", "-A");
    sh(record.path, "commit", "-m", "advance during anchor build");
  });

  let comment: Awaited<ReturnType<typeof addWorktreeComment>>;
  try {
    comment = await addWorktreeComment({
      worktreeId: record.id,
      body: "blank from the displayed content",
      author: { kind: "user" },
      anchor: { path: "head-race.txt", side: "new", line: 2 },
    });
  } finally {
    setAfterAnchorHeadForTests(undefined);
  }
  assert.equal(comment.anchor?.commit, capturedHead);
  assert.equal(comment.anchor?.dirty, true);
  assert.deepEqual(comment.anchor?.selectors.position, { start: 7, end: 7 });

  await reanchorWorktreeComments(record.id);
  const listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(listed?.current?.line, 2);
  assert.equal(listed?.anchorState, "anchored");
});

test("dirty blank-line anchors use their blob coordinate system", async () => {
  const committed = ["before", "after", ""].join("\n");
  writeFileSync(join(record.path, "dirty-blank.txt"), committed);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "dirty blank base");

  const dirty = ["before", "", "after", ""].join("\n");
  writeFileSync(join(record.path, "dirty-blank.txt"), dirty);
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "keep this dirty blank line",
    author: { kind: "user" },
    anchor: { path: "dirty-blank.txt", side: "new", line: 2 },
  });
  assert.equal(comment.anchor?.dirty, true);
  assert.deepEqual(comment.anchor?.selectors.position, { start: 7, end: 7 });

  await reanchorWorktreeComments(record.id);
  let listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(listed?.current?.line, 2);
  assert.equal(listed?.anchorState, "anchored");

  writeFileSync(join(record.path, "dirty-blank.txt"), `top\n${dirty}`);
  await reanchorWorktreeComments(record.id);
  listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(listed?.current?.line, 3);
  assert.equal(listed?.anchorState, "moved");
});

test("legacy dirty rows derive wire position from the anchor blob", async () => {
  const committed = ["before", "target", "after", ""].join("\n");
  writeFileSync(join(record.path, "dirty-legacy.txt"), committed);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "dirty legacy base");
  const anchorCommit = sh(record.path, "rev-parse", "HEAD").trim();
  const dirty = ["inserted", "before", "target", "after", ""].join("\n");
  writeFileSync(join(record.path, "dirty-legacy.txt"), dirty);
  const anchorBlob = sh(
    record.path,
    "hash-object",
    "-w",
    "--",
    "dirty-legacy.txt",
  ).trim();
  const now = Date.now();
  insertComment({
    id: "dirty-legacy-row",
    worktreeId: record.id,
    parentId: null,
    authorKind: "user",
    authorSessionId: null,
    body: "legacy dirty position",
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: "dirty-legacy.txt",
    anchorSide: "new",
    anchorLine: 3,
    anchorCommit,
    anchorBlob,
    anchorDirty: true,
    anchorContextJson: JSON.stringify({
      before: ["inserted", "before"],
      line: "target",
      after: ["after", ""],
    }),
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: "dirty-legacy.txt",
    currentLine: 3,
    anchorState: "anchored",
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
  });

  const listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "dirty-legacy-row",
  );
  const start = dirty.indexOf("target");
  assert.deepEqual(listed?.anchor?.selectors.position, {
    start,
    end: start + "target".length,
  });
});

test("legacy dirty rows fall back to quote resolution when their blob was never written", async () => {
  const base = ["before", "after", ""].join("\n");
  writeFileSync(join(record.path, "dirty-unwritten.txt"), base);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "unwritten dirty base");
  const anchorCommit = sh(record.path, "rev-parse", "HEAD").trim();
  const dirtyAnchor = ["dirty-only", "before", "legacy target unique", ""].join(
    "\n",
  );
  writeFileSync(join(record.path, "dirty-unwritten.txt"), dirtyAnchor);
  const unwrittenBlob = sh(
    record.path,
    "hash-object",
    "--",
    "dirty-unwritten.txt",
  ).trim();
  assert.equal(gitObjectExists(record.path, unwrittenBlob), false);
  writeFileSync(
    join(record.path, "dirty-unwritten.txt"),
    `new current prefix\n${dirtyAnchor}`,
  );

  const now = Date.now();
  insertComment({
    id: "dirty-unwritten-row",
    worktreeId: record.id,
    parentId: null,
    authorKind: "user",
    authorSessionId: null,
    body: "resolve without the historical blob",
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: "dirty-unwritten.txt",
    anchorSide: "new",
    anchorLine: 3,
    anchorCommit,
    anchorBlob: unwrittenBlob,
    anchorDirty: true,
    anchorContextJson: JSON.stringify({
      before: ["dirty-only", "before"],
      line: "legacy target unique",
      after: [""],
    }),
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: "dirty-unwritten.txt",
    currentLine: 3,
    anchorState: "anchored",
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
  });

  await reanchorWorktreeComments(record.id);
  const listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "dirty-unwritten-row",
  );
  assert.equal(listed?.current?.line, 4);
  assert.equal(listed?.anchorState, "moved");
  assert.equal(listed?.anchor?.selectors.quote.exact, "legacy target unique");
  assert.equal(listed?.anchor?.selectors.position, undefined);
  assert.equal(gitObjectExists(record.path, unwrittenBlob), false);
});

test("legacy dirty recovery never follows a symlink outside the worktree", async () => {
  const reviewedPath = join(record.path, "dirty-symlink.txt");
  writeFileSync(reviewedPath, "safe content\n");
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "dirty symlink base");
  const anchorCommit = sh(record.path, "rev-parse", "HEAD").trim();
  const outsidePath = join(tmp, "outside-dirty-anchor.txt");
  const outsideContent = "outside secret unique to symlink regression\n";
  writeFileSync(outsidePath, outsideContent);
  const missingBlob = sh(record.path, "hash-object", "--", outsidePath).trim();
  assert.equal(gitObjectExists(record.path, missingBlob), false);
  unlinkSync(reviewedPath);
  symlinkSync(outsidePath, reviewedPath);

  const now = Date.now();
  insertComment({
    id: "dirty-symlink-row",
    worktreeId: record.id,
    parentId: null,
    authorKind: "user",
    authorSessionId: null,
    body: "must not read the symlink target",
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: "dirty-symlink.txt",
    anchorSide: "new",
    anchorLine: 1,
    anchorCommit,
    anchorBlob: missingBlob,
    anchorDirty: true,
    anchorContextJson: JSON.stringify({
      before: [],
      line: outsideContent.trimEnd(),
      after: [""],
    }),
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: "dirty-symlink.txt",
    currentLine: 1,
    anchorState: "anchored",
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
  });

  let listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "dirty-symlink-row",
  );
  assert.equal(listed?.anchor?.selectors.position, undefined);
  assert.equal(gitObjectExists(record.path, missingBlob), false);

  await reanchorWorktreeComments(record.id);
  listed = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "dirty-symlink-row",
  );
  assert.equal(listed?.anchorState, "orphaned");
  assert.equal(gitObjectExists(record.path, missingBlob), false);
});

test("hunk-mapped block beats a duplicate at the stale anchor offsets", async () => {
  const original = ["header", "const answer = trueTarget;", "after", ""].join(
    "\n",
  );
  writeFileSync(join(record.path, "duplicate.ts"), original);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "duplicate-position fixture");
  const start = original.indexOf("answer");
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "the true target",
    author: { kind: "user" },
    anchor: {
      path: "duplicate.ts",
      side: "new",
      line: 2,
      selectors: {
        quote: { exact: "answer", prefix: "", suffix: "" },
        position: { start, end: start + "answer".length },
        block: { id: "2", occurrence: 1 },
      },
    },
  });

  // The inserted line puts an unrelated `answer` at exactly the old character
  // offsets, while Git maps the original full line down to line 3.
  writeFileSync(
    join(record.path, "duplicate.ts"),
    ["header", "xxxxxxanswer", "const answer = trueTarget;", "after", ""].join(
      "\n",
    ),
  );
  await reanchorWorktreeComments(record.id);
  const moved = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(moved?.current?.line, 3);
  assert.equal(moved?.anchorState, "moved");
});

test("sub-line relocation on the same line reports moved", async () => {
  const original = ["before", "const answer = 42;", "after", ""].join("\n");
  writeFileSync(join(record.path, "same-line.ts"), original);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "same-line fixture");
  const start = original.indexOf("answer");
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "selected token",
    author: { kind: "user" },
    anchor: {
      path: "same-line.ts",
      side: "new",
      line: 2,
      selectors: {
        quote: { exact: "answer", prefix: "", suffix: "" },
        position: { start, end: start + "answer".length },
        block: { id: "2", occurrence: 1 },
      },
    },
  });

  writeFileSync(
    join(record.path, "same-line.ts"),
    ["before", "const new answer = 42;", "after", ""].join("\n"),
  );
  await reanchorWorktreeComments(record.id);
  const moved = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(moved?.current?.line, 2);
  assert.equal(moved?.anchorState, "moved");
});

test("sub-line selectors survive hunk mapping and resolve to the moved line", async () => {
  const text = ["before", "const answer = fortyTwo();", "after", ""].join("\n");
  writeFileSync(join(record.path, "selection.ts"), text);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "selection fixture");
  const anchorCommit = sh(record.path, "rev-parse", "HEAD").trim();
  const now = Date.now();
  insertComment({
    id: "legacy-selector-row",
    worktreeId: record.id,
    parentId: null,
    authorKind: "user",
    authorSessionId: null,
    body: "legacy selector derivation",
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: "selection.ts",
    anchorSide: "new",
    anchorLine: 2,
    anchorCommit,
    anchorBlob: "",
    anchorDirty: false,
    anchorContextJson: JSON.stringify({
      before: ["before"],
      line: "const answer = fortyTwo();",
      after: ["after", ""],
    }),
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: "selection.ts",
    currentLine: 2,
    anchorState: "anchored",
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
  });
  const legacy = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "legacy-selector-row",
  );
  assert.equal(
    legacy?.anchor?.selectors.quote.exact,
    "const answer = fortyTwo();",
  );
  assert.deepEqual(legacy?.anchor?.selectors.block, {
    id: "2",
    occurrence: 1,
  });
  assert.deepEqual(legacy?.anchor?.selectors.position, {
    start: text.indexOf("const answer"),
    end: text.indexOf("const answer") + "const answer = fortyTwo();".length,
  });

  const start = text.indexOf("answer");
  await assert.rejects(
    addWorktreeComment({
      worktreeId: record.id,
      body: "stale selection",
      author: { kind: "user" },
      anchor: {
        path: "selection.ts",
        side: "new",
        line: 2,
        selectors: {
          quote: { exact: "answer", prefix: "", suffix: "" },
          position: { start: start + 1, end: start + 1 + "answer".length },
        },
      },
    }),
    /selected text no longer matches the displayed file/i,
  );
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "name this more clearly",
    author: { kind: "user" },
    anchor: {
      path: "selection.ts",
      side: "new",
      line: 2,
      selectors: {
        quote: { exact: "answer", prefix: "", suffix: "" },
        position: { start, end: start + "answer".length },
        block: { id: "2", occurrence: 1 },
      },
    },
  });
  assert.equal(comment.anchor?.selectors.quote.exact, "answer");

  writeFileSync(join(record.path, "selection.ts"), `// inserted\n${text}`);
  await reanchorWorktreeComments(record.id);
  const moved = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(moved?.current?.line, 3);
  assert.equal(moved?.anchorState, "moved");
  assert.equal(moved?.anchor?.selectors.quote.exact, "answer");
  const movedLegacy = (await listWorktreeComments(record.id)).find(
    (item) => item.id === "legacy-selector-row",
  );
  assert.equal(movedLegacy?.current?.line, 3);
  assert.equal(
    movedLegacy?.anchor?.selectors.quote.exact,
    "const answer = fortyTwo();",
  );
});

test("re-anchoring survives a pure rename of a file larger than the fuzzy window", async () => {
  // 200 distinct lines: without rename detection the diff reads as a full add,
  // mapping the anchor past the end and outside the ±50 fuzzy window.
  const bigLines = Array.from(
    { length: 200 },
    (_, index) => `line-${index + 1}: ${index * 7}`,
  );
  writeFileSync(join(record.path, "big.txt"), `${bigLines.join("\n")}\n`);
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "big file");

  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "Anchor deep in a big file",
    author: { kind: "user" },
    anchor: { path: "big.txt", side: "new", line: 150 },
  });
  sh(record.path, "mv", "big.txt", "renamed-big.txt");
  sh(record.path, "commit", "-am", "rename big file");

  await reanchorWorktreeComments(record.id);
  const root = (await listWorktreeComments(record.id)).find(
    (item) => item.id === comment.id,
  );
  assert.equal(root?.current?.path, "renamed-big.txt");
  assert.equal(root?.current?.line, 150);
  assert.equal(root?.anchorState, "moved");
});

test("agent tools list, reply, and resolve threads; prompt includes anchors", async () => {
  const roots = (await listWorktreeComments(record.id)).filter(
    (comment) => !comment.parentId,
  );
  const rootId = roots[0]!.id;

  // The agent session runs inside the worktree (in_worktree edge).
  linkSessionToWorktree("agent-sess", record.id);
  const ctx = {
    toolCallId: "t1",
    session: {
      sessionId: "agent-sess",
      harness: "pi" as const,
      agentType: "workshop" as const,
    },
  };

  const [listTool, replyTool, resolveTool] = worktreeReviewTools;
  const listed = JSON.parse(
    (await listTool!.execute({}, ctx)).content[0]!.type === "text"
      ? ((await listTool!.execute({}, ctx)).content[0] as { text: string }).text
      : "{}",
  ) as { threads: Array<{ id: string }> };
  assert.ok(listed.threads.some((thread) => thread.id === rootId));

  await replyTool!.execute(
    { commentId: rootId, text: "Changed it to 3." },
    ctx,
  );
  const withReply = await listWorktreeComments(record.id);
  const reply = withReply.find((comment) => comment.parentId === rootId);
  assert.equal(reply?.author.kind, "agent");
  assert.equal(reply?.body, "Changed it to 3.");

  await resolveTool!.execute({ commentId: rootId, resolved: true }, ctx);
  const resolved = (await listWorktreeComments(record.id)).find(
    (comment) => comment.id === rootId,
  );
  assert.ok(resolved?.resolvedAt);
  assert.equal(resolved?.resolvedBy, "agent-sess");

  // Reopen from the user side and check the handoff prompt.
  resolveWorktreeComment(rootId, false, "user");
  const prompt = (await buildReviewHandoffPrompt({
    worktreeId: record.id,
    commentIds: [rootId],
  }))!;
  assert.match(prompt, /logic\.ts:9/);
  assert.match(prompt, /Should this be 3\?/);
  assert.match(prompt, /review_comment_reply/);
});

test("ref anchors pin an older commit's content and re-anchor forward", async () => {
  // Two commits: the anchored line moves in the second one. Commenting "at" the
  // first commit must snapshot that commit's content and still map to current.
  writeFileSync(
    join(record.path, "story.txt"),
    ["one", "two", "three", ""].join("\n"),
  );
  sh(record.path, "add", "-A");
  sh(record.path, "commit", "-m", "story v1");
  const refOid = sh(record.path, "rev-parse", "HEAD").trim();

  writeFileSync(
    join(record.path, "story.txt"),
    ["intro", "one", "two", "three", ""].join("\n"),
  );
  sh(record.path, "commit", "-am", "story v2");

  // Anchor on "two" (line 2 at the FIRST commit; line 3 now).
  const comment = await addWorktreeComment({
    worktreeId: record.id,
    body: "Ref-anchored on two",
    author: { kind: "user" },
    anchor: { path: "story.txt", side: "new", line: 2, ref: refOid },
  });
  assert.equal(comment.anchor?.commit, refOid);
  assert.equal(comment.anchor?.dirty, false);
  // Creation already mapped the seed position forward to current content.
  assert.equal(comment.current?.line, 3);
  assert.equal(comment.anchorState, "moved");

  // An unknown revision or an out-of-range line at the ref must be rejected.
  await assert.rejects(
    addWorktreeComment({
      worktreeId: record.id,
      body: "bad ref",
      author: { kind: "user" },
      anchor: {
        path: "story.txt",
        side: "new",
        line: 2,
        ref: "does-not-exist",
      },
    }),
    /unknown revision/i,
  );
  await assert.rejects(
    addWorktreeComment({
      worktreeId: record.id,
      body: "bad line",
      author: { kind: "user" },
      anchor: { path: "story.txt", side: "new", line: 99, ref: refOid },
    }),
    /does not exist at that revision/i,
  );
});

async function createPendingBranchCleanup(name: string) {
  const victim = await createWorktree({ projectId: "cm-proj", name });
  writeFileSync(join(victim.path, `${name}.txt`), "squashed delivery\n");
  sh(victim.path, "add", `${name}.txt`);
  sh(victim.path, "commit", "-m", `${name} branch commit`);
  sh(repoPath, "merge", "--squash", victim.branch);
  sh(repoPath, "commit", "-m", `${name} squash`);

  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const fakeBin = join(tmp, `${name}-update-ref-bin`);
  mkdirSync(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh\nif [ "$1" = update-ref ]; then\n  echo forced update-ref failure >&2\n  exit 42\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    await assert.rejects(
      () => removeWorktree(victim.id, { deleteBranch: true }),
      /forced update-ref failure/i,
    );
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(getWorktree(victim.id)?.status, "removed");
  assert.ok(getWorktree(victim.id)?.branchCleanupOid);
  return victim;
}

function insertStoredComment(
  id: string,
  worktreeId: string,
  parentId: string | null = null,
): void {
  const now = Date.now();
  insertComment({
    id,
    worktreeId,
    parentId,
    authorKind: "user",
    authorSessionId: null,
    body: id,
    resolvedAt: null,
    resolvedBy: null,
    anchorPath: parentId ? null : "code.ts",
    anchorSide: parentId ? null : "new",
    anchorLine: parentId ? null : 1,
    anchorCommit: null,
    anchorBlob: null,
    anchorDirty: null,
    anchorContextJson: null,
    anchorQuoteExact: null,
    anchorQuotePrefix: null,
    anchorQuoteSuffix: null,
    anchorPositionStart: null,
    anchorPositionEnd: null,
    anchorBlockId: null,
    anchorBlockOccurrence: null,
    currentPath: parentId ? null : "code.ts",
    currentLine: parentId ? null : 1,
    anchorState: parentId ? null : "anchored",
    attachedSessionId: null,
    ownerWorktreeId: null,
    ownerBranch: null,
    ownerSource: null,
    createdAt: now,
    updatedAt: now,
  });
}

test("removing a worktree purges its threads only and broadcasts the empty list", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "remove-comments",
  });
  const other = await createWorktree({
    projectId: "cm-proj",
    name: "keep-comments",
  });
  const root = await addWorktreeComment({
    worktreeId: victim.id,
    body: "root to purge",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  await addWorktreeComment({
    worktreeId: victim.id,
    parentId: root.id,
    body: "reply to purge through the parent cascade",
    author: { kind: "user" },
  });
  await addWorktreeComment({
    worktreeId: other.id,
    body: "keep another worktree",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const mainId = mainWorktreeId("cm-proj");
  await addWorktreeComment({
    worktreeId: mainId,
    body: "keep main",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const mainCount = listComments(mainId).length;

  setWorktreeBroadcaster({
    broadcast: () => undefined,
    broadcastWorktree: () => undefined,
  });
  try {
    await removeWorktree(victim.id, { force: true, deleteBranch: true });
  } finally {
    setWorktreeBroadcaster({
      broadcast: () => undefined,
      broadcastWorktree: () => undefined,
    });
  }

  assert.equal(listComments(victim.id).length, 0);
  assert.equal(listComments(other.id).length, 1);
  assert.equal(listComments(mainId).length, mainCount);
  await removeWorktree(other.id, { force: true, deleteBranch: true });
});

test("a failed worktree removal leaves comments intact", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "failed-remove-comments",
  });
  await addWorktreeComment({
    worktreeId: victim.id,
    body: "must survive failure",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  // A locked checkout makes the actual `git worktree remove --force` command
  // fail (Git requires force twice for a locked worktree).
  sh(repoPath, "worktree", "lock", victim.path);
  await assert.rejects(
    () => removeWorktree(victim.id, { force: true }),
    /locked working tree/i,
  );
  assert.equal(listComments(victim.id).length, 1);

  sh(repoPath, "worktree", "unlock", victim.path);
  await removeWorktree(victim.id, { force: true, deleteBranch: true });
});

test("orphan sweep is dry by default and spares live and main comments", async () => {
  const live = await createWorktree({
    projectId: "cm-proj",
    name: "sweep-live",
  });
  await addWorktreeComment({
    worktreeId: live.id,
    body: "live comment",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const removed = await createWorktree({
    projectId: "cm-proj",
    name: "sweep-removed",
  });
  insertStoredComment("sweep-removed-root", removed.id);
  insertStoredComment("sweep-removed-reply", removed.id, "sweep-removed-root");
  markWorktreeRemovedForTests(removed.id);
  insertStoredComment("sweep-missing-root", live.id);
  reassignCommentWorktreeForTests("sweep-missing-root", "missing-worktree");
  const mainId = mainWorktreeId("cm-proj");
  const mainCount = listComments(mainId).length;

  const dryRun = sweepOrphanedWorktreeComments();
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.totalComments, 3);
  assert.deepEqual(
    dryRun.candidates
      .map(({ worktreeId, branch, commentCount }) => ({
        worktreeId,
        branch,
        commentCount,
      }))
      .sort((a, b) => a.worktreeId.localeCompare(b.worktreeId)),
    [
      {
        worktreeId: "missing-worktree",
        branch: null,
        commentCount: 1,
      },
      {
        worktreeId: removed.id,
        branch: removed.branch,
        commentCount: 2,
      },
    ].sort((a, b) => a.worktreeId.localeCompare(b.worktreeId)),
  );
  assert.equal(listComments(removed.id).length, 2);
  assert.equal(listComments("missing-worktree").length, 1);
  assert.equal(listComments(live.id).length, 1);
  assert.equal(listComments(mainId).length, mainCount);

  const deletion = sweepOrphanedWorktreeComments({ deleteComments: true });
  assert.equal(deletion.deletedComments, 3);
  assert.equal(listComments(removed.id).length, 0);
  assert.equal(listComments("missing-worktree").length, 0);
  assert.equal(listComments(live.id).length, 1);
  assert.equal(listComments(mainId).length, mainCount);

  await removeWorktree(live.id, { force: true, deleteBranch: true });
});

test("worktree deletion refuses cross-scope cascades and synthetic main", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "cross-scope-victim",
  });
  const other = await createWorktree({
    projectId: "cm-proj",
    name: "cross-scope-other",
  });
  const root = await addWorktreeComment({
    worktreeId: victim.id,
    body: "victim root",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const otherReply = await addWorktreeComment({
    worktreeId: victim.id,
    parentId: root.id,
    body: "historically malformed other reply",
    author: { kind: "user" },
  });
  const mainReply = await addWorktreeComment({
    worktreeId: victim.id,
    parentId: root.id,
    body: "historically malformed main reply",
    author: { kind: "user" },
  });
  const mainId = mainWorktreeId("cm-proj");
  reassignCommentWorktreeForTests(otherReply.id, other.id);
  reassignCommentWorktreeForTests(mainReply.id, mainId);

  assert.throws(
    () => deleteWorktreeComments(victim.id),
    /descendant .* belongs to/i,
  );
  assert.equal(listComments(victim.id).length, 1);
  assert.equal(listComments(other.id).length, 1);
  assert.ok(
    listComments(mainId).some((comment) => comment.id === mainReply.id),
  );
  assert.throws(
    () => deleteWorktreeComments(mainId),
    /synthetic-main comments cannot be deleted/i,
  );

  reassignCommentWorktreeForTests(otherReply.id, victim.id);
  reassignCommentWorktreeForTests(mainReply.id, victim.id);
  await removeWorktree(victim.id, { force: true, deleteBranch: true });
  await removeWorktree(other.id, { force: true, deleteBranch: true });
});

test("removal rejects a target comment parented into another worktree before Git", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "inverse-scope-victim",
  });
  const other = await createWorktree({
    projectId: "cm-proj",
    name: "inverse-scope-other",
  });
  const victimRoot = await addWorktreeComment({
    worktreeId: victim.id,
    body: "victim root",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  const victimReply = await addWorktreeComment({
    worktreeId: victim.id,
    parentId: victimRoot.id,
    body: "victim reply with corrupted parent",
    author: { kind: "user" },
  });
  const otherRoot = await addWorktreeComment({
    worktreeId: other.id,
    body: "other root",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  reparentCommentForTests(victimReply.id, otherRoot.id);

  await assert.rejects(
    () => removeWorktree(victim.id, { force: true }),
    /not in a .*rooted thread/i,
  );
  assert.equal(existsSync(victim.path), true);
  assert.equal(getWorktree(victim.id)?.status, "active");
  assert.equal(listComments(victim.id).length, 2);
  assert.equal(listComments(other.id).length, 1);

  reparentCommentForTests(victimReply.id, victimRoot.id);
  await removeWorktree(victim.id, { force: true, deleteBranch: true });
  await removeWorktree(other.id, { force: true, deleteBranch: true });
});

test("normal cleanup deletes a squash-contained branch without force", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "squash-cleanup",
  });
  writeFileSync(join(victim.path, "squashed.txt"), "same final tree\n");
  sh(victim.path, "add", "squashed.txt");
  sh(victim.path, "commit", "-m", "branch-only commit");
  sh(repoPath, "merge", "--squash", victim.branch);
  sh(repoPath, "commit", "-m", "squash branch");

  await removeWorktree(victim.id, { deleteBranch: true });
  assert.equal(existsSync(victim.path), false);
  assert.equal(getWorktree(victim.id)?.status, "removed");
  assert.equal(getWorktree(victim.id)?.branchCleanupOid, null);
  assert.throws(() =>
    execFileSync(
      "git",
      ["show-ref", "--verify", `refs/heads/${victim.branch}`],
      { cwd: repoPath, stdio: "ignore" },
    ),
  );
});

test("pending cleanup refuses a reused branch whose oid changed", async () => {
  const victim = await createPendingBranchCleanup("changed-cleanup-ref");
  sh(repoPath, "branch", "-D", victim.branch);
  const reusedOid = sh(
    repoPath,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "replacement branch",
  ).trim();
  sh(repoPath, "branch", victim.branch, reusedOid);

  await assert.rejects(
    () => removeWorktree(victim.id, { force: true, deleteBranch: true }),
    /newer branch was not deleted/i,
  );
  assert.equal(
    sh(repoPath, "rev-parse", `refs/heads/${victim.branch}`).trim(),
    reusedOid,
  );
  assert.equal(getWorktree(victim.id)?.branchCleanupOid, null);
  sh(repoPath, "branch", "-D", victim.branch);
});

test("pending cleanup refuses a branch checked out in another worktree", async () => {
  const victim = await createPendingBranchCleanup("checked-out-cleanup");
  const otherPath = join(tmp, "checked-out-cleanup-other");
  sh(repoPath, "worktree", "add", otherPath, victim.branch);

  await assert.rejects(
    () => removeWorktree(victim.id, { force: true, deleteBranch: true }),
    /checked out in another worktree/i,
  );
  assert.equal(
    sh(repoPath, "rev-parse", `refs/heads/${victim.branch}`).trim(),
    getWorktree(victim.id)?.branchCleanupOid,
  );
  assert.ok(getWorktree(victim.id)?.branchCleanupOid);

  sh(repoPath, "worktree", "remove", "--force", otherPath);
  await removeWorktree(victim.id, { force: true, deleteBranch: true });
  assert.equal(getWorktree(victim.id)?.branchCleanupOid, null);
});

test("fatal branch probes preserve pending cleanup", async () => {
  const victim = await createPendingBranchCleanup("fatal-probe-cleanup");
  const expectedOid = getWorktree(victim.id)?.branchCleanupOid;
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const fakeBin = join(tmp, "fatal-probe-bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh\nif [ "$1" = show-ref ] && [ "$2" = --verify ]; then\n  echo forced ref probe failure >&2\n  exit 42\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    await assert.rejects(
      () => removeWorktree(victim.id, { force: true, deleteBranch: true }),
      (error) =>
        error instanceof WorktreeBranchCleanupError &&
        /could not be inspected.*forced ref probe failure/i.test(error.message),
    );
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(getWorktree(victim.id)?.branchCleanupOid, expectedOid);
  assert.doesNotThrow(() =>
    sh(repoPath, "show-ref", "--verify", `refs/heads/${victim.branch}`),
  );
  await removeWorktree(victim.id, { force: true, deleteBranch: true });
});

test("concurrent retries re-read the pending cleanup claim under the repo lock", async () => {
  const victim = await createPendingBranchCleanup("concurrent-cleanup");
  const results = await Promise.allSettled([
    removeWorktree(victim.id, { force: true, deleteBranch: true }),
    removeWorktree(victim.id, { force: true, deleteBranch: true }),
  ]);

  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /unknown worktree/i);
  assert.equal(getWorktree(victim.id)?.branchCleanupOid, null);
});

test("failed prune for an externally absent folder preserves comments", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "failed-prune-comments",
  });
  await addWorktreeComment({
    worktreeId: victim.id,
    body: "must survive prune failure",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  rmSync(victim.path, { recursive: true, force: true });

  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const fakeBin = join(tmp, "failed-prune-bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = prune ]; then\n  echo forced prune failure >&2\n  exit 42\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
  try {
    await assert.rejects(
      () => removeWorktree(victim.id, { force: true }),
      /forced prune failure/i,
    );
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(getWorktree(victim.id)?.status, "active");
  assert.equal(listComments(victim.id).length, 1);

  await removeWorktree(victim.id, { force: true, deleteBranch: true });
});

test("comment insertion serializes with removal finalization", async () => {
  const victim = await createWorktree({
    projectId: "cm-proj",
    name: "concurrent-comment-remove",
  });
  let enteredInsert!: () => void;
  const atInsert = new Promise<void>((resolve) => {
    enteredInsert = resolve;
  });
  let releaseInsert!: () => void;
  const insertReleased = new Promise<void>((resolve) => {
    releaseInsert = resolve;
  });
  setBeforeCommentInsertForTests(async () => {
    enteredInsert();
    await insertReleased;
  });

  const adding = addWorktreeComment({
    worktreeId: victim.id,
    body: "racing comment",
    author: { kind: "user" },
    anchor: { path: "code.ts", side: "new", line: 1 },
  });
  await atInsert;
  try {
    await removeWorktree(victim.id, { force: true, deleteBranch: true });
  } finally {
    releaseInsert();
    setBeforeCommentInsertForTests(undefined);
  }
  await assert.rejects(adding, /unknown worktree/i);
  assert.equal(getWorktree(victim.id)?.status, "removed");
  assert.equal(listComments(victim.id).length, 0);
});

test("destructive orphan sweep rolls back every candidate on a later failure", async () => {
  const seed = await createWorktree({
    projectId: "cm-proj",
    name: "atomic-sweep-seed",
  });
  insertStoredComment("atomic-sweep-valid", seed.id);
  insertStoredComment("atomic-sweep-invalid", seed.id);
  insertStoredComment(
    "atomic-sweep-main-descendant",
    seed.id,
    "atomic-sweep-invalid",
  );
  reassignCommentWorktreeForTests("atomic-sweep-valid", "a-valid-orphan");
  reassignCommentWorktreeForTests("atomic-sweep-invalid", "z-invalid-orphan");
  reassignCommentWorktreeForTests(
    "atomic-sweep-main-descendant",
    mainWorktreeId("cm-proj"),
  );

  assert.throws(
    () => sweepOrphanedWorktreeComments({ deleteComments: true }),
    /descendant .* belongs to/i,
  );
  assert.equal(listComments("a-valid-orphan").length, 1);
  assert.equal(listComments("z-invalid-orphan").length, 1);
  assert.equal(
    listComments(mainWorktreeId("cm-proj")).filter(
      (comment) => comment.id === "atomic-sweep-main-descendant",
    ).length,
    1,
  );

  reassignCommentWorktreeForTests("atomic-sweep-valid", seed.id);
  reassignCommentWorktreeForTests("atomic-sweep-invalid", seed.id);
  reassignCommentWorktreeForTests("atomic-sweep-main-descendant", seed.id);
  await removeWorktree(seed.id, { force: true, deleteBranch: true });
});

test("agent review sets snapshot authorship, roll up resolution, and leave claims framing to the draft", async () => {
  const reviewWorktree = await createWorktree({
    projectId: "cm-proj",
    name: "agent-review-set",
  });
  writeFileSync(
    join(reviewWorktree.path, "finding.ts"),
    "export const value = 1;\n",
  );
  sh(reviewWorktree.path, "add", "finding.ts");
  sh(reviewWorktree.path, "commit", "-m", "review fixture");

  const sessionId = "review-set-author";
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "workshop",
    model: "review-model-v1",
    thinkingLevel: "high",
  });
  linkSessionToWorktree(sessionId, reviewWorktree.id);
  const ctx = {
    toolCallId: "review-set-call",
    session: {
      sessionId,
      harness: "pi" as const,
      agentType: "workshop" as const,
    },
  };
  const tools = new Map(worktreeReviewTools.map((tool) => [tool.name, tool]));
  const openTool = tools.get("review_set_open")!;
  const createTool = tools.get("review_comment_create")!;
  const replyTool = tools.get("review_comment_reply")!;
  const resolveTool = tools.get("review_comment_resolve")!;
  const closeTool = tools.get("review_set_close")!;
  const openResult = await openTool.execute({ blind: false }, ctx);
  const openContent = openResult.content[0];
  const opened = JSON.parse(
    openContent?.type === "text" ? openContent.text : "{}",
  ) as { reviewSetId: string };

  // Changing the session later must not rewrite the set's as-of-open snapshot.
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "workshop",
    model: "review-model-v2",
    thinkingLevel: "medium",
  });
  const createResult = await createTool.execute(
    {
      path: "finding.ts",
      line: 1,
      body: "This exported value needs validation.",
      severity: "major",
      reviewSetId: opened.reviewSetId,
    },
    ctx,
  );
  const createContent = createResult.content[0];
  const created = JSON.parse(
    createContent?.type === "text" ? createContent.text : "{}",
  ) as { commentId: string };
  const comment = (await listWorktreeComments(reviewWorktree.id)).find(
    (row) => row.id === created.commentId,
  );
  assert.deepEqual(comment?.author, {
    kind: "agent",
    sessionId,
    model: "review-model-v2",
    thinkingLevel: "medium",
  });
  assert.equal(comment?.severity, "major");
  assert.equal(comment?.reviewSetId, opened.reviewSetId);

  let [set] = listWorktreeReviewSets(reviewWorktree.id);
  assert.equal(set?.authorModel, "review-model-v1");
  assert.equal(set?.authorThinkingLevel, "high");
  assert.equal(set?.openCount, 1);
  assert.equal(set?.addressedCount, 0);

  const prompt = (await buildReviewHandoffPrompt({
    worktreeId: reviewWorktree.id,
    commentIds: [created.commentId],
  }))!;
  // One handoff helper serves the browser and the workflow fixer, so the
  // findings-are-claims framing reaches both from here (Task-520).
  assert.match(prompt, /Findings are claims, not orders/);
  assert.match(prompt, /\[major\]/);
  await replyTool.execute(
    { commentId: created.commentId, text: "Clarifying my own finding." },
    ctx,
  );
  [set] = listWorktreeReviewSets(reviewWorktree.id);
  assert.equal(set?.openCount, 1, "a reply alone does not resolve the thread");
  assert.equal(
    set?.addressedCount,
    0,
    "the reviewer's own clarification is not a fixer disposition",
  );
  await addWorktreeComment({
    worktreeId: reviewWorktree.id,
    body: "Verified and fixed at the source.",
    parentId: created.commentId,
    author: { kind: "agent", sessionId: "fixer-session" },
  });
  [set] = listWorktreeReviewSets(reviewWorktree.id);
  assert.equal(set?.openCount, 1);
  assert.equal(set?.addressedCount, 1);
  await resolveTool.execute(
    { commentId: created.commentId, resolved: true },
    ctx,
  );
  [set] = listWorktreeReviewSets(reviewWorktree.id);
  assert.equal(set?.openCount, 0);
  assert.equal(set?.addressedCount, 1);

  await closeTool.execute(
    {
      reviewSetId: opened.reviewSetId,
      verdict: "approve-with-fixes",
      summary: "One major finding was addressed.",
    },
    ctx,
  );
  [set] = listWorktreeReviewSets(reviewWorktree.id);
  assert.equal(set?.verdict, "approve-with-fixes");
  assert.equal(set?.summary, "One major finding was addressed.");

  await removeWorktree(reviewWorktree.id, {
    force: true,
    deleteBranch: true,
  });
  assert.deepEqual(listWorktreeReviewSets(reviewWorktree.id), []);
});

test("blind review sets isolate agent discovery until the whole round closes", async () => {
  const reviewWorktree = await createWorktree({
    projectId: "cm-proj",
    name: "blind-review-round",
  });
  writeFileSync(
    join(reviewWorktree.path, "blind.ts"),
    "export const blind = true;\n",
  );
  sh(reviewWorktree.path, "add", "blind.ts");
  sh(reviewWorktree.path, "commit", "-m", "blind fixture");
  const tools = new Map(worktreeReviewTools.map((tool) => [tool.name, tool]));
  const openTool = tools.get("review_set_open")!;
  const createTool = tools.get("review_comment_create")!;
  const listTool = tools.get("review_comments_list")!;
  const closeTool = tools.get("review_set_close")!;
  const contexts = ["blind-reviewer-a", "blind-reviewer-b"].map((sessionId) => {
    sessionStore.upsert({
      id: sessionId,
      harness: "pi",
      agentType: "workshop",
      model: sessionId,
    });
    linkSessionToWorktree(sessionId, reviewWorktree.id);
    return {
      toolCallId: sessionId,
      session: {
        sessionId,
        harness: "pi" as const,
        agentType: "workshop" as const,
      },
    };
  });
  const setIds: string[] = [];
  for (const ctx of contexts) {
    const result = await openTool.execute({ blind: true }, ctx);
    const content = result.content[0];
    const opened = JSON.parse(
      content?.type === "text" ? content.text : "{}",
    ) as { reviewSetId: string };
    setIds.push(opened.reviewSetId);
    await createTool.execute(
      {
        path: "blind.ts",
        line: 1,
        body: `Finding from ${ctx.session.sessionId}`,
        severity: "minor",
      },
      ctx,
    );
  }

  const listFor = async (ctx: (typeof contexts)[number]) => {
    const result = await listTool.execute({}, ctx);
    const content = result.content[0];
    return JSON.parse(content?.type === "text" ? content.text : "{}") as {
      threads: Array<{ body: string }>;
    };
  };
  let listed = await listFor(contexts[0]!);
  assert.deepEqual(
    listed.threads.map((thread) => thread.body),
    ["Finding from blind-reviewer-a"],
  );
  await closeTool.execute(
    { reviewSetId: setIds[0], verdict: "approve", summary: "A done" },
    contexts[0]!,
  );
  listed = await listFor(contexts[0]!);
  assert.deepEqual(
    listed.threads.map((thread) => thread.body),
    ["Finding from blind-reviewer-a"],
  );
  await closeTool.execute(
    { reviewSetId: setIds[1], verdict: "approve", summary: "B done" },
    contexts[1]!,
  );
  listed = await listFor(contexts[0]!);
  assert.equal(listed.threads.length, 2);
});
