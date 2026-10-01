/**
 * `session_audit`: the agent-facing surface of the Task-254 session usage and
 * context-contributor report (`sessionAudit.ts`), beside `session_read`.
 *
 * The analysis is shared with `pnpm run measure:session`; this module owns only
 * the bounded PROJECTION: sections are opt-in, per-turn rows are capped, and no
 * message body ever leaves — the largest tool results are reported as sizes,
 * and the drill-down as block structure.
 * `session_read`/`session_search` remain the only way to content.
 */
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import {
  auditSession,
  type AuditToolInventory,
  type SessionAuditReport,
  type TurnRow,
} from "../../sessionAudit.ts";
import { resolveAuditSource } from "../../sessionAuditSources.ts";
import { cleanSessionId, SessionInspectionError } from "./sessionInspection.ts";

/** Aggregate hard cap on the serialized `content[0].text` of a response. */
export const SESSION_AUDIT_MAX_CHARS = 20_000;

const DEFAULT_TURNS = 12;
const MAX_TURNS = 60;
const DEFAULT_TOP = 5;
const MAX_TOP = 20;

/** The optional sections, all off by default except `summary`. */
const SECTIONS = [
  "turns",
  "contributors",
  "tools",
  "toolResults",
  "contextJumps",
  "events",
] as const;

type Section = (typeof SECTIONS)[number];

type AuditParams = {
  sessionId?: string;
  sections?: string[];
  maxTurns?: number;
  top?: number;
  entryId?: string;
  providerRun?: number;
};

/**
 * `inventory` is handed in by `tools/catalog.ts`, which registers this tool:
 * the audit measures a session against the persona's catalog tools, and the
 * catalog composes every tool module — so reading it from here would close a
 * cycle (`docs/linting.md`, the cycle gates).
 */
export function sessionAuditTools(inventory: AuditToolInventory): AgentTool[] {
  return [makeSessionAuditTool(inventory)];
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(Math.max(n, min), max);
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: {
      type: "string",
      description:
        "Copied app session id to audit (works for pi and Claude sessions).",
    },
    sections: {
      type: "array",
      items: { type: "string", enum: [...SECTIONS] },
      description:
        "Optional sections to add to the summary: 'turns' (per-turn tokens, cost and context delta), 'contributors' (what the context is made of), 'tools' (definitions loaded, used, never used), 'toolResults' (the largest individual results, as sizes), 'contextJumps' (the biggest per-request context increases), 'events' (compactions, tool activations, failures). Ask for what the question needs; every section costs output.",
    },
    maxTurns: {
      type: "number",
      description: `Turn rows to return, most recent kept. Defaults to ${DEFAULT_TURNS}; clamped 1–${MAX_TURNS}.`,
    },
    top: {
      type: "number",
      description: `Rows per ranked section (tool results, context jumps, tools). Defaults to ${DEFAULT_TOP}; clamped 1–${MAX_TOP}.`,
    },
    entryId: {
      type: "string",
      description:
        "Drill down on one transcript entry id (from session_read/session_search): its block structure and sizes. Never returns the text.",
    },
    providerRun: {
      type: "number",
      description:
        "Drill down on one 1-based provider request: its usage and tool calls. Only available for sessions with a per-request transcript.",
    },
  },
} as const;

function makeSessionAuditTool(inventory: AuditToolInventory) {
  return defineAgentTool<AuditParams>({
    name: "session_audit",
    label: "Audit Session Usage",
    description:
      "Explain what a session spent and what its context is made of: provider calls, per-turn tokens and cost, processed input against context-window occupancy, contributor categories, the largest tool results, the biggest context jumps, and the tool definitions it loaded but never used. Reads only stored data (no shell, no external CLI). Returns sizes and counts, never message bodies — use session_read for content. Token figures are provider-reported; character-derived figures are named estTokens and are estimates.",
    searchHint:
      "session token usage cost context window audit report turns provider calls tool result size context contributors measure",
    parameters: schema,
    async execute(params, _ctx) {
      let sessionId: string;
      try {
        sessionId = cleanSessionId(params.sessionId);
      } catch (err) {
        if (err instanceof SessionInspectionError) throw new Error(err.message);
        throw err;
      }
      const requested = new Set<Section>(
        (Array.isArray(params.sections) ? params.sections : []).filter(
          (value): value is Section => SECTIONS.includes(value as Section),
        ),
      );
      const maxTurns = clamp(params.maxTurns, DEFAULT_TURNS, 1, MAX_TURNS);
      const top = clamp(params.top, DEFAULT_TOP, 1, MAX_TOP);
      const entryId =
        typeof params.entryId === "string" && params.entryId.trim()
          ? params.entryId.trim()
          : undefined;
      const providerRun =
        typeof params.providerRun === "number" &&
        Number.isFinite(params.providerRun)
          ? Math.max(1, Math.floor(params.providerRun))
          : undefined;

      let report: SessionAuditReport;
      try {
        report = auditSession(resolveAuditSource(sessionId), {
          inventory,
          maxTurns,
          topToolResults: top,
          topContextJumps: top,
          topTools: top,
          ...(entryId !== undefined || providerRun !== undefined
            ? {
                drilldown: {
                  ...(entryId !== undefined ? { entryId } : {}),
                  ...(providerRun !== undefined ? { providerRun } : {}),
                },
              }
            : {}),
        });
      } catch (err) {
        if (err instanceof SessionInspectionError) throw new Error(err.message);
        throw err;
      }

      const payload = project(report, requested);
      const text = fit(payload);
      return { content: [{ type: "text", text }], details: payload };
    },
  });
}

/** One compact turn row — the wide report row without its redundant halves. */
function turnProjection(turn: TurnRow): Record<string, unknown> {
  return {
    turn: turn.index,
    ...(turn.origin ? { origin: turn.origin } : {}),
    ...(turn.hiddenPrompt ? { hiddenPrompt: true } : {}),
    ...(turn.providerCalls !== undefined
      ? { providerCalls: turn.providerCalls }
      : {}),
    toolCalls: turn.toolCalls,
    processedInputTokens: turn.usage.processedInputTokens,
    uncachedInputTokens: turn.usage.uncachedInputTokens,
    cacheReadTokens: turn.usage.cacheReadTokens,
    cacheWriteTokens: turn.usage.cacheWriteTokens,
    outputTokens: turn.usage.outputTokens,
    costUSD: round(turn.usage.costUSD),
    ...(turn.contextAfter !== undefined
      ? { contextAfter: turn.contextAfter }
      : {}),
    ...(turn.contextDelta !== undefined
      ? { contextDelta: turn.contextDelta }
      : {}),
    toolResultBytes: turn.toolResultBytes,
    ...(turn.toolsActivated.length > 0
      ? { toolsActivated: turn.toolsActivated }
      : {}),
    ...(turn.failedToolResults > 0
      ? { failedToolResults: turn.failedToolResults }
      : {}),
    ...(turn.compacted ? { compacted: true } : {}),
    ...(turn.failure ? { failure: turn.failure.slice(0, 120) } : {}),
  };
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

function project(
  report: SessionAuditReport,
  sections: ReadonlySet<Section>,
): Record<string, unknown> {
  const t = report.totals;
  const payload: Record<string, unknown> = {
    sessionId: report.session.sessionId,
    title: report.session.title,
    harness: report.session.harness,
    persona: report.session.persona,
    ...(report.session.model ? { model: report.session.model } : {}),
    createdAt: report.session.createdAt,
    ...(report.session.attachedTaskId
      ? { attachedTaskId: report.session.attachedTaskId }
      : {}),
    totals: {
      turns: t.turns,
      assistantRuns: t.assistantRuns,
      ...(t.providerCalls !== undefined
        ? { providerCalls: t.providerCalls }
        : {}),
      ...(t.providerCallsUnattributed
        ? { providerCallsUnattributed: t.providerCallsUnattributed }
        : {}),
      toolCalls: t.toolCalls,
      toolResults: t.toolResults,
      failedToolResults: t.failedToolResults,
      failedRuns: t.failedRuns,
      compactions: t.compactions,
      processedInputTokens: t.processedInputTokens,
      uncachedInputTokens: t.uncachedInputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      outputTokens: t.outputTokens,
      ...(t.reasoningTokens !== undefined
        ? { reasoningTokens: t.reasoningTokens }
        : {}),
      costUSD: round(t.costUSD),
      latestContext: t.latestContext,
      elapsedMs: t.elapsedMs,
      ...(t.generationMs !== undefined ? { generationMs: t.generationMs } : {}),
      transcriptBytes: t.transcriptBytes,
      toolResultBytes: t.toolResultBytes,
    },
    ...(report.providerCallTotals
      ? {
          providerCallTotals: {
            ...report.providerCallTotals,
            costUSD: round(report.providerCallTotals.costUSD),
          },
        }
      : {}),
    ...(report.persisted
      ? {
          persistedStats: {
            agrees: report.persisted.agrees,
            comparedFields: report.persisted.comparedFields,
            ...(report.persisted.costAccumulation
              ? { costAccumulation: report.persisted.costAccumulation }
              : {}),
            ...(report.persisted.agrees
              ? {}
              : { differences: report.persisted.differences }),
          },
        }
      : {}),
    contextNote:
      "processedInputTokens is billed input summed over every request; latestContext is one prompt-side occupancy snapshot. Never add them.",
  };

  if (sections.has("contributors")) {
    payload.contributors = report.contributors.map((row) => ({
      category: row.category,
      estTokens: row.estTokens,
      share: row.share,
      items: row.items,
      basis: row.basis,
    }));
    payload.calibration = report.calibration;
  }
  if (sections.has("turns")) {
    payload.turns = report.turns.map(turnProjection);
    payload.turnsOmitted = report.bounds.turnsOmitted;
  }
  if (sections.has("toolResults"))
    payload.largestToolResults = report.largestToolResults;
  if (sections.has("contextJumps")) payload.contextJumps = report.contextJumps;
  if (sections.has("tools")) {
    payload.tools = {
      eagerCount: report.tools.eagerCount,
      eagerDefEstTokens: report.tools.eagerDefEstTokens,
      activatedCount: report.tools.activatedCount,
      unusedCount: report.tools.unusedCount,
      unusedDefEstTokens: report.tools.unusedDefEstTokens,
      callsNotInThisCatalog: report.tools.callsNotInThisCatalog,
      rows: report.tools.rows.map((row) => ({
        name: row.name,
        loading: row.loading,
        loaded: row.loaded,
        calls: row.calls,
        defEstTokens: row.defEstTokens,
        ...(row.activatedInTurn !== undefined
          ? { activatedInTurn: row.activatedInTurn }
          : {}),
      })),
    };
  }
  if (sections.has("events")) payload.events = report.events;
  if (report.drilldown) payload.drilldown = report.drilldown;
  if (report.unavailable.length > 0) payload.unavailable = report.unavailable;
  if (report.warnings.length > 0) payload.warnings = report.warnings;
  payload.availableSections = SECTIONS.filter(
    (section) => !sections.has(section),
  );
  return payload;
}

/**
 * Serialize under {@link SESSION_AUDIT_MAX_CHARS}, shedding the bounded list
 * sections from their cheap end — events first, then the oldest turns, then the
 * ranked tails — before ever touching the summary. What was shed is stated in
 * the payload's `responseTruncated`.
 */
function fit(payload: Record<string, unknown>): string {
  const shed: string[] = [];
  let text = JSON.stringify(payload, null, 2);
  let guard = 0;
  while (text.length > SESSION_AUDIT_MAX_CHARS && guard++ < 1000) {
    const turns = payload.turns as unknown[] | undefined;
    const events = payload.events as unknown[] | undefined;
    const jumps = payload.contextJumps as unknown[] | undefined;
    const results = payload.largestToolResults as unknown[] | undefined;
    const tools = payload.tools as { rows?: unknown[] } | undefined;
    if (events && events.length > 0) {
      events.splice(0, Math.max(1, Math.ceil(events.length / 4)));
      if (events.length === 0) delete payload.events;
      note(shed, "events");
    } else if (turns && turns.length > 1) {
      turns.splice(0, 1);
      payload.turnsOmitted = Number(payload.turnsOmitted ?? 0) + 1;
      note(shed, "turns");
    } else if (tools?.rows && tools.rows.length > 1) {
      tools.rows.pop();
      note(shed, "tools");
    } else if (jumps && jumps.length > 1) {
      jumps.pop();
      note(shed, "contextJumps");
    } else if (results && results.length > 1) {
      results.pop();
      note(shed, "largestToolResults");
    } else break;
    payload.responseTruncated = shed.join(", ");
    text = JSON.stringify(payload, null, 2);
  }
  return text;
}

function note(shed: string[], section: string): void {
  if (!shed.includes(section)) shed.push(section);
}
