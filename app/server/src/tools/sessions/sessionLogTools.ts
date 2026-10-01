import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import {
  buildReadResponse,
  buildSearchResponse,
  cleanSessionId,
  clampNumber,
  excerpt,
  includeOptions,
  readSessionWindow,
  resolveInspectableSession,
  searchSessionLog,
  SEARCH_EXCERPT_CHARS,
  sessionMetaProjection,
  SessionInspectionError,
  type ReadRecordOut,
  type SearchResultOut,
  type SessionRecord,
  type WindowResult,
} from "./sessionInspection.ts";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_EDGE_LIMIT = 8;
const DEFAULT_CENTERED_LIMIT = 5;
const MAX_READ_LIMIT = 25;
/** Bound caller-controlled metadata explicitly (rejected, never silently clipped) so it can never blow the aggregate response cap. */
const MAX_QUERY_CHARS = 512;
const MAX_AT_CHARS = 256;

type SessionSearchParams = {
  sessionId?: string;
  query?: string;
  maxResults?: number;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
};

type SessionReadParams = {
  sessionId?: string;
  at?: string;
  limit?: number;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeToolResults?: boolean;
};

export function sessionLogTools(): AgentTool[] {
  return [makeSessionReadTool(), makeSessionSearchTool()];
}

/* -------------------------------- read ----------------------------------- */

const sessionReadSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId"],
  properties: {
    sessionId: {
      type: "string",
      description:
        "Copied app session id to read (works for pi and Claude sessions).",
    },
    at: {
      type: "string",
      description: `Anchor: 'latest' (default), 'start', or a stable entry id from session_search/session_read navigation hints. Max ${MAX_AT_CHARS} characters.`,
    },
    limit: {
      type: "number",
      description:
        "Total records to return. Default 8 for edge reads, 5 for entry-centered reads; max 25.",
    },
    includeThinking: {
      type: "boolean",
      description: "Include assistant thinking blocks. Defaults to false.",
    },
    includeToolCalls: {
      type: "boolean",
      description: "Include tool call names/arguments. Defaults to false.",
    },
    includeToolResults: {
      type: "boolean",
      description: "Include tool result text. Defaults to false.",
    },
  },
} as const;

function makeSessionReadTool() {
  return defineAgentTool<SessionReadParams>({
    name: "session_read",
    label: "Read Session Log",
    description:
      "Read a bounded window of another app session's transcript directly from a copied session id.",
    parameters: sessionReadSchema,
    async execute(params, _ctx) {
      let sessionId: string;
      try {
        sessionId = cleanSessionId(params.sessionId);
      } catch (err) {
        if (err instanceof SessionInspectionError) throw new Error(err.message);
        throw err;
      }
      const at = normalizeAt(params.at);
      if (at.length > MAX_AT_CHARS)
        throw new Error(
          `at must be at most ${MAX_AT_CHARS} characters (received ${at.length}).`,
        );
      const isEntryAnchor = at !== "latest" && at !== "start";
      const resolved = resolveSafe(sessionId);
      const include = includeOptions(params);
      const metadata = await sessionMetaProjection(resolved);
      const limit = clampNumber(
        params.limit,
        isEntryAnchor ? DEFAULT_CENTERED_LIMIT : DEFAULT_EDGE_LIMIT,
        1,
        MAX_READ_LIMIT,
      );
      const warnings = resolved.warning ? [resolved.warning] : [];

      let window: WindowResult = {
        records: [],
        anchorFound: true,
        hasMoreBefore: false,
        hasMoreAfter: false,
        malformedCount: 0,
      };
      let anchorEntryId: string | undefined;
      if (resolved.logAvailability === "available") {
        if (isEntryAnchor) {
          const anchorScan = readSessionWindow(
            resolved.logPath,
            at,
            limit,
            include,
          );
          if (anchorScan.malformedCount > 0)
            warnings.push(
              `Skipped ${anchorScan.malformedCount} malformed log line(s).`,
            );
          if (anchorScan.anchorFound) {
            window = anchorScan;
            anchorEntryId = at;
          } else {
            warnings.push(
              `Entry id "${at}" was not found in this log; returning the latest records instead.`,
            );
            window = readSessionWindow(
              resolved.logPath,
              "latest",
              limit,
              include,
            );
          }
        } else {
          window = readSessionWindow(resolved.logPath, at, limit, include);
          if (window.malformedCount > 0)
            warnings.push(
              `Skipped ${window.malformedCount} malformed log line(s).`,
            );
        }
      }

      const records: ReadRecordOut[] = window.records.map((r) =>
        toReadRecord(r, anchorEntryId),
      );
      const { text, details } = buildReadResponse({
        metadata: {
          ...metadata,
          at,
          requestedLimit: limit,
          include,
        },
        records,
        ...(anchorEntryId !== undefined ? { anchorEntryId } : {}),
        hasMoreBefore: window.hasMoreBefore,
        hasMoreAfter: window.hasMoreAfter,
        ...(window.previousEntryId !== undefined
          ? { previousEntryId: window.previousEntryId }
          : {}),
        ...(window.nextEntryId !== undefined
          ? { nextEntryId: window.nextEntryId }
          : {}),
        warnings,
        guidance:
          "Use a previousEntryId/nextEntryId as the next 'at' to page, or session_search to find a specific record.",
      });
      return { content: [{ type: "text", text }], details };
    },
  });
}

function toReadRecord(
  r: SessionRecord,
  anchorEntryId: string | undefined,
): ReadRecordOut {
  return {
    entryId: r.entryId,
    role: r.role,
    blockKind: r.blockKind,
    ...(r.timestamp ? { timestamp: r.timestamp } : {}),
    text: r.text,
    textTruncated: false,
    ...(anchorEntryId != null && r.entryId === anchorEntryId
      ? { anchor: true }
      : {}),
  };
}

function normalizeAt(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "latest";
  return text;
}

/* ------------------------------- search ---------------------------------- */

const sessionSearchSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sessionId", "query"],
  properties: {
    sessionId: {
      type: "string",
      description:
        "Copied app session id to search (works for pi and Claude sessions).",
    },
    query: {
      type: "string",
      description: `Case-insensitive literal substring to search for. Max ${MAX_QUERY_CHARS} characters.`,
    },
    maxResults: {
      type: "number",
      description: "Maximum matches to return. Defaults to 10; clamped 1–50.",
    },
    includeThinking: {
      type: "boolean",
      description: "Also search assistant thinking blocks. Defaults to false.",
    },
    includeToolCalls: {
      type: "boolean",
      description: "Also search tool call names/arguments. Defaults to false.",
    },
    includeToolResults: {
      type: "boolean",
      description: "Also search tool result text. Defaults to false.",
    },
  },
} as const;

function makeSessionSearchTool() {
  return defineAgentTool<SessionSearchParams>({
    name: "session_search",
    label: "Search Session Log",
    description:
      "Search one known app session's transcript by copied session id, returning bounded excerpts. This is not a pagination API: when the result is truncated, narrow the query rather than paging through it.",
    parameters: sessionSearchSchema,
    async execute(params, _ctx) {
      let sessionId: string;
      let query: string;
      try {
        sessionId = cleanSessionId(params.sessionId);
        query = cleanRequired(params.query, "query");
      } catch (err) {
        if (err instanceof SessionInspectionError) throw new Error(err.message);
        throw err;
      }
      if (query.length > MAX_QUERY_CHARS)
        throw new Error(
          `query must be at most ${MAX_QUERY_CHARS} characters (received ${query.length}).`,
        );
      const include = includeOptions(params);
      const maxResults = clampNumber(
        params.maxResults,
        DEFAULT_SEARCH_LIMIT,
        1,
        MAX_SEARCH_LIMIT,
      );
      const resolved = resolveSafe(sessionId);
      const metadata = await sessionMetaProjection(resolved);
      const warnings = resolved.warning ? [resolved.warning] : [];

      let scan = {
        results: [] as SessionRecord[],
        totalMatches: 0,
        malformedCount: 0,
      };
      if (resolved.logAvailability === "available") {
        scan = searchSessionLog(resolved.logPath, query, maxResults, include);
        if (scan.malformedCount > 0)
          warnings.push(
            `Skipped ${scan.malformedCount} malformed log line(s).`,
          );
      }
      const results: SearchResultOut[] = scan.results.map((r) => ({
        entryId: r.entryId,
        role: r.role,
        blockKind: r.blockKind,
        ...(r.timestamp ? { timestamp: r.timestamp } : {}),
        excerpt: excerpt(r.text, query, SEARCH_EXCERPT_CHARS),
      }));
      const { text, details } = buildSearchResponse({
        metadata: { ...metadata, query, include },
        results,
        totalMatches: scan.totalMatches,
        warnings,
        guidance:
          "Hand a result entryId to session_read({ at: entryId }); if truncated, narrow the query or raise maxResults (max 50).",
      });
      return { content: [{ type: "text", text }], details };
    },
  });
}

/* ------------------------------- helpers --------------------------------- */

function resolveSafe(sessionId: string) {
  try {
    return resolveInspectableSession(sessionId);
  } catch (err) {
    if (err instanceof SessionInspectionError) throw new Error(err.message);
    throw err;
  }
}

function cleanRequired(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new SessionInspectionError("empty", `${name} is required.`);
  return text;
}
