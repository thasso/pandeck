import type { AgentType } from "@assistant/shared";
import { isPersonalAssistantAgentType } from "@assistant/shared";
import { permanentAssistantStore } from "./db/permanentAssistantStore.ts";

interface SessionRowIdentity {
  id: string;
  agentType?: AgentType;
}

/**
 * One binding read per projection, never one per row. Persona hides both the
 * mint-before-bind window and rotated predecessors. The bound id also hides a
 * legacy ordinary-persona singleton; abandoning that binding reveals it again.
 * Kept separate from the singleton runtime so the hub can use the same rule.
 */
export function sessionListHiddenProbe(): (row: SessionRowIdentity) => boolean {
  const boundId = permanentAssistantStore.sessionId();
  return (row) =>
    isPersonalAssistantAgentType(row.agentType) || row.id === boundId;
}
