/**
 * Whether an existing session may be opened right now, by the engine that runs
 * it (`docs/agent-harnesses.md`). A Claude session waits on the Claude SDK
 * setting, independent of its persona's dev-only flag (a Claude workshop
 * session stays loadable in production); a pi session on its persona's
 * existing-session availability.
 */
import type { AgentType, Harness } from "@assistant/shared";
import { isAgentSessionAvailable } from "../agents.ts";
import { getSettings } from "../settings.ts";

const gates: Record<Harness, (agentType: AgentType) => string | undefined> = {
  "claude-sdk": () =>
    getSettings().claudeSdk.enabled
      ? undefined
      : "Claude SDK is disabled in settings.",
  pi: (agentType) =>
    isAgentSessionAvailable(agentType)
      ? undefined
      : `The "${agentType}" agent is not available.`,
};

/** Why an existing session may not be opened now; undefined when it may. */
export function existingSessionRefusal(
  harness: Harness,
  agentType: AgentType,
): string | undefined {
  return gates[harness](agentType);
}
