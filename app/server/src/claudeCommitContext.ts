import type { AgentContentBlock } from "@assistant/shared/session";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import type { ToolSessionManager } from "./mcp/tool.ts";

const COMMIT_CUSTOM_TYPE = "workshop.commit";

/**
 * Build a minimal duck-typed `SessionManager` for the commit workflow from a
 * Claude session's normalized timeline. The commit workflow reads
 * `sessionManager.getBranch()` to find user prompts / touched files since the
 * last commit and calls `appendCustomEntry()`. Slash-command checkpoints come
 * from command-result cards. AgentTool checkpoints are held in memory for a
 * later tool round in the SAME Claude turn, then reconciled with the persisted
 * `worktree_commit` tool result once that turn enters the timeline.
 */
export function buildCommitSessionManager(
  getTimeline: () => readonly ClientTimelineEntry[],
): Pick<ToolSessionManager, "getBranch" | "appendCustomEntry"> {
  let nextPendingId = 1;
  let pendingCommitted: NonNullable<ReturnType<typeof committedCheckpoint>>[] =
    [];
  return {
    getBranch: () => {
      const branch = getTimeline()
        .map(timelineEntryToBranchEntry)
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      const durableCommitHashes = new Set(
        branch.flatMap((entry) => {
          const data = entry.data as
            { status?: unknown; commitHash?: unknown } | undefined;
          return entry.customType === COMMIT_CUSTOM_TYPE &&
            data?.status === "committed" &&
            typeof data.commitHash === "string"
            ? [data.commitHash]
            : [];
        }),
      );
      pendingCommitted = pendingCommitted.filter((entry) => {
        const hash = (entry.data as { commitHash: string }).commitHash;
        return !durableCommitHashes.has(hash);
      });
      return [...branch, ...pendingCommitted];
    },
    appendCustomEntry: (type, data) => {
      if (type !== COMMIT_CUSTOM_TYPE) return undefined;
      const checkpoint = committedCheckpoint(
        `pending-tool-commit-${nextPendingId++}`,
        data,
      );
      if (checkpoint) pendingCommitted.push(checkpoint);
      // This in-memory id is not a durable Claude timeline id and must not be
      // exposed as CommitDisplay.entryId (only dry-run acceptance uses one).
      return undefined;
    },
  };
}

function committedCheckpoint(id: string, data: unknown) {
  if (!data || typeof data !== "object") return undefined;
  const commit = data as { status?: unknown; commitHash?: unknown };
  if (commit.status !== "committed" || typeof commit.commitHash !== "string")
    return undefined;
  return {
    type: "custom",
    id,
    customType: COMMIT_CUSTOM_TYPE,
    data,
  };
}

function timelineEntryToBranchEntry(entry: ClientTimelineEntry) {
  if (entry.type === "command.result") {
    if (entry.card.kind !== "commit") return undefined;
    return {
      type: "custom",
      id: entry.id,
      customType: COMMIT_CUSTOM_TYPE,
      data: { version: 1, ...entry.card.commit },
    };
  }
  if (entry.role === "toolResult") return commitToolCheckpoint(entry);
  if (entry.role === "user" && entry.hidden) return undefined;
  return {
    type: "message",
    id: entry.id,
    message: {
      role: entry.role,
      content:
        entry.role === "user"
          ? textFromContent(entry.content)
          : entry.content.flatMap((block) =>
              block.type === "toolCall"
                ? [
                    {
                      type: "toolCall",
                      id: block.toolCallId,
                      name: block.name.toLowerCase(),
                      arguments: block.input as Record<string, unknown>,
                    },
                  ]
                : [],
            ),
    },
  };
}

function commitToolCheckpoint(
  entry: Extract<ClientTimelineEntry, { role: "toolResult" }>,
) {
  const toolName = entry.toolName?.replace(/^mcp__pa__/, "").toLowerCase();
  if (toolName !== "worktree_commit" || entry.isError) return undefined;
  try {
    const display = JSON.parse(textFromContent(entry.content)) as {
      status?: unknown;
    };
    if (
      !["committed", "dry-run", "blocked", "failed"].includes(
        typeof display.status === "string" ? display.status : "",
      )
    )
      return undefined;
    return {
      type: "custom",
      id: entry.id,
      customType: COMMIT_CUSTOM_TYPE,
      data: { version: 1, source: "tool", ...display },
    };
  } catch {
    return undefined;
  }
}

function textFromContent(content: readonly AgentContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<AgentContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}
