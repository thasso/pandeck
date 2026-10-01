import { listTasks } from "../../tasks.ts";
import { taskStore } from "../../db/taskStore.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { getDaySessionId } from "../../calendarDaySessions.ts";
import { KnowledgeBaseStore } from "../../knowledgeBaseStore.ts";
import { inWindow } from "../dayWindow.ts";
import {
  DAY_SCAN_ACTOR_NAME,
  DAY_SYNTHESIS_ACTOR_NAME,
  type CollectorOutput,
  type DayCollectContext,
  type DaySourceCollector,
  type DaySourceFact,
} from "../types.ts";

const KB_HISTORY_LIMIT = 200;

/**
 * External-link marker on scanner-created Tasks (applied by the synthesis
 * apply step). The PA collector excludes those Tasks' CREATION facts —
 * user progress on them stays genuine activity via status-change provenance.
 */
export const DAY_SCAN_TASK_MARKER = "pa-day-scan://created";

/** Injectable seam for tests. */
export interface PaCollectorDeps {
  kbStore?: KnowledgeBaseStore;
}

export function createPaCollector(
  deps: PaCollectorDeps = {},
): DaySourceCollector {
  return {
    key: "pa",
    label: "Pandeck",
    readiness() {
      return { ready: true };
    },
    async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
      const observedAt = new Date().toISOString();
      const facts: DaySourceFact[] = [];

      // --- Tasks: touched-vs-changed semantics. Historical collection must
      // retain identity after completed work ages out of the live Backlog, so
      // creation/suggestion facts scan archived Tasks too. Current-work signals
      // below still explicitly exclude archived rows.
      const tasks = listTasks({ includeArchived: true });
      const scannerCreated = new Set(
        tasks
          .filter((t) =>
            (t.externalLinks ?? []).some((l) =>
              l.url?.startsWith(DAY_SCAN_TASK_MARKER),
            ),
          )
          .map((t) => t.id),
      );
      for (const task of tasks) {
        const createdInWindow = inWindow(ctx.window, task.createdAt);
        // Self-exclusion: the scanner's own created Tasks are not "my work".
        if (createdInWindow && !scannerCreated.has(task.id)) {
          facts.push(taskFact(task, "task-created", observedAt));
        }
        if (!task.archivedAt && task.dueDate && task.status !== "done") {
          const dueState =
            task.dueDate < ctx.date
              ? "overdue"
              : task.dueDate === ctx.date
                ? "due-today"
                : null;
          if (dueState)
            facts.push({
              ...taskFact(task, "task-due", observedAt),
              tags: ["task", dueState],
            });
        }
        // An agent reporting a Task finished does not complete it (it is a
        // suggestion the user answers), so the write leaves NO `done` status
        // event — and without this the day would lose the agent's work
        // entirely: the answer may come days later, and would then be attributed
        // to that day instead. It is deliberately NOT tagged `completed`:
        // nothing is complete yet.
        //
        // The same write DOES move the Task out of `doing`, so one closeout can
        // yield both a `doing → todo` status-change fact and this one. That is
        // intended: they are two true and different statements about it — the
        // Task stopped being worked on, and a claim is waiting for an answer.
        const suggestion = task.statusSuggestion;
        if (suggestion?.to === "done" && inWindow(ctx.window, suggestion.at)) {
          facts.push({
            ...taskFact(task, "task-done-proposed", observedAt),
            occurredAt: new Date(suggestion.at).toISOString(),
            tags: ["task", "agent-change", "awaiting-confirmation"],
          });
        }
      }

      // Status changes carry durable actor provenance; the scanner's own
      // projection updates (system:day-scan*) are excluded entirely.
      const events = taskStore.statusEventsInWindow(
        ctx.window.startMs,
        ctx.window.endMs,
      );
      for (const event of events) {
        if (
          event.actorKind === "system" &&
          (event.actorId ?? "").startsWith(DAY_SCAN_ACTOR_NAME)
        )
          continue;
        const actorTag =
          event.actorKind === "user"
            ? "user-change"
            : event.actorKind === "agent"
              ? "agent-change"
              : "system-change";
        facts.push({
          id: `pa:task-status:${event.id}`,
          kind: "task-status-change",
          occurredAt: new Date(event.atMs).toISOString(),
          observedAt,
          links: [`pa://task/${event.taskId}`],
          data: {
            taskId: String(event.taskId),
            from: event.fromStatus,
            to: event.toStatus,
            actorKind: event.actorKind,
          },
          tags: [
            "task",
            actorTag,
            ...(event.toStatus === "done" ? ["completed"] : []),
          ],
        });
      }

      // --- KB commits: the git log gives REAL per-day changes. Self-exclusion
      // by KB-Actor name covers collection and synthesis commits.
      const store = deps.kbStore ?? new KnowledgeBaseStore();
      try {
        const history = await store.history({ limit: KB_HISTORY_LIMIT });
        for (const entry of history) {
          if (!inWindow(ctx.window, entry.date)) continue;
          const actorTrailer = entry.trailers["KB-Actor"] ?? "";
          if (
            actorTrailer.includes(DAY_SCAN_ACTOR_NAME) ||
            actorTrailer.includes(DAY_SYNTHESIS_ACTOR_NAME)
          )
            continue;
          const entryIds = (entry.trailers["KB-Entry"] ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          facts.push({
            id: `pa:kb:${entry.commit}`,
            kind: "kb-commit",
            occurredAt: entry.date,
            observedAt,
            title: entry.subject,
            links: entryIds.map((id) => `pa://knowledge/${id}`),
            data: { entryIds },
            tags: ["kb"],
          });
        }
      } catch {
        /* a missing/empty KB repo is not a collection failure */
      }

      // --- Sessions: ids/links only (privacy: richer metadata is processed
      // transiently elsewhere, never committed). The day session is excluded.
      const daySessionId = getDaySessionId(ctx.date);
      for (const session of sessionStore.list()) {
        if (!inWindow(ctx.window, session.updatedAt)) continue;
        if (session.id === daySessionId) continue;
        facts.push({
          id: `pa:session:${session.id}`,
          kind: "session-active",
          occurredAt: new Date(session.updatedAt).toISOString(),
          observedAt,
          links: [`pa://session/${session.id}`],
          tags: ["session"],
        });
      }

      return {
        result: "complete",
        facts,
        completeness: { tasks: tasks.length, statusEvents: events.length },
      };
    },
  };
}

type TaskLike = {
  id: string;
  title: string;
  status: string;
  priority?: string;
  projectId?: string;
  dueDate?: string;
  createdAt?: number | string;
};

function taskFact(
  task: TaskLike,
  kind: string,
  observedAt: string,
): DaySourceFact {
  return {
    id: `pa:${kind}:${task.id}`,
    kind,
    occurredAt:
      task.createdAt !== undefined
        ? new Date(task.createdAt).toISOString()
        : null,
    observedAt,
    title: task.title,
    links: [`pa://task/${task.id}`],
    data: {
      taskId: task.id,
      status: task.status,
      priority: task.priority ?? null,
      projectId: task.projectId ?? null,
      dueDate: task.dueDate ?? null,
    },
    tags: ["task"],
  };
}
