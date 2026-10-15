import {
  INITIATIVE_STATES,
  type InitiativeDetail,
  type InitiativeGraphNode,
  type InitiativeState,
} from "@assistant/shared";
import {
  defineAgentTool,
  type AgentTool,
  type ToolResult,
} from "../../mcp/tool.ts";
import {
  addInitiativeMembers,
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  listInitiatives,
  readInitiative,
  removeInitiativeMembers,
  setInitiativeMilestones,
  unarchiveInitiative,
  updateInitiative,
} from "../../initiatives.ts";

/**
 * A read by id is bounded by BYTES like `task_read`: an Initiative spanning
 * several epics has hundreds of members, and the tree is cut at a node
 * boundary (depth-first, so what is left is still a tree) with the payload
 * saying how much it dropped.
 */
const READ_BUDGET_BYTES = 24_000;
const DESCRIPTION_MAX_CHARS = 2_000;

const MANAGE_OPERATIONS = [
  "create",
  "update",
  "addMembers",
  "removeMembers",
  "setMilestone",
  "clearMilestone",
  "archive",
  "unarchive",
  "delete",
] as const;

type ManageOperationName = (typeof MANAGE_OPERATIONS)[number];

const MEMBER_OPERATIONS: ReadonlySet<string> = new Set<ManageOperationName>([
  "addMembers",
  "removeMembers",
  "setMilestone",
  "clearMilestone",
]);

const initiativeReadSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "One Initiative by id, e.g. 3 for Initiative-3.",
    },
    state: { type: "string", enum: INITIATIVE_STATES },
    query: { type: "string", description: "Search titles and descriptions." },
    includeArchived: { type: "boolean", default: false },
    maxResults: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
} as const;

const initiativeManageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      description: "Applied in order; each one is written whole or not at all.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["operation"],
        properties: {
          operation: { type: "string", enum: MANAGE_OPERATIONS },
          id: { type: "string", description: "Every operation but create." },
          title: { type: "string" },
          description: { type: "string", description: "Markdown." },
          state: {
            type: "string",
            enum: INITIATIVE_STATES,
            description:
              "Set only when the user says so: never derived from the Tasks' progress.",
          },
          taskIds: {
            type: "array",
            items: { type: "string" },
            description:
              "create, addMembers, removeMembers, setMilestone, clearMilestone. A Task brings its whole subtree.",
          },
        },
      },
    },
  },
} as const;

type ReadParams = {
  id?: string;
  state?: InitiativeState;
  query?: string;
  includeArchived?: boolean;
  maxResults?: number;
};

interface ManageOperation {
  operation?: ManageOperationName;
  id?: string;
  title?: string;
  description?: string;
  state?: InitiativeState;
  taskIds?: string[];
}

type ManageParams = { operations?: ManageOperation[] };

export function initiativeTools(): AgentTool[] {
  return [makeInitiativeReadTool(), makeInitiativeManageTool()];
}

function makeInitiativeReadTool() {
  return defineAgentTool<ReadParams>({
    name: "initiative_read",
    label: "Initiatives: Read",
    description:
      "List Initiatives, or read one by id: its member Tasks as a tree with status and blocked state, its milestones, and progress counts. Task descriptions are a task_read away. A read by id is byte-bounded: when the payload flags dropped members, read those Tasks with task_read.",
    searchHint:
      "initiative initiatives milestone epic cross-project progress map dependencies",
    parameters: initiativeReadSchema,
    async execute(params) {
      const id = cleanOptional(params.id);
      if (id) {
        const detail = readInitiative(id);
        if (!detail) throw new Error(`Initiative not found: ${id}`);
        return compactJsonResult(detailForTool(detail));
      }
      const query = cleanOptional(params.query);
      const items = listInitiatives({
        ...(params.state !== undefined ? { state: params.state } : {}),
        ...(query !== undefined ? { query } : {}),
        includeArchived: params.includeArchived === true,
      });
      const maxResults = normalizeReadLimit(params.maxResults);
      return compactJsonResult({
        count: Math.min(items.length, maxResults),
        totalCount: items.length,
        truncated: items.length > maxResults,
        items: items.slice(0, maxResults).map((item) => ({
          id: item.id,
          title: item.title,
          state: item.state,
          ...(item.archivedAt !== undefined ? { archived: true } : {}),
          progress: item.progress,
        })),
      });
    },
  });
}

function makeInitiativeManageTool() {
  return defineAgentTool<ManageParams>({
    name: "initiative_manage",
    label: "Initiatives: Manage",
    description:
      "Batch-create, update, archive, unarchive or delete Initiatives — the user's groupings of Tasks across Projects — and add or remove member Tasks and mark milestones; delete only when the user explicitly asks. Add an epic rather than its subtasks: a Task inside a member, or holding one, is refused. A milestone is a member Task, done when its status is. Dependencies between Tasks are task_manage blocks links, never Initiative text.",
    searchHint:
      "initiative initiatives milestone epic cross-project group members create",
    parameters: initiativeManageSchema,
    async execute(params) {
      const operations = params.operations ?? [];
      if (operations.length === 0)
        throw new Error("initiative_manage requires at least one operation.");
      const changed = new Map<string, true>();
      const deletedIds: string[] = [];
      for (const op of operations) {
        const operation = op.operation;
        const id = cleanOptional(op.id);
        const taskIds = op.taskIds?.map((taskId) => taskId.trim());
        if (
          taskIds !== undefined &&
          operation !== "create" &&
          !MEMBER_OPERATIONS.has(operation ?? "")
        )
          throw new Error(`taskIds does not apply to ${operation}.`);
        if (operation === "create") {
          const row = createInitiative({
            title: op.title ?? "",
            ...(op.description !== undefined
              ? { description: op.description }
              : {}),
            ...(op.state !== undefined ? { state: op.state } : {}),
            ...(taskIds !== undefined ? { taskIds } : {}),
          });
          changed.set(String(row.id), true);
          continue;
        }
        if (!id) throw new Error(`${operation} requires id.`);
        if (operation === "update") {
          if (
            op.title === undefined &&
            op.description === undefined &&
            op.state === undefined
          )
            throw new Error("update needs a title, description or state.");
          updateInitiative(id, {
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.description !== undefined
              ? { description: op.description }
              : {}),
            ...(op.state !== undefined ? { state: op.state } : {}),
          });
        } else if (operation === "archive") archiveInitiative(id);
        else if (operation === "unarchive") unarchiveInitiative(id);
        else if (operation === "delete") {
          deleteInitiative(id);
          changed.delete(id);
          deletedIds.push(id);
          continue;
        } else if (MEMBER_OPERATIONS.has(operation ?? "")) {
          if (!taskIds?.length)
            throw new Error(`${operation} requires taskIds.`);
          if (operation === "addMembers") addInitiativeMembers(id, taskIds);
          else if (operation === "removeMembers")
            removeInitiativeMembers(id, taskIds);
          else
            setInitiativeMilestones(id, taskIds, operation === "setMilestone");
        } else throw new Error(`Unknown operation: ${String(operation)}`);
        changed.set(id, true);
      }
      return compactJsonResult({
        changedCount: changed.size + deletedIds.length,
        changed: [...changed.keys()].flatMap((id) => {
          const detail = readInitiative(id);
          return detail
            ? [
                {
                  id: detail.id,
                  title: detail.title,
                  state: detail.state,
                  ...(detail.archivedAt !== undefined
                    ? { archived: true }
                    : {}),
                  progress: detail.progress,
                  milestoneIds: detail.milestoneIds,
                },
              ]
            : [];
        }),
        ...(deletedIds.length ? { deletedIds } : {}),
      });
    },
  });
}

/** One member in the tool's tree: no description, open blockers by id. */
interface ToolMember {
  id: string;
  title: string;
  status: InitiativeGraphNode["status"];
  state: InitiativeGraphNode["state"];
  projectId?: string;
  milestone?: true;
  archived?: true;
  /** Open blockers (neither done nor archived), members or not. */
  blockedBy?: string[];
  children?: ToolMember[];
}

/**
 * The detail as a tree, cut depth-first at the byte budget. Each kept node is
 * charged its own bytes before its children, so the cut never leaves a child
 * without the parent that places it.
 */
function detailForTool(detail: InitiativeDetail): Record<string, unknown> {
  const open = new Set<string>();
  for (const node of detail.nodes)
    if (node.status !== "done" && !node.archived) open.add(node.id);
  for (const stub of detail.externalBlockers)
    if (stub.status !== "done" && !stub.archived) open.add(stub.id);
  const blockedBy = new Map<string, string[]>();
  for (const edge of detail.edges) {
    if (!open.has(edge.from)) continue;
    blockedBy.set(edge.to, [...(blockedBy.get(edge.to) ?? []), edge.from]);
  }
  const description = detail.description.slice(0, DESCRIPTION_MAX_CHARS);
  const head = {
    id: detail.id,
    title: detail.title,
    state: detail.state,
    ...(detail.archivedAt !== undefined ? { archived: true } : {}),
    ...(description ? { description } : {}),
    ...(description.length < detail.description.length
      ? { descriptionTruncated: true }
      : {}),
    progress: detail.progress,
    milestoneIds: detail.milestoneIds,
    externalBlockers: detail.externalBlockers,
  };

  let remaining = READ_BUDGET_BYTES - jsonBytes(head);
  let kept = 0;
  const byId = new Map<string, ToolMember>();
  const roots: ToolMember[] = [];
  for (const node of detail.nodes) {
    const blockers = blockedBy.get(node.id);
    const member: ToolMember = {
      id: node.id,
      title: node.title,
      status: node.status,
      state: node.state,
      ...(node.projectId ? { projectId: node.projectId } : {}),
      ...(node.milestone ? { milestone: true as const } : {}),
      ...(node.archived ? { archived: true as const } : {}),
      ...(blockers ? { blockedBy: blockers } : {}),
    };
    const cost = jsonBytes(member) + 16;
    if (cost > remaining) break;
    remaining -= cost;
    kept += 1;
    byId.set(member.id, member);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) (parent.children ??= []).push(member);
    else roots.push(member);
  }
  const omitted = detail.nodes.length - kept;
  return {
    ...head,
    members: roots,
    ...(omitted > 0 ? { truncated: true, omittedForBudget: omitted } : {}),
  };
}

function jsonBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
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

function cleanOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
