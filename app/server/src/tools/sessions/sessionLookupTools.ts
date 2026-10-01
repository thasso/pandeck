/**
 * `session_lookup`: indexed discovery of ANOTHER app session by exact id or
 * title/linked-object match. Replaces the broad `list_agent_sessions`
 * enumeration. It reads only SQLite session metadata and existing relation
 * indexes (never a transcript, provider file, Task body, or project body) and
 * overlays live/running state from the hub. Output is bounded and compact.
 */
import { defineAgentTool, type AgentTool } from "../../mcp/tool.ts";
import { sessionStore, type SessionMeta } from "../../db/sessionStore.ts";
import { objectRefsForSession } from "../../db/sessionObjectStore.ts";
import { taskStore } from "../../db/taskStore.ts";
import { getWorktree, worktreeIdForSession } from "../../db/worktreeStore.ts";
import { projectStore } from "../../db/projectStore.ts";
import { getProject } from "../../projectRegistry.ts";
import {
  clampNumber,
  logAvailabilityByExistence,
  resumableState,
  runtimeStateFor,
} from "./sessionInspection.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

type LookupParams = {
  query?: string;
  limit?: number;
  includeArchived?: boolean;
};

type CompactRef = {
  objectType: "task" | "worktree" | "project";
  id: string;
  title?: string;
};

export function sessionLookupTools(): AgentTool[] {
  return [makeSessionLookupTool()];
}

function makeSessionLookupTool() {
  return defineAgentTool<LookupParams>({
    name: "session_lookup",
    label: "Look Up Session",
    description:
      "Find another app session by exact id or by title/linked Task/worktree/project, returning compact decision metadata. Only needed to turn a title into an id: with a copied session id, call session_read or session_send_prompt directly. The current session is never returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description:
            "Exact session id, or title / linked Task-worktree-project text to match.",
        },
        limit: {
          type: "number",
          description:
            "Maximum candidates for non-exact lookup. Defaults to 10; clamped 1–25.",
        },
        includeArchived: {
          type: "boolean",
          description: "Include archived sessions. Defaults to false.",
        },
      },
    } as const,
    async execute(params, ctx) {
      const rawQuery =
        typeof params.query === "string" ? params.query.trim() : "";
      if (!rawQuery) throw new Error("query is required.");
      const currentId = ctx.session.sessionId;
      const limit = clampNumber(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      const includeArchived = params.includeArchived === true;
      const nq = normalizeText(rawQuery);
      const qTokens = tokenize(nq);

      // Exact self lookup is an explicit error, never a silent not-found.
      if (rawQuery === currentId) {
        throw new Error(
          "Cannot look up the current session; use its tools directly.",
        );
      }

      // Exact id short-circuit: at most one other-session record regardless of limit.
      const exact = sessionStore.getIncludingDeleted(rawQuery);
      if (exact && exact.id !== currentId) {
        if (exact.deletedAt || exact.scope !== "user") {
          return notFound(rawQuery, "That session id is not available.");
        }
        if (exact.archivedAt != null && !includeArchived) {
          const details = {
            query: rawQuery,
            count: 0,
            candidates: [],
            archived: true,
            sessionId: exact.id,
            guidance: `Session ${exact.id} is archived. Retry with includeArchived: true, or read it directly with session_read.`,
          };
          return json(details);
        }
        const candidate = await toCandidate(exact);
        return json({
          query: rawQuery,
          count: 1,
          exactId: true,
          candidates: [candidate],
          guidance: "Exact session id match.",
        });
      }

      // Broad ranked lookup over indexed user sessions.
      const sessions = sessionStore
        .list()
        .filter((s) => s.id !== currentId)
        .filter((s) => includeArchived || s.archivedAt == null);

      const ranked = sessions
        .map((s) => {
          const refs = compactRefs(s.id);
          const rank = classify(s, refs, rawQuery, nq, qTokens);
          return rank ? { session: s, refs, rank } : null;
        })
        .filter(
          (r): r is { session: SessionMeta; refs: CompactRef[]; rank: Rank } =>
            r !== null,
        )
        .sort(compareRanked)
        .slice(0, limit);

      if (ranked.length === 0) return notFound(rawQuery);
      const candidates = await Promise.all(
        ranked.map((r) => toCandidate(r.session, r.refs)),
      );
      return json({
        query: rawQuery,
        count: candidates.length,
        candidates,
        guidance:
          "Read a candidate with session_read or message it with session_send_prompt.",
      });
    },
  });
}

/* ------------------------------ ranking ---------------------------------- */

interface Rank {
  cls: number;
  score: number;
}

function classify(
  session: SessionMeta,
  refs: CompactRef[],
  rawQuery: string,
  nq: string,
  qTokens: string[],
): Rank | null {
  const nt = normalizeText(session.title);
  const tTokens = tokenize(nt);
  if (nt && nt === nq) return { cls: 2, score: qTokens.length };
  if (nq && nt.startsWith(nq)) return { cls: 3, score: qTokens.length };
  if (qTokens.length > 0 && qTokens.every((t) => tTokens.includes(t)))
    return { cls: 4, score: qTokens.length };
  if (refs.some((r) => r.id === rawQuery || normalizeText(r.id) === nq))
    return { cls: 5, score: 1 };
  if (qTokens.length > 0) {
    let overlap = 0;
    for (const ref of refs) {
      if (!ref.title) continue;
      const refTokens = tokenize(normalizeText(ref.title));
      overlap += qTokens.filter((t) => refTokens.includes(t)).length;
    }
    if (overlap > 0) return { cls: 6, score: overlap };
  }
  return null;
}

function compareRanked(
  a: { session: SessionMeta; rank: Rank },
  b: { session: SessionMeta; rank: Rank },
): number {
  if (a.rank.cls !== b.rank.cls) return a.rank.cls - b.rank.cls;
  if (a.rank.score !== b.rank.score) return b.rank.score - a.rank.score;
  if (a.session.updatedAt !== b.session.updatedAt)
    return b.session.updatedAt - a.session.updatedAt;
  return a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0;
}

/* ---------------------------- normalization ------------------------------ */

function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/* ------------------------------- refs ------------------------------------ */

function taskRef(id: string): CompactRef {
  const numeric = Number(id);
  const title = Number.isInteger(numeric)
    ? taskStore.get(numeric)?.title
    : undefined;
  return { objectType: "task", id, ...(title ? { title } : {}) };
}
function projectRef(id: string): CompactRef {
  const title = getProject(id)?.name;
  return { objectType: "project", id, ...(title ? { title } : {}) };
}
function worktreeRef(id: string): CompactRef {
  const title = getWorktree(id)?.branch;
  return { objectType: "worktree", id, ...(title ? { title } : {}) };
}

/**
 * All indexed relations for a session: `context` refs PLUS the standalone
 * `in_project` and `in_worktree` edges normal sessions use (so exact ids and
 * linked titles for those match). De-duplicated by object type + id.
 */
function compactRefs(sessionId: string): CompactRef[] {
  const refs: CompactRef[] = [];
  const seen = new Set<string>();
  const add = (ref: CompactRef) => {
    const key = `${ref.objectType}:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const ref of objectRefsForSession(sessionId)) {
    if (ref.objectType === "task") add(taskRef(ref.id));
    else if (ref.objectType === "project") add(projectRef(ref.id));
    else if (ref.objectType === "worktree") add(worktreeRef(ref.id));
  }
  const projectId = safe(() => projectStore.sessionProjectOf(sessionId));
  if (projectId) add(projectRef(projectId));
  const worktreeId = safe(() => worktreeIdForSession(sessionId));
  if (worktreeId) add(worktreeRef(worktreeId));
  return refs;
}

function safe<T>(fn: () => T | undefined): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/* ---------------------------- projection --------------------------------- */

async function toCandidate(meta: SessionMeta, refs?: CompactRef[]) {
  const runtime = await runtimeStateFor(meta.id);
  const resumable = resumableState(meta, runtime);
  const useRefs = refs ?? compactRefs(meta.id);
  return {
    sessionId: meta.id,
    title: meta.title,
    harness: meta.harness,
    persona: meta.agentType,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    messageCount: meta.messageCount,
    archived: meta.archivedAt != null,
    runtimeState: runtime,
    resumable: resumable.resumable,
    ...(resumable.reason ? { notResumableReason: resumable.reason } : {}),
    logAvailability: logAvailabilityByExistence(meta.id),
    ...(useRefs.length ? { refs: useRefs } : {}),
  };
}

/* ------------------------------- results --------------------------------- */

function notFound(query: string, message?: string) {
  return json({
    query,
    count: 0,
    candidates: [],
    notFound: true,
    guidance:
      message ??
      "No matching session. If you already have a copied session id, use session_read or session_send_prompt directly.",
  });
}

function json(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}
