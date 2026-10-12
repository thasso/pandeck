/**
 * The creator backfill's evidence reader (`worktreeCreatorBackfill.ts`): which
 * worktrees one session log says its own `worktree_create` calls created.
 *
 * Kept free of the database and every app module on purpose, so the one piece
 * that streams files can be run as-is under the production Bun runtime.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Both harnesses' names for the tool: pi's bare name, Claude's MCP name. */
const CREATE_TOOL_NAME = /^(?:mcp__pa__)?worktree_create$/;

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
    // Only two kinds of line can matter, and the substring tests are only a
    // pre-filter: the entry's ROLE decides. A result line may name the tool
    // (`toolName`) or a path containing it and is still a result.
    const mayCall = line.includes("worktree_create");
    const mayResult = calls.size > 0 && line.includes('"toolResult"');
    if (!mayCall && !mayResult) continue;
    const entry = parse(line);
    // A fork stamps every entry it copied from its parent; those calls are the
    // parent's, whatever this session's own creation time says.
    if (entry?.inheritedFrom !== undefined) continue;
    if (entry?.role === "assistant") {
      for (const id of createCallIds(entry)) calls.add(id);
      continue;
    }
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
