/**
 * A stubbed global `fetch` for the edge's Jira read tools (Task-1439): it
 * records every request with its signal as the request starts, and answers
 * from `jiraReadFixtures.ts` unless a test answers otherwise. An OAuth path
 * is matched without its `/ex/jira/<cloudId>` prefix. Every value is fake.
 */
import { vi } from "vitest";
import { jiraReadAnswer } from "./jiraReadFixtures.ts";

export interface SeenJiraRequest {
  url: URL;
  method: string;
  /** The Jira path, without an OAuth `/ex/jira/<cloudId>` prefix. */
  path: string;
  query: Record<string, string>;
  body: unknown;
  auth: string | null;
  signal: AbortSignal | undefined;
  /** Whether the signal had already aborted when the request started. */
  abortedAtStart: boolean;
}

export type JiraResponder = (
  seen: SeenJiraRequest,
) => Response | Promise<Response> | undefined;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

/** A request that never answers; it rejects once its signal aborts, as `fetch` does. */
export function pendingUntilAbort(seen: SeenJiraRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = seen.signal;
    if (!signal) return;
    const fail = () =>
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("aborted"),
      );
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Stubs `fetch`; `answer` goes first, the fixtures answer what it leaves
 * undefined, and an unknown request is a 404.
 */
export function stubJiraFetch(answer?: JiraResponder): SeenJiraRequest[] {
  const seen: SeenJiraRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const signal = init?.signal ?? undefined;
      const request: SeenJiraRequest = {
        url,
        method: init?.method ?? "GET",
        path: url.pathname.replace(/^\/ex\/jira\/[^/]+/, ""),
        query: Object.fromEntries(url.searchParams),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        auth: new Headers(init?.headers).get("authorization"),
        signal,
        abortedAtStart: signal?.aborted ?? false,
      };
      seen.push(request);
      const answered = await answer?.(request);
      if (answered) return answered;
      const fixture = jiraReadAnswer(
        request.method,
        request.path,
        request.query,
        request.body,
      );
      return fixture === undefined ? json({}, 404) : json(fixture);
    }),
  );
  return seen;
}

/** A few event-loop turns: long enough for any next request to start. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}
