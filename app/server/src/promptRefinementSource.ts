import type { PromptRefineRequest } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { hub } from "./hub.ts";
import { buildVisibleConversationContext } from "./promptRefinement.ts";

/** A client-side staged id is not provenance until the host knows its source. */
export function refinementSource(
  input: Pick<
    PromptRefineRequest,
    "sessionId" | "requiresEnterprise" | "includeContext"
  >,
) {
  const requestedId =
    typeof input.sessionId === "string" ? input.sessionId : undefined;
  const source = requestedId
    ? sessionStore.getIncludingDeleted(requestedId)
    : undefined;
  const snapshot =
    requestedId && input.includeContext !== false
      ? hub.getLiveById(requestedId)?.snapshot()
      : undefined;
  const sourceSessionId = source || snapshot ? requestedId : undefined;
  const requiresEnterprise =
    input.requiresEnterprise === true ||
    source?.requiresEnterprise === true ||
    (!!snapshot && !source);
  return {
    context: snapshot ? buildVisibleConversationContext(snapshot) : "",
    ...(sourceSessionId !== undefined ? { sourceSessionId } : {}),
    ...(requiresEnterprise ? { requiresEnterprise: true as const } : {}),
  };
}
