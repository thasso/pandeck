/**
 * Builds the SDK query options and resolves model/thinking for a Claude-SDK
 * session using this repo's `ModelOption` / `ThinkingLevel` types, curated model
 * list, and installed `@anthropic-ai/claude-agent-sdk` Options type (see
 * THINKING below).
 */
import { isAbsolute, join, resolve as pathResolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type AgentType,
  isCodingAgentType,
  type SessionMode,
  type ThinkingLevel,
} from "@assistant/shared";
import { MCP_SERVER_NAME } from "../mcp/names.ts";
import {
  CLAUDE_SDK_HARNESS_SETTINGS,
  claudeSdkModelId,
  reasoningToThinking,
} from "./modelSettings.ts";
import { planModeToolUnavailableMessage } from "../mcp/tool.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import type { PromptAssetOptions } from "../promptAssets.ts";
import type { PromptConditions } from "../promptConditions.ts";
import type { ClaudeSdkOptions } from "./sdkSeam.ts";
import { SKILLS_RUNTIME_DIR } from "../config.ts";
import { packagedClaudeSdkOptions } from "../runtimeAssets.ts";
import { skillSetHash } from "../skills/skillRuntimeMaterializer.ts";
import {
  claudeOutputPolicyHooks,
  type ClaudeQueryLifecycleHooks,
  withClaudeOutputBudgetEnvironment,
} from "./outputPolicyHooks.ts";

/**
 * Default native tools exposed to a Claude-SDK session.
 *
 * `Grep`/`Glob` are the vendor's own bounded search tools (Task-316): without
 * them every search becomes a `Bash` round trip with unbounded output, and on
 * this box a plain `grep` is a shell function that fails outright (Task-315).
 */
export const CLAUDE_SDK_NATIVE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Monitor",
  "Grep",
  "Glob",
] as const;

/**
 * The native tools that MUTATE the working tree. Plan mode
 * ({@link SessionMode}) subtracts exactly these from whatever native set the
 * persona would otherwise get; everything else — `Read`, `Bash`, the search
 * pair, `ToolSearch` and the whole `mcp__pa__*` namespace — stays untouched, so
 * a planning session still investigates at full strength. That also bounds what
 * Plan promises: `Bash` and the write-capable `mcp__pa__*` tools can still
 * change files, so this is "no native file edits", not a read-only session.
 * They are members of {@link KNOWN_CLAUDE_NATIVE_TOOLS}, so dropping them here
 * also moves them onto `disallowedTools` with no second list to keep in step.
 */
const CLAUDE_NATIVE_MUTATING_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
];

/** All native tools we know about, so the rest can be explicitly disallowed. */
const KNOWN_CLAUDE_NATIVE_TOOLS = [
  "Bash",
  "Monitor",
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
] as const;

export interface BuildClaudeSdkQueryOptionsInput {
  cwd: string;
  abortController: AbortController;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /**
   * Build (default) or Plan. Recomputed on EVERY turn — a fresh `query()` is
   * built per prompt — so flipping the session's mode takes effect on the next
   * turn without any SDK control request.
   */
  mode?: SessionMode;
  /** Provider session id from a prior run, to resume. */
  providerSessionId?: string;
  /** Override the native tools exposed; defaults to {@link CLAUDE_SDK_NATIVE_TOOLS}. */
  nativeTools?: readonly string[];
  /**
   * In-process MCP server exposing this session's bridged custom tools (the
   * workshop toolset). When provided, it is mounted as `mcpServers.pa` and its
   * `mcp__pa__*` tools are added to the policy. Built once per session by the
   * {@link import("./ClaudeSdkSession.ts").ClaudeSdkSession}.
   */
  mcpServer?: Server;
  /**
   * Which agentType's `pa` MCP toolset to expose to this session. Defaults to
   * `"workshop"` (today's only claude-sdk behavior). Routed through the
   * harness-independent `AGENT_TYPES` registry so the SDK harness can apply any
   * agentType's allowlist; with the default this is byte-identical to before.
   */
  agentType?: AgentType;
  /** Optional session-specific instructions appended after the persona prompt. */
  additionalSystemPrompt?: string;
  /**
   * The session's FROZEN session-start prompt conditions (`promptConditions.ts`).
   * A resumed query resends the whole system prompt, so passing anything
   * recomputed here would move the cached prefix mid-conversation.
   */
  promptConditions?: PromptConditions;
  /** Scrubbed, profile-specific SDK subprocess environment. */
  env?: Record<string, string>;
  /** App session id used to retain elided native output as session artifacts. */
  outputPolicySessionId?: string;
  /**
   * Library skill names frozen at session start. The caller recreates this
   * set's generated runtime before an ordinary query; this builder only points
   * the SDK at that deterministic plugin root. Never pass live settings here.
   */
  frozenSkillNames?: readonly string[];
  /**
   * Explicit no-tool path for CLI-local operations such as `/compact`.
   * Suppresses native/system tools and library plugins without changing normal
   * coding-session discovery defaults.
   */
  disableTools?: boolean;
  /** Per-process retained-query governance hooks. */
  lifecycleHooks?: ClaudeQueryLifecycleHooks;
}

/**
 * Permission callback: allow the configured native tools and the mounted `pa` MCP
 * server's tools; deny everything else (other MCP servers, other natives).
 */
function buildCanUseTool(
  allowed: ReadonlySet<string>,
  allowPaMcp: boolean,
  planRestrictedAppTools: ReadonlySet<string>,
): NonNullable<ClaudeSdkOptions["canUseTool"]> {
  // External-name prefix the SDK gives tools served by our in-process `pa` server.
  const mcpPrefix = `mcp__${MCP_SERVER_NAME}__`;
  return async (toolName, input) => {
    const appToolName = toolName.startsWith(mcpPrefix)
      ? toolName.slice(mcpPrefix.length)
      : undefined;
    if (appToolName && planRestrictedAppTools.has(appToolName))
      return {
        behavior: "deny",
        message: planModeToolUnavailableMessage(appToolName),
      };
    if (allowed.has(toolName) || (allowPaMcp && appToolName !== undefined))
      return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: `Tool ${toolName} is not enabled for this session.`,
    };
  };
}

export function buildClaudeSdkQueryOptions(
  input: BuildClaudeSdkQueryOptionsInput,
): ClaudeSdkOptions {
  const agentType = input.agentType ?? "workshop";
  // The assistant personas (ordinary `assistant` and the singleton
  // `personal-assistant`) have NO native file/shell tools — all of their
  // capability is the dedicated `pa` integration tools over the bridge (mirrors
  // the pi assistant, which has no built-in tools). Only the coding personas get
  // the native Read/Write/Edit/Bash. An explicit `nativeTools` override still wins.
  const isAssistantPersona =
    agentType === "assistant" ||
    agentType === "personal-assistant" ||
    agentType === "workflow-coordinator";
  const defaultNative = isAssistantPersona ? [] : CLAUDE_SDK_NATIVE_TOOLS;
  // Plan mode is a pure SUBTRACTION applied after the persona (or an explicit
  // override) has decided the native set — never `permissionMode: "plan"`,
  // which would stop tool execution generally and impose the CLI's own
  // ExitPlanMode protocol. Build is byte-identical to having no mode at all.
  // `disableTools` is reserved for CLI-local no-model operations such as
  // compaction, where even Skill/ToolSearch must be absent deliberately.
  const native = [
    ...(input.disableTools ? [] : (input.nativeTools ?? defaultNative)),
  ].filter(
    (name) =>
      input.mode !== "plan" || !CLAUDE_NATIVE_MUTATING_TOOLS.includes(name),
  );
  const allowed = new Set(native);
  const planRestrictedAppTools = new Set(
    input.mode === "plan"
      ? AGENT_TYPES[agentType]
          .tools()
          .filter((tool) => !isPlanModeToolAllowed(tool))
          .map((tool) => tool.name)
      : [],
  );
  const disallowedTools = KNOWN_CLAUDE_NATIVE_TOOLS.filter(
    (name) => !allowed.has(name),
  );
  // ToolSearch is the CLI's own built-in deferred-tool search (loads
  // mcp__pa__* tool definitions on demand); it is NOT covered by allowing
  // "mcp__pa__*" through canUseTool. The CLI's own isToolSearchToolAvailable
  // gate requires "ToolSearch" to be a member of the `tools` allowlist array
  // itself (verified live: without this, the CLI silently loads every mcp__pa__
  // tool definition upfront regardless of alwaysLoad, for every persona/model —
  // canUseTool is irrelevant here anyway since bypassPermissions below shadows
  // it entirely). This must ride the `tools:` array, not just canUseTool.
  //
  // Skill has the same literal-membership gate: project skills are discovered
  // without it, but the model cannot invoke the context-injecting Skill tool.
  // Only coding personas load project settings/skills, so only they receive it.
  // Skill remains available in Plan because loading context is non-mutating,
  // matching Read and ToolSearch even when a skill body describes later edits.
  const toolsAllowlist = input.disableTools
    ? []
    : [
        ...native,
        ...(!isAssistantPersona ? ["Skill"] : []),
        ...(agentType === "workflow-coordinator" ? [] : ["ToolSearch"]),
      ];
  const cwd = isAbsolute(input.cwd) ? input.cwd : pathResolve(input.cwd);
  const env = withClaudeOutputBudgetEnvironment(input.env);
  const frozenSkillNames = input.frozenSkillNames ?? [];
  const librarySkillPlugin =
    isCodingAgentType(agentType) &&
    !input.disableTools &&
    frozenSkillNames.length > 0
      ? join(SKILLS_RUNTIME_DIR, skillSetHash(frozenSkillNames))
      : undefined;
  // Do not set `allowedTools`: bare entries auto-approve before `canUseTool` is
  // consulted, which both logs SDK shadowing warnings and bypasses this policy.
  // The mounted session MCP server owns which `mcp__pa__*` tools are listed; the
  // callback below permits that namespace and denies everything else.
  return {
    cwd,
    abortController: input.abortController,
    ...packagedClaudeSdkOptions(),
    env,
    ...(input.outputPolicySessionId
      ? {
          hooks: claudeOutputPolicyHooks(
            input.outputPolicySessionId,
            input.lifecycleHooks,
          ),
        }
      : {}),
    includePartialMessages: true,
    strictMcpConfig: true,
    // The host-owned persona/tool policy is authoritative: bypass mode
    // auto-approves ordinary coding Bash commands (no per-command prompt), so
    // most shell use behaves like pi. The native tool allowlist above still
    // prevents assistant personas from receiving Bash (or any file tool) at all.
    //
    // CAVEAT: bypass is NOT total. The bundled Claude Code CLI has a git-safety
    // gate that denies `git push` (and file deletes outside the cwd) BEFORE the
    // SDK permission layer runs — `canUseTool` is never even consulted for those
    // (empirically verified). No SDK option (bypass, canUseTool, PreToolUse
    // hooks, allowedTools rules) can override it, so a Claude coding session
    // cannot push through native Bash. Pushing is handled app-side by checked
    // `worktree_push` or the human `/push` command (`pushWorkflow.ts`), which run
    // git outside the CLI — mirroring checked commit surfaces.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    tools: toolsAllowlist,
    disallowedTools,
    // Disable Claude's native auto-memory globally; our in-app Memory is the
    // single authoritative memory surface (see CLAUDE_SDK_HARNESS_SETTINGS).
    settings: CLAUDE_SDK_HARNESS_SETTINGS,
    // Assistant personas must not inherit project/user settings: in particular,
    // a run worktree's CLAUDE.md must not enter the coordinator's authority
    // context. Their complete instruction surface is the locked-down prompt.
    ...(isAssistantPersona ? { settingSources: [] } : {}),
    ...(librarySkillPlugin
      ? {
          plugins: [
            {
              type: "local" as const,
              path: librarySkillPlugin,
              skipMcpDiscovery: true,
            },
          ],
        }
      : {}),
    // Deliberately omit the SDK `skills` filter: coding sessions retain the
    // CLI-default discovery of repository `.claude/skills` alongside the plugin.
    canUseTool: buildCanUseTool(
      new Set(toolsAllowlist),
      Boolean(input.mcpServer),
      planRestrictedAppTools,
    ),
    model: claudeSdkModelId(input.modelId),
    systemPrompt: claudeSdkSystemPrompt(
      agentType,
      input.additionalSystemPrompt,
      input.promptConditions
        ? { conditions: input.promptConditions }
        : undefined,
    ),
    ...reasoningToThinking(input.thinkingLevel, input.modelId),
    ...(input.providerSessionId ? { resume: input.providerSessionId } : {}),
    ...(input.mcpServer
      ? {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              type: "sdk" as const,
              name: MCP_SERVER_NAME,
              instance: input.mcpServer as never,
            },
          },
        }
      : {}),
  };
}

/**
 * The Claude harness's system prompt for a persona: our extension alone for the
 * assistant personas, or the vendor `claude_code` preset with our extension
 * appended for the coding ones. Exported so the prompt inventory
 * (`promptInventory.ts`) measures the real composition rather than a replica.
 */
export function claudeSdkSystemPrompt(
  agentType: AgentType,
  additional?: string,
  promptAssets?: PromptAssetOptions,
): NonNullable<ClaudeSdkOptions["systemPrompt"]> {
  const extra = additional?.trim();
  const prompt = `${AGENT_TYPES[agentType].systemPrompt(promptAssets)}${extra ? `\n\n## Personal profile instructions\n\n${extra}` : ""}`;
  // Coding personas (workshop/developer) build on Claude Code's base prompt and
  // append our persona extension; the assistant personas use their own
  // locked-down prompt.
  if (
    agentType !== "assistant" &&
    agentType !== "personal-assistant" &&
    agentType !== "workflow-coordinator"
  ) {
    return { type: "preset", preset: "claude_code", append: prompt };
  }
  return prompt;
}
