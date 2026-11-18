/**
 * The gateway's model upstreams, selected by path prefix. The prefix alone
 * decides the host, and the lease (or the machine pool) decides the profile;
 * a request decides neither: its `Host` and target never pick another.
 *
 * Engine and server leases keep exact `(method, pathname)` pairs after the
 * prefix, with no normalisation, so `/v1/messages/../x` and `/v1/messagesX`
 * never match. A later slice widens a lease list only with engine
 * contract-test evidence. A server lease also gets its upstream's
 * `serverAllowed`: v06's usage routes, `/anthropic`'s `GET /api/oauth/usage`
 * and `/chatgpt`'s wham routes, which an engine lease never reaches.
 *
 * The token routes, `/anthropic` and `/anthropic-mcp`, are marked
 * `machinePaths: "open"`: there the machine kind (a request without a lease,
 * Task-1430 R2′) is governed by `machinePaths.ts` instead, any method and
 * path the floors and the mode pass. `/anthropic-mcp` has no lease list, so
 * no engine or server lease reaches it. `/chatgpt`'s machine kind keeps its
 * engine list.
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
  host: UpstreamHost;
  label: UpstreamLabel;
  allowed: readonly { method: string; pathname: string }[];
  /** What only a server lease reaches besides `allowed`. */
  serverAllowed: readonly { method: string; pathname: string }[];
  /** A token route: the machine kind follows `machinePaths.ts`. */
  machinePaths?: "open";
}

/** The fixed hosts the provider routes name. */
export type UpstreamHost =
  "api.anthropic.com" | "mcp-proxy.anthropic.com" | "chatgpt.com";

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
    allowed: [
      { method: "POST", pathname: "/v1/messages" },
      { method: "POST", pathname: "/v1/messages/count_tokens" },
    ],
    // The server's Claude usage read (G4b); never refreshed.
    serverAllowed: [{ method: "GET", pathname: "/api/oauth/usage" }],
    machinePaths: "open",
  },
  {
    // Claude Code's remote MCP connectors; machine requests only. Shares the
    // `claude` pool, and `routeFor` never confuses it with `/anthropic`.
    kind: "provider",
    prefix: "/anthropic-mcp",
    provider: "claude",
    host: "mcp-proxy.anthropic.com",
    label: "Anthropic MCP",
    allowed: [],
    serverAllowed: [],
    machinePaths: "open",
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
