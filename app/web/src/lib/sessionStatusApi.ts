/**
 * The session status card (`docs/session-status.md`): GET
 * `/api/session-status` reads a session's last card, POST
 * `/api/session-status/refresh` has the status agent write a new one and
 * answers with it.
 */
import type {
  SessionStatusRefreshRequest,
  SessionStatusResponse,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

export async function fetchSessionStatus(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionStatusResponse> {
  const query = new URLSearchParams({ sessionId });
  return json(
    await fetch(`${serverHttpOrigin()}/api/session-status?${query}`, {
      headers: { ...authHeaders() },
      ...(signal ? { signal } : {}),
    }),
  );
}

/**
 * Write a new card. Resolves once the agent has finished, which takes a while.
 * With `joinOnly` it only waits for a refresh already running and never starts
 * one: the answer is then the current card.
 */
export async function refreshSessionStatus(
  sessionId: string,
  options: { joinOnly?: boolean } = {},
): Promise<SessionStatusResponse> {
  const request: SessionStatusRefreshRequest = {
    sessionId,
    ...(options.joinOnly ? { joinOnly: true } : {}),
  };
  return json(
    await fetch(`${serverHttpOrigin()}/api/session-status/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(request),
    }),
  );
}

async function json<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: unknown }).error;
    throw new Error(
      typeof error === "string" ? error : `Request failed (${res.status})`,
    );
  }
  return body as T;
}
