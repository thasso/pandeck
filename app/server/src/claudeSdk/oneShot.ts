/**
 * Headless one-shot run against the in-process Claude Agent SDK.
 *
 * The Claude engine half of `runOneShot` (`harnesses/oneShot.ts`), which routes
 * a helper run here when its configured provider is the Claude SDK
 * (`claude-sdk`) and is the only caller.
 *
 * It runs a single `query()` with no native file/shell tools, no project/user
 * setting sources (so CLAUDE.md / user settings can't leak in), and optionally
 * an explicit app-tool allowlist through the in-process MCP bridge. It
 * accumulates assistant text and returns normalized token usage. A timeout
 * aborts the underlying query.
 */
import { randomUUID } from "node:crypto";
import { CWD } from "../config.ts";
import { packagedClaudeSdkOptions } from "../runtimeAssets.ts";
import {
  claudeProfileEnvironment,
  defaultClaudeProfileId,
} from "../credentialProfiles.ts";
import { MCP_SERVER_NAME } from "../mcp/names.ts";
import {
  createSessionToolServer,
  type SessionToolServer,
} from "../mcp/sessionToolServer.ts";
import type { AgentTool } from "../mcp/tool.ts";
import {
  assistantProviderError,
  type AssistantBlock,
  mapAssistantBlocks,
  mapResultEpochUsage,
  resultProviderError,
  type ClaudeUsage,
} from "./messageMapper.ts";
import {
  claudeSdkModelId,
  CLAUDE_SDK_HARNESS_SETTINGS,
  reasoningToThinking,
} from "./modelSettings.ts";
import {
  buildRealClaudeSdkSeam,
  type ClaudeSdkOptions,
  type ClaudeSdkSeam,
  type ClaudeSdkUserMessage,
} from "./sdkSeam.ts";
import type { ThinkingLevel } from "@assistant/shared";

/** All native Claude tools explicitly disallowed for every helper run. */
const ALL_NATIVE_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoRead",
  "TodoWrite",
  "NotebookRead",
  "NotebookEdit",
];

export interface RunClaudeSdkOneShotInput {
  /** Model alias/id (opus/sonnet/haiku, or anything resolvable to one). */
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** Full system prompt (replaces the default — a custom prompt). */
  systemPrompt: string;
  /** The single user prompt. */
  prompt: string;
  /** Isolated Claude credential profile; defaults to PA's protected profile. */
  credentialProfileId?: string;
  /** Abort the query after this many ms. Defaults to 60s. */
  timeoutMs?: number;
  /** Error thrown on timeout. */
  timeoutMessage?: string;
  /** Explicit app-tool allowlist. Native Claude tools remain disabled. */
  tools?: AgentTool[];
  /** Maximum model/tool turns when tools are enabled. */
  maxTurns?: number;
  /** Binary documents (e.g. a PDF) attached to the single user turn as content blocks. */
  documents?: Array<{ mimeType: string; dataBase64: string }>;
}

export interface ClaudeSdkOneShotResult {
  text: string;
  usage: ClaudeUsage;
  /**
   * Set when the run's result was not a success (an `error*` subtype). The
   * text is whatever the model wrote before that, possibly nothing.
   */
  failure?: string;
}

/** Test seam override; defaults to the real installed SDK. */
let seamFactory: () => Promise<ClaudeSdkSeam> = buildRealClaudeSdkSeam;

/** Inject a fake seam (tests only). */
export function setClaudeSdkOneShotSeam(
  factory: () => Promise<ClaudeSdkSeam>,
): void {
  seamFactory = factory;
}

function buildOneShotOptions(
  input: RunClaudeSdkOneShotInput,
  abortController: AbortController,
  toolServer?: SessionToolServer,
): ClaudeSdkOptions {
  return {
    cwd: CWD,
    abortController,
    ...packagedClaudeSdkOptions(),
    env: claudeProfileEnvironment(
      input.credentialProfileId ?? defaultClaudeProfileId(),
    ),
    model: claudeSdkModelId(input.modelId),
    systemPrompt: input.systemPrompt,
    // Native tools and inherited settings stay disabled. A caller-supplied
    // app-tool allowlist is mounted only through the private pa MCP namespace.
    tools: [],
    disallowedTools: ALL_NATIVE_TOOLS,
    settingSources: [],
    // Disable Claude's native auto-memory globally; our in-app Memory is the
    // single authoritative memory surface (see CLAUDE_SDK_HARNESS_SETTINGS).
    settings: CLAUDE_SDK_HARNESS_SETTINGS,
    maxTurns: toolServer ? (input.maxTurns ?? 8) : 1,
    ...(toolServer
      ? {
          strictMcpConfig: true,
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "sdk" as const,
              name: MCP_SERVER_NAME,
              instance: toolServer.server as never,
            },
          },
          canUseTool: async (
            toolName: string,
            toolInput: Record<string, unknown>,
          ) =>
            toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)
              ? { behavior: "allow" as const, updatedInput: toolInput }
              : {
                  behavior: "deny" as const,
                  message: `Tool ${toolName} is not enabled for this helper agent.`,
                },
        }
      : { allowedTools: [] }),
    ...reasoningToThinking(input.thinkingLevel, input.modelId),
  } as ClaudeSdkOptions;
}

/**
 * Streaming-input prompt carrying binary documents (e.g. a PDF) as content
 * blocks alongside the text prompt in one user turn. Completing the generator
 * signals end-of-input so the single turn runs to a result.
 */
async function* documentPrompt(
  input: RunClaudeSdkOneShotInput,
  sessionId: string,
): AsyncGenerator<ClaudeSdkUserMessage> {
  const content = [
    ...(input.documents ?? []).map((doc) => ({
      type: "document" as const,
      source: {
        type: "base64" as const,
        media_type: doc.mimeType,
        data: doc.dataBase64,
      },
    })),
    { type: "text" as const, text: input.prompt },
  ];
  yield {
    type: "user",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: { role: "user", content },
  } as ClaudeSdkUserMessage;
}

/**
 * Run a single Claude SDK helper query and return the assistant text + usage.
 * App tools are absent by default and explicit when supplied. Throws on timeout
 * or abort; an error result is reported as {@link ClaudeSdkOneShotResult.failure}.
 */
export async function runClaudeSdkOneShot(
  input: RunClaudeSdkOneShotInput,
): Promise<ClaudeSdkOneShotResult> {
  const seam = await seamFactory();
  const abortController = new AbortController();
  const sessionId = `one-shot-${randomUUID()}`;
  const sessionManager = {
    getSessionId: () => sessionId,
    getBranch: () => [] as unknown[],
    appendCustomEntry: () => undefined,
  };
  const toolServer = input.tools?.length
    ? createSessionToolServer({
        sessionId,
        harness: "claude-sdk",
        listMode: "active",
        tools: () => input.tools ?? [],
        session: () => ({
          sessionId,
          harness: "claude-sdk",
          agentType: "assistant",
          cwd: CWD,
          sessionManager,
        }),
      })
    : undefined;
  const timeoutMs = input.timeoutMs ?? 60_000;
  const timeoutMessage =
    input.timeoutMessage ?? "Claude SDK one-shot agent timed out.";

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  let text = "";
  let usage: ClaudeUsage = {};
  let resultError: string | undefined;

  try {
    const query = seam.query({
      prompt: input.documents?.length
        ? documentPrompt(input, sessionId)
        : input.prompt,
      options: buildOneShotOptions(input, abortController, toolServer),
    });
    for await (const message of query) {
      if (message.type === "assistant") {
        // An API failure arrives as a synthetic assistant message whose text
        // is the provider's wording, never model output.
        const providerError = assistantProviderError(message);
        if (providerError) {
          resultError ??=
            providerError.text || `Claude API error: ${providerError.kind}`;
          continue;
        }
        for (const block of mapAssistantBlocks(message) as AssistantBlock[]) {
          if (block.type === "text") text += block.text;
        }
      } else if (message.type === "result") {
        // A one-shot query runs once, so the epoch running total IS this run.
        usage = mapResultEpochUsage(message);
        const failed = resultProviderError(message);
        if (failed)
          resultError ??=
            failed.text || `Claude SDK run ended with: ${failed.reason}`;
      }
    }
  } catch (err) {
    if (timedOut) throw new Error(timeoutMessage);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    await toolServer?.close().catch(() => {});
  }

  if (timedOut) throw new Error(timeoutMessage);
  return { text, usage, ...(resultError ? { failure: resultError } : {}) };
}
