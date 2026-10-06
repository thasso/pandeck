/**
 * Resolving a session id to the files and metadata `sessionAudit.ts` reads.
 *
 * Two resolvers, one shape:
 *
 * - {@link resolveAuditSource} runs INSIDE the server (the `session_audit`
 *   tool): metadata comes from `sessionStore`, and the deleted/out-of-scope
 *   classification of `resolveInspectableSession` applies unchanged, so the
 *   audit can never reach a session the inspection tools refuse.
 * - {@link resolveAuditSourceFromDataDir} runs from the CLI against a data
 *   directory that may not be this process's own. It opens `app.sqlite3`
 *   READ-ONLY (never `getDb()`, which would migrate the user's live database
 *   from a checkout) and applies the same deleted/out-of-scope refusal itself.
 *
 * Neither writes anything.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { objectRefsForSession } from "./db/sessionObjectStore.ts";
import { readSessionSnapshot } from "./db/sessionSnapshotRead.ts";
import { sessionStore } from "./db/sessionStore.ts";
import type { PromptConditions } from "./promptConditions.ts";
import {
  canonicalPiSessionPath,
  canonicalSessionLogPath,
} from "./sessionStorage.ts";
import type {
  AuditCallSource,
  PersistedUsageTotals,
  SessionAuditSource,
} from "./sessionAudit.ts";
import {
  cleanSessionId,
  resolveInspectableSession,
  SessionInspectionError,
} from "./tools/sessions/sessionInspection.ts";

export interface AuditSourceOptions {
  /** Optional explicit transcript root; no ambient Claude CLI path is read. */
  claudeProjectsDir?: string | undefined;
}

function parseConditions(
  json: string | undefined,
): PromptConditions | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object"
      ? (parsed as PromptConditions)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Claude CLI transcript for one provider session id, found by scanning the
 * per-project directories. Returns undefined when the CLI history is gone —
 * a normal outcome the report degrades on rather than failing.
 */
function claudeTranscriptPath(
  providerSessionId: string | undefined,
  projectsDir: string | undefined,
): string | undefined {
  if (!providerSessionId || !projectsDir || !existsSync(projectsDir))
    return undefined;
  // The transcript file is named after the provider session id inside one of
  // the project dirs; probing the direct path per dir avoids listing them all.
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${providerSessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project dir (or unreadable) — keep looking.
    }
  }
  return undefined;
}

function callTranscriptFor(
  sessionId: string,
  harness: string,
  providerSessionId: string | undefined,
  dataDir: string,
  projectsDir: string | undefined,
): {
  transcript?: { source: AuditCallSource; path: string };
  warning?: string;
} {
  if (harness === "pi") {
    const path =
      dataDir === DATA_DIR
        ? canonicalPiSessionPath(sessionId)
        : join(dataDir, "sessions", sessionId, "native.jsonl");
    if (existsSync(path)) return { transcript: { source: "pi-native", path } };
    return {
      warning:
        "This pi session has no native.jsonl, so provider calls cannot be resolved.",
    };
  }
  const transcript = claudeTranscriptPath(providerSessionId, projectsDir);
  if (transcript)
    return { transcript: { source: "claude-transcript", path: transcript } };
  const store = join(dataDir, "claude-sdk", `${sessionId}.json`);
  if (existsSync(store))
    return {
      transcript: { source: "claude-store", path: store },
      warning:
        "No Claude CLI transcript for this session; the SDK store keeps whole turns and cannot resolve provider calls.",
    };
  return {
    warning:
      "No Claude CLI transcript and no SDK store for this session; provider calls cannot be resolved.",
  };
}

/** In-process resolution for the `session_audit` tool. Throws the inspection error. */
export function resolveAuditSource(
  sessionId: string,
  options: AuditSourceOptions = {},
): SessionAuditSource {
  const resolved = resolveInspectableSession(sessionId);
  const meta = resolved.meta;
  const warnings = resolved.warning ? [resolved.warning] : [];
  const projectsDir = options.claudeProjectsDir;
  const calls = callTranscriptFor(
    meta.id,
    meta.harness,
    meta.providerSessionId,
    DATA_DIR,
    projectsDir,
  );
  if (calls.warning) warnings.push(calls.warning);
  const totals = sessionStore.getUsageTotals(meta.id);
  const conditions = parseConditions(sessionStore.getPromptConditions(meta.id));
  const attachedTaskId = attachedTaskIdFromStore(meta.id);
  return {
    sessionId: meta.id,
    meta: {
      title: meta.title,
      harness: meta.harness,
      agentType: meta.agentType,
      createdAtMs: meta.createdAt,
      updatedAtMs: meta.updatedAt,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.provider ? { provider: meta.provider } : {}),
      ...(meta.thinkingLevel ? { thinkingLevel: meta.thinkingLevel } : {}),
      archived: meta.archivedAt != null,
      messageCount: meta.messageCount,
    },
    logPath: canonicalSessionLogPath(meta.id),
    ...(calls.transcript ? { callTranscript: calls.transcript } : {}),
    ...(totals ? { persistedUsage: totals as PersistedUsageTotals } : {}),
    ...(conditions ? { promptConditions: conditions } : {}),
    ...(attachedTaskId ? { attachedTaskId } : {}),
    warnings,
  };
}

/** The Task a session opened on (`session → context → task`), when it has one. */
function attachedTaskIdFromStore(sessionId: string): string | undefined {
  try {
    return objectRefsForSession(sessionId).find(
      (ref) => ref.objectType === "task",
    )?.id;
  } catch {
    return undefined;
  }
}

/**
 * CLI resolution against any data directory, through the read-only snapshot
 * facade in `db/` (this module writes no SQL of its own). Only file PATHS and
 * plain metadata survive into the source; the database handle does not.
 */
export function resolveAuditSourceFromDataDir(
  sessionId: string,
  dataDir: string,
  options: AuditSourceOptions = {},
): SessionAuditSource {
  const id = cleanSessionId(sessionId);
  const snapshot = readSessionSnapshot(dataDir, id);
  if (!snapshot)
    throw new SessionInspectionError(
      "unknown",
      `No session found with id ${id} under ${dataDir}.`,
    );
  const row = snapshot.session;
  // The same refusals `resolveInspectableSession` applies in-process.
  if (row.deleted)
    throw new SessionInspectionError(
      "deleted",
      `Session ${id} was deleted and can no longer be inspected.`,
    );
  if (row.scope !== "user")
    throw new SessionInspectionError(
      "internal",
      `Session ${id} is not a user session (${row.scope}) and is not inspectable.`,
    );

  const projectsDir = options.claudeProjectsDir;
  const calls = callTranscriptFor(
    id,
    row.harness,
    row.providerSessionId,
    dataDir,
    projectsDir,
  );
  const conditions = parseConditions(snapshot.promptConditionsJson);

  return {
    sessionId: id,
    meta: {
      title: row.title,
      harness: row.harness,
      agentType: row.agentType,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
      ...(row.model ? { model: row.model } : {}),
      ...(row.provider ? { provider: row.provider } : {}),
      ...(row.thinkingLevel ? { thinkingLevel: row.thinkingLevel } : {}),
      archived: row.archived,
      messageCount: row.messageCount,
    },
    logPath: join(dataDir, "sessions", id, "log.jsonl"),
    ...(calls.transcript ? { callTranscript: calls.transcript } : {}),
    ...(snapshot.usage ? { persistedUsage: snapshot.usage } : {}),
    ...(conditions ? { promptConditions: conditions } : {}),
    ...(snapshot.attachedTaskId
      ? { attachedTaskId: snapshot.attachedTaskId }
      : {}),
    ...(calls.warning ? { warnings: [calls.warning] } : {}),
  };
}
