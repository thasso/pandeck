/**
 * The relay (`gateway-service` plan M14, Task-1384): the only holder of a
 * gateway client's key on its box. It understands no protocol; it adds the
 * client's TLS identity and pipes bytes to the gateway edge.
 *
 * - A loopback HTTP listener for model traffic: every request goes to the
 *   edge's model port over mutual TLS, unchanged, lease token included. Both
 *   bodies stream with `pipe`, so a paused engine holds the edge back.
 * - A Unix socket (0600, the relay's account) for the client protocol: each
 *   accepted connection is piped byte for byte to the edge's client port.
 *
 * `enrollRelay` makes the key with `node:crypto`, redeems a one-time code at
 * the edge's enrollment port and keeps key, certificate, CA and the edge's
 * ports in the state directory, the key 0600. Imports only `node:` modules.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";

const KEY_FILE = "client-key.pem";
const CERT_FILE = "client-cert.pem";
const CA_FILE = "gateway-ca.pem";
const EDGE_FILE = "edge.json";
const MAX_ENROLL_ANSWER_BYTES = 64 * 1024;

/** Where the edge listens, as the relay's state names it. */
interface EdgeAddress {
  host: string;
  clientId: string;
  modelPort: number;
  clientPort: number;
}

interface RelayIdentity extends EdgeAddress {
  key: string;
  cert: string;
  ca: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardable(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}

/** The TLS name to check the edge's certificate for; an IP gets no SNI. */
function tlsName(host: string): { servername?: string } {
  return net.isIP(host) ? {} : { servername: host };
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface RelayEnrollment {
  stateDir: string;
  /** The edge's host and enrollment port. */
  host: string;
  enrollPort: number;
  /** The gateway's CA, PEM: the only trust root for the edge. */
  caPem: string;
  code: string;
}

/** Enrolls this relay: answers the client id the gateway assigned. */
export async function enrollRelay(options: RelayEnrollment): Promise<string> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const body = JSON.stringify({
    code: options.code,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  });
  const answer = await new Promise<unknown>((resolve, reject) => {
    const request = https.request(
      {
        host: options.host,
        port: options.enrollPort,
        ...tlsName(options.host),
        ca: options.caPem,
        method: "POST",
        path: "/enroll",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ENROLL_ANSWER_BYTES) response.destroy();
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `The gateway refused the enrollment (${response.statusCode}).`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("The gateway's enrollment answer is not JSON."));
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  const { clientId, certificatePem, caPem, modelPort, clientPort } = (answer ??
    {}) as Record<string, unknown>;
  if (
    typeof clientId !== "string" ||
    typeof certificatePem !== "string" ||
    typeof caPem !== "string" ||
    !Number.isSafeInteger(modelPort) ||
    !Number.isSafeInteger(clientPort)
  )
    throw new Error("The gateway's enrollment answer is malformed.");
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(options.stateDir, 0o700);
  writePrivate(
    join(options.stateDir, KEY_FILE),
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  writePrivate(join(options.stateDir, CERT_FILE), certificatePem);
  writePrivate(join(options.stateDir, CA_FILE), caPem);
  const edge: EdgeAddress = {
    host: options.host,
    clientId,
    modelPort: modelPort as number,
    clientPort: clientPort as number,
  };
  writePrivate(
    join(options.stateDir, EDGE_FILE),
    `${JSON.stringify(edge, null, 2)}\n`,
  );
  return clientId;
}

function readIdentity(stateDir: string): RelayIdentity {
  const edge = JSON.parse(
    readFileSync(join(stateDir, EDGE_FILE), "utf8"),
  ) as EdgeAddress;
  return {
    ...edge,
    key: readFileSync(join(stateDir, KEY_FILE), "utf8"),
    cert: readFileSync(join(stateDir, CERT_FILE), "utf8"),
    ca: readFileSync(join(stateDir, CA_FILE), "utf8"),
  };
}

export interface RelayOptions {
  stateDir: string;
  /** The loopback model port; 0 picks a free one. */
  port: number;
  /** The client protocol's Unix socket. */
  socketPath: string;
  log?: (line: string) => void;
}

export interface RunningRelay {
  /** `http://127.0.0.1:<port>`: where engines send model requests. */
  readonly url: string;
  readonly port: number;
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Removes a stale socket file; refuses to remove anything else. */
function clearSocketPath(path: string): void {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket())
    throw new Error(`${path} exists and is not a socket.`);
  unlinkSync(path);
}

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
  const identity = readIdentity(options.stateDir);
  const tlsOptions = {
    host: identity.host,
    key: identity.key,
    cert: identity.cert,
    ca: identity.ca,
    ...tlsName(identity.host),
  };
  const agent = new https.Agent({ keepAlive: true, ...tlsOptions });
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const model = http.createServer((req, res) => {
    const started = Date.now();
    const upstream = https.request({
      ...tlsOptions,
      port: identity.modelPort,
      agent,
      method: req.method,
      path: req.url,
      headers: forwardable(req.headers),
    });
    let settled = false;
    upstream.on("response", (edgeRes) => {
      res.writeHead(edgeRes.statusCode ?? 502, forwardable(edgeRes.headers));
      edgeRes.pipe(res);
      edgeRes.on("error", () => res.destroy());
      edgeRes.on("close", () => {
        if (!edgeRes.complete) res.destroy();
      });
      res.on("finish", () => {
        settled = true;
        log(`${req.method} ${edgeRes.statusCode} ${Date.now() - started}ms`);
      });
    });
    upstream.on("error", (err) => {
      if (settled) return;
      settled = true;
      const code = (err as { code?: unknown }).code;
      log(`${req.method} edge unreachable (${String(code ?? "error")})`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = JSON.stringify({
        error: { message: "The relay cannot reach the gateway." },
      });
      res.writeHead(502, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  model.on("connection", track);
  model.on("clientError", (_err, socket) => socket.destroy());

  const control = net.createServer((local) => {
    track(local);
    const edge = tls.connect({ ...tlsOptions, port: identity.clientPort });
    track(edge);
    const end = (): void => {
      local.destroy();
      edge.destroy();
    };
    local.on("error", end);
    edge.on("error", (err) => {
      const code = (err as { code?: unknown }).code;
      log(`client connection: edge failed (${String(code ?? "error")})`);
      end();
    });
    local.on("close", end);
    edge.on("close", end);
    local.pipe(edge);
    edge.pipe(local);
  });

  await new Promise<void>((resolve, reject) => {
    model.once("error", reject);
    model.listen(options.port, "127.0.0.1", () => {
      model.removeListener("error", reject);
      resolve();
    });
  });
  clearSocketPath(options.socketPath);
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(options.socketPath, () => {
      control.removeListener("error", reject);
      resolve();
    });
  });
  chmodSync(options.socketPath, 0o600);
  const address = model.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(
    `client ${identity.clientId}: model on 127.0.0.1:${port}, client protocol on ${options.socketPath}`,
  );
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    socketPath: options.socketPath,
    async close() {
      const closed = Promise.all([
        new Promise<void>((resolve) => model.close(() => resolve())),
        new Promise<void>((resolve) => control.close(() => resolve())),
      ]);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      await closed;
    },
  };
}
