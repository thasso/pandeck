/**
 * Harness-independent agent-type registry.
 *
 * An `AgentType` (`assistant` | `workshop` | …, from `@assistant/shared`) is
 * the persona a session presents: its system prompt, its tool/permission
 * policy, and which tools it exposes. It is INDEPENDENT of the harness (pi /
 * claude-sdk) that actually runs it. This module is the single source of truth
 * for those definitions; each harness applier consumes the relevant fields:
 *   - pi (`buildAgentOptions` in {@link ./piSdk/options.ts}) consumes
 *     {@link AgentTypeDef.systemPrompt} and builds the pi tool policy there;
 *   - claude-sdk (the session MCP server) consumes {@link AgentTypeDef.systemPrompt}
 *     and {@link AgentTypeDef.tools}.
 *
 * Tool composition itself lives in the tool catalog
 * ({@link ./tools/catalog.ts}): every persona's toolset is the flat union of
 * its tool groups, which also carry the eager/deferred loading tiers and
 * integration gates.
 */
import type { AgentType } from "@assistant/shared";
import type { AgentTool } from "./mcp/tool.ts";
import type { PromptAssetOptions } from "./promptAssets.ts";
import {
  assistantSystemPromptText,
  developerSystemPromptText,
  personalAssistantSystemPromptText,
  workshopSystemPromptText,
  workflowCoordinatorSystemPromptText,
} from "./agents.ts";
import { agentToolsFor } from "./tools/catalog.ts";

/**
 * The harness-independent definition of an agent. Owns the system prompt and
 * the toolset exposed over the session MCP server (the pi tool/permission
 * policy is built from these in {@link ./piSdk/options.ts}). The `manager`
 * workshop sub-variant is handled as a parameter of the pi applier
 * (see `buildPiManagerOptions` in {@link ./piSdk/options.ts}); it is
 * intentionally NOT modeled as its own agentType.
 */
export interface AgentTypeDef {
  agentType: AgentType;
  label: string;
  /** Only offered in local dev mode (the app-modifying Workshop agent). */
  devOnly: boolean;
  /**
   * The agent's system-prompt text (our appended extension + context prompts).
   * Reused by the Claude harnesses to make a Claude session behave like this
   * agentType. Read fresh on each call so prompt edits apply to new sessions.
   * `opts` overrides which prompt-asset directory the file-backed layers
   * resolve against — sessions never pass it; the prompt inventory does, to
   * measure a directory other than the running process's.
   */
  systemPrompt(opts?: PromptAssetOptions): string;
  /**
   * The custom tools this agentType exposes over the session MCP server (the
   * Claude SDK mounts it as `pa`, prefixing external names with `mcp__pa__`).
   * This is the FULL tool universe — session-independent; per-session toolGroup
   * enablement is applied by the session tool server's active-tool filter.
   * Composed from the persona's tool-catalog groups (`tools/catalog.ts`) —
   * the single source of truth for BOTH harnesses' toolsets.
   */
  tools(): AgentTool[];
}

export const AGENT_TYPES: Record<AgentType, AgentTypeDef> = {
  assistant: {
    agentType: "assistant",
    label: "Assistant",
    devOnly: false,
    systemPrompt: (opts) => assistantSystemPromptText(opts),
    // The assistant has NO native file/shell tools; all capability is the
    // dedicated integration tools over the session MCP server.
    tools: () => agentToolsFor("assistant"),
  },
  "personal-assistant": {
    agentType: "personal-assistant",
    label: "Personal Assistant",
    // Never advertised in a picker (see agents.ts availableAgents); the singleton
    // acquisition path creates it directly.
    devOnly: false,
    systemPrompt: (opts) => personalAssistantSystemPromptText(opts),
    // Shares the ordinary Assistant's dedicated integration-tool universe.
    tools: () => agentToolsFor("personal-assistant"),
  },
  workshop: {
    agentType: "workshop",
    label: "Workshop",
    devOnly: true,
    systemPrompt: (opts) => workshopSystemPromptText(opts),
    // Workshop adds the code-editing groups (worktree review, toolGroups) on
    // top of the shared groups; Claude already has native Read/Write/Edit/Bash. The toolGroup tool UNIVERSE is always part of the
    // toolset — per-session enablement is applied by the session tool server's
    // active-tool filter, not here.
    tools: () => agentToolsFor("workshop"),
  },
  "workflow-coordinator": {
    agentType: "workflow-coordinator",
    label: "Workflow coordinator",
    devOnly: false,
    systemPrompt: (opts) => workflowCoordinatorSystemPromptText(opts),
    tools: () => agentToolsFor("workflow-coordinator"),
  },
  developer: {
    agentType: "developer",
    label: "Developer",
    devOnly: false,
    systemPrompt: (opts) => developerSystemPromptText(opts),
    // A generic coding agent: the same code-editing toolset as Workshop, minus
    // the tools that only make sense on the app's own dev box (the catalog's
    // developer exclusions).
    tools: () => agentToolsFor("developer"),
  },
};
