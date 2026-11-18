/**
 * The machine path's rules on the token routes (`docs/workers.md` "Machine
 * path", Task-1430 PR3): what a request without a lease may do on
 * `/anthropic` and `/anthropic-mcp`, whose fixed hosts are the only places
 * the account's token goes.
 *
 * In order: the method floor, the canonical-path rule, the deny floor, then
 * in strict mode only the listed templates. Permissive mode (the default)
 * forwards whatever passes the first three. Every rule reads the full raw
 * pathname after the prefix (Node does not normalise it), never the query.
 *
 * `listed` and `pathKey` mark each machine request's record against the
 * templates, whatever the mode. Pure and side-effect free.
 */
import type { Route } from "./upstreams.ts";

/** Whether the machine kind may forward unlisted paths. */
export type MachinePathMode = "permissive" | "strict";

/**
 * Methods that could reflect the request, and so the injected token, back
 * to the machine. TRACK never reaches a handler on Node or Bun (their HTTP
 * parsers reject it with a 400); it stays here in case a runtime admits it.
 */
const METHOD_FLOOR: ReadonlySet<string> = new Set([
  "TRACE",
  "TRACK",
  "CONNECT",
]);

/** Whether a method is refused on the token routes before any path rule. */
function isFloorMethod(method: string | undefined): boolean {
  return method !== undefined && METHOD_FLOOR.has(method);
}

/** Hex digits of a percent-escape. */
const HEX_RE = /^[0-9A-Fa-f]{2}$/;
/** Characters a percent-escape must never encode: unreserved, `/`, `\`, `%`. */
const NEVER_ENCODED_RE = /^[A-Za-z0-9\-._~/\\%]$/;

/**
 * The canonical-path rule: a pathname of non-empty segments, none `.` or
 * `..`, without `\`, whose every `%` starts an escape of a byte that is not
 * unreserved, `/`, `\` or `%`. So an encoded letter, separator or a double
 * encoding cannot disguise a floor path, and a trailing `/` or `//` fails.
 */
export function isCanonicalPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname.includes("\\")) return false;
  for (const segment of pathname.slice(1).split("/"))
    if (segment === "" || segment === "." || segment === "..") return false;
  for (
    let i = pathname.indexOf("%");
    i >= 0;
    i = pathname.indexOf("%", i + 1)
  ) {
    const hex = pathname.slice(i + 1, i + 3);
    if (!HEX_RE.test(hex)) return false;
    if (NEVER_ENCODED_RE.test(String.fromCharCode(Number.parseInt(hex, 16))))
      return false;
  }
  return true;
}

interface DenyEntry {
  id: string;
  /** Lower-case literal segments; `*` matches exactly one segment. */
  segments: readonly string[];
  /** The endpoint and everything below it, never a textual prefix. */
  descendants: boolean;
}

const entry = (id: string, path: string): DenyEntry => ({
  id,
  segments: path.split("/"),
  descendants: true,
});

/**
 * The deny floor (v03 C8): credential and API-key endpoints and access
 * grants, refused in both modes. Each reason is in `docs/workers.md`.
 */
const DENY_FLOOR: readonly DenyEntry[] = [
  entry("v1-oauth", "v1/oauth"),
  entry("oauth-token", "api/oauth/token"),
  entry("oauth-authorize", "api/oauth/authorize"),
  entry("oauth-revoke", "api/oauth/revoke"),
  entry("cli-create-api-key", "api/oauth/claude_cli/create_api_key"),
  entry("v1-org-api-keys", "v1/organizations/api_keys"),
  entry("v1-org-x-api-keys", "v1/organizations/*/api_keys"),
  entry("org-x-api-keys", "api/organizations/*/api_keys"),
  entry("v1-org-invites", "v1/organizations/invites"),
  entry("v1-org-users", "v1/organizations/users"),
  entry("v1-org-x-invites", "v1/organizations/*/invites"),
  entry("v1-org-x-users", "v1/organizations/*/users"),
  entry("org-x-invites", "api/organizations/*/invites"),
  entry("org-x-members", "api/organizations/*/members"),
  entry("api-auth", "api/auth"),
];

/** The deny-floor entry a canonical pathname falls under, by id. */
export function deniedBy(pathname: string): string | undefined {
  const segments = pathname.slice(1).toLowerCase().split("/");
  for (const { id, segments: floor, descendants } of DENY_FLOOR) {
    if (segments.length < floor.length) continue;
    if (!descendants && segments.length !== floor.length) continue;
    if (floor.every((part, i) => part === "*" || part === segments[i]))
      return id;
  }
  return undefined;
}

/** `:uuid`: the lower-case canonical 8-4-4-4-12 hex form only. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `:slug`: never `.` or `..`, and never a percent-escape. */
const SLUG_RE = /^[A-Za-z0-9._-]{1,128}$/;

interface Template {
  method: string;
  /** The template text: literal segments, `:uuid` or `:slug`. */
  path: string;
}

/**
 * The listed templates per token route, from captured evidence (Claude Code
 * 2.1.327, capture E1 of 2026-11-18; `domain_info` from F1). The eval key is
 * the public feature-flag client key compiled into that release, seen in
 * all three captures; a release that changes it logs as unlisted. Marking
 * data only: in permissive mode an unlisted path is forwarded too.
 */
const LISTED: Readonly<Record<string, readonly Template[]>> = {
  "/anthropic": [
    { method: "POST", path: "/v1/messages" },
    { method: "POST", path: "/v1/messages/count_tokens" },
    { method: "POST", path: "/api/oauth/validate" },
    { method: "GET", path: "/api/claude_cli/bootstrap" },
    { method: "POST", path: "/api/eval/sdk-zAZezfDKGoZuXXKe" },
    { method: "GET", path: "/api/claude_code_penguin_mode" },
    { method: "GET", path: "/api/claude_code/policy_limits" },
    { method: "GET", path: "/api/claude_code/settings" },
    { method: "GET", path: "/api/organizations/:uuid/model_selector/cc" },
    { method: "GET", path: "/api/oauth/organizations/:uuid/marketplaces" },
    {
      method: "GET",
      path: "/api/oauth/organizations/:uuid/plugins/list-plugins",
    },
    {
      method: "GET",
      path: "/api/oauth/organizations/:uuid/plugins/:slug/download",
    },
    {
      method: "GET",
      path: "/api/oauth/organizations/:uuid/skills/list-skills",
    },
    {
      method: "GET",
      path: "/api/oauth/organizations/:uuid/skills/:slug/download",
    },
    { method: "GET", path: "/v1/mcp_servers" },
    { method: "POST", path: "/api/artifacts/mcp" },
    { method: "GET", path: "/api/oauth/usage" },
    { method: "POST", path: "/api/event_logging/v2/batch" },
    { method: "POST", path: "/api/claude_code/metrics" },
    { method: "GET", path: "/api/directory/server-urls" },
    { method: "GET", path: "/api/web/domain_info" },
  ],
  "/anthropic-mcp": [{ method: "POST", path: "/v1/mcp/:slug" }],
};

function segmentMatches(template: string, segment: string): boolean {
  if (template === ":uuid") return UUID_RE.test(segment);
  if (template === ":slug")
    return SLUG_RE.test(segment) && segment !== "." && segment !== "..";
  return template === segment;
}

/** The listed template a request matches, compared exactly, or undefined. */
export function listedTemplate(
  prefix: string,
  method: string | undefined,
  pathname: string,
): string | undefined {
  const segments = pathname.split("/");
  for (const template of LISTED[prefix] ?? []) {
    if (template.method !== method) continue;
    const parts = template.path.split("/");
    if (
      parts.length === segments.length &&
      parts.every((part, i) => segmentMatches(part, segments[i]!))
    )
      return template.path;
  }
  return undefined;
}

/** A token route: its fixed host takes any machine path the rules pass. */
export function isTokenRoute(route: Route | undefined): route is Route {
  return (
    route?.upstream.kind === "provider" &&
    route.upstream.machinePaths === "open"
  );
}

/**
 * The record's marking of a token-route machine request: listed only when
 * it would pass the floors and matches a template; `pathKey` is the
 * template, else the pathname.
 */
export function classifyMachinePath(
  route: Route,
  method: string | undefined,
): { listed: boolean; pathKey: string } {
  const { pathname } = route;
  const unlisted = { listed: false, pathKey: pathname };
  if (
    isFloorMethod(method) ||
    !isCanonicalPath(pathname) ||
    deniedBy(pathname) !== undefined
  )
    return unlisted;
  const template = listedTemplate(route.upstream.prefix, method, pathname);
  return template === undefined
    ? unlisted
    : { listed: true, pathKey: template };
}

/** Why a token-route machine request is refused, or undefined to forward. */
export type MachinePathRefusal =
  | { case: "denied"; id: string }
  | { case: "non-canonical-path" }
  | { case: "forbidden" };

/**
 * The machine path's verdict on a token route: the method floor, the
 * canonical rule, the deny floor, then in strict mode the templates.
 */
export function machinePathVerdict(
  route: Route,
  method: string | undefined,
  mode: MachinePathMode,
): MachinePathRefusal | undefined {
  if (isFloorMethod(method)) return { case: "denied", id: "method" };
  const { pathname } = route;
  if (!isCanonicalPath(pathname)) return { case: "non-canonical-path" };
  const id = deniedBy(pathname);
  if (id !== undefined) return { case: "denied", id };
  if (
    mode === "strict" &&
    listedTemplate(route.upstream.prefix, method, pathname) === undefined
  )
    return { case: "forbidden" };
  return undefined;
}
