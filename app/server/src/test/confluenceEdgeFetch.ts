/**
 * A stubbed global `fetch` for the edge's Confluence read tools (Task-1439
 * P2): it records every request with its signal as the request starts, and
 * answers from `confluenceReadFixtures.ts` the way the local baseline's stub
 * does (an unknown request is a 404 with `{}`), unless a test answers
 * otherwise. An OAuth path is matched without its `/ex/confluence/<cloudId>`
 * prefix. Every value is fake.
 */
import { vi } from "vitest";
import { confluenceReadAnswer } from "./confluenceReadFixtures.ts";

export interface SeenConfluenceRequest {
  url: URL;
  method: string;
  /** The Confluence path, without an OAuth `/ex/confluence/<cloudId>` prefix. */
  path: string;
  query: Record<string, string>;
  /** Reads send no body; kept for the Jira fake's helpers. */
  body: null;
  auth: string | null;
  signal: AbortSignal | undefined;
  /** Whether the signal had already aborted when the request started. */
  abortedAtStart: boolean;
}

export type ConfluenceResponder = (
  seen: SeenConfluenceRequest,
) => Response | Promise<Response> | undefined;

/**
 * Stubs `fetch`; `answer` goes first, the fixtures answer what it leaves
 * undefined.
 */
export function stubConfluenceFetch(
  answer?: ConfluenceResponder,
): SeenConfluenceRequest[] {
  const seen: SeenConfluenceRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const signal = init?.signal ?? undefined;
      const request: SeenConfluenceRequest = {
        url,
        method: init?.method ?? "GET",
        path: url.pathname.replace(/^\/ex\/confluence\/[^/]+/, ""),
        query: Object.fromEntries(url.searchParams),
        body: null,
        auth: new Headers(init?.headers).get("authorization"),
        signal,
        abortedAtStart: signal?.aborted ?? false,
      };
      seen.push(request);
      const answered = await answer?.(request);
      if (answered) return answered;
      const fixture = confluenceReadAnswer(
        request.method,
        request.path,
        request.query,
      );
      return new Response(JSON.stringify(fixture?.body ?? {}), {
        status: fixture?.status ?? 404,
      });
    }),
  );
  return seen;
}
