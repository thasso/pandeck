/** The only JSON body the credential edge parses: the relay's own reports. */
import { X509Certificate } from "node:crypto";
import type http from "node:http";
import net from "node:net";
import type { AdmittedClient } from "./forward.ts";
import { GATEWAY_REFUSAL_MARKER } from "./refusals.ts";
import { RELAY_RID, type RelayDedup } from "./relayDedup.ts";
import type { RequestEntry, RequestLog } from "./requestLog.ts";

type Report = Pick<
  RequestEntry,
  | "rid"
  | "at"
  | "host"
  | "method"
  | "path"
  | "status"
  | "outcome"
  | "reason"
  | "clientCredential"
  | "clientCookie"
  | "requestBytes"
  | "responseBytes"
  | "durationMs"
> & { d: number; rid: string };
type Note =
  | { d: number; note: "relay-restarted" }
  | { d: number; note: "overflow"; count: number; from: number; to: number };
interface Batch {
  boot: string;
  records: (Report | Note)[];
}
export interface ObservationsCommitted {
  clientId: string;
  boot: string;
  committed: number[];
  ignored: number[];
  /** Test-only privacy and transport evidence; never supplied by production. */
  batch: Batch;
}
const MAX_BYTES = 64 * 1024;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value: unknown, min = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
const REPORT_KEYS = [
  "d",
  "rid",
  "at",
  "host",
  "method",
  "path",
  "status",
  "outcome",
  "reason",
  "clientCredential",
  "clientCookie",
  "requestBytes",
  "responseBytes",
  "durationMs",
];
const REASONS = new Set([
  "edge-unreachable",
  "client-closed",
  "relay-closing",
  "reserved-path",
  // An observed host's answer in a transfer coding the relay cannot forward.
  "transfer-coding",
  // The relay's own refusals on intercepted traffic (ADR-0006).
  "connect-port",
  "connect-target",
  "origin-form",
  "upgrade",
]);

/** Normalise identity spellings only, without resolving names. */
function normalizedHost(
  host: string,
): { name: string; ip: boolean } | undefined {
  if (net.isIPv6(host)) {
    try {
      return {
        name: new URL(`http://[${host}]/`).hostname.slice(1, -1),
        ip: true,
      };
    } catch {
      return undefined;
    }
  }
  return net.isIPv4(host)
    ? { name: host, ip: true }
    : { name: host.toLowerCase().replace(/\.$/, ""), ip: false };
}

/** Both configuration and the certificate actually served must own the name. */
function hostOwnership(hosts: readonly string[], certificate: string) {
  const configured = hosts.map(normalizedHost);
  const cert = new X509Certificate(certificate);
  return (host: string): boolean => {
    const normalized = normalizedHost(host);
    if (!normalized) return false;
    const { name, ip } = normalized;
    if (!name || name.endsWith(".") || name.includes("*")) return false;
    const owned = configured.some((pattern) => {
      if (!pattern || pattern.ip !== ip) return false;
      if (pattern.name === name) return true;
      if (ip || !pattern.name.startsWith("*.")) return false;
      const suffix = pattern.name.slice(1);
      if (!name.endsWith(suffix)) return false;
      const label = name.slice(0, -suffix.length);
      return label.length > 0 && !label.includes(".");
    });
    if (!owned) return false;
    if (ip) return cert.checkIP(name) !== undefined;
    const checkOptions = {
      subject: "never" as const,
      wildcards: true,
      partialWildcards: false,
      multiLabelWildcards: false,
      singleLabelSubdomains: false,
    };
    if (
      cert.checkHost(name, checkOptions) !== undefined ||
      cert.checkHost(`${name}.`, checkOptions) !== undefined
    )
      return true;
    // X509 does not expand a dotted wildcard SAN for either concrete spelling.
    // Require three DNS labels, then prove that one literal SAN exists without
    // wildcard expansion. Configuration ownership was checked independently.
    if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+){2,}$/.test(name)) return false;
    const reference = `*${name.slice(name.indexOf("."))}.`;
    return (
      cert.checkHost(reference, { ...checkOptions, wildcards: false }) !==
      undefined
    );
  };
}

/**
 * The relay's named domains (ADR-0006; `relay/connectTarget.ts`, which this
 * module may not import; a test pins the two equal). A relay record may name
 * one of them, or a DNS name under one, besides the edge's own hosts.
 */
export const RELAY_NAMED_DOMAINS: readonly string[] = [
  "anthropic.com",
  "claude.ai",
  "claude.com",
];
const DNS_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** P7 report identities are separate from the edge's own TLS identity. */
function namedHost(host: string): boolean {
  return (
    DNS_NAME.test(host) &&
    RELAY_NAMED_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  );
}

/** Validate every entry before touching identity, acknowledgement or log state. */
function validate(
  value: unknown,
  ownsHost: (host: string) => boolean,
): Batch | undefined {
  if (
    !object(value) ||
    !keys(value, ["boot", "ack", "records"]) ||
    typeof value.boot !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.boot) ||
    (value.ack !== undefined && !integer(value.ack)) ||
    !Array.isArray(value.records) ||
    value.records.length < 1 ||
    value.records.length > 100
  )
    return undefined;
  let previous = 0;
  for (const entry of value.records) {
    if (!object(entry) || !integer(entry.d, 1) || entry.d <= previous)
      return undefined;
    previous = entry.d;
    if (entry.note === "relay-restarted") {
      if (!keys(entry, ["d", "note"])) return undefined;
    } else if (entry.note === "overflow") {
      if (
        !keys(entry, ["d", "note", "count", "from", "to"]) ||
        !integer(entry.count, 1) ||
        !integer(entry.from) ||
        !integer(entry.to) ||
        entry.from > entry.to
      )
        return undefined;
    } else {
      if (
        !keys(entry, REPORT_KEYS) ||
        typeof entry.rid !== "string" ||
        RELAY_RID.exec(entry.rid)?.[1] !== value.boot ||
        !integer(entry.at) ||
        typeof entry.host !== "string" ||
        !/^[\x21-\x7e]{1,253}$/.test(entry.host) ||
        !(ownsHost(entry.host) || namedHost(entry.host)) ||
        typeof entry.method !== "string" ||
        !/^[A-Z][A-Z-]{0,15}$/.test(entry.method) ||
        typeof entry.path !== "string" ||
        !/^\/[\x20-\x7e]{0,199}$/.test(entry.path) ||
        entry.path.includes("?") ||
        !(
          entry.status === null ||
          (integer(entry.status, 100) && entry.status <= 599)
        ) ||
        !["failed", "refused", "observed"].includes(entry.outcome as string) ||
        !["none", "placeholder", "lease", "mcp-token", "other"].includes(
          entry.clientCredential as string,
        ) ||
        typeof entry.clientCookie !== "boolean" ||
        !integer(entry.requestBytes) ||
        !integer(entry.responseBytes) ||
        !integer(entry.durationMs) ||
        (entry.reason !== undefined &&
          (typeof entry.reason !== "string" ||
            !(
              REASONS.has(entry.reason) ||
              /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.reason)
            )))
      )
        return undefined;
    }
  }
  return value as unknown as Batch;
}

function refuse(res: http.ServerResponse, status: number): void {
  const body = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: `${GATEWAY_REFUSAL_MARKER} invalid relay observation request.`,
    },
  });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...(status === 405 ? { allow: "POST" } : {}),
  });
  res.end(body);
}

export function createRelayObservations(options: {
  hosts: readonly string[];
  /** The same server certificate used by the model-port TLS listener. */
  certificate: string;
  dedup: RelayDedup;
  requests: Pick<RequestLog, "record">;
  log(line: string): void;
  now?: () => number;
  onCommitted?: ((event: ObservationsCommitted) => void) | undefined;
}) {
  const ownsHost = hostOwnership(options.hosts, options.certificate);
  return (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: AdmittedClient,
  ): void => {
    if (req.method !== "POST") {
      refuse(res, 405);
      req.resume();
      return;
    }
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    req.on("error", () => {
      done = true;
      chunks.length = 0;
    });
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BYTES) {
        done = true;
        chunks.length = 0;
        options.log("relay observations: invalid batch");
        res.once("finish", () => req.destroy());
        refuse(res, 413);
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      if (done || res.destroyed) return;
      done = true;
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        value = undefined;
      }
      chunks.length = 0;
      const batch = validate(value, ownsHost);
      if (!batch) {
        options.log("relay observations: invalid batch");
        refuse(res, 400);
        return;
      }
      const { dedup } = options;
      const ack = dedup.ack(client.id, batch.boot);
      const committed: number[] = [];
      const ignored: number[] = [];
      let belowFloor = 0;
      for (const entry of batch.records) {
        if (entry.d <= ack) {
          ignored.push(entry.d);
          continue;
        }
        let record: RequestEntry;
        if ("note" in entry) {
          record = {
            userId: client.userId,
            client: { id: client.id, label: client.label },
            via: "relay",
            at: "from" in entry ? entry.from : (options.now ?? Date.now)(),
            host: options.hosts[0] ?? "",
            method: "-",
            path: "-",
            pathKey: `note:${entry.note}`,
            status: null,
            outcome: entry.note === "overflow" ? "overflow" : "failed",
            reason: entry.note,
            ...("count" in entry ? { count: entry.count } : {}),
            clientCredential: "none",
            clientCookie: false,
            requestBytes: 0,
            responseBytes: 0,
            durationMs: 0,
          };
        } else {
          const n = Number(entry.rid.split(":")[1]);
          const disposition = dedup.enter(client.id, batch.boot, n);
          if (disposition !== "new") {
            if (disposition === "below-floor") belowFloor++;
            ignored.push(entry.d);
            continue;
          }
          const { d: _d, ...request } = entry;
          record = {
            ...request,
            host: request.host.toLowerCase(),
            userId: client.userId,
            client: { id: client.id, label: client.label },
            via: "relay",
          };
        }
        options.requests.record(record);
        committed.push(entry.d);
      }
      dedup.dropped(client.id, batch.boot, belowFloor);
      const last = batch.records.at(-1)!.d;
      dedup.acknowledge(client.id, batch.boot, last);
      options.onCommitted?.({
        clientId: client.id,
        boot: batch.boot,
        committed,
        ignored,
        batch,
      });
      const body = JSON.stringify({ ack: last });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  };
}
