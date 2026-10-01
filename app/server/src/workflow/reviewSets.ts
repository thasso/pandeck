/**
 * The workflow review loop's side of durable worktree review sets
 * ([Task-520](pa://task/520), `docs/comments.md`).
 *
 * A workflow review is published, not typed: the reviewer submits its
 * `assessment` through `session_submit_result`, and the SERVER turns that one
 * result into one review set on the run worktree — an anchored, severity-
 * carrying thread per finding, closed immediately with the verdict and the
 * reviewer's summary. Publishing here rather than asking the reviewer to author
 * the set through the review tools is what makes it exact: one set per
 * assessment, never a forgotten or half-closed one, and identical after a
 * restart, because the assessment it derives from is already durable.
 *
 * Blind rounds stay out of this path. Blindness only means something for
 * parallel discovery in ONE worktree, which the recipe does not do — its passes
 * are sequential — so workflow sets are ordinary visible sets, and `blind`
 * remains reserved for directly authored review rounds.
 *
 * Publication is best-effort by design: the assessment is the run's evidence
 * and the review set is where a human reads it, so a worktree that has gone
 * away must never cost the run its result.
 */
import {
  compareReviewFindings,
  type ReviewFinding,
  type ReviewFindingResolution,
  type WorkflowJsonValue,
  type WorktreeReviewVerdict,
} from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import type { WorkflowRunRow, WorkflowStepRow } from "../db/workflowStore.ts";
import { getReviewSet, listComments } from "../db/worktreeStore.ts";
import { errorText } from "../errors.ts";
import { clipText } from "../textBudget.ts";
import {
  addWorktreeComment,
  closeWorktreeReviewSet,
  createWorktreeReviewSet,
  resolveWorktreeComment,
} from "../worktrees/worktreeComments.ts";
import {
  ASSESSMENT_CONTRACT_ID,
  IMPLEMENTATION_RESULT_CONTRACT_ID,
  type Assessment,
  type ImplementationResult,
  type WorkflowResultContractId,
} from "./resultContracts.ts";

/** How much of a fixer's reply travels back into the next assignment. */
export const RESOLUTION_RESPONSE_MAX_CHARS = 400;

/** What a review verdict means on the worktree's own review surface. */
function reviewSetVerdictOf(assessment: Assessment): WorktreeReviewVerdict {
  switch (assessment.verdict) {
    case "pass":
      return "approve";
    case "revise":
      return "request-changes";
    case "fail":
      return "reject";
  }
}

/**
 * Enrich an agent result with review-set evidence before it becomes the step's
 * immutable record: an assessment publishes its set, and an implementation
 * result reads back what the fix round did with the set it was handed.
 */
export async function withReviewSetEvidence(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  contractId: WorkflowResultContractId,
  payload: WorkflowJsonValue,
  summary: string,
): Promise<WorkflowJsonValue> {
  if (contractId === ASSESSMENT_CONTRACT_ID) {
    const assessment = withoutServerFindingEvidence(
      payload as unknown as Assessment,
    );
    try {
      return (await publishAssessmentReviewSet(
        run,
        step,
        assessment,
        summary,
      )) as unknown as WorkflowJsonValue;
    } catch (err) {
      warnFailure(step, err);
      return assessment as unknown as WorkflowJsonValue;
    }
  }
  if (contractId === IMPLEMENTATION_RESULT_CONTRACT_ID) {
    const result = payload as unknown as ImplementationResult;
    const { reviewSetId: _id, resolutions: _states, ...claimed } = result;
    try {
      return recordFindingResolutions(
        step,
        claimed,
      ) as unknown as WorkflowJsonValue;
    } catch (err) {
      warnFailure(step, err);
      return claimed as unknown as WorkflowJsonValue;
    }
  }
  return payload;
}

function warnFailure(step: WorkflowStepRow, err: unknown): void {
  console.warn(
    `[workflow] review-set evidence for step ${step.id} failed:`,
    errorText(err),
  );
}

/**
 * The assessment as the reviewer is allowed to write it. `reviewSetId` and a
 * finding's `commentId` are the server's own record of where it published the
 * review, so a submitted one is never evidence of anything — and, since the fix
 * assignment leaves a finding that HAS a thread to the handoff section, an
 * invented `commentId` would quietly delete that finding from the assignment.
 * Stripping is the only place that trust boundary can be drawn: the contract
 * validator runs on submissions the server itself has not yet enriched.
 */
function withoutServerFindingEvidence(assessment: Assessment): Assessment {
  const {
    reviewSetId: _published,
    settlement: _settled,
    ...claimed
  } = assessment;
  return {
    ...claimed,
    findings: assessment.findings.map((finding) => {
      const { commentId: _thread, ...rest } = finding;
      return rest;
    }),
  };
}

/**
 * The set a review step publishes under. DERIVED from the step, never fresh:
 * the submission that carries an assessment can be attempted more than once —
 * a rejected payload leaves the step running, and a submission that publishes
 * and then fails to complete its step invites a retry — and a fresh id would
 * turn each attempt into another set on the user's diff. With this id the
 * second attempt finds its own set and finishes it instead.
 */
export function workflowReviewSetId(runId: number, stepId: number): string {
  return `wf-${runId}-${stepId}`;
}

/**
 * Which set an assessment publishes into. Normally its own step's — except a
 * RE-CHECK, which settles the findings it wrote itself and therefore belongs on
 * the threads it already opened: the user reads one conversation per finding
 * (raised, answered, re-checked) instead of the same point twice in two sets.
 * The recipe owns that id, not the agent; a set id from anywhere else is a
 * step's own by construction, and a target outside this run is ignored.
 */
function reviewSetTargetOf(run: WorkflowRunRow, step: WorkflowStepRow): string {
  const payload =
    typeof step.payload === "object" &&
    step.payload !== null &&
    !Array.isArray(step.payload)
      ? step.payload
      : {};
  const authored = payload.reviewSetId;
  if (
    payload.objective === "re-check" &&
    typeof authored === "string" &&
    authored.startsWith(`wf-${run.id}-`)
  )
    return authored;
  return workflowReviewSetId(run.id, step.id);
}

/**
 * Publish one assessment as one closed review set, and return the assessment
 * carrying the ids it was published under. Findings the reviewer anchored to a
 * file and line become threads; one that names no location still reaches the
 * fixer through the payload, but has nowhere on the diff to live.
 *
 * Every step of this is resumable, because the set id is the step's: a set left
 * open or half-populated by a crash or a failed close is ADOPTED here — its
 * existing threads are matched to their findings and only the missing ones are
 * opened — and a set already closed is simply re-read. A failure after creation
 * still closes the set before it propagates, so an interrupted publication
 * never leaves a review showing as in progress forever.
 */
export async function publishAssessmentReviewSet(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  assessment: Assessment,
  summary: string,
): Promise<Assessment> {
  const worktreeId = run.worktreeId;
  const sessionId =
    step.executor?.kind === "session" ? step.executor.id : undefined;
  if (!worktreeId || !sessionId) return assessment;

  const reviewSetId = reviewSetTargetOf(run, step);
  const session = sessionStore.get(sessionId);
  const existing = getReviewSet(reviewSetId);
  if (!existing)
    createWorktreeReviewSet({
      id: reviewSetId,
      worktreeId,
      authorSessionId: sessionId,
      ...(session?.model ? { authorModel: session.model } : {}),
      ...(session?.thinkingLevel
        ? { authorThinkingLevel: session.thinkingLevel }
        : {}),
      blind: false,
    });

  try {
    // A re-check RESTATES findings that already have threads, and the fix it
    // just read has moved the lines under them, so anchor identity cannot
    // recognize them: `lock.ts:12` is not where it was. Its assignment carries
    // the server's own record of which thread each finding is, and matching on
    // that is what keeps a restatement in its own conversation instead of
    // opening a second thread beside it.
    // Sorted like publication, so which restatement claims which of two
    // equally worded threads is the same on every attempt.
    const submitted = [...assessment.findings].sort(compareReviewFindings);
    const claimed = allocateRestatements(restatedThreadsOf(step), submitted);
    const known: ReviewFinding[] = [];
    const unknown: ReviewFinding[] = [];
    submitted.forEach((finding, index) => {
      const commentId = claimed[index];
      if (commentId) known.push({ ...canonicalFinding(finding), commentId });
      else unknown.push(finding);
    });
    const findings = [
      ...known,
      ...(await publishFindings(worktreeId, reviewSetId, sessionId, unknown)),
    ].sort(compareReviewFindings);
    if (!isReCheck(step)) return { ...assessment, reviewSetId, findings };
    await settleReCheckedThreads(
      worktreeId,
      reviewSetId,
      sessionId,
      findings,
      assignedResolutionsOf(step),
    );
    // What the threads say AFTER settlement ran, read off the surface rather
    // than assumed from what it set out to do. Settlement is best-effort per
    // thread, so a resolution that failed leaves the thread open — and the card
    // counts thread state, so it has to count this and not the intention. Read
    // with no responder: this is the disposition of each thread, and no reply
    // on it belongs to the author settling it.
    return {
      ...assessment,
      reviewSetId,
      findings,
      settlement: readFindingResolutions(reviewSetId),
    };
  } finally {
    if (getReviewSet(reviewSetId)?.verdict === null)
      closeWorktreeReviewSet({
        reviewSetId,
        verdict: reviewSetVerdictOf(assessment),
        summary: summary.trim() || assessmentFallbackSummary(assessment),
      });
  }
}

/**
 * What the fix round left on each thread, as the re-check's ASSIGNMENT records
 * it. Immutable for the life of the step, which is what lets a settlement that
 * runs twice write the same words both times.
 */
function assignedResolutionsOf(step: WorkflowStepRow): Map<string, string> {
  const states = new Map<string, string>();
  const payload = step.payload as Record<string, WorkflowJsonValue>;
  const assigned = Array.isArray(payload.findingResolutions)
    ? payload.findingResolutions
    : [];
  for (const value of assigned) {
    const resolution = value as unknown as ReviewFindingResolution;
    if (resolution?.commentId && typeof resolution.state === "string")
      states.set(resolution.commentId, resolution.state);
  }
  return states;
}

/** One thread a re-check may be restating, with the keys it answers to. */
type RestatementCandidate = {
  /** Severity, path and text: what tells two same-worded findings apart. */
  anchored: string;
  /** Severity and text alone, for a restatement that dropped its path. */
  loose: string;
  commentId: string;
};

/**
 * The threads a re-check's own findings already live on, read from the step's
 * ASSIGNMENT — recipe-owned evidence, never an agent's claim about a thread.
 * Empty for every other assessment, which owns no thread yet.
 *
 * A LIST, not a lookup keyed by wording: this module deliberately supports the
 * same finding at two anchors ("this cast is unchecked" at two call sites), and
 * a map would let the second thread overwrite the first — collapsing two
 * restatements onto one thread and leaving the other looking accepted.
 */
function restatedThreadsOf(step: WorkflowStepRow): RestatementCandidate[] {
  if (!isReCheck(step)) return [];
  const payload = step.payload as Record<string, WorkflowJsonValue>;
  const assigned = Array.isArray(payload.findings) ? payload.findings : [];
  return assigned.flatMap((value) => {
    const finding = value as unknown as ReviewFinding;
    if (!finding?.commentId || typeof finding.text !== "string") return [];
    return [
      {
        anchored: restatementKey(finding, true),
        loose: restatementKey(finding, false),
        commentId: finding.commentId,
      },
    ];
  });
}

/**
 * Which thread each submitted finding restates, allocated over the WHOLE
 * submission rather than one finding at a time, and consumed so no two findings
 * claim one thread.
 *
 * Exactness is global, not positional: every path-and-wording match is settled
 * first, and only then may a finding that dropped its path fall back to wording
 * alone. Deciding per finding let a same-worded NEW finding take, by loose
 * match, the very thread a later finding named exactly — which both stranded
 * the real restatement and denied the new finding the thread it was owed.
 *
 * A fix moves a finding's line, so the line can play no part; the path still
 * separates the same sentence said about two files. Anything left unmatched is
 * a finding this round introduced, and opens its own thread.
 */
function allocateRestatements(
  candidates: readonly RestatementCandidate[],
  findings: readonly ReviewFinding[],
): (string | undefined)[] {
  const remaining = [...candidates];
  const claimed = new Array<string | undefined>(findings.length).fill(
    undefined,
  );
  const take = (index: number, at: number): void => {
    if (at >= 0) claimed[index] = remaining.splice(at, 1)[0]!.commentId;
  };
  findings.forEach((finding, index) => {
    const anchored = restatementKey(finding, true);
    take(
      index,
      remaining.findIndex((candidate) => candidate.anchored === anchored),
    );
  });
  findings.forEach((finding, index) => {
    if (claimed[index]) return;
    const loose = restatementKey(finding, false);
    take(
      index,
      remaining.findIndex((candidate) => candidate.loose === loose),
    );
  });
  return claimed;
}

/** A finding's identity across a fix that moved it: never its line. */
function restatementKey(
  finding: { severity: string; text: string; path?: string },
  withPath: boolean,
): string {
  return JSON.stringify([
    finding.severity,
    ...(withPath ? [finding.path ?? null] : []),
    finding.text.trim(),
  ]);
}

function isReCheck(step: WorkflowStepRow): boolean {
  return (
    typeof step.payload === "object" &&
    step.payload !== null &&
    !Array.isArray(step.payload) &&
    step.payload.objective === "re-check"
  );
}

/**
 * What a re-check leaves on the threads it wrote: the third turn of the
 * conversation the user reads. A finding it did not restate is one it accepted
 * — the fix stands, or the fixer's argument does — so its thread is answered
 * and RESOLVED. A finding it restated is unsettled whatever the fix round
 * marked, so that thread is answered and reopened; nothing else may decide a
 * reviewer's own finding is done.
 *
 * The set keeps the verdict its discovery pass closed it with. That verdict is
 * a fact about what that pass concluded, and a review round that asked for
 * changes did ask for them; the thread state is where settlement lives, and it
 * is what the card's rollup counts.
 */
async function settleReCheckedThreads(
  worktreeId: string,
  reviewSetId: string,
  sessionId: string,
  restated: readonly ReviewFinding[],
  assigned: Map<string, string>,
): Promise<void> {
  const restatedIds = new Set(
    restated.flatMap((finding) =>
      finding.commentId ? [finding.commentId] : [],
    ),
  );
  const authorSessionId = getReviewSet(reviewSetId)?.authorSessionId;
  const comments = listComments(worktreeId);
  for (const thread of comments) {
    if (thread.parentId || thread.reviewSetId !== reviewSetId) continue;
    const stillOpen = restatedIds.has(thread.id);
    const resolved = thread.resolvedAt !== null;
    // What the FIX ROUND left, from the assignment rather than from the live
    // thread: settlement resolves threads itself, so reading their current
    // state would make a retry describe the state its first attempt created.
    // Who is speaking, stated rather than assumed: the author normally
    // re-checks its own set, but a session the user deleted cannot be reopened
    // and a replacement judges the findings in its place. Claiming authorship
    // for that replacement would put a settlement in the mouth of a session
    // that never saw the code.
    const by = sessionId === authorSessionId ? "its author" : "a stand-in";
    const body = stillOpen
      ? `Re-checked by ${by}: still unresolved.`
      : assigned.get(thread.id) === "resolved"
        ? `Re-checked by ${by}: the fix answers this.`
        : `Re-checked by ${by}: the answer is accepted.`;
    // Settlement is two durable effects, and each converges on ITS OWN state.
    // A submission can be attempted more than once, and the pair is not atomic:
    // treating the reply as proof that the disposition also landed would let a
    // crash between them leave a thread answered but never resolved, with every
    // retry skipping the half that failed.
    //
    // The reply converges on being the newest word: this exact line, from this
    // session, already last on the thread means the attempt before this one
    // wrote it and nothing has happened since. A later round still speaks,
    // because the fix round replies after this one — and when it silently fixed
    // instead of replying, the disposition it changes is what makes the line
    // differ.
    if (!alreadySettled(comments, thread.id, sessionId, body))
      try {
        await addWorktreeComment({
          worktreeId,
          body,
          parentId: thread.id,
          author: commentAuthor(sessionId),
        });
      } catch (err) {
        warnSettlement(reviewSetId, err);
      }
    // The disposition converges on the state the re-check decided: restated is
    // open, accepted is resolved. Attempted independently, so a failed reply
    // never costs the thread its state, and re-applied from whatever the thread
    // is in now, so an attempt that died before this point is repaired.
    if (resolved === stillOpen)
      try {
        resolveWorktreeComment(thread.id, !stillOpen, sessionId);
      } catch (err) {
        warnSettlement(reviewSetId, err);
      }
  }
}

function warnSettlement(reviewSetId: string, err: unknown): void {
  console.warn(
    `[workflow] re-check settlement for ${reviewSetId} failed:`,
    errorText(err),
  );
}

/**
 * A finding in the form publication PERSISTS: comment insertion trims the body,
 * so a submitted `"same issue "` is stored as `"same issue"`. Canonicalizing
 * once, here, is what keeps a retry's key equal to the row it should adopt —
 * comparing a raw submission against the trimmed row made any assessment with
 * surrounding whitespace un-adoptable, so every retry opened another thread. It
 * also means the text the fixer reads in its assignment is the text on the
 * thread it answers.
 */
function canonicalFinding(finding: ReviewFinding): ReviewFinding {
  return { ...finding, text: finding.text.trim() };
}

/**
 * The identity a published thread has to match to be adopted by a repeated
 * publication: the whole CANONICAL finding, against the thread's ORIGINAL
 * anchor — which never moves, unlike the re-anchored current one.
 *
 * Text alone is not identity. A review may legitimately make the same point at
 * two places ("this cast is unchecked" at two call sites), and matching on the
 * body would let the first finding claim the pair's only remembered thread,
 * leaving the second to open a third one — the retry then diverges instead of
 * converging. It would also let a finding whose anchor changed between attempts
 * adopt a thread sitting somewhere else entirely.
 *
 * The tuple is JSON-encoded rather than joined on a separator character:
 * nothing validates that a finding's text excludes any particular character, so
 * a separator would be an invariant this module merely hopes for.
 */
function publishedFindingKey(finding: {
  severity: string | null;
  path: string | null;
  line: number | null;
  text: string;
}): string {
  return JSON.stringify([
    finding.severity,
    finding.path,
    finding.line,
    finding.text,
  ]);
}

/**
 * One thread per anchored finding, in severity order. Threads this set already
 * holds are adopted rather than duplicated, which is what makes a resumed
 * publication converge on the same set instead of doubling it. Every candidate
 * is kept, so N identically worded findings adopt their own N threads; a
 * finding matching nothing opens a new thread rather than reusing a thread that
 * is not it, which can leave an earlier attempt's thread in the set if a
 * resubmission changed its wording or anchor. That is the honest outcome: both
 * were published, and re-pointing a finding at some other reviewer's line would
 * be worse than a visible extra one.
 */
async function publishFindings(
  worktreeId: string,
  reviewSetId: string,
  sessionId: string,
  submitted: readonly ReviewFinding[],
): Promise<ReviewFinding[]> {
  const adoptable = new Map<string, string[]>();
  for (const comment of listComments(worktreeId)) {
    if (comment.parentId || comment.reviewSetId !== reviewSetId) continue;
    const key = publishedFindingKey({
      severity: comment.severity ?? null,
      path: comment.anchorPath,
      line: comment.anchorLine,
      text: comment.body,
    });
    const candidates = adoptable.get(key);
    if (candidates) candidates.push(comment.id);
    else adoptable.set(key, [comment.id]);
  }
  const findings: ReviewFinding[] = [];
  // A stable sort by severity keeps equally severe findings in submission
  // order, so a repeat of the same payload adopts in the same order it wrote.
  for (const submittedFinding of [...submitted].sort(compareReviewFindings)) {
    const finding = canonicalFinding(submittedFinding);
    const adopted = adoptable
      .get(
        publishedFindingKey({
          severity: finding.severity,
          path: finding.path ?? null,
          line: finding.line ?? null,
          text: finding.text,
        }),
      )
      ?.shift();
    if (adopted) {
      findings.push({ ...finding, commentId: adopted });
      continue;
    }
    findings.push(
      await publishFinding(worktreeId, reviewSetId, sessionId, finding),
    );
  }
  return findings;
}

/** Whether this settlement line is already the newest word on the thread. */
function alreadySettled(
  comments: readonly {
    id: string;
    parentId: string | null;
    body: string;
    authorSessionId: string | null;
    createdAt: number;
  }[],
  threadId: string,
  sessionId: string,
  body: string,
): boolean {
  let newest:
    | { body: string; authorSessionId: string | null; createdAt: number }
    | undefined;
  for (const comment of comments) {
    if (comment.parentId !== threadId) continue;
    if (!newest || comment.createdAt >= newest.createdAt) newest = comment;
  }
  return newest?.body === body && newest.authorSessionId === sessionId;
}

/** How an agent-published comment names its author. */
function commentAuthor(sessionId: string): {
  kind: "agent";
  sessionId: string;
  model?: string;
  thinkingLevel?: string;
} {
  const session = sessionStore.get(sessionId);
  return {
    kind: "agent",
    sessionId,
    ...(session?.model ? { model: session.model } : {}),
    ...(session?.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
  };
}

async function publishFinding(
  worktreeId: string,
  reviewSetId: string,
  sessionId: string,
  finding: ReviewFinding,
): Promise<ReviewFinding> {
  if (!finding.path || !finding.line || finding.line < 1) return finding;
  const session = sessionStore.get(sessionId);
  try {
    const comment = await addWorktreeComment({
      worktreeId,
      body: finding.text,
      author: {
        kind: "agent",
        sessionId,
        ...(session?.model ? { model: session.model } : {}),
        ...(session?.thinkingLevel
          ? { thinkingLevel: session.thinkingLevel }
          : {}),
      },
      anchor: { path: finding.path, side: "new", line: finding.line },
      severity: finding.severity,
      reviewSetId,
    });
    return { ...finding, commentId: comment.id };
  } catch (err) {
    // A path the reviewer named loosely (or a file the fix already moved) is
    // the reviewer's inaccuracy, not the run's failure: the finding still
    // travels, it just has no thread.
    console.warn(
      `[workflow] anchoring finding at ${finding.path}:${finding.line} failed:`,
      errorText(err),
    );
    return finding;
  }
}

function assessmentFallbackSummary(assessment: Assessment): string {
  return `Workflow review of ${assessment.headCommit}: ${assessment.verdict}.`;
}

/**
 * What the fix round did with each published finding, read from the threads
 * themselves. The fixer's prose says what it believes it did; the thread state
 * is what the user and the verdict pass actually see.
 */
export function recordFindingResolutions(
  step: WorkflowStepRow,
  result: ImplementationResult,
): ImplementationResult {
  const payload = step.payload as Record<string, unknown> | undefined;
  const reviewSetId =
    typeof payload?.reviewSetId === "string" ? payload.reviewSetId : undefined;
  if (!reviewSetId) return result;
  const responder =
    step.executor?.kind === "session" ? step.executor.id : undefined;
  const resolutions = readFindingResolutions(reviewSetId, responder);
  if (resolutions.length === 0) return { ...result, reviewSetId };
  return { ...result, reviewSetId, resolutions };
}

/**
 * The current state of every thread in one published review set, as the round
 * run by `responderSessionId` left it.
 *
 * Attribution is the point of that argument. `response` is contractually the
 * FIXER's own last reply, and `disputed` means the fixer answered a finding and
 * deliberately left it open — so only that session's replies may fill either.
 * A user's comment on a thread, or another agent's, is not the fixer speaking:
 * counting it would put someone else's words in the fixer's mouth in the
 * re-check's assignment, and would report a finding as answered that the fix
 * round never touched. `resolved` is the exception and stays whoever set it,
 * because a resolved thread IS resolved for every reader — the author
 * re-checking it sees the disposition it must actually settle.
 */
function readFindingResolutions(
  reviewSetId: string,
  responderSessionId?: string,
): ReviewFindingResolution[] {
  const set = getReviewSet(reviewSetId);
  if (!set) return [];
  const comments = listComments(set.worktreeId);
  const answersByRoot = new Map<string, string>();
  for (const comment of comments) {
    if (!comment.parentId || !responderSessionId) continue;
    if (
      comment.authorKind !== "agent" ||
      comment.authorSessionId !== responderSessionId
    )
      continue;
    answersByRoot.set(comment.parentId, comment.body);
  }
  return comments
    .filter((comment) => !comment.parentId && comment.reviewSetId === set.id)
    .map((root) => {
      const response = answersByRoot.get(root.id);
      const state =
        root.resolvedAt !== null
          ? "resolved"
          : response !== undefined
            ? "disputed"
            : "open";
      return {
        commentId: root.id,
        state,
        ...(response
          ? {
              response: clipText(response, RESOLUTION_RESPONSE_MAX_CHARS).text,
            }
          : {}),
      } satisfies ReviewFindingResolution;
    });
}
