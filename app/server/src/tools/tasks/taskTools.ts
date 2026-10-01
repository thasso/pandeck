import type {
  AgentKind,
  TaskComment,
  TaskDueFilter,
  TaskExternalLink,
  TaskItem,
  TaskPriority,
  TaskScheduledFilter,
  TaskSessionRef,
  TaskStatus,
  TaskSummary,
} from "@assistant/shared";
import {
  isTaskExternalLinkSource,
  normalizeGithubIssueRef,
  normalizeGithubIssueRefs,
} from "@assistant/shared";
import {
  defineAgentTool,
  type AgentTool,
  type ToolResult,
  type ToolSession,
} from "../../mcp/tool.ts";
import {
  archiveTask,
  createTask,
  deleteTask,
  listTasks,
  readTask,
  taskSummaryOf,
  unarchiveTask,
  updateTask,
} from "../../tasks.ts";
import { addTaskComment, listTaskComments } from "../../taskComments.ts";
import { getProject, lookupProjects } from "../../projectRegistry.ts";
import { clipText } from "../../textBudget.ts";
import {
  getRun,
  latestStepForExecutor,
  listSteps,
  type WorkflowRunRow,
} from "../../db/workflowStore.ts";
import { workflowRunCardOf } from "../../workflow/cardProjection.ts";

/** Every `task_manage` result carries this; `task_read` stays a plain body. */
const TASK_MANAGE_RENDER_KIND = "taskManage";

const TASK_STATUS_VALUES = ["todo", "doing", "done"] as const;
const TASK_PRIORITY_VALUES = ["low", "normal", "high", "urgent"] as const;
const TASK_DUE_FILTER_VALUES = [
  "overdue",
  "today",
  "upcoming",
  "unscheduled",
] as const;
const TASK_SCHEDULED_FILTER_VALUES = [
  "past",
  "today",
  "tomorrow",
  "upcoming",
  "unplanned",
] as const;

/**
 * A `task_read` result is bounded by BYTES, not just by item count: an epic with
 * descendants, full descriptions and a long trace used to overflow the harness
 * tool-output limit outright, which costs more round trips than the read saved.
 * The budget is deliberately far below every harness cap, and the read degrades
 * in a fixed order — clip descriptions, drop descriptions (previews survive),
 * drop trailing Tasks — always saying in the payload what it did.
 */
const READ_BUDGET_BYTES = 24_000;
/** Counts and flags around the two arrays; charged to the budget, not extra. */
const ENVELOPE_BYTES = 256;
/** Comments never crowd the Tasks out entirely; the rest of the budget is theirs. */
const COMMENT_BUDGET_BYTES = 12_000;
const COMMENT_BODY_MAX_CHARS = 1_500;
const DESCRIPTION_MAX_CHARS = 2_000;
const DEFAULT_COMMENT_LIMIT = 10;
const MAX_COMMENT_LIMIT = 100;

const taskReadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description:
        "One Task by exact durable id, e.g. 32 for Task-32; query never matches an id.",
    },
    parentId: { type: "string", description: "Direct children of this id." },
    includeSubtasks: { type: "boolean" },
    status: { type: "string", enum: TASK_STATUS_VALUES },
    projectId: { type: "string" },
    priority: { type: "string", enum: TASK_PRIORITY_VALUES },
    due: { type: "string", enum: TASK_DUE_FILTER_VALUES },
    scheduled: {
      type: "string",
      enum: TASK_SCHEDULED_FILTER_VALUES,
      description:
        "By the day work is PLANNED for, not the deadline; 'past' is planned work left unfinished.",
    },
    untriaged: {
      type: "boolean",
      description: "Only Tasks still waiting in the user's Inbox.",
    },
    sessionId: { type: "string" },
    query: { type: "string", description: "Full-text search." },
    includeDescriptions: { type: "boolean", default: false },
    comments: {
      type: "object",
      additionalProperties: false,
      description: "The Task's most recent comments, oldest-first.",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: DEFAULT_COMMENT_LIMIT,
        },
        before: {
          type: "string",
          description: "comments.nextCursor from a previous result.",
        },
      },
    },
    includeArchived: { type: "boolean", default: false },
    maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const taskManageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description: "Applied in order; prefer one batch over many calls.",
      // Only the rules the runtime CANNOT correct after the fact survive here:
      // a wrong-but-valid argument (dueDate vs scheduledFor, a status the user
      // never asked for) is silent, while a missing id or an ambiguous
      // descriptionEdits oldText throws a precise error that says the same
      // thing better and only when it is needed (Task-285).
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation"],
        properties: {
          operation: {
            type: "string",
            enum: [
              "create",
              "update",
              "archive",
              "unarchive",
              "delete",
              "comment",
            ],
            description:
              "comment appends to the trace without changing the Task.",
          },
          id: { type: "string" },
          title: { type: "string" },
          description: {
            type: "string",
            description: "Markdown body, create only.",
          },
          descriptionEdits: {
            type: "array",
            description:
              "Targeted edits to the body you have read; update only.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["oldText", "newText"],
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
            },
          },
          comment: {
            type: "string",
            description:
              "An EVENT worth keeping — a decision or handoff — never progress narration.",
          },
          status: {
            type: "string",
            enum: TASK_STATUS_VALUES,
            description: "'done' also takes the Task out of 'doing'.",
          },
          statusReason: { type: "string", description: "One short line." },
          userRequestedStatus: {
            type: "boolean",
            description:
              "Set ONLY when the user asked for this status: it is then applied, not suggested.",
          },
          projectId: {
            type: "string",
            description: "Inherited from parentId.",
          },
          jiraIssueKeys: { type: "array", items: { type: "string" } },
          githubIssues: { type: "array", items: { type: "string" } },
          externalLinks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["url"],
              properties: {
                url: { type: "string" },
                type: {
                  type: "string",
                  enum: ["source", "related"],
                  default: "source",
                  // Both values validate and neither is corrected later, but
                  // "source" is what intake and minutes processing DEDUPLICATE
                  // on: a supporting link typed as one is a silent wrong write.
                  description:
                    "source = where the Task came from; related = supporting context.",
                },
                source: {
                  type: "string",
                  enum: ["slack", "jira", "github", "forgejo", "unknown"],
                  description: "Detected from the URL when omitted.",
                },
                title: { type: "string" },
              },
            },
          },
          dueDate: {
            type: "string",
            description:
              "External DEADLINE, YYYY-MM-DD — never when work happens, which is scheduledFor.",
          },
          scheduledFor: {
            type: "string",
            description:
              "The day the user plans to WORK on this, YYYY-MM-DD: the field to set when planning a day.",
          },
          priority: { type: "string", enum: ["", ...TASK_PRIORITY_VALUES] },
          parentId: {
            type: "string",
            description: "Nests this as a sub-task.",
          },
          // The batching half of this line is `operations`' own rule, and the
          // eager block is a fixed budget: the inheritance rule on `projectId`
          // is paid for by not saying it twice.
          sortOrder: {
            type: "number",
            description: "Position among siblings, lower first.",
          },
        },
      },
    },
  },
} as const;

const coordinatorTaskCreateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description: "Create follow-up Tasks in order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation", "title"],
        properties: {
          operation: { type: "string", enum: ["create"] },
          title: { type: "string" },
          description: { type: "string", description: "Markdown body." },
          projectId: { type: "string" },
          jiraIssueKeys: { type: "array", items: { type: "string" } },
          githubIssues:
            taskManageSchema.properties.operations.items.properties
              .githubIssues,
          externalLinks:
            taskManageSchema.properties.operations.items.properties
              .externalLinks,
          dueDate:
            taskManageSchema.properties.operations.items.properties.dueDate,
          scheduledFor:
            taskManageSchema.properties.operations.items.properties
              .scheduledFor,
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
          },
          sortOrder: { type: "number" },
        },
      },
    },
  },
} as const;

type ReadParams = {
  id?: string;
  parentId?: string;
  includeSubtasks?: boolean;
  status?: TaskStatus;
  projectId?: string;
  priority?: TaskPriority;
  due?: TaskDueFilter;
  scheduled?: TaskScheduledFilter;
  untriaged?: boolean;
  sessionId?: string;
  query?: string;
  includeDescriptions?: boolean;
  comments?: CommentsRequest;
  includeArchived?: boolean;
  maxResults?: number;
};

interface CommentsRequest {
  limit?: number;
  before?: string;
}

interface DescriptionEdit {
  oldText: string;
  newText: string;
}

/**
 * A Task touched by one operation, plus the per-operation facts the Task itself
 * cannot carry — whether the escape hatch applied a status the user asked for,
 * and how many targeted description edits landed.
 */
interface ChangedTask {
  task: TaskItem;
  statusSetByRequest?: boolean;
  descriptionEditsApplied?: number;
  /** A create that resolved to an EXISTING Task (Slack source-link dedupe). */
  deduplicated?: boolean;
}

interface ManageOperation {
  operation?:
    "create" | "update" | "archive" | "unarchive" | "delete" | "comment";
  id?: string;
  title?: string;
  description?: string;
  descriptionEdits?: DescriptionEdit[];
  comment?: string;
  status?: TaskStatus;
  statusReason?: string;
  userRequestedStatus?: boolean;
  projectId?: string;
  jiraIssueKeys?: string[];
  githubIssues?: string[];
  externalLinks?: TaskExternalLink[];
  dueDate?: string;
  scheduledFor?: string;
  priority?: TaskPriority | "";
  parentId?: string;
  sortOrder?: number;
}

type ManageParams = { operations?: ManageOperation[] };

/**
 * Every field that asks for a change to the Task itself. A `comment` operation
 * carries none of them: the likeliest agent slip is meaning "update AND
 * comment" but writing `comment`, and dropping the status suggestion on the
 * floor for it would lose the write with nothing in the result to say so.
 */
const MANAGE_MUTATION_FIELDS = [
  "title",
  "description",
  "descriptionEdits",
  "status",
  "statusReason",
  "userRequestedStatus",
  "projectId",
  "jiraIssueKeys",
  "githubIssues",
  "externalLinks",
  "dueDate",
  "scheduledFor",
  "priority",
  "parentId",
  "sortOrder",
] as const satisfies ReadonlyArray<keyof ManageOperation>;

export function taskToolsForKind(_defaultKind: AgentKind) {
  return [makeTaskReadTool(), makeTaskManageTool()];
}

/** Coordinator access is deliberately creation-only and run-provenanced. */
export function workflowCoordinatorTaskCreateTools(): AgentTool[] {
  return [makeTaskManageTool(true)];
}

function makeTaskReadTool() {
  return defineAgentTool<ReadParams>({
    name: "task_read",
    label: "Tasks: Read",
    description:
      "Read one Task by id, its subtasks, or a bounded Task list/search. Results are byte-bounded: when the payload flags dropped content, narrow the read instead of assuming it was complete.",
    parameters: taskReadSchema,
    async execute(params, ctx) {
      const id = cleanOptional(params.id);
      const parentId = cleanOptional(params.parentId);
      if (params.includeSubtasks && !id)
        throw new Error("includeSubtasks requires id.");
      // A trace belongs to ONE Task, so asking for one on a list read says the
      // caller means something else; returning no trace and no reason why is
      // the silent no-op this tool exists to stop.
      if (params.comments && !id)
        throw new Error("comments requires id: a trace belongs to one Task.");
      if (id && parentId)
        throw new Error("Use either id or parentId, not both.");

      const maxResults = normalizeReadLimit(params.maxResults);
      let items: TaskSummary[];
      if (id) {
        const task = readTask(id);
        if (!task) throw new Error(`Task not found: ${id}`);
        items = params.includeSubtasks
          ? [
              toSummary(task),
              ...taskDescendants(id, Boolean(params.includeArchived)),
            ]
          : [toSummary(task)];
      } else {
        const session = ctx.session;
        const sessionFilter = params.sessionId
          ? { kind: session.agentType, sessionId: params.sessionId }
          : undefined;
        const projectIdValue = cleanOptional(params.projectId);
        const queryValue = cleanOptional(params.query);
        items = listTasks({
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(projectIdValue !== undefined
            ? { projectId: projectIdValue }
            : {}),
          ...(params.priority !== undefined
            ? { priority: params.priority }
            : {}),
          ...(params.due !== undefined ? { due: params.due } : {}),
          ...(params.scheduled !== undefined
            ? { scheduled: params.scheduled }
            : {}),
          ...(params.untriaged === true ? { untriaged: true } : {}),
          ...(sessionFilter !== undefined ? { session: sessionFilter } : {}),
          ...(queryValue !== undefined ? { query: queryValue } : {}),
          includeArchived: Boolean(params.includeArchived),
        });
        if (parentId)
          items = items.filter((item) => item.parentId === parentId);
      }

      // Comments are bounded first and the Tasks get what is left, so a long
      // trace can never starve the read of the Tasks that were asked for.
      const comments =
        id && params.comments
          ? boundedComments(id, params.comments)
          : undefined;
      const commentBytes = comments ? jsonBytes(comments) : 0;
      const totalCount = items.length;
      const bounded = boundedItems({
        summaries: items.slice(0, maxResults),
        includeDescriptions: Boolean(params.includeDescriptions),
        budgetBytes: READ_BUDGET_BYTES - ENVELOPE_BYTES - commentBytes,
      });
      const omittedForBudget =
        Math.min(items.length, maxResults) - bounded.items.length;
      const details = {
        count: bounded.items.length,
        totalCount,
        truncated: totalCount > bounded.items.length,
        ...(bounded.descriptionsTruncated
          ? { descriptionsTruncated: true }
          : {}),
        ...(bounded.descriptionsOmitted ? { descriptionsOmitted: true } : {}),
        ...(omittedForBudget > 0 ? { omittedForBudget } : {}),
        items: bounded.items,
        ...(comments ? { comments } : {}),
      };
      return compactJsonResult(details);
    },
  });
}

function makeTaskManageTool(coordinatorCreateOnly = false) {
  return defineAgentTool<ManageParams>({
    name: "task_manage",
    label: coordinatorCreateOnly ? "Tasks: Create Follow-ups" : "Tasks: Manage",
    description: coordinatorCreateOnly
      ? "Create durable follow-up Tasks only when the user's current message explicitly asks. This coordinator-only variant cannot update, archive, comment on, or delete Tasks. Every created Task lands untriaged, is linked under this Workflow Run's Task, and carries its pull request as a source link when present."
      : "Batch-create, update, archive, unarchive, comment on, or delete Tasks; delete only when the user explicitly asks. Create only for durable work that will NOT happen in this session: a new Task lands in the user's Inbox untriaged. Status writes are SUGGESTIONS the user answers. At most one comment per session; silence is the default. Set dates, priority, project and issue links only from explicit or strong evidence, and ask before an ambiguous bulk change. On update, an empty string clears projectId, parentId, dueDate or scheduledFor and resets priority.",
    parameters: coordinatorCreateOnly
      ? coordinatorTaskCreateSchema
      : taskManageSchema,
    async execute(params, ctx) {
      const session = ctx.session;
      const requestedOperations = params.operations ?? [];
      const coordinatorRun = coordinatorCreateOnly
        ? workflowRunForCoordinator(session)
        : undefined;
      const operations = coordinatorRun
        ? requestedOperations.map((operation) =>
            coordinatorCreateOperation(operation, coordinatorRun),
          )
        : requestedOperations;
      if (operations.length === 0)
        throw new Error("task_manage requires at least one operation.");

      const changed: ChangedTask[] = [];
      const deletedIds: string[] = [];
      const appended: TaskComment[] = [];
      const warnings: string[] = [];
      for (const op of operations) {
        const commentBody = commentBodyOf(op.comment);
        if (op.operation === "comment") {
          const carried = MANAGE_MUTATION_FIELDS.filter(
            (field) => op[field] !== undefined,
          );
          if (carried.length > 0)
            throw new Error(
              `A comment operation changes nothing about the Task, so it cannot carry ${carried.join(", ")}. Use operation "update" with comment to do both in one operation.`,
            );
        }
        const descriptionEdits = normalizeDescriptionEdits(op.descriptionEdits);
        if (descriptionEdits && op.operation !== "update")
          throw new Error(
            "descriptionEdits applies only to an update operation.",
          );
        if (commentBody && op.operation === "delete")
          throw new Error("A deleted Task cannot carry a comment.");
        // The comment rides the same operation, so it needs the id the mutation
        // resolved to — which for a create is only known afterwards.
        let commentTaskId: string | undefined;

        if (op.operation === "comment") {
          if (!op.id) throw new Error("Comment operation requires id.");
          if (!commentBody)
            throw new Error("Comment operation requires comment text.");
          commentTaskId = op.id;
        } else if (op.operation === "archive") {
          if (!op.id) throw new Error("Archive operation requires id.");
          changed.push({ task: archiveTask(op.id) });
          commentTaskId = op.id;
        } else if (op.operation === "unarchive") {
          if (!op.id) throw new Error("Unarchive operation requires id.");
          changed.push({ task: unarchiveTask(op.id) });
          commentTaskId = op.id;
        } else if (op.operation === "delete") {
          if (!op.id) throw new Error("Delete operation requires id.");
          deleteTask(op.id);
          deletedIds.push(op.id);
        } else if (op.operation === "create") {
          const title = cleanTitle(op.title);
          if (!title) throw new Error("Create operation requires a title.");
          const jiraIssueKeys = normalizeJiraIssueKeys(op.jiraIssueKeys);
          const githubIssues = githubIssueRefsForTool(op.githubIssues);
          const projectIdValue = cleanOptional(op.projectId);
          const links = resolveTaskLinks({
            ...(projectIdValue !== undefined
              ? { projectId: projectIdValue }
              : {}),
            ...(jiraIssueKeys[0] !== undefined
              ? { primaryJiraKey: jiraIssueKeys[0] }
              : {}),
            warnings,
          });
          const externalLinks = normalizeExternalLinksForTool(op.externalLinks);
          const duplicate = findExistingSlackTask(externalLinks);
          if (duplicate) {
            if (coordinatorCreateOnly)
              throw new Error(
                `follow-up Task creation was refused because source links match existing Task ${duplicate.id}; the coordinator cannot modify existing Tasks`,
              );
            warnings.push(
              `Skipped duplicate Slack import for existing Task ${duplicate.id}; matched source link by permalink/channel+ts.`,
            );
            // Flagged, not just warned about: `changed` says nothing about which
            // operation produced an entry, so a create that landed on an
            // existing Task would otherwise be indistinguishable from a real one
            // and read as "created" wherever the op is used for the verb.
            changed.push({
              task: updateTask(duplicate.id, {
                // The list projection intentionally carries lean refs. Re-read
                // the detail before rewriting the edge set so existing server
                // metadata is not erased during deduplication.
                sessionRefs: addSessionRef(
                  readTask(duplicate.id)?.sessionRefs,
                  session,
                ),
              }),
              deduplicated: true,
            });
            commentTaskId = duplicate.id;
          } else {
            const createParentId = cleanOptional(op.parentId);
            const createSortOrder = normalizeSortOrder(op.sortOrder);
            const created = createTask({
              title,
              description: op.description ?? "",
              status: normalizeStatus(op.status),
              ...(links.projectId != null
                ? { projectId: links.projectId }
                : {}),
              jiraIssueKeys,
              ...(githubIssues !== undefined ? { githubIssues } : {}),
              ...(externalLinks !== undefined ? { externalLinks } : {}),
              ...taskSchedulingForCreate(op),
              ...(createParentId !== undefined
                ? { parentId: createParentId }
                : {}),
              ...(createSortOrder !== undefined
                ? { sortOrder: createSortOrder }
                : {}),
              sessionRefs: [
                {
                  harness: session.harness,
                  agentType: session.agentType,
                  sessionId: session.sessionId,
                  ...(session.sessionFile !== undefined
                    ? { sessionFile: session.sessionFile }
                    : {}),
                },
              ],
              source: {
                createdBy: "agent",
                agentType: session.agentType,
                sessionId: session.sessionId,
              },
            });
            changed.push({ task: created });
            commentTaskId = created.id;
          }
        } else if (op.operation === "update") {
          if (!op.id) throw new Error("Update operation requires id.");
          // A description an agent did not read is one it cannot safely
          // replace, so on update the whole-body write is refused outright and
          // only targeted edits get through. Creates still write a whole body:
          // there is nothing there to clobber.
          if (op.description !== undefined)
            throw new Error(
              "An agent cannot replace a whole Task description on update; read it and pass targeted descriptionEdits instead. A whole description is only written on create.",
            );
          const current = readTask(op.id);
          const editedDescription = descriptionEdits
            ? applyDescriptionEdits(current, op.id, descriptionEdits)
            : undefined;
          const jiraIssueKeys = op.jiraIssueKeys
            ? normalizeJiraIssueKeys(op.jiraIssueKeys)
            : undefined;
          const githubIssues = githubIssueRefsForTool(op.githubIssues);
          const projectIdValue =
            op.projectId === "" ? null : cleanOptional(op.projectId);
          const links = resolveTaskLinks({
            ...(projectIdValue !== undefined
              ? { projectId: projectIdValue }
              : {}),
            ...(jiraIssueKeys?.[0] !== undefined
              ? { primaryJiraKey: jiraIssueKeys?.[0] }
              : {}),
            ...(current?.projectId !== undefined
              ? { currentProjectId: current?.projectId }
              : {}),
            warnings,
          });
          // Whether the escape hatch actually did anything is decided BEFORE the
          // write: afterwards the Task simply has the requested status, which is
          // also what an ordinary no-op write leaves behind.
          const statusSetByRequest =
            op.userRequestedStatus === true &&
            (op.status === "done" || op.status === "todo") &&
            current !== null &&
            current.status !== op.status;
          const externalLinksValue = normalizeExternalLinksForTool(
            op.externalLinks,
          );
          // `undefined` here means "leave the parent alone"; `""` means "move to
          // root", which is the `null` the patch carries.
          const updateParentId: string | null | undefined =
            op.parentId === undefined
              ? undefined
              : op.parentId === ""
                ? null
                : cleanOptional(op.parentId);
          const updateSortOrder = normalizeSortOrder(op.sortOrder);
          const updated = updateTask(op.id, {
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(editedDescription !== undefined
              ? { description: editedDescription }
              : {}),
            ...(op.status !== undefined ? { status: op.status } : {}),
            ...(op.statusReason !== undefined
              ? { statusReason: op.statusReason }
              : {}),
            userRequestedStatus: op.userRequestedStatus === true,
            actor: { kind: "agent", id: session.sessionId },
            ...(links.projectId !== undefined
              ? { projectId: links.projectId }
              : {}),
            ...(jiraIssueKeys !== undefined ? { jiraIssueKeys } : {}),
            ...(githubIssues !== undefined ? { githubIssues } : {}),
            ...(op.externalLinks
              ? {
                  ...(externalLinksValue !== undefined
                    ? { externalLinks: externalLinksValue }
                    : {}),
                }
              : {}),
            ...taskSchedulingForUpdate(op),
            ...(updateParentId !== undefined
              ? { parentId: updateParentId }
              : {}),
            ...(updateSortOrder !== undefined
              ? { sortOrder: updateSortOrder }
              : {}),
            sessionRefs: addSessionRef(current?.sessionRefs, session),
          });
          changed.push({
            task: updated,
            statusSetByRequest,
            ...(descriptionEdits
              ? { descriptionEditsApplied: descriptionEdits.length }
              : {}),
          });
          commentTaskId = op.id;
        } else {
          throw new Error(
            `Unsupported task operation: ${op.operation ?? "(missing)"}`,
          );
        }

        if (commentBody && commentTaskId)
          appended.push(
            addTaskComment({
              taskId: commentTaskId,
              authorKind: "agent",
              authorName: cleanOptional(session.title) ?? session.agentType,
              authorSessionId: session.sessionId,
              body: commentBody,
            }),
          );
      }

      // The RESULT shape is a contract (a web card renders it), so it says the
      // whole outcome once: every entry's `status` is the status after the
      // write, `descriptionEditsApplied` counts the targeted edits that landed,
      // `comments` names every trace append, and a recorded `statusSuggestion`
      // states what is still waiting for the user. Nothing about a suggestion
      // goes in `warnings` — the server did exactly what an agent's status
      // write means, so phrasing it as a warning made a correct outcome read
      // like a failure.
      return compactJsonResult({
        renderKind: TASK_MANAGE_RENDER_KIND,
        version: 1,
        changedCount: changed.length + deletedIds.length,
        changed: changed.map((entry) =>
          taskForTool(toSummary(entry.task), false, {
            ...(entry.statusSetByRequest !== undefined
              ? { statusSetByRequest: entry.statusSetByRequest }
              : {}),
            ...(entry.descriptionEditsApplied !== undefined
              ? { descriptionEditsApplied: entry.descriptionEditsApplied }
              : {}),
            ...(entry.deduplicated !== undefined
              ? { deduplicated: entry.deduplicated }
              : {}),
          }),
        ),
        ...(deletedIds.length ? { deletedIds } : {}),
        ...(appended.length
          ? {
              comments: appended.map((comment) => ({
                taskId: comment.taskId,
                ...commentForTool(comment),
              })),
            }
          : {}),
        ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}),
      });
    },
  });
}

const COORDINATOR_CREATE_FIELDS = new Set<keyof ManageOperation>([
  "operation",
  "title",
  "description",
  "projectId",
  "jiraIssueKeys",
  "githubIssues",
  "externalLinks",
  "dueDate",
  "scheduledFor",
  "priority",
  "sortOrder",
]);

function workflowRunForCoordinator(session: ToolSession): WorkflowRunRow {
  if (session.agentType !== "workflow-coordinator")
    throw new Error(
      "this creation-focused task_manage is available only in a workflow coordinator session",
    );
  const assigned = latestStepForExecutor("session", session.sessionId);
  if (!assigned)
    throw new Error(
      "this coordinator session is not associated with a Workflow Run",
    );
  const run = getRun(assigned.runId);
  if (!run)
    throw new Error("the Workflow Run for this coordinator session is missing");
  if (!readTask(String(run.taskId)))
    throw new Error(
      `cannot create workflow follow-up Tasks because source Task-${run.taskId} no longer exists`,
    );
  return run;
}

function coordinatorCreateOperation(
  operation: ManageOperation,
  run: WorkflowRunRow,
): ManageOperation {
  if (operation.operation !== "create")
    throw new Error(
      `the coordinator's task_manage can only create follow-up Tasks; operation ${JSON.stringify(operation.operation ?? "(missing)")} was refused`,
    );
  const unsupported = Object.keys(operation).filter(
    (field) => !COORDINATOR_CREATE_FIELDS.has(field as keyof ManageOperation),
  );
  if (unsupported.length > 0)
    throw new Error(
      `the coordinator's task_manage cannot set ${unsupported.join(", ")}`,
    );

  const card = workflowRunCardOf(run, listSteps(run.id));
  const provenance: TaskExternalLink[] = [
    ...(card.pullRequest?.url
      ? [
          {
            url: card.pullRequest.url,
            type: "source" as const,
            source: "unknown" as const,
            title: `Workflow Run ${run.id} pull request #${card.pullRequest.number}`,
          },
        ]
      : []),
  ];
  const provenanceUrls = new Set(
    provenance.map((link) => comparableExternalLinkUrl(link.url)),
  );
  const externalLinks = [
    ...(operation.externalLinks ?? []).filter(
      (candidate) =>
        !provenanceUrls.has(comparableExternalLinkUrl(candidate.url)),
    ),
    ...provenance,
  ];
  return {
    ...operation,
    ...(operation.projectId === undefined && run.projectId
      ? { projectId: run.projectId }
      : {}),
    parentId: String(run.taskId),
    externalLinks,
  };
}

function comparableExternalLinkUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

/**
 * Targeted description edits, applied against the body the agent claims to have
 * read: every `oldText` must occur EXACTLY once and no two edits may overlap,
 * so a stale or ambiguous edit fails loudly instead of rewriting the wrong span.
 */
function applyDescriptionEdits(
  current: TaskItem | null,
  id: string,
  edits: DescriptionEdit[],
): string {
  if (!current) throw new Error(`Task not found: ${id}`);
  const description = current.description ?? "";
  const regions: { start: number; end: number; newText: string }[] = [];
  for (const edit of edits) {
    const first = description.indexOf(edit.oldText);
    if (first < 0)
      throw new Error(
        `descriptionEdits oldText not found in Task ${id}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    const second = description.indexOf(
      edit.oldText,
      first + edit.oldText.length,
    );
    if (second >= 0)
      throw new Error(
        `descriptionEdits oldText is not unique in Task ${id}: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      );
    regions.push({
      start: first,
      end: first + edit.oldText.length,
      newText: edit.newText,
    });
  }
  regions.sort((a, b) => a.start - b.start);
  for (let i = 1; i < regions.length; i++) {
    if (regions[i]!.start < regions[i - 1]!.end)
      throw new Error("descriptionEdits must not overlap.");
  }
  let next = "";
  let cursor = 0;
  for (const region of regions) {
    next += description.slice(cursor, region.start) + region.newText;
    cursor = region.end;
  }
  return next + description.slice(cursor);
}

function normalizeDescriptionEdits(
  values: unknown,
): DescriptionEdit[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0)
    throw new Error("descriptionEdits must be a non-empty array.");
  return values.map((raw) => {
    const oldText = (raw as { oldText?: unknown })?.oldText;
    const newText = (raw as { newText?: unknown })?.newText;
    if (typeof oldText !== "string" || oldText === "")
      throw new Error("descriptionEdits[].oldText must be a non-empty string.");
    if (typeof newText !== "string")
      throw new Error("descriptionEdits[].newText must be a string.");
    return { oldText, newText };
  });
}

function commentBodyOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const body = String(value ?? "").trim();
  if (!body) throw new Error("comment must not be empty.");
  return body;
}

/**
 * One comment, with its body clipped so a single 20k-char comment cannot decide
 * how many comments fit. A clipped body says so rather than looking complete.
 */
function commentForTool(comment: TaskComment) {
  const clipped = clipText(comment.body, COMMENT_BODY_MAX_CHARS);
  return {
    id: comment.id,
    author: comment.author.name,
    authorKind: comment.author.kind,
    createdAt: comment.createdAt,
    body: clipped.text,
    ...(clipped.truncated
      ? { bodyTruncated: true, bodyChars: comment.body.length }
      : {}),
  };
}

/**
 * The most recent comments of one Task, oldest-first so the trace reads
 * chronologically, with `olderCount` and a `nextCursor` that pages BACKWARDS in
 * time — the rare deep-history read walks it, the common read never pays for it.
 */
function boundedComments(taskId: string, request: CommentsRequest) {
  const all = listTaskComments(taskId);
  const before = cleanOptional(request.before);
  let pool = all;
  if (before) {
    const index = all.findIndex((comment) => comment.id === before);
    if (index < 0)
      throw new Error(
        `Unknown comments.before cursor for Task ${taskId}: ${before}`,
      );
    pool = all.slice(0, index);
  }
  const limit = normalizeCommentLimit(request.limit);
  const items = pool
    .slice(Math.max(0, pool.length - limit))
    .map(commentForTool);
  while (items.length > 1 && jsonBytes(items) > COMMENT_BUDGET_BYTES)
    items.shift();
  const olderCount = pool.length - items.length;
  return {
    count: items.length,
    totalCount: all.length,
    olderCount,
    ...(olderCount > 0 && items[0] ? { nextCursor: items[0].id } : {}),
    items,
  };
}

interface BoundedItems {
  items: ReturnType<typeof taskForTool>[];
  descriptionsTruncated: boolean;
  descriptionsOmitted: boolean;
}

/**
 * Fit the Tasks into the remaining budget by degrading, in this order: full
 * descriptions, clipped descriptions, no descriptions (the short previews
 * survive), then dropping trailing Tasks. Losing bodies beats losing Tasks — a
 * caller that asked for an epic wants to see the whole shape of it first.
 */
function boundedItems(args: {
  summaries: TaskSummary[];
  includeDescriptions: boolean;
  budgetBytes: number;
}): BoundedItems {
  const { summaries, includeDescriptions, budgetBytes } = args;
  if (includeDescriptions) {
    const full = summaries.map((item) => taskForTool(item, true));
    if (jsonBytes(full) <= budgetBytes)
      return {
        items: full,
        descriptionsTruncated: false,
        descriptionsOmitted: false,
      };
    const clipped = summaries.map((item) =>
      taskForTool(item, true, {}, DESCRIPTION_MAX_CHARS),
    );
    if (jsonBytes(clipped) <= budgetBytes)
      return {
        items: clipped,
        descriptionsTruncated: true,
        descriptionsOmitted: false,
      };
  }
  const previews = summaries.map((item) => taskForTool(item, false));
  while (previews.length > 1 && jsonBytes(previews) > budgetBytes)
    previews.pop();
  return {
    items: previews,
    descriptionsTruncated: false,
    descriptionsOmitted: includeDescriptions,
  };
}

function jsonBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function normalizeCommentLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(MAX_COMMENT_LIMIT, Math.trunc(value)))
    : DEFAULT_COMMENT_LIMIT;
}

function findExistingSlackTask(
  externalLinks: TaskExternalLink[] | undefined,
): TaskSummary | undefined {
  const requestedKeys = slackSourceKeys(externalLinks);
  if (requestedKeys.size === 0) return undefined;
  const existing = listTasks({ includeArchived: false });
  return existing.find((task) => {
    const keys = slackSourceKeys(task.externalLinks);
    for (const key of requestedKeys) {
      if (keys.has(key)) return true;
    }
    return false;
  });
}

function slackSourceKeys(
  externalLinks: TaskExternalLink[] | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const link of externalLinks ?? []) {
    const url = cleanOptional(link.url);
    if (!url) continue;
    const parsed = parseSlackMessageUrl(url);
    if (!parsed && link.source !== "slack") continue;
    keys.add(`url:${normalizeComparableUrl(url)}`);
    if (parsed)
      keys.add(`slack-message:${parsed.host}:${parsed.channelId}:${parsed.ts}`);
  }
  return keys;
}

function parseSlackMessageUrl(
  value: string,
): { host: string; channelId: string; ts: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith("slack.com")) return null;
  const archiveMatch = url.pathname.match(
    /\/archives\/([^/]+)\/p(\d{10})(\d{0,6})/i,
  );
  if (archiveMatch?.[1] && archiveMatch[2]) {
    const fraction = archiveMatch[3]
      ? archiveMatch[3].padEnd(6, "0")
      : "000000";
    return {
      host,
      channelId: archiveMatch[1],
      ts: `${archiveMatch[2]}.${fraction}`,
    };
  }
  const channelId =
    url.searchParams.get("channel") ?? url.searchParams.get("cid");
  const messageTs =
    url.searchParams.get("message_ts") ??
    url.searchParams.get("thread_ts") ??
    url.searchParams.get("ts");
  if (channelId && messageTs)
    return { host, channelId, ts: normalizeSlackTs(messageTs) };
  return null;
}

function normalizeSlackTs(value: string): string {
  const clean = value.trim();
  if (/^\d{10}\.\d{1,6}$/.test(clean)) {
    const [seconds, fraction = ""] = clean.split(".");
    return `${seconds}.${fraction.padEnd(6, "0")}`;
  }
  const compact = clean.replace(/\D/g, "");
  if (compact.length > 10)
    return `${compact.slice(0, 10)}.${compact.slice(10, 16).padEnd(6, "0")}`;
  return clean;
}

function normalizeComparableUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.searchParams.sort();
    return url.toString();
  } catch {
    return value.trim();
  }
}

function resolveTaskLinks(args: {
  projectId?: string | null;
  primaryJiraKey?: string;
  currentProjectId?: string;
  warnings: string[];
}): { projectId?: string | null } {
  const primaryJiraKey = cleanOptional(args.primaryJiraKey)?.toUpperCase();
  let projectId: string | null | undefined;

  if (args.projectId === null) {
    projectId = null;
  } else if (args.projectId !== undefined) {
    const requested = cleanOptional(args.projectId);
    const project = requested ? getProject(requested) : null;
    projectId = project?.id ?? requested;
    if (requested && !project)
      args.warnings.push(
        `Unknown projectId "${requested}"; no project registry record matched.`,
      );
  }

  if (primaryJiraKey && projectId !== null) {
    const matches = lookupProjects({ jiraKey: primaryJiraKey, maxResults: 3 });
    const goodMatches = matches.filter(
      (match) => match.confidence === "strong" || match.confidence === "medium",
    );
    const currentOrRequestedProject = projectId ?? args.currentProjectId;
    if (!currentOrRequestedProject && goodMatches.length === 1) {
      projectId = goodMatches[0]!.project.id;
      args.warnings.push(
        `Linked ${primaryJiraKey} to projectId "${projectId}" from the project registry.`,
      );
    } else if (!currentOrRequestedProject && goodMatches.length > 1) {
      args.warnings.push(
        `Jira key ${primaryJiraKey} matched multiple registry projects; projectId was left unset.`,
      );
    } else if (
      currentOrRequestedProject &&
      goodMatches.length > 0 &&
      !goodMatches.some(
        (match) => match.project.id === currentOrRequestedProject,
      )
    ) {
      args.warnings.push(
        `Jira key ${primaryJiraKey} matched registry project "${goodMatches[0]!.project.id}", not current projectId "${currentOrRequestedProject}".`,
      );
    }
  }

  return { ...(projectId !== undefined ? { projectId } : {}) };
}

function addSessionRef(
  refs: TaskSessionRef[] | undefined,
  session: ToolSession,
): TaskSessionRef[] {
  const current = refs ?? [];
  if (current.some((ref) => ref.sessionId === session.sessionId))
    return current;
  return [
    ...current,
    {
      harness: session.harness,
      agentType: session.agentType,
      sessionId: session.sessionId,
      ...(session.sessionFile !== undefined
        ? { sessionFile: session.sessionFile }
        : {}),
    },
  ];
}

function compactJsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function normalizeReadLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(100, Math.trunc(value)))
    : 50;
}

function taskDescendants(
  parentId: string,
  includeArchived: boolean,
): TaskSummary[] {
  const all = listTasks({ includeArchived });
  const byParent = new Map<string, TaskSummary[]>();
  for (const task of all) {
    if (!task.parentId) continue;
    const siblings = byParent.get(task.parentId) ?? [];
    siblings.push(task);
    byParent.set(task.parentId, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort(
      (a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.createdAt - b.createdAt,
    );
  }

  const result: TaskSummary[] = [];
  const visit = (id: string) => {
    for (const child of byParent.get(id) ?? []) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(parentId);
  return result;
}

/**
 * One Task in a tool result. `status` is always the status AFTER the write, so
 * a caller never has to reconstruct it from what it asked for.
 */
function taskForTool(
  summary: TaskSummary,
  includeDescription: boolean,
  applied: {
    statusSetByRequest?: boolean;
    descriptionEditsApplied?: number;
    deduplicated?: boolean;
  } = {},
  descriptionMaxChars?: number,
) {
  const item = includeDescription ? readTask(summary.id) : null;
  const full = item?.description;
  const clip =
    full !== undefined && descriptionMaxChars !== undefined
      ? clipText(full, descriptionMaxChars)
      : undefined;
  const description = clip ? clip.text : full;
  const clipped =
    clip?.truncated && full !== undefined
      ? { descriptionTruncated: true, descriptionChars: full.length }
      : undefined;
  return {
    id: summary.id,
    title: summary.title,
    status: summary.status,
    ...(summary.statusSuggestion
      ? {
          statusSuggestion: {
            to: summary.statusSuggestion.to,
            at: summary.statusSuggestion.at,
            ...(summary.statusSuggestion.reason
              ? { reason: summary.statusSuggestion.reason }
              : {}),
          },
        }
      : {}),
    ...(applied.statusSetByRequest ? { statusSetByRequest: true } : {}),
    ...(applied.deduplicated ? { deduplicated: true } : {}),
    ...(applied.descriptionEditsApplied !== undefined
      ? { descriptionEditsApplied: applied.descriptionEditsApplied }
      : {}),
    ...(description !== undefined
      ? { description, ...(clipped ?? {}) }
      : summary.descriptionPreview
        ? { descriptionPreview: summary.descriptionPreview }
        : {}),
    ...(summary.parentId ? { parentId: summary.parentId } : {}),
    ...(summary.sortOrder !== undefined
      ? { sortOrder: summary.sortOrder }
      : {}),
    ...(summary.projectId ? { projectId: summary.projectId } : {}),
    ...(summary.jiraIssueKeys?.length
      ? { jiraIssueKeys: summary.jiraIssueKeys }
      : {}),
    ...(summary.githubIssues?.length
      ? { githubIssues: summary.githubIssues }
      : {}),
    ...(summary.externalLinks?.length
      ? { externalLinks: summary.externalLinks }
      : {}),
    ...(summary.dueDate ? { dueDate: summary.dueDate } : {}),
    ...(summary.scheduledFor ? { scheduledFor: summary.scheduledFor } : {}),
    ...(summary.triagedAt === undefined ? { untriaged: true } : {}),
    ...(summary.priority && summary.priority !== "normal"
      ? { priority: summary.priority }
      : {}),
    ...(summary.archivedAt !== undefined
      ? { archivedAt: summary.archivedAt }
      : {}),
  };
}

const toSummary = taskSummaryOf;

function cleanTitle(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim();
}

function cleanOptional(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeJiraIssueKeys(values: unknown): string[] {
  const candidates = Array.isArray(values) ? values : [];
  const keys = candidates
    .map((value) => cleanOptional(value)?.toUpperCase())
    .filter((value): value is string =>
      Boolean(value && /^[A-Z][A-Z0-9]+-\d+$/.test(value)),
    );
  return [...new Set(keys)];
}

/**
 * Canonical refs, or undefined when the operation names none. Unlike Jira keys
 * a malformed ref THROWS: `#123` without its repository is the likely slip, and
 * silently dropping it would read as a link that landed.
 */
function githubIssueRefsForTool(values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  const list = Array.isArray(values) ? values : [values];
  const invalid = list.filter((value) => !normalizeGithubIssueRef(value));
  if (invalid.length)
    throw new Error(
      `Not a GitHub issue reference: ${invalid.map((value) => JSON.stringify(value)).join(", ")}. Use 'owner/repo#123' or the issue's github.com URL.`,
    );
  return normalizeGithubIssueRefs(list);
}

function normalizeExternalLinksForTool(
  values: unknown,
): TaskExternalLink[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const out: TaskExternalLink[] = [];
  for (const raw of values) {
    if (!raw || typeof raw !== "object") continue;
    const url = cleanOptional((raw as { url?: unknown }).url);
    if (!url) continue;
    const type =
      (raw as { type?: unknown }).type === "related" ? "related" : "source";
    const rawSource = (raw as { source?: unknown }).source;
    const source = isTaskExternalLinkSource(rawSource) ? rawSource : "unknown";
    const titleValue = cleanOptional((raw as { title?: unknown }).title);
    out.push({
      url,
      type,
      source,
      ...(titleValue !== undefined ? { title: titleValue } : {}),
      addedAt: Date.now(),
    });
  }
  return out.length ? out : undefined;
}

function normalizeSortOrder(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function normalizeStatus(status: unknown): TaskStatus {
  return status === "doing" || status === "done" ? status : "todo";
}

function normalizePriority(priority: unknown): TaskPriority | undefined {
  return priority === "low" ||
    priority === "normal" ||
    priority === "high" ||
    priority === "urgent"
    ? priority
    : undefined;
}

function taskSchedulingForCreate(op: ManageOperation): {
  dueDate?: string;
  scheduledFor?: string;
  priority?: TaskPriority;
} {
  const dueDateValue = cleanOptional(op.dueDate);
  const scheduledForValue = cleanOptional(op.scheduledFor);
  const priorityValue = normalizePriority(op.priority);
  return {
    ...(dueDateValue !== undefined ? { dueDate: dueDateValue } : {}),
    ...(scheduledForValue !== undefined
      ? { scheduledFor: scheduledForValue }
      : {}),
    ...(priorityValue !== undefined ? { priority: priorityValue } : {}),
  };
}

function taskSchedulingForUpdate(op: ManageOperation): {
  dueDate?: string | null;
  scheduledFor?: string | null;
  priority?: TaskPriority | null;
} {
  const dueDateValue = op.dueDate === "" ? null : cleanOptional(op.dueDate);
  const scheduledForValue =
    op.scheduledFor === "" ? null : cleanOptional(op.scheduledFor);
  const priorityValue =
    op.priority === "" ? null : normalizePriority(op.priority);
  return {
    ...(dueDateValue !== undefined ? { dueDate: dueDateValue } : {}),
    ...(scheduledForValue !== undefined
      ? { scheduledFor: scheduledForValue }
      : {}),
    ...(priorityValue !== undefined ? { priority: priorityValue } : {}),
  };
}
