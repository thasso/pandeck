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
import type { Delivery, ObservationBatch } from "./observations.ts";
import { startRelay, type RunningRelay } from "./relay.ts";

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

interface Recorded {
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
  /** Resolves once a batch holding a record that matches arrives. */
  reported(match: (record: Delivery) => boolean): Promise<Delivery>;
}

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
beforeAll(() => {
  interceptCa = loadInterceptCa(mkdtempSync(join(root, "ca-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function recordingEdge(): Promise<RecordingEdge> {
  const waiting = new Set<() => void>();
  const edge: RecordingEdge = {
    port: 0,
    requests: [],
    batches: [],
    connections: 0,
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
          const batch = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as ObservationBatch;
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
async function started(withCa = true): Promise<Started> {
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
