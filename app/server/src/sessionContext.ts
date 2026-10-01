/**
 * The ONE place that decides what context a session starts with
 * ([Task-554](pa://task/554)).
 *
 * A session can be started from a Task, from a Knowledge Base entry, or on a
 * plain Project, by any of five triggers: an ordinary send carrying staged
 * context, the pi and claude first sends behind the new-session landing, a
 * workflow role, and an agent-proposed peer session. Every one of those used to
 * carry its own copy of the same block, and the copies had drifted — one had no
 * worktree fallback for the Project, one inlined Knowledge context into the
 * prompt TEXT while the others attached it. This module states the rule once;
 * triggers only trigger.
 *
 * The operation is deliberately SPLIT around session creation:
 *
 *   1. {@link resolveSessionContext} — a pure read, before anything exists. It
 *      settles precedence and yields the {@link sessionContextEvidence} the
 *      session's prompt conditions freeze.
 *   2. {@link applySessionContext} — after creation. It writes the links and
 *      returns the attachments the first turn carries.
 *
 * That split is the safety property, not ceremony. The prompt-condition
 * evidence is a CLAIM that the matching context attachment ships (a known
 * Project drops the eager registry pointer on exactly that promise —
 * `promptConditions.ts`), and a path that froze the claim without sending the
 * attachment left its session with neither. Deriving both from one resolution
 * makes that disagreement unrepresentable.
 *
 * Context always travels as an ATTACHMENT, never as text spliced into the
 * prompt: attachments reach the model through `promptAttachments.ts` on BOTH
 * harnesses while the durable log keeps the human's own words, which is the
 * `session/CLAUDE.md` rule that model-only enrichment rides the prompt options.
 */
import type {
  PromptAttachment,
  TaskItem,
  TaskSessionRef,
} from "@assistant/shared";
import { linkSessionToObject } from "./db/sessionObjectStore.ts";
import { projectStore } from "./db/projectStore.ts";
import { buildKnowledgeContextAttachment } from "./knowledgeBaseContext.ts";
import type { SessionPromptEvidence } from "./promptConditions.ts";
import { buildProjectContextAttachment } from "./sessionProjectContext.ts";
import { buildTaskContextAttachment } from "./taskContext.ts";
import { linkTaskStart } from "./taskSessionStart.ts";
import { findOriginTask, readTask } from "./tasks.ts";

/** What a trigger asks for. Every field is what the USER or agent picked. */
export interface SessionContextRequest {
  taskId?: string;
  projectId?: string;
  knowledgeEntryId?: string;
  /**
   * The Project a named-nothing session falls back to — its worktree's.
   *
   * An argument rather than a lookup so the difference between the paths stays
   * a DECISION: a first send adopts the checkout's Project, while a later send
   * into a running session attaches only what the user staged.
   */
  worktreeProjectId?: string;
}

/**
 * The one precedence rule, resolved. A Task wins over a Knowledge entry, which
 * wins over a Project: the more specific context implies the rest.
 */
export type ResolvedSessionContext =
  | { kind: "task"; taskId: string; projectId?: string }
  | { kind: "knowledge"; entryId: string }
  | { kind: "project"; projectId: string }
  | { kind: "none" };

/** How the trigger will deliver this context. */
export interface ApplySessionContextOptions {
  /**
   * The first turn happens LATER and elsewhere, so this session's Project is
   * PINNED at start rather than resolved live from its Task.
   *
   * Only an agent-spawned session needs it: its opening prompt is delivered by
   * the peer engine, which rebuilds the context from these links, and a Task
   * that moves Project in between would otherwise hand that rebuild a Project
   * the frozen evidence never claimed.
   */
  pinProject?: boolean;
}

/** What the session's first turn carries. */
export interface SessionStartContext {
  attachments: PromptAttachment[];
  /** The Task this start linked, when the caller wants to report it. */
  taskId?: string;
  /** The Project this start bound the session to. */
  projectId?: string;
}

const EMPTY: SessionStartContext = { attachments: [] };

export function resolveSessionContext(
  request: SessionContextRequest,
): ResolvedSessionContext {
  const taskId = request.taskId?.trim();
  if (taskId) {
    // A Task with a Project of its own overrides anything named alongside it.
    // A Task WITHOUT one does not erase the Project the session is being
    // started in: the caller picked or inherited that, and dropping it would
    // leave a session running in a checkout whose Project it cannot see.
    // `||`, matching the project branch: a blank string is "not named", so it
    // falls through to the worktree rather than short-circuiting past it.
    const projectId =
      readTask(taskId)?.projectId ||
      request.projectId?.trim() ||
      request.worktreeProjectId?.trim();
    return { kind: "task", taskId, ...(projectId ? { projectId } : {}) };
  }
  const entryId = request.knowledgeEntryId?.trim();
  if (entryId) return { kind: "knowledge", entryId };
  const projectId =
    request.projectId?.trim() || request.worktreeProjectId?.trim();
  return projectId ? { kind: "project", projectId } : { kind: "none" };
}

/**
 * The evidence this context freezes into the session's prompt conditions.
 *
 * A Knowledge entry deliberately yields NO Project: the session did not start
 * on one, so it keeps the eager registry pointer.
 */
export function sessionContextEvidence(
  resolved: ResolvedSessionContext,
  opts: { hasAttachments?: boolean } = {},
): SessionPromptEvidence {
  const projectId =
    resolved.kind === "task" || resolved.kind === "project"
      ? resolved.projectId
      : undefined;
  return {
    hasAttachments: Boolean(opts.hasAttachments),
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * Record the links and build the first turn's context. Runs AFTER the session
 * exists, because every write here names its id.
 *
 * The RESOLUTION is authoritative, not the world as it stands now: session
 * creation happens in between, and the evidence frozen from that resolution can
 * no longer move. A Task that changed Project or disappeared in that window is
 * therefore reconciled toward the claim rather than allowed to contradict it.
 *
 * Linking is best-effort in the same sense `linkTaskStart` is: a session must
 * still get its assignment when a metadata write fails.
 */
export async function applySessionContext(
  resolved: ResolvedSessionContext,
  ref: TaskSessionRef,
  opts: ApplySessionContextOptions = {},
): Promise<SessionStartContext> {
  switch (resolved.kind) {
    case "task": {
      // Also nudges `todo → doing`: attaching the Task IS the start of work.
      const task = linkTaskStart(resolved.taskId, ref);
      // Session creation happens between the resolution and here, so the Task
      // can move Projects or be deleted in that window. The frozen evidence
      // CANNOT move with it, so the resolved Project is authoritative for what
      // is attached: a Task that moved is attached under the Project this
      // session was born claiming, and a Task that vanished leaves that
      // Project's own context in its place. Either way the claim holds.
      if (!task) return applyProjectContext(resolved.projectId, ref);
      // A deferred first turn rebuilds from the links, so the claim has to
      // OUTLIVE this call: pin the Project instead of leaving the rebuild to
      // resolve it live from a Task that may move meanwhile. Immediate triggers
      // do not pin — a Task start otherwise follows its Task's Project.
      if (opts.pinProject && resolved.projectId)
        projectStore.setSessionProject(ref.sessionId, resolved.projectId);
      return {
        attachments: [
          buildTaskContextAttachment(pinTaskProject(task, resolved.projectId)),
        ],
        taskId: task.id,
        ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
      };
    }
    case "knowledge": {
      linkSessionToObject(
        ref.sessionId,
        "knowledge",
        resolved.entryId,
        "initial-context",
      );
      const attachment = await buildKnowledgeContextAttachment(
        resolved.entryId,
      );
      return { attachments: attachment ? [attachment] : [] };
    }
    case "project":
      return applyProjectContext(resolved.projectId, ref);
    case "none":
      return EMPTY;
  }
}

/** Bind a session to a Project and build that Project's context attachment. */
function applyProjectContext(
  projectId: string | undefined,
  ref: TaskSessionRef,
): SessionStartContext {
  if (!projectId) return EMPTY;
  projectStore.setSessionProject(ref.sessionId, projectId);
  const attachment = buildProjectContextAttachment(projectId);
  return { attachments: attachment ? [attachment] : [], projectId };
}

/**
 * The Task as the RESOLUTION saw its Project, so the attachment's embedded
 * Project context cannot contradict the evidence frozen from that resolution.
 * Everything else — the status the link just nudged included — stays live.
 */
function pinTaskProject(
  task: TaskItem,
  projectId: string | undefined,
): TaskItem {
  if (task.projectId === projectId) return task;
  const { projectId: _moved, ...rest } = task;
  return projectId ? { ...rest, projectId } : rest;
}

/**
 * The same first-turn context, rebuilt from a session's persisted links.
 *
 * For a trigger whose first turn happens LATER and elsewhere: an agent-spawned
 * session is created by one path and first prompted by peer delivery, which has
 * no attachment channel of its own. Rebuilding beats carrying the payload —
 * the links are already durable, so this survives a restart between creation
 * and delivery and needs no new state.
 *
 * Knowledge context is deliberately absent: no trigger starts a session on a KB
 * entry and defers its first turn, and inventing that path here would be an
 * untested branch. Add it with the trigger that needs it.
 */
export function sessionFirstTurnContext(
  sessionId: string,
): SessionStartContext {
  // The Project pinned at start (`pinProject`) is the claim the frozen evidence
  // was built from, so it wins over whatever the Task says now. A session that
  // was never pinned has none, and then its Task's own Project stands in — the
  // behaviour every immediate trigger already has.
  const pinned = projectStore.sessionProjectOf(sessionId)?.trim();
  const origin = findOriginTask(sessionId);
  const task = origin ? readTask(origin.id) : null;
  if (task) {
    const projectId = pinned ?? task.projectId;
    return {
      attachments: [
        buildTaskContextAttachment(pinTaskProject(task, projectId)),
      ],
      taskId: task.id,
      ...(projectId ? { projectId } : {}),
    };
  }
  if (!pinned) return EMPTY;
  const attachment = buildProjectContextAttachment(pinned);
  return {
    attachments: attachment ? [attachment] : [],
    projectId: pinned,
  };
}
