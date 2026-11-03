/**
 * The model listener's request handling (`docs/workers.md` "Credentials").
 *
 * Order: route by prefix, then the lease, then the route's allowlist and the
 * lease's provider, then the credential, then the upstream. Bytes pass through
 * unchanged both ways: compressed bodies are never decoded, and SSE streams as
 * it arrives. Both directions use `pipe`, so a client that stops reading holds
 * the upstream back instead of growing this process's memory. Only the
 * credential headers are replaced, and `set-cookie` never reaches the engine.
 *
 * A log line names the provider, method, pathname (no query), lease id, outcome
 * and duration. No line holds a credential, lease token, query or body.
 */
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { readCredential } from "./profileCredential.ts";
import type { LeaseProvider, LeaseTable } from "./leases.ts";
import {
  refusalResponse,
  type Refusal,
  type RefusalShape,
} from "./refusals.ts";
import { isAllowed, routeFor, type Route } from "./upstreams.ts";

/** Where to connect for an upstream instead of its logical host (tests). */
export type UpstreamOverrides = Partial<
  Record<
    LeaseProvider,
    { connect: { host: string; port: number }; ca?: string | string[] }
  >
>;

export interface GatewayStats {
  forwarded: number;
  refused: number;
  clientClosed: number;
  upstreamErrors: number;
}

interface ForwarderDeps {
  leases: LeaseTable;
  log: (line: string) => void;
  agent: https.Agent;
  upstreams: UpstreamOverrides;
  stats: GatewayStats;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const LOGGED_PATH_CHARS = 80;
const LOGGED_CLIENT_CHARS = 120;
/** Distinct clients logged; later ones are not, so the set stays bounded. */
const MAX_LOGGED_CLIENTS = 256;

/** `headers` without hop-by-hop, `proxy-*`, `Connection`-listed and `drop` names. */
function forwardable(
  headers: http.IncomingHttpHeaders,
  drop: readonly string[],
): http.OutgoingHttpHeaders {
  const listed = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  const dropped = new Set([...HOP_BY_HOP, ...listed, ...drop]);
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !dropped.has(name) && !name.startsWith("proxy-"))
      out[name] = value;
  return out;
}

function bearerOf(header: string | undefined): string | undefined {
  return header ? /^Bearer +(\S+)$/i.exec(header)?.[1] : undefined;
}

/** A Node error code for the log and refusal text, never an error message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "connection failed";
}

function quoted(text: string, max: number): string {
  return JSON.stringify(text.slice(0, max));
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

function shapeOf(route: Route | undefined): RefusalShape {
  return route?.upstream.provider === "openai-codex" ? "codex" : "claude";
}

function refusalCase(refusal: Refusal): string {
  switch (refusal.case) {
    case "revoked-lease":
      return `revoked-lease (${refusal.reason})`;
    case "credential":
      return `credential (${refusal.problem})`;
    case "unreachable":
      return `unreachable (${refusal.reason})`;
    default:
      return refusal.case;
  }
}

export function createForwarder(deps: ForwarderDeps): {
  handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex) => void;
} {
  const { leases, log, agent, stats } = deps;
  const loggedClients = new Set<string>();

  /** Logs the first request of each distinct client, bounded and quoted. */
  function noteClient(headers: http.IncomingHttpHeaders): void {
    const userAgent = headerText(headers["user-agent"]);
    const originator = headerText(headers.originator);
    const key = `${userAgent}\n${originator}`;
    if (loggedClients.has(key) || loggedClients.size >= MAX_LOGGED_CLIENTS)
      return;
    loggedClients.add(key);
    log(
      `client user-agent=${quoted(userAgent, LOGGED_CLIENT_CHARS)} originator=${quoted(originator, LOGGED_CLIENT_CHARS)}`,
    );
  }

  /** One log line per request, written once whichever path ends it. */
  function requestLog(
    req: http.IncomingMessage,
    route: Route | undefined,
  ): (outcome: string, leaseId?: string) => void {
    const started = Date.now();
    const url = req.url ?? "";
    const pathname = route?.pathname ?? url.split("?")[0] ?? "";
    let logged = false;
    return (outcome, leaseId) => {
      if (logged) return;
      logged = true;
      const lease = leaseId ? ` lease=${leaseId}` : "";
      log(
        `${route?.upstream.provider ?? "-"} ${req.method} ${quoted(pathname, LOGGED_PATH_CHARS)}${lease} ${outcome} ${Date.now() - started}ms`,
      );
    };
  }

  function refuse(
    res: http.ServerResponse,
    shape: RefusalShape,
    refusal: Refusal,
    done: (outcome: string, leaseId?: string) => void,
    leaseId?: string,
  ): void {
    stats.refused += 1;
    const { status, body } = refusalResponse(refusal, shape);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    done(`refused ${refusalCase(refusal)} ${status}`, leaseId);
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route | undefined,
    done: (outcome: string, leaseId?: string) => void,
  ): Promise<void> {
    if (!route) return refuse(res, "claude", { case: "unknown-prefix" }, done);
    const shape = shapeOf(route);
    const lease = leases.verify(bearerOf(req.headers.authorization));
    if (!lease.ok)
      return lease.refusal === "revoked"
        ? refuse(
            res,
            shape,
            { case: "revoked-lease", reason: lease.reason },
            done,
            lease.leaseId,
          )
        : refuse(res, shape, { case: "unknown-lease" }, done);
    const { leaseId, binding } = lease;
    if (
      binding.provider !== route.upstream.provider ||
      !isAllowed(route, req.method)
    )
      return refuse(res, shape, { case: "forbidden" }, done, leaseId);
    const credential = await readCredential(
      binding.provider,
      binding.tokenFile,
    );
    if (!credential.ok)
      return refuse(
        res,
        shape,
        { case: "credential", problem: credential.problem },
        done,
        leaseId,
      );
    if (res.destroyed) {
      stats.clientClosed += 1;
      return done("client closed", leaseId);
    }
    forward(
      req,
      res,
      route,
      credential.headers,
      (outcome) => done(outcome, leaseId),
      (refusal) => refuse(res, shape, refusal, done, leaseId),
    );
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route,
    credentialHeaders: Record<string, string>,
    done: (outcome: string) => void,
    refuseLocally: (refusal: Refusal) => void,
  ): void {
    const { upstream } = route;
    const override = deps.upstreams[upstream.provider];
    const replaced = ["host", "authorization", "x-api-key"];
    if (upstream.provider === "openai-codex")
      replaced.push("chatgpt-account-id");
    let ended: "client" | "upstream" | undefined;

    const upstreamReq = https.request({
      host: override?.connect.host ?? upstream.host,
      port: override?.connect.port ?? 443,
      servername: upstream.host,
      method: req.method,
      path: route.path,
      headers: {
        ...forwardable(req.headers, replaced),
        host: upstream.host,
        ...credentialHeaders,
      },
      agent,
      ...(override?.ca ? { ca: override.ca } : {}),
    });

    /** The upstream failed after headers: the engine sees a truncated stream. */
    const failAfterHeaders = (err?: unknown): void => {
      if (ended) return;
      ended = "upstream";
      stats.upstreamErrors += 1;
      res.destroy();
      done(`upstream error after headers (${errorCode(err)})`);
    };

    upstreamReq.on("response", (upstreamRes) => {
      if (ended) {
        upstreamRes.destroy();
        return;
      }
      // An abort surfaces as `close` before `complete`; the error adds nothing.
      upstreamRes.on("error", () => {});
      upstreamRes.on("close", () => {
        if (!upstreamRes.complete) failAfterHeaders();
      });
      const status = upstreamRes.statusCode ?? 502;
      stats.forwarded += 1;
      res.writeHead(status, forwardable(upstreamRes.headers, ["set-cookie"]));
      res.on("finish", () => done(String(status)));
      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (ended) return;
      if (res.headersSent) return failAfterHeaders(err);
      ended = "upstream";
      stats.upstreamErrors += 1;
      req.unpipe(upstreamReq);
      refuseLocally({
        case: "unreachable",
        upstream: upstream.label,
        reason: errorCode(err),
      });
    });

    // A client that closes first is a normal end (an engine stops reading
    // once it has the answer): cancel the upstream, log no upstream error.
    res.on("close", () => {
      if (ended || res.writableFinished) return;
      ended = "client";
      stats.clientClosed += 1;
      upstreamReq.destroy();
      done("client closed");
    });
    res.on("error", () => upstreamReq.destroy());
    req.on("error", () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  return {
    handleRequest(req, res) {
      noteClient(req.headers);
      const route = routeFor(req.url ?? "");
      const done = requestLog(req, route);
      handle(req, res, route, done).catch((err: unknown) => {
        done(`internal error (${errorCode(err)})`);
        if (res.headersSent) res.destroy();
        else res.writeHead(500).end();
      });
    },

    // WebSocket is refused without contacting upstream: engines use SSE.
    handleUpgrade(req, socket) {
      noteClient(req.headers);
      const route = routeFor(req.url ?? "");
      const done = requestLog(req, route);
      stats.refused += 1;
      const refusal: Refusal = { case: "websocket" };
      const { status, body } = refusalResponse(refusal, shapeOf(route));
      socket.on("error", () => socket.destroy());
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      done(`refused ${refusalCase(refusal)} ${status}`);
    },
  };
}
