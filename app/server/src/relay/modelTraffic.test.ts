/** PR2b-facing module contracts, without enabling interception in the relay. */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { afterEach, test } from "vitest";
import { createModelTraffic } from "./modelTraffic.ts";
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
