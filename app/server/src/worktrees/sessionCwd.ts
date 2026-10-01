/**
 * Session → working-directory resolution. The `session —in_worktree→ worktree`
 * edge is the durable source of truth for where a session executes.
 *
 * Three distinct states, and the difference between the last two matters: a
 * session with NO edge legitimately runs in the app CWD, while a session whose
 * edge points at a worktree that was removed or whose folder is gone would be
 * silently retargeted at the app's own checkout — the wrong repository. Callers
 * that start a run guard on {@link sessionWorktreeEdge} being `missing`
 * (`connection.ts`); the cwd resolvers keep falling back so a session can still
 * be opened and read.
 */
import { isCodingAgentType } from "@assistant/shared";
import { existsSync } from "node:fs";
import { CWD } from "../config.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  activeWorktreePaths,
  getWorktree,
  worktreeIdForSession,
} from "../db/worktreeStore.ts";
import {
  isMainWorktreeId,
  mainCheckoutPathForProject,
  projectIdFromMainWorktreeId,
} from "./worktreeResolve.ts";

/** Where a session's `in_worktree` edge points, and whether it still exists. */
export type SessionWorktreeEdge =
  /** No edge: the session runs in the app CWD by design. */
  | { kind: "none" }
  /** The linked worktree exists on disk. */
  | { kind: "live"; worktreeId: string; path: string }
  /** The linked worktree is removed or its folder is gone. */
  | { kind: "missing"; worktreeId: string };

/**
 * Resolve a worktree id to its path, or undefined when it no longer exists.
 * A synthetic `main:<projectId>` id resolves to the project's main checkout.
 */
function worktreePathIfPresent(worktreeId: string): string | undefined {
  if (isMainWorktreeId(worktreeId)) {
    const path = mainCheckoutPathForProject(
      projectIdFromMainWorktreeId(worktreeId),
    );
    return path && existsSync(path) ? path : undefined;
  }
  const row = getWorktree(worktreeId);
  if (!row || row.status !== "active" || !existsSync(row.path))
    return undefined;
  return row.path;
}

/** The session's edge and whether the worktree it names is still there. */
export function sessionWorktreeEdge(sessionId: string): SessionWorktreeEdge {
  const worktreeId = worktreeIdForSession(sessionId);
  if (!worktreeId) return { kind: "none" };
  const path = worktreePathIfPresent(worktreeId);
  return path
    ? { kind: "live", worktreeId, path }
    : { kind: "missing", worktreeId };
}

/**
 * The worktree path a session should execute in, or undefined when the session
 * has no (usable) worktree link. A synthetic `main:<projectId>` edge resolves
 * to the project's main checkout; missing/removed worktrees resolve to
 * undefined so callers fall back to the app CWD instead of a dead folder.
 */
export function worktreeCwdForSession(sessionId: string): string | undefined {
  const edge = sessionWorktreeEdge(sessionId);
  return edge.kind === "live" ? edge.path : undefined;
}

/** The effective cwd for a session: its worktree path, else the app CWD. */
export function resolveSessionCwd(sessionId: string): string {
  return worktreeCwdForSession(sessionId) ?? CWD;
}

/**
 * True when the session's worktree is gone AND the user has not acknowledged
 * running it in the app CWD anyway. This is the wire flag
 * (`SessionListItem.worktreeMissing`) and the condition every run-starting path
 * refuses on. The acknowledgement is per worktree id, so relinking the session
 * to a different worktree that later disappears asks again.
 */
export function sessionWorktreeMissing(sessionId: string): boolean {
  // Only coding personas execute native file/shell tools. A coordinator may be
  // linked for ownership and presentation, but falling back after retirement
  // cannot retarget it into another repository.
  const agentType = sessionStore.get(sessionId)?.agentType;
  // Legacy/imported rows can lack metadata; retain their conservative historic
  // behavior until a known non-coding persona is available.
  if (agentType && !isCodingAgentType(agentType)) return false;
  const edge = sessionWorktreeEdge(sessionId);
  if (edge.kind !== "missing") return false;
  return sessionStore.worktreeMissingAck(sessionId) !== edge.worktreeId;
}

/**
 * Record the user's "run it in the app directory anyway" for the worktree the
 * session's edge points at now. Returns the acknowledged worktree id, or
 * undefined when there was nothing to acknowledge (no edge, or it still exists).
 */
export function acknowledgeMissingSessionWorktree(
  sessionId: string,
): string | undefined {
  const edge = sessionWorktreeEdge(sessionId);
  if (edge.kind !== "missing") return undefined;
  sessionStore.acknowledgeMissingWorktree(sessionId, edge.worktreeId);
  return edge.worktreeId;
}

/**
 * A memoized "is this worktree gone?" probe for list builds. The session list is
 * rebuilt several times a second, so the check is done once per DISTINCT
 * worktree id per build rather than per row, and never for ids no row asks
 * about. The spawned-worktree rows come from ONE read of the active ones, taken
 * on the first ask, since a statement per id was half of a default rebuild;
 * `existsSync` stays per id and per build, because a folder can vanish without
 * any write this process sees.
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
      missing = worktreePathIfPresent(worktreeId) === undefined;
    } else {
      activePaths ??= activeWorktreePaths();
      const path = activePaths.get(worktreeId);
      missing = path === undefined || !existsSync(path);
    }
    cache.set(worktreeId, missing);
    return missing;
  };
}
