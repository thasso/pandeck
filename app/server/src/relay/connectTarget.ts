/**
 * Which CONNECT the relay decrypts (Task-1430, ADR-0006): the named domains,
 * the two token hosts and their fixed gateway routes, and the one decision
 * over a raw CONNECT target. Pure; imports only `node:` modules.
 *
 * A target is decrypted only when it is a DNS name (never an IP literal), it
 * equals a named domain or ends in `.` plus one, and its port is 443. A token
 * host goes to its fixed gateway route; every other named host is observed:
 * forwarded directly to itself on 443 (`observedTraffic.ts`). Every other
 * valid target is a blind tunnel. The target is validated before
 * anything is decided, so a query, userinfo, path or bad port never becomes a
 * host that is recorded or logged.
 */
import net from "node:net";

/** The domains the interception CA may name and the relay may decrypt. */
export const NAMED_DOMAINS: readonly string[] = [
  "anthropic.com",
  "claude.ai",
  "claude.com",
];

/**
 * The token hosts and the edge route each goes to, fixed in relay code: a
 * request chooses neither its upstream nor its profile.
 */
const TOKEN_HOSTS: ReadonlyMap<string, string> = new Map([
  ["api.anthropic.com", "/anthropic"],
  ["mcp-proxy.anthropic.com", "/anthropic-mcp"],
]);

/** Why the relay refuses a CONNECT to a named host itself (recorded). */
type ConnectRefusal = "connect-port" | "connect-target";

export type ConnectDecision =
  /** Decrypt and send to the edge's `route`; `host` is a token host. */
  | { kind: "intercept"; host: string; route: string }
  /** Decrypt and forward directly to `host:443`; never a token host. */
  | { kind: "observe"; host: string }
  /** Pipe bytes to `host:port` untouched; `port` is always 1-65535. */
  | { kind: "tunnel"; host: string; port: number }
  /** A named host refused locally; `host` is validated and lower-case. */
  | { kind: "refuse"; reason: ConnectRefusal; host: string }
  /** Not a valid authority: a marked 400, never recorded or echoed. */
  | { kind: "malformed" };

const SHAPE =
  /^(?:\[([0-9A-Fa-f:.]{2,45})\]|([A-Za-z0-9.-]{1,254})):([0-9]{1,5})$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isNamed(name: string): boolean {
  return NAMED_DOMAINS.some(
    (domain) => name === domain || name.endsWith(`.${domain}`),
  );
}

function validDnsName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 253 &&
    name.split(".").every((label) => LABEL.test(label))
  );
}

/** The decision for one raw CONNECT request target (`host:port`). */
export function connectTarget(authority: string): ConnectDecision {
  const shape = SHAPE.exec(authority);
  if (!shape) return { kind: "malformed" };
  const [, bracketed, bare, digits] = shape;
  const port = Number(digits);
  const portOk = port >= 1 && port <= 65535;
  if (bracketed !== undefined)
    return net.isIPv6(bracketed) && portOk
      ? { kind: "tunnel", host: bracketed, port }
      : { kind: "malformed" };
  const raw = bare!;
  if (net.isIPv4(raw))
    return portOk ? { kind: "tunnel", host: raw, port } : { kind: "malformed" };
  const lower = raw.toLowerCase();
  const trailingDot = lower.endsWith(".");
  const name = trailingDot ? lower.slice(0, -1) : lower;
  if (!validDnsName(name)) return { kind: "malformed" };
  if (isNamed(name)) {
    if (trailingDot)
      return { kind: "refuse", reason: "connect-target", host: name };
    if (port !== 443)
      return { kind: "refuse", reason: "connect-port", host: name };
    const route = TOKEN_HOSTS.get(name);
    return route
      ? { kind: "intercept", host: name, route }
      : { kind: "observe", host: name };
  }
  return portOk ? { kind: "tunnel", host: lower, port } : { kind: "malformed" };
}
