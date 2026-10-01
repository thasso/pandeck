/**
 * The Git contract for the one automatic triage a reproduced host-operation
 * failure earns ([Task-591](pa://task/591), `docs/agent-workflows.md`).
 *
 * A rebase repair is handed a conflict and asked to CHANGE history, so its
 * contract is a finished rebase (`workflow/rebaseRepair.ts`). A triage is the
 * opposite assignment: the operation it was handed is going to run again
 * immediately afterwards, against the same range and the same reservation, so
 * the only honest postcondition is that the assignment left Git exactly as it
 * found it. Diagnosis, remote inspection and provider-side repair all satisfy
 * that; a commit, a rewrite or a stray file does not, and the run's committed
 * history is therefore never quietly moved by a step nobody reviewed.
 *
 * The comparison needs a pre-assignment snapshot, and the recipe that writes
 * the assignment is pure, so the snapshot is taken HERE at dispatch and
 * recorded as a run event — durable, so a server restart mid-triage still
 * settles against the state the triage was handed.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowResultStatus } from "@assistant/shared";
import {
  appendEvent,
  listEvents,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from "../db/workflowStore.ts";
import { getWorktree } from "../db/worktreeStore.ts";
import { git, gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import {
  operationTriagePayloadOf,
  type OperationTriageSafetyEvidence,
} from "./codeDeliveryRecipe.ts";

/** What the triage was handed, and what it has to hand back. */
type OperationTriageSnapshot = {
  head: string;
  branch: string;
  /** Whether the working tree was clean, which is what licenses a hard reset. */
  clean: boolean;
  /** Digest of the exact porcelain status, so the check stays O(1) in size. */
  statusDigest: string;
};

const SNAPSHOT_EVENT_FIELD = "operationTriageSnapshot";

/** Every sequencer state a triage could leave half-finished. */
const IN_PROGRESS_MARKERS = [
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["BISECT_LOG", "a bisect"],
] as const;

async function gitDir(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--absolute-git-dir"], cwd)).stdout.trim();
}

async function inProgressOperation(cwd: string): Promise<string | undefined> {
  const dir = await gitDir(cwd);
  for (const [marker, label] of IN_PROGRESS_MARKERS)
    if (existsSync(join(dir, marker))) return label;
  return undefined;
}

async function head(cwd: string): Promise<string> {
  return (
    await git(["rev-parse", "--verify", "HEAD^{commit}"], cwd)
  ).stdout.trim();
}

async function branch(cwd: string): Promise<string> {
  const result = await gitOptional(
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    cwd,
  );
  return result.code === 0 ? result.stdout.trim() : "";
}

async function status(cwd: string): Promise<string> {
  return (
    await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd)
  ).stdout.trim();
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The worktree this triage belongs to, or a refusal. Identity is re-checked on
 * every call rather than trusted from dispatch: the row may have been removed
 * or re-pointed while the assignment ran, and a restore aimed at the wrong
 * checkout is worse than no restore at all.
 */
function triageWorktree(run: WorkflowRunRow, step: WorkflowStepRow) {
  if (!run.worktreeId || !run.branch)
    throw new Error(`workflow run ${run.id} has no triage worktree or branch`);
  const row = getWorktree(run.worktreeId);
  if (!row || row.status !== "active")
    throw new Error(
      `workflow triage worktree ${run.worktreeId} is unavailable`,
    );
  if (row.branch !== run.branch)
    throw new Error(
      `workflow triage step ${step.id} no longer matches its worktree`,
    );
  return row;
}

function isSnapshot(value: unknown): value is OperationTriageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.head === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(record.head) &&
    typeof record.branch === "string" &&
    typeof record.clean === "boolean" &&
    typeof record.statusDigest === "string" &&
    record.statusDigest.length > 0
  );
}

/** The latest snapshot recorded for this dispatch of the step. */
function recordedSnapshot(
  runId: number,
  stepId: number,
): OperationTriageSnapshot | undefined {
  const events = listEvents(runId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.stepId !== stepId) continue;
    const detail = event.detail;
    if (typeof detail !== "object" || detail === null || Array.isArray(detail))
      continue;
    const snapshot = (detail as Record<string, unknown>)[SNAPSHOT_EVENT_FIELD];
    if (isSnapshot(snapshot)) return snapshot;
  }
  return undefined;
}

/**
 * Record what the triage is being handed, before its turn begins.
 *
 * Called from the agent dispatcher for a triage assignment and for nothing
 * else. A failure here refuses the dispatch: an assignment whose postcondition
 * cannot be checked afterwards must not be handed out at all.
 */
export async function recordOperationTriageSnapshot(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
): Promise<void> {
  if (!operationTriagePayloadOf(step)) return;
  const row = triageWorktree(run, step);
  const snapshot = await withRepoLock(
    await repoLockKey(row.mainRepoRoot),
    async (): Promise<OperationTriageSnapshot> => {
      const pending = await inProgressOperation(row.path);
      if (pending)
        throw new Error(
          `a workflow triage cannot start while ${pending} is in progress`,
        );
      const current = await branch(row.path);
      if (current !== run.branch)
        throw new Error(
          `a workflow triage cannot start off the run branch "${run.branch}"`,
        );
      const text = await status(row.path);
      return {
        head: await head(row.path),
        branch: current,
        clean: text === "",
        statusDigest: digest(text),
      };
    },
  );
  appendEvent({
    runId: run.id,
    stepId: step.id,
    type: "observation-recorded",
    actor: { kind: "system", id: "workflow-operation-triage" },
    detail: { [SNAPSHOT_EVENT_FIELD]: snapshot },
  });
}

/**
 * Enforce the triage assignment's Git postcondition under the repository lock.
 *
 * A COMPLETED triage that moved anything is refused outright and nothing is
 * undone — the agent still holds its turn, so it is told what it changed and
 * can put it back or submit blocked instead. Destroying work an agent believes
 * it just finished, on its own success submission, would be the one recovery
 * nobody could review.
 *
 * Every other outcome restores: the sequencer is aborted, and the branch and
 * head are put back. A hard reset is licensed only by a snapshot that was
 * CLEAN, because that is the only state in which everything the reset discards
 * was demonstrably created by this assignment. A triage handed a dirty tree —
 * uncommitted implementer work a commit-sync failed to commit — gets its branch
 * pointer back with a soft reset and keeps every byte of that content; what the
 * host could not verify is named in the evidence instead of being papered over.
 */
export async function finalizeOperationTriage(
  run: WorkflowRunRow,
  step: WorkflowStepRow,
  resultStatus: WorkflowResultStatus,
): Promise<OperationTriageSafetyEvidence | undefined> {
  if (!operationTriagePayloadOf(step)) return undefined;
  const snapshot = recordedSnapshot(run.id, step.id);
  if (!snapshot)
    throw new Error(
      `triage step ${step.id} has no recorded pre-assignment Git snapshot`,
    );
  const row = triageWorktree(run, step);
  const runBranch = run.branch!;

  return withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
    const violations = await triageViolations(row.path, runBranch, snapshot);
    if (resultStatus === "completed") {
      if (violations.length === 0) return undefined;
      throw new Error(
        `a workflow triage must leave Git exactly as it found it, but ${violations.join("; ")}. Restore the run branch to ${snapshot.head} with a clean working tree and submit again, or submit blocked with what you found.`,
      );
    }
    if (violations.length === 0)
      return { verified: true, restored: true, originalHead: snapshot.head };

    // Each abort is attempted once and only where Git says that state exists;
    // the ones that do not apply exit non-zero and are ignored.
    if (await inProgressOperation(row.path))
      for (const command of [
        ["rebase", "--abort"],
        ["merge", "--abort"],
        ["cherry-pick", "--abort"],
        ["revert", "--abort"],
        ["bisect", "reset"],
      ])
        await gitOptional(command, row.path);
    if ((await branch(row.path)) !== runBranch) {
      // Never force a checkout: the current branch may contain unrelated work
      // the snapshot cannot authorize us to discard. If checkout cannot prove
      // the run branch is active, preserve all evidence and do not reset/clean.
      try {
        await git(["checkout", runBranch], row.path);
      } catch {
        const remaining = await triageViolations(row.path, runBranch, snapshot);
        return {
          verified: true,
          restored: false,
          originalHead: snapshot.head,
          violations: [
            ...remaining,
            `could not safely check out run branch "${runBranch}"; no reset or clean was performed`,
          ],
        };
      }
    }
    if ((await branch(row.path)) !== runBranch) {
      const remaining = await triageViolations(row.path, runBranch, snapshot);
      return {
        verified: true,
        restored: false,
        originalHead: snapshot.head,
        violations: [
          ...remaining,
          `could not verify checkout on run branch "${runBranch}"; no reset or clean was performed`,
        ],
      };
    }
    if ((await head(row.path).catch(() => "")) !== snapshot.head)
      await git(
        ["reset", snapshot.clean ? "--hard" : "--soft", snapshot.head],
        row.path,
      );
    if (snapshot.clean)
      // The triage started from a verified clean tree, so any untracked path
      // now present was created during this bounded assignment and must not
      // survive a failed/blocked triage as an unreviewed workspace change.
      await git(["clean", "-fd"], row.path);

    const remaining = await triageViolations(row.path, runBranch, snapshot, {
      // A dirty snapshot is restored to its branch and head only; the working
      // tree is deliberately left alone, so it is not a restoration failure.
      ignoreTree: !snapshot.clean,
    });
    return {
      verified: true,
      restored: remaining.length === 0,
      originalHead: snapshot.head,
      violations,
    };
  });
}

/** Everything the current checkout differs in from what the triage was handed. */
async function triageViolations(
  cwd: string,
  runBranch: string,
  snapshot: OperationTriageSnapshot,
  options: { ignoreTree?: boolean } = {},
): Promise<string[]> {
  const pending = await inProgressOperation(cwd);
  const current = await branch(cwd);
  const currentHead = await head(cwd).catch(() => "");
  const text = await status(cwd);
  return [
    pending ? `${pending} is in progress` : "",
    current !== runBranch
      ? `the checkout is on ${current || "a detached HEAD"}, not the run branch "${runBranch}"`
      : "",
    currentHead !== snapshot.head
      ? `HEAD moved from ${snapshot.head} to ${currentHead || "(unreadable)"}`
      : "",
    !options.ignoreTree && digest(text) !== snapshot.statusDigest
      ? snapshot.clean
        ? "the working tree is no longer clean"
        : "the working tree no longer matches the state the assignment was handed"
      : "",
  ].filter(Boolean);
}
