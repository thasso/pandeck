import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  issueLeafCertificate,
  type CertificatePair,
} from "./certificateAuthority.ts";
import {
  startPackageProxy,
  type ProxyCredentialProvider,
  type RunningPackageProxy,
} from "./proxyServer.ts";

const TOKEN = "ghp_pretendtokenvalue0123456789";
const REGISTRY_HOST = "registry.test";
const SECRET = "test-proxy-secret";

/** A throwaway CA for the fake registry AND for the proxy's own leaves. */
let ca: CertificatePair;
let registry: https.Server;
let registryPort: number;
let registryRequests: { authorization?: string; url?: string }[] = [];
const running: RunningPackageProxy[] = [];

/** RSA keygen is slow; issue each host's leaf once for the whole file. */
const leaves = new Map<string, CertificatePair>();
function leafFor(host: string): CertificatePair {
  const cached = leaves.get(host);
  if (cached) return cached;
  const issued = issueLeafCertificate(ca, host);
  leaves.set(host, issued);
  return issued;
}

beforeAll(async () => {
  const { loadOrCreateCa } = await import("./certificateAuthority.ts");
  // Uses the temp DATA_DIR from the shared test setup.
  ca = await loadOrCreateCa();

  const leaf = leafFor(REGISTRY_HOST);
  registry = https.createServer(
    { key: leaf.keyPem, cert: leaf.certPem },
    (req, res) => {
      registryRequests.push({
        ...(req.headers.authorization
          ? { authorization: req.headers.authorization }
          : {}),
        ...(req.url ? { url: req.url } : {}),
      });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("artifact-bytes");
    },
  );
  await new Promise<void>((resolve) =>
    registry.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = registry.address();
  registryPort = typeof address === "object" && address ? address.port : 0;
});

afterEach(async () => {
  registryRequests = [];
  while (running.length) await running.pop()!.close();
});

async function startProxy(
  hosts: Map<string, ProxyCredentialProvider>,
): Promise<RunningPackageProxy> {
  const proxy = await startPackageProxy({
    credentialHosts: hosts,
    ca,
    leafFor,
    secret: SECRET,
    upstreamCa: ca.certPem,
    upstreamAddress: { host: "127.0.0.1", port: registryPort },
  });
  running.push(proxy);
  return proxy;
}

const credentialProvider: ProxyCredentialProvider = async () => ({
  username: "octo",
  token: TOKEN,
});

/** Open a CONNECT tunnel through the proxy and return the raw socket. */
function connectThroughProxy(
  proxy: RunningPackageProxy,
  target: string,
  opts: { secret?: string | null; scheme?: "Bearer" | "Basic" } = {},
): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: target };
    if (opts.secret !== null) {
      const secret = opts.secret ?? SECRET;
      headers["proxy-authorization"] =
        (opts.scheme ?? "Bearer") === "Basic"
          ? `Basic ${Buffer.from(`assistant:${secret}`, "utf8").toString("base64")}`
          : `Bearer ${secret}`;
    }
    const req = http.request({
      port: proxy.port,
      host: "127.0.0.1",
      method: "CONNECT",
      path: target,
      headers,
    });
    req.once("connect", (res, socket) =>
      resolve({ status: res.statusCode ?? 0, socket }),
    );
    req.once("response", (res) => {
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        socket: net.connect({ port: 0 }).destroy(),
      });
    });
    req.once("error", reject);
    req.end();
  });
}

/** Fetch an https URL through the proxy, trusting our CA for the (intercepted) leaf. */
async function fetchThroughProxy(
  proxy: RunningPackageProxy,
  host: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; body: string }> {
  const { socket, status } = await connectThroughProxy(proxy, `${host}:443`);
  if (status !== 200) throw new Error(`CONNECT failed with ${status}`);
  return await new Promise((resolve, reject) => {
    // `socket` reuses the already-open CONNECT tunnel as the TLS transport;
    // Node supports it but the public RequestOptions type omits it.
    const options = {
      socket,
      host,
      servername: host,
      path,
      ca: ca.certPem,
      headers,
      agent: false,
    } as unknown as https.RequestOptions;
    const req = https.request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("package proxy", () => {
  test("injects the credential for an intercepted host", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const res = await fetchThroughProxy(
      proxy,
      REGISTRY_HOST,
      "/com/acme/log/1.0.3/log-1.0.3.pom",
    );

    expect(res.status).toBe(200);
    expect(res.body).toBe("artifact-bytes");
    expect(registryRequests).toHaveLength(1);
    const expected = `Basic ${Buffer.from(`octo:${TOKEN}`, "utf8").toString("base64")}`;
    expect(registryRequests[0]?.authorization).toBe(expected);
    expect(proxy.stats.intercepted).toBe(1);
  });

  test("REPLACES a placeholder Authorization header rather than merging it", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    await fetchThroughProxy(proxy, REGISTRY_HOST, "/x.pom", {
      authorization: `Basic ${Buffer.from("placeholder:placeholder", "utf8").toString("base64")}`,
    });

    const sent = registryRequests[0]?.authorization ?? "";
    expect(sent).toBe(
      `Basic ${Buffer.from(`octo:${TOKEN}`, "utf8").toString("base64")}`,
    );
    expect(
      Buffer.from(sent.replace("Basic ", ""), "base64").toString("utf8"),
    ).not.toContain("placeholder");
  });

  test("tunnels an unmapped host without decrypting it", async () => {
    // A plain TCP echo server stands in for a CDN: if the proxy tried to
    // TLS-terminate it, the bytes would not come back verbatim.
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    const echoPort = (echo.address() as net.AddressInfo).port;
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const { status, socket } = await connectThroughProxy(
      proxy,
      `127.0.0.1:${echoPort}`,
    );
    expect(status).toBe(200);
    const roundTrip = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      socket.write("opaque-tls-bytes");
    });

    expect(roundTrip).toBe("opaque-tls-bytes");
    expect(proxy.stats.tunneled).toBe(1);
    expect(proxy.stats.intercepted).toBe(0);
    socket.destroy();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  test("never asks for a credential for an unmapped host", async () => {
    let providerCalls = 0;
    const echo = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    const echoPort = (echo.address() as net.AddressInfo).port;
    const proxy = await startProxy(
      new Map([
        [
          REGISTRY_HOST,
          async () => {
            providerCalls += 1;
            return { username: "octo", token: TOKEN };
          },
        ],
      ]),
    );

    const { socket } = await connectThroughProxy(
      proxy,
      `127.0.0.1:${echoPort}`,
    );
    socket.destroy();

    expect(providerCalls).toBe(0);
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  test("tunnels an unmapped host without requiring the proxy secret", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) =>
      echo.listen(0, "127.0.0.1", () => resolve()),
    );
    const echoPort = (echo.address() as net.AddressInfo).port;
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const { status, socket } = await connectThroughProxy(
      proxy,
      `127.0.0.1:${echoPort}`,
      { secret: null },
    );
    expect(status).toBe(200);
    const roundTrip = await new Promise<string>((resolve) => {
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
      socket.write("no-auth-needed");
    });

    expect(roundTrip).toBe("no-auth-needed");
    expect(proxy.stats.tunneled).toBe(1);
    expect(proxy.stats.rejected).toBe(0);
    socket.destroy();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  test("rejects an intercepted CONNECT without the proxy secret", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const { status } = await connectThroughProxy(
      proxy,
      `${REGISTRY_HOST}:443`,
      { secret: null },
    );

    expect(status).toBe(407);
    expect(proxy.stats.rejected).toBe(1);
    expect(registryRequests).toHaveLength(0);
  });

  test("rejects an intercepted CONNECT carrying the wrong secret", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const { status } = await connectThroughProxy(
      proxy,
      `${REGISTRY_HOST}:443`,
      { secret: "wrong" },
    );

    expect(status).toBe(407);
  });

  test("also accepts the secret as Basic auth (the JVM's proxy authenticator only speaks Basic)", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, credentialProvider]]),
    );

    const good = await connectThroughProxy(proxy, `${REGISTRY_HOST}:443`, {
      scheme: "Basic",
    });
    const bad = await connectThroughProxy(proxy, `${REGISTRY_HOST}:443`, {
      scheme: "Basic",
      secret: "wrong",
    });

    expect(good.status).toBe(200);
    expect(bad.status).toBe(407);
    good.socket.destroy();
  });

  test("passes the upstream status and body through unchanged", async () => {
    const proxy = await startProxy(
      new Map([[REGISTRY_HOST, async () => null]]),
    );

    const res = await fetchThroughProxy(proxy, REGISTRY_HOST, "/anonymous.pom");

    expect(res.status).toBe(200);
    // No credential available: the request still goes out, just unauthenticated.
    expect(registryRequests[0]?.authorization).toBeUndefined();
  });
});
