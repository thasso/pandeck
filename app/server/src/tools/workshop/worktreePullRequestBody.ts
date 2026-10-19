/**
 * `worktree_update_pull_request_body` (Task 947): replace the description of a
 * managed worktree's canonical open pull request with caller-written text, or
 * have the pull-request draft agent write it again after a fix round.
 *
 * Like the ready and retarget transitions it accepts only a worktree id; the
 * server derives the provider, the one open pull request and its live managed
 * cards (`withReservedManagedTarget`), so it can never reach another repository
 * or pull request. Caller text is published as written, so it carries the same
 * credential refusal as a caller-written commit message, with no override.
 */
import type { PullRequestCard } from "@assistant/shared";
import {
  defineAgentTool,
  jsonResult,
  type AgentTool,
  type ToolCallContext,
} from "../../mcp/tool.ts";
import {
  MAX_PULL_REQUEST_BODY_CHARS,
  normalizeCallerPullRequestBody,
} from "../../callerAuthoredText.ts";
import { draftPullRequest } from "../../prWorkflow.ts";
import { patchPullRequestCard } from "../../pullRequestCards.ts";
import { withPullRequestMutation } from "../../pullRequestMerge.ts";
import { sourceRequiresEnterprise } from "../../sessionEnterprise.ts";
import {
  defaultFinishPullRequestOperations,
  recordInventoryChange,
  withReservedManagedTarget,
  type ManagedPullRequestTarget,
  type WorktreeFinishPullRequestOperations,
} from "./worktreeFinishPullRequest.ts";

const MAX_CONTEXT_CHARS = 4_000;

export interface WorktreePullRequestBodyOperations extends WorktreeFinishPullRequestOperations {
  draft: typeof draftPullRequest;
  projectBody(cards: PullRequestCard[], body: string): void;
}

const defaultBodyOperations: WorktreePullRequestBodyOperations = {
  ...defaultFinishPullRequestOperations,
  draft: draftPullRequest,
  projectBody(cards, body) {
    for (const card of cards) patchPullRequestCard(card.id, { body: [body] });
  },
};

type UpdateBodyParams = { worktreeId: string; body?: string; context?: string };

/** Providers may hand a description back with CRLF line ends or trimmed. */
function sameBody(left: string, right: string): boolean {
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
  return normalize(left) === normalize(right);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorktreeUpdatePullRequestBodyTool(
  operations: WorktreePullRequestBodyOperations = defaultBodyOperations,
): AgentTool<UpdateBodyParams> & AgentTool {
  return defineAgentTool<UpdateBodyParams>({
    name: "worktree_update_pull_request_body",
    label: "Update managed pull request body",
    description:
      "Replace the description of an active registered spawned worktree's canonical open pull request: with your exact body, or, without one, a body the configured PR agent writes again from the pushed branch. Derives the provider and PR from the worktree; never reaches another repository or PR. Pre-authorized; a body that looks like it contains a credential is refused. Use after a fix round changes what the description says.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["worktreeId"],
      properties: {
        worktreeId: {
          type: "string",
          minLength: 1,
          description:
            "Active registered spawned worktree id; no repository, PR number or ref is accepted.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PULL_REQUEST_BODY_CHARS,
          description:
            "Exact Markdown body, published as given; outer whitespace is trimmed. Omit it to regenerate the body; the worktree's local HEAD must then equal the PR head.",
        },
        context: {
          type: "string",
          maxLength: MAX_CONTEXT_CHARS,
          description:
            "Optional bounded intent for the PR agent when regenerating; refused together with body.",
        },
      },
    },
    async execute(params, ctx) {
      return executeUpdateBody(params, ctx, operations);
    },
  });
}

async function executeUpdateBody(
  params: UpdateBodyParams,
  ctx: ToolCallContext,
  operations: WorktreePullRequestBodyOperations,
) {
  const requiresEnterprise = sourceRequiresEnterprise([ctx.session.sessionId]);
  const callerBody =
    params.body === undefined
      ? undefined
      : normalizeCallerPullRequestBody(params.body);
  const context = params.context?.trim();
  if (context && callerBody !== undefined)
    throw new Error(
      "context only guides a regenerated body; omit it when passing body.",
    );
  if (context && context.length > MAX_CONTEXT_CHARS)
    throw new Error(`context exceeds ${MAX_CONTEXT_CHARS} characters.`);

  return withReservedManagedTarget(
    params.worktreeId,
    ctx,
    operations,
    "A checked agent pull-request body update is in progress in this worktree.",
    {},
    async (target) => {
      const drafted =
        callerBody === undefined
          ? await regenerate(target, operations, ctx, {
              requiresEnterprise,
              ...(context ? { context } : {}),
            })
          : undefined;
      const body = callerBody ?? drafted!.body;
      return withPullRequestMutation(
        {
          repoPath: target.row.path,
          providerKind: target.hosted.provider.kind,
          number: target.number,
          repoUrl: target.hosted.provider.repoWebUrl,
        },
        "a description update",
        () =>
          writeBody(target, body, operations, {
            source: callerBody === undefined ? "agent" : "caller",
            warnings: drafted?.warnings ?? [],
          }),
      );
    },
  );
}

/** The draft agent's body for exactly the head the pull request holds. */
async function regenerate(
  target: ManagedPullRequestTarget,
  operations: WorktreePullRequestBodyOperations,
  ctx: ToolCallContext,
  options: { requiresEnterprise: boolean; context?: string },
): Promise<{ body: string; warnings: string[] }> {
  // The agent reads the LOCAL branch; it may only describe what was pushed.
  const local = await operations.localState(target.row, ctx.signal);
  if (
    local.branch !== target.row.branch ||
    !local.head ||
    local.head.toLowerCase() !== target.headSha.toLowerCase()
  )
    throw new Error(
      `The worktree's local HEAD (${local.head || "unreadable"}) is not pull request #${target.number}'s head ${target.headSha}; push or reconcile it before regenerating the body. Nothing was changed.`,
    );
  const taskId = target.cards.find(
    (card) => card.worktreeId === target.row.id && card.linkedTask,
  )?.linkedTask?.id;
  const agent = await operations.draft({
    repoRoot: target.row.path,
    headBranch: target.row.branch,
    baseBranch: target.baseBranch,
    taskId,
    additionalContext: options.context,
    helperSource: {
      sourceSessionId: ctx.session.sessionId,
      requiresEnterprise: options.requiresEnterprise,
    },
    onProgress: (message) =>
      ctx.progress?.(jsonResult({ status: "running", message })),
  });
  const body = agent.body
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!body)
    throw new Error(
      "The pull-request agent returned an empty body; nothing was changed.",
    );
  return { body, warnings: agent.warnings };
}

/**
 * Re-read the pull request under its mutation lock, write, and read the body
 * back. Neither provider has a precondition on the PATCH, so a failed write is
 * judged by the read-back like a retarget: the old body means the provider
 * refused, the new one means it landed, anything else is unknown.
 */
async function writeBody(
  target: ManagedPullRequestTarget,
  body: string,
  operations: WorktreePullRequestBodyOperations,
  options: { source: "caller" | "agent"; warnings: string[] },
) {
  const provider = target.hosted.provider;
  const detail = await provider.pullRequestDetail(target.number);
  if (
    !detail ||
    detail.number !== target.number ||
    detail.state !== "open" ||
    detail.merged ||
    detail.headSha.toLowerCase() !== target.headSha.toLowerCase() ||
    detail.headBranch !== target.headBranch ||
    detail.baseBranch !== target.baseBranch
  )
    throw new Error(
      `Pull request #${target.number} changed while preparing its body update; nothing was changed.`,
    );
  const before = await provider.pullRequestBody(target.number);
  const result = (status: string, extra: Record<string, unknown> = {}) =>
    jsonResult({
      status,
      provider: provider.kind,
      number: target.number,
      url: target.url,
      source: options.source,
      bodyChars: body.length,
      cardIds: target.cards.map((card) => card.id),
      ...extra,
      ...(options.warnings.length ? { warnings: options.warnings } : {}),
    });
  if (sameBody(before, body)) return result("unchanged");

  let writeError: unknown;
  let inventoryWarning: string | undefined;
  try {
    await provider.editPullRequestBody(target.number, body);
  } catch (error) {
    writeError = error;
  } finally {
    inventoryWarning = recordInventoryChange(operations, target);
  }
  let readBack: string | undefined;
  let readError: unknown;
  try {
    readBack = await provider.pullRequestBody(target.number);
  } catch (error) {
    readError = error;
  }
  const landed = readBack !== undefined && sameBody(readBack, body);
  if (writeError !== undefined && !landed) {
    if (readBack !== undefined && sameBody(readBack, before))
      throw new Error(
        `${provider.kind} refused the body update for pull request #${target.number}: ${errorText(writeError)}. Nothing was changed.`,
      );
    throw new Error(
      `The body update for pull request #${target.number} failed (${errorText(writeError)}) and its outcome is unknown; read the pull request before retrying.`,
    );
  }

  const notes: string[] = [];
  if (writeError !== undefined)
    notes.push(
      `The provider reported an error (${errorText(writeError)}), but the read-back shows the new body.`,
    );
  if (readBack === undefined)
    notes.push(
      `The body was written, but it could not be read back (${errorText(readError)}); read the pull request to confirm it.`,
    );
  else if (!landed)
    notes.push(
      "The provider accepted the write, but the body read back differs from the one sent; read the pull request before relying on it.",
    );
  if (inventoryWarning) notes.push(inventoryWarning);
  if (landed) {
    try {
      operations.projectBody(target.cards, body);
    } catch (error) {
      notes.push(
        `The body was updated, but its card could not be updated: ${errorText(error)}.`,
      );
    }
  }
  return result(notes.length ? "updated-partial" : "updated", {
    ...(notes.length ? { message: notes.join(" ") } : {}),
  });
}
