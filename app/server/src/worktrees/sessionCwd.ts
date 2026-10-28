/**
 * Session → working-directory resolution. The `session —in_worktree→ worktree`
 * edge is the durable source of truth for where a session executes.
 *
 * Three distinct states, and the difference between the last two matters: a
 * session with NO edge legitimately runs in the app CWD, while a session whose
 * edge points at a worktree that was removed or whose folder is gone would be
 * silently retargeted at the app's own checkout — the wrong repository.
 *
 * Nothing here reads the server's filesystem. The synchronous readers (list
 * flag, banner, pre-checks) answer from the presence cache
 * (`checkoutPresence.ts`): the last answer the checkout's side gave, where
 * never-verified is not missing. A path that starts a run or an engine
 * decides from its own Worker check, {@link checkWorktreeCheckout}, and passes
 * that {@link CheckedCheckout} to the read it guards.
 */
import { isCodingAgentType } from "@assistant/shared";
import { CWD } from "../config.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  activeWorktreePaths,
  getWorktree,
  worktreeIdForSession,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { checkPresence, presenceKey, presenceNow } from "./checkoutPresence.ts";
import { checkoutSideOf } from "./knowledgeCheckout.ts";
import {
  checkMainCheckout,
  isMainWorktreeId,
  mainCheckoutEdgeNow,
  mainCheckoutReadsKey,
  projectIdFromMainWorktreeId,
  resolveWorktreeRow,
} from "./worktreeResolve.ts";

/** Where a session's `in_worktree` edge points, and whether it still exists. */
export type SessionWorktreeEdge =
  /** No edge: the session runs in the app CWD by design. */
  | { kind: "none" }
  /** The linked worktree exists on disk. */
  | { kind: "live"; worktreeId: string; path: string }
  /** The linked worktree is removed or its folder is gone. */
  | { kind: "missing"; worktreeId: string }
  /** Its side has not answered yet: never missing, never the app CWD. */
  | { kind: "unverified"; worktreeId: string };

/** One Worker check of a worktree id; a plain value holding nothing. */
export interface CheckedCheckout {
  worktreeId: string | undefined;
  verdict:
    "none" | "live" | "missing-db" | "missing-absent" | "missing-no-repository";
  /** Set exactly when `verdict` is `live`. */
  path?: string;
}

/** The session's edge moved while a construction checked it (RD-W3d-3). */
export class CheckoutEdgeChangedError extends Error {
  constructor() {
    super("the session's worktree changed while opening; try again");
  }
}

/**
 * A cwd was read from the cache before the checkout's side answered: the
 * caller needed its own check (RD-W3d-1).
 */
export class UnverifiedCheckoutError extends Error {
  constructor(worktreeId: string) {
    super(`The checkout of worktree ${worktreeId} is not verified yet.`);
  }
}

/** An edge as the cache answers it; `retired` marks a DB verdict. */
type EdgeVerdict =
  | { kind: "live"; path: string }
  | { kind: "missing"; retired: boolean }
  | { kind: "unverified" };

function edgeVerdict(worktreeId: string): EdgeVerdict {
  if (isMainWorktreeId(worktreeId))
    return mainCheckoutEdgeNow(projectIdFromMainWorktreeId(worktreeId));
  const row = getWorktree(worktreeId);
  if (!row || row.status !== "active")
    return { kind: "missing", retired: true };
  const answer = presenceNow(checkoutSideOf(row), row.path);
  if (answer === "present") return { kind: "live", path: row.path };
  return answer === "absent"
    ? { kind: "missing", retired: false }
    : { kind: "unverified" };
}

/**
 * Whether the synchronous answer for `worktreeId` reads one of the changed
 * presence `keys` (`checkoutPresence.ts`): its row's path, or for a main id
 * its candidate (`main:<projectId>`) and the paths the project read.
 */
export function worktreeReadsPresenceKey(
  worktreeId: string,
  keys: ReadonlySet<string>,
): boolean {
  if (isMainWorktreeId(worktreeId))
    return mainCheckoutReadsKey(projectIdFromMainWorktreeId(worktreeId), keys);
  const row = getWorktree(worktreeId);
  return !!row && keys.has(presenceKey(checkoutSideOf(row), row.path));
}

/** The session's edge and whether the worktree it names is still there. */
export function sessionWorktreeEdge(sessionId: string): SessionWorktreeEdge {
  const worktreeId = worktreeIdForSession(sessionId);
  if (!worktreeId) return { kind: "none" };
  const verdict = edgeVerdict(worktreeId);
  if (verdict.kind === "live")
    return { kind: "live", worktreeId, path: verdict.path };
  return { kind: verdict.kind, worktreeId };
}

let checkSettledForTests: ((checked: CheckedCheckout) => void) | undefined;

/**
 * One Worker check of `worktreeId`, requested by this call: no edge is
 * `none` with no probe; DB verdicts (removed or inactive row, unknown
 * project) need none either; a spawned row's own presence check, or the main
 * checkout's (`checkMainCheckout`). Rejects on a Worker failure.
 *
 * It does not compare edges: a caller that acts on the session's edge
 * compares `checked.worktreeId` in its own continuation, right before the
 * read it guards.
 */
export async function checkWorktreeCheckout(
  worktreeId: string | undefined,
): Promise<CheckedCheckout> {
  const checked = await checkOnce(worktreeId);
  checkSettledForTests?.(checked);
  return checked;
}

/**
 * The check split at its first yield: the store reads (the row, the project)
 * run now and throw synchronously; the promise is the Worker half alone.
 */
function checkOnce(worktreeId: string | undefined): Promise<CheckedCheckout> {
  if (!worktreeId) return Promise.resolve({ worktreeId, verdict: "none" });
  if (isMainWorktreeId(worktreeId))
    return checkMainCheckout(projectIdFromMainWorktreeId(worktreeId)).then(
      (main): CheckedCheckout =>
        main.verdict === "live"
          ? { worktreeId, verdict: "live", path: main.path }
          : { worktreeId, verdict: main.verdict },
    );
  const row = getWorktree(worktreeId);
  if (!row || row.status !== "active")
    return Promise.resolve({ worktreeId, verdict: "missing-db" });
  return checkPresence(checkoutSideOf(row), row.path).then(
    (present): CheckedCheckout =>
      present
        ? { worktreeId, verdict: "live", path: row.path }
        : { worktreeId, verdict: "missing-absent" },
  );
}

/**
 * The worktree a construction for `sessionId` checks: an explicit target (a
 * creation links the session to it), else the session's current edge.
 */
export function checkoutEdgeTarget(
  sessionId: string,
  explicitTarget?: string,
): string | undefined {
  return explicitTarget ?? worktreeIdForSession(sessionId);
}

/** A check's cwd: the path when live, else undefined. */
export function checkoutCwd(checked: CheckedCheckout): string | undefined {
  return checked.verdict === "live" ? checked.path : undefined;
}

/**
 * Checks the worktree a construction for `sessionId` reads and hands that
 * check to `consume`, called synchronously right after the comparison in the
 * same continuation: `consume` is the construction's yield-free section and
 * must not await. A target that moved while it was checked is checked again;
 * the third consecutive move refuses with {@link CheckoutEdgeChangedError}
 * (RD-W3d-3). With `explicitTarget` (a creation that links the session to it)
 * nothing is compared, so one check settles it. Rejects on a Worker failure.
 */
export async function withCheckedCheckout<T>(
  sessionId: string,
  explicitTarget: string | undefined,
  consume: (checked: CheckedCheckout) => T,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const checked = await checkWorktreeCheckout(
      checkoutEdgeTarget(sessionId, explicitTarget),
    );
    // Resumed in THIS continuation: compare, then consume with no yield.
    if (checked.worktreeId === checkoutEdgeTarget(sessionId, explicitTarget))
      return consume(checked);
    if (attempt === 3) throw new CheckoutEdgeChangedError();
  }
}

/**
 * The worktree `id` names when a session can run in it now: its row resolved
 * and active, and its checkout live by this call's own Worker check. Undefined
 * for a DB verdict, a verified absence or base's cached "no repository";
 * rejects on a Worker failure. A main id answers the main checkout's path.
 */
export async function resolveUsableWorktree(
  id: string,
): Promise<{ row: WorktreeRow; path: string } | undefined> {
  const row = await resolveWorktreeRow(id);
  if (!row || row.status !== "active") return undefined;
  const path = checkoutCwd(await checkWorktreeCheckout(row.id));
  return path === undefined ? undefined : { row, path };
}

/**
 * The worktree path a session should execute in, or undefined when the session
 * has no (usable) worktree link. A synthetic `main:<projectId>` edge resolves
 * to the project's main checkout; missing/removed worktrees resolve to
 * undefined so callers fall back to the session's own cwd instead of a dead
 * folder.
 *
 * With `checked`, the answer is that check's, which must be of the session's
 * current edge: {@link CheckoutEdgeChangedError} otherwise, a backstop for a
 * caller that yielded between its comparison and this read. Without it, the
 * cache answers, and an unverified checkout throws
 * {@link UnverifiedCheckoutError} rather than guess.
 */
export function worktreeCwdForSession(
  sessionId: string,
  checked?: CheckedCheckout,
): string | undefined {
  if (checked) {
    if (checked.worktreeId !== worktreeIdForSession(sessionId))
      throw new CheckoutEdgeChangedError();
    return checkoutCwd(checked);
  }
  const edge = sessionWorktreeEdge(sessionId);
  if (edge.kind === "unverified")
    throw new UnverifiedCheckoutError(edge.worktreeId);
  return edge.kind === "live" ? edge.path : undefined;
}

/** The effective cwd for a session: its worktree path, else the app CWD. */
export function resolveSessionCwd(sessionId: string): string {
  return worktreeCwdForSession(sessionId) ?? CWD;
}

/**
 * Whether `sessionId` is exempt from the worktree checks: only coding personas
 * execute native file/shell tools. A coordinator may be linked for ownership
 * and presentation, but falling back after retirement cannot retarget it into
 * another repository.
 */
function exemptPersona(sessionId: string): boolean {
  const agentType = sessionStore.get(sessionId)?.agentType;
  // Legacy/imported rows can lack metadata; retain their conservative historic
  // behavior until a known non-coding persona is available.
  return !!agentType && !isCodingAgentType(agentType);
}

/**
 * True when the session's worktree is gone AND the user has not acknowledged
 * running it in the app CWD anyway. This is the wire flag
 * (`SessionListItem.worktreeMissing`). The acknowledgement is per worktree id,
 * so relinking the session to a different worktree that later disappears asks
 * again. From the cache: a DB verdict, a verified absence, or no main
 * candidate is missing; unverified is not.
 */
export function sessionWorktreeMissing(sessionId: string): boolean {
  if (exemptPersona(sessionId)) return false;
  const edge = sessionWorktreeEdge(sessionId);
  if (edge.kind !== "missing") return false;
  return sessionStore.worktreeMissingAck(sessionId) !== edge.worktreeId;
}

/**
 * {@link sessionWorktreeMissing} for DB verdicts only: a removed or inactive
 * row, a main edge whose project no longer exists, or base's cached "no
 * repository" within its TTL. Never filesystem-derived.
 */
export function sessionWorktreeRetired(sessionId: string): boolean {
  if (exemptPersona(sessionId)) return false;
  const worktreeId = worktreeIdForSession(sessionId);
  if (!worktreeId) return false;
  const verdict = edgeVerdict(worktreeId);
  if (verdict.kind !== "missing" || !verdict.retired) return false;
  return sessionStore.worktreeMissingAck(sessionId) !== worktreeId;
}

/**
 * Whether a run of `sessionId` refuses on `checked`, its own check: the same
 * predicate as {@link sessionWorktreeMissing}, applied to that check.
 */
export function sessionCheckoutRefusal(
  sessionId: string,
  checked: CheckedCheckout,
): boolean {
  if (exemptPersona(sessionId)) return false;
  if (!checked.verdict.startsWith("missing-")) return false;
  return sessionStore.worktreeMissingAck(sessionId) !== checked.worktreeId;
}

/**
 * The store half of a run's own check, read now: the persona, the edge and
 * what it names. A store error throws HERE, synchronously, before any Worker
 * contact; the promise is the Worker check alone and rejects only on a Worker
 * failure. Undefined for a non-coding persona, which needs no check.
 */
export function startSessionCheckoutCheck(
  sessionId: string,
): Promise<CheckedCheckout> | undefined {
  if (exemptPersona(sessionId)) return undefined;
  return checkOnce(worktreeIdForSession(sessionId));
}

/**
 * Whether a run of `sessionId` refuses, decided from a Worker check this call
 * requests: {@link sessionCheckoutRefusal} on it. A non-coding persona is
 * decided before any Worker contact; no edge and a DB verdict need none.
 *
 * Fails OPEN on a store error, as base's run checks did: a store read that
 * throws (only the synchronous halves before and after the Worker check) is
 * handed to `storeFailed` and does not refuse. A Worker failure is never a
 * store error: it rejects.
 */
export async function checkSessionCheckoutRefused(
  sessionId: string,
  storeFailed: (error: unknown) => void,
): Promise<boolean> {
  let check: Promise<CheckedCheckout> | undefined;
  try {
    check = startSessionCheckoutCheck(sessionId);
  } catch (error) {
    storeFailed(error);
    return false;
  }
  if (!check) return false;
  const checked = await check;
  try {
    return sessionCheckoutRefusal(sessionId, checked);
  } catch (error) {
    storeFailed(error);
    return false;
  }
}

/**
 * Record the user's "run it in the app directory anyway" for the worktree the
 * session's edge points at, decided by this call's own Worker check. Returns
 * the acknowledged worktree id, or undefined when there was nothing to
 * acknowledge (no edge, it still exists, or the edge moved while it was
 * checked). Rejects on a Worker failure.
 */
export async function acknowledgeMissingSessionWorktree(
  sessionId: string,
): Promise<string | undefined> {
  const checked = await checkWorktreeCheckout(worktreeIdForSession(sessionId));
  const { worktreeId } = checked;
  if (!worktreeId || !checked.verdict.startsWith("missing-")) return undefined;
  // Resumed in this continuation: only the edge that was checked is recorded.
  if (worktreeId !== worktreeIdForSession(sessionId)) return undefined;
  sessionStore.acknowledgeMissingWorktree(sessionId, worktreeId);
  return worktreeId;
}

/**
 * A memoized "is this worktree gone?" probe for list builds. The session list is
 * rebuilt several times a second, so the check is done once per DISTINCT
 * worktree id per build rather than per row, and never for ids no row asks
 * about. The spawned-worktree rows come from ONE read of the active ones, taken
 * on the first ask, since a statement per id was half of a default rebuild.
 * Presence comes from the cache, read per id and per build: each read queues
 * one background probe, so a folder that vanished without any write this
 * process sees shows on the build after its probe answers.
 */
export function worktreeMissingProbe(): (
  worktreeId: string | undefined,
) => boolean {
  const cache = new Map<string, boolean>();
  let activePaths: Map<string, string> | undefined;
  return (worktreeId) => {
    if (!worktreeId) return false;
    const cached = cache.get(worktreeId);
    if (cached !== undefined) return cached;
    let missing: boolean;
    if (isMainWorktreeId(worktreeId)) {
      missing = edgeVerdict(worktreeId).kind === "missing";
    } else {
      activePaths ??= activeWorktreePaths();
      const path = activePaths.get(worktreeId);
      missing =
        path === undefined ||
        presenceNow(checkoutSideOf({ id: worktreeId }), path) === "absent";
    }
    cache.set(worktreeId, missing);
    return missing;
  };
}

// --- Test seams -----------------------------------------------------------

/**
 * Test seam: `hook` runs synchronously inside {@link checkWorktreeCheckout}
 * right before it returns, with the check it returns. Undefined disarms.
 */
export function onCheckoutCheckSettledForTests(
  hook: ((checked: CheckedCheckout) => void) | undefined,
): void {
  checkSettledForTests = hook;
}
