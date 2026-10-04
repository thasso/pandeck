import type { AgentType } from "@assistant/shared";

/** The chat-bearing routes, as far as staging is concerned. */
interface ChatRoute {
  name: string;
  /** Present on `/sessions/<id>`. */
  id?: string;
}

export interface ChatRouteStageInput {
  route: ChatRoute;
  /** The session currently in view, if any. */
  viewedSessionId: string | null;
  /** That session's persona — how the Assistant singleton is recognized. */
  viewedAgentType: AgentType | undefined;
  /** A client-staged session renders optimistically and is never "pending". */
  hasOptimisticSession: boolean;
  /** The viewed session is right but its transcript has not arrived yet. */
  transcriptPending: boolean;
}

/**
 * Whether the chat surface is WAITING for the session its route names, and must
 * therefore stand the transcript down for a placeholder
 * (`app/web/docs/loading-states.md` R3: a different object gets a placeholder,
 * never the previous one's content under a new title).
 *
 * The Assistant is the case this exists for. Its route names no id — the server
 * owns the singleton — so "has the route arrived" cannot be answered by
 * comparing ids the way an ordinary session route does. What is waited for is
 * the PERSONA appearing in view; until it does, the pane was left drawing
 * whatever session the reader came from, with nothing anywhere saying the
 * Assistant was on its way.
 */
/**
 * Why the session a session route names cannot be opened at all, when the
 * server said so (`UIState.unopenableSessions`); null otherwise. A route that
 * is pending for such a session has nothing on its way, so the stage shows the
 * failure: an error region is not a loading region
 * (`app/web/docs/loading-states.md`).
 */
export function chatRouteFailure(
  route: ChatRoute,
  unopenable: Readonly<Record<string, string>>,
): string | null {
  if (route.name !== "session" || route.id === undefined) return null;
  return unopenable[route.id] ?? null;
}

export function chatRoutePending(input: ChatRouteStageInput): boolean {
  const { route, viewedSessionId, viewedAgentType } = input;
  if (route.name === "permanentAssistant")
    return viewedAgentType !== "personal-assistant";
  if (route.name !== "session" || route.id === undefined) return false;
  if (input.hasOptimisticSession) return false;
  return viewedSessionId !== route.id || input.transcriptPending;
}
