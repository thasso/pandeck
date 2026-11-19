/** Observed forward lifetimes at module level, below the decrypting ingress. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { loadInterceptCa } from "./interceptCa.ts";
import { createModelTraffic } from "./modelTraffic.ts";
import {
  createObservations,
  type Delivery,
  type Observation,
} from "./observations.ts";
import { createObservedTraffic } from "./observedTraffic.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function listen(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return (server.address() as net.AddressInfo).port;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("F004 (backpressure, module level): an early answer during a large, backed-up upload settles at the answer's finish though the paused request never ends or closes; the real C5 slot is free for the next request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "observed-traffic-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ca = loadInterceptCa(dir);
  let upstreamRequests = 0;
  const upstream = https.createServer(ca.leafFor("claude.ai"), (req, res) => {
    upstreamRequests += 1;
    // Answers a little later, never reading the upload: it backs up.
    if (req.url === "/pressure")
      setTimeout(
        () => res.writeHead(413, { "content-length": 5 }).end("early"),
        50,
      );
    else res.writeHead(200, { "content-length": 2 }).end("ok");
  });
  const upstreamPort = await listen(upstream);

  const records: Delivery[] = [];
  const boot = "d".repeat(32);
  // Capacity 2: the restart note and ONE request slot.
  const observations = createObservations({
    boot,
    capacity: 2,
    log: () => {},
    send: async (batch) => {
      records.push(...batch.records);
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  cleanups.push(() => observations.close(100));
  await pause(30);
  const traffic = createModelTraffic({
    boot,
    observations,
    edge: {},
    edgeHost: "edge.invalid",
    log: () => {},
  });
  const agent = new https.Agent({ keepAlive: true });
  cleanups.push(() => agent.destroy());
  const observed = createObservedTraffic({
    traffic,
    agent,
    upstream: () => ({
      host: "127.0.0.1",
      port: upstreamPort,
      ca: ca.certPem,
    }),
    log: () => {},
  });
  let paused: http.IncomingMessage | undefined;
  const inner = http.createServer((req, res) => {
    if (req.url === "/pressure") paused = req;
    observed.forward(req, res, "claude.ai");
  });
  const innerPort = await listen(inner);

  const client = net.connect(innerPort, "127.0.0.1");
  client.on("error", () => {});
  let response = "";
  client.on("data", (chunk: Buffer) => (response += chunk.toString("latin1")));
  client.write(
    "POST /pressure HTTP/1.1\r\nHost: claude.ai\r\ncontent-length: 16777216\r\n\r\n",
  );
  client.write(Buffer.alloc(8 * 1024 * 1024, 0x41));
  const deadline = Date.now() + 5000;
  while (!response.endsWith("\r\n\r\nearly") && Date.now() < deadline)
    await pause(10);
  assert.match(response, /^HTTP\/1\.1 413 /);
  client.destroy();
  while (
    !records.some((r) => "path" in r && r.path === "/pressure") &&
    Date.now() < deadline
  )
    await pause(10);
  const record = records.find((r) => "path" in r && r.path === "/pressure");
  assert.ok(record && "status" in record, "recorded without its upload");
  assert.deepEqual(
    [record.status, record.outcome, record.reason],
    [413, "observed", undefined],
  );
  assert.ok(record.requestBytes > 0 && record.requestBytes < 16777216);
  assert.equal(paused?.complete, false, "the upload never completed");
  await pause(50);

  const next = await new Promise<number>((resolve, reject) =>
    http
      .get(
        {
          host: "127.0.0.1",
          port: innerPort,
          path: "/next",
          headers: { host: "claude.ai" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      )
      .on("error", reject),
  );
  assert.equal(next, 200, "the slot was free");
  assert.equal(upstreamRequests, 2);
  traffic.beginClose();
  await traffic.drain(0);
});

/**
 * An observed forward at module level: a TLS upstream with `handle` (and
 * `upgrade`, if given), the relay's observed traffic over real
 * observations, and the plain inner server it serves. `recorded` sees each
 * record as the relay writes it, before it is sent.
 */
async function observedHarness(options: {
  handle: http.RequestListener;
  upgrade?: (req: http.IncomingMessage, socket: net.Socket) => void;
  recorded?: (record: Observation) => void;
  /** Each request the inner server reads, before the relay forwards it. */
  inner?: (req: http.IncomingMessage) => void;
}) {
  const dir = mkdtempSync(join(tmpdir(), "observed-traffic-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const ca = loadInterceptCa(dir);
  const upstream = https.createServer(ca.leafFor("claude.ai"), options.handle);
  if (options.upgrade) upstream.on("upgrade", options.upgrade);
  const upstreamPort = await listen(upstream);
  const records: Delivery[] = [];
  const boot = "e".repeat(32);
  const observations = createObservations({
    boot,
    capacity: 8,
    log: () => {},
    send: async (batch) => {
      records.push(...batch.records);
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  cleanups.push(() => observations.close(100));
  const reserve = observations.reserve.bind(observations);
  observations.reserve = () => {
    const slot = reserve();
    return (
      slot && {
        release: () => slot.release(),
        record: (record) => {
          options.recorded?.(record);
          slot.record(record);
        },
      }
    );
  };
  await pause(30);
  const traffic = createModelTraffic({
    boot,
    observations,
    edge: {},
    edgeHost: "edge.invalid",
    log: () => {},
  });
  cleanups.push(async () => {
    traffic.beginClose();
    await traffic.drain(0);
  });
  const agent = new https.Agent({ keepAlive: true });
  cleanups.push(() => agent.destroy());
  const observed = createObservedTraffic({
    traffic,
    agent,
    upstream: () => ({ host: "127.0.0.1", port: upstreamPort, ca: ca.certPem }),
    log: () => {},
  });
  const inner = http.createServer((req, res) => {
    options.inner?.(req);
    observed.forward(req, res, "claude.ai");
  });
  inner.on("upgrade", (req, socket: net.Socket, head: Buffer) =>
    observed.upgrade(req, socket, head, "claude.ai"),
  );
  const innerPort = await listen(inner);
  const recordFor = async (path: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const found = records.find((r) => "path" in r && r.path === path);
      if (found && "status" in found) return found;
      if (Date.now() > deadline) throw new Error(`no record for ${path}`);
      await pause(10);
    }
  };
  return { innerPort, recordFor };
}

/** Sends `request` raw and reads until the relay closes the connection. */
function rawExchange(port: number, request: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.write(request);
  });
}

test("F006: an observed answer in a transfer coding other than chunked alone is the marked 502 transfer-coding, recorded failed; chunked alone still passes, and the next request gets its own answer", async () => {
  const coded = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
  const { innerPort, recordFor } = await observedHarness({
    handle: (req, res) => {
      req.resume();
      if (req.url === "/coded")
        res.writeHead(200, { "Transfer-Encoding": "gzip, chunked" });
      else if (req.url === "/split")
        res.writeHead(200, [
          "Transfer-Encoding",
          "gzip",
          "Transfer-Encoding",
          "chunked",
        ]);
      else res.writeHead(200, { "Transfer-Encoding": " Chunked" });
      res.end(coded);
    },
  });
  for (const path of ["/coded", "/split"]) {
    const answer = (
      await rawExchange(
        innerPort,
        `GET ${path} HTTP/1.1\r\nHost: claude.ai\r\nConnection: close\r\n\r\n`,
      )
    ).toString("latin1");
    assert.match(answer, /^HTTP\/1\.1 502 /);
    assert.match(answer, /Pandeck gateway: /);
    assert.match(answer, /transfer coding the relay cannot forward/);
    assert.ok(!answer.includes("\x1f\x8b"), "none of the coded body");
    const record = await recordFor(path);
    assert.deepEqual(
      [record.status, record.outcome, record.reason],
      [502, "failed", "transfer-coding"],
    );
  }
  const plain = await rawExchange(
    innerPort,
    "GET /plain HTTP/1.1\r\nHost: claude.ai\r\nConnection: close\r\n\r\n",
  );
  const head = plain.subarray(0, plain.indexOf("\r\n\r\n")).toString("latin1");
  assert.match(head, /^HTTP\/1\.1 200 /);
  assert.match(head, /\r\nTransfer-Encoding: chunked/i);
  assert.ok(plain.includes(coded), "chunked alone passes, its body intact");
  const record = await recordFor("/plain");
  assert.deepEqual([record.status, record.outcome], [200, "observed"]);
});

test("F006: an upgrade answered with a non-101 in a transfer coding other than chunked alone is the marked 502 transfer-coding, then the connection closes; recorded failed", async () => {
  const { innerPort, recordFor } = await observedHarness({
    handle: (_req, res) => res.end(),
    upgrade: (_req, socket) => {
      socket.on("error", () => {});
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: gzip, chunked\r\n\r\n3\r\n\x1f\x8b\x08\r\n0\r\n\r\n",
      );
    },
  });
  const answer = (
    await rawExchange(
      innerPort,
      "GET /ws HTTP/1.1\r\nHost: claude.ai\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    )
  ).toString("latin1");
  assert.match(answer, /^HTTP\/1\.1 502 /);
  assert.match(answer, /Pandeck gateway: /);
  assert.ok(!answer.includes("\x1f\x8b"), "none of the coded body");
  const record = await recordFor("/ws");
  assert.deepEqual(
    [record.status, record.outcome, record.reason],
    [502, "failed", "transfer-coding"],
  );
});

test("F007: an early answer during a backed-up upload records no more request bytes than the inner server read from the client", async () => {
  const header = Buffer.from(
    "POST /pressure HTTP/1.1\r\nHost: claude.ai\r\ncontent-length: 16777216\r\n\r\n",
  );
  let inbound: net.Socket | undefined;
  let readAtRecord: number | undefined;
  const { innerPort, recordFor } = await observedHarness({
    // Answers a little later, never reading the upload: it backs up.
    handle: (_req, res) =>
      void setTimeout(
        () => res.writeHead(413, { "content-length": 5 }).end("early"),
        50,
      ),
    inner: (req) => (inbound = req.socket),
    recorded: () => (readAtRecord = inbound?.bytesRead),
  });
  const client = net.connect(innerPort, "127.0.0.1");
  client.on("error", () => {});
  cleanups.push(() => void client.destroy());
  let response = "";
  client.on("data", (chunk: Buffer) => (response += chunk.toString("latin1")));
  await new Promise((resolve) => client.once("connect", resolve));
  client.write(header);
  client.write(Buffer.alloc(8 * 1024 * 1024, 0x41));
  const record = await recordFor("/pressure");
  // Recorded at the answer's finish, which can precede the client's read.
  const deadline = Date.now() + 5000;
  while (!response.endsWith("\r\n\r\nearly") && Date.now() < deadline)
    await pause(10);
  assert.match(response, /^HTTP\/1\.1 413 /);
  assert.ok("requestBytes" in record);
  assert.ok(readAtRecord !== undefined, "the read count at settlement");
  const bodyRead = readAtRecord - header.length;
  assert.ok(record.requestBytes > 0, "the bytes read before the answer");
  assert.ok(
    record.requestBytes <= bodyRead,
    `requestBytes ${record.requestBytes} must not exceed the ${bodyRead} body bytes read`,
  );
});
