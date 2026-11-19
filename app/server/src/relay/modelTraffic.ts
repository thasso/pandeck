/** Shared admission, forwarding and refusal handling for relay model ingresses. */
import type http from "node:http";
import https from "node:https";
import type net from "node:net";
import { Transform } from "node:stream";
import {
  classifyClientCredential,
  hasClientCookie,
  type ClientCredentialClass,
} from "./credentialClass.ts";
import type { Observation, Observations } from "./observations.ts";

export const RELAY_REFUSAL_MARKER = "Pandeck gateway:";
/** Fixed hop-by-hop fields, never forwarded on any relay ingress. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function stripReservedHeaders(rawHeaders: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (!rawHeaders[i]!.toLowerCase().startsWith("x-pandeck-"))
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  return out;
}

function forwardable(rawHeaders: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (!HOP_BY_HOP.has(rawHeaders[i]!.toLowerCase()))
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  return out;
}

/** Every `name` field of `rawHeaders`, as name/value pairs in order. */
function fieldsNamed(rawHeaders: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === name)
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  return out;
}

/**
 * Puts a request's own body framing, as the inner server parsed it, on the
 * fields it is forwarded with, whatever filtering removed. Without it Node
 * and Bun write a piped body unframed for the methods they do not chunk by
 * default (GET, DELETE, OPTIONS, …), and the next hop would parse that body
 * as further requests (F001/F002).
 *
 * - `Transfer-Encoding` is hop-by-hop and dropped with the rest. Both parsers
 *   admit it on a request only with `chunked` last and never beside a
 *   `Content-Length`, so the received fields, sent again unchanged, make the
 *   client chunk-encode the decoded body whatever the method.
 * - Otherwise the received `Content-Length` frames the body: kept where it
 *   still is, put back where a filter (a `Connection` nomination) took it.
 */
export function withRequestFraming(
  received: readonly string[],
  fields: readonly string[],
): string[] {
  const codings = fieldsNamed(received, "transfer-encoding");
  if (codings.length) {
    const out: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const name = fields[i]!.toLowerCase();
      if (name !== "content-length" && name !== "transfer-encoding")
        out.push(fields[i]!, fields[i + 1]!);
    }
    out.push(...codings);
    return out;
  }
  const length = fieldsNamed(received, "content-length");
  if (!length.length || fieldsNamed(fields, "content-length").length)
    return [...fields];
  return [...fields, ...length];
}

/**
 * C5: a local target under `/relay/` is the relay's own; every ingress,
 * plain and decrypted, refuses it with this before any upstream contact.
 */
export function isReservedPath(target: string | undefined): boolean {
  return (target ?? "").startsWith("/relay/");
}
export const RESERVED_PATH = {
  status: 403,
  reason: "reserved-path",
  errorType: "permission_error",
  text: "this path is reserved for the relay.",
} as const;

/**
 * Query- and fragment-free printable ASCII, bounded after UTF-8 byte
 * escaping: the target is cut at its first `?` or `#` before anything else
 * (Task-1435), so neither ever reaches a record.
 */
export function observationPath(raw: string): string {
  const path = raw.split(/[?#]/, 1)[0] ?? "/";
  if (!path.startsWith("/")) return "/";
  let out = "";
  for (const byte of Buffer.from(path)) {
    const next =
      byte >= 0x20 && byte <= 0x7e
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    if (out.length + next.length > 200) break;
    out += next;
  }
  return out;
}

interface RequestIdentity {
  host: string;
  path: string;
  method?: string;
}
export interface LocalRefusal extends RequestIdentity {
  status: number;
  reason: string;
  text: string;
  errorType: "api_error" | "permission_error" | "invalid_request_error";
}

type Answer = http.ServerResponse | net.Socket;
function refusalBody(errorType: string, text: string): string {
  return JSON.stringify({
    type: "error",
    error: {
      type: errorType,
      code: errorType,
      message: `${RELAY_REFUSAL_MARKER} ${text}`,
    },
  });
}
function answerLocal(answer: Answer, status: number, body: string): void {
  if ("writeHead" in answer) {
    answer.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      connection: "close",
    });
    answer.end(body);
  } else {
    answer.end(
      `HTTP/1.1 ${status} ${httpStatus(status)}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  }
}
/**
 * A marked local answer that nothing records: a CONNECT target the relay
 * cannot read may hold anything, so it never reaches a record (ADR-0006).
 */
export function answerUnrecorded(
  answer: Answer,
  refusal: Pick<LocalRefusal, "status" | "errorType" | "text">,
): void {
  answerMarked(answer, refusal);
}
/**
 * A marked local answer with connection close; returns its body's length.
 * The caller records it, if at all.
 */
export function answerMarked(
  answer: Answer,
  refusal: Pick<LocalRefusal, "status" | "errorType" | "text">,
): number {
  const body = refusalBody(refusal.errorType, refusal.text);
  answerLocal(answer, refusal.status, body);
  return Buffer.byteLength(body);
}
function httpStatus(status: number): string {
  return status === 403
    ? "Forbidden"
    : status === 503
      ? "Service Unavailable"
      : status === 501
        ? "Not Implemented"
        : status === 502
          ? "Bad Gateway"
          : "Bad Request";
}
/** A bounded Node error code, else `fallback`: never an error's text. */
export function errorCode(err: unknown, fallback = "edge-unreachable"): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : fallback;
}

/** An admitted request the relay ends itself; see `open`. */
export interface Lifetime {
  /** The method as recorded. */
  method: string;
  durationMs(): number;
  /** Records the one final observation; later calls do nothing. */
  end(
    value: Pick<
      Observation,
      "status" | "outcome" | "reason" | "requestBytes" | "responseBytes"
    >,
  ): void;
}

export interface ForwardTarget extends RequestIdentity {
  /** Gateway route including query, distinct from the displayed original path. */
  edgePath: string;
  headers?: readonly string[];
}

export function createModelTraffic(options: {
  boot: string;
  observations: Observations;
  edge: https.RequestOptions;
  edgeHost: string;
  log(line: string): void;
}) {
  const { observations, log } = options;
  let n = 0;
  let closing = false;
  const active = new Set<() => void>();
  const summaries = new Map<string, number>();
  let onDrained: (() => void) | undefined;

  function count(
    host: string,
    outcome: string,
    credential: ClientCredentialClass,
  ): void {
    const key = `${host} ${outcome} ${credential}`;
    summaries.set(key, (summaries.get(key) ?? 0) + 1);
  }
  function admit(
    req: http.IncomingMessage,
    answer: Answer,
    target: RequestIdentity,
  ) {
    const at = Date.now();
    const started = performance.now();
    const durationMs = () =>
      Math.max(0, Math.round(performance.now() - started));
    const credential = classifyClientCredential(req.rawHeaders);
    const slot = observations.reserve();
    if (!slot) {
      observations.overflow();
      count(target.host, "overflow", credential);
      answerLocal(
        answer,
        503,
        refusalBody(
          "api_error",
          "the relay is too busy to report this request; retry shortly.",
        ),
      );
      req.resume();
      return undefined;
    }
    const base = {
      rid: `${options.boot}:${++n}`,
      at,
      host: target.host,
      method: target.method ?? req.method ?? "GET",
      path: observationPath(target.path),
      clientCredential: credential,
      clientCookie: hasClientCookie(req.rawHeaders),
    };
    const record = (
      value: Pick<
        Observation,
        "status" | "outcome" | "reason" | "requestBytes" | "responseBytes"
      >,
    ) => {
      slot.record({ ...base, ...value, durationMs: durationMs() });
      count(base.host, value.outcome, credential);
    };
    return { base, slot, record, durationMs };
  }
  function refuse(
    req: http.IncomingMessage,
    answer: Answer,
    target: LocalRefusal,
  ): void {
    const admission = admit(req, answer, target);
    if (!admission) return;
    const status = closing ? 503 : target.status;
    const reason = closing ? "relay-closing" : target.reason;
    const body = refusalBody(
      closing ? "api_error" : target.errorType,
      closing ? "the relay is restarting; retry shortly." : target.text,
    );
    answerLocal(answer, status, body);
    admission.record({
      status,
      outcome: "refused",
      reason,
      requestBytes: 0,
      responseBytes:
        "writeHead" in answer && (target.method ?? req.method) === "HEAD"
          ? 0
          : Buffer.byteLength(body),
    });
    req.resume();
  }
  /**
   * Admits a request the relay ends itself, an observed host's: while closing
   * it is the marked 503 `relay-closing` refusal, with a full queue the
   * counted 503 overflow, and `undefined` is returned for both. Otherwise its
   * reservation stays held and it stays active (the drain waits for it) until
   * `end` records it, exactly once, with its final counters. At the drain
   * deadline `shutdown` is called and must call `end` before it returns.
   */
  function open(
    req: http.IncomingMessage,
    answer: Answer,
    target: RequestIdentity,
    shutdown: () => void,
  ): Lifetime | undefined {
    if (closing) {
      refuse(req, answer, {
        ...target,
        status: 503,
        reason: "relay-closing",
        errorType: "api_error",
        text: "the relay is restarting; retry shortly.",
      });
      return undefined;
    }
    const admission = admit(req, answer, target);
    if (!admission) return undefined;
    let ended = false;
    const entry = (): void => shutdown();
    active.add(entry);
    return {
      method: admission.base.method,
      durationMs: admission.durationMs,
      end(value) {
        if (ended) return;
        ended = true;
        admission.record(value);
        active.delete(entry);
        if (!active.size) onDrained?.();
      },
    };
  }
  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: ForwardTarget,
  ): void {
    // Strip reserved metadata even when the ingress prepared its own headers.
    const headers = withRequestFraming(
      req.rawHeaders,
      forwardable(stripReservedHeaders(target.headers ?? req.rawHeaders)),
    );
    if (closing || isReservedPath(req.url)) {
      refuse(req, res, { ...target, ...RESERVED_PATH });
      return;
    }
    const admission = admit(req, res, target);
    if (!admission) return;
    const { base, slot, record, durationMs } = admission;
    headers.push("x-pandeck-relay-id", base.rid);
    if (
      !headers.some((name, i) => i % 2 === 0 && name.toLowerCase() === "host")
    )
      headers.push("host", options.edgeHost);
    const upstream = https.request({
      ...options.edge,
      method: req.method,
      path: target.edgePath,
      headers,
    });
    let edgeResponse: http.IncomingMessage | undefined;
    let headersArrived = false;
    let recorded = false;
    let ended = false;
    let requestBytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        requestBytes += chunk.length;
        callback(null, chunk);
      },
    });
    const fallback = (
      reason: string,
      status: number | null,
      responseBytes: number,
    ) => {
      if (headersArrived || recorded) return;
      recorded = true;
      record({
        status,
        outcome: "failed",
        reason,
        requestBytes,
        responseBytes,
      });
    };
    const detachRequest = () => {
      req.unpipe(counter);
      counter.unpipe(upstream);
      counter.destroy();
    };
    const end = () => {
      if (ended) return;
      ended = true;
      active.delete(destroy);
      if (!active.size) onDrained?.();
    };
    const destroy = () => {
      fallback("relay-closing", null, 0);
      detachRequest();
      upstream.destroy();
      edgeResponse?.destroy();
      req.destroy();
      res.destroy();
      end();
    };
    active.add(destroy);
    upstream.on("response", (edgeRes) => {
      if (ended) {
        edgeRes.destroy();
        return;
      }
      headersArrived = true;
      edgeResponse = edgeRes;
      slot.release();
      count(base.host, "forwarded", base.clientCredential);
      res.writeHead(edgeRes.statusCode ?? 502, forwardable(edgeRes.rawHeaders));
      edgeRes.pipe(res);
      edgeRes.on("error", () => res.destroy());
      edgeRes.on("close", () => {
        if (!edgeRes.complete) res.destroy();
      });
    });
    upstream.on("error", (err) => {
      if (ended) return;
      detachRequest();
      req.resume();
      if (headersArrived) {
        res.destroy();
        return;
      }
      const body = JSON.stringify({
        error: { message: "The relay cannot reach the gateway." },
      });
      const canAnswer = !res.destroyed && !res.headersSent;
      fallback(
        errorCode(err),
        canAnswer ? 502 : null,
        canAnswer && req.method !== "HEAD" ? Buffer.byteLength(body) : 0,
      );
      log(`${base.method} edge unreachable (${errorCode(err)})`);
      if (canAnswer) {
        res.writeHead(502, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
      } else res.destroy();
    });
    res.on("finish", () => {
      detachRequest();
      req.resume();
      upstream.destroy();
      log(`${base.method} ${res.statusCode} ${durationMs()}ms`);
      end();
    });
    res.on("close", () => {
      if (!res.writableFinished) {
        fallback("client-closed", null, 0);
        detachRequest();
        upstream.destroy();
        edgeResponse?.destroy();
        req.destroy();
      }
      end();
    });
    const clientFailed = () => {
      fallback("client-closed", null, 0);
      detachRequest();
      upstream.destroy();
      edgeResponse?.destroy();
      req.destroy();
      res.destroy();
      end();
    };
    req.on("error", clientFailed);
    res.on("error", clientFailed);
    counter.on("error", () => {
      upstream.destroy();
      req.destroy();
      res.destroy();
    });
    req.pipe(counter).pipe(upstream);
  }
  return {
    forward,
    open,
    refuse,
    count,
    isClosing() {
      return closing;
    },
    beginClose() {
      closing = true;
    },
    async drain(drainMs: number): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (active.size)
        await new Promise<void>((resolve) => {
          onDrained = resolve;
          timer = setTimeout(resolve, drainMs);
        });
      clearTimeout(timer);
      onDrained = undefined;
      for (const destroy of active) destroy();
    },
    summary() {
      log(
        `relay summary: rejected-observations=${observations.rejected}; ${
          [...summaries]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join("; ") || "no requests"
        }`,
      );
    },
  };
}
export type ModelTraffic = ReturnType<typeof createModelTraffic>;
