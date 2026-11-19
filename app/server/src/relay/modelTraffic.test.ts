/** PR2b-facing module contracts, without enabling interception in the relay. */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, test } from "vitest";
import { createModelTraffic, observationPath } from "./modelTraffic.ts";
import { createObservations, type Delivery } from "./observations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function reporting() {
  const records: Delivery[] = [];
  const logs: string[] = [];
  const boot = "b".repeat(32);
  const observations = createObservations({
    boot,
    log: (line) => logs.push(line),
    send: async (batch) => {
      records.push(...batch.records);
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  return { records, logs, boot, observations };
}
async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return (server.address() as { port: number }).port;
}

test("local CONNECT refusals reserve and report method CONNECT, path / and the named host", async () => {
  const r = reporting();
  const traffic = createModelTraffic({
    ...r,
    edge: {},
    edgeHost: "localhost",
    log: (line) => r.logs.push(line),
  });
  const server = http.createServer();
  server.on("connect", (req, socket) =>
    traffic.refuse(req, socket as net.Socket, {
      host: "api.anthropic.com",
      path: "/",
      method: "CONNECT",
      status: 403,
      reason: "connect-port",
      errorType: "permission_error",
      text: "this port is not supported.",
    }),
  );
  const port = await listen(server);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
    });
    socket.on("end", () => {
      socket.destroy();
      resolve(answer);
    });
    socket.on("error", reject);
    socket.write(
      "CONNECT api.anthropic.com:8443 HTTP/1.1\r\nHost: api.anthropic.com:8443\r\nAuthorization: Bearer SENTINEL\r\n\r\n",
    );
  });
  await r.observations.close(100);
  traffic.summary();
  assert.match(response, /^HTTP\/1.1 403 Forbidden/);
  assert.match(response, /Pandeck gateway:/);
  const record = r.records.find((entry) => "rid" in entry);
  assert.ok(record && "rid" in record);
  assert.equal(record.host, "api.anthropic.com");
  assert.equal(record.path, "/");
  assert.equal(record.method, "CONNECT");
  assert.equal(record.reason, "connect-port");
  assert.equal(record.clientCredential, "other");
  assert.equal(record.outcome, "refused");
  assert.ok(!JSON.stringify(r.records).includes("SENTINEL"));
  assert.ok(!r.logs.join("\n").includes("SENTINEL"));
});

test("a closing CONNECT refusal overflows without a second record when admission is full", async () => {
  const records: Delivery[] = [];
  const logs: string[] = [];
  let releaseSend!: () => void;
  let pendingSend!: () => void;
  const pending = new Promise<void>((resolve) => (pendingSend = resolve));
  const observations = createObservations({
    boot: "b".repeat(32),
    capacity: 2,
    log: (line) => logs.push(line),
    send: async (batch) => {
      if (batch.records.some((record) => "rid" in record)) {
        pendingSend();
        await new Promise<void>((resolve) => (releaseSend = resolve));
      }
      records.push(...batch.records);
      return { status: 200, ack: batch.records.at(-1)!.d };
    },
  });
  const traffic = createModelTraffic({
    boot: "b".repeat(32),
    observations,
    edge: {},
    edgeHost: "localhost",
    log: (line) => logs.push(line),
  });
  const server = http.createServer();
  server.on("connect", (req, socket) =>
    traffic.refuse(req, socket as net.Socket, {
      host: "api.anthropic.com",
      path: "/",
      method: "CONNECT",
      status: 403,
      reason: "connect-port",
      errorType: "permission_error",
      text: "this port is not supported.",
    }),
  );
  const port = await listen(server);
  const exchange = () =>
    new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => (answer += chunk));
      socket.on("end", () => resolve(answer));
      socket.on("error", reject);
      socket.write(
        "CONNECT api.anthropic.com:8443 HTTP/1.1\r\nHost: api.anthropic.com:8443\r\n\r\n",
      );
    });

  const first = await exchange();
  assert.match(first, /^HTTP\/1\.1 403 Forbidden/);
  await pending;
  traffic.beginClose();
  assert.equal(traffic.isClosing(), true);
  const overflow = await exchange();
  assert.match(overflow, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.match(overflow, /too busy to report/);
  releaseSend();
  await observations.close(100);
  const measured = records.filter((record) => "rid" in record);
  const notes = records.filter(
    (record) => "note" in record && record.note === "overflow",
  );
  assert.equal(
    measured.length,
    1,
    "the overflowed CONNECT has no request record",
  );
  assert.equal(measured[0]!.method, "CONNECT");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.count, 1);
});

test("HEAD local refusals and unreachable-edge fallbacks record only emitted body bytes", async () => {
  const r = reporting();
  const unused = net.createServer();
  await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const closedPort = (unused.address() as { port: number }).port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const traffic = createModelTraffic({
    ...r,
    edge: { host: "127.0.0.1", port: closedPort, agent: false },
    edgeHost: "localhost",
    log: (line) => r.logs.push(line),
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/relay/test")
      traffic.refuse(req, res, {
        host: "api.anthropic.com",
        path: req.url,
        status: 403,
        reason: "reserved-path",
        errorType: "permission_error",
        text: "reserved",
      });
    else
      traffic.forward(req, res, {
        host: "api.anthropic.com",
        path: req.url ?? "/",
        edgePath: req.url ?? "/",
      });
  });
  const port = await listen(server);
  for (const path of ["/relay/test", "/anthropic/v1/messages"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${path}`,
        { method: "HEAD" },
        (res) => {
          let bytes = 0;
          res.on("data", (chunk: Buffer) => (bytes += chunk.length));
          res.on("end", () => {
            assert.equal(bytes, 0);
            resolve(res.statusCode!);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, path === "/relay/test" ? 403 : 502);
  }
  traffic.beginClose();
  await traffic.drain(100);
  await r.observations.close(100);
  const measured = r.records.filter((entry) => "rid" in entry);
  assert.deepEqual(
    measured.map((entry) => entry.responseBytes),
    [0, 0],
  );
});

test("gateway forwarding accepts caller-supplied fallback host and original path independently of the route", async () => {
  const r = reporting();
  const unused = net.createServer();
  await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const closedPort = (unused.address() as { port: number }).port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const traffic = createModelTraffic({
    ...r,
    edge: { host: "127.0.0.1", port: closedPort, agent: false },
    edgeHost: "localhost",
    log: (line) => r.logs.push(line),
  });
  const server = http.createServer((req, res) =>
    traffic.forward(req, res, {
      host: "mcp-proxy.anthropic.com",
      path: "/original?q=SENTINEL",
      edgePath: "/anthropic-mcp/original?q=SENTINEL",
      headers: ["Host", "localhost", "X-PanDeck-Relay-Id", "forged"],
    }),
  );
  const port = await listen(server);
  await new Promise<void>((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}/original?q=SENTINEL`,
      (res) => {
        assert.equal(res.statusCode, 502);
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
  });
  traffic.beginClose();
  await traffic.drain(100);
  await r.observations.close(100);
  const record = r.records.find((entry) => "rid" in entry);
  assert.ok(record && "rid" in record);
  assert.equal(record.host, "mcp-proxy.anthropic.com");
  assert.equal(record.path, "/original");
  assert.equal(record.reason, "ECONNREFUSED");
  assert.ok(!JSON.stringify(r.records).includes("SENTINEL"));
});

test("Task-1435: observationPath cuts at the first ? or #, before escaping and bounding", () => {
  for (const [raw, expected] of [
    ["/relay/blocked#SENTINEL", "/relay/blocked"],
    ["/relay/blocked?q=SENTINEL#F", "/relay/blocked"],
    ["/relay/blocked#F?q=SENTINEL", "/relay/blocked"],
    ["/a/b?", "/a/b"],
    ["/a/b#", "/a/b"],
    ["#SENTINEL", "/"],
    ["?SENTINEL", "/"],
    ["https://claude.ai/x#SENTINEL", "/"],
    ["/ü#SENTINEL", "/%C3%BC"],
    [`/${"a".repeat(250)}#SENTINEL`, `/${"a".repeat(199)}`],
  ])
    assert.equal(observationPath(raw!), expected, raw);
});
