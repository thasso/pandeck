/**
 * The model listener's request handling (`docs/workers.md` "Credentials").
 *
 * Order: route by prefix, then the lease, then the route's allowlist and the
 * lease's provider, then the credential, then the upstream. The credential
 * comes from the vault (`vaultPort.ts`): a token about to expire is renewed
 * first, a dead or absent login gets U7's needs-login refusal, and an
 * upstream 401 may force one renewal while it passes through. A provider route
 * refuses a lease of an OpenAI-compatible profile. `/compat` instead takes
 * only an engine or server lease of an OpenAI-compatible profile, then one
 * snapshot of the endpoint pushed for that lease's own profile (503 without
 * one), then its allowlist, and sends that profile's pushed key over http or
 * https as the push says; it reads no token file. The profile comes from the
 * lease alone, so a lease for one account never reaches another's key. A
 * request keeps its snapshot, so a push meanwhile never mixes an origin with
 * another's key. Bytes pass through
 * unchanged both ways: compressed bodies are never decoded, and SSE streams as
 * it arrives. Both directions use `pipe`, so a client that stops reading holds
 * the upstream back instead of growing this process's memory. Only the
 * credential headers are replaced, and `set-cookie` never reaches the engine.
 *
 * On a client's model port, a bearer that is not lease-shaped, or none, takes
 * the machine path (Task-1424, `machinePool.ts`): only a loopback `Host` and no
 * `Origin`, only the engine routes of `/anthropic` and `/chatgpt`, then the
 * client's pool picks and pins the account and its machine lease. After the
 * credential wait the selection must still hold (client active, lease live,
 * pin and profile unchanged and usable); it is re-selected once, and a second
 * change is refused. The upstream's status and raw headers on a model-run
 * route, from any lease kind, feed the pool's benches; a failure there is
 * logged and never reaches the response.
 *
 * A log line names the provider, method, pathname (no query), lease id, outcome
 * and duration, then the outcome's class and `via=gateway`; on a client's port
 * also the lease kind and the client id. No line holds a credential, lease
 * token, session key, query or body. On a client's port the same request also
 * becomes one record in the request log (`requestLog.ts`), which writes the
 * line. Each body passes one counting Transform (`req → count → upstream`,
 * `upstream → count → res`) that reads only a chunk's length; backpressure
 * crosses it as any pipe's, and an error or close on either side destroys
 * every link. From admission the request's own `close` listener owns its
 * end: a client that closes during the credential wait is recorded failed at
 * once, and what settles later neither answers nor contacts the upstream. A
 * client that closes before its answer ended is failed, its status kept.
 */
import http from "node:http";
import https from "node:https";
import { Transform, type Duplex } from "node:stream";
import type { CompatTarget, CompatUpstream } from "./compatUpstream.ts";
import {
  isLeaseShaped,
  type LeaseCheck,
  type LeaseOwnership,
  type LeaseProvider,
  type LeaseTable,
  type LoginBinding,
} from "./leases.ts";
import {
  isModelRun,
  pinKeyOf,
  type MachinePool,
  type MachineSelection,
} from "./machinePool.ts";
import {
  classifyClientCredential,
  hasClientCookie,
} from "./requestCredential.ts";
import type { RequestEntry, RequestLog, RequestOutcome } from "./requestLog.ts";
import {
  refusalResponse,
  type Refusal,
  type RefusalShape,
  type UpstreamLabel,
} from "./refusals.ts";
import {
  isAllowed,
  isCompatAllowed,
  routeFor,
  type Route,
} from "./upstreams.ts";
import type { VaultCredential, VaultPort } from "./vaultPort.ts";

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
  /** For a plain-HTTP compatible endpoint. */
  httpAgent: http.Agent;
  upstreams: UpstreamOverrides;
  compat: CompatUpstream;
  /** Test seam: the CA an https compatible endpoint is checked against. */
  compatCa: string | string[] | undefined;
  stats: GatewayStats;
  vault: Pick<VaultPort, "credentialFor" | "upstream401">;
  /**
   * The enrolled client a request came from, on the edge's mutual-TLS port;
   * absent on the loopback listener. A lease is spent only by its own client,
   * and a client's lease only on that port.
   */
  clientOf?: (req: http.IncomingMessage) => string | undefined;
  /**
   * The machine path, on a client's port only: non-lease requests are served
   * from the client's user's pool.
   */
  machine?: MachineAccess | undefined;
  /** Model-run evidence from any lease kind, for the pool's benches. */
  observe?: MachinePool["observe"] | undefined;
  /** On a client's port: where each admitted request's record goes. */
  requests?: RequestRecorder | undefined;
}

/** The request log and the registry name of an account, for records. */
interface RequestRecorder {
  log: Pick<RequestLog, "record">;
  accountName: (profileId: string) => string | undefined;
}

/**
 * The client a request came from, as the client listener admitted it at the
 * request's start: a revocation while it waits does not lose its record.
 */
export interface AdmittedClient {
  id: string;
  label: string;
  userId: string;
}

/** A request the client listener answers itself, being observed. */
export interface LocalAnswer {
  /** Marks the answer a local refusal, `reason` a fixed code. */
  refuse(reason: string): void;
}

/** A body chunk's length as `write` and `end` take it, else 0. */
function chunkBytes(chunk: unknown, encoding: unknown): number {
  if (typeof chunk === "string")
    return Buffer.byteLength(
      chunk,
      typeof encoding === "string" && Buffer.isEncoding(encoding)
        ? encoding
        : "utf8",
    );
  return chunk instanceof Uint8Array ? chunk.byteLength : 0;
}

/**
 * Counts the body bytes a local handler writes to `res`: its own `write` and
 * `end` read each chunk's length and pass every call on unchanged.
 */
function countAnswer(res: http.ServerResponse, add: (n: number) => void): void {
  const { write, end } = res;
  res.write = ((...args: unknown[]) => {
    add(chunkBytes(args[0], args[1]));
    return Reflect.apply(write, res, args) as boolean;
  }) as typeof res.write;
  res.end = ((...args: unknown[]) => {
    add(chunkBytes(args[0], args[1]));
    return Reflect.apply(end, res, args) as http.ServerResponse;
  }) as typeof res.end;
}

/**
 * A pass-through link that adds each chunk's length and keeps nothing: its
 * buffer is a Transform's, so a slow reader still holds the writer back.
 */
function byteCounter(add: (n: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      add(chunk.length);
      callback(null, chunk);
    },
  });
}

/**
 * Counts the body bytes read from `req`, by whichever reader: its `emit`
 * reads each `data` chunk's length and passes every event on unchanged, so
 * the stream's mode and its reader's flow stay as they were.
 */
function countRead(req: http.IncomingMessage, add: (n: number) => void): void {
  const { emit } = req;
  req.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (event === "data") add(chunkBytes(args[0], undefined));
    return Reflect.apply(emit, req, [event, ...args]) as boolean;
  }) as typeof req.emit;
}

/** Fixed reasons for the statuses a local answer is known to send. */
const LOCAL_REASONS: Readonly<Record<number, string>> = {
  400: "bad-request",
  405: "method-not-allowed",
  413: "too-large",
  500: "internal-error",
  504: "timeout",
};

/** A local answer sent in full, classed by its status. */
function answerEnding(status: number): Ending {
  if (status < 400)
    return { text: String(status), outcome: "forwarded", status };
  const refused = status < 500;
  const reason =
    LOCAL_REASONS[status] ?? (refused ? "client-error" : "server-error");
  return {
    text: `${refused ? "refused" : "failed"} ${reason} ${status}`,
    outcome: refused ? "refused" : "failed",
    status,
    reason,
  };
}

/** What the machine path needs from the client listener. */
export interface MachineAccess {
  pool: Pick<MachinePool, "select" | "isCurrent" | "observe">;
  /**
   * The user of the request's client while that client is active with its
   * certificate, else undefined; throws when the registry cannot be read.
   */
  userOf: (req: http.IncomingMessage) => string | undefined;
}

/** How a request ended, for its log line and its record. */
interface Ending {
  /** The line's outcome as before: `200`, `refused forbidden 403`, … */
  text: string;
  outcome: RequestOutcome;
  /** What the client was answered, or null when it got no status. */
  status: number | null;
  /** A fixed code, never request or upstream text. */
  reason?: string;
}

/**
 * One request's bookkeeping. `end` takes effect once, whichever path ends
 * the request first; the counters only grow until then.
 */
interface Trace {
  /** The machine path's; otherwise the held lease's kind. */
  kind?: LeaseOwnership["kind"];
  /**
   * Marks `profileId` the account the request spends, once it is the
   * client's own: its registry label is read now, so a profile renamed or
   * removed while the request streams does not change the record. A
   * re-selection calls it again; the last call names the account.
   */
  spend(profileId: string): void;
  /** The lease the request holds, once known: a client-close line names it. */
  leaseId?: string;
  /** The logical upstream host; `""` before one is known. */
  host: string;
  /** The status sent to the client, once its headers are written. */
  status?: number;
  /** Request body bytes read from the client toward the upstream. */
  requestBytes: number;
  /** Response body bytes sent to the client, a local refusal's included. */
  responseBytes: number;
  /** Whether `end` already took effect. */
  readonly ended: boolean;
  end(ending: Ending, leaseId?: string): void;
}

/** Where a request goes once it is allowed, credential included. */
interface Destination {
  secure: boolean;
  /** Where to connect, and the TLS options; no method, path or headers. */
  options: https.RequestOptions;
  /** The `Host` header: the logical host, never the connect address. */
  host: string;
  /** Request headers replaced, besides `host` and the credential's. */
  replaced: readonly string[];
  credentialHeaders: Record<string, string>;
  label: UpstreamLabel;
  /**
   * Called with the upstream's status and raw headers (repeats kept) once
   * its headers arrive. A throw is logged, never answered.
   */
  onResponse?: (status: number, rawHeaders: readonly string[]) => void;
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

/**
 * A response's raw header fields, in order and with every repeat, without
 * the names `forwardable` drops: a harness reads a provider's answer
 * unchanged, a repeated `retry-after` included.
 */
function forwardableRaw(
  rawHeaders: readonly string[],
  drop: readonly string[],
): string[] {
  const listed: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "connection")
      for (const name of rawHeaders[i + 1]!.split(","))
        listed.push(name.trim().toLowerCase());
  const dropped = new Set([...HOP_BY_HOP, ...listed, ...drop]);
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (!dropped.has(name) && !name.startsWith("proxy-"))
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  }
  return out;
}

/** A loopback `Host`: exactly these names, any case, an optional port. */
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/**
 * Whether a machine request came from a local tool, read from the raw
 * headers so a repeat is seen: no `Origin` at all (a browser page sends one)
 * and exactly one `Host` naming loopback, so a DNS-rebound name is refused.
 */
function isLoopbackOnly(rawHeaders: readonly string[]): boolean {
  let hosts = 0;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (name === "origin") return false;
    if (name !== "host") continue;
    hosts += 1;
    if (!LOOPBACK_HOST_RE.test(rawHeaders[i + 1]!)) return false;
  }
  return hosts === 1;
}

function bearerOf(header: string | undefined): string | undefined {
  return header ? /^Bearer +(\S+)$/i.exec(header)?.[1] : undefined;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A Node error code for the log and refusal text, never an error message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && CODE_RE.test(code)
    ? code
    : "connection failed";
}

function quoted(text: string, max: number): string {
  return JSON.stringify(text.slice(0, max));
}

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : (value ?? "");
}

/** Codex and the compatible endpoint both take the OpenAI error shape. */
function shapeOf(route: Route | undefined): RefusalShape {
  return !route || route.upstream.provider === "claude" ? "claude" : "codex";
}

function refusalCase(refusal: Refusal): string {
  switch (refusal.case) {
    case "revoked-lease":
      return `revoked-lease (${refusal.reason})`;
    case "credential":
      return `credential (${refusal.problem})`;
    case "needs-login":
      return "needs-login";
    case "unreachable":
      return `unreachable (${refusal.reason})`;
    default:
      return refusal.case;
  }
}

export function createForwarder(deps: ForwarderDeps): {
  /** `admitted`: on a client's port, the client the listener admitted. */
  handleRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    admitted?: AdmittedClient,
  ) => void;
  handleUpgrade: (req: http.IncomingMessage, socket: Duplex) => void;
  observeLocal: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    admitted?: AdmittedClient,
  ) => LocalAnswer;
} {
  const { leases, log, agent, httpAgent, compat, stats } = deps;
  const loggedClients = new Set<string>();

  /**
   * Logs the first request of each distinct client, bounded and quoted.
   * Loopback only: on a client's port these headers are the client's own
   * text, and its request is identified by its record (Task-1430).
   */
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

  /**
   * One line per request, and on a client's port one record, written once
   * whichever path ends it. On a client's port the line names the lease kind
   * (the held lease's unless the machine path set it) and the client. What
   * the record needs of the request is read here, at its start: the
   * admitted client, the credential's class, whether a cookie came and the
   * session key's hash prefix, never a value.
   */
  function startTrace(
    req: http.IncomingMessage,
    route: Route | undefined,
    admitted: AdmittedClient | undefined,
  ): Trace {
    const started = Date.now();
    const url = req.url ?? "";
    const pathname = route?.pathname ?? url.split("?")[0] ?? "";
    const clientId = deps.clientOf?.(req);
    const { requests } = deps;
    const recording = requests && admitted;
    const credential = recording
      ? {
          clientCredential: classifyClientCredential(req.rawHeaders),
          clientCookie: hasClientCookie(req.rawHeaders),
        }
      : undefined;
    const session =
      recording && route?.upstream.kind === "provider"
        ? pinKeyOf(route.upstream.provider, req.rawHeaders)?.slice(0, 12)
        : undefined;
    let ended = false;
    let account: string | undefined;
    const trace: Trace = {
      host: route?.upstream.kind === "provider" ? route.upstream.host : "",
      requestBytes: 0,
      responseBytes: 0,
      get ended() {
        return ended;
      },
      spend(profileId) {
        if (!requests || !admitted || ended) return;
        try {
          account = requests.accountName(profileId);
        } catch (err) {
          account = undefined;
          log(`request account lookup failed (${errorCode(err)})`);
        }
      },
      end(ending, leaseId = trace.leaseId) {
        if (ended) return;
        ended = true;
        const durationMs = Date.now() - started;
        const lease = leaseId ? ` lease=${leaseId}` : "";
        const leaseKind =
          trace.kind ??
          (leaseId === undefined ? undefined : leases.kindOf(leaseId));
        const client = deps.clientOf
          ? ` kind=${leaseKind ?? "-"} client=${clientId ?? "-"}`
          : "";
        const line = `${route?.upstream.provider ?? "-"} ${req.method} ${quoted(pathname, LOGGED_PATH_CHARS)}${client}${lease} ${ending.text} ${durationMs}ms outcome=${ending.outcome} via=gateway`;
        if (!requests || !admitted || !credential) return log(line);
        const entry: RequestEntry = {
          userId: admitted.userId,
          client: { id: admitted.id, label: admitted.label },
          via: "gateway",
          at: started,
          host: trace.host,
          method: req.method ?? "",
          path: pathname,
          status: ending.status,
          outcome: ending.outcome,
          ...(ending.reason === undefined ? {} : { reason: ending.reason }),
          ...(account === undefined ? {} : { account }),
          ...(session === undefined ? {} : { session }),
          ...credential,
          requestBytes: trace.requestBytes,
          responseBytes: trace.responseBytes,
          durationMs,
        };
        try {
          requests.log.record(entry, line);
        } catch (err) {
          log(line);
          log(`request record failed (${errorCode(err)})`);
        }
      },
    };
    return trace;
  }

  /**
   * Ends a request whose client closed before its answer was complete: failed,
   * with the status already sent if any. A no-op once the request ended.
   */
  function clientClosed(res: http.ServerResponse, trace: Trace): void {
    if (trace.ended) return;
    stats.clientClosed += 1;
    trace.end({
      text: "client closed",
      outcome: "failed",
      status: trace.status ?? null,
      reason: "client-closed",
    });
    if (!res.destroyed) res.destroy();
  }

  /**
   * Whether the request is over before this step: its client closed (recorded
   * now if its `close` has not run yet) or another path ended it. A step that
   * finds it over writes nothing and contacts no upstream.
   */
  function gone(res: http.ServerResponse, trace: Trace): boolean {
    if (res.destroyed) clientClosed(res, trace);
    return trace.ended;
  }

  /** The ending of a local refusal: its case, an upgrade's as `upgrade`. */
  function refusalEnding(refusal: Refusal, status: number): Ending {
    const text = `refused ${refusalCase(refusal)} ${status}`;
    if (refusal.case === "unreachable")
      return {
        text,
        outcome: "failed",
        status,
        reason: CODE_RE.test(refusal.reason) ? refusal.reason : "unreachable",
      };
    return {
      text,
      outcome: "refused",
      status,
      reason: refusal.case === "websocket" ? "upgrade" : refusal.case,
    };
  }

  function refuse(
    res: http.ServerResponse,
    shape: RefusalShape,
    refusal: Refusal,
    trace: Trace,
    leaseId?: string,
  ): void {
    if (gone(res, trace)) return;
    stats.refused += 1;
    const { status, body, retryAfter } = refusalResponse(refusal, shape);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(retryAfter === undefined
        ? {}
        : { "retry-after": String(retryAfter) }),
    });
    trace.status = status;
    trace.responseBytes += Buffer.byteLength(body);
    res.end(body);
    trace.end(refusalEnding(refusal, status), leaseId);
  }

  /** Runs response bookkeeping; a throw is logged, never answered. */
  function contained(what: string, run: () => void): void {
    try {
      run();
    } catch (err) {
      log(`${what} failed (${errorCode(err)})`);
    }
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route | undefined,
    trace: Trace,
  ): Promise<void> {
    if (!route) return refuse(res, "claude", { case: "unknown-prefix" }, trace);
    const shape = shapeOf(route);
    const bearer = bearerOf(req.headers.authorization);
    const clientId = deps.clientOf?.(req);
    // A client's request without a lease-shaped bearer is its machine's.
    if (deps.machine && clientId !== undefined && !isLeaseShaped(bearer))
      // Its kind is on the trace, so the caller's internal-error line keeps it.
      return serveMachine(req, res, route, clientId, deps.machine, trace);
    const refuseLease = (lease: Extract<LeaseCheck, { ok: false }>): void =>
      lease.refusal === "revoked"
        ? refuse(
            res,
            shape,
            { case: "revoked-lease", reason: lease.reason },
            trace,
            lease.leaseId,
          )
        : refuse(res, shape, { case: "unknown-lease" }, trace);
    const lease = leases.verify(bearer);
    if (!lease.ok) return refuseLease(lease);
    const { leaseId, binding } = lease;
    trace.leaseId = leaseId;
    if (leases.clientOf(leaseId) !== clientId)
      return refuse(res, shape, { case: "forbidden" }, trace, leaseId);
    // Only the client's own lease names its account in the record.
    trace.spend(binding.profileId);
    const { upstream } = route;
    if (upstream.kind === "compat") {
      // An engine or server lease of an OpenAI-compatible profile, never a
      // Codex or Claude lease of either kind.
      const kind = leases.kindOf(leaseId);
      if (
        (kind !== "engine" && kind !== "server") ||
        binding.provider !== "openai-compatible"
      )
        return refuse(res, shape, { case: "forbidden" }, trace, leaseId);
      const target = compat.current(binding.profileId);
      if (!target)
        return refuse(res, shape, { case: "compat-unset" }, trace, leaseId);
      trace.host = target.host;
      if (!isCompatAllowed(route, req.method, target.basePath))
        return refuse(res, shape, { case: "forbidden" }, trace, leaseId);
      return send(
        req,
        res,
        route,
        compatDestination(target),
        shape,
        trace,
        leaseId,
      );
    }
    if (
      binding.provider === "openai-compatible" ||
      binding.provider !== upstream.provider ||
      !isAllowed(route, req.method, leases.kindOf(leaseId))
    )
      return refuse(res, shape, { case: "forbidden" }, trace, leaseId);
    // A renewal may come first; a dead login is refused without upstream.
    const credential = await deps.vault.credentialFor(binding);
    // A client gone while it waited was recorded then; nothing more is sent.
    if (gone(res, trace)) return;
    // A revocation that arrived while it waited takes effect now.
    const still = leases.verify(bearer);
    if (!still.ok) return refuseLease(still);
    if (!credential.ok)
      return refuse(res, shape, credentialRefusal(credential), trace, leaseId);
    send(
      req,
      res,
      route,
      providerDestination(req, route, upstream, binding, credential),
      shape,
      trace,
      leaseId,
    );
  }

  /**
   * A machine request: loopback only, an engine route, then the pool's pick,
   * its credential and the final validation. A selection that changed while
   * the credential was read is re-selected once; a second change is refused
   * `machine-retry`, with no third credential read.
   */
  async function serveMachine(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route,
    clientId: string,
    machine: MachineAccess,
    trace: Trace,
  ): Promise<void> {
    const shape = shapeOf(route);
    // Every line of a machine request names its kind, an internal error's too.
    trace.kind = "machine";
    if (!isLoopbackOnly(req.rawHeaders))
      return refuse(res, shape, { case: "machine-origin" }, trace);
    const { upstream } = route;
    // Never `/compat`, and only the engine routes.
    if (
      upstream.kind !== "provider" ||
      !isAllowed(route, req.method, "machine")
    )
      return refuse(res, shape, { case: "forbidden" }, trace);
    const { provider } = upstream;
    const label = provider === "claude" ? "Claude" : "OpenAI";
    const pin = {
      clientId,
      provider,
      keyHash: pinKeyOf(provider, req.rawHeaders),
    };
    for (let attempt = 0; ; attempt += 1) {
      const userId = machine.userOf(req);
      if (userId === undefined)
        return refuse(res, shape, { case: "forbidden" }, trace);
      const outcome = machine.pool.select(userId, pin);
      if (!outcome.ok)
        return refuse(
          res,
          shape,
          outcome.refusal === "machine-pool-empty"
            ? { case: "machine-pool-empty", provider: label }
            : {
                case: "machine-session-limited",
                provider: label,
                retryAfterSeconds: outcome.retryAfterSeconds,
              },
          trace,
        );
      const { selection } = outcome;
      const { leaseId, binding } = selection;
      trace.leaseId = leaseId;
      trace.spend(binding.profileId);
      const credential = await deps.vault.credentialFor(binding);
      if (gone(res, trace)) return;
      // The final validation: what changed while it waited takes effect now.
      if (machine.userOf(req) !== userId)
        return refuse(res, shape, { case: "forbidden" }, trace, leaseId);
      // A dead login is a changed selection, never the vault's 401 here.
      const current =
        machine.pool.isCurrent(selection) &&
        (credential.ok ||
          "locked" in credential ||
          credential.refusal.case !== "needs-login");
      if (!current) {
        if (attempt === 0) continue;
        return refuse(res, shape, { case: "machine-retry" }, trace, leaseId);
      }
      if (!credential.ok)
        return refuse(
          res,
          shape,
          credentialRefusal(credential),
          trace,
          leaseId,
        );
      return send(
        req,
        res,
        route,
        providerDestination(
          req,
          route,
          upstream,
          binding,
          credential,
          selection,
        ),
        shape,
        trace,
        leaseId,
      );
    }
  }

  /** A failed credential read's refusal; a locked vault is no verdict. */
  function credentialRefusal(
    credential: Extract<VaultCredential, { ok: false }>,
  ): Refusal {
    return "locked" in credential
      ? { case: "vault-locked" }
      : credential.refusal;
  }

  /**
   * A provider upstream with the profile's credential. The upstream's answer
   * on a model-run route is the pool's evidence; a 401 is the vault's.
   */
  function providerDestination(
    req: http.IncomingMessage,
    route: Route,
    upstream: Extract<Route["upstream"], { kind: "provider" }>,
    binding: LoginBinding,
    credential: Extract<VaultCredential, { ok: true }>,
    selection?: MachineSelection,
  ): Destination {
    const override = deps.upstreams[upstream.provider];
    const evidence = isModelRun(upstream.provider, req.method, route.pathname)
      ? { provider: upstream.provider, profileId: binding.profileId, selection }
      : undefined;
    return {
      secure: true,
      options: {
        host: override?.connect.host ?? upstream.host,
        port: override?.connect.port ?? 443,
        servername: upstream.host,
        agent,
        ...(override?.ca ? { ca: override.ca } : {}),
      },
      host: upstream.host,
      replaced:
        upstream.provider === "openai-codex" ? ["chatgpt-account-id"] : [],
      credentialHeaders: credential.headers,
      label: upstream.label,
      onResponse: (status, rawHeaders) => {
        // The 401 passes through unchanged; renewal may force one (once).
        if (status === 401)
          contained("upstream 401 report", () =>
            deps.vault.upstream401(binding, credential.token),
          );
        const { observe } = deps;
        if (evidence && observe)
          contained("machine pool evidence", () =>
            observe(evidence, status, rawHeaders),
          );
      },
    };
  }

  /** The pushed endpoint as the snapshot names it, with the pushed key. */
  function compatDestination(target: CompatTarget): Destination {
    const secure = target.protocol === "https";
    return {
      secure,
      options: {
        host: target.hostname,
        port: target.port,
        agent: secure ? agent : httpAgent,
        ...(secure && target.servername !== undefined
          ? { servername: target.servername }
          : {}),
        ...(secure && deps.compatCa ? { ca: deps.compatCa } : {}),
      },
      host: target.host,
      replaced: [],
      credentialHeaders: { authorization: `Bearer ${target.apiKey}` },
      label: "the OpenAI-compatible endpoint",
    };
  }

  function send(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route,
    destination: Destination,
    shape: RefusalShape,
    trace: Trace,
    leaseId: string,
  ): void {
    if (gone(res, trace)) return;
    forward(
      req,
      res,
      route,
      destination,
      trace,
      (ending) => trace.end(ending, leaseId),
      (refusal) => refuse(res, shape, refusal, trace, leaseId),
    );
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: Route,
    destination: Destination,
    trace: Trace,
    done: (ending: Ending) => void,
    refuseLocally: (refusal: Refusal) => void,
  ): void {
    const { options } = destination;
    let ended: "client" | "upstream" | undefined;
    // Each body passes one counting link; every link below is torn down with
    // the request, whichever side ends it.
    const countIn = byteCounter((n) => (trace.requestBytes += n));
    const countOut = byteCounter((n) => (trace.responseBytes += n));

    const upstreamReq = (destination.secure ? https : http).request({
      ...options,
      method: req.method,
      path: route.path,
      headers: {
        ...forwardable(req.headers, [
          "host",
          "authorization",
          "x-api-key",
          ...destination.replaced,
        ]),
        host: destination.host,
        ...destination.credentialHeaders,
      },
    });

    /** The upstream failed after headers: the engine sees a truncated stream. */
    const failAfterHeaders = (err?: unknown): void => {
      if (ended) return;
      ended = "upstream";
      stats.upstreamErrors += 1;
      countOut.destroy();
      res.destroy();
      const code = errorCode(err);
      done({
        text: `upstream error after headers (${code})`,
        outcome: "failed",
        status: trace.status ?? null,
        reason: CODE_RE.test(code) ? code : "upstream-truncated",
      });
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
      const { onResponse } = destination;
      if (onResponse)
        contained("response bookkeeping", () =>
          onResponse(status, upstreamRes.rawHeaders),
        );
      res.writeHead(
        status,
        forwardableRaw(upstreamRes.rawHeaders, ["set-cookie"]),
      );
      trace.status = status;
      res.on("finish", () =>
        done({ text: String(status), outcome: "forwarded", status }),
      );
      countOut.on("error", (err) => failAfterHeaders(err));
      upstreamRes.pipe(countOut).pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (ended) return;
      if (res.headersSent) return failAfterHeaders(err);
      ended = "upstream";
      stats.upstreamErrors += 1;
      req.unpipe(countIn);
      countIn.destroy();
      refuseLocally({
        case: "unreachable",
        upstream: destination.label,
        reason: errorCode(err),
      });
    });

    // A client that closes before its answer ended (an engine may stop
    // reading early): the request's own close listener records it failed;
    // here every link toward and from the upstream is cancelled, and no
    // upstream error is logged.
    const cancel = (): void => {
      upstreamReq.destroy();
      countIn.destroy();
      countOut.destroy();
    };
    res.on("close", () => {
      setTimeout(() => {
        if (ended || res.writableFinished) return;
        ended = "client";
        cancel();
      }, 10);
    });
    res.on("error", cancel);
    req.on("error", cancel);
    countIn.on("error", () => upstreamReq.destroy());
    req.pipe(countIn).pipe(upstreamReq);
  }

  return {
    handleRequest(req, res, admitted) {
      if (!admitted) noteClient(req.headers);
      const route = routeFor(req.url ?? "");
      const trace = startTrace(req, route, admitted);
      // The request's end belongs to this trace from admission on: a client
      // that closes during any wait is recorded at once, and whatever settles
      // later finds it ended. An answer handed over in full is not a close.
      res.once("close", () => {
        setTimeout(() => {
          if (trace.ended) return;
          if (res.writableFinished && trace.status !== undefined)
            return trace.end({
              text: String(trace.status),
              outcome: "forwarded",
              status: trace.status,
            });
          clientClosed(res, trace);
        }, 10);
      });
      handle(req, res, route, trace).catch((err: unknown) => {
        if (gone(res, trace)) return;
        const sent = res.headersSent;
        trace.end({
          text: `internal error (${errorCode(err)})`,
          outcome: "failed",
          status: sent ? (trace.status ?? null) : 500,
          reason: "internal-error",
        });
        if (sent) res.destroy();
        else res.writeHead(500).end();
      });
    },

    // WebSocket is refused without contacting upstream: engines use SSE.
    handleUpgrade(req, socket) {
      noteClient(req.headers);
      const route = routeFor(req.url ?? "");
      const trace = startTrace(req, route, undefined);
      stats.refused += 1;
      const refusal: Refusal = { case: "websocket" };
      const { status, body } = refusalResponse(refusal, shapeOf(route));
      socket.on("error", () => socket.destroy());
      trace.status = status;
      trace.responseBytes += Buffer.byteLength(body);
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      trace.end(refusalEnding(refusal, status));
    },

    /**
     * A client-port request the listener answers itself (`/mcp`, its own
     * refusals): one line and, with `admitted`, one record, written once
     * when the answer closes. Nothing is read from the request but its
     * method, path and credential class. Both byte counts are lengths only:
     * `requestBytes` from the request's `data` events, whoever reads them
     * (its `emit` is wrapped, so no listener changes how the handler reads),
     * `responseBytes` from the handler's `write` and `end`.
     *
     * An answer completed at `finish` is classed by its status: below 400
     * forwarded, 4xx refused, 5xx failed, each with a fixed reason. An
     * answer closed before completion, even after `end`, is failed, its
     * status null before headers: `aborted` when the handler destroyed it,
     * else `client-closed`. A completed gate's `refuse` wins over its status.
     */
    observeLocal(req, res, admitted) {
      const trace = startTrace(req, undefined, admitted);
      let refused: string | undefined;
      let destroyedHere = false;
      // A gate refuses before the body is read: what Node discards after
      // its answer is not the request's.
      countRead(req, (n) => {
        if (refused === undefined) trace.requestBytes += n;
      });
      countAnswer(res, (n) => (trace.responseBytes += n));
      const { destroy } = res;
      // The handler's own teardown while its client is still connected; a
      // destroy after the client went away is that client's close.
      res.destroy = ((...args: unknown[]) => {
        if (!req.socket.destroyed) destroyedHere = true;
        return Reflect.apply(destroy, res, args) as http.ServerResponse;
      }) as typeof res.destroy;
      const finish = (): void => {
        if (trace.ended) return;
        const status = res.headersSent ? res.statusCode : null;
        if (status !== null) trace.status = status;
        if (refused !== undefined)
          return trace.end({
            text: `refused ${refused} ${status ?? "-"}`,
            outcome: "refused",
            status,
            reason: refused,
          });
        if (status === null) return;
        trace.end(answerEnding(status));
      };
      res.once("finish", finish);
      // Allow an already-scheduled finish to run before the failure fallback.
      // Close alone never proves completion, regardless of the reply's status.
      res.once("close", () => {
        setTimeout(() => {
          if (trace.ended) return;
          const status = res.headersSent ? res.statusCode : null;
          if (status !== null) trace.status = status;
          const reason = destroyedHere ? "aborted" : "client-closed";
          trace.end({
            text: reason === "aborted" ? "aborted" : "client closed",
            outcome: "failed",
            status,
            reason,
          });
        }, 10);
      });
      return {
        refuse(reason) {
          refused = reason;
        },
      };
    },
  };
}
