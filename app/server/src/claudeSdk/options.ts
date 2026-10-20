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
  hasNativeTools,
  type SessionMode,
  type ThinkingLevel,
} from "@assistant/shared";
import { MCP_SERVER_NAME } from "../mcp/names.ts";
import {
  CLAUDE_SDK_HARNESS_SETTINGS,
  claudeSdkModelAlias,
  claudeSdkModelId,
  reasoningToThinking,
} from "./modelSettings.ts";
import { planModeToolUnavailableMessage } from "../mcp/tool.ts";
import { isPlanModeToolAllowed } from "../tools/toolPolicy.ts";
import { AGENT_TYPES } from "../agentTypes.ts";
import {
  AGENT_NATIVE_TOOLS,
  type AgentNativeTool,
} from "../agents/agentLibrary.ts";
import {
  agentPromptLayer,
  deniesNative,
  type SessionAgent,
} from "../agents/sessionAgent.ts";
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
 * ({@link SessionMode}) refuses exactly these; everything else — `Read`,
 * `Bash`, the search pair, `ToolSearch` and the whole `mcp__pa__*` namespace —
 * stays untouched, so a planning session still investigates at full strength.
 * That also bounds what Plan promises: `Bash` and the write-capable
 * `mcp__pa__*` tools can still change files, so this is "no native file edits",
 * not a read-only session.
 *
 * They stay on `tools:` in Plan and are refused per call by the `PreToolUse`
 * gate ({@link planModeNativeRefusal}), never moved onto `disallowedTools`:
 * the tool list is fixed when the Claude process starts, and a process kept
 * alive for retained background work must be able to return to Build without
 * a restart that would kill that work ([Task-756](pa://task/756)).
 */
const CLAUDE_NATIVE_MUTATING_TOOLS: readonly string[] = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
];

/**
 * Plan's refusal of a mutating native, or undefined when the call may run.
 * Evaluated per call against the LIVE mode, so a switch reaches a running
 * process on its next tool call.
 */
function planModeNativeRefusal(
  mode: SessionMode,
  toolName: string,
): string | undefined {
  if (mode !== "plan" || !CLAUDE_NATIVE_MUTATING_TOOLS.includes(toolName))
    return undefined;
  return `${toolName} is unavailable while this session is in Plan mode. Deliver the plan as your reply; the user switches back to Build to implement it.`;
}

/**
 * The Claude natives behind each harness-neutral name an agent definition may
 * deny (`docs/agent-definitions.md` "Tools"). `Monitor` runs shell commands,
 * so it goes with `bash`.
 */
const CLAUDE_NATIVES_FOR_AGENT_DENY: Readonly<
  Record<AgentNativeTool, readonly string[]>
> = {
  bash: ["Bash", "Monitor"],
  edit: ["Edit", "MultiEdit", "NotebookEdit"],
  write: ["Write"],
};

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
   * The session's LIVE Build/Plan mode, read per tool call. It never shapes
   * `tools:`/`disallowedTools` — a retained process outlives a mode switch —
   * only the `PreToolUse` gate and `canUseTool`, so a switch applies to the
   * running process too. Requires `outputPolicySessionId`, whose hooks carry
   * the gate. Omitted means Build.
   */
  mode?: () => SessionMode;
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
   * The FROZEN agent definition the session was spawned as: its body is the
   * last system-prompt layer and its denied natives leave `tools:`.
   */
  agent?: SessionAgent | undefined;
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
  /**
   * The session's stored compaction window, already clamped into the model's
   * range. Set: the query starts with it as `autoCompactWindow` and without the
   * server's `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which the CLI would read first.
   * Unset: settings and env are exactly today's (`docs/compaction-window.md`).
   */
  compactionWindow?: number;
}

/**
 * Permission callback: allow the configured native tools and the mounted `pa` MCP
 * server's tools; deny everything else (other MCP servers, other natives).
 *
 * Bypass mode below normally approves before this runs, but bypass is not
 * guaranteed: an account whose org-managed settings carry
 * `permissions.disableBypassPermissionsMode: "disable"` silently starts the CLI
 * in `default` mode. This callback is then the only approver; without it every
 * prompting call (each `mcp__pa__*` tool, any out-of-cwd read) is denied with
 * "you haven't granted it yet" and no prompt ever reaches the user.
 */
function buildCanUseTool(
  allowed: ReadonlySet<string>,
  allowPaMcp: boolean,
  mode: () => SessionMode,
  planRestrictedAppTools: ReadonlySet<string>,
): NonNullable<ClaudeSdkOptions["canUseTool"]> {
  // External-name prefix the SDK gives tools served by our in-process `pa` server.
  const mcpPrefix = `mcp__${MCP_SERVER_NAME}__`;
  return async (toolName, input) => {
    const appToolName = toolName.startsWith(mcpPrefix)
      ? toolName.slice(mcpPrefix.length)
      : undefined;
    const planned = mode() === "plan";
    if (planned && appToolName && planRestrictedAppTools.has(appToolName))
      return {
        behavior: "deny",
        message: planModeToolUnavailableMessage(appToolName),
      };
    const nativeRefusal = planModeNativeRefusal(mode(), toolName);
    if (nativeRefusal) return { behavior: "deny", message: nativeRefusal };
    if (allowed.has(toolName) || (allowPaMcp && appToolName !== undefined))
      return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: `Tool ${toolName} is not enabled for this session.`,
    };
  };
}

/**
 * The CLI's own compaction-window variable. It outranks every settings layer,
 * so a query that carries a stored window must not inherit it.
 */
export const CLAUDE_AUTO_COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

export function buildClaudeSdkQueryOptions(
  input: BuildClaudeSdkQueryOptionsInput,
): ClaudeSdkOptions {
  const agentType = input.agentType ?? "workshop";
  const defaultNative = hasNativeTools(agentType)
    ? CLAUDE_SDK_NATIVE_TOOLS
    : [];
  // Plan mode never shapes the native set: it is a per-call refusal against
  // the live mode (see CLAUDE_NATIVE_MUTATING_TOOLS) — and never
  // `permissionMode: "plan"`, which would stop tool execution generally and
  // impose the CLI's own ExitPlanMode protocol. `disableTools` is reserved for
  // CLI-local no-model operations such as compaction, where even
  // Skill/ToolSearch must be absent deliberately.
  const deniedNative = new Set(
    AGENT_NATIVE_TOOLS.filter((name) =>
      deniesNative(input.agent, name),
    ).flatMap((name) => CLAUDE_NATIVES_FOR_AGENT_DENY[name]),
  );
  const native = [
    ...(input.disableTools ? [] : (input.nativeTools ?? defaultNative)),
  ].filter((name) => !deniedNative.has(name));
  const allowed = new Set(native);
  if (input.mode && !input.outputPolicySessionId)
    throw new Error(
      "A Claude query with a session mode needs outputPolicySessionId: its PreToolUse hook enforces Plan.",
    );
  const mode = input.mode ?? (() => "build" as const);
  const planRestrictedAppTools = new Set(
    AGENT_TYPES[agentType]
      .tools()
      .filter((tool) => !isPlanModeToolAllowed(tool))
      .map((tool) => tool.name),
  );
  const disallowedTools = KNOWN_CLAUDE_NATIVE_TOOLS.filter(
    (name) => !allowed.has(name),
  );
  // ToolSearch is the CLI's own built-in deferred-tool search (loads
  // mcp__pa__* tool definitions on demand); it is NOT covered by allowing
  // "mcp__pa__*" through canUseTool. The CLI's own isToolSearchToolAvailable
  // gate requires "ToolSearch" to be a member of the `tools` allowlist array
  // itself (verified live: without this, the CLI silently loads every mcp__pa__
  // tool definition upfront regardless of alwaysLoad, for every persona/model).
  // This must ride the `tools:` array, not just canUseTool.
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
        ...(isCodingAgentType(agentType) ? ["Skill"] : []),
        ...(agentType === "workflow-coordinator" ? [] : ["ToolSearch"]),
      ];
  const cwd = isAbsolute(input.cwd) ? input.cwd : pathResolve(input.cwd);
  const env = withClaudeOutputBudgetEnvironment(input.env);
  if (input.compactionWindow !== undefined)
    delete env[CLAUDE_AUTO_COMPACT_WINDOW_ENV];
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
            (toolName) => planModeNativeRefusal(mode(), toolName),
          ),
        }
      : {}),
    includePartialMessages: true,
    strictMcpConfig: true,
    // The host-owned persona/tool policy is authoritative: bypass mode
    // auto-approves ordinary coding Bash commands (no per-command prompt), so
    // most shell use behaves like pi. The native tool allowlist above still
    // prevents personas without native access from receiving file/shell tools.
    // Org-managed settings can silently downgrade this to `default`; the
    // `canUseTool` callback below then approves the same policy.
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
    settings:
      input.compactionWindow !== undefined
        ? {
            ...CLAUDE_SDK_HARNESS_SETTINGS,
            autoCompactWindow: input.compactionWindow,
          }
        : CLAUDE_SDK_HARNESS_SETTINGS,
    // Assistant personas must not inherit project/user settings: in particular,
    // a run worktree's CLAUDE.md must not enter the coordinator's authority
    // context. Their complete instruction surface is the locked-down prompt.
    ...(!isCodingAgentType(agentType) ? { settingSources: [] } : {}),
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
      mode,
      planRestrictedAppTools,
    ),
    model: claudeQueryModel(input.modelId, input.agent),
    systemPrompt: claudeSdkSystemPrompt(
      agentType,
      input.additionalSystemPrompt,
      input.promptConditions
        ? { conditions: input.promptConditions }
        : undefined,
      input.agent,
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
 * The SDK model a query runs. A spawned agent that pinned a concrete version
 * runs exactly that version while the session is still on the agent's alias,
 * however the alias is mapped by then; a model the user switched to runs as
 * usual.
 */
export function claudeQueryModel(
  modelId: string,
  agent: SessionAgent | undefined,
): string {
  if (
    agent?.pinnedModel &&
    claudeSdkModelAlias(modelId) === claudeSdkModelAlias(agent.model)
  )
    return agent.pinnedModel;
  return claudeSdkModelId(modelId);
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
  agent?: SessionAgent,
): NonNullable<ClaudeSdkOptions["systemPrompt"]> {
  const extra = additional?.trim();
  const prompt = `${AGENT_TYPES[agentType].systemPrompt(promptAssets)}${extra ? `\n\n## Personal profile instructions\n\n${extra}` : ""}${agent ? `\n\n${agentPromptLayer(agent)}` : ""}`;
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
