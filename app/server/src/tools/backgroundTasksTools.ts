/**
 * The owner-facing background work catalog. This is deliberately a single,
 * provider-neutral tool: PA task ids are the only address exposed to a model,
 * while the supervisor remains the only authority that can Stop work.
 */
import {
  backgroundWorkBackendsForHarness,
  type BackgroundWorkBackend,
  type BackgroundWorkIntent,
  type Harness,
} from "@assistant/shared";
import { backgroundWorkItemSummaryOf } from "../backgroundWorkRegistry.ts";
import { backgroundWorkOwnerEligibility } from "../backgroundWork/policy.ts";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";
import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";
import { defineAgentTool, jsonResult, type AgentTool } from "../mcp/tool.ts";
import { sessionArtifactFile } from "../mcp/toolGroups/packRuntime.ts";

const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 20;
const MAX_CURSOR_CHARS = 256;
const MAX_ID_CHARS = 200;
const MAX_REASON_CHARS = 500;
type BackgroundTasksParams =
  | {
      operation: "list";
      state?: "active" | "terminal" | "all";
      cursor?: string;
      limit?: number;
    }
  | { operation: "status"; taskId: string }
  | { operation: "stop"; taskId: string; reason?: string }
  | { operation: "stop_all"; reason?: string }
  | { operation: "set_intent"; taskId: string; intent: BackgroundWorkIntent };

type ListCursor = {
  operation: "list";
  state: "active" | "terminal" | "all";
  after: { active: boolean; createdAt: number; id: string };
};

const listStateSchema = {
  type: "string",
  enum: ["active", "terminal", "all"],
  description: "Which owned work to show; defaults to active.",
};
const taskIdSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_ID_CHARS,
  description: "The PA background task id returned by this tool.",
};
const reasonSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_REASON_CHARS,
  description: "A bounded human reason for the Stop request.",
};

const operationSchema = {
  type: "string",
  enum: ["list", "status", "stop", "stop_all", "set_intent"],
  description: "The catalog operation to perform.",
};
const intentSchema = {
  type: "string",
  enum: ["awaited", "service"],
  description:
    "For set_intent: service for work nobody waits on (dev server, watcher); awaited (the default) for work whose end you wait for.",
};
const backgroundTasksSchema = {
  type: "object",
  additionalProperties: false,
  required: ["operation"],
  properties: {
    operation: operationSchema,
    state: listStateSchema,
    cursor: {
      type: "string",
      minLength: 1,
      maxLength: MAX_CURSOR_CHARS,
      description:
        'An opaque cursor returned by a previous list operation. Paging never loses a row; under state "all" one whose state changes mid-traversal may be listed twice.',
    },
    limit: {
      type: "number",
      minimum: 1,
      maximum: MAX_LIST_LIMIT,
      description:
        "Number of rows to return; defaults to 10 and is capped at 20.",
    },
    taskId: taskIdSchema,
    reason: reasonSchema,
    intent: intentSchema,
  },
} as const;

/** The backend a tool admits under: the harness's first (today its only) one. */
function backendForHarness(harness: Harness): BackgroundWorkBackend {
  const [backend] = backgroundWorkBackendsForHarness(harness);
  if (!backend) throw new Error(`No background-work backend for ${harness}.`);
  return backend;
}

function requireString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} is required.`);
  const result = value.trim();
  if (!result) throw new Error(`${name} is required.`);
  if (result.length > max) throw new Error(`${name} is too long.`);
  return result;
}

function listLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error("limit must be an integer from 1 through 20.");
  if (value < 1 || value > MAX_LIST_LIMIT)
    throw new Error("limit must be an integer from 1 through 20.");
  return value;
}

function parseListCursor(
  value: unknown,
  state: ListCursor["state"],
): ListCursor["after"] | undefined {
  if (value === undefined) return undefined;
  const raw = requireString(value, "cursor", MAX_CURSOR_CHARS);
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ListCursor>;
    const after = decoded.after;
    if (
      decoded.operation !== "list" ||
      decoded.state !== state ||
      !after ||
      typeof after !== "object" ||
      !Number.isSafeInteger(after.createdAt) ||
      after.createdAt < 0 ||
      typeof after.id !== "string" ||
      after.id.length === 0 ||
      after.id.length > MAX_ID_CHARS ||
      typeof after.active !== "boolean"
    )
      throw new Error("invalid");
    return after;
  } catch {
    throw new Error("cursor is invalid.");
  }
}

function encodeListCursor(
  state: ListCursor["state"],
  after: ListCursor["after"],
): string {
  return Buffer.from(
    JSON.stringify({ operation: "list", state, after }),
  ).toString("base64url");
}

function humanLink(taskId: string): string {
  return `/background-tasks?task=${encodeURIComponent(taskId)}`;
}

function displayItem(
  item: ReturnType<typeof backgroundWorkStore.getItem>,
  now: number,
) {
  if (!item) return undefined;
  const summary = backgroundWorkItemSummaryOf(item);
  const start = item.startedAt ?? item.createdAt;
  const output = item.evidence?.artifactId
    ? sessionArtifactFile(item.ownerSessionId, item.evidence.artifactId)
    : undefined;
  return {
    ...summary,
    taskId: item.id,
    ...(output ? { outputFile: output.path } : {}),
    elapsedMs: Math.max(0, (item.terminalAt ?? now) - start),
    ...(item.terminalAt === undefined
      ? { remainingMs: Math.max(0, item.deadlineAt - now) }
      : {}),
    humanLink: humanLink(item.id),
  };
}

function ownerBackend(
  ctx: Parameters<AgentTool["execute"]>[1],
): BackgroundWorkBackend {
  return backendForHarness(ctx.session.harness);
}

function assertOwner(
  ctx: Parameters<AgentTool["execute"]>[1],
): BackgroundWorkBackend {
  const backend = ownerBackend(ctx);
  const eligibility = backgroundWorkOwnerEligibility(
    ctx.session.sessionId,
    backend,
  );
  if (!eligibility.eligible)
    throw new Error("Background tasks are not available to this session.");
  return backend;
}

function assertOperationFields(
  params: BackgroundTasksParams,
  operation: string | undefined,
): void {
  const allowed =
    operation === "list"
      ? new Set(["operation", "state", "cursor", "limit"])
      : operation === "status"
        ? new Set(["operation", "taskId"])
        : operation === "stop"
          ? new Set(["operation", "taskId", "reason"])
          : operation === "stop_all"
            ? new Set(["operation", "reason"])
            : operation === "set_intent"
              ? new Set(["operation", "taskId", "intent"])
              : undefined;
  if (!allowed)
    throw new Error(
      "operation must be one of list, status, stop, stop_all, or set_intent.",
    );
  for (const key of Object.keys(params))
    if (!allowed.has(key)) throw new Error(`${key} is not accepted here.`);
}

function ownedItemOrThrow(
  taskId: string,
  ownerSessionId: string,
  backend: BackgroundWorkBackend,
) {
  const item = backgroundWorkStore.getItem(taskId);
  if (
    !item ||
    item.ownerSessionId !== ownerSessionId ||
    item.backend !== backend
  )
    throw new Error("Background task not found or not owned by this session.");
  return item;
}

const backgroundTasksTool = defineAgentTool<BackgroundTasksParams>({
  name: "background_tasks",
  label: "Background Tasks",
  description:
    "Inspect, Stop or classify background work owned by this interactive session. Completion is delivered automatically; use list and status for recovery and inspection, not polling. Retained output is returned as outputFile. Address work only by the PA task id returned here. Stop is available in both Build and Plan. set_intent service marks work nobody waits on (dev server, watcher) so it never reads as work in progress. No wait, tail, stream, subscribe, or raw-output operation is provided.",
  parameters: backgroundTasksSchema,
  executionMode: "sequential",
  async execute(params, ctx) {
    const backend = assertOwner(ctx);
    const operation = params?.operation;
    assertOperationFields(params, operation);
    if (operation === "list") {
      const state = params.state ?? "active";
      if (state !== "active" && state !== "terminal" && state !== "all")
        throw new Error("state must be active, terminal, or all.");
      const limit = listLimit(params.limit);
      const cursor = parseListCursor(params.cursor, state);
      const rows = backgroundWorkStore.listItems({
        ownerSessionId: ctx.session.sessionId,
        state,
        limit: limit + 1,
        ...(cursor ? { after: cursor } : {}),
      });
      const hasNext = rows.length > limit;
      const page = rows.slice(0, limit);
      const items = page.map((item) => displayItem(item, Date.now()));
      return jsonResult({
        operation,
        state,
        items,
        ...(hasNext && page.length > 0
          ? {
              nextCursor: encodeListCursor(state, {
                active:
                  page.at(-1)!.state === "pending-launch" ||
                  page.at(-1)!.state === "running",
                createdAt: page.at(-1)!.createdAt,
                id: page.at(-1)!.id,
              }),
            }
          : {}),
      });
    }

    if (operation === "status") {
      const taskId = requireString(params.taskId, "taskId", MAX_ID_CHARS);
      const item = ownedItemOrThrow(taskId, ctx.session.sessionId, backend);
      return jsonResult({
        operation,
        taskId,
        item: displayItem(item, Date.now()),
        humanLink: humanLink(taskId),
      });
    }

    if (operation === "stop") {
      const taskId = requireString(params.taskId, "taskId", MAX_ID_CHARS);
      const item = ownedItemOrThrow(taskId, ctx.session.sessionId, backend);
      const reason =
        params.reason === undefined
          ? "Stop requested by the owner"
          : requireString(params.reason, "reason", MAX_REASON_CHARS);
      const result = await backgroundWorkSupervisor.stopOne({
        itemId: item.id,
        ownerSessionId: ctx.session.sessionId,
        sourceRequestId: ctx.toolCallId,
        reason,
      });
      if (result.state === "not-owner")
        throw new Error(
          "Background task not found or not owned by this session.",
        );
      const current = displayItem(result.item, Date.now());
      return jsonResult({
        operation,
        taskId,
        result: result.state,
        item: current,
        humanLink: humanLink(taskId),
      });
    }

    if (operation === "stop_all") {
      const reason =
        params.reason === undefined
          ? "Stop-all requested by the owner"
          : requireString(params.reason, "reason", MAX_REASON_CHARS);
      const results = await backgroundWorkSupervisor.stopAllOwner({
        ownerSessionId: ctx.session.sessionId,
        callerSessionId: ctx.session.sessionId,
        sourceRequestId: ctx.toolCallId,
        reason,
      });
      return jsonResult({
        operation,
        result: "accepted; finish your turn",
        items: results.flatMap((result) =>
          result.item
            ? [
                {
                  result: result.state,
                  item: displayItem(result.item, Date.now()),
                  humanLink: humanLink(result.item.id),
                },
              ]
            : [],
        ),
      });
    }

    if (operation === "set_intent") {
      const taskId = requireString(params.taskId, "taskId", MAX_ID_CHARS);
      if (params.intent !== "awaited" && params.intent !== "service")
        throw new Error("intent must be awaited or service.");
      const item = ownedItemOrThrow(taskId, ctx.session.sessionId, backend);
      if (item.terminalAt !== undefined)
        throw new Error("Background task has already finished.");
      const updated = backgroundWorkStore.setIntent({
        itemId: item.id,
        ownerSessionId: ctx.session.sessionId,
        intent: params.intent,
      });
      return jsonResult({
        operation,
        taskId,
        item: displayItem(updated, Date.now()),
        humanLink: humanLink(taskId),
      });
    }

    throw new Error(
      "operation must be one of list, status, stop, stop_all, or set_intent.",
    );
  },
});

export function backgroundTasksTools(): AgentTool[] {
  return [backgroundTasksTool];
}

export { backgroundTasksTool };
