/**
 * External tool names derived from the agent-type registry.
 *
 * Kept apart from {@link ./names.ts} so that module can stay import-free: this
 * one pulls in {@link ../agentTypes.ts} and therefore joins the import cycle
 * rooted there, which `names.ts` must not.
 */
import { AGENT_TYPES } from "../agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import { externalToolName } from "./names.ts";

/** External `mcp__pa__*` names of the toolset a persona exposes to a session. */
export function mcpToolNamesFor(agentType: AgentType): string[] {
  return AGENT_TYPES[agentType]
    .tools()
    .map((tool) => externalToolName(tool.name));
}
