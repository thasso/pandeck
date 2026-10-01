/**
 * Which object a session screen's dock row offers as its context jump — the slot
 * beside back (`components/SessionDockActions.tsx`).
 *
 * Pure, and separate from `App.tsx`, because it is a PRIORITY RULE rather than
 * rendering: one order, stated once, so the slot always means "leave for the thing
 * this conversation is about" instead of whichever field happened to be checked first.
 */

export type SessionDockContextTarget =
  | { kind: "worktree"; id: string }
  | { kind: "task"; id: string }
  | { kind: "knowledge"; id: string }
  | { kind: "project"; id: string };

export interface SessionDockContextInput {
  /** The worktree the session executes in, once it has one. */
  worktreeId?: string;
  /** The Task the session was started from. */
  originTaskId?: string;
  /** Whether the session has an accepted user turn: after that, staged context is stale. */
  hasUserPrompt: boolean;
  /**
   * A draft session's staged context, which before the first prompt IS what the session
   * is about. It is ignored once a prompt exists: these stagings outlive the send they
   * were made for, so an old worktree staging would otherwise outrank the real one.
   */
  staged?: {
    worktreeId?: string | null;
    taskId?: string | null;
    knowledgeEntryId?: string | null;
    projectId?: string | null;
  };
}

/**
 * Worktree first: it is the screen a session is left for most, and the only tier with a
 * state (uncommitted changes) worth a dot. Then the object the session hangs off, from
 * most to least specific — a Task, an entry under review, and finally its project.
 * `undefined` means the session hangs off nothing, and the row falls back to the
 * composer's paperclip. (Before the first send the slot is the staged-context picker
 * instead, so this answers for a session that has one — or is mid-first-send.)
 */
export function resolveSessionDockContext(
  input: SessionDockContextInput,
): SessionDockContextTarget | undefined {
  const staged = input.hasUserPrompt ? undefined : input.staged;
  const worktreeId = input.worktreeId ?? staged?.worktreeId ?? undefined;
  if (worktreeId) return { kind: "worktree", id: worktreeId };
  const taskId = input.originTaskId ?? staged?.taskId ?? undefined;
  if (taskId) return { kind: "task", id: taskId };
  if (staged?.knowledgeEntryId)
    return { kind: "knowledge", id: staged.knowledgeEntryId };
  const projectId = staged?.projectId ?? undefined;
  if (projectId) return { kind: "project", id: projectId };
  return undefined;
}
