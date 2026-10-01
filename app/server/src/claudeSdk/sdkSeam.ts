/**
 * Import seam for the in-process Claude Agent SDK.
 *
 * The real seam lazily `import()`s `@anthropic-ai/claude-agent-sdk` so the
 * (heavy) SDK is only pulled in when a Claude-SDK session actually runs, and so a
 * fake seam can be injected in tests. Re-exports the SDK's own types so the rest
 * of the module stays decoupled from the package path.
 */
import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
  SDKMessage as ClaudeSdkMessage,
  Settings as ClaudeSdkSettings,
  SDKUserMessage as ClaudeSdkUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type {
  ClaudeSdkMessage,
  ClaudeSdkOptions,
  ClaudeSdkSettings,
  ClaudeSdkUserMessage,
};

/** Per-MCP-tool context usage row (subset of the SDK's get_context_usage). */
type ClaudeContextUsageMcpTool = {
  name: string;
  serverName: string;
  tokens: number;
  isLoaded?: boolean;
};

/** The streaming query controls used by retained Claude process epochs. */
export type ClaudeQuery = AsyncIterable<ClaudeSdkMessage> & {
  close?: () => void;
  interrupt?: () => Promise<unknown>;
  streamInput?: (stream: AsyncIterable<ClaudeSdkUserMessage>) => Promise<void>;
  stopTask?: (taskId: string) => Promise<void>;
  /**
   * Drop a queued user message by its uuid before the CLI reads it (the
   * `cancel_async_message` control request). The installed SDK implements it on
   * `Query` without declaring it, so it stays optional: a missing method only
   * means a withdrawn steer may still reach the CLI, where the provider-turn
   * gate interrupts it.
   */
  cancelAsyncMessage?: (messageUuid: string) => Promise<boolean>;
  setModel?: (model?: string) => Promise<void>;
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
  /** Tool-search visibility: which MCP tool definitions are loaded (optional; fakes omit it). */
  getContextUsage?: () => Promise<{ mcpTools: ClaudeContextUsageMcpTool[] }>;
  /**
   * The structured data behind the CLI's `/usage` command (session cost/usage
   * totals plus claude.ai plan rate-limit utilization). Untyped/loose on
   * purpose: the SDK marks this API EXPERIMENTAL_MAY_CHANGE, and the observed
   * runtime payload already carries fields beyond the package's declared
   * `SDKControlGetUsageResponse` type. Optional; fakes omit it.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<
    Record<string, unknown>
  >;
};

export type ClaudeQueryParams = {
  prompt: string | AsyncIterable<ClaudeSdkUserMessage>;
  options?: ClaudeSdkOptions;
};

/** The minimal surface the session depends on; a fake implements this in tests. */
export type ClaudeSdkSeam = {
  query(params: ClaudeQueryParams): ClaudeQuery;
  /**
   * Branch a native transcript into a new one, sliced INCLUSIVELY at
   * `upToMessageId` (a transcript message uuid, i.e. what we persist as an
   * entry's `providerMessageId`). Copies the messages under fresh uuids, so the
   * source session is untouched. Optional: a fake seam may omit it, and a
   * harness that cannot fork reports so through its adapter capabilities.
   *
   * `sessionStore` binds the call to one credential profile's config root; see
   * `profileSessionStore.ts` for why it is not an env flip. Typed `unknown`
   * because the SDK marks `SessionMutationOptions.sessionStore` `@alpha`: the
   * seam should not pin an unstable structural type its fakes must then mimic.
   */
  forkSession?(
    sessionId: string,
    options: {
      upToMessageId?: string;
      dir?: string;
      title?: string;
      sessionStore?: unknown;
    },
  ): Promise<{ sessionId: string }>;
  /** Remove a native transcript, so PA's delete does not orphan one. */
  deleteSession?(
    sessionId: string,
    options: { dir?: string; sessionStore?: unknown },
  ): Promise<void>;
};

/** The real seam, backed by the installed `@anthropic-ai/claude-agent-sdk`. */
export async function buildRealClaudeSdkSeam(): Promise<ClaudeSdkSeam> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return {
    query: (params) => sdk.query(params) as ClaudeSdkQuery as ClaudeQuery,
    forkSession: (sessionId, options) =>
      sdk.forkSession(
        sessionId,
        options as Parameters<typeof sdk.forkSession>[1],
      ),
    deleteSession: (sessionId, options) =>
      sdk.deleteSession(
        sessionId,
        options as Parameters<typeof sdk.deleteSession>[1],
      ),
  };
}
