/**
 * The gateway's model upstreams, selected by path prefix. The route decides
 * the upstream and the lease decides the profile; a request decides neither.
 *
 * Each upstream allows exact `(method, pathname)` pairs after its prefix, with
 * no normalisation, so `/v1/messages/../x` and `/v1/messagesX` never match. A
 * later slice widens an allowlist only with engine contract-test evidence.
 */
import type { LeaseProvider } from "./leases.ts";
import type { UpstreamLabel } from "./refusals.ts";

interface Upstream {
  prefix: string;
  provider: LeaseProvider;
  /** The logical host: TLS name, `Host` header and, in production, address. */
  host: string;
  label: UpstreamLabel;
  allowed: readonly { method: string; pathname: string }[];
}

const UPSTREAMS: readonly Upstream[] = [
  {
    prefix: "/anthropic",
    provider: "claude",
    host: "api.anthropic.com",
    label: "Anthropic",
    allowed: [{ method: "POST", pathname: "/v1/messages" }],
  },
  {
    prefix: "/chatgpt",
    provider: "openai-codex",
    host: "chatgpt.com",
    label: "ChatGPT",
    allowed: [{ method: "POST", pathname: "/backend-api/codex/responses" }],
  },
];

export interface Route {
  upstream: Upstream;
  /** The request target after the prefix, query included, sent verbatim. */
  path: string;
  /** `path` without its query. */
  pathname: string;
}

/** The upstream a request target names by its prefix, or undefined. */
export function routeFor(url: string): Route | undefined {
  for (const upstream of UPSTREAMS) {
    if (!url.startsWith(upstream.prefix)) continue;
    const path = url.slice(upstream.prefix.length);
    if (path !== "" && !path.startsWith("/") && !path.startsWith("?")) continue;
    const query = path.indexOf("?");
    return {
      upstream,
      path,
      pathname: query < 0 ? path : path.slice(0, query),
    };
  }
  return undefined;
}

export function isAllowed(route: Route, method: string | undefined): boolean {
  return route.upstream.allowed.some(
    (entry) => entry.method === method && entry.pathname === route.pathname,
  );
}
