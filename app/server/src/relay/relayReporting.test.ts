/** Relay-only recording mTLS receiver. This is not real-edge ingest evidence. */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, test } from "vitest";
import { edgeTlsFor, issueClientCertificate } from "../gateway/x509.ts";
import { MACHINE_PLACEHOLDER } from "./credentialClass.ts";
import { RELAY_REFUSAL_MARKER } from "./modelTraffic.ts";
import type { Delivery, ObservationBatch } from "./observations.ts";
import { startRelay, type RelayOptions, type RunningRelay } from "./relay.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});
const sha = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
const tlsState = edgeTlsFor(["127.0.0.1", "localhost"], undefined);

type Received = {
  path: string;
  headers: string[];
  hash: string;
  bytes: number;
  req: http.IncomingMessage;
  res: http.ServerResponse;
};
async function rig(extra: Partial<RelayOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "relay-report-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const events = new EventEmitter();
  const requests: Received[] = [];
  const incoming: http.IncomingMessage[] = [];
  const batches: ObservationBatch[] = [];
  const records: Delivery[] = [];
  const acks = new Map<string, number>();
  const logs: string[] = [];
  const sockets = new Set<Duplex>();
  let mode:
    | "normal"
    | "reset"
    | "hold"
    | "headers"
    | "reject-batches"
    | "stall-batches" = "normal";
  const receiver = https.createServer(
    {
      key: tlsState.serverKeyPem,
      cert: tlsState.serverCertPem,
      ca: tlsState.caCertPem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      assert.equal(
        (req.socket as import("node:tls").TLSSocket).authorized,
        true,
      );
      incoming.push(req);
      req.on("aborted", () => events.emit("change"));
      const chunks: Buffer[] = [];
      req.on("error", () => {});
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        events.emit("change");
      });
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.url === "/relay/observations") {
          const batch = JSON.parse(body.toString("utf8")) as ObservationBatch;
          batches.push(batch);
          if (mode === "reject-batches") res.writeHead(503).end();
          else if (mode !== "stall-batches") {
            // Recording receiver models only d/ack, not the edge's rid dedup.
            records.push(
              ...batch.records.filter(
                (record) => record.d > (acks.get(batch.boot) ?? 0),
              ),
            );
            const ack = batch.records.at(-1)!.d;
            acks.set(batch.boot, ack);
            res.end(JSON.stringify({ ack }));
          }
        } else {
          requests.push({
            path: req.url ?? "",
            headers: req.rawHeaders,
            hash: sha(body),
            bytes: body.length,
            req,
            res,
          });
          if (mode === "reset") req.socket.destroy();
          else if (mode === "headers") {
            res.writeHead(200);
            res.flushHeaders();
            res.write("stream");
          } else if (mode !== "hold") {
            res.writeHead(201, [
              "content-type",
              "text/plain",
              "x-repeat",
              "one",
              "x-repeat",
              "two",
            ]);
            res.end("answer");
          }
        }
        events.emit("change");
      });
    },
  );
  receiver.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  });
  const port = (receiver.address() as { port: number }).port;
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const cert = issueClientCertificate(tlsState, "c_reporting", key.publicKey);
  writeFileSync(
    join(dir, "client-key.pem"),
    key.privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  writeFileSync(join(dir, "client-cert.pem"), cert.certificatePem);
  writeFileSync(join(dir, "gateway-ca.pem"), tlsState.caCertPem);
  writeFileSync(
    join(dir, "edge.json"),
    JSON.stringify({
      host: "127.0.0.1",
      clientId: "c_reporting",
      modelPort: port,
      clientPort: port,
    }),
  );
  const options: RelayOptions = {
    stateDir: dir,
    port: 0,
    socketPath: join(dir, "control.sock"),
    log: (line) => logs.push(line),
    drainMs: 50,
    flushMs: 500,
    observations: { retryMs: 10, retryMaxMs: 20, responseMs: 250 },
    ...extra,
  };
  let relay = await startRelay(options);
  cleanup.push(() => relay.close());
  async function until(predicate: () => boolean): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        events.removeListener("change", changed);
        reject(new Error("Receiver condition timed out."));
      }, 2000);
      const changed = () => {
        if (predicate()) {
          clearTimeout(timer);
          events.removeListener("change", changed);
          resolve();
        }
      };
      events.on("change", changed);
    });
  }
  await until(() => records.length === 1);
  // The receiver's end event precedes the relay reading the ack.
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    dir,
    options,
    get relay() {
      return relay;
    },
    requests,
    incoming,
    batches,
    records,
    logs,
    until,
    setMode(value: typeof mode) {
      mode = value;
    },
    async restart() {
      await relay.close();
      relay = await startRelay(options);
    },
    resetHeld() {
      for (const request of requests) request.req.socket.destroy();
    },
  };
}

function exchange(
  relay: RunningRelay,
  path: string,
  body = "",
  headers: string[] = [],
) {
  return new Promise<{ status: number; body: string; rawHeaders: string[] }>(
    (resolve, reject) => {
      const req = http.request(
        `${relay.url}${path}`,
        {
          method: body ? "POST" : "GET",
          headers: [
            "host",
            `127.0.0.1:${relay.port}`,
            "content-length",
            String(Buffer.byteLength(body)),
            ...headers,
          ],
        },
        (res) => {
          let answer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            answer += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: answer,
              rawHeaders: res.rawHeaders,
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
function requestsOnly(records: Delivery[]) {
  return records.filter((record) => "rid" in record);
}

test("plain forwarding preserves bytes and repeats, strips every caller reserved header and sets one rid", async () => {
  const r = await rig();
  const body = "SENTINEL-body".repeat(100);
  const response = await exchange(
    r.relay,
    "/anthropic/v1/messages?q=SENTINEL",
    body,
    [
      "authorization",
      `Bearer ${MACHINE_PLACEHOLDER}`,
      "anthropic-beta",
      "one",
      "anthropic-beta",
      "two",
      "x-pandeck-relay-id",
      "forged",
      "X-Pandeck-Relay-Id",
      "forged",
      "x-pandeck-other",
      "forged",
    ],
  );
  assert.equal(response.status, 201);
  assert.equal(response.body, "answer");
  assert.deepEqual(response.rawHeaders.slice(0, 6), [
    "content-type",
    "text/plain",
    "x-repeat",
    "one",
    "x-repeat",
    "two",
  ]);
  assert.equal(r.requests[0]!.path, "/anthropic/v1/messages?q=SENTINEL");
  assert.equal(r.requests[0]!.hash, sha(body));
  const fields = r.requests[0]!.headers.reduce<string[][]>(
    (pairs, name, i, headers) => {
      if (i % 2 === 0) pairs.push([name.toLowerCase(), headers[i + 1]!]);
      return pairs;
    },
    [],
  );
  const reserved = fields.filter(([name]) => name!.startsWith("x-pandeck-"));
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0]![0], "x-pandeck-relay-id");
  assert.match(reserved[0]![1]!, /^[0-9a-f]{32}:1$/);
  assert.deepEqual(
    fields.filter(([name]) => name === "anthropic-beta"),
    [
      ["anthropic-beta", "one"],
      ["anthropic-beta", "two"],
    ],
  );
  await r.relay.close();
  assert.equal(requestsOnly(r.records).length, 0);
  assert.ok(!r.logs.join("\n").includes("SENTINEL"));
  assert.ok(
    r.logs.some((line) => line.includes("127.0.0.1 forwarded placeholder=1")),
  );
});

test("pre-header reset creates one length-only, query-free fallback; existing 502 stays unmarked", async () => {
  const r = await rig();
  r.setMode("reset");
  const body = "SENTINEL".repeat(500);
  const response = await exchange(
    r.relay,
    "/anthropic/v1/messages?q=SENTINEL",
    body,
    ["authorization", "Bearer SENTINEL", "cookie", "SENTINEL"],
  );
  assert.equal(response.status, 502);
  assert.ok(!response.body.includes(RELAY_REFUSAL_MARKER));
  await r.until(() => requestsOnly(r.records).length === 1);
  const record = requestsOnly(r.records)[0]!;
  assert.equal(record.outcome, "failed");
  assert.equal(record.status, 502);
  assert.equal(record.path, "/anthropic/v1/messages");
  assert.equal(record.host, "127.0.0.1");
  assert.equal(record.reason, "ECONNRESET");
  assert.equal(record.requestBytes, Buffer.byteLength(body));
  assert.equal(record.responseBytes, Buffer.byteLength(response.body));
  assert.equal(record.clientCredential, "other");
  assert.equal(record.clientCookie, true);
  assert.ok(!JSON.stringify(r.batches).includes("SENTINEL"));
  assert.ok(!r.logs.join("\n").includes("SENTINEL"));
});

test("a stalled report answer times out, resends the same d and does not block later reporting", async () => {
  const r = await rig({ observations: { retryMs: 10, responseMs: 40 } });
  const before = r.batches.length;
  r.setMode("stall-batches");
  await exchange(r.relay, "/relay/stalled");
  await r.until(() => r.batches.length >= before + 2);
  assert.deepEqual(r.batches[before], r.batches[before + 1]);
  r.setMode("normal");
  await r.until(() => requestsOnly(r.records).length === 1);
  assert.equal(requestsOnly(r.records)[0]!.path, "/relay/stalled");
});

test("reserved paths get a marked local 403 with one record and no gateway request", async () => {
  const r = await rig();
  const response = await exchange(
    r.relay,
    "/relay/observations?q=SENTINEL",
    "SENTINEL",
  );
  assert.equal(response.status, 403);
  assert.match(
    JSON.parse(response.body).error.message as string,
    /^Pandeck gateway:/,
  );
  await r.until(() => requestsOnly(r.records).length === 1);
  assert.equal(r.requests.length, 0);
  const record = requestsOnly(r.records)[0]!;
  assert.equal(record.reason, "reserved-path");
  assert.equal(record.outcome, "refused");
  assert.equal(record.path, "/relay/observations");
  assert.ok(!JSON.stringify(r.batches).includes("SENTINEL"));
});

test("capacity is reserved before forwarding, including reserved-path refusals; overflow aggregates", async () => {
  const r = await rig({
    observations: { capacity: 5, retryMs: 10, responseMs: 100 },
  });
  r.setMode("hold");
  const pending = Array.from({ length: 4 }, (_, n) =>
    exchange(r.relay, `/held/${n}`),
  );
  await r.until(() => r.requests.length === 4);
  const fifth = await exchange(r.relay, "/fifth");
  const reserved = await exchange(r.relay, "/relay/x");
  for (const response of [fifth, reserved]) {
    assert.equal(response.status, 503);
    assert.match(
      JSON.parse(response.body).error.message as string,
      /^Pandeck gateway:/,
    );
  }
  assert.equal(r.requests.length, 4);
  r.resetHeld();
  r.setMode("normal");
  await Promise.all(pending);
  await r.until(
    () =>
      requestsOnly(r.records).length === 4 &&
      r.records.some(
        (record) => "note" in record && record.note === "overflow",
      ),
  );
  const notes = r.records.filter(
    (record) => "note" in record && record.note === "overflow",
  );
  assert.equal(notes.length, 1);
  assert.equal("count" in notes[0]! && notes[0]!.count, 2);
  assert.equal(
    new Set(requestsOnly(r.records).map((record) => record.rid)).size,
    4,
  );
});

test("close drains active streams, cuts pre-header work into one fallback and is idempotent", async () => {
  const r = await rig();
  r.setMode("headers");
  let streamClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    streamClosed = resolve;
  });
  let gotHeaders!: () => void;
  const headers = new Promise<void>((resolve) => {
    gotHeaders = resolve;
  });
  const streaming = http.get(`${r.relay.url}/stream`, (res) => {
    gotHeaders();
    res.resume();
    res.on("close", streamClosed);
    res.on("error", () => {});
  });
  streaming.on("error", () => {});
  await r.until(() => r.requests.length === 1);
  // Observe response headers at the caller, not merely the receiver writing them.
  await headers;
  r.setMode("hold");
  const held = http.get(`${r.relay.url}/held`);
  held.on("error", () => {});
  await r.until(() => r.requests.length === 2);
  const started = Date.now();
  const close = r.relay.close();
  assert.equal(r.relay.close(), close);
  await close;
  await closed;
  assert.ok(Date.now() - started >= 40);
  assert.ok(Date.now() - started < 1000);
  const fallbacks = requestsOnly(r.records);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0]!.path, "/held");
  assert.equal(fallbacks[0]!.reason, "relay-closing");
  assert.equal(fallbacks[0]!.status, null);
  assert.ok(r.logs.some((line) => line.includes("forwarded none=1")));
});

test("caller abort before headers cancels every upstream link and reports once with actual lengths", async () => {
  const r = await rig();
  const body = "SENTINEL-partial";
  const req = http.request(`${r.relay.url}/partial?q=SENTINEL`, {
    method: "POST",
    headers: { "content-length": "100000", authorization: "Bearer SENTINEL" },
  });
  req.on("error", () => {});
  req.write(body);
  await r.until(() =>
    r.incoming.some(
      (incoming) =>
        incoming.url?.startsWith("/partial") && incoming.readableLength === 0,
    ),
  );
  const upstream = r.incoming.find((incoming) =>
    incoming.url?.startsWith("/partial"),
  )!;
  req.destroy();
  await r.until(() => upstream.aborted && requestsOnly(r.records).length === 1);
  const record = requestsOnly(r.records)[0]!;
  assert.equal(record.reason, "client-closed");
  assert.equal(record.status, null);
  assert.equal(record.requestBytes, Buffer.byteLength(body));
  assert.equal(record.responseBytes, 0);
  assert.ok(!JSON.stringify(r.batches).includes("SENTINEL"));
});

test("new requests on an active keep-alive connection during drain get a marked closing refusal", async () => {
  const r = await rig({ drainMs: 500 });
  r.setMode("hold");
  const socket = net.connect(r.relay.port, "127.0.0.1");
  let answer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    answer += chunk;
  });
  const ended = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.on("error", () => {});
  socket.write("GET /first HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await r.until(() => r.requests.length === 1);
  const closing = r.relay.close();
  socket.write("GET /during-close HTTP/1.1\r\nHost: localhost\r\n\r\n");
  // The first response must finish before HTTP/1.1 can send the queued refusal.
  // Waiting for its report proves the closing handler ran on the actual socket.
  await r.until(() =>
    requestsOnly(r.records).some((record) => record.reason === "relay-closing"),
  );
  r.requests[0]!.res.end("done");
  await closing;
  await ended;
  assert.match(answer, /HTTP\/1\.1 503/);
  assert.match(answer, /Pandeck gateway:/);
  assert.equal(r.requests.length, 1);
  const records = requestsOnly(r.records);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.path, "/during-close");
  assert.equal(records[0]!.status, 503);
});

test("close deadline reports a count, writes no observation file and every boot reports unknown loss", async () => {
  const r = await rig();
  const before = readdirSync(r.dir)
    .filter((file) => file !== "control.sock")
    .sort();
  r.setMode("reject-batches");
  // A local refusal queues while delivery is unavailable.
  await exchange(r.relay, "/relay/x");
  await r.relay.close();
  assert.deepEqual(
    r.logs.filter((line) => line.includes("not delivered at close")),
    ["observations: 1 not delivered at close"],
  );
  assert.deepEqual(
    readdirSync(r.dir)
      .filter((file) => file !== "control.sock")
      .sort(),
    before,
  );
  r.setMode("normal");
  await r.restart();
  await r.until(
    () =>
      r.records.filter(
        (record) => "note" in record && record.note === "relay-restarted",
      ).length === 2,
  );
  const restarts = r.records.filter(
    (record) => "note" in record && record.note === "relay-restarted",
  );
  assert.ok(restarts.every((record) => !("count" in record) && record.d === 1));
  assert.notEqual(r.batches[0]!.boot, r.batches.at(-1)!.boot);
});
