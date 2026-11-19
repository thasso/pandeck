/**
 * Direct forwarding for the observed named hosts (Task-1430 PR4, ADR-0006):
 * every decrypted request to a named host that is not a token host.
 *
 * - The destination is the CONNECT host on 443 with SNI equal to that host
 *   and default CA verification; the inner `Host` and SNI never choose it.
 *   Nothing of the edge's link is used: no client certificate, key, edge CA
 *   or agent, and no gateway credential.
 * - Header fields pass as received, repeats and order kept, except the fixed
 *   hop-by-hop fields, every field `Connection` names and caller
 *   `x-pandeck-*` fields. A nomination never removes `Host`,
 *   `Content-Length` or `Transfer-Encoding`. No credential or cookie is added
 *   or removed; a response `set-cookie` reaches the client. Bodies are piped
 *   both ways and never read; the counters see lengths only. A request body
 *   goes up framed as the inner server parsed it, chunked or by its
 *   `Content-Length`, whatever its method (`withRequestFraming`).
 * - A response is re-framed only when its transfer coding is chunked alone
 *   or absent; any other coding, an upgrade's non-`101` answer included, is
 *   the relay's marked 502 `transfer-coding` (`unforwardableCoding`).
 * - An upgrade request goes up as its head alone, with neither
 *   `Transfer-Encoding` nor `Content-Length`: nothing the client sent after
 *   its head is written upstream before the `101`, so no body can frame a
 *   second request.
 * - An upgrade keeps its `Upgrade` fields and one `Connection: Upgrade`.
 *   After the upstream's `101`, both buffered heads go first, then bytes are
 *   piped both ways; any other answer is an ordinary response.
 * - Each request is admitted through the shared model traffic (`open`): it
 *   reserves a reporting slot, stays active for the drain and, whenever and
 *   however its lifetime ends, writes exactly one `observed` record (or
 *   `failed` without upstream headers) with its final counters.
 *
 * Imports only `node:` modules and `relay/`.
 */
import type http from "node:http";
import https from "node:https";
import type net from "node:net";
import { Transform } from "node:stream";
import {
  answerMarked,
  errorCode,
  HOP_BY_HOP,
  stripReservedHeaders,
  withRequestFraming,
  type Lifetime,
  type ModelTraffic,
} from "./modelTraffic.ts";

/** Where an observed request goes: fixed by the CONNECT host alone. */
interface ObservedUpstream {
  host: string;
  port: number;
  servername: string;
  rejectUnauthorized: true;
}

/** The production destination for a validated named host. */
function observedUpstream(host: string): ObservedUpstream {
  return { host, port: 443, servername: host, rejectUnauthorized: true };
}

/**
 * TEST SEAM, programmatic only (never a flag or environment variable): given
 * the production destination, a local address and trust root to use
 * instead. SNI and verification always stay the production ones.
 */
export type ObservedUpstreamSeam = (production: Readonly<ObservedUpstream>) => {
  host: string;
  port: number;
  ca: string | string[];
};

/** Never a `Connection` field's to remove: the message's framing and Host. */
const NOT_NOMINABLE: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "transfer-encoding",
]);

/** Lower-case names every `Connection` field nominates, bar `NOT_NOMINABLE`. */
function nominated(rawHeaders: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "connection")
      for (const token of rawHeaders[i + 1]!.split(",")) {
        const name = token.trim().toLowerCase();
        if (name && !NOT_NOMINABLE.has(name)) names.add(name);
      }
  return names;
}

/**
 * Fields as received without hop-by-hop ones. With `upgrade`, the `Upgrade`
 * fields stay and one `Connection: Upgrade` is appended.
 */
function endToEnd(rawHeaders: readonly string[], upgrade: boolean): string[] {
  const hop = nominated(rawHeaders);
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    if (upgrade && name === "upgrade")
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
    else if (!HOP_BY_HOP.has(name) && !hop.has(name))
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  }
  if (upgrade) out.push("Connection", "Upgrade");
  return out;
}

/** The request fields sent upstream for a request to `host`. */
function requestFields(
  rawHeaders: readonly string[],
  host: string,
  upgrade: boolean,
): string[] {
  const kept = endToEnd(stripReservedHeaders(rawHeaders), upgrade);
  // An upgrade goes up as its head alone: no length for a body never sent.
  const out = upgrade
    ? kept.filter(
        (_, i) => kept[i - (i % 2)]!.toLowerCase() !== "content-length",
      )
    : kept;
  // What Node would have set: only an HTTP/1.0 request can come without one.
  if (!out.some((name, i) => i % 2 === 0 && name.toLowerCase() === "host"))
    out.push("Host", host);
  return out;
}

/** A response head written onto a raw socket. */
function rawHead(status: number, message: string, fields: string[]): string {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (let i = 0; i + 1 < fields.length; i += 2)
    lines.push(`${fields[i]}: ${fields[i + 1]}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** A pass-through that only counts lengths. */
function counter(add: (length: number) => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      add(chunk.length);
      callback(null, chunk);
    },
  });
}

/**
 * Whether a response's transfer codings are other than chunked alone (F006).
 * The relay drops `Transfer-Encoding` as hop-by-hop and re-frames the body;
 * that is faithful only for chunked, which the parser has already removed.
 * Any other coding (`gzip, chunked`, say) would reach the client still
 * applied, with nothing naming it. The relay strips the client's `TE`, so a
 * compliant upstream sends none; one that does is answered `CODED`.
 */
function unforwardableCoding(rawHeaders: readonly string[]): boolean {
  const codings: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "transfer-encoding")
      for (const item of rawHeaders[i + 1]!.split(",")) {
        const coding = item.trim().toLowerCase();
        if (coding) codings.push(coding);
      }
  return codings.length > 0 && (codings.length > 1 || codings[0] !== "chunked");
}

const UNREACHABLE = {
  status: 502,
  errorType: "api_error",
  text: "the relay cannot reach this host.",
} as const;
/** An upstream answer whose transfer coding the relay cannot pass on. */
const CODED = {
  status: 502,
  reason: "transfer-coding",
  errorType: "api_error",
  text: "the host answered with a transfer coding the relay cannot forward.",
} as const;

/**
 * One request's single completion: its final counters and the record. The
 * outcome is `observed` once upstream headers arrived, else `failed`.
 */
function completion() {
  const state = {
    status: null as number | null,
    local: null as number | null,
    failure: undefined as string | undefined,
    requestBytes: 0,
    responseBytes: 0,
  };
  let settled = false;
  return {
    state,
    /** The first failure wins; a later one is a consequence of it. */
    fail(reason: string): void {
      state.failure ??= reason;
    },
    /** Records once; returns whether this call did. */
    settle(life: Lifetime): boolean {
      if (settled) return false;
      settled = true;
      const reason =
        state.failure ?? (state.status === null ? "client-closed" : undefined);
      life.end({
        status: state.status ?? state.local,
        outcome: state.status === null ? "failed" : "observed",
        ...(reason === undefined ? {} : { reason }),
        requestBytes: state.requestBytes,
        responseBytes: state.responseBytes,
      });
      return true;
    },
  };
}

export function createObservedTraffic(options: {
  traffic: Pick<ModelTraffic, "open">;
  /** The observed hosts' own keep-alive agent, never the edge's. */
  agent: https.Agent;
  upstream?: ObservedUpstreamSeam;
  log(line: string): void;
}) {
  const { traffic, log } = options;

  function destination(host: string): https.RequestOptions {
    const production = observedUpstream(host);
    if (!options.upstream) return { ...production };
    const local = options.upstream(Object.freeze({ ...production }));
    return {
      host: local.host,
      port: local.port,
      ca: local.ca,
      servername: production.servername,
      rejectUnauthorized: production.rejectUnauthorized,
    };
  }

  function settle(
    done: ReturnType<typeof completion>,
    life: Lifetime,
    host: string,
    kind: string,
  ): void {
    if (!done.settle(life)) return;
    const { status, local, failure } = done.state;
    log(
      `${host} ${life.method}${kind} ${status ?? local ?? "-"} ${life.durationMs()}ms${failure ? ` (${failure})` : ""}`,
    );
  }

  function forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
  ): void {
    const target = req.url ?? "/";
    const done = completion();
    let upstream: http.ClientRequest | undefined;
    let upstreamRes: http.IncomingMessage | undefined;
    const reqCount = counter((n) => (done.state.requestBytes += n));
    const resCount = counter((n) => (done.state.responseBytes += n));
    const teardown = (): void => {
      req.unpipe(reqCount);
      reqCount.destroy();
      upstream?.destroy();
      upstreamRes?.destroy();
      req.destroy();
      res.destroy();
    };
    const life = traffic.open(req, res, { host, path: target }, () => {
      done.fail("relay-closing");
      settle(done, life!, host, "");
      teardown();
    });
    if (!life) return;
    // The record waits for both ends, as the gateway's own records do: the
    // answer delivered and the upload finished, or either given up.
    let answered = false;
    let uploaded = false;
    const end = (): void => settle(done, life, host, "");
    const both = (): void => {
      if (answered && uploaded) end();
    };
    /**
     * An answer that finished with the upload still open settles the lifetime
     * there and then (F004, F005): nothing the client does next, or never
     * does, can hold it. Under backpressure a paused inner request emits
     * neither its end nor, with its socket unread, any close.
     *
     * - The upload stops: what passed the counter, plus what the inner
     *   request still buffers, is counted; the rest is drained by the inner
     *   server's own framing, so its connection stays usable and a client
     *   that leaves is seen. The counter's own unread buffer is not added
     *   (F007): under backpressure it still holds the chunk its transform
     *   already counted, so adding it counted that chunk twice. A chunk the
     *   counter took but had not transformed yet goes uncounted instead, so
     *   the count never exceeds the body bytes read.
     * - The upstream request is destroyed, its connection never pooled. Bun's
     *   server ends such a request at its response's finish and calls it
     *   complete with its body short, so a whole upload cannot be told from a
     *   cut one, and a pooled connection would read the rest as the next
     *   request.
     */
    const answeredEarly = (): void => {
      uploaded = true;
      req.unpipe(reqCount);
      // Read from the client but not yet handed to the counter.
      done.state.requestBytes += req.readableLength;
      reqCount.destroy();
      upstream?.destroy();
      req.resume();
      end();
    };
    const failed = (reason: string): void => {
      done.fail(reason);
      teardown();
      end();
    };
    const answerLocally = (refusal: typeof UNREACHABLE | typeof CODED) => {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return;
      }
      done.state.local = refusal.status;
      const length = answerMarked(res, refusal);
      if (life.method !== "HEAD") done.state.responseBytes = length;
    };
    const unreachable = (): void => answerLocally(UNREACHABLE);
    res.on("finish", () => {
      answered = true;
      if (uploaded) end();
      else answeredEarly();
    });
    res.on("close", () => {
      if (!res.writableFinished) failed("client-closed");
    });
    req.on("error", () => failed("client-closed"));
    res.on("error", () => failed("client-closed"));
    reqCount.on("error", () => failed("client-closed"));
    resCount.on("error", () => failed("client-closed"));
    try {
      upstream = https.request({
        ...destination(host),
        agent: options.agent,
        method: req.method ?? "GET",
        path: target,
        headers: withRequestFraming(
          req.rawHeaders,
          requestFields(req.rawHeaders, host, false),
        ),
      });
    } catch (err) {
      done.fail(errorCode(err, "UNKNOWN"));
      uploaded = true;
      req.resume();
      unreachable();
      return;
    }
    upstream.on("finish", () => {
      uploaded = true;
      both();
    });
    upstream.on("response", (answer) => {
      upstreamRes = answer;
      if (res.destroyed) {
        answer.destroy();
        return;
      }
      if (unforwardableCoding(answer.rawHeaders)) {
        // Neither this answer nor its connection is used again; the upload,
        // if still running, ends at the local answer's finish.
        answer.on("error", () => {});
        answer.destroy();
        upstream!.destroy();
        done.fail(CODED.reason);
        answerLocally(CODED);
        return;
      }
      done.state.status = answer.statusCode ?? 502;
      res.writeHead(done.state.status, endToEnd(answer.rawHeaders, false));
      answer.on("error", (err) => {
        done.fail(errorCode(err, "UNKNOWN"));
        res.destroy();
      });
      answer.on("close", () => {
        if (answer.complete) return;
        done.fail("UNKNOWN");
        res.destroy();
      });
      answer.pipe(resCount).pipe(res);
    });
    upstream.on("error", (err) => {
      // Nothing more goes up; the answer, if any, decides what is left.
      done.fail(errorCode(err, "UNKNOWN"));
      uploaded = true;
      req.unpipe(reqCount);
      req.resume();
      // A local answer already under way stands.
      if (done.state.local !== null) return;
      if (done.state.status === null) unreachable();
      else if (!answered) res.destroy();
    });
    req.pipe(reqCount).pipe(upstream);
  }

  function upgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    host: string,
  ): void {
    const target = req.url ?? "/";
    const done = completion();
    let upstream: http.ClientRequest | undefined;
    let upstreamRes: http.IncomingMessage | undefined;
    let tunnel: net.Socket | undefined;
    const teardown = (): void => {
      upstream?.destroy();
      upstreamRes?.destroy();
      tunnel?.destroy();
      socket.destroy();
    };
    const life = traffic.open(req, socket, { host, path: target }, () => {
      done.fail("relay-closing");
      settle(done, life!, host, " upgrade");
      teardown();
    });
    if (!life) return;
    // Whatever this side sent last went out: the connection is over. A
    // paused client is never read again, so its end would never be seen.
    socket.once("finish", () => socket.destroy());
    socket.on("close", () => {
      const { status, local } = done.state;
      if (
        status === null
          ? local === null
          : status !== 101 && !upstreamRes?.complete
      )
        done.fail("client-closed");
      teardown();
      settle(done, life, host, " upgrade");
    });
    const answerLocally = (refusal: typeof UNREACHABLE | typeof CODED) => {
      if (socket.destroyed || socket.writableEnded) {
        socket.destroy();
        return;
      }
      done.state.local = refusal.status;
      done.state.responseBytes = answerMarked(socket, refusal);
    };
    const unreachable = (): void => answerLocally(UNREACHABLE);
    try {
      upstream = https.request({
        ...destination(host),
        // An upgraded connection never goes back to a pool.
        agent: false,
        method: req.method ?? "GET",
        path: target,
        headers: requestFields(req.rawHeaders, host, true),
      });
    } catch (err) {
      done.fail(errorCode(err, "UNKNOWN"));
      unreachable();
      return;
    }
    upstream.on("upgrade", (answer, upgraded: net.Socket, upgradedHead) => {
      upstreamRes = answer;
      tunnel = upgraded;
      if (socket.destroyed) {
        upgraded.destroy();
        return;
      }
      done.state.status = 101;
      upgraded.on("error", (err) => {
        done.fail(errorCode(err, "UNKNOWN"));
        socket.destroy();
      });
      upgraded.on("close", () => socket.destroy());
      socket.write(
        rawHead(
          101,
          answer.statusMessage || "Switching Protocols",
          endToEnd(answer.rawHeaders, true),
        ),
      );
      // Both buffered heads first: the bytes each side sent with its head.
      if (upgradedHead.length) {
        done.state.responseBytes += upgradedHead.length;
        socket.write(upgradedHead);
      }
      if (head.length) {
        done.state.requestBytes += head.length;
        upgraded.write(head);
      }
      const up = counter((n) => (done.state.requestBytes += n));
      const down = counter((n) => (done.state.responseBytes += n));
      up.on("error", () => socket.destroy());
      down.on("error", () => socket.destroy());
      upgraded.pipe(down).pipe(socket);
      socket.pipe(up).pipe(upgraded);
    });
    upstream.on("response", (answer) => {
      // Not upgraded: an ordinary answer, then this connection closes.
      upstreamRes = answer;
      if (socket.destroyed) {
        answer.destroy();
        return;
      }
      if (unforwardableCoding(answer.rawHeaders)) {
        answer.on("error", () => {});
        answer.destroy();
        upstream!.destroy();
        done.fail(CODED.reason);
        answerLocally(CODED);
        return;
      }
      done.state.status = answer.statusCode ?? 502;
      const fields = endToEnd(answer.rawHeaders, false);
      fields.push("Connection", "close");
      socket.write(
        rawHead(done.state.status, answer.statusMessage ?? "", fields),
      );
      answer.on("error", (err) => {
        done.fail(errorCode(err, "UNKNOWN"));
        socket.destroy();
      });
      answer.on("close", () => {
        if (answer.complete) return;
        done.fail("UNKNOWN");
        socket.destroy();
      });
      const down = counter((n) => (done.state.responseBytes += n));
      down.on("error", () => socket.destroy());
      answer.pipe(down).pipe(socket);
    });
    upstream.on("error", (err) => {
      done.fail(errorCode(err, "UNKNOWN"));
      // A local answer already under way stands.
      if (done.state.local !== null) return;
      if (done.state.status === null) unreachable();
      else socket.destroy();
    });
    upstream.end();
  }

  return { forward, upgrade };
}
export type ObservedTraffic = ReturnType<typeof createObservedTraffic>;
