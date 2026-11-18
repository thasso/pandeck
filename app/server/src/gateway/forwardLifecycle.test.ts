/** Real-socket lifecycle regressions for Task-1430 F007-F009. */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, test, vi } from "vitest";
import { decodeGatewayUiRequests } from "../../../shared/gatewayUi.ts";
import { createCompatUpstream } from "./compatUpstream.ts";
import { createForwarder, type GatewayStats } from "./forward.ts";
import { LeaseTable } from "./leases.ts";
import { createRequestLog } from "./requestLog.ts";

const CLIENT = { id: "c1", label: "devbox", userId: "u1" };
const PATH = "/compat/v1/chat/completions";
const open: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) await open.pop()!();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise((resolve) => server.close(resolve)));
  if (server instanceof http.Server)
    open.push(() => server.closeAllConnections());
  return (server.address() as net.AddressInfo).port;
}

async function rig(
  upstream: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const upstreamPort = await listen(http.createServer(upstream));
  const compat = createCompatUpstream();
  assert.ok(
    compat.set("a", `http://127.0.0.1:${upstreamPort}/v1`, "fixture-key"),
  );
  const leases = new LeaseTable();
  const lease = leases.grant(
    { profileId: "a", provider: "openai-compatible" },
    { kind: "engine", owner: { workerId: "w1", clientId: CLIENT.id } },
  );
  const lines: string[] = [];
  const requests = createRequestLog({ log: (line) => lines.push(line) });
  const stats: GatewayStats = {
    forwarded: 0,
    refused: 0,
    clientClosed: 0,
    upstreamErrors: 0,
  };
  const agent = new https.Agent();
  const httpAgent = new http.Agent({ keepAlive: true });
  open.push(
    () => agent.destroy(),
    () => httpAgent.destroy(),
  );
  const forwarder = createForwarder({
    leases,
    log: (line) => lines.push(line),
    agent,
    httpAgent,
    upstreams: {},
    compat,
    compatCa: undefined,
    stats,
    vault: {
      credentialFor: () => Promise.resolve({ ok: false, locked: true }),
      upstream401: () => {},
    },
    clientOf: () => CLIENT.id,
    requests: { log: requests, accountName: () => "Account a" },
  });
  const answers: http.ServerResponse[] = [];
  const port = await listen(
    http.createServer((req, res) => {
      answers.push(res);
      forwarder.handleRequest(req, res, CLIENT);
    }),
  );
  return {
    port,
    lease,
    compat,
    answers,
    lines,
    stats,
    requests,
    entries: () => requests.since(CLIENT.userId, undefined, 0, 500).records,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

for (const abort of [false, true])
  test(`a pipelined forwarder refusal ${abort ? "fails on queued abort" : "retains its reason on finish"}`, async () => {
    const r = await rig((req, res) => {
      req.resume();
      res.writeHead(200);
      res.end(abort ? Buffer.alloc(32 * 1024 * 1024, 0x61) : "ok");
    });
    const socket = net.connect(r.port, "127.0.0.1");
    open.push(() => socket.destroy());
    socket.on("error", () => {});
    let received = false;
    socket.on("data", () => {
      received = true;
      if (abort) socket.pause();
    });
    socket.write(
      `POST ${PATH} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${r.lease.token}\r\nContent-Length: 0\r\n\r\n` +
        "POST /nowhere HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n",
    );
    await vi.waitFor(() => assert.equal(r.answers.length, 2));
    if (abort) {
      await vi.waitFor(() => assert.equal(received, true));
      assert.equal(r.answers[0]!.writableFinished, false);
      assert.equal(r.answers[1]!.writableFinished, false);
      assert.equal(r.answers[1]!.socket, null);
      assert.equal(r.entries().length, 0);
      socket.destroy();
    }
    await vi.waitFor(() => assert.equal(r.entries().length, 2));
    const forwarded = r
      .entries()
      .find((e) => e.path === "/v1/chat/completions")!;
    const refused = r.entries().find((e) => e.path === "/nowhere")!;
    assert.deepEqual(
      [forwarded.status, forwarded.outcome, forwarded.reason],
      abort ? [200, "failed", "client-closed"] : [200, "forwarded", undefined],
    );
    assert.deepEqual(
      [refused.status, refused.outcome, refused.reason],
      abort
        ? [null, "failed", "client-closed"]
        : [404, "refused", "unknown-prefix"],
    );
    assert.equal(forwarded.account, "Account a");
    assert.equal(refused.account, undefined);
    await settle();
    assert.equal(r.entries().length, 2);
    assert.equal(r.lines.length, 2);
    assert.ok(r.lines.every((line) => !line.includes(r.lease.token)));
  });

test("a completed marked 503 refusal keeps its reason and account", async () => {
  const r = await rig(() => assert.fail("a refusal must not reach upstream"));
  r.compat.clear("a");
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: r.port,
      path: PATH,
      method: "POST",
      agent: false,
      headers: { authorization: `Bearer ${r.lease.token}` },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      response.resume();
      response.on("end", resolve);
    });
    request.end();
  });
  await vi.waitFor(() => assert.equal(r.entries().length, 1));
  assert.equal(r.answers[0]!.writableFinished, true);
  const [entry] = r.entries();
  assert.deepEqual(
    [entry!.status, entry!.outcome, entry!.reason, entry!.account],
    [503, "refused", "compat-unset", "Account a"],
  );
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0]!.includes(`lease=${r.lease.leaseId}`));
});

test("a synchronous send setup error still records its finished internal-error reply", async () => {
  const r = await rig(() =>
    assert.fail("invalid setup must not reach upstream"),
  );
  vi.spyOn(r.compat, "current").mockReturnValue({
    ...r.compat.current("a")!,
    port: -1,
  });
  let status: number | undefined;
  await new Promise<void>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: r.port,
      path: PATH,
      method: "POST",
      agent: false,
      headers: { authorization: `Bearer ${r.lease.token}` },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      status = response.statusCode;
      response.resume();
      response.on("end", resolve);
    });
    request.end();
  });
  assert.equal(status, 500);
  await vi.waitFor(() => assert.equal(r.entries().length, 1));
  const [entry] = r.entries();
  assert.deepEqual(
    [entry!.status, entry!.outcome, entry!.reason, entry!.account],
    [500, "failed", "internal-error", "Account a"],
  );
  assert.equal(r.lines.length, 1);
});

for (const abort of [false, true])
  test(`an early response ${abort ? "does not hide a later upload abort" : "waits for the full upload without delaying the reply"}`, async () => {
    let upstreamBytes = 0;
    const r = await rig((req, res) => {
      req.on("data", (chunk: Buffer) => {
        upstreamBytes += chunk.length;
        if (!res.headersSent)
          res.writeHead(200, { "content-length": 2 }).end("ok");
      });
    });
    const agent = new http.Agent({ keepAlive: true });
    open.push(() => agent.destroy());
    let socket: net.Socket | undefined;
    const request = http.request({
      host: "127.0.0.1",
      port: r.port,
      path: PATH,
      method: "POST",
      agent,
      headers: {
        authorization: `Bearer ${r.lease.token}`,
        "content-length": 100,
      },
    });
    request.on("socket", (value) => (socket = value));
    request.on("error", () => {});
    const reply = new Promise<void>((resolve) =>
      request.on("response", (response) => {
        assert.equal(response.statusCode, 200);
        response.resume();
        response.on("end", resolve);
      }),
    );
    request.write(Buffer.alloc(5, 0x61));
    await reply;
    assert.equal(upstreamBytes, 5);
    await settle();
    assert.equal(r.entries().length, 0);
    if (abort) socket!.destroy();
    else request.end(Buffer.alloc(95, 0x62));
    await vi.waitFor(() => assert.equal(r.entries().length, 1));
    if (!abort) await vi.waitFor(() => assert.equal(upstreamBytes, 100));
    const [entry] = r.entries();
    assert.deepEqual(
      [entry!.status, entry!.outcome, entry!.reason, entry!.requestBytes],
      abort
        ? [200, "failed", "client-closed", 5]
        : [200, "forwarded", undefined, 100],
    );
    assert.ok(entry!.durationMs >= 40);
    await settle();
    assert.equal(r.entries().length, 1);
    assert.equal(r.lines.length, 1);
  });

test("an upstream that closes its reader after an early reply settles the unfinished upload", async () => {
  const r = await rig((req, res) => {
    req.once("data", () => {
      res
        .writeHead(200, { "content-length": 2, connection: "close" })
        .end("ok");
    });
  });
  const agent = new http.Agent({ keepAlive: true });
  open.push(() => agent.destroy());
  const request = http.request({
    host: "127.0.0.1",
    port: r.port,
    path: PATH,
    method: "POST",
    agent,
    headers: {
      authorization: `Bearer ${r.lease.token}`,
      "content-length": 100,
    },
  });
  open.push(() => request.destroy());
  request.on("error", () => {});
  request.on("response", (response) => response.on("error", () => {}).resume());
  request.write(Buffer.alloc(5, 0x61));
  await vi.waitFor(() => assert.equal(r.entries().length, 1));
  const [entry] = r.entries();
  assert.deepEqual(
    [entry!.status, entry!.outcome, entry!.reason, entry!.requestBytes],
    [200, "failed", "upstream-truncated", 5],
  );
  await settle();
  assert.equal(r.entries().length, 1);
  assert.equal(r.lines.length, 1);
});

test("an upstream answer arriving inside the deferred client-close window is ignored", async () => {
  let reply: http.ServerResponse | undefined;
  const r = await rig((req, res) => {
    req.resume();
    reply = res;
  });
  const request = http.request({
    host: "127.0.0.1",
    port: r.port,
    path: PATH,
    method: "POST",
    agent: false,
    headers: { authorization: `Bearer ${r.lease.token}` },
  });
  request.on("error", () => {});
  request.end();
  await vi.waitFor(() => assert.ok(reply));
  r.answers[0]!.once("close", () => reply!.writeHead(200).end("late"));
  request.destroy();
  await vi.waitFor(() => assert.equal(r.entries().length, 1));
  const [entry] = r.entries();
  assert.deepEqual(
    [entry!.status, entry!.outcome, entry!.reason],
    [null, "failed", "client-closed"],
  );
  assert.equal(r.stats.forwarded, 0);
  await settle();
  assert.equal(r.entries().length, 1);
  assert.equal(r.lines.length, 1);
});

test("a backwards wall clock cannot poison a producer page or hide later requests", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(2_000);
  const r = await rig((req, res) => {
    req.resume();
    req.once("end", () => {
      clock.mockReturnValue(1_000);
      res.end("ok");
    });
  });
  for (let i = 0; i < 2; i++) {
    clock.mockReturnValue(2_000 + i * 1_000);
    await new Promise<void>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: r.port,
        path: PATH,
        method: "POST",
        agent: false,
        headers: { authorization: `Bearer ${r.lease.token}` },
      });
      request.on("error", reject);
      request.on("response", (response) => {
        response.resume();
        response.on("end", resolve);
      });
      request.end("input");
    });
  }
  clock.mockRestore();
  await vi.waitFor(() => assert.equal(r.entries().length, 2));
  const entries = r.entries();
  assert.deepEqual(
    entries.map((e) => e.at),
    [2_000, 3_000],
  );
  assert.ok(
    entries.every(
      (e) => Number.isSafeInteger(e.durationMs) && e.durationMs >= 0,
    ),
  );
  const page = decodeGatewayUiRequests({
    epoch: r.requests.epoch,
    requests: entries,
  });
  assert.ok(page);
  assert.equal(page.requests.length, 2);
  const later = r.requests.since(
    CLIENT.userId,
    page.epoch,
    page.requests[0]!.seq,
    500,
  );
  assert.equal(
    decodeGatewayUiRequests({ epoch: later.epoch, requests: later.records })!
      .requests.length,
    1,
  );
});
