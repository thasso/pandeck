/**
 * CONNECT on the relay's model listener with `--intercept-ca-cert` (Task-1430,
 * ADR-0006). `connectTarget` decides each target:
 *
 * - A token host on 443 is decrypted with a leaf of the relay's interception
 *   CA (ALPN `http/1.1`). Each decrypted request goes over the relay's
 *   mutual-TLS link to the edge's model port as that host's fixed route plus
 *   the original target, its header fields as received except hop-by-hop
 *   fields, caller `x-pandeck-*` fields and `Host`, which becomes one loopback
 *   `Host`. Bodies are piped both ways and never read.
 * - Every other valid target, IP literals included, is a blind tunnel: bytes
 *   piped untouched, nothing logged but a failure's error code.
 * - A named host on a port other than 443, or spelled with a trailing dot, is
 *   refused with a marked 403; an absolute-form target inside the tunnel with
 *   a marked 400; an upgrade with a marked 501, without contacting the edge.
 * - A target that is not a valid authority gets a marked 400 and a fixed log
 *   line that never holds the target.
 *
 * Every refusal here has Anthropic's error shape and carries the gateway's
 * refusal marker, so the server's classifier never reads it as a dead login.
 * Imports only `node:` modules and `relay/`.
 */
import type http from "node:http";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { connectTarget } from "./connectTarget.ts";
import { interceptedHeaders } from "./headers.ts";
import type { InterceptCa } from "./interceptCa.ts";

/**
 * The gateway's refusal marker (`gateway/refusals.ts`), repeated here because
 * the relay imports no gateway module; a test pins the two equal.
 */
export const RELAY_REFUSAL_MARKER = "Pandeck gateway:";

/** The refusals the relay answers itself on intercepted traffic. */
type RelayRefusal =
  "connect-port" | "connect-target" | "origin-form" | "upgrade" | "malformed";

const REFUSALS: Record<
  RelayRefusal,
  { status: number; reason: string; type: string; text: string }
> = {
  "connect-port": {
    status: 403,
    reason: "Forbidden",
    type: "permission_error",
    text: "the relay decrypts this host only on port 443.",
  },
  "connect-target": {
    status: 403,
    reason: "Forbidden",
    type: "permission_error",
    text: "the relay refuses a named host spelled with a trailing dot.",
  },
  "origin-form": {
    status: 400,
    reason: "Bad Request",
    type: "invalid_request_error",
    text: "the relay accepts only origin-form request targets here.",
  },
  upgrade: {
    status: 501,
    reason: "Not Implemented",
    type: "api_error",
    text: "the relay does not upgrade connections to this host.",
  },
  malformed: {
    status: 400,
    reason: "Bad Request",
    type: "invalid_request_error",
    text: "the relay cannot read this CONNECT target.",
  },
};

/** A refusal's body: Anthropic's error shape with the marker, no request text. */
function relayRefusalBody(refusal: RelayRefusal): string {
  const { type, text } = REFUSALS[refusal];
  return JSON.stringify({
    type: "error",
    error: { type, message: `${RELAY_REFUSAL_MARKER} ${text}` },
  });
}

/** A refusal as raw HTTP/1.1 bytes, for a socket no server answers on. */
function rawRefusal(refusal: RelayRefusal): string {
  const { status, reason } = REFUSALS[refusal];
  const body = relayRefusalBody(refusal);
  return [
    `HTTP/1.1 ${status} ${reason}`,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n");
}

/**
 * Where a request goes on the edge and what it carries. `recordHost` and
 * `recordPath` name it for the relay's own record when no edge answer comes
 * (PR2a's reporting): a token host and the query-free original pathname.
 */
export interface Ingress {
  path: string;
  headers: string[];
  recordHost?: string;
  recordPath?: string;
}

type Forward = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ingress: Ingress,
) => void;

export interface InterceptionOptions {
  ca: InterceptCa;
  /** The relay's own loopback port, for the `Host` the edge sees. */
  relayPort(): number;
  forward: Forward;
  /** Keeps a socket for the relay's close. */
  track(socket: net.Socket): void;
  log(line: string): void;
}

function errorCode(err: unknown): string {
  return String((err as { code?: unknown }).code ?? "error");
}

/**
 * Adds CONNECT handling to the relay's model listener; the returned close
 * stops the decrypted requests' server (the sockets are the relay's).
 */
export function attachInterception(
  model: http.Server,
  options: InterceptionOptions,
): { close(): Promise<void> } {
  const { ca, log, track } = options;
  /** The token host, and its route, each decrypted socket was opened for. */
  const hostOf = new WeakMap<net.Socket, { host: string; route: string }>();

  const refuseRaw = (socket: net.Socket, refusal: RelayRefusal): void => {
    socket.end(rawRefusal(refusal));
  };

  const inner = createServer((req, res) => {
    const opened = hostOf.get(req.socket);
    if (!opened) {
      req.socket.destroy();
      return;
    }
    const { host, route } = opened;
    const target = req.url ?? "";
    if (!target.startsWith("/")) {
      // Reporting (PR2a) records this refusal: path `/`, `origin-form`.
      const body = relayRefusalBody("origin-form");
      res.writeHead(400, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      log(`${host}: ${req.method} refused (origin-form)`);
      return;
    }
    const query = target.indexOf("?");
    options.forward(req, res, {
      path: route + target,
      headers: interceptedHeaders(
        req.rawHeaders,
        `127.0.0.1:${options.relayPort()}`,
      ),
      recordHost: host,
      recordPath: query === -1 ? target : target.slice(0, query),
    });
  });
  inner.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    // Reporting (PR2a) records this refusal: `upgrade`, no edge request.
    socket.on("error", () => socket.destroy());
    refuseRaw(socket, "upgrade");
    log(`${hostOf.get(req.socket)?.host ?? "?"}: upgrade refused`);
  });
  inner.on("clientError", (_err, socket) => socket.destroy());
  inner.on("connection", track);

  const tunnel = (
    socket: net.Socket,
    head: Buffer,
    host: string,
    port: number,
  ): void => {
    let upstream: net.Socket;
    try {
      upstream = net.connect(port, host);
    } catch (err) {
      log(`CONNECT refused: no tunnel (${errorCode(err)})`);
      refuseRaw(socket, "malformed");
      return;
    }
    track(upstream);
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (err) => {
      log(`CONNECT tunnel failed (${errorCode(err)})`);
      socket.destroy();
    });
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  };

  const decrypt = (
    socket: net.Socket,
    head: Buffer,
    host: string,
    route: string,
  ): void => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client sent after the CONNECT belong to the TLS stream.
    if (head.length) socket.unshift(head);
    // ONE call: the key and the certificate are always one pair.
    const leaf = ca.leafFor(host);
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ALPNProtocols: ["http/1.1"],
    });
    hostOf.set(secure, { host, route });
    secure.on("error", (err) => {
      // No request was admitted, so nothing is recorded.
      log(`${host}: TLS failed (${errorCode(err)})`);
      secure.destroy();
    });
    inner.emit("connection", secure);
  };

  model.on(
    "connect",
    (req: http.IncomingMessage, rawSocket: net.Socket, head: Buffer) => {
      const socket = rawSocket;
      socket.on("error", () => socket.destroy());
      const decision = connectTarget(req.url ?? "");
      switch (decision.kind) {
        case "malformed":
          // Never the target: it may hold anything.
          log("CONNECT refused (malformed target)");
          refuseRaw(socket, "malformed");
          return;
        case "refuse":
          // Reporting (PR2a) reserves a slot and records this refusal:
          // method CONNECT, path `/`, the validated host and the reason.
          log(`CONNECT ${decision.host} refused (${decision.reason})`);
          refuseRaw(socket, decision.reason);
          return;
        case "tunnel":
          tunnel(socket, head, decision.host, decision.port);
          return;
        case "intercept":
          decrypt(socket, head, decision.host, decision.route);
          return;
      }
    },
  );

  return {
    close: () =>
      new Promise<void>((resolve) => {
        inner.close(() => resolve());
      }),
  };
}
