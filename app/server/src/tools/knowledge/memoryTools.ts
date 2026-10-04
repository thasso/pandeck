/**
 * Agent-facing memory tools (Task 91): the idempotent `memory_search` /
 * `memory_manage` surface. Both route through the memory lifecycle service so
 * validation, optimistic concurrency, provenance, and content-dedup idempotency
 * are identical to automatic processing — model output proposes, deterministic
 * code applies. `clientId`/caller-supplied provenance/strength/state are NOT
 * exposed; provenance is derived from the trusted calling session.
 *
 * Automatic capture (Task 99) is the primary continuity path; these tools are the
 * explicit path for remember/correct/forget and targeted recall.
 */
import type {
  MemoryCard,
  MemoryKind,
  MemoryLifecycleState,
  MemoryScope,
  MemoryTemporal,
  AgentType,
} from "@assistant/shared";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import { userTimeZone } from "../../userProfile.ts";
import { memoryStore } from "../../db/memoryStore.ts";
import { projectStore } from "../../db/projectStore.ts";
import { resolveSessionProject } from "../../sessionProjectContext.ts";
import {
  archiveMemory,
  createMemory,
  editMemory,
  reinforceMemory,
  resolveSessionScope,
  restoreMemory,
  setMemoryPinned,
  supersedeMemory,
  withOperationIdempotency,
  type MemoryMutationResult,
  type MemoryScopeContext,
} from "../../memory/memoryService.ts";
import { searchMemory } from "../../memory/memorySelector.ts";

const KIND_ENUM = ["preference", "fact", "constraint", "working"];
const STATE_ENUM = ["active", "superseded", "archived"];

function sessionScope(ctx: ToolCallContext): MemoryScopeContext {
  const persona = (ctx.session.agentType as AgentType) ?? "assistant";
  // Shared resolver so a Task-derived project (not just a standalone
  // session→project link) scopes tool reads/writes (Task 94).
  const projectId = resolveSessionProject(ctx.session.sessionId);
  return resolveSessionScope({
    persona,
    ...(projectId !== undefined ? { projectId } : {}),
  });
}

/** Compact card projection for tool output (id + current revision always included). */
function projectCard(card: MemoryCard) {
  return {
    id: card.id,
    revision: card.revision,
    kind: card.kind,
    text: card.text,
    scope: card.scope,
    state: card.state,
    pinned: card.pinned,
    temporalMode: card.temporal.mode,
  };
}

/* ------------------------------ memory_search ---------------------------- */

type MemorySearchParams = {
  query: string;
  scope?: "current" | "all";
  kinds?: MemoryKind[];
  states?: MemoryLifecycleState[];
  includeTimeIneligible?: boolean;
  limit?: number;
};

const memorySearchTool = defineAgentTool<MemorySearchParams>({
  name: "memory_search",
  label: "Search memory",
  description:
    "Search your long-term memory for scoped preferences, facts, constraints, or working state. Hits carry each memory's stable id and current revision, which memory_manage needs.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Lexical overlap only — a paraphrase sharing few words with the memory is missed.",
      },
      scope: {
        type: "string",
        enum: ["current", "all"],
        default: "current",
        description: "'current' keeps to this session's persona/project.",
      },
      kinds: { type: "array", items: { type: "string", enum: KIND_ENUM } },
      states: {
        type: "array",
        items: { type: "string", enum: STATE_ENUM },
        default: ["active"],
      },
      includeTimeIneligible: {
        type: "boolean",
        description:
          "Also return active cards that are future, expired, or off-recurrence today.",
      },
      // No minimum/maximum: the selector CLAMPS to 1–50, so a schema bound
      // would turn a harmless over-ask into a hard validation failure.
      limit: { type: "number", default: 10 },
    },
  },
  async execute(params, ctx) {
    const states = (params.states ?? ["active"]) as MemoryLifecycleState[];
    const cards = memoryStore.list({ states, limit: 5_000 });
    const context = params.scope === "all" ? undefined : sessionScope(ctx);
    const timezone = userTimeZone();
    const hits = searchMemory(params.query ?? "", cards, {
      ...(context ? { context } : {}),
      states,
      ...(params.kinds ? { kinds: params.kinds } : {}),
      // Share the selector's eligibility by DEFAULT (exclude future/expired/
      // off-recurrence active cards); opt out with includeTimeIneligible.
      ...(params.includeTimeIneligible ? {} : { nowMs: Date.now(), timezone }),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return jsonResult({
      query: params.query,
      count: hits.length,
      results: hits,
    });
  },
});

/* ------------------------------ memory_manage ---------------------------- */

type ManageOp =
  | {
      op: "create";
      text: string;
      kind: MemoryKind;
      scope?: MemoryScope;
      temporal?: MemoryTemporal;
      pin?: boolean;
      reason?: string;
    }
  | { op: "reinforce"; id: string; expectedRevision: number; reason?: string }
  | {
      op: "correct";
      id: string;
      expectedRevision: number;
      text: string;
      kind?: MemoryKind;
      scope?: MemoryScope;
      temporal?: MemoryTemporal;
      reason?: string;
    }
  | {
      op: "edit";
      id: string;
      expectedRevision: number;
      text?: string;
      kind?: MemoryKind;
      scope?: MemoryScope;
      temporal?: MemoryTemporal;
      reason?: string;
    }
  | { op: "archive"; id: string; expectedRevision: number; reason?: string }
  | { op: "restore"; id: string; expectedRevision: number; reason?: string }
  | { op: "pin"; id: string; expectedRevision: number; reason?: string }
  | { op: "unpin"; id: string; expectedRevision: number; reason?: string };

type MemoryManageParams = {
  operations: ManageOp[];
};

const SCOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "Omit a field to match any project/persona.",
  properties: {
    projectId: { type: "string" },
    persona: {
      type: "string",
      enum: ["assistant", "personal-assistant", "developer", "workshop"],
    },
  },
};

const TEMPORAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["persistent", "window", "until-changed", "recurring"],
    },
    validFromMs: { type: "number", description: "Window start, epoch ms." },
    validUntilMs: { type: "number", description: "Window end, epoch ms." },
    timezone: { type: "string", description: "IANA, for window/recurrence." },
    recurrence: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "weekdays"],
      properties: {
        kind: { type: "string", enum: ["weekly"] },
        weekdays: {
          type: "array",
          items: { type: "number" },
          description: "0=Sun … 6=Sat.",
        },
      },
    },
  },
};

function resultToOutput(
  op: string,
  result: MemoryMutationResult,
): Record<string, unknown> {
  if (result.ok) return { op, ok: true, card: projectCard(result.card) };
  if (result.reason === "stale")
    return {
      op,
      ok: false,
      error: "stale-revision",
      current: projectCard(result.current),
    };
  if (result.reason === "invalid")
    return {
      op,
      ok: false,
      error: `invalid: ${result.error.field} — ${result.error.message}`,
    };
  return { op, ok: false, error: "not-found" };
}

const memoryManageTool = defineAgentTool<MemoryManageParams>({
  name: "memory_manage",
  label: "Manage memory",
  description:
    "Create, reinforce, correct, edit, archive, restore, or pin/unpin long-term memories in one batch. A correction supersedes the old memory and creates its replacement, which is how an outdated memory is fixed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["operations"],
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        description: "Applied in order.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op"],
          // Per-field prose is only for what a caller cannot infer and the
          // runtime cannot say afterwards: a missing or stale expectedRevision,
          // a wrong argument shape and an unknown project all come back as a
          // precise per-operation error (Task-285).
          properties: {
            op: {
              type: "string",
              enum: [
                "create",
                "reinforce",
                "correct",
                "edit",
                "archive",
                "restore",
                "pin",
                "unpin",
              ],
            },
            id: { type: "string" },
            expectedRevision: {
              type: "number",
              description:
                "The revision you observed in `[id@revision]`; every op on an existing memory needs it, and a stale one changes nothing.",
            },
            // Carried on an op that does not take them (reinforce, archive,
            // pin, …) these are IGNORED, not refused, so the applicability note
            // is the only thing standing between a caller and a write it
            // believes happened.
            text: {
              type: "string",
              description: "create/correct; optional on edit.",
            },
            kind: {
              type: "string",
              enum: KIND_ENUM,
              description: "create/correct; optional on edit.",
            },
            scope: SCOPE_SCHEMA,
            temporal: TEMPORAL_SCHEMA,
            // Read on create ONLY, next to a `pin` operation that does the same
            // thing later: without this line, `pin` on an edit is silently
            // ignored rather than refused.
            pin: { type: "boolean", description: "Pin on create." },
            reason: { type: "string", description: "Concise, one line." },
          },
        },
      },
    },
  },
  executionMode: "sequential",
  async execute(params, ctx) {
    const sessionId = ctx.session.sessionId;
    const provenance = { sourceKind: "agent" as const, sessionId };
    const outputs: Record<string, unknown>[] = [];
    let idx = -1;
    for (const op of params.operations ?? []) {
      idx += 1;
      // A trusted per-operation identity (tool call + batch index) so an exact
      // retry of this tool call is idempotent (no duplicate create / re-increment).
      const opKey = `tool:${sessionId}:${ctx.toolCallId}:${idx}`;
      // Every operation targeting an existing card requires `expectedRevision`
      // (Task 97) — reinforce included. Reject a missing one without mutating.
      if (op.op !== "create" && typeof op.expectedRevision !== "number") {
        outputs.push({
          op: op.op,
          ok: false,
          error:
            "expectedRevision is required for operations on an existing memory",
        });
        continue;
      }
      // Explicit scoped writes must reference a real project.
      if (
        (op.op === "create" || op.op === "correct" || op.op === "edit") &&
        op.scope?.projectId &&
        !projectStore.get(op.scope.projectId)
      ) {
        outputs.push({
          op: op.op,
          ok: false,
          error: `unknown project: ${op.scope.projectId}`,
        });
        continue;
      }
      switch (op.op) {
        case "create":
          outputs.push(
            resultToOutput(
              "create",
              withOperationIdempotency(opKey, () =>
                createMemory({
                  text: op.text,
                  kind: op.kind,
                  ...(op.scope !== undefined ? { scope: op.scope } : {}),
                  ...(op.temporal !== undefined
                    ? { temporal: op.temporal }
                    : {}),
                  ...(op.pin !== undefined ? { pinned: op.pin } : {}),
                  ...(op.reason !== undefined ? { reason: op.reason } : {}),
                  provenance,
                }),
              ),
            ),
          );
          break;
        case "reinforce":
          outputs.push(
            resultToOutput(
              "reinforce",
              withOperationIdempotency(opKey, () =>
                reinforceMemory(op.id, op.reason, op.expectedRevision),
              ),
            ),
          );
          break;
        case "correct":
          outputs.push(
            supersedeResultToOutput(
              supersedeMemory(
                op.id,
                op.expectedRevision,
                {
                  text: op.text,
                  // Omitted kind/scope/temporal inherit from the corrected card.
                  ...(op.kind !== undefined ? { kind: op.kind } : {}),
                  ...(op.scope !== undefined ? { scope: op.scope } : {}),
                  ...(op.temporal !== undefined
                    ? { temporal: op.temporal }
                    : {}),
                  ...(op.reason !== undefined ? { reason: op.reason } : {}),
                  provenance,
                },
                opKey,
              ),
            ),
          );
          break;
        case "edit":
          outputs.push(
            resultToOutput(
              "edit",
              withOperationIdempotency(opKey, () =>
                editMemory(op.id, op.expectedRevision, {
                  ...(op.text !== undefined ? { text: op.text } : {}),
                  ...(op.kind !== undefined ? { kind: op.kind } : {}),
                  ...(op.scope !== undefined ? { scope: op.scope } : {}),
                  ...(op.temporal !== undefined
                    ? { temporal: op.temporal }
                    : {}),
                  ...(op.reason !== undefined ? { reason: op.reason } : {}),
                }),
              ),
            ),
          );
          break;
        case "archive":
          outputs.push(
            resultToOutput(
              "archive",
              withOperationIdempotency(opKey, () =>
                archiveMemory(op.id, op.expectedRevision, op.reason),
              ),
            ),
          );
          break;
        case "restore":
          outputs.push(
            resultToOutput(
              "restore",
              withOperationIdempotency(opKey, () =>
                restoreMemory(op.id, op.expectedRevision, op.reason),
              ),
            ),
          );
          break;
        case "pin":
          outputs.push(
            resultToOutput(
              "pin",
              withOperationIdempotency(opKey, () =>
                setMemoryPinned(op.id, op.expectedRevision, true, op.reason),
              ),
            ),
          );
          break;
        case "unpin":
          outputs.push(
            resultToOutput(
              "unpin",
              withOperationIdempotency(opKey, () =>
                setMemoryPinned(op.id, op.expectedRevision, false, op.reason),
              ),
            ),
          );
          break;
        default:
          outputs.push({
            op: (op as { op: string }).op,
            ok: false,
            error: "unknown-operation",
          });
      }
    }
    return jsonResult({ count: outputs.length, results: outputs });
  },
});

function supersedeResultToOutput(
  result: ReturnType<typeof supersedeMemory>,
): Record<string, unknown> {
  if (result.ok)
    return {
      op: "correct",
      ok: true,
      superseded: result.old.id,
      card: projectCard(result.replacement),
    };
  if (result.reason === "stale")
    return {
      op: "correct",
      ok: false,
      error: "stale-revision",
      current: projectCard(result.current),
    };
  if (result.reason === "invalid")
    return {
      op: "correct",
      ok: false,
      error: `invalid: ${result.error.field} — ${result.error.message}`,
    };
  return { op: "correct", ok: false, error: "not-found" };
}

/** The memory tools shared by every persona. */
export const memoryTools: AgentTool[] = [memorySearchTool, memoryManageTool];
