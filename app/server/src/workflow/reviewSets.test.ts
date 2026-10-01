import { applyPatch } from "@assistant/shared";
/**
 * Publishing a workflow assessment as a durable review set, and reading back
 * what the fix round left on its threads ([Task-520](pa://task/520)).
 *
 * The review store and its git worktree are REAL here — anchoring is what makes
 * a finding a thread on the diff, and a fake store would prove nothing about
 * it. Only the run/step rows are hand-built.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import type { WorkflowStepRow } from "../db/workflowStore.ts";
import type { Assessment, ImplementationResult } from "./resultContracts.ts";

const tmp = mkdtempSync(join(tmpdir(), "workflow-review-sets-test-"));
process.env.ASSISTANT_CWD = tmp;

/**
 * The review surface refusing ONE disposition, which settlement warns and skips
 * (`settleReCheckedThreads`). Everything else is the real module: what is being
 * tested is that the settlement snapshot reports the thread as it durably is,
 * not as the re-check meant it to be.
 */
const refusedResolutions = vi.hoisted(() => new Set<string>());
vi.mock("../worktrees/worktreeComments.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../worktrees/worktreeComments.ts")>();
  return {
    ...actual,
    resolveWorktreeComment(commentId: string, resolved: boolean, by: string) {
      if (refusedResolutions.has(commentId))
        throw new Error("the review surface is unavailable");
      return actual.resolveWorktreeComment(commentId, resolved, by);
    },
  };
});

const { createWorktree } = await import("../worktrees/worktrees.ts");
const {
  addWorktreeComment,
  listWorktreeComments,
  listWorktreeReviewSets,
  resolveWorktreeComment,
} = await import("../worktrees/worktreeComments.ts");
const { projectStore } = await import("../db/projectStore.ts");
const {
  publishAssessmentReviewSet,
  recordFindingResolutions,
  withReviewSetEvidence,
  workflowReviewSetId,
} = await import("./reviewSets.ts");
const { ASSESSMENT_CONTRACT_ID, IMPLEMENTATION_RESULT_CONTRACT_ID } =
  await import("./resultContracts.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "reviewsetsrepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(
  join(repoPath, "lock.ts"),
  ["export function lock() {", "  return 1;", "}", ""].join("\n"),
);
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

projectStore.put({
  id: "rs-proj",
  name: "Review Sets Project",
  key: "RS",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  worktreeRoot: join(tmp, "wt-root"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const worktree = await createWorktree({ projectId: "rs-proj", name: "run" });

const REVIEWER_SESSION = "reviewer-session";
const FIXER_SESSION = "fixer-session";

function run(): Parameters<typeof publishAssessmentReviewSet>[0] {
  return {
    id: 1,
    taskId: 7,
    projectId: "rs-proj",
    recipeId: "code-delivery",
    recipeVersion: 15,
    lifecycle: "active",
    maxIterations: 2,
    maxReviewPasses: 1,
    config: {},
    worktreeId: worktree.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Parameters<typeof publishAssessmentReviewSet>[0];
}

function reviewStep(): WorkflowStepRow {
  return {
    id: 11,
    runId: 1,
    kind: "agent",
    payload: { role: "reviewer", objective: "review" },
    status: "running",
    executor: { kind: "session", id: REVIEWER_SESSION },
    attempt: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("an assessment publishes one closed set of anchored findings", async () => {
  const assessment: Assessment = {
    verdict: "revise",
    headCommit: "head-1",
    findings: [
      {
        severity: "minor",
        text: "rename the helper",
        path: "lock.ts",
        line: 3,
      },
      {
        severity: "critical",
        text: "the lock leaks",
        path: "lock.ts",
        line: 1,
      },
      { severity: "major", text: "no file named here" },
    ],
  };
  const published = await publishAssessmentReviewSet(
    run(),
    reviewStep(),
    assessment,
    "the locking is not yet correct",
  );

  const [set] = listWorktreeReviewSets(worktree.id);
  assert.ok(set, "the reviewer's submission published a set");
  assert.equal(published.reviewSetId, set.id);
  assert.equal(set.verdict, "request-changes");
  assert.equal(set.summary, "the locking is not yet correct");
  assert.equal(set.blind, false, "workflow passes are sequential, never blind");
  assert.equal(set.authorSessionId, REVIEWER_SESSION);
  assert.equal(set.openCount, 2);

  // Severity order is the publication order, and the unanchored finding still
  // travels — it just has no thread to be read in.
  assert.deepEqual(
    published.findings.map((finding) => finding.severity),
    ["critical", "major", "minor"],
  );
  const unanchored = published.findings.find(
    (finding) => finding.text === "no file named here",
  );
  assert.equal(unanchored?.commentId, undefined);

  const threads = (await listWorktreeComments(worktree.id)).filter(
    (comment) => !comment.parentId,
  );
  assert.equal(threads.length, 2);
  const leak = threads.find((thread) => thread.body === "the lock leaks");
  assert.equal(leak?.severity, "critical");
  assert.equal(leak?.reviewSetId, set.id);
  assert.equal(leak?.current?.path, "lock.ts");
  assert.equal(leak?.current?.line, 1);
  assert.equal(leak?.author.kind, "agent");
  assert.equal(
    published.findings.find((finding) => finding.text === "the lock leaks")
      ?.commentId,
    leak?.id,
  );
});

test("a fix round's thread state separates resolved, disputed, and open", async () => {
  const assessment: Assessment = {
    verdict: "revise",
    headCommit: "head-2",
    findings: [
      { severity: "major", text: "fixed one", path: "lock.ts", line: 1 },
      { severity: "major", text: "disputed one", path: "lock.ts", line: 2 },
      { severity: "minor", text: "untouched one", path: "lock.ts", line: 3 },
    ],
  };
  const published = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 21 },
    assessment,
    "three findings",
  );
  const idOf = (text: string) =>
    published.findings.find((finding) => finding.text === text)!.commentId!;

  // The fixer answers two threads and resolves only the one it actually fixed;
  // the reviewer clarifying its own finding is not an answer to it.
  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "fixed at the source",
    parentId: idOf("fixed one"),
    author: { kind: "agent", sessionId: FIXER_SESSION },
  });
  resolveWorktreeComment(idOf("fixed one"), true, FIXER_SESSION);
  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "the caller already holds it, see lock.ts:1",
    parentId: idOf("disputed one"),
    author: { kind: "agent", sessionId: FIXER_SESSION },
  });
  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "to be clear, I meant the outer helper",
    parentId: idOf("untouched one"),
    author: { kind: "agent", sessionId: REVIEWER_SESSION },
  });

  const reviseStep: WorkflowStepRow = {
    ...reviewStep(),
    id: 22,
    payload: {
      role: "implementer",
      objective: "revise",
      reviewSetId: published.reviewSetId!,
    },
    executor: { kind: "session", id: FIXER_SESSION },
  };
  const result = recordFindingResolutions(reviseStep, {
    notes: "one fixed, one rejected",
  } satisfies ImplementationResult);

  assert.equal(result.reviewSetId, published.reviewSetId);
  const state = new Map(
    (result.resolutions ?? []).map((resolution) => [
      resolution.commentId,
      resolution,
    ]),
  );
  assert.equal(state.get(idOf("fixed one"))?.state, "resolved");
  assert.equal(state.get(idOf("disputed one"))?.state, "disputed");
  assert.equal(
    state.get(idOf("disputed one"))?.response,
    "the caller already holds it, see lock.ts:1",
  );
  assert.equal(
    state.get(idOf("untouched one"))?.state,
    "open",
    "the reviewer's own clarification is not a fixer answer",
  );
  assert.equal(result.notes, "one fixed, one rejected");
});

test("only the fixer's own words are recorded as the fixer's answer", async () => {
  // `response` is contractually the fixer's last reply and `disputed` means the
  // fixer answered and left the finding open. A user's comment on a thread — or
  // any other agent's — is not the fix round speaking: counting it put someone
  // else's words in the fixer's mouth in the author's re-check assignment, and
  // reported findings as answered that the fix round never touched.
  const assessment: Assessment = {
    verdict: "revise",
    headCommit: "head-3",
    findings: [
      { severity: "major", text: "user answered", path: "lock.ts", line: 1 },
      { severity: "major", text: "user resolved", path: "lock.ts", line: 2 },
      { severity: "minor", text: "fixer answered", path: "lock.ts", line: 3 },
    ],
  };
  const published = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 31 },
    assessment,
    "three findings",
  );
  const idOf = (text: string) =>
    published.findings.find((finding) => finding.text === text)!.commentId!;

  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "I think this one is fine as it stands",
    parentId: idOf("user answered"),
    author: { kind: "user" },
  });
  // The user reads the diff and settles a thread themselves, before the fix
  // round has said anything at all.
  resolveWorktreeComment(idOf("user resolved"), true, "user");
  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "rejected: the caller already holds the lock",
    parentId: idOf("fixer answered"),
    author: { kind: "agent", sessionId: FIXER_SESSION },
  });

  const reviseStep: WorkflowStepRow = {
    ...reviewStep(),
    id: 32,
    payload: {
      role: "implementer",
      objective: "revise",
      reviewSetId: published.reviewSetId!,
    },
    executor: { kind: "session", id: FIXER_SESSION },
  };
  const state = new Map(
    (
      recordFindingResolutions(reviseStep, {
        notes: "one rejected",
      } satisfies ImplementationResult).resolutions ?? []
    ).map((resolution) => [resolution.commentId, resolution]),
  );

  assert.deepEqual(
    state.get(idOf("user answered")),
    { commentId: idOf("user answered"), state: "open" },
    "the user's comment is not the fixer's answer",
  );
  assert.deepEqual(
    state.get(idOf("user resolved")),
    { commentId: idOf("user resolved"), state: "resolved" },
    "a resolved thread is resolved for every reader, with no words attributed",
  );
  assert.deepEqual(state.get(idOf("fixer answered")), {
    commentId: idOf("fixer answered"),
    state: "disputed",
    response: "rejected: the caller already holds the lock",
  });
});

test("a repeated publication finishes its own set instead of opening a second", async () => {
  const assessment: Assessment = {
    verdict: "revise",
    headCommit: "head-4",
    findings: [
      { severity: "major", text: "retry me", path: "lock.ts", line: 1 },
      { severity: "minor", text: "and me", path: "lock.ts", line: 2 },
    ],
  };
  const step = { ...reviewStep(), id: 41 };
  const first = await publishAssessmentReviewSet(
    run(),
    step,
    assessment,
    "first attempt",
  );
  assert.equal(first.reviewSetId, workflowReviewSetId(1, 41));

  // What a submission that published and then failed to complete its step
  // leaves behind: the same step submits again.
  const second = await publishAssessmentReviewSet(
    run(),
    step,
    assessment,
    "second attempt",
  );
  assert.equal(second.reviewSetId, first.reviewSetId);
  assert.deepEqual(
    second.findings.map((finding) => finding.commentId),
    first.findings.map((finding) => finding.commentId),
    "the existing threads are adopted, not duplicated",
  );
  assert.equal(
    listWorktreeReviewSets(worktree.id).filter(
      (set) => set.id === first.reviewSetId,
    ).length,
    1,
  );
  const threads = (await listWorktreeComments(worktree.id)).filter(
    (comment) => !comment.parentId && comment.reviewSetId === first.reviewSetId,
  );
  assert.equal(threads.length, 2, "no thread was opened twice");
});

test("the same finding at two anchors converges on its own two threads", async () => {
  // Two ways a retry used to diverge, in one payload. A review may make the
  // same point at two places, and adoption keyed on the text alone let the
  // first of them claim the pair's only remembered thread, so the retry opened
  // a third for the second. The contract also accepts surrounding whitespace
  // while insertion trims the body, so a raw-text key never matched the row it
  // had just written.
  const assessment: Assessment = {
    verdict: "revise",
    headCommit: "head-7",
    findings: [
      {
        severity: "major",
        text: "  this cast is unchecked\n",
        path: "lock.ts",
        line: 1,
      },
      {
        severity: "major",
        text: "this cast is unchecked ",
        path: "lock.ts",
        line: 3,
      },
    ],
  };
  const step = { ...reviewStep(), id: 71 };
  const first = await publishAssessmentReviewSet(
    run(),
    step,
    assessment,
    "twice over",
  );
  const second = await publishAssessmentReviewSet(
    run(),
    step,
    assessment,
    "twice over",
  );

  const reviewSetId = workflowReviewSetId(1, 71);
  const ids = first.findings.map((finding) => finding.commentId);
  assert.equal(new Set(ids).size, 2, "each anchor got its own thread");
  assert.deepEqual(
    first.findings.map((finding) => finding.text),
    ["this cast is unchecked", "this cast is unchecked"],
    "the payload carries the text the thread stores, not the raw submission",
  );
  assert.deepEqual(
    second.findings.map((finding) => finding.commentId),
    ids,
    "the retry adopts both threads, in the same order",
  );
  const threads = (await listWorktreeComments(worktree.id)).filter(
    (comment) => !comment.parentId && comment.reviewSetId === reviewSetId,
  );
  assert.equal(threads.length, 2, "and opens no third one");
  assert.deepEqual(threads.map((thread) => thread.anchor?.line).sort(), [1, 3]);
});

test("an interrupted publication never leaves the set open", async () => {
  const step = { ...reviewStep(), id: 51 };
  // A set the previous attempt created and left open with one thread already
  // in it — the state a crash between creation and close leaves behind.
  const partial: Assessment = {
    verdict: "revise",
    headCommit: "head-5",
    findings: [
      {
        severity: "major",
        text: "already published",
        path: "lock.ts",
        line: 1,
      },
    ],
  };
  await publishAssessmentReviewSet(run(), step, partial, "partial");
  const reviewSetId = workflowReviewSetId(1, 51);

  // The retry adds the finding the interrupted attempt never reached, and the
  // set ends closed with its verdict either way.
  const finished = await publishAssessmentReviewSet(
    run(),
    step,
    {
      ...partial,
      findings: [
        ...partial.findings,
        {
          severity: "minor",
          text: "never published",
          path: "lock.ts",
          line: 2,
        },
      ],
    },
    "finished",
  );
  const set = listWorktreeReviewSets(worktree.id).find(
    (candidate) => candidate.id === reviewSetId,
  );
  assert.equal(set?.verdict, "request-changes");
  assert.equal(finished.findings.length, 2);
  assert.ok(finished.findings.every((finding) => finding.commentId));
});

test("server-owned evidence a submission invents is stripped, not trusted", async () => {
  const step = { ...reviewStep(), id: 61 };
  const forged = await withReviewSetEvidence(
    run(),
    step,
    ASSESSMENT_CONTRACT_ID,
    {
      verdict: "revise",
      headCommit: "head-6",
      reviewSetId: "a set the reviewer named itself",
      findings: [
        // Unanchored, so nothing publishes it — and with a forged thread id the
        // fix assignment would leave it to a handoff section that never
        // mentions it, silently dropping the finding.
        { severity: "major", text: "no anchor", commentId: "forged-thread" },
      ],
    },
    "forged ids",
  );
  const assessment = forged as unknown as Assessment;
  assert.equal(assessment.reviewSetId, workflowReviewSetId(1, 61));
  assert.equal(assessment.findings[0]?.commentId, undefined);

  const claimed = await withReviewSetEvidence(
    run(),
    {
      ...step,
      id: 62,
      payload: { role: "implementer", objective: "revise" },
    },
    IMPLEMENTATION_RESULT_CONTRACT_ID,
    {
      notes: "done",
      reviewSetId: "not mine to say",
      resolutions: [{ commentId: "forged-thread", state: "resolved" }],
    },
    "forged resolutions",
  );
  assert.deepEqual(claimed, { notes: "done" });
});

test("a run with no worktree publishes nothing and keeps its assessment", async () => {
  const assessment: Assessment = {
    verdict: "pass",
    headCommit: "head-3",
    findings: [],
  };
  const before = listWorktreeReviewSets(worktree.id).length;
  const published = await publishAssessmentReviewSet(
    applyPatch(run(), { worktreeId: undefined }),
    { ...reviewStep(), id: 31 },
    assessment,
    "clean",
  );
  assert.deepEqual(published, assessment);
  assert.equal(listWorktreeReviewSets(worktree.id).length, before);
});

test("a re-check settles the threads of the set it wrote", async () => {
  // The discovery pass raises two anchored findings and closes its set.
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 81 },
    {
      verdict: "revise",
      headCommit: "head-5",
      findings: [
        { severity: "major", text: "the lock leaks", path: "lock.ts", line: 1 },
        { severity: "minor", text: "rename it", path: "lock.ts", line: 2 },
      ],
    },
    "two things",
  );
  const setId = raised.reviewSetId!;
  const leaks = raised.findings[0]!.commentId!;
  const rename = raised.findings[1]!.commentId!;

  // The fix round marks one fixed and argues the other, leaving it open.
  resolveWorktreeComment(leaks, true, FIXER_SESSION);

  // Its author re-checks: it accepts the argued one and restates the other.
  const reChecked = await publishAssessmentReviewSet(
    run(),
    {
      ...reviewStep(),
      id: 72,
      payload: {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: setId,
        // The assignment carries the server's record of which thread each
        // finding is; the fix has moved the lines, so nothing else can match.
        findings: raised.findings as unknown as never,
      },
    },
    {
      verdict: "revise",
      headCommit: "head-5",
      findings: [
        { severity: "major", text: "the lock leaks", path: "lock.ts", line: 1 },
      ],
    },
    "one still open",
  );

  assert.equal(reChecked.reviewSetId, setId, "it settles its own set");
  assert.equal(
    listWorktreeReviewSets(worktree.id).filter((set) => set.id === setId)
      .length,
    1,
    "no second set beside it",
  );
  const comments = await listWorktreeComments(worktree.id);
  const threads = comments.filter(
    (comment) => !comment.parentId && comment.reviewSetId === setId,
  );
  assert.equal(threads.length, 2, "no thread was opened twice");

  // The accepted answer is answered and closed; the restated finding is
  // answered and reopened, whatever the fix round marked it.
  const accepted = threads.find((thread) => thread.id === rename)!;
  const restated = threads.find((thread) => thread.id === leaks)!;
  assert.ok(accepted.resolvedAt, "an accepted answer does not stay open");
  assert.equal(restated.resolvedAt, undefined, "a restated finding reopens");
  const replies = comments.filter(
    (comment) => comment.parentId === leaks || comment.parentId === rename,
  );
  assert.deepEqual(
    replies.map((reply) => [reply.parentId, reply.body]),
    [
      [leaks, "Re-checked by its author: still unresolved."],
      [rename, "Re-checked by its author: the answer is accepted."],
    ],
  );
});

test("a re-check keeps two same-worded findings on their own threads", async () => {
  // The case a wording-keyed lookup collapses: one sentence, two call sites.
  writeFileSync(
    join(worktree.path, "other.ts"),
    ["export const other = 1;", "", ""].join("\n"),
  );
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 91 },
    {
      verdict: "revise",
      headCommit: "head-6",
      findings: [
        { severity: "major", text: "unchecked cast", path: "lock.ts", line: 2 },
        {
          severity: "major",
          text: "unchecked cast",
          path: "other.ts",
          line: 1,
        },
      ],
    },
    "same problem twice",
  );
  const setId = raised.reviewSetId!;
  const inA = raised.findings.find(
    (finding) => finding.path === "lock.ts",
  )!.commentId!;
  const inB = raised.findings.find(
    (finding) => finding.path === "other.ts",
  )!.commentId!;
  assert.notEqual(inA, inB, "two anchors, two threads");

  // The fix answers one and the author restates the other, at a line the fix
  // has moved: only the path and the wording can still recognize it.
  const reChecked = await publishAssessmentReviewSet(
    run(),
    {
      ...reviewStep(),
      id: 92,
      payload: {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: setId,
        findings: raised.findings as unknown as never,
      },
    },
    {
      verdict: "revise",
      headCommit: "head-6",
      findings: [
        {
          severity: "major",
          text: "unchecked cast",
          path: "other.ts",
          line: 2,
        },
      ],
    },
    "one still stands",
  );

  assert.deepEqual(
    reChecked.findings.map((finding) => finding.commentId),
    [inB],
    "the restatement claims ITS thread, not the other one",
  );
  const threads = (await listWorktreeComments(worktree.id)).filter(
    (comment) => !comment.parentId && comment.reviewSetId === setId,
  );
  assert.equal(threads.length, 2, "no third thread was opened");
  assert.ok(
    threads.find((thread) => thread.id === inA)!.resolvedAt,
    "the finding the author did not restate is accepted",
  );
  assert.equal(
    threads.find((thread) => thread.id === inB)!.resolvedAt,
    undefined,
    "the restated one stays open",
  );
});

test("a repeated re-check publication settles the threads exactly once", async () => {
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 101 },
    {
      verdict: "revise",
      headCommit: "head-7",
      findings: [
        {
          severity: "major",
          text: "guard the retry",
          path: "lock.ts",
          line: 2,
        },
      ],
    },
    "one thing",
  );
  const setId = raised.reviewSetId!;
  const thread = raised.findings[0]!.commentId!;
  const reCheckStep = {
    ...reviewStep(),
    id: 102,
    payload: {
      role: "reviewer",
      objective: "re-check",
      reviewSetId: setId,
      findings: raised.findings as unknown as never,
    },
  };
  const accepted = {
    verdict: "pass" as const,
    headCommit: "head-7",
    findings: [],
  };

  // What a submission that published and then failed to complete its step
  // leaves behind: the same step submits again.
  await publishAssessmentReviewSet(run(), reCheckStep, accepted, "settled");
  await publishAssessmentReviewSet(run(), reCheckStep, accepted, "settled");

  const replies = (await listWorktreeComments(worktree.id)).filter(
    (comment) => comment.parentId === thread,
  );
  assert.deepEqual(
    replies.map((reply) => reply.body),
    ["Re-checked by its author: the answer is accepted."],
    "the second attempt appended nothing",
  );
});

test("an exact restatement keeps its thread from a same-worded new finding", async () => {
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 111 },
    {
      verdict: "revise",
      headCommit: "head-8",
      findings: [
        { severity: "major", text: "unchecked cast", path: "lock.ts", line: 2 },
      ],
    },
    "one cast",
  );
  const setId = raised.reviewSetId!;
  const original = raised.findings[0]!.commentId!;

  // The re-check reports the SAME sentence about another file first, and
  // restates its own finding second. Deciding per finding in submission order
  // let the new one take the old one's thread by wording alone.
  const reChecked = await publishAssessmentReviewSet(
    run(),
    {
      ...reviewStep(),
      id: 112,
      payload: {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: setId,
        findings: raised.findings as unknown as never,
      },
    },
    {
      verdict: "revise",
      headCommit: "head-8",
      findings: [
        {
          severity: "major",
          text: "unchecked cast",
          path: "other.ts",
          line: 1,
        },
        { severity: "major", text: "unchecked cast", path: "lock.ts", line: 7 },
      ],
    },
    "one old, one new",
  );

  const restated = reChecked.findings.find(
    (finding) => finding.path === "lock.ts",
  )!;
  const introduced = reChecked.findings.find(
    (finding) => finding.path === "other.ts",
  )!;
  assert.equal(
    restated.commentId,
    original,
    "the exact match keeps its thread",
  );
  assert.ok(introduced.commentId, "the new finding still gets a thread");
  assert.notEqual(introduced.commentId, original, "and not that one");
});

test("a settlement interrupted after its reply still applies the disposition", async () => {
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 121 },
    {
      verdict: "revise",
      headCommit: "head-9",
      findings: [
        {
          severity: "major",
          text: "close the handle",
          path: "lock.ts",
          line: 1,
        },
      ],
    },
    "one handle",
  );
  const setId = raised.reviewSetId!;
  const thread = raised.findings[0]!.commentId!;

  // The state a crash between the two durable effects leaves: the reply is on
  // the thread, the resolve never ran.
  await addWorktreeComment({
    worktreeId: worktree.id,
    body: "Re-checked by its author: the answer is accepted.",
    parentId: thread,
    author: { kind: "agent", sessionId: REVIEWER_SESSION },
  });

  await publishAssessmentReviewSet(
    run(),
    {
      ...reviewStep(),
      id: 122,
      payload: {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: setId,
        findings: raised.findings as unknown as never,
      },
    },
    { verdict: "pass", headCommit: "head-9", findings: [] },
    "settled",
  );

  const comments = await listWorktreeComments(worktree.id);
  assert.ok(
    comments.find((comment) => comment.id === thread)!.resolvedAt,
    "the half that failed is repaired",
  );
  assert.deepEqual(
    comments
      .filter((comment) => comment.parentId === thread)
      .map((reply) => reply.body),
    ["Re-checked by its author: the answer is accepted."],
    "and the half that succeeded is not written twice",
  );
});

test("the settlement snapshot reports the threads as they durably are", async () => {
  // Settlement is best-effort per thread: the reply and the disposition are
  // attempted independently and each failure is warned and skipped. So what the
  // re-check DECIDED and what its threads HOLD can differ — and the card counts
  // thread state, so the snapshot the result carries has to be read back off
  // the surface rather than derived from the assessment.
  const raised = await publishAssessmentReviewSet(
    run(),
    { ...reviewStep(), id: 191 },
    {
      verdict: "revise",
      headCommit: "head-9",
      findings: [
        {
          severity: "major",
          text: "settles cleanly",
          path: "lock.ts",
          line: 1,
        },
        {
          severity: "major",
          text: "resolve refused",
          path: "lock.ts",
          line: 2,
        },
        { severity: "minor", text: "stays restated", path: "lock.ts", line: 3 },
      ],
    },
    "three things",
  );
  const setId = raised.reviewSetId!;
  const idOf = (text: string) =>
    raised.findings.find((finding) => finding.text === text)!.commentId!;
  refusedResolutions.add(idOf("resolve refused"));

  // The author accepts two answers and restates the third. Both acceptances
  // mean "resolve this thread"; only one of them can land.
  const reChecked = await publishAssessmentReviewSet(
    run(),
    {
      ...reviewStep(),
      id: 192,
      payload: {
        role: "reviewer",
        objective: "re-check",
        reviewSetId: setId,
        findings: raised.findings as unknown as never,
      },
    },
    {
      verdict: "revise",
      headCommit: "head-9",
      findings: [
        { severity: "minor", text: "stays restated", path: "lock.ts", line: 3 },
      ],
    },
    "one still open",
  );
  refusedResolutions.clear();

  // The snapshot matches the durable threads, including the one whose
  // resolution was refused — the card must not claim a transition that failed.
  const threads = (await listWorktreeComments(worktree.id)).filter(
    (comment) => !comment.parentId && comment.reviewSetId === setId,
  );
  const durable = new Map(
    threads.map((thread) => [
      thread.id,
      thread.resolvedAt ? "resolved" : "open",
    ]),
  );
  assert.deepEqual(Object.fromEntries(durable), {
    [idOf("settles cleanly")]: "resolved",
    [idOf("resolve refused")]: "open",
    [idOf("stays restated")]: "open",
  });
  assert.deepEqual(
    new Map(
      (reChecked.settlement ?? []).map((entry) => [
        entry.commentId,
        entry.state,
      ]),
    ),
    durable,
    "the snapshot is the thread state, not the intent behind it",
  );
});

test("an assessment cannot claim a settlement of its own", async () => {
  // Server-written like `reviewSetId`: a submitted snapshot is stripped before
  // publication rather than trusted, so no agent can hand the card counts.
  const claimed = (await withReviewSetEvidence(
    run(),
    { ...reviewStep(), id: 95 },
    ASSESSMENT_CONTRACT_ID,
    {
      verdict: "pass",
      headCommit: "head-10",
      findings: [],
      settlement: [{ commentId: "invented", state: "resolved" }],
    } as never,
    "nothing to see",
  )) as unknown as Assessment;
  assert.equal(claimed.settlement, undefined);
});
