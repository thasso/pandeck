/**
 * What a frozen agent definition does to a session, read from the definition
 * alone: the tools it denies and the system-prompt layer its body becomes.
 * Pure, so an engine builds from a definition it was handed without reaching
 * the session store (`docs/workers.md`); `sessionAgent.ts` freezes and reads
 * the stored row.
 */
import { AGENT_NATIVE_TOOLS, type AgentNativeTool } from "./agentLibrary.ts";
import type { SessionAgent } from "./sessionAgent.ts";

/** The system-prompt layer the definition's body becomes, after the persona's. */
export function agentPromptLayer(agent: SessionAgent): string {
  // The persona's own layers may still name a tool the definition denies.
  const denied =
    agent.denyTools.length > 0
      ? `\n\nThis session does not have these tools, whatever the instructions above say: ${agent.denyTools.join(", ")}.`
      : "";
  return `## Agent definition: ${agent.name}\n\nYou were started as the "${agent.name}" agent. These instructions define your role in this session:\n\n${agent.body}${denied}`;
}

/** Whether the definition denies one of the harness-neutral native tools. */
export function deniesNative(
  agent: SessionAgent | undefined,
  native: AgentNativeTool,
): boolean {
  return agent?.denyTools.includes(native) ?? false;
}

/** The persona's app tools without the ones the definition denies. */
export function withoutDeniedTools<T extends { name: string }>(
  tools: T[],
  agent: SessionAgent | undefined,
): T[] {
  if (!agent || agent.denyTools.length === 0) return tools;
  const denied = new Set(
    agent.denyTools.filter(
      (name) => !(AGENT_NATIVE_TOOLS as readonly string[]).includes(name),
    ),
  );
  return tools.filter((tool) => !denied.has(tool.name));
}
