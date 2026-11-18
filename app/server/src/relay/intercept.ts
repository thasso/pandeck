/**
 * CONNECT on the relay's model listener with `--intercept-ca-cert` (Task-1430,
 * ADR-0006). `connectTarget` decides each target:
 *
 * - A token host on 443 is decrypted with a leaf of the relay's interception
 *   CA (ALPN `http/1.1`). Each decrypted request goes through the relay's
 *   shared model traffic (`modelTraffic.ts`: admission, rid, reserved-field
 *   strip, fallback record) to the edge's model port as that host's fixed
 *   route plus the original target. Its header fields pass as received except
 *   hop-by-hop fields, caller `x-pandeck-*` fields and `Host`, which becomes
 *   one loopback `Host`. Bodies are piped both ways and never read.
 * - Every other valid target, IP literals included, is a blind tunnel: bytes
 *   piped untouched, not recorded, nothing logged but a failure's error code.
 * - A named host on a port other than 443, or spelled with a trailing dot, is
 *   refused with a marked 403; an absolute-form target inside the tunnel with
 *   a marked 400; an upgrade with a marked 501, without contacting the edge.
 *   Each reserves a reporting slot and is recorded like any refusal.
 * - A target that is not a valid authority gets a marked 400, a summary count
 *   and a fixed log line; it is never recorded and its text never logged.
 *
 * Imports only `node:` modules and `relay/`.
 */
import type http from "node:http";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { connectTarget } from "./connectTarget.ts";
import { classifyClientCredential } from "./credentialClass.ts";
import type { InterceptCa } from "./interceptCa.ts";
import {
  answerUnrecorded,
  type LocalRefusal,
  type ModelTraffic,
} from "./modelTraffic.ts";

/** The relay-local refusals on intercepted traffic, without their identity. */
type Refusal = Pick<LocalRefusal, "status" | "errorType" | "text">;

const REFUSALS = {
  "connect-port": {
    status: 403,
    errorType: "permission_error",
    text: "the relay decrypts this host only on port 443.",
  },
  "connect-target": {
    status: 403,
    errorType: "permission_error",
    text: "the relay refuses a named host spelled with a trailing dot.",
  },
  "origin-form": {
    status: 400,
    errorType: "invalid_request_error",
    text: "the relay accepts only origin-form request targets here.",
  },
  "reserved-path": {
    status: 403,
    errorType: "permission_error",
    text: "this path is reserved for the relay.",
  },
  upgrade: {
    status: 501,
    errorType: "api_error",
    text: "the relay does not upgrade connections to this host.",
  },
} as const satisfies Record<string, Refusal>;

const MALFORMED: Refusal = {
  status: 400,
  errorType: "invalid_request_error",
  text: "the relay cannot read this CONNECT target.",
};

/** The summary's host column for a CONNECT whose target is never shown. */
const UNSHOWN = "-";

export interface InterceptionOptions {
  ca: InterceptCa;
  /** The relay's own loopback port, for the `Host` the edge sees. */
  relayPort(): number;
  traffic: Pick<ModelTraffic, "forward" | "refuse" | "count" | "isClosing">;
  /** Keeps a socket for the relay's close. */
  track(socket: net.Socket): void;
  log(line: string): void;
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "error";
}

/**
 * The fields a decrypted request carries: as received, every caller `Host`
 * replaced by one loopback `Host`, so the edge sees a loopback caller exactly
 * as through the plain listener. The shared forward drops hop-by-hop and
 * reserved fields and sets the rid.
 */
function loopbackHeaders(
  rawHeaders: readonly string[],
  loopbackHost: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() !== "host")
      out.push(rawHeaders[i]!, rawHeaders[i + 1]!);
  out.push("host", loopbackHost);
  return out;
}

/**
 * Adds CONNECT handling to the relay's model listener. The returned `close`
 * closes the decrypted requests' server once its connections are gone; the
 * relay's close drains and destroys them (they are tracked).
 */
export function attachInterception(
  model: http.Server,
  options: InterceptionOptions,
): { close(): Promise<void> } {
  const { ca, log, track, traffic } = options;
  /** The token host, and its route, each decrypted socket was opened for. */
  const hostOf = new WeakMap<net.Socket, { host: string; route: string }>();

  const inner = createServer((req, res) => {
    const opened = hostOf.get(req.socket);
    if (!opened) {
      req.socket.destroy();
      return;
    }
    const { host, route } = opened;
    const target = req.url ?? "";
    if (!target.startsWith("/")) {
      traffic.refuse(req, res, {
        host,
        path: "/",
        reason: "origin-form",
        ...REFUSALS["origin-form"],
      });
      return;
    }
    // `/relay/…`, admission, rid and the fallback record are the shared
    // forward's; `path` is reported without its query.
    traffic.forward(req, res, {
      host,
      path: target,
      edgePath: route + target,
      headers: loopbackHeaders(
        req.rawHeaders,
        `127.0.0.1:${options.relayPort()}`,
      ),
    });
  });
  inner.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    socket.on("error", () => socket.destroy());
    const host = hostOf.get(req.socket)?.host;
    if (!host) {
      socket.destroy();
      return;
    }
    traffic.refuse(req, socket, {
      host,
      path: req.url ?? "/",
      reason: "upgrade",
      ...REFUSALS.upgrade,
    });
  });
  // CONNECT is dispatched here, not to the request callback. It never
  // opens a nested tunnel, even with an origin-form target. Keep the
  // existing reserved-path priority and never record its authority.
  inner.on("connect", (req: http.IncomingMessage, socket: net.Socket) => {
    socket.on("error", () => socket.destroy());
    const host = hostOf.get(req.socket)?.host;
    if (!host) {
      socket.destroy();
      return;
    }
    const reason = (req.url ?? "").startsWith("/relay/")
      ? "reserved-path"
      : "origin-form";
    traffic.refuse(req, socket, {
      host,
      path: "/",
      method: "CONNECT",
      reason,
      ...REFUSALS[reason],
    });
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
      answerUnrecorded(socket, MALFORMED);
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
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    host: string,
    route: string,
  ): void => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // Bytes the client sent after the CONNECT belong to the TLS stream, so
    // they go back onto the raw socket before the TLS layer reads it.
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
      // No request was admitted, so nothing is recorded; counted instead.
      log(`${host}: TLS failed (${errorCode(err)})`);
      traffic.count(
        host,
        "tls-failed",
        classifyClientCredential(req.rawHeaders),
      );
      secure.destroy();
    });
    inner.emit("connection", secure);
  };

  model.on(
    "connect",
    (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      socket.on("error", () => socket.destroy());
      const decision = connectTarget(req.url ?? "");
      if (decision.kind === "malformed") {
        // Never the target: it may hold anything.
        log("CONNECT refused (malformed target)");
        traffic.count(
          UNSHOWN,
          "malformed",
          classifyClientCredential(req.rawHeaders),
        );
        answerUnrecorded(socket, MALFORMED);
        req.resume();
        return;
      }
      if (decision.kind === "refuse") {
        log(`CONNECT ${decision.host} refused (${decision.reason})`);
        traffic.refuse(req, socket, {
          host: decision.host,
          path: "/",
          method: "CONNECT",
          reason: decision.reason,
          ...REFUSALS[decision.reason],
        });
        return;
      }
      if (decision.kind === "tunnel") {
        tunnel(socket, head, decision.host, decision.port);
      } else if (traffic.isClosing()) {
        traffic.refuse(req, socket, {
          host: decision.host,
          path: "/",
          method: "CONNECT",
          status: 503,
          reason: "relay-closing",
          errorType: "api_error",
          text: "the relay is restarting; retry shortly.",
        });
      } else decrypt(req, socket, head, decision.host, decision.route);
    },
  );

  return {
    close: () =>
      new Promise<void>((resolve) => {
        inner.close(() => resolve());
        inner.closeIdleConnections();
      }),
  };
}
