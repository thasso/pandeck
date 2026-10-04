/**
 * Merge a worktree branch back into its base branch. Strategies:
 *   squash — `git merge --squash` in the main checkout, commit message drafted
 *            by the commit agent (static fallback);
 *   merge  — `git merge --no-ff`;
 *   rebase — `git rebase <base>` inside the worktree, then `--ff-only` merge.
 *
 * All mutating git runs under {@link withRepoLock}. Conflicts spawn the
 * configured merger agent as a REAL workshop session (it needs file/shell
 * tools) in the directory holding the conflict — the main checkout for
 * merge/squash, the worktree for rebase. Completion is detected on the
 * session's run-state turning idle: the git state is verified (no unmerged
 * paths, no MERGE_HEAD/rebase in progress); until then the merge stays in
 * `conflicts`/`agent_resolving` and the session is a normal visible session
 * the user can take over.
 *
 * The state machine is persisted in the row's `merge_state_json` so a dev
 * reload can restore an in-flight conflict (`reconcileWorktreeMergesOnBoot`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  boundMergeMessage,
  CLAUDE_SDK_PROVIDER,
  type WorktreeMergePhase,
  type WorktreeMergeStrategy,
} from "@assistant/shared";
import { git, gitOptional, repoLockKey, withRepoLock } from "../gitExec.ts";
import { getSettings } from "../settings.ts";
import {
  formatCommitMessage,
  generateCommitMessageJson,
} from "../commitAgent.ts";
import { claudeSdkModelAlias } from "../claudeSdk/modelSettings.ts";
import {
  getWorktree,
  listWorktrees,
  updateWorktree,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { isMainWorktreeId } from "./worktreeResolve.ts";
import {
  branchContainedInBase,
  invalidateWorktreeStatus,
  computeWorktreeStatus,
} from "./worktreeStatus.ts";
import { worktreeBroadcaster } from "./worktreeEvents.ts";
import { purgeMainCommentsForBranchSubject } from "./worktreeComments.ts";
import { accountForSlot } from "../settingsModelSlots.ts";

const MAX_MESSAGE_DIFF_CHARS = 60_000;
const VERIFY_DEBOUNCE_MS = 1_500;

export interface MergeState {
  strategy: WorktreeMergeStrategy;
  phase: WorktreeMergePhase;
  startedAt: number;
  agentSessionId?: string;
  conflictPaths?: string[];
  message?: string;
  /**
   * Main-checkout HEAD when the conflict was handed to the agent. Completion
   * of a merge/squash resolution = a commit landed (HEAD moved past this).
   * Tree containment cannot judge it: a conflict resolution that combines both
   * sides is a valid squash result whose re-merge would still conflict.
   */
  mainHeadAtConflict?: string;
}

const verifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Requests waiting for or holding the repository lock, keyed by worktree. */
const mergeRequests = new Set<string>();

function readMergeState(row: WorktreeRow): MergeState | undefined {
  if (!row.mergeStateJson) return undefined;
  try {
    return JSON.parse(row.mergeStateJson) as MergeState;
  } catch {
    return undefined;
  }
}

function setMergeState(worktreeId: string, state: MergeState | null): void {
  updateWorktree(worktreeId, {
    mergeStateJson: state ? JSON.stringify(state) : null,
  });
  const update = state ?? {
    phase: "idle" as const,
    strategy: "squash" as const,
    startedAt: 0,
  };
  const messageValue = boundMergeMessage(update.message);
  worktreeBroadcaster().broadcastWorktree(worktreeId, {
    type: "worktreeMergeUpdate",
    worktreeId,
    phase: update.phase,
    // Bounded on the way out: a git failure can be enormous, and this text
    // lands in a card's detail line and its memo key.
    ...(boundMergeMessage(update.message)
      ? { ...(messageValue !== undefined ? { message: messageValue } : {}) }
      : {}),
    ...(update.conflictPaths?.length
      ? { conflictPaths: update.conflictPaths }
      : {}),
    ...(update.agentSessionId ? { agentSessionId: update.agentSessionId } : {}),
  });
}

export function mergePhase(worktreeId: string): WorktreeMergePhase {
  const row = getWorktree(worktreeId);
  return (row && readMergeState(row)?.phase) || "idle";
}

async function isClean(path: string): Promise<boolean> {
  const status = await gitOptional(
    ["status", "--porcelain=v1", "--untracked-files=all"],
    path,
  );
  return status.code === 0 && !status.stdout.trim();
}

async function unmergedPaths(path: string): Promise<string[]> {
  const status = await gitOptional(["status", "--porcelain=v1"], path);
  if (status.code !== 0) return [];
  return status.stdout
    .split("\n")
    .filter((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function mergeInProgress(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".git", "MERGE_HEAD"));
}

async function rebaseInProgress(worktreePath: string): Promise<boolean> {
  const gitDir = await gitOptional(
    ["rev-parse", "--absolute-git-dir"],
    worktreePath,
  );
  if (gitDir.code !== 0) return false;
  const dir = gitDir.stdout.trim();
  return (
    existsSync(join(dir, "rebase-merge")) ||
    existsSync(join(dir, "rebase-apply"))
  );
}

/* --------------------------------- the merge -------------------------------- */

export async function mergeWorktree(
  worktreeId: string,
  strategyInput?: WorktreeMergeStrategy,
): Promise<void> {
  if (isMainWorktreeId(worktreeId))
    throw new Error("The main checkout has no branch to merge back.");
  if (mergeRequests.has(worktreeId))
    throw new Error("A merge is already in progress for this worktree.");
  mergeRequests.add(worktreeId);
  try {
    await mergeWorktreeClaimed(worktreeId, strategyInput);
  } finally {
    mergeRequests.delete(worktreeId);
  }
}

/** Run one request after its pre-lock claim excludes duplicate clicks. */
async function mergeWorktreeClaimed(
  worktreeId: string,
  strategyInput?: WorktreeMergeStrategy,
): Promise<void> {
  const initial = getWorktree(worktreeId);
  if (!initial || initial.status !== "active" || !existsSync(initial.path))
    throw new Error("Unknown worktree.");
  const strategy =
    strategyInput ?? getSettings().worktrees.defaultMergeStrategy;
  let row = initial;
  let state: MergeState = {
    strategy,
    phase: "merging",
    startedAt: Date.now(),
  };
  let started = false;

  try {
    const conflict = await withRepoLock(
      await repoLockKey(initial.mainRepoRoot),
      async () => {
        // The base can be changed while this merge waits for the repository
        // lock. Re-read the durable row here so validation and mutation use one
        // serialized target rather than the caller's stale pre-lock snapshot.
        const currentRow = getWorktree(worktreeId);
        if (
          !currentRow ||
          currentRow.status !== "active" ||
          currentRow.path !== initial.path ||
          currentRow.branch !== initial.branch ||
          currentRow.mainRepoRoot !== initial.mainRepoRoot ||
          !existsSync(currentRow.path)
        )
          throw new Error("Unknown worktree.");
        row = currentRow;

        const current = readMergeState(row)?.phase;
        if (
          current === "merging" ||
          current === "conflicts" ||
          current === "agent_resolving"
        )
          throw new Error("A merge is already in progress for this worktree.");
        if (!(await isClean(row.path)))
          throw new Error(
            "The worktree has uncommitted changes. Commit them first.",
          );
        if (!(await isClean(row.mainRepoRoot)))
          throw new Error(
            "The main checkout has uncommitted changes. Commit or stash them first.",
          );

        // Merge/squash commit onto whatever the main checkout has checked out,
        // so it MUST be the freshly recorded base branch.
        const mainBranchRes = await gitOptional(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          row.mainRepoRoot,
        );
        const mainBranch =
          mainBranchRes.code === 0 ? mainBranchRes.stdout.trim() : "";
        if (mainBranch !== row.baseBranch)
          throw new Error(
            `The main checkout is on "${mainBranch || "a detached HEAD"}", not "${row.baseBranch}". Check out ${row.baseBranch} there first.`,
          );

        state = {
          strategy,
          phase: "merging",
          startedAt: Date.now(),
        };
        setMergeState(worktreeId, state);
        started = true;
        return runStrategy(row, strategy);
      },
    );
    if (conflict) {
      await spawnMergeAgent(row, {
        ...state,
        phase: "conflicts",
        conflictPaths: conflict.paths,
        message: conflict.message,
      });
      return;
    }
    await finishMerge(row, state);
  } catch (err) {
    if (!started) throw err;
    const message = err instanceof Error ? err.message : String(err);
    setMergeState(worktreeId, { ...state, phase: "failed", message });
  }
}

interface ConflictInfo {
  paths: string[];
  /** Where the conflict must be resolved. */
  message: string;
}

/** Run the strategy; returns conflict info instead of throwing on conflicts. */
async function runStrategy(
  row: WorktreeRow,
  strategy: WorktreeMergeStrategy,
): Promise<ConflictInfo | undefined> {
  if (strategy === "rebase") {
    const rebase = await gitOptional(["rebase", row.baseBranch], row.path);
    if (rebase.code !== 0) {
      const paths = await unmergedPaths(row.path);
      if (paths.length || (await rebaseInProgress(row.path))) {
        return {
          paths,
          message: `Rebase of ${row.branch} onto ${row.baseBranch} hit conflicts.`,
        };
      }
      throw new Error(rebase.stderr.trim() || "Rebase failed.");
    }
    await git(["merge", "--ff-only", row.branch], row.mainRepoRoot);
    return undefined;
  }

  if (strategy === "merge") {
    const merge = await gitOptional(
      ["merge", "--no-ff", row.branch, "-m", `Merge worktree ${row.branch}`],
      row.mainRepoRoot,
    );
    if (merge.code !== 0) {
      const paths = await unmergedPaths(row.mainRepoRoot);
      if (paths.length || mergeInProgress(row.mainRepoRoot)) {
        return {
          paths,
          message: `Merging ${row.branch} into ${row.baseBranch} hit conflicts.`,
        };
      }
      throw new Error(merge.stderr.trim() || "Merge failed.");
    }
    return undefined;
  }

  // squash
  const squash = await gitOptional(
    ["merge", "--squash", row.branch],
    row.mainRepoRoot,
  );
  if (squash.code !== 0) {
    const paths = await unmergedPaths(row.mainRepoRoot);
    if (paths.length) {
      return {
        paths,
        message: `Squash-merging ${row.branch} into ${row.baseBranch} hit conflicts.`,
      };
    }
    throw new Error(squash.stderr.trim() || "Squash merge failed.");
  }
  await git(["commit", "-m", await squashCommitMessage(row)], row.mainRepoRoot);
  return undefined;
}

/** Commit message for the squashed result: commit agent with a static fallback. */
async function squashCommitMessage(row: WorktreeRow): Promise<string> {
  const fallback = `Merge worktree ${row.branch} (squash)`;
  try {
    const diff = await gitOptional(
      ["diff", "--cached", "--stat"],
      row.mainRepoRoot,
    );
    const log = await gitOptional(
      ["log", "--format=- %s", `${row.baseBranch}..${row.branch}`],
      row.mainRepoRoot,
    );
    const prompt = [
      `Squash-merging branch "${row.branch}" into "${row.baseBranch}".`,
      "",
      "Commits being squashed:",
      log.stdout.slice(0, 4_000),
      "",
      "Staged diffstat:",
      diff.stdout.slice(0, MAX_MESSAGE_DIFF_CHARS),
    ].join("\n");
    const result = await generateCommitMessageJson(
      prompt,
      getSettings().commitAgent,
    );
    if (result.status === "commit" && result.subject)
      return formatCommitMessage(result);
    return fallback;
  } catch {
    return fallback;
  }
}

function setMergeDone(row: WorktreeRow, state: MergeState): void {
  setMergeState(row.id, { ...state, phase: "done" });
  purgeMainCommentsForBranchSubject(row, "merged");
}

async function finishMerge(row: WorktreeRow, state: MergeState): Promise<void> {
  setMergeDone(row, state);
  invalidateWorktreeStatus(row.id);
  const status = await computeWorktreeStatus(row, { force: true }).catch(
    () => undefined,
  );
  if (status)
    worktreeBroadcaster().broadcastWorktree(status.worktreeId, {
      type: "worktreeStatus",
      status,
    });
}

/* ------------------------------- merger agent ------------------------------- */

async function spawnMergeAgent(
  row: WorktreeRow,
  initialState: MergeState,
): Promise<void> {
  const mainHeadRes = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    row.mainRepoRoot,
  );
  const state: MergeState = {
    ...initialState,
    ...(mainHeadRes.code === 0
      ? { mainHeadAtConflict: mainHeadRes.stdout.trim() }
      : {}),
  };
  setMergeState(row.id, state);
  const conflictCwd = state.strategy === "rebase" ? row.path : row.mainRepoRoot;
  const prompt = await mergeAgentPrompt(row, state, conflictCwd);
  const settings = getSettings().worktrees.mergeAgent;

  try {
    const { hub } = await import("../hub.ts");
    const { createSession } = await import("../harnesses/create.ts");
    const { promptRuntimeSession } =
      await import("../session/runtimePrompt.ts");
    const credentialProfileId = accountForSlot(settings);
    // Linked ONLY when the agent runs in the worktree (rebase). The
    // in_worktree edge is the durable cwd source of truth, so linking a
    // main-checkout merge/squash agent would reopen it in the wrong directory.
    // Main-checkout agents keep their cwd through the session's own
    // persistence (Claude record cwd / pi session header cwd); traceability
    // lives in merge_state_json.agentSessionId.
    const start = {
      agentType: "workshop",
      thinkingLevel: settings.thinkingLevel,
      credentialProfileId,
      ...(conflictCwd === row.path
        ? { worktree: { id: row.id, path: row.path } }
        : { cwd: conflictCwd }),
    } as const;
    let driver: import("../harness.ts").LiveSession;
    if (settings.provider === CLAUDE_SDK_PROVIDER) {
      if (!getSettings().claudeSdk.enabled)
        throw new Error(
          "Claude SDK is disabled; configure a pi model for the merge agent.",
        );
      driver = await createSession({
        harness: "claude-sdk",
        modelId: claudeSdkModelAlias(settings.modelId),
        ...start,
      });
    } else {
      const { findModelForProfile } = await import("../piSdk/models.ts");
      const model = await findModelForProfile(
        credentialProfileId,
        settings.provider,
        settings.modelId,
      );
      if (!model)
        throw new Error(
          `Merge-agent model ${settings.provider}/${settings.modelId} is not available.`,
        );
      driver = await createSession({ harness: "pi", model, ...start });
    }
    const sessionId = driver.sessionId;
    watchMergeAgent(row.id, sessionId);
    setMergeState(row.id, {
      ...state,
      phase: "agent_resolving",
      agentSessionId: sessionId,
    });
    void promptRuntimeSession(driver, prompt, {
      origin: { kind: "system", source: "worktree-merge" },
    }).catch((err) => {
      setMergeState(row.id, {
        ...state,
        phase: "conflicts",
        agentSessionId: sessionId,
        message: `Merge agent prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
    void hub.broadcastSessions();
  } catch (err) {
    // No agent — stay in conflicts; the user resolves manually (or retries).
    setMergeState(row.id, {
      ...state,
      phase: "conflicts",
      message:
        `${state.message ?? ""} ${err instanceof Error ? err.message : String(err)}`.trim(),
    });
  }
}

async function mergeAgentPrompt(
  row: WorktreeRow,
  state: MergeState,
  conflictCwd: string,
): Promise<string> {
  const status = await gitOptional(["status"], conflictCwd);
  const finishCommand =
    state.strategy === "rebase"
      ? "git rebase --continue"
      : "git commit --no-edit";
  return [
    "## Resolve merge conflicts",
    "",
    `A ${state.strategy} of branch \`${row.branch}\` into \`${row.baseBranch}\` hit conflicts in \`${conflictCwd}\`.`,
    "",
    "Conflicted files:",
    ...(state.conflictPaths ?? []).map((path) => `- ${path}`),
    "",
    "Instructions:",
    "1. Open each conflicted file and resolve the conflict markers, preserving the intent of BOTH sides minimally.",
    `2. \`git add\` each resolved file, then finish with \`${finishCommand}\`.`,
    state.strategy === "rebase"
      ? `3. Do NOT merge into ${row.baseBranch} yourself — the app fast-forwards after the rebase finishes.`
      : "3. Do not push.",
    "4. If a conflict cannot be resolved safely, stop and explain which file and why.",
    "",
    "Current git status:",
    "```",
    status.stdout.slice(0, 6_000),
    "```",
  ].join("\n");
}

/* ------------------------- completion verification ------------------------- */

const watchedAgents = new Map<string, string>(); // sessionId → worktreeId
let runtimeSubscribed = false;

function watchMergeAgent(worktreeId: string, sessionId: string): void {
  watchedAgents.set(sessionId, worktreeId);
  if (runtimeSubscribed) return;
  runtimeSubscribed = true;
  void import("../session/runtimeInstance.ts").then(({ sessionRuntime }) => {
    sessionRuntime.subscribeEvents((eventSessionId, event) => {
      if (event.type !== "runStateChanged") return;
      const targetWorktreeId = watchedAgents.get(eventSessionId);
      if (!targetWorktreeId || sessionRuntime.isRunning(eventSessionId)) return;
      const existing = verifyTimers.get(targetWorktreeId);
      if (existing) clearTimeout(existing);
      verifyTimers.set(
        targetWorktreeId,
        setTimeout(() => {
          verifyTimers.delete(targetWorktreeId);
          void verifyMergeResolution(targetWorktreeId, eventSessionId).catch(
            () => undefined,
          );
        }, VERIFY_DEBOUNCE_MS),
      );
    });
  });
}

/**
 * After the merger agent's turn ends: did the merge/rebase actually finish?
 * "No conflict markers" is NOT enough — the agent may have aborted the merge
 * (`git merge --abort` leaves a clean tree with nothing merged), so the result
 * is only `done` when the branch's work is verifiably contained in the base.
 */
async function verifyMergeResolution(
  worktreeId: string,
  sessionId: string,
): Promise<void> {
  const row = getWorktree(worktreeId);
  if (!row) return;
  const state = readMergeState(row);
  if (!state || state.phase !== "agent_resolving") return;

  // The user (or an errant agent) may have switched the main checkout while
  // the conflict sat with the agent; completing the merge would then land on
  // the wrong branch. Refuse deterministically instead.
  if (!(await mainCheckoutOnBase(row))) {
    watchedAgents.delete(sessionId);
    setMergeState(worktreeId, {
      ...state,
      phase: "failed",
      message: `The main checkout is no longer on "${row.baseBranch}". Check it out again and retry the merge.`,
    });
    return;
  }

  if (state.strategy === "rebase") {
    if (
      (await rebaseInProgress(row.path)) ||
      (await unmergedPaths(row.path)).length > 0
    )
      return;
    // The rebase is no longer running; fast-forward the base branch under the
    // repo lock, re-verifying the checked-out branch inside the lock. An
    // aborted rebase leaves a non-fast-forwardable branch → failed.
    try {
      await withRepoLock(await repoLockKey(row.mainRepoRoot), async () => {
        if (!(await mainCheckoutOnBase(row)))
          throw new Error(
            `the main checkout is no longer on "${row.baseBranch}"`,
          );
        await git(["merge", "--ff-only", row.branch], row.mainRepoRoot);
      });
    } catch (err) {
      watchedAgents.delete(sessionId);
      setMergeState(worktreeId, {
        ...state,
        phase: "failed",
        message: `Fast-forward after rebase failed (the agent may have aborted the rebase): ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  } else {
    if (
      mergeInProgress(row.mainRepoRoot) ||
      (await unmergedPaths(row.mainRepoRoot)).length > 0
    )
      return;
    if (!(await mergeConflictResolved(row, state))) {
      watchedAgents.delete(sessionId);
      setMergeState(worktreeId, {
        ...state,
        phase: "failed",
        message:
          "The merge is no longer in progress but no resolution commit landed — the agent may have aborted it. Retry the merge.",
      });
      return;
    }
  }

  watchedAgents.delete(sessionId);
  await finishMerge(row, state);
}

/** Whether the main checkout still has the recorded base branch checked out. */
async function mainCheckoutOnBase(row: WorktreeRow): Promise<boolean> {
  const res = await gitOptional(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    row.mainRepoRoot,
  );
  return res.code === 0 && res.stdout.trim() === row.baseBranch;
}

/**
 * Whether a merge/squash conflict was actually RESOLVED with a resolution
 * commit — not merely left clean by an abort:
 *   merge  — a true merge commit makes the branch an ancestor of the base, so
 *            tree/ancestry containment is exact.
 *   squash — the resolution is a plain commit whose content may combine both
 *            sides (re-merging would still conflict), so containment cannot
 *            judge it. Instead: HEAD must have moved past the conflict
 *            snapshot AND the commits since must touch at least one of the
 *            recorded conflict paths — an abort followed by an unrelated
 *            commit does not qualify.
 * Falls back to containment for states predating the head snapshot.
 */
async function mergeConflictResolved(
  row: WorktreeRow,
  state: MergeState,
): Promise<boolean> {
  if (state.strategy === "merge" || !state.mainHeadAtConflict) {
    return branchContainedInBase(row.mainRepoRoot, row.branch, row.baseBranch);
  }
  const headRes = await gitOptional(
    ["rev-parse", "--verify", "HEAD"],
    row.mainRepoRoot,
  );
  if (headRes.code !== 0 || headRes.stdout.trim() === state.mainHeadAtConflict)
    return false;
  const conflictPaths = state.conflictPaths ?? [];
  if (conflictPaths.length === 0) return true; // no recorded paths to check against
  const touched = await gitOptional(
    ["diff", "--name-only", state.mainHeadAtConflict, "HEAD"],
    row.mainRepoRoot,
  );
  if (touched.code !== 0) return false;
  const touchedPaths = new Set(
    touched.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return conflictPaths.some((path) => touchedPaths.has(path));
}

/** Restore in-flight conflict state after a server restart. */
export async function reconcileWorktreeMergesOnBoot(): Promise<void> {
  for (const row of listWorktrees()) {
    const state = readMergeState(row);
    if (!state) continue;
    if (
      state.phase === "done" ||
      state.phase === "failed" ||
      state.phase === "idle"
    )
      continue;
    const stillConflicted =
      state.strategy === "rebase"
        ? (await rebaseInProgress(row.path)) ||
          (await unmergedPaths(row.path)).length > 0
        : mergeInProgress(row.mainRepoRoot) ||
          (await unmergedPaths(row.mainRepoRoot)).length > 0;
    if (stillConflicted) {
      setMergeState(row.id, {
        ...state,
        phase: "conflicts",
        message: "Restored after restart — conflicts still present.",
      });
      if (state.agentSessionId) watchMergeAgent(row.id, state.agentSessionId);
      continue;
    }
    // No conflict markers ≠ merged: the server may have crashed before the
    // merge ran, or the merge was aborted. Verify a resolution actually landed
    // (HEAD moved past the conflict snapshot; containment as legacy fallback).
    if (
      state.strategy !== "rebase" &&
      (await mergeConflictResolved(row, state))
    ) {
      setMergeDone(row, state);
    } else if (
      state.strategy === "rebase" &&
      (await branchContainedInBase(
        row.mainRepoRoot,
        row.branch,
        row.baseBranch,
      ))
    ) {
      setMergeDone(row, state);
    } else {
      setMergeState(row.id, {
        ...state,
        phase: "failed",
        message:
          "Interrupted by a restart before the merge completed. Retry the merge.",
      });
    }
  }
}
