/**
 * One-time backfill of `created_worktree` edges for worktrees created before
 * `worktree_create` recorded its caller (`docs/worktree-ownership.md`).
 *
 * The evidence is the creating session's OWN log: its `worktree_create` tool
 * call and the result paired with it by `toolCallId`, whose JSON names the new
 * worktree's id, path and project. A worktree id merely mentioned somewhere —
 * a `worktree_status` listing, a pasted path — is not a claim.
 *
 * A fork copies its parent's history, so the same call and result appear in
 * every fork made after it. The creator is therefore the claimant that
 * EXISTED when the worktree was created (session `createdAt <= row.createdAt`);
 * more than one such claimant is ambiguous and links nothing.
 *
 * It runs once per data directory, off the boot path, and records its summary
 * in `worktree_creator_backfill`. A failure records nothing, so the next start
 * retries; a creator already recorded is never replaced.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { sessionStore } from "../db/sessionStore.ts";
import {
  creatorSessionIdForWorktree,
  listWorktrees,
  recordWorktreeCreator,
  recordWorktreeCreatorBackfill,
  worktreeCreatorBackfillDone,
  type WorktreeRow,
} from "../db/worktreeStore.ts";
import { logPathFor } from "../session/log/persistence.ts";
import { broadcastWorktreeList } from "./worktrees.ts";

/** Both harnesses' names for the tool: pi's bare name, Claude's MCP name. */
const CREATE_TOOL_NAME = /^(?:mcp__pa__)?worktree_create$/;

export interface WorktreeCreatorBackfillSummary {
  /** Worktree rows, active or removed, that had no creator. */
  candidates: number;
  /** Session logs read. */
  sessionsScanned: number;
  linked: number;
  /** Candidates more than one existing session claimed. */
  ambiguous: number;
}

/** What one `worktree_create` result in a log says it created. */
export interface CreatedWorktreeClaim {
  worktreeId: string;
  path: string;
  projectId: string;
}

/**
 * Every worktree a session log says its own `worktree_create` calls created,
 * streamed line by line: logs reach hundreds of megabytes, and only the lines
 * that can matter are parsed.
 */
export async function scanLogForCreatedWorktrees(
  path: string,
): Promise<CreatedWorktreeClaim[]> {
  const calls = new Set<string>();
  const claims: CreatedWorktreeClaim[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.includes("worktree_create")) {
      for (const id of createCallIds(parse(line))) calls.add(id);
      continue;
    }
    if (calls.size === 0 || !line.includes('"toolResult"')) continue;
    const entry = parse(line);
    if (entry?.role !== "toolResult") continue;
    const callId = entry.toolCallId;
    if (typeof callId !== "string" || !calls.delete(callId)) continue;
    const claim = claimOf(entry.content);
    if (claim) claims.push(claim);
  }
  return claims;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function createCallIds(entry: Record<string, unknown> | undefined): string[] {
  if (entry?.role !== "assistant" || !Array.isArray(entry.content)) return [];
  const ids: string[] = [];
  for (const part of entry.content as unknown[]) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    if (
      block.type === "toolCall" &&
      typeof block.name === "string" &&
      CREATE_TOOL_NAME.test(block.name) &&
      typeof block.toolCallId === "string"
    )
      ids.push(block.toolCallId);
  }
  return ids;
}

function claimOf(content: unknown): CreatedWorktreeClaim | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const part of content as unknown[]) {
    if (!part || typeof part !== "object") continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const result = parse(block.text);
    if (
      typeof result?.id === "string" &&
      typeof result.path === "string" &&
      typeof result.projectId === "string"
    )
      return {
        worktreeId: result.id,
        path: result.path,
        projectId: result.projectId,
      };
  }
  return undefined;
}

export interface WorktreeCreatorBackfillOptions {
  /** Where a session's log lives; tests point it at fixtures. */
  logPath?: (sessionId: string) => string;
}

/**
 * Run the backfill unless it already ran. Answers what it did, or `undefined`
 * when there was nothing to do because it had completed before.
 */
export async function backfillWorktreeCreators(
  options: WorktreeCreatorBackfillOptions = {},
): Promise<WorktreeCreatorBackfillSummary | undefined> {
  if (worktreeCreatorBackfillDone()) return undefined;
  const logPath = options.logPath ?? logPathFor;
  const candidates = new Map<string, WorktreeRow>();
  for (const row of listWorktrees({ includeRemoved: true }))
    if (creatorSessionIdForWorktree(row.id) === undefined)
      candidates.set(row.id, row);

  const summary: WorktreeCreatorBackfillSummary = {
    candidates: candidates.size,
    sessionsScanned: 0,
    linked: 0,
    ambiguous: 0,
  };
  if (candidates.size > 0) {
    const createdAts = [...candidates.values()].map((row) => row.createdAt);
    const earliest = Math.min(...createdAts);
    const latest = Math.max(...createdAts);
    const claimants = new Map<string, Set<string>>();
    // A creator existed before its worktree and was active after it.
    const sessions = sessionStore
      .list({ scopes: "all", includeDeleted: true })
      .filter(
        (session) =>
          session.createdAt <= latest && session.updatedAt >= earliest,
      );
    for (const session of sessions) {
      const path = logPath(session.id);
      if (!existsSync(path)) continue;
      summary.sessionsScanned += 1;
      for (const claim of await scanLogForCreatedWorktrees(path)) {
        const row = candidates.get(claim.worktreeId);
        if (
          !row ||
          row.path !== claim.path ||
          row.projectId !== claim.projectId ||
          session.createdAt > row.createdAt
        )
          continue;
        const set = claimants.get(row.id) ?? new Set<string>();
        set.add(session.id);
        claimants.set(row.id, set);
      }
    }
    for (const [worktreeId, sessionIds] of claimants) {
      if (sessionIds.size !== 1) {
        summary.ambiguous += 1;
        continue;
      }
      const [sessionId] = sessionIds;
      if (sessionId === undefined) continue;
      recordWorktreeCreator(sessionId, worktreeId);
      summary.linked += 1;
    }
  }
  recordWorktreeCreatorBackfill(summary);
  if (summary.linked > 0) void broadcastWorktreeList().catch(() => undefined);
  return summary;
}
