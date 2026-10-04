import type { AgentType, PromptRefineResponse } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/** Optional session context the refinement endpoint may use. */
export interface RefineTextOptions {
  sessionId?: string;
  agentType?: AgentType;
  includeContext?: boolean;
}

/**
 * Refine arbitrary draft text through the server's shared refinement endpoint.
 * Callers own loading state, feedback placement, and where the result lands.
 */
export async function refineText(
  text: string,
  options: RefineTextOptions = {},
): Promise<string> {
  const draft = text.trim();
  if (!draft) throw new Error("Text refinement requires a non-empty draft.");

  const response = await fetch(`${serverHttpOrigin()}/api/prompt/refine`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ text: draft, ...options }),
  });
  const payload = (await response
    .json()
    .catch(() => ({}))) as Partial<PromptRefineResponse> & { error?: string };

  if (!response.ok) {
    throw new Error(
      payload.error || `Text refinement failed (${response.status}).`,
    );
  }
  if (!payload.refinedText?.trim()) {
    throw new Error("Text refinement returned an empty response.");
  }
  return payload.refinedText;
}
