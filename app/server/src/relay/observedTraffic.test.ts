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
import { createObservations, type Delivery } from "./observations.ts";
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
