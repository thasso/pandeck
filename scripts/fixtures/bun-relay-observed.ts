/**
 * The bundled relay's observed hosts under the packaged Bun (Task-1430 PR4).
 * `scripts/bun-relay-observed-check.mjs` bundles THIS file with the
 * production bundler and plugins and runs the result with the pinned Bun, so
 * the relay code below is the production code, bundled as `relay.js` is.
 *
 * Everything is local and synthetic: a mutual-TLS observation receiver
 * standing in for the edge, a TLS upstream standing in for every observed
 * host, its own CA, the relay's interception CA and enrollment files. The
 * relay's programmatic seam (`observedUpstream`) swaps the address and trust
 * root only, after this file has checked the production destination, so no
 * provider name is resolved and default verification stays on.
 *
 * Checks: an HTTPS request's fields, body and `set-cookie`; one observed
 * report; a 101 upgrade with both buffered heads and bidirectional bytes,
 * reported once when it ends; an upstream signed by an untrusted CA refused
 * by verification as the relay's marked 502; a bounded relay close. Any
 * failed assertion throws and exits non-zero. Usage: `bun <bundle> <dir>`.
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import tls from "node:tls";
import { GATEWAY_REFUSAL_MARKER } from "../../app/server/src/gateway/refusals.ts";
import {
  edgeTlsFor,
  issueClientCertificate,
} from "../../app/server/src/gateway/x509.ts";
import { loadInterceptCa } from "../../app/server/src/relay/interceptCa.ts";
import type {
  Delivery,
  Observation,
  ObservationBatch,
} from "../../app/server/src/relay/observations.ts";
import { startRelay } from "../../app/server/src/relay/relay.ts";

const SUCCESS = "bun-relay-observed: all checks passed";

const dir = process.argv[2];
if (!dir) throw new Error("Usage: bun-relay-observed <scratch dir>");
mkdirSync(dir, { recursive: true });

const CLIENT_ID = "c_bun_observed";
const UNTRUSTED = "untrusted.claude.com";
const RESPONSE_BODY = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => (i * 13 + 1) & 0xff),
);
const REQUEST_BODY = Buffer.from(
  Array.from({ length: 5000 }, (_, i) => (i * 29 + 3) & 0xff),
);
const SERVER_HEAD = Buffer.from([0x00, 0xff, 0x81, 0x02, 0x53, 0x48]);
const CLIENT_HEAD = Buffer.from([0x82, 0x00, 0x0d, 0x0a, 0xfe]);
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

const closers: (() => Promise<void> | void)[] = [];
const sockets = new Set<net.Socket>();

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as net.AddressInfo).port),
    ),
  );
}
function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function within<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${what}.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fieldValues(rawHeaders: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === name) out.push(rawHeaders[i + 1]!);
  return out;
}

// --- The observation receiver: mutual TLS, the relay's client certificate.
const edgeTls = edgeTlsFor(["127.0.0.1"], undefined);
const clientKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const batches: ObservationBatch[] = [];
const edgeRequests: string[] = [];
/** Model requests' framing and body, and ingest hits holding no batch. */
const edgeSeen: { url: string; te: string[]; bodySha256: string }[] = [];
let foreignIngest = 0;
const receiver = https.createServer(
  {
    key: edgeTls.serverKeyPem,
    cert: edgeTls.serverCertPem,
    ca: edgeTls.caCertPem,
    requestCert: true,
    rejectUnauthorized: true,
  },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url !== "/relay/observations") {
        edgeRequests.push(req.url ?? "");
        edgeSeen.push({
          url: req.url ?? "",
          te: fieldValues(req.rawHeaders, "transfer-encoding"),
          bodySha256: sha(Buffer.concat(chunks)),
        });
        res.writeHead(500).end();
        return;
      }
      let batch: ObservationBatch | undefined;
      try {
        batch = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as ObservationBatch;
      } catch {
        batch = undefined;
      }
      if (!Array.isArray(batch?.records) || !batch.records.length) {
        foreignIngest += 1;
        res.writeHead(400).end();
        return;
      }
      batches.push(batch);
      const body = JSON.stringify({ ack: batch.records.at(-1)!.d });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
  },
);
receiver.on("connection", (socket: net.Socket) => sockets.add(socket));

// --- The observed upstream: its own CA, a leaf per SNI name.
mkdirSync(join(dir, "upstream-ca"), { recursive: true, mode: 0o700 });
const upstreamCa = loadInterceptCa(join(dir, "upstream-ca"));
interface Seen {
  url: string;
  servername: string | false | null;
  rawHeaders: string[];
  bodySha256?: string;
  received?: Buffer[];
}
const upstreamSeen: Seen[] = [];
const fallbackLeaf = upstreamCa.leafFor("claude.ai");
const upstream = https.createServer(
  {
    key: fallbackLeaf.key,
    cert: fallbackLeaf.cert,
    SNICallback: (name, callback) =>
      callback(null, tls.createSecureContext(upstreamCa.leafFor(name))),
  },
  (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamSeen.push({
        url: req.url ?? "",
        servername: (req.socket as tls.TLSSocket).servername,
        rawHeaders: [...req.rawHeaders],
        bodySha256: sha(Buffer.concat(chunks)),
      });
      res.writeHead(200, [
        "content-type",
        "application/octet-stream",
        "set-cookie",
        "session=fake-upstream; Secure; HttpOnly",
        "set-cookie",
        "second=2",
        "content-length",
        String(RESPONSE_BODY.length),
      ]);
      res.end(RESPONSE_BODY);
    });
  },
);
upstream.on("connection", (socket: net.Socket) => sockets.add(socket));
upstream.on(
  "upgrade",
  (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => {});
    const seen: Seen = {
      url: req.url ?? "",
      servername: (req.socket as tls.TLSSocket).servername,
      rawHeaders: [...req.rawHeaders],
      received: [],
    };
    upstreamSeen.push(seen);
    socket.write(
      Buffer.concat([
        Buffer.from(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        ),
        SERVER_HEAD,
      ]),
    );
    const echo = (chunk: Buffer): void => {
      seen.received!.push(chunk);
      socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
    };
    if (head.length) echo(head);
    socket.on("data", echo);
  },
);

/** Polls up to 5 s: reports arrive without an event to wait on. */
async function until<T>(find: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** The first relay record matching, once reported. */
function reported(
  match: (record: Observation) => boolean,
  what: string,
): Promise<Observation> {
  return until(
    () =>
      batches
        .flatMap((batch) => batch.records)
        .find(
          (record: Delivery) =>
            !("note" in record) && match(record as Observation),
        ) as Observation | undefined,
    what,
  );
}
const records = () =>
  batches
    .flatMap((batch) => batch.records)
    .filter((record) => !("note" in record)) as Observation[];

/** A decrypted TLS connection to `host` through the relay's CONNECT. */
async function decrypted(
  relayPort: number,
  host: string,
  caPem: string,
): Promise<tls.TLSSocket> {
  const raw = net.connect(relayPort, "127.0.0.1");
  raw.on("error", () => {});
  await once(raw, "connect");
  raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  let head = Buffer.alloc(0);
  while (!head.includes("\r\n\r\n")) {
    const [chunk] = (await once(raw, "data")) as [Buffer];
    head = Buffer.concat([head, chunk]);
  }
  assert.match(head.toString("latin1"), /^HTTP\/1\.1 200 /);
  raw.pause();
  const secure = tls.connect({ socket: raw, servername: host, ca: [caPem] });
  secure.on("error", () => {});
  await once(secure, "secureConnect");
  assert.equal(secure.authorized, true, "the relay's leaf for the host");
  return secure;
}

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
    const onClose = (): void => {
      if (done(received)) resolve(received);
      else reject(new Error("Closed before the expected bytes."));
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}
const headEnd = (received: Buffer) => received.indexOf("\r\n\r\n");

async function main(): Promise<void> {
  const edgePort = await listen(receiver);
  closers.push(() => closeServer(receiver));
  const upstreamPort = await listen(upstream);
  closers.push(() => closeServer(upstream));

  // The enrolled relay's state, as `relay enroll` leaves it.
  const stateDir = join(dir, "relay");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, "client-key.pem"),
    clientKey.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 },
  );
  writeFileSync(
    join(stateDir, "client-cert.pem"),
    issueClientCertificate(edgeTls, CLIENT_ID, clientKey.publicKey)
      .certificatePem,
  );
  writeFileSync(join(stateDir, "gateway-ca.pem"), edgeTls.caCertPem);
  writeFileSync(
    join(stateDir, "edge.json"),
    JSON.stringify({
      host: "127.0.0.1",
      clientId: CLIENT_ID,
      modelPort: edgePort,
      clientPort: 1,
    }),
  );
  const interceptCa = loadInterceptCa(stateDir);
  const destinations: unknown[] = [];
  const logs: string[] = [];
  const relay = await startRelay({
    stateDir,
    port: 0,
    socketPath: join(dir, "r.sock"),
    interceptCa,
    observedUpstream: (production) => {
      // The production destination, untouched, before the local swap.
      assert.ok(Object.isFrozen(production));
      assert.deepEqual(
        { ...production },
        {
          host: production.host,
          port: 443,
          servername: production.host,
          rejectUnauthorized: true,
        },
      );
      destinations.push({ ...production });
      return {
        host: "127.0.0.1",
        port: upstreamPort,
        // The untrusted host's upstream is signed by a CA the relay does not
        // trust: the relay's own interception CA.
        ca:
          production.host === UNTRUSTED
            ? interceptCa.certPem
            : upstreamCa.certPem,
      };
    },
    drainMs: 300,
    flushMs: 2000,
    log: (line) => logs.push(line),
  });
  let relayClosed = false;
  closers.push(() => (relayClosed ? undefined : relay.close()));
  // Every boot first reports its restart, over the relay's mutual TLS.
  await until(
    () => batches.find((batch) => batch.records.some((r) => "note" in r)),
    "the relay's restart note",
  );

  // 1. An ordinary HTTPS request: fields, binary body, set-cookie, report.
  {
    const secure = await decrypted(
      relay.port,
      "claude.ai",
      interceptCa.certPem,
    );
    sockets.add(secure);
    const answer = readUntil(secure, (received) => {
      const end = headEnd(received);
      return end !== -1 && received.length >= end + 4 + RESPONSE_BODY.length;
    });
    secure.write(
      Buffer.concat([
        Buffer.from(
          [
            "POST /api/bootstrap?q=QUERY-SENTINEL HTTP/1.1",
            "Host: claude.ai",
            "authorization: Bearer CREDENTIAL_SENTINEL",
            "cookie: SENTINEL=1",
            "x-repeat: one",
            "x-pandeck-relay-id: forged",
            "x-repeat: two",
            "Connection: keep-alive, X-Nominated",
            "x-nominated: hop",
            "content-type: application/octet-stream",
            `content-length: ${REQUEST_BODY.length}`,
            "",
            "",
          ].join("\r\n"),
        ),
        REQUEST_BODY,
      ]),
    );
    const received = await within(answer, 5000, "observed HTTPS answer");
    secure.destroy();
    const end = headEnd(received);
    const head = received.subarray(0, end).toString("latin1").split("\r\n");
    assert.match(head[0]!, /^HTTP\/1\.1 200 /);
    assert.deepEqual(
      head.filter((line) => /^set-cookie:/i.test(line)),
      [
        "set-cookie: session=fake-upstream; Secure; HttpOnly",
        "set-cookie: second=2",
      ],
    );
    assert.equal(sha(received.subarray(end + 4)), sha(RESPONSE_BODY));
    const seen = upstreamSeen.find((s) => s.url.startsWith("/api/bootstrap"));
    assert.ok(seen, "the upstream got the request");
    assert.equal(seen.url, "/api/bootstrap?q=QUERY-SENTINEL");
    assert.equal(seen.servername, "claude.ai", "SNI is the CONNECT host");
    assert.equal(seen.bodySha256, sha(REQUEST_BODY));
    assert.deepEqual(fieldValues(seen.rawHeaders, "authorization"), [
      "Bearer CREDENTIAL_SENTINEL",
    ]);
    assert.deepEqual(fieldValues(seen.rawHeaders, "cookie"), ["SENTINEL=1"]);
    assert.deepEqual(fieldValues(seen.rawHeaders, "x-repeat"), ["one", "two"]);
    assert.deepEqual(fieldValues(seen.rawHeaders, "x-nominated"), []);
    assert.deepEqual(fieldValues(seen.rawHeaders, "x-pandeck-relay-id"), []);
    const record = await reported(
      (r) => r.path === "/api/bootstrap",
      "observed HTTPS request",
    );
    assert.deepEqual(
      [record.host, record.method, record.status, record.outcome],
      ["claude.ai", "POST", 200, "observed"],
    );
    assert.equal(record.clientCredential, "other");
    assert.equal(record.clientCookie, true);
    assert.equal(record.requestBytes, REQUEST_BODY.length);
    assert.equal(record.responseBytes, RESPONSE_BODY.length);
  }

  // 2. A 101 upgrade: both buffered heads, bidirectional bytes, one report
  //    when the stream ends and not before.
  {
    const secure = await decrypted(
      relay.port,
      "claude.ai",
      interceptCa.certPem,
    );
    sockets.add(secure);
    const echoHead = Buffer.concat([Buffer.from("echo:"), CLIENT_HEAD]);
    const opened = readUntil(secure, (received) => {
      const end = headEnd(received);
      return (
        end !== -1 &&
        received.length >= end + 4 + SERVER_HEAD.length + echoHead.length
      );
    });
    secure.write(
      Buffer.concat([
        Buffer.from(
          "GET /api/ws HTTP/1.1\r\nHost: claude.ai\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        ),
        CLIENT_HEAD,
      ]),
    );
    const received = await within(opened, 5000, "the 101 and both heads");
    const end = headEnd(received);
    assert.match(
      received.subarray(0, end).toString("latin1"),
      /^HTTP\/1\.1 101 /,
    );
    assert.equal(
      sha(received.subarray(end + 4)),
      sha(Buffer.concat([SERVER_HEAD, echoHead])),
    );
    const more = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const echoed = readUntil(secure, (r) => r.length >= 5 + more.length);
    secure.write(more);
    assert.equal(
      sha(await within(echoed, 5000, "the echo")),
      sha(Buffer.concat([Buffer.from("echo:"), more])),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(
      !records().some((r) => r.path === "/api/ws"),
      "nothing is recorded at the 101",
    );
    const upgrade = upstreamSeen.find((s) => s.url === "/api/ws");
    assert.ok(upgrade?.received);
    assert.equal(upgrade.servername, "claude.ai");
    assert.equal(
      sha(Buffer.concat(upgrade.received)),
      sha(Buffer.concat([CLIENT_HEAD, more])),
    );
    secure.end();
    const record = await reported((r) => r.path === "/api/ws", "the upgrade");
    assert.equal(record.status, 101);
    assert.equal(record.outcome, "observed");
    assert.equal(record.requestBytes, CLIENT_HEAD.length + more.length);
    assert.equal(
      record.responseBytes,
      SERVER_HEAD.length + echoHead.length + 5 + more.length,
    );
  }

  // 3. Default verification refuses an upstream the relay does not trust.
  {
    const secure = await decrypted(relay.port, UNTRUSTED, interceptCa.certPem);
    sockets.add(secure);
    const closed = once(secure, "close");
    const chunks: Buffer[] = [];
    secure.on("data", (chunk: Buffer) => chunks.push(chunk));
    secure.write(
      `GET /refused HTTP/1.1\r\nHost: ${UNTRUSTED}\r\nconnection: close\r\n\r\n`,
    );
    await within(closed, 5000, "the refusal");
    const text = Buffer.concat(chunks).toString("utf8");
    assert.match(text, /^HTTP\/1\.1 502 /);
    assert.ok(text.includes(GATEWAY_REFUSAL_MARKER), "a marked refusal");
    assert.ok(!upstreamSeen.some((s) => s.url === "/refused"));
    const record = await reported(
      (r) => r.host === UNTRUSTED,
      "the refused upstream",
    );
    assert.equal(record.outcome, "failed");
    assert.equal(record.status, 502);
    assert.match(record.reason ?? "", /^[A-Z][A-Z0-9_]{0,63}$/);
    console.log(`verification refusal reason: ${record.reason}`);
  }

  assert.deepEqual(destinations, [
    {
      host: "claude.ai",
      port: 443,
      servername: "claude.ai",
      rejectUnauthorized: true,
    },
    {
      host: "claude.ai",
      port: 443,
      servername: "claude.ai",
      rejectUnauthorized: true,
    },
    {
      host: UNTRUSTED,
      port: 443,
      servername: UNTRUSTED,
      rejectUnauthorized: true,
    },
  ]);
  assert.deepEqual(edgeRequests, [], "no observed request reached the edge");
  assert.equal(records().length, 3, "each request reported exactly once");
  const surfaces = JSON.stringify(batches) + logs.join("\n");
  for (const sentinel of ["QUERY-SENTINEL", "SENTINEL", "fake-upstream"])
    assert.ok(!surfaces.includes(sentinel), `${sentinel} leaked`);

  // 4. A chunked DELETE body is sent chunked on every ingress (F001/F002):
  //    unframed, these bytes would be a second, reserved request.
  {
    const smuggled = Buffer.concat([
      Buffer.from(
        "POST /relay/observations HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-length: 2\r\n\r\n{}",
      ),
      Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x81]),
    ]);
    const chunked = (path: string, host: string): Buffer =>
      Buffer.concat([
        Buffer.from(
          `DELETE ${path} HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${smuggled.length.toString(16)}\r\n`,
        ),
        smuggled,
        Buffer.from("\r\n0\r\n\r\n"),
      ]);
    const exchange = async (
      socket: net.Socket,
      request: Buffer,
    ): Promise<string> => {
      sockets.add(socket);
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      const closed = once(socket, "close");
      socket.write(request);
      await within(closed, 5000, "a framed exchange");
      return Buffer.concat(chunks).toString("latin1");
    };
    const plainSocket = net.connect(relay.port, "127.0.0.1");
    plainSocket.on("error", () => {});
    await once(plainSocket, "connect");
    assert.match(
      await exchange(plainSocket, chunked("/v1/framed", "127.0.0.1")),
      /^HTTP\/1\.1 500 /,
    );
    assert.match(
      await exchange(
        await decrypted(relay.port, "api.anthropic.com", interceptCa.certPem),
        chunked("/v1/framed", "api.anthropic.com"),
      ),
      /^HTTP\/1\.1 500 /,
    );
    assert.match(
      await exchange(
        await decrypted(relay.port, "claude.ai", interceptCa.certPem),
        chunked("/api/framed", "claude.ai"),
      ),
      /^HTTP\/1\.1 200 /,
    );
    assert.deepEqual(edgeSeen, [
      { url: "/v1/framed", te: ["chunked"], bodySha256: sha(smuggled) },
      {
        url: "/anthropic/v1/framed",
        te: ["chunked"],
        bodySha256: sha(smuggled),
      },
    ]);
    const others = upstreamSeen.filter((seen) => seen.url !== "/api/bootstrap");
    assert.deepEqual(
      upstreamSeen
        .filter((seen) => seen.url === "/api/framed")
        .map((seen) => [
          fieldValues(seen.rawHeaders, "transfer-encoding"),
          seen.bodySha256,
        ]),
      [[["chunked"], sha(smuggled)]],
    );
    assert.ok(
      !others.some((seen) => seen.url.startsWith("/relay/")),
      "no smuggled request at the upstream",
    );
    await reported(
      (r) => r.path === "/api/framed" && r.requestBytes === smuggled.length,
      "the framed observed request",
    );
  }

  // 5. A /relay/ target on an observed host is the marked 403 (F003).
  {
    const secure = await decrypted(
      relay.port,
      "claude.ai",
      interceptCa.certPem,
    );
    sockets.add(secure);
    const chunks: Buffer[] = [];
    secure.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = once(secure, "close");
    secure.write(
      "GET /relay/observations HTTP/1.1\r\nHost: claude.ai\r\nconnection: close\r\n\r\n",
    );
    await within(closed, 5000, "the reserved-path refusal");
    const text = Buffer.concat(chunks).toString("utf8");
    assert.match(text, /^HTTP\/1\.1 403 /);
    assert.ok(text.includes(GATEWAY_REFUSAL_MARKER), "a marked refusal");
    const record = await reported(
      (r) => r.path === "/relay/observations",
      "the reserved-path refusal",
    );
    assert.equal(record.reason, "reserved-path");
  }
  assert.equal(foreignIngest, 0, "the reserved ingest was never reached");
  assert.equal(
    upstreamSeen.filter((seen) => seen.url.startsWith("/relay/")).length,
    0,
  );
  assert.equal(destinations.length, 4, "the reserved path dialled nothing");
  console.log("framing: chunked on plain, token and observed; reserved 403");

  const started = Date.now();
  await within(relay.close(), 5000, "the relay's close");
  relayClosed = true;
  assert.ok(Date.now() - started < 5000);
}

try {
  await main();
  console.log(
    `runtime: ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`,
  );
  console.log(SUCCESS);
} finally {
  for (const socket of sockets) socket.destroy();
  while (closers.length) await closers.pop()!();
}
