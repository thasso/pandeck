import { readInitiativeActivity } from "../../initiativeActivityRead.ts";
import type { MemberActivity } from "../../initiativeActivity.ts";
import {
  INITIATIVE_STATES,
  type InitiativeDetail,
  type InitiativeExternalBlocker,
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
  initiativeMembershipNow,
  type InitiativeMembershipWrite,
} from "../../initiatives.ts";

/**
 * Every result is bounded by its WHOLE UTF-8 size, like `task_read`: an
 * Initiative spanning several epics has hundreds of members and may wait on
 * hundreds of outside Tasks. Each list inside a read has its own cap, and the
 * member tree is cut depth-first at a node boundary, with `nextOffset` to read
 * on from there.
 */
const READ_BUDGET_BYTES = 24_000;
/** Room the closing metadata (`truncated`, `nextOffset`, counts) may take. */
const TRAILER_BYTES = 160;
const DESCRIPTION_MAX_BYTES = 4_000;
const MILESTONE_IDS_MAX = 20;
const EXTERNAL_BLOCKERS_MAX_BYTES = 6_000;
const BLOCKED_BY_MAX = 10;
/**
 * Whole-record caps (`fitRecord`). A head and one node, each at its cap, plus
 * the node's place in the tree and the trailer, stay inside the budget, so
 * every page carries at least its first node.
 */
const HEAD_MAX_BYTES = 19_000;
const NODE_MAX_BYTES = 4_000;
const EXTERNAL_BLOCKER_MAX_BYTES = 2_000;
/** What a record's top level costs in its parent's `children` at most. */
const CHILD_PLACE_BYTES = 14;
/** Ends a string `fitRecord` cut; the record names it in `clipped`. */
const CLIP_MARK = "…";

/**
 * The fields `fitRecord` may give up, in the order it gives them up; each
 * group goes whole and is named in `omitted` by its first key. Every other
 * field is required: only the `*_CLIP` strings may be cut, in that order.
 */
const HEAD_DROP = [
  ["externalBlockers", "externalBlockersOmitted"],
  ["description", "descriptionTruncated"],
  ["milestoneIds", "milestonesOmitted"],
] as const;
const HEAD_CLIP = ["title", "id"] as const;
const NODE_DROP = [["activity"], ["projectId"], ["blockedBy"]] as const;
const NODE_CLIP = ["title", "parentId", "id"] as const;
const EXTERNAL_BLOCKER_DROP = [["projectId"]] as const;
const EXTERNAL_BLOCKER_CLIP = ["title", "id"] as const;
/** A manage answer names at most this many Tasks per Initiative and list. */
const MANAGE_TASK_IDS_MAX = 20;

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
    offset: {
      type: "integer",
      minimum: 0,
      description: "With id: the nextOffset of a truncated read, to read on.",
    },
    state: { type: "string", enum: INITIATIVE_STATES },
    query: { type: "string", description: "Search titles and descriptions." },
    includeActivity: {
      type: "boolean",
      default: false,
      description:
        "With id only: live sessions rooted by task-start, Task-linked worktrees or Workflow Run roles, plus coordinator-owned descendants unless attached to another Task. Passive references do not qualify. Includes state, last activity, owed replies, stalled, worktrees and PR observations, including settled sessions' PRs and removed worktrees. At most 5 sessions, 3 worktrees, 3 PRs and 3 owed ids per session; true counts when capped. Activity is omitted before other member fields or required-string clipping. PR head/checks/review are last observed, not a provider refresh.",
    },
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
              "create, addMembers, removeMembers, setMilestone, clearMilestone. A Task brings its whole subtree; one list is one request, in any order.",
          },
        },
      },
    },
  },
} as const;

type ReadParams = {
  id?: string;
  offset?: number;
  state?: InitiativeState;
  query?: string;
  includeArchived?: boolean;
  includeActivity?: boolean;
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
      "List Initiatives, or read one by id: its member Tasks as a tree with status and blocked state, its milestones, and progress counts. Opt in with includeActivity for live delivery sessions, worktrees and PR state per member. Task descriptions are a task_read away. Results are byte-bounded: when a read by id is truncated, read on with its nextOffset; an omitted outside blocker is still named in its member's blockedBy.",
    searchHint:
      "initiative initiatives milestone epic cross-project progress map dependencies",
    parameters: initiativeReadSchema,
    async execute(params) {
      const id = cleanOptional(params.id);
      if (id) {
        const detail = readInitiative(id);
        if (!detail) throw new Error(`Initiative not found: ${shortText(id)}`);
        const activity =
          params.includeActivity === true
            ? await readInitiativeActivity(
                detail.id,
                detail.nodes.map((node) => node.id),
              )
            : undefined;
        return compactJsonResult(
          detailForTool(detail, params.offset ?? 0, activity),
        );
      }
      if (params.includeActivity !== undefined)
        throw new Error("includeActivity applies only to a read by id.");
      if (params.offset !== undefined)
        throw new Error("offset applies only to a read by id.");
      const query = cleanOptional(params.query);
      return compactJsonResult(
        listForTool(
          listInitiatives({
            ...(params.state !== undefined ? { state: params.state } : {}),
            ...(query !== undefined ? { query } : {}),
            includeArchived: params.includeArchived === true,
          }),
          normalizeReadLimit(params.maxResults),
        ),
      );
    },
  });
}

function makeInitiativeManageTool() {
  return defineAgentTool<ManageParams>({
    name: "initiative_manage",
    label: "Initiatives: Manage",
    description:
      "Batch-create, update, archive, unarchive or delete Initiatives — the user's groupings of Tasks across Projects — and add or remove member Tasks and mark milestones; delete only when the user explicitly asks. A member brings its whole subtree: adding a Task under a member is refused, and adding an epic absorbs its members below it. A milestone is a member Task, even one inside a member epic, done when its status is. Dependencies between Tasks are task_manage blocks links, never Initiative text.",
    searchHint:
      "initiative initiatives milestone epic cross-project group members create",
    parameters: initiativeManageSchema,
    async execute(params) {
      const operations = params.operations ?? [];
      if (operations.length === 0)
        throw new Error("initiative_manage requires at least one operation.");
      // Every id this answer names is the canonical one a write returned,
      // never the caller's spelling: `0003` and `3` are one Initiative.
      const changed = new Set<string>();
      const deletedIds: string[] = [];
      const absorbed = new Map<string, string[]>();
      const removed = new Map<string, Set<string>>();
      const record = (write: InitiativeMembershipWrite): string => {
        const id = String(write.initiative.id);
        changed.add(id);
        if (write.absorbedTaskIds.length)
          absorbed.set(id, [
            ...(absorbed.get(id) ?? []),
            ...write.absorbedTaskIds,
          ]);
        return id;
      };
      for (const op of operations) {
        const operation = op.operation;
        const id = cleanOptional(op.id);
        const taskIds = op.taskIds?.map((taskId) => taskId.trim());
        const named = shortText(String(operation));
        if (
          taskIds !== undefined &&
          operation !== "create" &&
          !MEMBER_OPERATIONS.has(operation ?? "")
        )
          throw new Error(`taskIds does not apply to ${named}.`);
        if (operation === "create") {
          record(
            createInitiative({
              title: op.title ?? "",
              ...(op.description !== undefined
                ? { description: op.description }
                : {}),
              ...(op.state !== undefined ? { state: op.state } : {}),
              ...(taskIds !== undefined ? { taskIds } : {}),
            }),
          );
          continue;
        }
        if (!id) throw new Error(`${named} requires id.`);
        if (operation === "update") {
          if (
            op.title === undefined &&
            op.description === undefined &&
            op.state === undefined
          )
            throw new Error("update needs a title, description or state.");
          const row = updateInitiative(id, {
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.description !== undefined
              ? { description: op.description }
              : {}),
            ...(op.state !== undefined ? { state: op.state } : {}),
          });
          changed.add(String(row.id));
        } else if (operation === "archive")
          changed.add(String(archiveInitiative(id).id));
        else if (operation === "unarchive")
          changed.add(String(unarchiveInitiative(id).id));
        else if (operation === "delete") {
          const canonical = deleteInitiative(id);
          changed.delete(canonical);
          absorbed.delete(canonical);
          removed.delete(canonical);
          deletedIds.push(canonical);
        } else if (MEMBER_OPERATIONS.has(operation ?? "")) {
          if (!taskIds?.length) throw new Error(`${named} requires taskIds.`);
          const canonical = record(
            operation === "addMembers"
              ? addInitiativeMembers(id, taskIds)
              : operation === "removeMembers"
                ? removeInitiativeMembers(id, taskIds)
                : setInitiativeMilestones(
                    id,
                    taskIds,
                    operation === "setMilestone",
                  ),
          );
          if (operation === "removeMembers") {
            const set = removed.get(canonical) ?? new Set<string>();
            for (const taskId of taskIds) {
              const n = Number(taskId);
              if (Number.isInteger(n) && n > 0) set.add(String(n));
            }
            removed.set(canonical, set);
          }
        } else throw new Error(`Unknown operation: ${named}`);
      }
      const entries = [...changed].flatMap((id) => {
        const detail = readInitiative(id);
        if (!detail) return [];
        const absorbedIds = absorbed.get(id) ?? [];
        // As of the END of the batch: a later operation may have removed the
        // ancestor that covered a Task an earlier one removed.
        const kept = initiativeMembershipNow(id, [...(removed.get(id) ?? [])]);
        return [
          {
            id: detail.id,
            title: detail.title,
            state: detail.state,
            ...(detail.archivedAt !== undefined ? { archived: true } : {}),
            progress: detail.progress,
            milestoneCount: detail.milestoneIds.length,
            ...cappedIds("absorbedTaskIds", absorbedIds),
            ...(kept.length
              ? {
                  stillMembers: kept.slice(0, MANAGE_TASK_IDS_MAX),
                  ...(kept.length > MANAGE_TASK_IDS_MAX
                    ? { stillMembersCount: kept.length }
                    : {}),
                }
              : {}),
          },
        ];
      });
      // At most twenty operations, but a title and the id lists are each
      // bounded only per entry: the whole answer is cut like a read.
      const kept = fitByBytes(
        entries,
        READ_BUDGET_BYTES - TRAILER_BYTES - jsonBytes(deletedIds),
      );
      return compactJsonResult({
        changedCount: changed.size + deletedIds.length,
        changed: kept,
        ...(kept.length < entries.length
          ? { omittedForBudget: entries.length - kept.length }
          : {}),
        ...(deletedIds.length ? { deletedIds } : {}),
      });
    },
  });
}

/** `{ [key]: ids }` capped, with the true count when the cap cut it. */
function cappedIds(key: string, ids: readonly string[]) {
  if (!ids.length) return {};
  return {
    [key]: ids.slice(0, MANAGE_TASK_IDS_MAX),
    ...(ids.length > MANAGE_TASK_IDS_MAX
      ? { [`${key}Count`]: ids.length }
      : {}),
  };
}

/** One member in the tool's tree: no description, open blockers by id. */
interface ToolMember {
  id: string;
  title: string;
  status: InitiativeGraphNode["status"];
  blocked?: true;
  projectId?: string;
  milestone?: true;
  archived?: true;
  /** On a page's top node only: where it hangs in the full tree. */
  parentId?: string;
  /** Open blockers (neither done nor archived), members or not; capped. */
  blockedBy?: string[];
  /** How many open blockers there are, when `blockedBy` was capped. */
  blockedByCount?: number;
  children?: ToolMember[];
  activity?: MemberActivity;
}

/** What `fitRecord` left out of a record or cut, named in the record. */
interface FitNote {
  omitted?: string[];
  clipped?: string[];
}

/**
 * The detail as a tree, from member `offset` of the depth-first order and cut
 * where the whole answer would pass the budget. The first page also carries
 * the Initiative's description and its capped milestone and outside-blocker
 * lists; a later page only its members. A node is charged before its
 * children, so the cut never leaves a child without the parent that places it.
 */
function detailForTool(
  detail: InitiativeDetail,
  offset: number,
  activity?: ReadonlyMap<string, MemberActivity>,
): Record<string, unknown> {
  const start = Math.max(0, Math.trunc(offset));
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

  const head: Record<string, unknown> = {
    id: detail.id,
    title: detail.title,
    state: detail.state,
    ...(detail.archivedAt !== undefined ? { archived: true } : {}),
    progress: detail.progress,
    totalMembers: detail.nodes.length,
    ...(activity ? { activityAsOf: new Date().toISOString() } : {}),
  };
  if (start === 0) {
    const description = clipSerialized(
      detail.description,
      DESCRIPTION_MAX_BYTES,
    );
    if (description) head.description = description;
    if (description.length < detail.description.length)
      head.descriptionTruncated = true;
    head.milestoneIds = detail.milestoneIds.slice(0, MILESTONE_IDS_MAX);
    if (detail.milestoneIds.length > MILESTONE_IDS_MAX)
      head.milestonesOmitted = detail.milestoneIds.length - MILESTONE_IDS_MAX;
    const blockers = fitByBytes(
      detail.externalBlockers.map((stub) =>
        fitRecord(
          stub,
          EXTERNAL_BLOCKER_MAX_BYTES,
          EXTERNAL_BLOCKER_DROP,
          EXTERNAL_BLOCKER_CLIP,
        ),
      ),
      EXTERNAL_BLOCKERS_MAX_BYTES,
    );
    head.externalBlockers = blockers;
    if (blockers.length < detail.externalBlockers.length)
      head.externalBlockersOmitted =
        detail.externalBlockers.length - blockers.length;
  } else head.offset = start;
  const fittedHead = fitRecord(head, HEAD_MAX_BYTES, HEAD_DROP, HEAD_CLIP);

  let remaining =
    READ_BUDGET_BYTES -
    jsonBytes({ ...fittedHead, members: [] }) -
    TRAILER_BYTES;
  const byId = new Map<string, ToolMember>();
  const roots: ToolMember[] = [];
  let next = start;
  for (; next < detail.nodes.length; next += 1) {
    const node = detail.nodes[next]!;
    const blockers = blockedBy.get(node.id) ?? [];
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const member = fitRecord<ToolMember>(
      {
        id: node.id,
        title: node.title,
        status: node.status,
        ...(activity?.has(node.id) ? { activity: activity.get(node.id)! } : {}),
        ...(node.blocked ? { blocked: true as const } : {}),
        ...(node.projectId ? { projectId: node.projectId } : {}),
        ...(node.milestone ? { milestone: true as const } : {}),
        ...(node.archived ? { archived: true as const } : {}),
        ...(!parent && node.parentId ? { parentId: node.parentId } : {}),
        ...(blockers.length
          ? { blockedBy: blockers.slice(0, BLOCKED_BY_MAX) }
          : {}),
        ...(blockers.length > BLOCKED_BY_MAX
          ? { blockedByCount: blockers.length }
          : {}),
      },
      NODE_MAX_BYTES,
      NODE_DROP,
      NODE_CLIP,
    );
    // A root's place costs a comma; a child's also its parent's `children`
    // key, charged for every child. The first node is always taken: the head
    // and node caps leave it room, and the check below holds the line.
    const cost = jsonBytes(member) + (parent ? CHILD_PLACE_BYTES : 1);
    if (cost > remaining && next > start) break;
    remaining -= cost;
    // Keyed by the node's own id, not a clipped one, so its children find it.
    byId.set(node.id, member);
    if (parent) (parent.children ??= []).push(member);
    else roots.push(member);
  }
  const answer = {
    ...fittedHead,
    members: roots,
    ...(next < detail.nodes.length
      ? { truncated: true, nextOffset: next }
      : {}),
  };
  // The postcondition itself, on the answer as serialized. A read writes
  // nothing, so refusing here loses no work.
  if (jsonBytes(answer) > READ_BUDGET_BYTES)
    throw new Error(
      `initiative_read: the answer at offset ${start} passed its budget.`,
    );
  return answer;
}

/**
 * `record` within `maxBytes` of serialized JSON, measured whole after every
 * step, metadata included. It drops the `drop` groups in order, each named by
 * its first key in `omitted`, then cuts the `clip` strings in order, each
 * ending in {@link CLIP_MARK} and named in `clipped`. A record that fits comes
 * back as it was.
 */
function fitRecord<T extends object>(
  record: T,
  maxBytes: number,
  drop: readonly (readonly string[])[],
  clip: readonly string[],
): T & FitNote {
  const fitted: T & FitNote = { ...record };
  const fields = fitted as Record<string, unknown>;
  for (const group of drop) {
    if (jsonBytes(fitted) <= maxBytes) return fitted;
    if (!group.some((key) => key in fields)) continue;
    for (const key of group) delete fields[key];
    (fitted.omitted ??= []).push(group[0]!);
  }
  const markBytes = jsonBytes(CLIP_MARK) - 2;
  for (const key of clip) {
    if (jsonBytes(fitted) <= maxBytes) return fitted;
    const value = fields[key];
    if (typeof value !== "string" || jsonBytes(value) - 2 <= markBytes)
      continue;
    (fitted.clipped ??= []).push(key);
    const over = jsonBytes(fitted) - maxBytes;
    const room = jsonBytes(value) - 2 - over - markBytes;
    fields[key] = clipSerialized(value, Math.max(0, room)) + CLIP_MARK;
  }
  if (jsonBytes(fitted) > maxBytes)
    throw new Error(`A ${maxBytes}-byte record cap cannot be met.`);
  return fitted;
}

/** A list read: entries in order until the budget, then a count of the rest. */
function listForTool(
  items: ReturnType<typeof listInitiatives>,
  maxResults: number,
): Record<string, unknown> {
  const entries = items.slice(0, maxResults).map((item) => ({
    id: item.id,
    title: item.title,
    state: item.state,
    ...(item.archivedAt !== undefined ? { archived: true } : {}),
    progress: item.progress,
  }));
  const kept = fitByBytes(entries, READ_BUDGET_BYTES - TRAILER_BYTES);
  return {
    count: kept.length,
    totalCount: items.length,
    truncated: items.length > kept.length,
    ...(kept.length < entries.length
      ? { omittedForBudget: entries.length - kept.length }
      : {}),
    items: kept,
  };
}

/** The longest prefix of `items` whose JSON array fits in `budget` bytes. */
function fitByBytes<T extends InitiativeExternalBlocker | object>(
  items: readonly T[],
  budget: number,
): T[] {
  let used = 2;
  const kept: T[] = [];
  for (const item of items) {
    const cost = jsonBytes(item) + 1;
    if (used + cost > budget) break;
    used += cost;
    kept.push(item);
  }
  return kept;
}

/**
 * The longest prefix of `text` whose JSON-SERIALIZED form, quotes aside, fits
 * in `maxBytes`: what the answer carries is the escaped text, and a control
 * character costs six bytes there for its one in the string.
 */
function clipSerialized(text: string, maxBytes: number): string {
  if (jsonBytes(text) - 2 <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = jsonBytes(char) - 2;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** A caller-supplied word an error repeats: short, never the input whole. */
function shortText(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
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
