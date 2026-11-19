/**
 * The relay's CONNECT interception (Task-1430 PR2b, ADR-0006) against a
 * RECORDING edge: a mutual-TLS listener with the test edge CA's server
 * certificate that requires the relay's client certificate and records each
 * request's target, raw header fields and body hash. The relay's own output
 * on its edge link is therefore checked byte for byte, independent of what
 * the real edge would do with it. Every value is fake; nothing reaches a
 * provider and no public name is resolved.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  GATEWAY_REFUSAL_MARKER,
  isGatewayRefusal,
} from "../gateway/refusals.ts";
import { edgeTlsFor, issueClientCertificate } from "../gateway/x509.ts";
import { loadInterceptCa, type InterceptCa } from "./interceptCa.ts";
import { MACHINE_PLACEHOLDER } from "./credentialClass.ts";
import { RELAY_REFUSAL_MARKER } from "./modelTraffic.ts";
import type {
  Delivery,
  Observation,
  ObservationBatch,
} from "./observations.ts";
import { startRelay, type RelayOptions, type RunningRelay } from "./relay.ts";

const CLIENT_ID = "c_intercept_test";
const edgeTls = edgeTlsFor(["127.0.0.1"], undefined);
const clientKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const clientKeyPem = clientKey.privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;
const clientCertPem = issueClientCertificate(
  edgeTls,
  CLIENT_ID,
  clientKey.publicKey,
).certificatePem;
const root = mkdtempSync(join(tmpdir(), "relay-intercept-"));
let interceptCa: InterceptCa;
/** PR4: signs the fake observed upstream's leaves; never the relay's CA. */
let upstreamCa: InterceptCa;

interface Recorded {
  method: string;
  url: string;
  rawHeaders: string[];
  bodySha256: string;
  clientCn: string;
}

/**
 * The recording edge: every model request it got, the relay's observation
 * batches (acknowledged in full) apart from them, and its TCP connections.
 */
interface RecordingEdge {
  port: number;
  requests: Recorded[];
  batches: ObservationBatch[];
  connections: number;
  /** `/relay/observations` requests that held no relay batch. */
  foreignIngest: number;
  /** Resolves once a batch holding a record that matches arrives. */
  reported(match: (record: Delivery) => boolean): Promise<Delivery>;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
beforeAll(() => {
  interceptCa = loadInterceptCa(mkdtempSync(join(root, "ca-")));
  upstreamCa = loadInterceptCa(mkdtempSync(join(root, "upstream-ca-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function recordingEdge(): Promise<RecordingEdge> {
  const waiting = new Set<() => void>();
  const edge: RecordingEdge = {
    port: 0,
    requests: [],
    batches: [],
    connections: 0,
    foreignIngest: 0,
    reported: (match) =>
      new Promise((resolve) => {
        const check = (): void => {
          const found = edge.batches
            .flatMap((batch) => batch.records)
            .find(match);
          if (!found) return;
          waiting.delete(check);
          resolve(found);
        };
        waiting.add(check);
        check();
      }),
  };
  const server = https.createServer(
    {
      key: edgeTls.serverKeyPem,
      cert: edgeTls.serverCertPem,
      ca: edgeTls.caCertPem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      if (req.url === "/relay/observations") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let batch: ObservationBatch | undefined;
          try {
            batch = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as ObservationBatch;
          } catch {
            batch = undefined;
          }
          if (!Array.isArray(batch?.records) || !batch.records.length) {
            edge.foreignIngest += 1;
            res.writeHead(400, { "content-length": 0 });
            res.end();
            return;
          }
          edge.batches.push(batch);
          const body = JSON.stringify({ ack: batch.records.at(-1)!.d });
          res.writeHead(200, {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          });
          res.end(body);
          for (const check of [...waiting]) check();
        });
        return;
      }
      const hash = createHash("sha256");
      req.on("data", (chunk: Buffer) => hash.update(chunk));
      req.on("end", () => {
        const peer = (req.socket as tls.TLSSocket).getPeerCertificate();
        edge.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          rawHeaders: [...req.rawHeaders],
          bodySha256: hash.digest("hex"),
          clientCn: [peer.subject?.CN].flat().join(","),
        });
        res.writeHead(200, {
          "content-type": "text/plain",
          "content-length": 8,
        });
        res.end("recorded");
      });
    },
  );
  server.on("connection", () => (edge.connections += 1));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  edge.port = (server.address() as net.AddressInfo).port;
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return edge;
}

interface Started {
  edge: RecordingEdge;
  relay: RunningRelay;
  logs: string[];
}

/** A relay enrolled against the test edge CA, its model port the recorder. */
async function started(
  withCa = true,
  extra: Pick<
    RelayOptions,
    "observedUpstream" | "observations" | "drainMs" | "flushMs"
  > = {},
): Promise<Started> {
  const edge = await recordingEdge();
  const stateDir = mkdtempSync(join(root, "relay-"));
  writeFileSync(join(stateDir, "client-key.pem"), clientKeyPem, {
    mode: 0o600,
  });
  writeFileSync(join(stateDir, "client-cert.pem"), clientCertPem);
  writeFileSync(join(stateDir, "gateway-ca.pem"), edgeTls.caCertPem);
  writeFileSync(
    join(stateDir, "edge.json"),
    JSON.stringify({
      host: "127.0.0.1",
      clientId: CLIENT_ID,
      modelPort: edge.port,
      // Never dialled here: the client protocol is not exercised.
      clientPort: 1,
    }),
  );
  const logs: string[] = [];
  const relay = await startRelay({
    stateDir,
    port: 0,
    socketPath: join(stateDir, "r.sock"),
    ...(withCa ? { interceptCa } : {}),
    ...extra,
    log: (line) => logs.push(line),
  });
  open.push({ close: () => relay.close() });
  // Every boot first reports its restart; later connections are traffic's.
  await edge.reported((record) => "note" in record);
  return { edge, relay, logs };
}

interface ConnectAnswer {
  status: number;
  head: string;
  /** For an answer other than 200: everything after the head, to the close. */
  body: Buffer;
  socket: net.Socket;
}

/** A raw CONNECT; a 200 hands back the socket, anything else reads to close. */
function connectThrough(
  port: number,
  target: string,
  extraHeaders: string[] = [],
): Promise<ConnectAnswer> {
  const socket = net.connect(port, "127.0.0.1");
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extraHeaders.map((line) => `${line}\r\n`).join("")}\r\n`,
  );
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let headEnd = -1;
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (headEnd !== -1) return;
      headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) return;
      const head = buffer.subarray(0, headEnd).toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      if (status === 200) {
        socket.removeListener("data", onData);
        socket.removeListener("close", onClose);
        socket.pause();
        resolve({ status, head, body: Buffer.alloc(0), socket });
      }
    };
    const onClose = (): void => {
      const end = headEnd === -1 ? buffer.length : headEnd;
      resolve({
        status: Number(
          /^HTTP\/1\.1 (\d{3})/.exec(buffer.toString("latin1"))?.[1] ?? 0,
        ),
        head: buffer.subarray(0, end).toString("latin1"),
        body: headEnd === -1 ? Buffer.alloc(0) : buffer.subarray(headEnd + 4),
        socket,
      });
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", () => {});
  });
}

interface HttpAnswer {
  status: number;
  head: string;
  body: Buffer;
}

function parseAnswer(raw: Buffer): HttpAnswer {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString("latin1");
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
    head,
    body: end === -1 ? Buffer.alloc(0) : raw.subarray(end + 4),
  };
}

function readToClose(socket: net.Socket | tls.TLSSocket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  return new Promise((resolve) =>
    socket.once("close", () => resolve(Buffer.concat(chunks))),
  );
}

/** One raw HTTP/1.1 exchange inside a decrypted CONNECT to `host`. */
async function decrypted(
  relayPort: number,
  host: string,
  request: Buffer | string,
): Promise<HttpAnswer> {
  const connected = await connectThrough(relayPort, `${host}:443`);
  assert.equal(connected.status, 200, connected.head);
  const secure = tls.connect({
    socket: connected.socket,
    servername: host,
    ca: [interceptCa.certPem],
  });
  await once(secure, "secureConnect");
  assert.equal(secure.authorized, true);
  assert.equal(secure.alpnProtocol, false, "no ALPN offered by this client");
  const answer = readToClose(secure);
  secure.write(request);
  return parseAnswer(await answer);
}

function fieldValues(rawHeaders: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === name) out.push(rawHeaders[i + 1]!);
  return out;
}

const BODY = JSON.stringify({ model: "fake", messages: [] });

/** T5a's request: repeats, two caller `Host`s and reserved fields. */
function messagesRequest(): string {
  return [
    "POST /v1/messages?beta=true HTTP/1.1",
    "Host: api.anthropic.com",
    "authorization: Bearer fake",
    "anthropic-beta: first-beta",
    "Host: second-host.example",
    "x-pandeck-relay-id: 00000000000000000000000000000000:1",
    "anthropic-beta: second-beta",
    "X-Pandeck-Relay-Id: forged",
    "x-pandeck-other: one",
    "x-pandeck-other: two",
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(BODY)}`,
    "connection: close",
    "",
    BODY,
  ].join("\r\n");
}

/** T5a's checks on what the recording edge got for one token host. */
function assertMapped(
  recorded: Recorded,
  expectedUrl: string,
  relayPort: number,
): void {
  assert.equal(recorded.url, expectedUrl);
  assert.equal(recorded.clientCn, CLIENT_ID, "over the relay's mutual TLS");
  assert.deepEqual(fieldValues(recorded.rawHeaders, "host"), [
    `127.0.0.1:${relayPort}`,
  ]);
  assert.deepEqual(fieldValues(recorded.rawHeaders, "authorization"), [
    "Bearer fake",
  ]);
  assert.deepEqual(fieldValues(recorded.rawHeaders, "anthropic-beta"), [
    "first-beta",
    "second-beta",
  ]);
  assert.deepEqual(
    recorded.rawHeaders.filter(
      (name, i) => i % 2 === 0 && name.toLowerCase().startsWith("x-pandeck-"),
    ),
    ["x-pandeck-relay-id"],
    "no caller x-pandeck-* field, only the relay's own rid",
  );
  assert.match(
    fieldValues(recorded.rawHeaders, "x-pandeck-relay-id")[0]!,
    /^[0-9a-f]{32}:[1-9][0-9]*$/,
  );
  // The caller's `connection: close` is hop-by-hop: only the relay's own
  // keep-alive link to the edge speaks here.
  assert.deepEqual(fieldValues(recorded.rawHeaders, "connection"), [
    "keep-alive",
  ]);
  assert.equal(
    recorded.bodySha256,
    createHash("sha256").update(BODY).digest("hex"),
  );
}

test("T5a: each token host's decrypted request reaches the edge on its fixed route with one loopback Host, the bearer, repeats in order, the relay's own rid only and the same body", async () => {
  const { edge, relay } = await started();
  for (const [host, url] of [
    ["api.anthropic.com", "/anthropic/v1/messages?beta=true"],
    ["mcp-proxy.anthropic.com", "/anthropic-mcp/v1/messages?beta=true"],
  ] as const) {
    const before = edge.requests.length;
    const answer = await decrypted(relay.port, host, messagesRequest());
    assert.equal(answer.status, 200, answer.head);
    assert.equal(answer.body.toString(), "recorded");
    assert.equal(edge.requests.length, before + 1);
    assertMapped(edge.requests.at(-1)!, url, relay.port);
  }
});

test("T12: an IP-literal CONNECT is a blind tunnel: the peer is the edge's own certificate and the bytes pass untouched", async () => {
  const { edge, relay } = await started();
  const connected = await connectThrough(relay.port, `127.0.0.1:${edge.port}`);
  assert.equal(connected.status, 200, connected.head);
  const secure = tls.connect({
    socket: connected.socket,
    host: "127.0.0.1",
    ca: [edgeTls.caCertPem],
    key: clientKeyPem,
    cert: clientCertPem,
    servername: "",
  });
  await once(secure, "secureConnect");
  assert.equal(secure.authorized, true);
  const peer = new X509Certificate(secure.getPeerCertificate(true).raw);
  assert.equal(peer.issuer, "CN=Pandeck gateway CA");
  assert.equal(
    peer.verify(new X509Certificate(interceptCa.certPem).publicKey),
    false,
    "not a leaf of the interception CA",
  );
  const answer = readToClose(secure);
  secure.write(
    "GET /tunnelled?as=sent HTTP/1.1\r\nHost: as-sent.example\r\nx-pandeck-relay-id: kept\r\nconnection: close\r\n\r\n",
  );
  assert.equal(parseAnswer(await answer).status, 200);
  const recorded = edge.requests.at(-1)!;
  assert.equal(recorded.url, "/tunnelled?as=sent");
  assert.deepEqual(fieldValues(recorded.rawHeaders, "host"), [
    "as-sent.example",
  ]);
  assert.deepEqual(fieldValues(recorded.rawHeaders, "x-pandeck-relay-id"), [
    "kept",
  ]);
});

test("T16: without an interception CA, CONNECT is closed without a 200 and the edge sees nothing", async () => {
  const { edge, relay } = await started(false);
  const connections = edge.connections;
  const answer = await connectThrough(relay.port, "api.anthropic.com:443");
  assert.notEqual(answer.status, 200);
  assert.doesNotMatch(answer.head, /Connection Established/);
  assert.equal(edge.connections, connections);
  assert.equal(edge.requests.length, 0);
});

const SHAPES = {
  "connect-port": { status: 403, type: "permission_error" },
  "connect-target": { status: 403, type: "permission_error" },
  "origin-form": { status: 400, type: "invalid_request_error" },
  upgrade: { status: 501, type: "api_error" },
  "reserved-path": { status: 403, type: "permission_error" },
  malformed: { status: 400, type: "invalid_request_error" },
} as const;

function assertMarked(answer: HttpAnswer, refusal: keyof typeof SHAPES): void {
  const { status, type } = SHAPES[refusal];
  assert.equal(answer.status, status, `${refusal}: ${answer.head}`);
  assert.match(answer.head, /\r\ncontent-type: application\/json\r\n/i);
  const length = /\r\ncontent-length: (\d+)/i.exec(answer.head)?.[1];
  assert.equal(Number(length), answer.body.length, refusal);
  const text = answer.body.toString("utf8");
  assert.ok(isGatewayRefusal(text), refusal);
  // Anthropic's error shape: these fields are required, more may follow.
  const parsed = JSON.parse(text) as {
    type: string;
    error: { type: string; message: string };
  };
  assert.equal(parsed.type, "error");
  assert.equal(parsed.error.type, type, refusal);
  assert.ok(parsed.error.message.startsWith(`${GATEWAY_REFUSAL_MARKER} `));
}

test("T20: every relay-local refusal is marked like the gateway's and shaped like Anthropic's error, and none reaches the edge", async () => {
  assert.equal(RELAY_REFUSAL_MARKER, GATEWAY_REFUSAL_MARKER);
  const { edge, relay } = await started();
  assertMarked(
    await connectThrough(relay.port, "api.anthropic.com:8443"),
    "connect-port",
  );
  assertMarked(
    await connectThrough(relay.port, "API.ANTHROPIC.COM.:443"),
    "connect-target",
  );
  assertMarked(
    await connectThrough(relay.port, "api.anthropic.com/x:443"),
    "malformed",
  );
  assertMarked(
    await decrypted(
      relay.port,
      "api.anthropic.com",
      "GET https://api.anthropic.com/v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\nconnection: close\r\n\r\n",
    ),
    "origin-form",
  );
  assertMarked(
    await decrypted(
      relay.port,
      "api.anthropic.com",
      "GET /v1/stream HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: fake-ws-key\r\n\r\n",
    ),
    "upgrade",
  );
  assert.equal(edge.requests.length, 0, "no refusal reached the edge");
  // Each named refusal is one record; the malformed target none.
  const reasons = ["connect-port", "connect-target", "origin-form", "upgrade"];
  await edge.reported(
    (record) => "reason" in record && record.reason === "upgrade",
  );
  const records = edge.batches
    .flatMap((batch) => batch.records)
    .filter((record) => "rid" in record);
  assert.deepEqual(
    records.map((record) => "reason" in record && record.reason).sort(),
    [...reasons].sort(),
  );
  for (const record of records) {
    assert.ok("rid" in record);
    assert.equal(record.host, "api.anthropic.com");
    assert.equal(record.outcome, "refused");
  }
});

test("T22: a CONNECT to an IP with a port outside 1-65535 gets the marked 400, never a tunnel or a crash, and nothing of it is logged", async () => {
  const { edge, relay, logs } = await started();
  const connections = edge.connections;
  for (const target of [
    "127.0.0.1:65536",
    "127.0.0.1:0",
    "[::1]:99999",
    "[::1]:0",
  ]) {
    const answer = await connectThrough(relay.port, target, [
      "x-sentinel: SENTINEL",
      "x-sentinel-2: SENTINEL",
    ]);
    assertMarked(answer, "malformed");
    assert.doesNotMatch(answer.head, /Connection Established/);
    for (const line of logs) {
      assert.ok(!line.includes(target), `logged ${target}: ${line}`);
      assert.ok(!line.includes("SENTINEL"), `logged a header: ${line}`);
    }
  }
  assert.equal(edge.connections, connections, "the edge saw no connection");
  assert.deepEqual(
    edge.batches.flatMap((batch) => batch.records).filter((r) => "rid" in r),
    [],
    "a malformed target is never recorded",
  );
  // Still serving: a decrypted request is mapped as before, and a valid IP
  // target still tunnels.
  const answer = await decrypted(
    relay.port,
    "api.anthropic.com",
    messagesRequest(),
  );
  assert.equal(answer.status, 200);
  assertMapped(
    edge.requests.at(-1)!,
    "/anthropic/v1/messages?beta=true",
    relay.port,
  );
  const tunnel = await connectThrough(relay.port, `127.0.0.1:${edge.port}`);
  assert.equal(tunnel.status, 200);
  tunnel.socket.destroy();
});

test("close: resolves with an intercepted connection and a tunnel still open", async () => {
  const { edge, relay } = await started();
  const intercepted = await connectThrough(relay.port, "api.anthropic.com:443");
  const secure = tls.connect({
    socket: intercepted.socket,
    servername: "api.anthropic.com",
    ca: [interceptCa.certPem],
  });
  await once(secure, "secureConnect");
  secure.on("error", () => {});
  const tunnel = await connectThrough(relay.port, `127.0.0.1:${edge.port}`);
  assert.equal(tunnel.status, 200);
  const closedSecure = once(secure, "close");
  const closedTunnel = once(tunnel.socket, "close");
  await relay.close();
  await Promise.all([closedSecure, closedTunnel]);
});

test("summary: TLS failures and malformed targets are counted, classed by the CONNECT's own Proxy-Authorization, never recorded", async () => {
  const { edge, relay, logs } = await started();
  const connected = await connectThrough(relay.port, "api.anthropic.com:443");
  assert.equal(connected.status, 200);
  const closed = once(connected.socket, "close");
  connected.socket.resume();
  connected.socket.write("not a TLS ClientHello\r\n\r\n");
  await closed;
  assertMarked(
    await connectThrough(relay.port, "SENTINEL/x:443", [
      `Proxy-Authorization: Bearer ${MACHINE_PLACEHOLDER}`,
    ]),
    "malformed",
  );
  await relay.close();
  const summary = logs.filter((line) => line.startsWith("relay summary:"));
  assert.equal(summary.length, 1);
  assert.match(summary[0]!, /api\.anthropic\.com tls-failed none=1/);
  assert.match(summary[0]!, /- malformed placeholder=1/);
  assert.ok(
    logs.some((line) => line.startsWith("api.anthropic.com: TLS failed (")),
  );
  assert.ok(!logs.join("\n").includes("SENTINEL"));
  assert.deepEqual(
    edge.batches.flatMap((batch) => batch.records).filter((r) => "rid" in r),
    [],
  );
});

// ---------------------------------------------------------------------------
// PR4: observed hosts, forwarded directly against a FAKE upstream. The relay's
// programmatic seam swaps only the address and trust root; the upstream's
// certificate comes from a separate synthetic CA and names the observed host,
// so SNI and default verification are still exercised.

interface UpstreamRequest {
  method: string;
  url: string;
  servername: string | false | null;
  rawHeaders: string[];
  body: Buffer;
}
interface UpstreamUpgrade {
  url: string;
  servername: string | false | null;
  rawHeaders: string[];
  head: Buffer;
  received: Buffer[];
  closed: Promise<void>;
}
interface FakeUpstream {
  port: number;
  requests: UpstreamRequest[];
  upgrades: UpstreamUpgrade[];
  /** Requests whose answer is held (`/hold…`), first one first. */
  held: { req: http.IncomingMessage; res: http.ServerResponse }[];
  aborted: number;
}

const RESPONSE_BODY = Buffer.from(
  Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff),
);
const SERVER_HEAD = Buffer.from([0x00, 0xff, 0x81, 0x02, 0x53, 0x48]);
const CLIENT_HEAD = Buffer.from([0x82, 0x00, 0x0d, 0x0a, 0xfe]);

async function fakeUpstream(): Promise<FakeUpstream> {
  const upstream: FakeUpstream = {
    port: 0,
    requests: [],
    upgrades: [],
    held: [],
    aborted: 0,
  };
  const fallback = upstreamCa.leafFor("claude.ai");
  const server = https.createServer(
    {
      key: fallback.key,
      cert: fallback.cert,
      SNICallback: (name, callback) =>
        callback(null, tls.createSecureContext(upstreamCa.leafFor(name))),
    },
    (req, res) => {
      const servername = (req.socket as tls.TLSSocket).servername;
      if (req.url === "/reset") {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("aborted", () => (upstream.aborted += 1));
      req.on("close", () => {
        if (!req.complete) upstream.aborted += 1;
      });
      if (req.url?.startsWith("/hold")) {
        upstream.held.push({ req, res });
        return;
      }
      if (req.url === "/early") {
        // Answers before reading the upload, which still arrives.
        res.writeHead(413, { "content-length": 5 });
        res.end("early");
        return;
      }
      req.on("end", () => {
        upstream.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          servername,
          rawHeaders: [...req.rawHeaders],
          body: Buffer.concat(chunks),
        });
        res.writeHead(200, [
          "content-type",
          "application/octet-stream",
          "set-cookie",
          "session=UPSTREAM-COOKIE; Secure; HttpOnly",
          "set-cookie",
          "second=2",
          "x-upstream",
          "one",
          "content-length",
          String(RESPONSE_BODY.length),
        ]);
        res.end(RESPONSE_BODY);
      });
    },
  );
  server.on(
    "upgrade",
    (req: http.IncomingMessage, socket: net.Socket, head) => {
      socket.on("error", () => {});
      if (req.url === "/no-upgrade") {
        socket.end(
          "HTTP/1.1 426 Upgrade Required\r\ncontent-type: text/plain\r\ncontent-length: 4\r\nconnection: close\r\n\r\nnope",
        );
        return;
      }
      const seen: UpstreamUpgrade = {
        url: req.url ?? "",
        servername: (req.socket as tls.TLSSocket).servername,
        rawHeaders: [...req.rawHeaders],
        head: Buffer.from(head),
        received: [],
        closed: new Promise((resolve) => socket.once("close", () => resolve())),
      };
      upstream.upgrades.push(seen);
      // The 101 and the upstream's first protocol bytes in ONE write.
      socket.write(
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nKeep-Alive: timeout=5\r\nx-upstream: upgraded\r\n\r\n",
          ),
          SERVER_HEAD,
        ]),
      );
      const echo = (chunk: Buffer): void => {
        seen.received.push(chunk);
        socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
      };
      if (head.length) echo(head);
      socket.on("data", echo);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.port = (server.address() as net.AddressInfo).port;
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return upstream;
}

interface ObservedRig extends Started {
  upstream: FakeUpstream;
  /** Every production destination the relay asked the seam to replace. */
  destinations: unknown[];
}

/** A relay whose observed hosts reach the fake upstream; `ca` is its trust. */
async function observedRig(
  options: { ca?: string; capacity?: number; drainMs?: number } = {},
): Promise<ObservedRig> {
  const upstream = await fakeUpstream();
  const destinations: unknown[] = [];
  const rig = await started(true, {
    observedUpstream: (production) => {
      assert.ok(Object.isFrozen(production));
      destinations.push({ ...production });
      return {
        host: "127.0.0.1",
        port: upstream.port,
        ca: options.ca ?? upstreamCa.certPem,
      };
    },
    ...(options.capacity
      ? { observations: { capacity: options.capacity } }
      : {}),
    drainMs: options.drainMs ?? 200,
    flushMs: 1000,
  });
  return { ...rig, upstream, destinations };
}

/** A decrypted connection to `host` through the relay, trusting its CA. */
async function secureTo(relayPort: number, host: string) {
  const connected = await connectThrough(relayPort, `${host}:443`);
  assert.equal(connected.status, 200, connected.head);
  const secure = tls.connect({
    socket: connected.socket,
    servername: host,
    ca: [interceptCa.certPem],
  });
  secure.on("error", () => {});
  await once(secure, "secureConnect");
  return secure;
}

/** Reads from `socket` until `done` holds for everything received. */
function readUntil(
  socket: tls.TLSSocket,
  done: (received: Buffer) => boolean,
): Promise<Buffer> {
  let received = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (!done(received)) return;
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      resolve(received);
    };
    const onClose = (): void =>
      reject(new Error(`Closed early: ${received.toString("latin1")}`));
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

const relayRecords = (edge: RecordingEdge): (Observation & { d: number })[] =>
  edge.batches
    .flatMap((batch) => batch.records)
    .filter((record) => !("note" in record)) as (Observation & {
    d: number;
  })[];

/** The first relay record matching `match`, once it was reported. */
async function reportedRecord(
  edge: RecordingEdge,
  match: (record: Observation) => boolean = () => true,
): Promise<Observation> {
  return (await edge.reported(
    (delivery) => !("note" in delivery) && match(delivery),
  )) as Observation;
}

function production(host: string) {
  return { host, port: 443, servername: host, rejectUnauthorized: true };
}

test("PR4: every named host on 443 decrypts; each observed host goes to itself on 443 with SNI = host and default verification, never to the edge", async () => {
  const r = await observedRig();
  const hosts = [
    "anthropic.com",
    "claude.ai",
    "claude.com",
    "downloads.claude.ai",
    "platform.claude.com",
    "statsig.anthropic.com",
  ];
  for (const host of hosts) {
    const answer = await decrypted(
      r.relay.port,
      host,
      `GET /ping HTTP/1.1\r\nHost: ${host}\r\nconnection: close\r\n\r\n`,
    );
    assert.equal(answer.status, 200, answer.head);
  }
  assert.deepEqual(r.destinations, hosts.map(production));
  assert.deepEqual(
    r.upstream.requests.map((seen) => seen.servername),
    hosts,
    "SNI is the CONNECT host",
  );
  assert.deepEqual(r.edge.requests, [], "no observed request at the edge");
  await r.edge.reported(() => relayRecords(r.edge).length === hosts.length);
  assert.deepEqual(
    relayRecords(r.edge).map((record) => [
      record.host,
      record.outcome,
      record.status,
    ]),
    hosts.map((host) => [host, "observed", 200]),
  );
});

test("PR4: the inner Host never chooses the destination; the CONNECT host does", async () => {
  const r = await observedRig();
  const answer = await decrypted(
    r.relay.port,
    "claude.ai",
    "GET /x HTTP/1.1\r\nHost: api.anthropic.com\r\nconnection: close\r\n\r\n",
  );
  assert.equal(answer.status, 200);
  assert.deepEqual(r.destinations, [production("claude.ai")]);
  assert.equal(r.upstream.requests[0]!.servername, "claude.ai");
  assert.deepEqual(fieldValues(r.upstream.requests[0]!.rawHeaders, "host"), [
    "api.anthropic.com",
  ]);
  assert.deepEqual(r.edge.requests, []);
});

test("PR4: an observed request reaches the upstream with its end-to-end fields, credentials, cookies, query and binary body; set-cookie reaches the client; one observed report with classes and lengths only", async () => {
  const r = await observedRig();
  const body = Buffer.from(
    Array.from({ length: 1000 }, (_, i) => (i * 31 + 5) & 0xff),
  );
  const head = [
    "POST /api/oauth/thing?code=QUERY-SENTINEL HTTP/1.1",
    "Host: claude.ai",
    "authorization: Bearer CREDENTIAL_SENTINEL",
    "cookie: SENTINEL=1",
    "x-repeat: one",
    "Cookie: second=2",
    "x-pandeck-relay-id: 00000000000000000000000000000000:1",
    "X-Pandeck-Other: forged",
    "x-repeat: two",
    "Connection: keep-alive, X-Nominated",
    "x-nominated: hop",
    "Keep-Alive: timeout=5",
    "Proxy-Connection: keep-alive",
    "TE: trailers",
    "content-type: application/octet-stream",
    `content-length: ${body.length}`,
    "",
    "",
  ].join("\r\n");
  const secure = await secureTo(r.relay.port, "claude.ai");
  const raw = readUntil(secure, (received) => {
    const end = received.indexOf("\r\n\r\n");
    return end !== -1 && received.length >= end + 4 + RESPONSE_BODY.length;
  });
  secure.write(Buffer.concat([Buffer.from(head), body]));
  const answer = parseAnswer(await raw);
  secure.destroy();
  assert.equal(answer.status, 200, answer.head);
  assert.deepEqual(answer.body, RESPONSE_BODY);
  const answered = answer.head.split("\r\n").slice(1);
  assert.deepEqual(
    answered.filter((line) => /^set-cookie:/i.test(line)),
    [
      "set-cookie: session=UPSTREAM-COOKIE; Secure; HttpOnly",
      "set-cookie: second=2",
    ],
  );
  assert.ok(answered.includes("x-upstream: one"));

  const [seen] = r.upstream.requests;
  assert.equal(seen!.url, "/api/oauth/thing?code=QUERY-SENTINEL");
  assert.equal(seen!.servername, "claude.ai");
  assert.deepEqual(seen!.body, body);
  // Everything end-to-end, in order and with repeats; no hop-by-hop field,
  // nothing `Connection` named, no caller x-pandeck-*. Node adds only its own
  // `Connection` for the relay's link.
  const fields = seen!.rawHeaders.filter(
    (name, i) => i % 2 === 1 || name.toLowerCase() !== "connection",
  );
  const pairs: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    if (fields[i]!.toLowerCase() !== "connection")
      pairs.push(`${fields[i]}: ${fields[i + 1]}`);
  assert.deepEqual(pairs, [
    "Host: claude.ai",
    "authorization: Bearer CREDENTIAL_SENTINEL",
    "cookie: SENTINEL=1",
    "x-repeat: one",
    "Cookie: second=2",
    "x-repeat: two",
    "content-type: application/octet-stream",
    `content-length: ${body.length}`,
  ]);
  assert.deepEqual(fieldValues(seen!.rawHeaders, "connection"), ["keep-alive"]);
  assert.deepEqual(r.edge.requests, []);

  const record = await reportedRecord(
    r.edge,
    (delivery) => delivery.host === "claude.ai",
  );
  assert.deepEqual(
    {
      ...record,
      rid: undefined,
      at: undefined,
      durationMs: undefined,
      d: undefined,
    },
    {
      rid: undefined,
      at: undefined,
      durationMs: undefined,
      d: undefined,
      host: "claude.ai",
      method: "POST",
      path: "/api/oauth/thing",
      status: 200,
      outcome: "observed",
      clientCredential: "other",
      clientCookie: true,
      requestBytes: body.length,
      responseBytes: RESPONSE_BODY.length,
    },
  );
  assert.match(record.rid, /^[0-9a-f]{32}:[1-9][0-9]*$/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(relayRecords(r.edge).length, 1, "reported once");
  const surfaces = JSON.stringify(r.edge.batches) + r.logs.join("\n");
  for (const sentinel of ["QUERY-SENTINEL", "SENTINEL", "UPSTREAM-COOKIE"])
    assert.ok(!surfaces.includes(sentinel), sentinel);
});

test("PR4: an upgrade is piped after the upstream's 101 with both buffered heads first, bidirectional binary bytes, and one final report only when the stream ends", async () => {
  const r = await observedRig();
  const secure = await secureTo(r.relay.port, "claude.ai");
  const request = Buffer.concat([
    Buffer.from(
      [
        "GET /api/ws?token=QUERY-SENTINEL HTTP/1.1",
        "Host: claude.ai",
        "Upgrade: websocket",
        "Connection: Upgrade, X-Nominated",
        "x-nominated: hop",
        "Keep-Alive: timeout=5",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "cookie: SENTINEL=1",
        "x-pandeck-relay-id: forged",
        "",
        "",
      ].join("\r\n"),
    ),
    CLIENT_HEAD,
  ]);
  const echoHead = Buffer.concat([Buffer.from("echo:"), CLIENT_HEAD]);
  const first = readUntil(secure, (received) => {
    const end = received.indexOf("\r\n\r\n");
    return (
      end !== -1 &&
      received.length >= end + 4 + SERVER_HEAD.length + echoHead.length
    );
  });
  secure.write(request);
  const opened = await first;
  const end = opened.indexOf("\r\n\r\n");
  const head = opened.subarray(0, end).toString("latin1").split("\r\n");
  assert.equal(head[0], "HTTP/1.1 101 Switching Protocols");
  assert.deepEqual(head.slice(1), [
    "Upgrade: websocket",
    "x-upstream: upgraded",
    "Connection: Upgrade",
  ]);
  assert.deepEqual(
    opened.subarray(end + 4),
    Buffer.concat([SERVER_HEAD, echoHead]),
    "the upstream's head first, then the echo of the client's",
  );
  const [upgrade] = r.upstream.upgrades;
  assert.equal(upgrade!.url, "/api/ws?token=QUERY-SENTINEL");
  assert.equal(upgrade!.servername, "claude.ai");
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "upgrade"), ["websocket"]);
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "connection"), ["Upgrade"]);
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "x-nominated"), []);
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "keep-alive"), []);
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "x-pandeck-relay-id"), []);
  assert.deepEqual(fieldValues(upgrade!.rawHeaders, "cookie"), ["SENTINEL=1"]);
  assert.deepEqual(Buffer.concat(upgrade!.received), CLIENT_HEAD);

  const more = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const echoed = readUntil(
    secure,
    (received) => received.length >= 5 + more.length,
  );
  secure.write(more);
  assert.deepEqual(await echoed, Buffer.concat([Buffer.from("echo:"), more]));
  // Still open: nothing recorded at the 101.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(relayRecords(r.edge), []);

  secure.end();
  await upgrade!.closed;
  const record = await reportedRecord(r.edge);
  assert.equal(record.host, "claude.ai");
  assert.equal(record.method, "GET");
  assert.equal(record.path, "/api/ws");
  assert.equal(record.status, 101);
  assert.equal(record.outcome, "observed");
  assert.equal(record.reason, undefined);
  assert.equal(record.clientCookie, true);
  assert.equal(record.requestBytes, CLIENT_HEAD.length + more.length);
  assert.equal(
    record.responseBytes,
    SERVER_HEAD.length + echoHead.length + 5 + more.length,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(relayRecords(r.edge).length, 1);
  const surfaces = JSON.stringify(r.edge.batches) + r.logs.join("\n");
  assert.ok(!surfaces.includes("SENTINEL"));
});

test("PR4: an upgrade the upstream does not accept is an ordinary answer, then the connection closes; one observed report", async () => {
  const r = await observedRig();
  const answer = await decrypted(
    r.relay.port,
    "claude.ai",
    "GET /no-upgrade HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  assert.equal(answer.status, 426, answer.head);
  assert.equal(answer.body.toString(), "nope");
  assert.match(answer.head, /\r\nConnection: close/);
  const record = await reportedRecord(r.edge);
  assert.equal(record.status, 426);
  assert.equal(record.outcome, "observed");
  assert.equal(record.responseBytes, 4);
});

test("PR4: an upstream whose certificate the default verification refuses is the relay's marked 502, one failed report with its code, for requests and upgrades", async () => {
  // Trusting a different CA than the one that signed the upstream's leaf.
  const r = await observedRig({ ca: interceptCa.certPem });
  const answers = [
    await decrypted(
      r.relay.port,
      "claude.ai",
      "GET /x?q=SENTINEL HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n",
    ),
    await decrypted(
      r.relay.port,
      "claude.com",
      "GET /ws HTTP/1.1\r\nHost: claude.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    ),
  ];
  for (const answer of answers) {
    assert.equal(answer.status, 502, answer.head);
    assert.ok(isGatewayRefusal(answer.body.toString()));
  }
  assert.deepEqual(r.upstream.requests, []);
  assert.deepEqual(r.upstream.upgrades, []);
  assert.deepEqual(r.destinations, [
    production("claude.ai"),
    production("claude.com"),
  ]);
  await r.edge.reported(() => relayRecords(r.edge).length === 2);
  for (const [record, answer] of relayRecords(r.edge).map(
    (record, i) => [record, answers[i]!] as const,
  )) {
    assert.equal(record.outcome, "failed");
    assert.equal(record.status, 502);
    assert.match(record.reason ?? "", /^[A-Z][A-Z0-9_]{0,63}$/);
    assert.equal(record.responseBytes, answer.body.length);
  }
  assert.ok(!r.logs.join("\n").includes("SENTINEL"));
});

test("PR4: a client gone mid-upload aborts the upstream request; one failed client-closed report with measured lengths", async () => {
  const r = await observedRig();
  const secure = await secureTo(r.relay.port, "claude.ai");
  secure.write(
    "POST /hold HTTP/1.1\r\nHost: claude.ai\r\ncontent-length: 1000\r\n\r\n0123456789",
  );
  const deadline = Date.now() + 5000;
  while (!r.upstream.held.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(r.upstream.held.length, 1);
  secure.destroy();
  const record = await reportedRecord(r.edge);
  assert.equal(record.outcome, "failed");
  assert.equal(record.status, null);
  assert.equal(record.reason, "client-closed");
  assert.equal(record.requestBytes, 10);
  assert.equal(record.responseBytes, 0);
  while (!r.upstream.aborted && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(r.upstream.aborted >= 1, "the upstream request was cut");
});

test("PR4: no lifetime strands its reservation: after success, reset, abort, refused and accepted upgrades, two concurrent upgrades still fit the two free slots", async () => {
  const r = await observedRig({ capacity: 3 });
  const settled = async (count: number): Promise<void> => {
    await r.edge.reported(() => relayRecords(r.edge).length === count);
    // The acknowledgement frees the record's slot just after the batch.
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const get = (path: string) =>
    decrypted(
      r.relay.port,
      "claude.ai",
      `GET ${path} HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n`,
    );
  assert.equal((await get("/ok")).status, 200);
  await settled(1);
  assert.equal((await get("/reset")).status, 502);
  await settled(2);
  const aborted = await secureTo(r.relay.port, "claude.ai");
  aborted.write(
    "POST /hold HTTP/1.1\r\nHost: claude.ai\r\ncontent-length: 5\r\n\r\nab",
  );
  const deadline = Date.now() + 5000;
  while (!r.upstream.held.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  aborted.destroy();
  await settled(3);
  assert.equal(
    (
      await decrypted(
        r.relay.port,
        "claude.ai",
        "GET /no-upgrade HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      )
    ).status,
    426,
  );
  await settled(4);
  const upgraded = async () => {
    const secure = await secureTo(r.relay.port, "claude.ai");
    const opened = readUntil(secure, (received) => {
      const end = received.indexOf("\r\n\r\n");
      return end !== -1 && received.length >= end + 4 + SERVER_HEAD.length;
    });
    secure.write(
      "GET /ws HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    assert.match((await opened).toString("latin1"), /^HTTP\/1\.1 101 /);
    return secure;
  };
  const one = await upgraded();
  one.destroy();
  await settled(5);
  const both = [await upgraded(), await upgraded()];
  for (const secure of both) secure.destroy();
  await settled(7);
  assert.deepEqual(
    relayRecords(r.edge).map((record) => [record.status, record.outcome]),
    [
      [200, "observed"],
      [502, "failed"],
      [null, "failed"],
      [426, "observed"],
      [101, "observed"],
      [101, "observed"],
      [101, "observed"],
    ],
  );
  assert.equal(r.logs.filter((line) => line.includes("overflow")).length, 0);
});

test("PR4: close with an open upgraded stream and a held request ends both at the drain deadline, each reported once as relay-closing", async () => {
  const r = await observedRig({ drainMs: 150 });
  const stream = await secureTo(r.relay.port, "claude.ai");
  const opened = readUntil(stream, (received) => {
    const end = received.indexOf("\r\n\r\n");
    return end !== -1 && received.length >= end + 4 + SERVER_HEAD.length;
  });
  stream.write(
    "GET /ws HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  );
  await opened;
  const held = await secureTo(r.relay.port, "downloads.claude.ai");
  held.write("GET /hold HTTP/1.1\r\nHost: downloads.claude.ai\r\n\r\n");
  const deadline = Date.now() + 5000;
  while (!r.upstream.held.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const streamClosed = once(stream, "close");
  const heldClosed = once(held, "close");
  const started = Date.now();
  await r.relay.close();
  assert.ok(Date.now() - started < 3000, "close is bounded");
  await Promise.all([streamClosed, heldClosed, r.upstream.upgrades[0]!.closed]);
  const records = relayRecords(r.edge);
  assert.deepEqual(
    records
      .map((record) => [
        record.host,
        record.status,
        record.outcome,
        record.reason,
      ])
      .sort(),
    [
      ["claude.ai", 101, "observed", "relay-closing"],
      ["downloads.claude.ai", null, "failed", "relay-closing"],
    ],
  );
  assert.equal(new Set(records.map((record) => record.rid)).size, 2);
  assert.ok(!r.logs.some((line) => line.includes("not delivered")));
});

test("PR4: an early upstream answer reaches the client at once; the record waits for the upload to finish and counts all of it", async () => {
  const r = await observedRig();
  const secure = await secureTo(r.relay.port, "claude.ai");
  const answered = readUntil(secure, (received) => {
    const end = received.indexOf("\r\n\r\n");
    return end !== -1 && received.length >= end + 4 + 5;
  });
  secure.write(
    "POST /early HTTP/1.1\r\nHost: claude.ai\r\ncontent-length: 20\r\n\r\n0123456789",
  );
  const answer = parseAnswer(await answered);
  assert.equal(answer.status, 413);
  assert.equal(answer.body.toString(), "early");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(relayRecords(r.edge), [], "upload still open");
  secure.write("abcdefghij");
  const record = await reportedRecord(r.edge);
  assert.equal(record.status, 413);
  assert.equal(record.outcome, "observed");
  assert.equal(record.reason, undefined);
  assert.equal(record.requestBytes, 20);
  assert.equal(record.responseBytes, 5);
  secure.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(relayRecords(r.edge).length, 1);
});

/**
 * A body that, written unframed, is a whole reserved request followed by
 * binary bytes: what F001/F002 let reach the next hop as a second request.
 */
const SMUGGLED = Buffer.concat([
  Buffer.from(
    "POST /relay/observations HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
  ),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x30, 0x0d, 0x0a, 0x0d, 0x0a, 0x81]),
]);

/** A raw request with `body` in two chunks, then the connection closes. */
function chunkedRequest(
  method: string,
  path: string,
  host: string,
  body: Buffer,
): Buffer {
  const chunk = (part: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`${part.length.toString(16)}\r\n`),
      part,
      Buffer.from("\r\n"),
    ]);
  const half = Math.floor(body.length / 2);
  return Buffer.concat([
    Buffer.from(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`,
    ),
    chunk(body.subarray(0, half)),
    chunk(body.subarray(half)),
    Buffer.from("0\r\n\r\n"),
  ]);
}

/** One raw HTTP/1.1 exchange on the relay's plain model listener. */
async function plain(relayPort: number, request: Buffer): Promise<HttpAnswer> {
  const socket = net.connect(relayPort, "127.0.0.1");
  const answer = readToClose(socket);
  socket.write(request);
  return parseAnswer(await answer);
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

test("F001/F002: a chunked GET or DELETE body is sent chunked on the plain, token and observed ingresses: one request each, the same bytes, none of them parsed as a request", async () => {
  const r = await observedRig();
  for (const method of ["GET", "DELETE"]) {
    const viaPlain = await plain(
      r.relay.port,
      chunkedRequest(method, "/v1/thing", "127.0.0.1", SMUGGLED),
    );
    assert.equal(viaPlain.status, 200, viaPlain.head);
    const viaToken = await decrypted(
      r.relay.port,
      "api.anthropic.com",
      chunkedRequest(method, "/v1/thing", "api.anthropic.com", SMUGGLED),
    );
    assert.equal(viaToken.status, 200, viaToken.head);
    const viaObserved = await decrypted(
      r.relay.port,
      "claude.ai",
      chunkedRequest(method, "/api/thing", "claude.ai", SMUGGLED),
    );
    assert.equal(viaObserved.status, 200, viaObserved.head);
  }
  await reportedRecord(
    r.edge,
    (record) => record.host === "claude.ai" && record.method === "DELETE",
  );
  // The edge: exactly the four requests, each re-chunked with its own rid.
  assert.deepEqual(
    r.edge.requests.map((seen) => [seen.method, seen.url]),
    [
      ["GET", "/v1/thing"],
      ["GET", "/anthropic/v1/thing"],
      ["DELETE", "/v1/thing"],
      ["DELETE", "/anthropic/v1/thing"],
    ],
  );
  for (const seen of r.edge.requests) {
    assert.equal(seen.bodySha256, sha256(SMUGGLED), seen.url);
    assert.deepEqual(fieldValues(seen.rawHeaders, "transfer-encoding"), [
      "chunked",
    ]);
    assert.deepEqual(fieldValues(seen.rawHeaders, "content-length"), []);
    assert.equal(fieldValues(seen.rawHeaders, "x-pandeck-relay-id").length, 1);
  }
  assert.equal(r.edge.foreignIngest, 0, "the reserved ingest was never hit");
  // The observed upstream: exactly the two requests, the same bytes.
  assert.deepEqual(
    r.upstream.requests.map((seen) => [
      seen.method,
      seen.url,
      seen.body.equals(SMUGGLED),
      fieldValues(seen.rawHeaders, "transfer-encoding"),
    ]),
    [
      ["GET", "/api/thing", true, ["chunked"]],
      ["DELETE", "/api/thing", true, ["chunked"]],
    ],
  );
  // The edge records the forwarded ones; the relay each observed one, once,
  // with the whole body counted.
  assert.deepEqual(
    relayRecords(r.edge).map((record) => [
      record.host,
      record.method,
      record.path,
      record.status,
      record.requestBytes,
    ]),
    [
      ["claude.ai", "GET", "/api/thing", 200, SMUGGLED.length],
      ["claude.ai", "DELETE", "/api/thing", 200, SMUGGLED.length],
    ],
  );
});

const upgradeTo = (host: string, path: string): string =>
  `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`;

test("F001 audit: an observed upgrade with a chunked body goes up as its head alone; the body is never a second request", async () => {
  const r = await observedRig();
  const secure = await secureTo(r.relay.port, "claude.ai");
  const opened = readUntil(secure, (received) => {
    const end = received.indexOf("\r\n\r\n");
    return end !== -1 && received.length >= end + 4 + SERVER_HEAD.length;
  });
  const request = chunkedRequest("GET", "/ws", "claude.ai", SMUGGLED)
    .toString("latin1")
    .replace(
      "Connection: close\r\n",
      "Upgrade: websocket\r\nConnection: Upgrade\r\n",
    );
  secure.write(Buffer.from(request, "latin1"));
  assert.match((await opened).toString("latin1"), /^HTTP\/1\.1 101 /);
  secure.destroy();
  await reportedRecord(r.edge, (record) => record.status === 101);
  assert.equal(r.upstream.upgrades.length, 1);
  assert.deepEqual(
    fieldValues(r.upstream.upgrades[0]!.rawHeaders, "transfer-encoding"),
    [],
  );
  assert.deepEqual(r.upstream.requests, [], "no request beside the upgrade");
});

test("F003: a /relay/ target on an observed host, request or upgrade, and on a token host's upgrade is the marked 403 reserved-path before any upstream contact; one refused record each", async () => {
  const r = await observedRig();
  assertMarked(
    await decrypted(
      r.relay.port,
      "claude.ai",
      "GET /relay/observations HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n",
    ),
    "reserved-path",
  );
  assertMarked(
    await decrypted(
      r.relay.port,
      "platform.claude.com",
      "POST /relay/x?q=1 HTTP/1.1\r\nHost: platform.claude.com\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
    ),
    "reserved-path",
  );
  assertMarked(
    await decrypted(
      r.relay.port,
      "claude.ai",
      upgradeTo("claude.ai", "/relay/ws"),
    ),
    "reserved-path",
  );
  assertMarked(
    await decrypted(
      r.relay.port,
      "api.anthropic.com",
      upgradeTo("api.anthropic.com", "/relay/ws"),
    ),
    "reserved-path",
  );
  await reportedRecord(r.edge, (record) => record.host === "api.anthropic.com");
  assert.deepEqual(r.destinations, [], "no observed destination was dialled");
  assert.deepEqual(r.upstream.requests, []);
  assert.deepEqual(r.upstream.upgrades, []);
  assert.deepEqual(r.edge.requests, []);
  assert.deepEqual(
    relayRecords(r.edge).map((record) => [
      record.host,
      record.path,
      record.status,
      record.outcome,
      record.reason,
    ]),
    [
      ["claude.ai", "/relay/observations", 403, "refused", "reserved-path"],
      ["platform.claude.com", "/relay/x", 403, "refused", "reserved-path"],
      ["claude.ai", "/relay/ws", 403, "refused", "reserved-path"],
      ["api.anthropic.com", "/relay/ws", 403, "refused", "reserved-path"],
    ],
  );
});

test("F003: with every reporting slot held, an observed /relay/ target is the counted overflow 503, as on the shared forward, and dials nothing", async () => {
  const r = await observedRig({ capacity: 3 });
  const holders = [
    await secureTo(r.relay.port, "claude.ai"),
    await secureTo(r.relay.port, "claude.ai"),
  ];
  for (const [i, secure] of holders.entries())
    secure.write(
      `GET /hold${i} HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n`,
    );
  const deadline = Date.now() + 5000;
  while (r.upstream.held.length < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(r.upstream.held.length, 2);
  const refused = await decrypted(
    r.relay.port,
    "claude.ai",
    "GET /relay/observations HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n",
  );
  assert.equal(refused.status, 503, refused.head);
  assert.ok(isGatewayRefusal(refused.body.toString("utf8")));
  assert.equal(r.destinations.length, 2, "only the held requests dialled");
  for (const { res } of r.upstream.held) res.end();
  for (const secure of holders) secure.destroy();
  const overflow = await r.edge.reported(
    (record) => "note" in record && record.note === "overflow",
  );
  assert.ok("note" in overflow && overflow.note === "overflow");
  assert.equal(overflow.count, 1);
});

/** A request the next hop would parse as a further one if sent unframed. */
const FURTHER = Buffer.from(
  "GET /smuggled-unrecorded HTTP/1.1\r\nHost: claude.ai\r\n\r\n",
);

/** A request whose `Connection` field nominates its framing and `Host`. */
function nominatingRequest(method: string, path: string, host: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: content-length, host, transfer-encoding, close\r\nContent-Length: ${FURTHER.length}\r\n\r\n`,
    ),
    FURTHER,
  ]);
}

test("F001 (m2): a Connection field never removes an observed request's Content-Length or Host; GET and POST go up framed, one request and one record each", async () => {
  const r = await observedRig();
  for (const method of ["GET", "POST"]) {
    const answer = await decrypted(
      r.relay.port,
      "claude.ai",
      nominatingRequest(method, "/api/thing", "inner.claude.ai"),
    );
    assert.equal(answer.status, 200, answer.head);
  }
  await reportedRecord(r.edge, (record) => record.method === "POST");
  assert.deepEqual(
    r.upstream.requests.map((seen) => [
      seen.method,
      seen.url,
      seen.body.equals(FURTHER),
      fieldValues(seen.rawHeaders, "content-length"),
      fieldValues(seen.rawHeaders, "host"),
    ]),
    [
      [
        "GET",
        "/api/thing",
        true,
        [String(FURTHER.length)],
        ["inner.claude.ai"],
      ],
      [
        "POST",
        "/api/thing",
        true,
        [String(FURTHER.length)],
        ["inner.claude.ai"],
      ],
    ],
  );
  assert.deepEqual(
    relayRecords(r.edge).map((record) => [
      record.method,
      record.path,
      record.status,
      record.requestBytes,
    ]),
    [
      ["GET", "/api/thing", 200, FURTHER.length],
      ["POST", "/api/thing", 200, FURTHER.length],
    ],
  );
});

test("F001 (m2) sibling: the plain and token forward keep a Connection-nominated Content-Length; one edge request each with the same body", async () => {
  const r = await observedRig();
  for (const method of ["GET", "DELETE"]) {
    const viaPlain = await plain(
      r.relay.port,
      nominatingRequest(method, "/v1/thing", "127.0.0.1"),
    );
    assert.equal(viaPlain.status, 200, viaPlain.head);
    const viaToken = await decrypted(
      r.relay.port,
      "api.anthropic.com",
      nominatingRequest(method, "/v1/thing", "api.anthropic.com"),
    );
    assert.equal(viaToken.status, 200, viaToken.head);
  }
  assert.deepEqual(
    r.edge.requests.map((seen) => [
      seen.method,
      seen.url,
      seen.bodySha256 === sha256(FURTHER),
      fieldValues(seen.rawHeaders, "content-length"),
    ]),
    [
      ["GET", "/v1/thing", true, [String(FURTHER.length)]],
      ["GET", "/anthropic/v1/thing", true, [String(FURTHER.length)]],
      ["DELETE", "/v1/thing", true, [String(FURTHER.length)]],
      ["DELETE", "/anthropic/v1/thing", true, [String(FURTHER.length)]],
    ],
  );
  assert.equal(r.edge.foreignIngest, 0);
});

test("F001 (m2) audit: an observed upgrade head goes up without a Content-Length or Transfer-Encoding, nominated or not; its body is never a request", async () => {
  const r = await observedRig();
  for (const connection of ["Upgrade", "Upgrade, content-length"]) {
    const secure = await secureTo(r.relay.port, "claude.ai");
    const opened = readUntil(secure, (received) => {
      const end = received.indexOf("\r\n\r\n");
      return end !== -1 && received.length >= end + 4 + SERVER_HEAD.length;
    });
    secure.write(
      Buffer.concat([
        Buffer.from(
          `GET /ws HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: ${connection}\r\nContent-Length: ${FURTHER.length}\r\n\r\n`,
        ),
        FURTHER,
      ]),
    );
    assert.match((await opened).toString("latin1"), /^HTTP\/1\.1 101 /);
    secure.destroy();
  }
  await r.edge.reported(
    () =>
      relayRecords(r.edge).filter((record) => record.status === 101).length ===
      2,
  );
  assert.equal(r.upstream.upgrades.length, 2);
  for (const upgrade of r.upstream.upgrades) {
    assert.deepEqual(fieldValues(upgrade.rawHeaders, "content-length"), []);
    assert.deepEqual(fieldValues(upgrade.rawHeaders, "transfer-encoding"), []);
  }
  assert.deepEqual(r.upstream.requests, [], "no request beside the upgrades");
});
