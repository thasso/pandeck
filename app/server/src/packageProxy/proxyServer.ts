/**
 * The package proxy: a loopback HTTP forward proxy with SELECTIVE TLS
 * interception, so builds in agent worktrees can read private package
 * registries without ever holding a credential.
 *
 * Invariants (covered by `proxyServer.test.ts`):
 * - A host is intercepted ONLY if it has a credential provider. Everything else
 *   is a blind `CONNECT` tunnel: bytes are piped, never decrypted.
 * - For an intercepted host the request's own `Authorization`/`Proxy-*` headers
 *   are REPLACED, never merged — build tools are configured with placeholder
 *   credentials (Gradle silently skips a repository whose credentials are null).
 * - ONLY intercepted hosts require the per-boot `Proxy-Authorization` secret.
 *   Blind tunnels to non-credentialed hosts are unauthenticated so clients that
 *   don't parse proxy-URL userinfo (e.g. Chromium) can reach them. The secret
 *   protects credential injection, not tunnel access — any local process can
 *   already emit a CONNECT or make a direct socket.
 * - The credential never appears in a log line, an error, or a response.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { redactRegistrySecrets } from "../containerImages.ts";
import { errorText } from "../errors.ts";
import type { CertificatePair } from "./certificateAuthority.ts";

/** Resolves the credential for one intercepted host, or null when unavailable. */
export type ProxyCredentialProvider = () => Promise<{
  username: string;
  token: string;
} | null>;

export interface PackageProxyOptions {
  /** host -> credential provider. Only these hosts are TLS-terminated. */
  credentialHosts: Map<string, ProxyCredentialProvider>;
  ca: CertificatePair;
  leafFor: (host: string) => CertificatePair;
  /** Shared secret every client must send as `Proxy-Authorization: Bearer <secret>`. */
  secret: string;
  port?: number;
  /** Extra CAs for upstream verification (tests point this at their own CA). */
  upstreamCa?: string | string[];
  /**
   * Where to actually connect for an intercepted host. Tests run their
   * "registry" on 127.0.0.1 with an unresolvable hostname; the SNI name and
   * `Host` header always stay the logical host.
   */
  upstreamAddress?: { host: string; port: number };
}

interface PackageProxyStats {
  intercepted: number;
  tunneled: number;
  rejected: number;
  upstreamErrors: number;
}

export interface RunningPackageProxy {
  readonly url: string;
  readonly port: number;
  readonly stats: PackageProxyStats;
  close(): Promise<void>;
}

const PROXY_AUTH_HEADER = "proxy-authorization";
const TUNNEL_TIMEOUT_MS = 10 * 60_000;

function log(message: string, secrets: readonly string[] = []): void {
  console.log(`[package-proxy] ${redactRegistrySecrets(message, secrets)}`);
}

/** Strip hop-by-hop and proxy headers before re-originating a request. */
function forwardableHeaders(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const key of [
    "proxy-authorization",
    "proxy-connection",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "authorization",
  ]) {
    delete out[key];
  }
  return out;
}

export async function startPackageProxy(
  options: PackageProxyOptions,
): Promise<RunningPackageProxy> {
  const stats: PackageProxyStats = {
    intercepted: 0,
    tunneled: 0,
    rejected: 0,
    upstreamErrors: 0,
  };
  const expectedAuth = `Bearer ${options.secret}`;
  const sockets = new Set<net.Socket>();

  /**
   * Accept the secret as Bearer (curl/git/npm, which take it from the proxy
   * URL's userinfo) OR as Basic (the JVM, which only speaks Basic proxy auth
   * and ignores userinfo in `-Dhttps.proxyHost`). Any username is fine — the
   * password IS the capability.
   */
  const authorized = (headers: http.IncomingHttpHeaders): boolean => {
    const provided = headers[PROXY_AUTH_HEADER];
    if (typeof provided !== "string") return false;
    if (provided === expectedAuth) return true;
    const basic = /^Basic (.+)$/i.exec(provided.trim())?.[1];
    if (!basic) return false;
    const decoded = Buffer.from(basic, "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1) === options.secret;
  };

  /** Serves the decrypted requests of an intercepted host. */
  const interceptor = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const provider = options.credentialHosts.get(host);
    if (!provider) {
      // Defense in depth: we only ever route intercepted hosts here.
      res.writeHead(502).end("package proxy: host is not interceptable");
      return;
    }
    void (async () => {
      let secrets: string[] = [];
      try {
        const credential = await provider();
        const headers = forwardableHeaders(req.headers);
        if (credential) {
          secrets = [
            credential.token,
            `${credential.username}:${credential.token}`,
          ];
          headers.authorization = `Basic ${Buffer.from(`${credential.username}:${credential.token}`, "utf8").toString("base64")}`;
        }
        const upstream = https.request(
          {
            host: options.upstreamAddress?.host ?? host,
            port: options.upstreamAddress?.port ?? 443,
            servername: host,
            path: req.url,
            method: req.method,
            headers: { ...headers, host },
            ...(options.upstreamCa ? { ca: options.upstreamCa } : {}),
          },
          (upstreamRes) => {
            stats.intercepted += 1;
            const redirect = upstreamRes.headers.location
              ? ` -> ${safeHost(upstreamRes.headers.location)}`
              : "";
            log(
              `intercept ${req.method} ${host}${truncatePath(req.url)} : ${upstreamRes.statusCode}${redirect}`,
              secrets,
            );
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", (err) => {
          stats.upstreamErrors += 1;
          log(`upstream error for ${host}: ${errorText(err)}`, secrets);
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
      } catch (err) {
        stats.upstreamErrors += 1;
        log(
          `interception failed for ${host}: ${redactRegistrySecrets(errorText(err), secrets)}`,
          secrets,
        );
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
    })();
  });

  const proxy = http.createServer((_req, res) => {
    // Plain-HTTP proxying is not supported: registries are HTTPS, and forwarding
    // arbitrary cleartext would widen this surface for no benefit.
    stats.rejected += 1;
    res.writeHead(501).end("package proxy: only CONNECT (https) is supported");
  });

  proxy.on("connect", (req, rawSocket, head) => {
    // Node types the CONNECT socket as Duplex; it is always a net.Socket here.
    const clientSocket = rawSocket as net.Socket;
    const [rawHost = "", rawPort = "443"] = (req.url ?? "").split(":");
    const host = rawHost.toLowerCase();
    sockets.add(clientSocket);
    clientSocket.once("close", () => sockets.delete(clientSocket));
    clientSocket.setTimeout(TUNNEL_TIMEOUT_MS, () => clientSocket.destroy());

    if (!options.credentialHosts.has(host)) {
      tunnel(host, Number(rawPort), clientSocket, head, stats);
      return;
    }

    if (!authorized(req.headers)) {
      stats.rejected += 1;
      log(`rejected unauthorized CONNECT to ${host}`);
      // Challenge with Basic: it is the only scheme the JVM's proxy
      // authenticator answers, and curl/git/npm handle it just as well.
      clientSocket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="package-proxy"\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // ONE call: an uncached issuer would otherwise hand out a key and a cert
    // from two different pairs ("key values mismatch").
    const leaf = options.leafFor(host);
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.keyPem,
      cert: leaf.certPem,
      ALPNProtocols: ["http/1.1"],
    });
    tlsSocket.on("error", (err) =>
      log(`tls error for ${host}: ${errorText(err)}`),
    );
    if (head.length) tlsSocket.unshift(head);
    interceptor.emit("connection", tlsSocket);
  });

  proxy.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(options.port ?? 0, "127.0.0.1", () => {
      proxy.removeListener("error", reject);
      resolve();
    });
  });

  const address = proxy.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(
    `listening on 127.0.0.1:${port}; intercepting ${[...options.credentialHosts.keys()].join(", ")}`,
  );

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => interceptor.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      log(
        `stopped (intercepted=${stats.intercepted} tunneled=${stats.tunneled} rejected=${stats.rejected})`,
      );
    },
  };
}

/** Blind CONNECT tunnel: we never see plaintext for these hosts. */
function tunnel(
  host: string,
  port: number,
  clientSocket: net.Socket,
  head: Buffer,
  stats: PackageProxyStats,
): void {
  const upstream = net.connect(port, host, () => {
    stats.tunneled += 1;
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.setTimeout(TUNNEL_TIMEOUT_MS, () => upstream.destroy());
  upstream.on("error", (err) => {
    log(`tunnel to ${host} failed: ${errorText(err)}`);
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
}

function safeHost(location: string): string {
  try {
    return new URL(location).host;
  } catch {
    return "?";
  }
}

function truncatePath(path: string | undefined): string {
  if (!path) return "";
  return path.length > 80 ? `${path.slice(0, 80)}…` : path;
}
