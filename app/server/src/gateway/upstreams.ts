/**
 * The gateway's model upstreams, selected by path prefix. The route decides
 * the upstream and the lease decides the profile; a request decides neither.
 *
 * Each upstream allows exact `(method, pathname)` pairs after its prefix, with
 * no normalisation, so `/v1/messages/../x` and `/v1/messagesX` never match. A
 * later slice widens an allowlist only with engine contract-test evidence.
 * A server lease also gets its upstream's `serverAllowed`: v06's usage routes,
 * which an engine lease never reaches.
 *
 * `/compat` is the OpenAI-compatible endpoint the server pushed: its origin
 * and base path come from the push (`compatUpstream.ts`), and it allows only
 * `POST <base path>/chat/completions`.
 */
import type { LeaseOwnership, LeaseProvider } from "./leases.ts";
import type { UpstreamLabel } from "./refusals.ts";

/** A provider's fixed upstream, spending the lease's profile credential. */
interface ProviderUpstream {
  kind: "provider";
  prefix: string;
  provider: LeaseProvider;
  /** The logical host: TLS name, `Host` header and, in production, address. */
  host: string;
  label: UpstreamLabel;
  allowed: readonly { method: string; pathname: string }[];
  /** What only a server lease reaches besides `allowed`. */
  serverAllowed: readonly { method: string; pathname: string }[];
}

/** The pushed OpenAI-compatible endpoint, spending the pushed key. */
interface CompatUpstreamRoute {
  kind: "compat";
  prefix: string;
  provider: "openai-compatible";
}

type Upstream = ProviderUpstream | CompatUpstreamRoute;

const UPSTREAMS: readonly Upstream[] = [
  {
    kind: "provider",
    prefix: "/anthropic",
    provider: "claude",
    host: "api.anthropic.com",
    label: "Anthropic",
    allowed: [{ method: "POST", pathname: "/v1/messages" }],
    serverAllowed: [],
  },
  {
    kind: "provider",
    prefix: "/chatgpt",
    provider: "openai-codex",
    host: "chatgpt.com",
    label: "ChatGPT",
    allowed: [{ method: "POST", pathname: "/backend-api/codex/responses" }],
    // The server's usage, credits and irreversible consume (G4).
    serverAllowed: [
      { method: "GET", pathname: "/backend-api/wham/usage" },
      { method: "GET", pathname: "/backend-api/wham/rate-limit-reset-credits" },
      {
        method: "POST",
        pathname: "/backend-api/wham/rate-limit-reset-credits/consume",
      },
    ],
  },
  { kind: "compat", prefix: "/compat", provider: "openai-compatible" },
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

/**
 * A provider route's allowlist for a lease of `kind`: `serverAllowed` only for
 * a server lease, never an unknown kind. `/compat` is checked against its push.
 */
export function isAllowed(
  route: Route,
  method: string | undefined,
  kind: LeaseOwnership["kind"] | undefined,
): boolean {
  const { upstream } = route;
  if (upstream.kind !== "provider") return false;
  const matches = (entry: { method: string; pathname: string }): boolean =>
    entry.method === method && entry.pathname === route.pathname;
  return (
    upstream.allowed.some(matches) ||
    (kind === "server" && upstream.serverAllowed.some(matches))
  );
}

/** The one request `/compat` forwards, under the pushed base path. */
export function isCompatAllowed(
  route: Route,
  method: string | undefined,
  basePath: string,
): boolean {
  return method === "POST" && route.pathname === `${basePath}/chat/completions`;
}
