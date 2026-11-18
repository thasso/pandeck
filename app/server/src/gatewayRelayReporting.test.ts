/** Real relay + real edge C2/C4/C5 integration. No provider network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import dns from "node:dns";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { GatewayOptions, RunningGateway } from "./gateway/gateway.ts";
import type { ObservationsCommitted } from "./gateway/relayObservations.ts";
import type { RequestRecord } from "./gateway/requestLog.ts";
import type { RunningRelay } from "./relay/relay.ts";
import { createObservations } from "./relay/observations.ts";
import { createModelTraffic } from "./relay/modelTraffic.ts";
import { MACHINE_PLACEHOLDER } from "./relay/credentialClass.ts";

const home = mkdtempSync(join(tmpdir(), "relay-real-edge-home-"));
process.env.HOME = home;
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { fakeProcesses, startFakeUpstreams } =
  await import("./test/gatewayFixtures.ts");
const { createEdgeTools } = await import("./gatewayTools/index.ts");
const open: (() => Promise<void> | void)[] = [];
let upstreams: Awaited<ReturnType<typeof startFakeUpstreams>>;
let upstreamAction: (() => void) | undefined;
let upstreamStream = false;
let upstreamWait: Promise<void> | undefined;
beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: (_seen, res) => {
      upstreamAction?.();
      const answer = () => {
        res.writeHead(200, {
          "content-type": upstreamStream
            ? "text/event-stream"
            : "application/json",
        });
        if (upstreamStream) res.write("data: stream\n\n");
        else res.end('{"ok":true}');
      };
      if (upstreamWait) void upstreamWait.then(answer);
      else answer();
    },
  });
});
afterEach(async () => {
  upstreamAction = undefined;
  upstreamStream = false;
  upstreamWait = undefined;
  while (open.length) await open.pop()!();
  upstreams.reset();
});
afterAll(async () => {
  await upstreams.close();
  rmSync(home, { recursive: true, force: true });
});
const boot = "c".repeat(32);
const rid = (n: number) => `${boot}:${n}`;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function rig(
  extra: {
    tools?: boolean;
    capacity?: number;
    dropFirstAck?: boolean;
    responseMs?: number;
    intervals?: number;
    drainMs?: number;
    hosts?: string[];
    relayHost?: string;
    bindHost?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "relay-real-edge-"));
  const stateDir = join(root, "edge");
  const dir = join(root, "relay");
  const events = new EventEmitter();
  const lines: string[] = [];
  const commits: ObservationsCommitted[] = [];
  let onCommit: ((event: ObservationsCommitted) => void) | undefined;
  let now = Date.now();
  let mcpBytes = 0;
  const tools = extra.tools ? createEdgeTools({ log() {} }) : undefined;
  if (tools) {
    const handleMcp = tools.handleMcp;
    tools.handleMcp = (req, res, caller) => {
      req.on("data", (chunk: Buffer) => {
        mcpBytes += chunk.length;
        events.emit("change");
      });
      handleMcp(req, res, caller);
    };
  }
  let gateway: RunningGateway;
  const pairs = new Set<{
    local: net.Socket;
    edge: net.Socket;
    held: boolean;
    swallowed: boolean;
  }>();
  const proxy = {
    holdUp: false,
    dropDown: false,
    connections: 0,
    held: 0,
    lostAcks: 0,
    reset() {
      for (const pair of pairs) {
        pair.local.destroy();
        pair.edge.destroy();
      }
    },
  };
  const server = net.createServer((local) => {
    proxy.connections++;
    const edge = net.connect(
      gateway.clients!.modelPort,
      extra.bindHost === "::" ? "::1" : "127.0.0.1",
    );
    const pair = { local, edge, held: false, swallowed: false };
    pairs.add(pair);
    const end = () => {
      local.destroy();
      edge.destroy();
    };
    local.on("data", (chunk: Buffer) => {
      if (proxy.holdUp) {
        pair.held = true;
        proxy.held++;
        events.emit("change");
      } else if (!edge.write(chunk)) local.pause();
    });
    edge.on("drain", () => local.resume());
    edge.on("data", (chunk: Buffer) => {
      if (proxy.dropDown) {
        pair.swallowed = true;
      } else if (!local.write(chunk)) edge.pause();
    });
    local.on("drain", () => edge.resume());
    local.on("error", end);
    edge.on("error", end);
    local.on("close", () => {
      end();
      pairs.delete(pair);
      if (pair.swallowed) {
        proxy.dropDown = false;
        proxy.lostAcks++;
        events.emit("change");
      }
    });
    edge.on("close", end);
    events.emit("change");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, extra.bindHost ?? "127.0.0.1", resolve),
  );
  const proxyPort = (server.address() as { port: number }).port;
  let edgeOptions: GatewayOptions;
  const makeGateway = async () => startGateway(edgeOptions);
  edgeOptions = {
    stateDir,
    upstreams: upstreams.overrides,
    claudeTokenEndpoint: upstreams.tokenEndpoint,
    processProbe: fakeProcesses().probe,
    now: () => now,
    log: (line) => {
      lines.push(line);
      events.emit("change");
    },
    clients: {
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      ...(extra.hosts ? { hosts: extra.hosts } : {}),
      ...(extra.bindHost ? { bindHost: extra.bindHost } : {}),
    },
    ...(tools ? { tools } : {}),
    ...(extra.intervals ? { relayDedupIntervals: extra.intervals } : {}),
    onObservationsCommitted(event) {
      commits.push(event);
      if (extra.dropFirstAck && commits.length === 1) proxy.dropDown = true;
      onCommit?.(event);
      events.emit("change");
    },
  };
  gateway = await makeGateway();
  gateway.clients!.registry.addUser("thasso");
  const clientId = await enrollRelay({
    stateDir: dir,
    host: extra.relayHost ?? "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "reporting devbox"),
  });
  const address = JSON.parse(
    readFileSync(join(dir, "edge.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(
    join(dir, "edge.json"),
    JSON.stringify({ ...address, modelPort: proxyPort }),
  );
  let relay: RunningRelay;
  const relayOptions = {
    stateDir: dir,
    port: 0,
    socketPath: join(root, "relay.sock"),
    observations: {
      ...(extra.capacity ? { capacity: extra.capacity } : {}),
      retryMs: 60,
      retryMaxMs: 100,
      responseMs: extra.responseMs ?? 500,
    },
    drainMs: extra.drainMs ?? 100,
    flushMs: 600,
    log: (line: string) => {
      lines.push(line);
      events.emit("change");
    },
  };
  relay = await startRelay(relayOptions);
  open.push(async () => {
    await relay.close();
    proxy.reset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function until(predicate: () => boolean): Promise<void> {
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (predicate()) {
          clearTimeout(timer);
          events.removeListener("change", changed);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        events.removeListener("change", changed);
        reject(new Error("Real-edge condition timed out."));
      }, 5000);
      events.on("change", changed);
    });
  }
  const records = (user = "thasso"): RequestRecord[] => {
    const result: RequestRecord[] = [];
    let after = 0;
    for (;;) {
      const page = gateway.requests!.since(
        user,
        gateway.requests!.epoch,
        after,
        500,
      ).records;
      result.push(...page);
      if (page.length < 500) return result;
      after = page.at(-1)!.seq;
    }
  };
  await until(() => commits.length >= (extra.dropFirstAck ? 2 : 1));
  const tlsOptions = () => ({
    host: "127.0.0.1",
    port: gateway.clients!.modelPort,
    servername: "localhost",
    key: readFileSync(join(dir, "client-key.pem")),
    cert: readFileSync(join(dir, "client-cert.pem")),
    ca: readFileSync(join(dir, "gateway-ca.pem")),
    agent: false as const,
  });
  return {
    root,
    stateDir,
    dir,
    clientId,
    proxy,
    commits,
    lines,
    until,
    records,
    tlsOptions,
    get mcpBytes() {
      return mcpBytes;
    },
    get gateway() {
      return gateway;
    },
    get relay() {
      return relay;
    },
    set onCommit(value: typeof onCommit) {
      onCommit = value;
    },
    advance(ms: number) {
      now += ms;
    },
    async restartRelay() {
      await relay.close();
      relay = await startRelay(relayOptions);
    },
    async stopEdge() {
      await gateway.close();
    },
    async restartEdge() {
      const ports = gateway.clients!;
      edgeOptions = {
        ...edgeOptions,
        clients: {
          modelPort: ports.modelPort,
          clientPort: ports.clientPort,
          enrollPort: ports.enrollPort,
        },
      };
      gateway = await makeGateway();
    },
    account() {
      const file = join(root, "account.json");
      writeFileSync(
        file,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "fake-access",
            refreshToken: "fake-refresh",
            expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
          },
        }),
      );
      gateway.clients!.putAccount({
        id: "a",
        name: "Reporting account",
        provider: "claude",
        tokenFile: file,
        userId: "thasso",
        enabled: true,
      });
    },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;
interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function send(
  r: Rig,
  path: string,
  options: {
    direct?: boolean;
    method?: string;
    headers?: string[];
    body?: string;
    tls?: https.RequestOptions;
    agent?: https.Agent;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = [
      "host",
      "localhost",
      ...(options.body === undefined
        ? []
        : ["content-length", String(Buffer.byteLength(options.body))]),
      ...(options.headers ?? []),
    ];
    const req =
      options.direct || options.tls
        ? https.request({
            ...r.tlsOptions(),
            ...options.tls,
            ...(options.agent ? { agent: options.agent } : {}),
            path,
            method: options.method ?? "GET",
            headers,
          })
        : http.request(`${r.relay.url}${path}`, {
            method: options.method ?? "GET",
            headers,
          });
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString("utf8"),
          headers: res.headers,
        }),
      );
    });
    req.end(options.body);
  });
}
function report(n: number, d: number, host = "127.0.0.1") {
  return {
    d,
    rid: rid(n),
    at: Date.now(),
    host,
    method: "GET",
    path: "/failure",
    status: 502,
    outcome: "failed",
    reason: "edge-unreachable",
    clientCredential: "none",
    clientCookie: false,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
  };
}
function post(
  r: Rig,
  value: unknown,
  extra: { tls?: https.RequestOptions } = {},
) {
  return send(r, "/relay/observations", {
    direct: true,
    method: "POST",
    body: typeof value === "string" ? value : JSON.stringify(value),
    ...extra,
  });
}

test("T1/T15 real forwarding replaces forged metadata, strips it upstream and preserves opaque body bytes", async () => {
  const r = await rig();
  r.account();
  const body = JSON.stringify({ note: "SENTINEL", model: "fixture" });
  const answer = await send(r, "/anthropic/v1/messages?q=SENTINEL", {
    method: "POST",
    body,
    headers: [
      "authorization",
      `Bearer ${MACHINE_PLACEHOLDER}`,
      "cookie",
      "SENTINEL",
      "x-pandeck-relay-id",
      rid(99),
      "X-PanDeck-Relay-Id",
      rid(98),
      "x-pandeck-other",
      "SENTINEL",
    ],
  });
  assert.equal(answer.status, 200);
  await r.until(() => r.records().some((record) => record.rid?.endsWith(":1")));
  const row = r.records().find((record) => record.rid?.endsWith(":1"))!;
  assert.match(row.rid!, /^[0-9a-f]{32}:1$/);
  assert.notEqual(row.rid!.split(":")[0], boot);
  assert.equal(row.via, "gateway");
  assert.equal(row.client.id, r.clientId);
  assert.equal(row.clientCredential, "placeholder");
  assert.equal(row.clientCookie, true);
  assert.equal(row.path, "/v1/messages");
  assert.equal(row.requestBytes, Buffer.byteLength(body));
  assert.equal(hash(upstreams.anthropic[0]!.body), hash(body));
  assert.ok(
    !Object.keys(upstreams.anthropic[0]!.headers).some((name) =>
      name.startsWith("x-pandeck-"),
    ),
  );
  assert.ok(!JSON.stringify(r.records()).includes("SENTINEL"));
  assert.ok(!JSON.stringify(r.commits).includes("SENTINEL"));
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
  await r.relay.close();
  assert.equal(
    r.records().filter((record) => record.rid === row.rid).length,
    1,
  );
});

test("F004 every Node method and M-SEARCH fallback preserve a genuine GET batch sibling", async () => {
  const r = await rig();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = createObservations({
    boot,
    log: (line) => r.lines.push(line),
    send: async (batch) => {
      await held;
      const answer = await post(r, batch);
      return {
        status: answer.status,
        ...(answer.status === 200
          ? (JSON.parse(answer.body) as { ack: number })
          : {}),
      };
    },
  });
  const unused = net.createServer();
  await new Promise<void>((resolve) => unused.listen(0, "127.0.0.1", resolve));
  const closedPort = (unused.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => unused.close(() => resolve()));
  const traffic = createModelTraffic({
    boot,
    observations: queue,
    edge: { host: "127.0.0.1", port: closedPort, agent: false },
    edgeHost: "localhost",
    log: (line) => r.lines.push(line),
  });
  const server = http.createServer((req, res) =>
    traffic.forward(req, res, {
      host: "127.0.0.1",
      path: req.url!,
      edgePath: req.url!,
    }),
  );
  server.on("connect", (req, socket) =>
    traffic.refuse(req, socket as net.Socket, {
      host: "127.0.0.1",
      path: "/relay/CONNECT",
      status: 403,
      reason: "reserved-path",
      errorType: "permission_error",
      text: "reserved",
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  open.push(async () => {
    release();
    traffic.beginClose();
    await traffic.drain(100);
    await queue.close(100);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function raw(method: string, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        response += chunk;
      });
      socket.on("error", reject);
      socket.on("end", () => {
        socket.destroy();
        resolve(response);
      });
      socket.write(
        `${method} ${method === "CONNECT" ? "localhost:443" : path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
  }
  for (const method of http.METHODS)
    assert.match(await raw(method, `/relay/${method}`), /^HTTP\/1\.1 403/);
  for (const method of ["GET", "M-SEARCH"])
    assert.match(await raw(method, `/fallback/${method}`), /^HTTP\/1\.1 502/);
  release();
  await queue.close(1000);
  assert.equal(queue.rejected, 0);
  const rows = r.records().filter((row) => row.rid?.startsWith(boot));
  assert.deepEqual(
    rows.slice(0, http.METHODS.length).map((row) => row.method),
    http.METHODS,
  );
  assert.deepEqual(
    rows.slice(-2).map((row) => [row.method, row.path]),
    [
      ["GET", "/fallback/GET"],
      ["M-SEARCH", "/fallback/M-SEARCH"],
    ],
  );
  assert.ok(
    r.commits.some(
      (event) =>
        event.batch.records.some(
          (entry) => "rid" in entry && entry.method === "M-SEARCH",
        ) &&
        event.batch.records.some(
          (entry) => "rid" in entry && entry.method === "GET",
        ),
    ),
  );
  assert.ok(!r.lines.some((line) => line.includes("invalid batch")));
});

test("F004 strict method grammar and whole-batch atomicity remain", async () => {
  const r = await rig();
  for (const method of [
    "",
    "-GET",
    "get",
    "M_Search",
    "GET1",
    "A".repeat(17),
    "G ET",
    "GET\\n",
  ]) {
    const before = r.records().length;
    assert.equal(
      (
        await post(r, {
          boot,
          records: [report(1, 1), { ...report(2, 2), method }],
        })
      ).status,
      400,
    );
    assert.equal(r.records().length, before);
  }
  for (const [i, method] of ["A", "A" + "-".repeat(15), "M-SEARCH"].entries()) {
    assert.equal(
      (await post(r, { boot, records: [{ ...report(i + 1, i + 1), method }] }))
        .status,
      200,
    );
    assert.equal(r.records().at(-1)!.method, method);
  }
});

test.each([
  [undefined, "LOCALHOST", "127.0.0.1"],
  [undefined, "localhost.", "127.0.0.1"],
  [["::1"], "0:0:0:0:0:0:0:1", "::"],
  [["::1"], "::1", "::"],
  [["*.relay.localhost"], "a.relay.localhost", "127.0.0.1"],
] as const)(
  "F007 enrolled host %s / %s retains relay reports",
  async (hosts, relayHost, bindHost) => {
    const original = dns.lookup;
    // Test transport only. Ownership validation must never resolve a host.
    const lookup = vi.spyOn(dns, "lookup").mockImplementation(((
      host: string,
      options: dns.LookupOptions | number,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | dns.LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      if (host === "a.relay.localhost") {
        if (typeof options === "object" && options.all)
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      } else Reflect.apply(original, dns, [host, options, callback]);
    }) as typeof dns.lookup);
    try {
      const r = await rig({
        ...(hosts ? { hosts: [...hosts] } : {}),
        relayHost,
        bindHost,
      });
      assert.equal((await send(r, "/relay/x")).status, 403);
      await r.relay.close();
      const row = r.records().find((entry) => entry.path === "/relay/x");
      assert.ok(row);
      assert.equal(row.client.id, r.clientId);
      assert.equal(row.reason, "reserved-path");
      assert.equal(row.host, relayHost.toLowerCase());
      assert.ok(!r.lines.some((line) => line.includes("invalid batch")));
    } finally {
      lookup.mockRestore();
    }
  },
);

test.each([
  ["/unknown-route", [], 404],
  ["/anthropic/v1/messages", [], 403],
  ["/mcp", [], 401],
  ["/mcp", ["origin", "https://example.test"], 403],
] as const)(
  "F005 GET/HEAD %s counts only emitted gateway body bytes",
  async (path, headers, status) => {
    const r = await rig({ tools: true });
    for (const method of ["GET", "HEAD"]) {
      const before = r.records().length;
      const answer = await send(r, path, { method, headers: [...headers] });
      assert.equal(answer.status, status);
      await r.until(() => r.records().length === before + 1);
      const row = r.records().at(-1)!;
      assert.equal(row.via, "gateway");
      assert.equal(row.method, method);
      assert.equal(row.status, status);
      assert.equal(row.outcome, "refused");
      assert.match(row.rid!, /^[0-9a-f]{32}:[1-9][0-9]*$/);
      assert.equal(row.responseBytes, Buffer.byteLength(answer.body));
      const representation = Number(answer.headers["content-length"]);
      assert.ok(representation > 0);
      assert.equal(
        Buffer.byteLength(answer.body),
        method === "HEAD" ? 0 : representation,
      );
      assert.equal(
        r.records().filter((entry) => entry.rid === row.rid).length,
        1,
      );
    }
  },
);

test("F006 a backward wall-clock step retains the relay record and a genuine GET sibling", async () => {
  const r = await rig();
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(10_000)
    .mockReturnValue(5_000);
  try {
    assert.equal((await send(r, "/relay/stepped")).status, 403);
  } finally {
    clock.mockRestore();
  }
  assert.equal((await send(r, "/relay/after-step")).status, 403);
  await r.relay.close();
  const rows = r.records().filter((row) => row.rid);
  assert.deepEqual(
    rows.map((row) => row.path),
    ["/relay/stepped", "/relay/after-step"],
  );
  assert.equal(rows[0]!.at, 10_000);
  assert.ok(
    rows.every(
      (row) =>
        row.method === "GET" &&
        Number.isSafeInteger(row.durationMs) &&
        row.durationMs >= 0,
    ),
  );
  assert.ok(!r.lines.some((line) => line.includes("invalid batch")));
});

test("F006 the real queue sends ordered overflow bounds and a genuine sibling through strict ingest", async () => {
  const r = await rig();
  let now = 10_000;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const queue = createObservations({
    boot,
    capacity: 3,
    now: () => now,
    log: (line) => r.lines.push(line),
    send: async (batch) => {
      if (first) {
        first = false;
        started();
        await held;
      }
      const answer = await post(r, batch);
      return {
        status: answer.status,
        ...(answer.status === 200
          ? (JSON.parse(answer.body) as { ack: number })
          : {}),
      };
    },
  });
  open.push(() => queue.close(100));
  await sending;
  const slot = queue.reserve()!;
  assert.ok(slot);
  assert.equal(queue.reserve(), undefined);
  queue.overflow();
  now = 5_000;
  queue.overflow();
  const { d: _d, ...sibling } = report(1, 1);
  slot.record({ ...sibling, outcome: "failed", clientCredential: "none" });
  release();
  await queue.close(1000);
  assert.equal(queue.rejected, 0);
  const rows = r.records();
  assert.equal(rows.filter((row) => row.rid === rid(1)).length, 1);
  const overflow = rows.find((row) => row.reason === "overflow");
  assert.ok(overflow);
  assert.equal(overflow.count, 2);
  const batches = r.commits.filter((event) => event.boot === boot);
  const note = batches
    .flatMap((event) => event.batch.records)
    .find((entry) => "note" in entry && entry.note === "overflow");
  assert.deepEqual(note, {
    d: 3,
    note: "overflow",
    count: 2,
    from: 5_000,
    to: 10_000,
  });
  assert.ok(batches.some((event) => event.committed.length === 2));
  assert.ok(!r.lines.some((line) => line.includes("invalid batch")));
});

test("T2 malformed or repeated ids are ignored, served and diagnosed without echo", async () => {
  const r = await rig();
  for (const headers of [
    ["x-pandeck-relay-id", "SENTINEL"],
    ["x-pandeck-relay-id", rid(1), "X-Pandeck-Relay-Id", rid(1)],
  ]) {
    const answer = await send(r, "/unknown", { direct: true, headers });
    assert.equal(answer.status, 404);
  }
  const rows = r.records().filter((row) => row.via === "gateway");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.rid === undefined));
  assert.equal(
    r.lines.filter((line) => line.includes("rid=invalid")).length,
    2,
  );
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
});

test.each([
  ["registry-unavailable", 503],
  ["forbidden", 403],
] as const)(
  "cached-client %s refusal carries its rid and suppresses only its own fallback",
  async (reason, status) => {
    const r = await rig();
    const { key, cert, ca, servername } = r.tlsOptions();
    const agent = new https.Agent({
      key,
      cert,
      ca,
      servername,
      keepAlive: true,
      maxSockets: 1,
    });
    open.push(() => agent.destroy());
    assert.equal(
      (await send(r, "/unknown", { direct: true, agent })).status,
      404,
    );
    const file = join(r.stateDir, "clients.json");
    const good = readFileSync(file, "utf8");
    const inactive =
      reason === "forbidden"
        ? vi
            .spyOn(r.gateway.clients!.registry, "active")
            .mockReturnValue(undefined)
        : undefined;
    if (!inactive) writeFileSync(file, "temporarily invalid JSON");
    try {
      const answer = await send(r, "/unknown?q=SENTINEL", {
        direct: true,
        agent,
        headers: ["x-pandeck-relay-id", rid(1)],
      });
      assert.equal(answer.status, status);
    } finally {
      inactive?.mockRestore();
      writeFileSync(file, good);
    }
    await r.until(() => r.records().some((row) => row.rid === rid(1)));
    const row = r.records().find((entry) => entry.rid === rid(1))!;
    assert.deepEqual(
      [row.client.id, row.outcome, row.reason, row.status, row.via],
      [r.clientId, "refused", reason, status, "gateway"],
    );
    assert.equal(upstreams.anthropic.length, 0);
    assert.equal(
      (await post(r, { boot, records: [report(1, 1)] })).status,
      200,
    );
    const duplicate = await send(r, "/unknown", {
      direct: true,
      headers: ["x-pandeck-relay-id", rid(1)],
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body, /Pandeck gateway:/);
    assert.equal(r.records().filter((entry) => entry.rid === rid(1)).length, 1);
    assert.equal(
      r.lines.filter(
        (line) =>
          line.includes(`rid=${rid(1)}`) && line.includes(`refused ${reason}`),
      ).length,
      1,
    );
    assert.ok(!JSON.stringify(r.records()).includes("SENTINEL"));
    assert.ok(!r.lines.join("\n").includes("SENTINEL"));
  },
);

test("cached-client registry refusal ignores invalid rid and keeps duplicates text-only", async () => {
  const r = await rig();
  const { key, cert, ca, servername } = r.tlsOptions();
  const agent = new https.Agent({
    key,
    cert,
    ca,
    servername,
    keepAlive: true,
    maxSockets: 1,
  });
  open.push(() => agent.destroy());
  await send(r, "/unknown", {
    direct: true,
    agent,
    headers: ["x-pandeck-relay-id", rid(1)],
  });
  const file = join(r.stateDir, "clients.json");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "temporarily invalid JSON");
  try {
    const before = r.records().length;
    const duplicate = await send(r, "/unknown", {
      direct: true,
      agent,
      headers: ["x-pandeck-relay-id", rid(1)],
    });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body, /Pandeck gateway:/);
    assert.equal(r.records().length, before);
    const invalid = await send(r, "/unknown?q=SENTINEL", {
      direct: true,
      agent,
      headers: ["x-pandeck-relay-id", "SENTINEL"],
    });
    assert.equal(invalid.status, 503);
  } finally {
    writeFileSync(file, good);
  }
  await r.until(() =>
    r.records().some((row) => row.reason === "registry-unavailable"),
  );
  const rows = r
    .records()
    .filter((row) => row.reason === "registry-unavailable");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rid, undefined);
  assert.equal(
    r.lines.filter((line) => line.includes("rid=invalid")).length,
    1,
  );
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
  assert.ok(!JSON.stringify(r.records()).includes("SENTINEL"));
});

test("T4/T6 fallback-first duplicate is a marked text-only 409; d order never suppresses a lower rid", async () => {
  const r = await rig();
  await send(r, "/unknown", {
    direct: true,
    headers: ["x-pandeck-relay-id", rid(2)],
  });
  assert.equal(
    (await post(r, { boot, records: [report(3, 1), report(1, 2)] })).status,
    200,
  );
  for (const n of [3, 1]) {
    const before = r.records().length;
    const answer = await send(r, "/unknown", {
      direct: true,
      headers: ["x-pandeck-relay-id", rid(n)],
    });
    assert.equal(answer.status, 409);
    assert.match(answer.body, /Pandeck gateway:/);
    assert.equal(r.records().length, before);
  }
  for (const n of [1, 2, 3])
    assert.equal(r.records().filter((row) => row.rid === rid(n)).length, 1);
  assert.equal(
    r.lines.filter((line) => line.includes("duplicate-rid")).length,
    2,
  );
});

test("T3 the same forged boot and n in a different authenticated client cannot suppress A", async () => {
  const r = await rig();
  const other = join(r.root, "other");
  const otherId = await enrollRelay({
    stateDir: other,
    host: "127.0.0.1",
    enrollPort: r.gateway.clients!.enrollPort,
    caPem: r.gateway.clients!.caPem,
    code: r.gateway.clients!.registry.createCode("thasso", "other"),
  });
  const tls = {
    key: readFileSync(join(other, "client-key.pem")),
    cert: readFileSync(join(other, "client-cert.pem")),
  };
  await send(r, "/unknown", {
    direct: true,
    tls,
    headers: ["x-pandeck-relay-id", rid(1)],
  });
  assert.equal((await post(r, { boot, records: [report(1, 1)] })).status, 200);
  const rows = r.records().filter((row) => row.rid === rid(1));
  assert.equal(rows.length, 2);
  assert.deepEqual(
    new Set(rows.map((row) => row.client.id)),
    new Set([r.clientId, otherId]),
  );
});

test("T7 compaction drops a genuine missing fallback with a count, but serves the same live id", async () => {
  const r = await rig({ intervals: 4 });
  for (const n of [1, 3, 5, 7, 9, 11])
    await send(r, "/unknown", {
      direct: true,
      headers: ["x-pandeck-relay-id", rid(n)],
    });
  assert.equal((await post(r, { boot, records: [report(2, 1)] })).status, 200);
  assert.equal(r.records().filter((row) => row.rid === rid(2)).length, 0);
  assert.ok(
    r.lines.some((line) => line.includes("below-floor dropped=1 total=1")),
  );
  const live = await send(r, "/unknown", {
    direct: true,
    headers: ["x-pandeck-relay-id", rid(2)],
  });
  assert.equal(live.status, 404);
  assert.equal(r.records().filter((row) => row.rid === rid(2)).length, 1);
  assert.ok(r.lines.some((line) => line.includes("rid=below-floor")));
});

test("T8 expiry and the 64-boot cap permit identifiable same-rid UI duplicates", async () => {
  const r = await rig();
  await send(r, "/unknown", {
    direct: true,
    headers: ["x-pandeck-relay-id", rid(1)],
  });
  r.advance(6 * 60 * 60_000);
  await post(r, { boot, records: [report(1, 1)] });
  assert.equal(r.records().filter((row) => row.rid === rid(1)).length, 2);
  for (let n = 1; n <= 64; n++)
    await post(r, {
      boot: n.toString(16).padStart(32, "0"),
      records: [{ d: 1, note: "relay-restarted" }],
    });
  await post(r, { boot, records: [report(1, 1)] });
  assert.equal(r.records().filter((row) => row.rid === rid(1)).length, 3);
});

test("T9 lost acks after real commit retry the rid-less note and a real fallback exactly once", async () => {
  const r = await rig({ dropFirstAck: true, responseMs: 60 });
  const first = r.commits[0]!;
  assert.deepEqual(first.committed, [1]);
  assert.equal(
    first.batch.records[0] && "note" in first.batch.records[0]
      ? first.batch.records[0].note
      : undefined,
    "relay-restarted",
  );
  assert.deepEqual(r.commits[1]!.committed, []);
  assert.deepEqual(r.commits[1]!.ignored, [1]);
  assert.ok(r.proxy.lostAcks >= 1);
  let armed = false;
  r.onCommit = (event) => {
    if (
      !armed &&
      event.committed.length &&
      event.batch.records.some((entry) => "rid" in entry)
    ) {
      armed = true;
      r.proxy.dropDown = true;
    }
  };
  const held = r.proxy.held;
  r.proxy.holdUp = true;
  const request = http.get(`${r.relay.url}/never-received`);
  request.on("error", () => {});
  await r.until(() => r.proxy.held > held);
  request.destroy();
  r.proxy.holdUp = false;
  r.proxy.reset();
  await r.until(
    () =>
      armed &&
      r.proxy.lostAcks >= 2 &&
      r.commits.some((event) => event.ignored.some((d) => d > 1)),
  );
  const fallback = r.records().find((row) => row.via === "relay" && row.rid)!;
  assert.ok(fallback);
  assert.equal(r.records().filter((row) => row.rid === fallback.rid).length, 1);
  assert.equal(
    r.records().filter((row) => row.reason === "relay-restarted").length,
    1,
  );
  const next = await send(r, "/relay/next");
  assert.equal(next.status, 403);
  await r.until(() =>
    r.records().some((row) => row.reason === "reserved-path"),
  );
  assert.ok(r.commits.at(-1)!.batch.records[0]!.d > 2);
});

test("T10 admission reserves before all four held requests, and aggregates both overflow classes", async () => {
  const r = await rig({ capacity: 5 });
  await send(r, "/warmup");
  const held = r.proxy.held;
  r.proxy.holdUp = true;
  const calls = Array.from({ length: 4 }, (_, n) =>
    send(r, `/held-${n}`).catch(() => undefined),
  );
  await r.until(() => r.proxy.held >= held + 4);
  const before = r.proxy.connections;
  for (const path of ["/fifth", "/relay/x"]) {
    const answer = await send(r, path);
    assert.equal(answer.status, 503);
    assert.match(answer.body, /Pandeck gateway:/);
  }
  assert.equal(r.proxy.connections, before);
  r.proxy.holdUp = false;
  r.proxy.reset();
  await Promise.all(calls);
  await r.until(
    () =>
      r.records().filter((row) => row.via === "relay" && row.rid).length ===
        4 && r.records().some((row) => row.outcome === "overflow"),
  );
  assert.equal(
    r.records().filter((row) => row.outcome === "overflow").length,
    1,
  );
  assert.equal(r.records().find((row) => row.outcome === "overflow")!.count, 2);
  const rows = r.records().filter((row) => row.via === "relay" && row.rid);
  assert.equal(new Set(rows.map((row) => row.rid)).size, 4);
});

test("T5 edge dedup survives eviction of the original record from the entire UI ring", async () => {
  const r = await rig();
  r.account();
  upstreamAction = () => {
    r.proxy.dropDown = true;
  };
  const call = send(r, "/anthropic/v1/messages", {
    method: "POST",
    body: "{}",
  }).catch(() => undefined);
  await r.until(() =>
    r.records().some((row) => row.via === "gateway" && row.rid),
  );
  const original = r.records().find((row) => row.via === "gateway" && row.rid)!;
  r.proxy.holdUp = true;
  r.proxy.dropDown = false;
  r.proxy.reset();
  await call;
  const agent = new https.Agent({
    ...r.tlsOptions(),
    keepAlive: true,
    maxSockets: 1,
  });
  try {
    for (let n = 0; n < 5001; n++)
      assert.equal(
        (await send(r, "/evict", { direct: true, agent })).status,
        404,
      );
  } finally {
    agent.destroy();
  }
  assert.equal(r.records().length, 5000);
  assert.ok(!r.records().some((row) => row.rid === original.rid));
  const seq = r.records().at(-1)!.seq;
  r.proxy.holdUp = false;
  r.proxy.reset();
  await r.until(() =>
    r.commits.some((event) =>
      event.batch.records.some(
        (entry) => "rid" in entry && entry.rid === original.rid,
      ),
    ),
  );
  assert.equal(r.records().at(-1)!.seq, seq);
  assert.ok(!r.records().some((row) => row.rid === original.rid));
}, 30_000);

test("T13 validation rejects the whole malformed batch with fixed marked text and edge-owned hosts only", async () => {
  const r = await rig();
  const initial = r.records().length;
  const invalids: unknown[] = [
    "{",
    {
      boot,
      records: Array.from({ length: 101 }, (_, i) => report(i + 1, i + 1)),
    },
    { boot, records: [report(1, 1)], padding: "SENTINEL".repeat(9000) },
    ...[
      { ...report(2, 2), rid: `${"d".repeat(32)}:2` },
      { ...report(2, 2), path: "/x?q=SENTINEL" },
      { ...report(2, 2), host: "example.com" },
      { ...report(2, 2), host: "10.0.0.1" },
      { ...report(2, 2), clientCredential: "SENTINEL" },
      { ...report(2, 2), requestBytes: -1 },
      { ...report(2, 2), unexpectedField: "SENTINEL" },
    ].map((bad) => ({ boot, records: [report(1, 1), bad] })),
  ];
  for (const invalid of invalids) {
    const response = await post(r, invalid);
    assert.ok([400, 413].includes(response.status));
    assert.match(response.body, /Pandeck gateway:/);
    assert.ok(!response.body.includes("SENTINEL"));
    assert.equal(r.records().length, initial);
  }
  assert.equal(
    (await send(r, "/relay/observations", { direct: true })).status,
    405,
  );
  assert.equal(
    (
      await post(r, {
        boot,
        records: [report(1, 1, "127.0.0.1"), report(2, 2, "LOCALHOST")],
      })
    ).status,
    200,
  );
  assert.equal(r.records().length, initial + 2);
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
});

test("T14 local observation forgery is a marked 403 and one relay record, never ingest", async () => {
  const r = await rig();
  const response = await send(r, "/relay/observations?q=SENTINEL", {
    method: "POST",
    body: "SENTINEL",
  });
  assert.equal(response.status, 403);
  assert.match(response.body, /Pandeck gateway:/);
  await r.until(() =>
    r.records().some((row) => row.reason === "reserved-path"),
  );
  const rows = r.records().filter((row) => row.rid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.via, "relay");
  assert.ok(!JSON.stringify(r.commits).includes("SENTINEL"));
});

test("T10 admission saturates with four pre-header requests and aggregates both overflow classes", async () => {
  const r = await rig({ capacity: 5 });
  await send(r, "/warmup");
  const heldBefore = r.proxy.held;
  r.proxy.holdUp = true;
  const requests = Array.from({ length: 4 }, () => {
    const req = http.get(`${r.relay.url}/held`);
    req.on("error", () => {});
    return req;
  });
  await r.until(() => r.proxy.held >= heldBefore + 4);
  const connections = r.proxy.connections;
  for (const path of ["/fifth", "/relay/x"]) {
    const answer = await send(r, path);
    assert.equal(answer.status, 503);
    assert.match(answer.body, /Pandeck gateway:/);
  }
  assert.equal(r.proxy.connections, connections);
  r.proxy.holdUp = false;
  r.proxy.reset();
  await r.until(
    () =>
      r.records().filter((row) => row.via === "relay" && row.rid).length ===
        4 && r.records().some((row) => row.reason === "overflow"),
  );
  const overflow = r.records().filter((row) => row.reason === "overflow");
  assert.equal(overflow.length, 1);
  assert.equal(overflow[0]!.count, 2);
  assert.equal(
    new Set(
      r
        .records()
        .filter((row) => row.via === "relay" && row.rid)
        .map((row) => row.rid),
    ).size,
    4,
  );
  for (const req of requests) req.destroy();
});

test("T11 edge-down close reports its dropped count without files, next boot reports unknown loss", async () => {
  const r = await rig();
  await send(r, "/warmup");
  const before = readdirSync(r.dir)
    .filter((name) => name !== "control.sock")
    .sort();
  await r.stopEdge();
  await send(r, "/relay/queued");
  await r.relay.close();
  assert.deepEqual(
    r.lines.filter((line) => line.includes("not delivered at close")),
    ["observations: 1 not delivered at close"],
  );
  assert.deepEqual(
    readdirSync(r.dir)
      .filter((name) => name !== "control.sock")
      .sort(),
    before,
  );
  await r.restartEdge();
  await r.restartRelay();
  await r.until(() =>
    r.records().some((row) => row.reason === "relay-restarted"),
  );
  const restart = r.records().find((row) => row.reason === "relay-restarted")!;
  assert.equal(restart.count, undefined);
  assert.equal(r.commits.at(-1)!.batch.records[0]!.d, 1);
});

test("T12 close cuts an active edge stream and converts only the pre-header request into a fallback", async () => {
  const r = await rig();
  r.account();
  upstreamStream = true;
  let headers!: () => void;
  const gotHeaders = new Promise<void>((resolve) => {
    headers = resolve;
  });
  const stream = http.request(
    `${r.relay.url}/anthropic/v1/messages`,
    {
      method: "POST",
      headers: {
        host: "localhost",
        authorization: `Bearer ${MACHINE_PLACEHOLDER}`,
      },
    },
    (res) => {
      res.resume();
      res.on("error", () => {});
      headers();
    },
  );
  stream.on("error", () => {});
  stream.end("{}");
  await gotHeaders;
  const heldBefore = r.proxy.held;
  r.proxy.holdUp = true;
  const held = http.get(`${r.relay.url}/held-close`);
  held.on("error", () => {});
  await r.until(() => r.proxy.held > heldBefore);
  r.proxy.holdUp = false;
  const close = r.relay.close();
  assert.equal(close, r.relay.close());
  await close;
  await r.until(() => r.records().filter((row) => row.rid).length === 2);
  const rows = r.records().filter((row) => row.rid);
  assert.equal(rows.filter((row) => row.via === "gateway").length, 1);
  assert.equal(rows.filter((row) => row.via === "relay").length, 1);
  assert.equal(
    rows.find((row) => row.via === "relay")!.reason,
    "relay-closing",
  );
  assert.equal(rows.find((row) => row.via === "relay")!.status, null);
  stream.destroy();
  held.destroy();
});

test("T17 /mcp has one PR1-owned rid record per refusal, known-size success and pre-header abort", async () => {
  const r = await rig({ tools: true });
  const token = readFileSync(join(r.dir, "mcp-token"), "utf8").trim();
  const auth = ["authorization", `Bearer ${token}`];
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  const cases = [
    { method: "POST", headers: [] as string[], body: "{}", status: 401 },
    {
      method: "POST",
      headers: [...auth, "origin", "http://localhost"],
      body: "{}",
      status: 403,
    },
    { method: "GET", headers: auth, body: "", status: 405 },
    {
      method: "POST",
      headers: [...auth, "mcp-protocol-version", "invalid"],
      body: "{}",
      status: 400,
    },
    {
      method: "POST",
      headers: auth,
      body: "x".repeat(1024 * 1024 + 1),
      status: 413,
    },
  ];
  for (const options of cases) {
    const before = r.records().filter((row) => row.rid).length;
    const answer = await send(r, "/mcp?q=SENTINEL", options);
    assert.equal(answer.status, options.status);
    await r.until(
      () => r.records().filter((row) => row.rid).length === before + 1,
    );
    const row = r
      .records()
      .filter((record) => record.rid)
      .at(-1)!;
    assert.equal(row.via, "gateway");
    assert.equal(row.outcome, "refused");
    assert.equal(row.status, options.status);
  }
  const good = await send(r, "/mcp", {
    method: "POST",
    body,
    headers: [
      ...auth,
      "content-type",
      "application/json",
      "accept",
      "application/json, text/event-stream",
      "mcp-protocol-version",
      "2025-06-18",
    ],
  });
  assert.equal(good.status, 200);
  await r.until(() => r.records().filter((row) => row.rid).length === 6);
  const success = r
    .records()
    .filter((row) => row.rid)
    .at(-1)!;
  assert.equal(success.requestBytes, Buffer.byteLength(body));
  assert.equal(success.responseBytes, Buffer.byteLength(good.body));
  const beforeBytes = r.mcpBytes;
  const partial = http.request(`${r.relay.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-length": "10000" },
  });
  partial.on("error", () => {});
  partial.write('{"partial":');
  await r.until(() => r.mcpBytes > beforeBytes);
  partial.destroy();
  await r.until(() => r.records().filter((row) => row.rid).length === 7);
  await r.relay.close();
  const rows = r.records().filter((row) => row.rid);
  assert.equal(rows.length, 7);
  assert.equal(new Set(rows.map((row) => row.rid)).size, 7);
  const aborted = rows.at(-1)!;
  assert.equal(aborted.outcome, "failed");
  assert.equal(aborted.status, null);
  assert.equal(rows.filter((row) => row.via === "relay").length, 0);
  assert.ok(rows.every((row) => row.client.id === r.clientId));
  assert.ok(!JSON.stringify(r.records()).includes("SENTINEL"));
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
});

test("T6 real out-of-order relay completions deliver rid 3 before rid 1 without losing either", async () => {
  const r = await rig();
  const relayBoot = r.commits[0]!.boot;
  let held = r.proxy.held;
  r.proxy.holdUp = true;
  const first = http.get(`${r.relay.url}/one`);
  first.on("error", () => {});
  await r.until(() => r.proxy.held > held);
  r.proxy.holdUp = false;
  assert.equal((await send(r, "/two")).status, 404);
  held = r.proxy.held;
  r.proxy.holdUp = true;
  const third = http.get(`${r.relay.url}/three`);
  third.on("error", () => {});
  await r.until(() => r.proxy.held > held);
  third.destroy();
  r.proxy.holdUp = false;
  await r.until(() => r.records().some((row) => row.rid === `${relayBoot}:3`));
  first.destroy();
  await r.until(() => r.records().some((row) => row.rid === `${relayBoot}:1`));
  for (const n of [1, 2, 3])
    assert.equal(
      r.records().filter((row) => row.rid === `${relayBoot}:${n}`).length,
      1,
    );
  const delivered = r.commits
    .flatMap((event) => event.batch.records)
    .filter((entry) => "rid" in entry);
  const d3 = delivered.find(
    (entry) => "rid" in entry && entry.rid === `${relayBoot}:3`,
  )!.d;
  const d1 = delivered.find(
    (entry) => "rid" in entry && entry.rid === `${relayBoot}:1`,
  )!.d;
  assert.ok(d3 < d1);
});

test("T15 a real no-edge-header fallback retains only classes, pathname and measured lengths", async () => {
  const r = await rig();
  const before = r.proxy.held;
  r.proxy.holdUp = true;
  const body = "SENTINEL-body";
  const request = http.request(`${r.relay.url}/failure?q=SENTINEL`, {
    method: "POST",
    headers: {
      "content-length": String(Buffer.byteLength(body)),
      authorization: "Bearer SENTINEL",
      cookie: "SENTINEL",
      "x-claude-code-session-id": "SENTINEL-session",
    },
  });
  request.on("error", () => {});
  request.end(body);
  await r.until(() => r.proxy.held > before);
  request.destroy();
  r.proxy.holdUp = false;
  // Let caller cancellation destroy the held upstream. A simultaneous proxy
  // reset would instead legitimately race into the relay's 502 path.
  await r.until(() =>
    r.records().some((row) => row.rid && row.via === "relay"),
  );
  const row = r.records().find((entry) => entry.rid && entry.via === "relay")!;
  assert.equal(row.host, "127.0.0.1");
  assert.equal(row.path, "/failure");
  assert.equal(row.requestBytes, Buffer.byteLength(body));
  assert.equal(row.responseBytes, 0);
  assert.equal(row.status, null);
  assert.equal(row.outcome, "failed");
  assert.equal(row.clientCredential, "other");
  assert.equal(row.clientCookie, true);
  assert.ok(!JSON.stringify(r.records()).includes("SENTINEL"));
  assert.ok(!JSON.stringify(r.commits).includes("SENTINEL"));
  assert.ok(!r.lines.join("\n").includes("SENTINEL"));
});

test("T12 requests arriving on an active keep-alive socket during drain get the recorded marked 503", async () => {
  const r = await rig({ drainMs: 1000 });
  r.account();
  let release!: () => void;
  upstreamWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  upstreamAction = started;
  const socket = net.connect(r.relay.port, "127.0.0.1");
  socket.setEncoding("utf8");
  let response = "";
  socket.on("data", (chunk: string) => {
    response += chunk;
  });
  socket.on("error", () => {});
  const ended = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.write(
    `POST /anthropic/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${MACHINE_PLACEHOLDER}\r\nContent-Length: 2\r\n\r\n{}`,
  );
  await didStart;
  const closing = r.relay.close();
  socket.write("GET /during-close HTTP/1.1\r\nHost: localhost\r\n\r\n");
  await r.until(() =>
    r.records().some((row) => row.reason === "relay-closing"),
  );
  release();
  await closing;
  await ended;
  assert.match(response, /HTTP\/1\.1 503/);
  assert.match(response, /Pandeck gateway:/);
  const closingRows = r
    .records()
    .filter((row) => row.reason === "relay-closing");
  assert.equal(closingRows.length, 1);
  assert.equal(closingRows[0]!.status, 503);
  assert.equal(closingRows[0]!.via, "relay");
  assert.equal(closingRows[0]!.path, "/during-close");
  assert.equal(r.records().filter((row) => row.rid).length, 2);
});
