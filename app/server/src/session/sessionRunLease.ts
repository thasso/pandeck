/**
 * Mutual exclusion between "a session is about to RUN" and an exclusive
 * WORKTREE mutation (removal or agent-facing checked delivery).
 *
 * Sampling `isRunning` before a mutation cannot be enough, however late it is
 * sampled: another connection can start a prompt in the gap between the sample
 * and the removal, pass its own run-boundary checks while the worktree is still
 * there, and end up with an agent running in a directory that is deleted a
 * moment later. The two decisions have to exclude each other, not merely
 * observe each other.
 *
 * The held resource is the WORKTREE, not a list of sessions. A snapshot of "the
 * sessions on this worktree" is stale the moment it is taken — a fork or a
 * review handoff can link a NEW session to the same checkout while the removal
 * is still fetching — and that new session would not be in anyone's list. Every
 * prompt therefore resolves its session's CURRENT worktree at admission and is
 * refused if that worktree is held, so a link made after the hold is covered by
 * it too.
 *
 * Removal refuses every admitted prompt. Checked delivery may instead reserve
 * around its calling prompt when that is the only run in the target; callers
 * working elsewhere still require an idle target. Both reservations prevent a
 * new run from starting until they release.
 *
 * The check lives in `runtimePrompt.ts` — the ONE app-level prompt facade every
 * path is contractually required to use (`app/server/src/CLAUDE.md`, enforced by
 * `architecture.test.ts`) — so no caller has to remember it. Both operations are
 * SYNCHRONOUS: with a single-threaded runtime, a check-then-set with no `await`
 * between them cannot interleave, which is the whole reason this works where
 * sampling did not.
 *
 * It is in-memory on purpose: it protects an operation that lasts seconds, and a
 * process that dies takes both sides of the race with it.
 */
import { isCodingAgentType } from "@assistant/shared";
import { sessionStore } from "../db/sessionStore.ts";
import { worktreeIdForSession } from "../db/worktreeStore.ts";

function runnableWorktreeIdForSession(sessionId: string): string | undefined {
  const agentType = sessionStore.get(sessionId)?.agentType;
  return !agentType || isCodingAgentType(agentType)
    ? worktreeIdForSession(sessionId)
    : undefined;
}

/** worktreeId → why an exclusive mutation holds it, phrased for the user. */
const worktreeHolds = new Map<string, string>();
/** worktreeId → session id → admitted prompts not yet finished. */
const promptsInFlight = new Map<string, Map<string, number>>();

type WorktreeResolver = (sessionId: string) => string | undefined;
let resolveWorktree: WorktreeResolver = runnableWorktreeIdForSession;

/** Test seam: resolve a session's worktree without the graph store. */
export function setSessionWorktreeResolverForTests(
  resolver: WorktreeResolver | null,
): void {
  resolveWorktree = resolver ?? runnableWorktreeIdForSession;
}

/** Throws when an exclusive mutation holds the worktree this session runs in. */
export function assertSessionRunnable(sessionId: string): void {
  const worktreeId = resolveWorktree(sessionId);
  const reason = worktreeId ? worktreeHolds.get(worktreeId) : undefined;
  if (reason) throw new Error(reason);
}

/**
 * Admit a prompt, refusing outright if its worktree is mutation-held, and keep
 * that worktree busy until the returned release runs (idempotent, and it MUST
 * run in a `finally`).
 *
 * The worktree is resolved ONCE, here: a session re-linked mid-run keeps the
 * checkout it was admitted against, which is also the cwd its run is using.
 */
export function beginPromptRun(sessionId: string): () => void {
  assertSessionRunnable(sessionId);
  const worktreeId = resolveWorktree(sessionId);
  if (!worktreeId) return () => {};
  const runs = promptsInFlight.get(worktreeId) ?? new Map<string, number>();
  runs.set(sessionId, (runs.get(sessionId) ?? 0) + 1);
  promptsInFlight.set(worktreeId, runs);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = promptsInFlight.get(worktreeId);
    if (!current) return;
    const next = (current.get(sessionId) ?? 1) - 1;
    if (next > 0) current.set(sessionId, next);
    else current.delete(sessionId);
    if (current.size === 0) promptsInFlight.delete(worktreeId);
  };
}

/**
 * Hold a worktree for removal. `undefined` means REFUSED — a run is in flight
 * on it, or another removal already holds it — and the caller must not proceed.
 * While held, no session on that worktree can start a run, including one linked
 * to it after the hold was taken. The returned release MUST run in a `finally`.
 */
export function reserveWorktreeForRemoval(
  worktreeId: string,
  reason: string,
): (() => void) | undefined {
  if (worktreeHolds.has(worktreeId)) return undefined;
  if ((promptsInFlight.get(worktreeId)?.size ?? 0) > 0) return undefined;
  return holdWorktree(worktreeId, reason);
}

/**
 * Hold a worktree for an agent-initiated mutation. The caller's OWN admitted
 * prompt may already be running in the target worktree — that is the normal
 * linked-session tool call — but any other admitted prompt refuses the hold.
 * A caller working elsewhere may reserve only an idle target. Once held, the
 * ordinary prompt admission check prevents every new run until release.
 */
export function reserveWorktreeForMutation(
  worktreeId: string,
  callerSessionId: string,
  reason: string,
): (() => void) | undefined {
  if (worktreeHolds.has(worktreeId)) return undefined;
  const running = promptsInFlight.get(worktreeId);
  if (running && (running.size !== 1 || running.get(callerSessionId) !== 1))
    return undefined;
  return holdWorktree(worktreeId, reason);
}

function holdWorktree(worktreeId: string, reason: string): () => void {
  worktreeHolds.set(worktreeId, reason);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    worktreeHolds.delete(worktreeId);
  };
}

/** Test seam: drop every hold, so one test's leak cannot fail the next. */
export function resetSessionRunLeasesForTests(): void {
  worktreeHolds.clear();
  promptsInFlight.clear();
  resolveWorktree = runnableWorktreeIdForSession;
}
