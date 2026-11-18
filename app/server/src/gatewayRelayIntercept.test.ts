/**
 * Real relay + real edge with the relay's CONNECT interception (Task-1430
 * PR2b, ADR-0006): decrypted token-host requests and the relay's own
 * refusals reach the edge's request log through PR2a's reporting and real C5
 * ingest. The client speaks CONNECT and TLS to the relay exactly as Claude
 * Code behind `HTTPS_PROXY` would. Every value is fake; the fake upstreams
 * stand in for `api.anthropic.com`, and no public name is resolved.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import type { GatewayOptions, RunningGateway } from "./gateway/gateway.ts";
import { isGatewayRefusal } from "./gateway/refusals.ts";
import {
  RELAY_NAMED_DOMAINS,
  type ObservationsCommitted,
} from "./gateway/relayObservations.ts";
import type { RequestRecord } from "./gateway/requestLog.ts";
import { NAMED_DOMAINS } from "./relay/connectTarget.ts";
import { MACHINE_PLACEHOLDER } from "./relay/credentialClass.ts";
import type { InterceptCa } from "./relay/interceptCa.ts";
import type { RunningRelay } from "./relay/relay.ts";

const home = mkdtempSync(join(tmpdir(), "relay-intercept-edge-home-"));
process.env.HOME = home;
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { loadInterceptCa } = await import("./relay/interceptCa.ts");
const { CLAUDE_ACCESS, fakeProcesses, startFakeUpstreams, writeTokenFiles } =
  await import("./test/gatewayFixtures.ts");

const RID = /^[0-9a-f]{32}:[1-9][0-9]*$/;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

let upstreams: Awaited<ReturnType<typeof startFakeUpstreams>>;
/** How the fake `api.anthropic.com` answers: at once, or a held stream. */
let upstreamStream = false;
let upstreamStarted: ((req: http.IncomingMessage) => void) | undefined;
const open: (() => Promise<void> | void)[] = [];
beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: (_seen, res) => {
      res.writeHead(200, {
        "content-type": upstreamStream
          ? "text/event-stream"
          : "application/json",
      });
      if (upstreamStream) res.write("data: stream\n\n");
      else res.end('{"ok":true}');
    },
    claudeStarted: (req) => upstreamStarted?.(req),
  });
});
afterEach(async () => {
  upstreamStream = false;
  upstreamStarted = undefined;
  while (open.length) await open.pop()!();
  upstreams.reset();
});
afterAll(async () => {
  await upstreams.close();
  rmSync(home, { recursive: true, force: true });
});

async function rig(extra: { capacity?: number; drainMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-intercept-edge-"));
  const stateDir = join(root, "edge");
  const dir = join(root, "relay");
  const lines: string[] = [];
  const commits: ObservationsCommitted[] = [];
  let edgeOptions: GatewayOptions = {
    stateDir,
    upstreams: upstreams.overrides,
    claudeTokenEndpoint: upstreams.tokenEndpoint,
    processProbe: fakeProcesses().probe,
    log: (line) => lines.push(line),
    clients: { modelPort: 0, clientPort: 0, enrollPort: 0 },
    onObservationsCommitted: (event) => commits.push(event),
  };
  let gateway: RunningGateway = await startGateway(edgeOptions);
  gateway.clients!.registry.addUser("thasso");
  const clientId = await enrollRelay({
    stateDir: dir,
    host: "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "intercept devbox"),
  });
  // In the relay's own state directory, as `relay run` keeps it.
  const interceptCa: InterceptCa = loadInterceptCa(dir);
  const relayOptions = {
    stateDir: dir,
    port: 0,
    socketPath: join(root, "relay.sock"),
    interceptCa,
    observations: {
      ...(extra.capacity ? { capacity: extra.capacity } : {}),
      retryMs: 60,
      retryMaxMs: 100,
      responseMs: 500,
    },
    drainMs: extra.drainMs ?? 100,
    flushMs: 600,
    log: (line: string) => lines.push(line),
  };
  let relay: RunningRelay = await startRelay(relayOptions);
  open.push(async () => {
    await relay.close();
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
  });
  /** Polls: edge records are written without an event to wait on. */
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("Real-edge condition timed out.");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  const records = (): RequestRecord[] => {
    const result: RequestRecord[] = [];
    let after = 0;
    for (;;) {
      const page = gateway.requests!.since(
        "thasso",
        gateway.requests!.epoch,
        after,
        500,
      ).records;
      result.push(...page);
      if (page.length < 500) return result;
      after = page.at(-1)!.seq;
    }
  };
  await until(() => commits.length >= 1);
  return {
    dir,
    clientId,
    lines,
    commits,
    records,
    until,
    caPem: interceptCa.certPem,
    get relay() {
      return relay;
    },
    get gateway() {
      return gateway;
    },
    async account() {
      const { claudeFile } = await writeTokenFiles();
      gateway.clients!.putAccount({
        id: "a",
        name: "Intercept account",
        provider: "claude",
        tokenFile: claudeFile,
        userId: "thasso",
        enabled: true,
      });
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
      gateway = await startGateway(edgeOptions);
    },
    async restartRelay() {
      await relay.close();
      relay = await startRelay(relayOptions);
    },
    /** A POST of the relay's own report shape, with its client certificate. */
    post(value: unknown): Promise<number> {
      const body = JSON.stringify(value);
      return new Promise((resolve, reject) => {
        const req = https.request({
          host: "127.0.0.1",
          port: gateway.clients!.modelPort,
          servername: "localhost",
          key: readFileSync(join(dir, "client-key.pem")),
          cert: readFileSync(join(dir, "client-cert.pem")),
          ca: readFileSync(join(dir, "gateway-ca.pem")),
          agent: false,
          method: "POST",
          path: "/relay/observations",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        });
        req.on("error", reject);
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        });
        req.end(body);
      });
    },
  };
}
type Rig = Awaited<ReturnType<typeof rig>>;

interface Answer {
  status: number;
  head: string;
  body: Buffer;
}

function parse(raw: Buffer): Answer {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString("latin1");
  const body = end === -1 ? Buffer.alloc(0) : raw.subarray(end + 4);
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
    head,
    body: /\r\ntransfer-encoding: chunked/i.test(head) ? dechunk(body) : body,
  };
}

/** A complete chunked body, without its framing. */
function dechunk(framed: Buffer): Buffer {
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const line = framed.indexOf("\r\n", at);
    const size = parseInt(framed.subarray(at, line).toString("latin1"), 16);
    if (!size) return Buffer.concat(out);
    out.push(framed.subarray(line + 2, line + 2 + size));
    at = line + 2 + size + 2;
  }
}

function readToClose(socket: net.Socket): Promise<Buffer> {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  return new Promise((resolve) =>
    socket.once("close", () => resolve(Buffer.concat(chunks))),
  );
}

/**
 * A raw CONNECT to the relay. A 200 hands back the paused socket; any other
 * answer is read to the close.
 */
function connect(
  r: Rig,
  target: string,
  headers: string[] = [],
): Promise<Answer & { socket: net.Socket }> {
  const socket = net.connect(r.relay.port, "127.0.0.1");
  socket.on("error", () => {});
  socket.write(
    `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${headers.map((line) => `${line}\r\n`).join("")}\r\n`,
  );
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!buffer.includes("\r\n\r\n")) return;
      const answer = parse(buffer);
      if (answer.status !== 200) return;
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.pause();
      resolve({ ...answer, socket });
    };
    const onClose = (): void => resolve({ ...parse(buffer), socket });
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

/** A decrypted connection to a token host through the relay. */
async function tokenHost(
  r: Rig,
  host = "api.anthropic.com",
): Promise<tls.TLSSocket> {
  const connected = await connect(r, `${host}:443`);
  assert.equal(connected.status, 200, connected.head);
  const secure = tls.connect({
    socket: connected.socket,
    servername: host,
    ca: [r.caPem],
  });
  secure.on("error", () => {});
  await once(secure, "secureConnect");
  return secure;
}

/** One request on a fresh decrypted connection, read to the close. */
async function decrypted(
  r: Rig,
  request: string,
  host = "api.anthropic.com",
): Promise<Answer> {
  const secure = await tokenHost(r, host);
  const answer = readToClose(secure);
  secure.write(request);
  return parse(await answer);
}

function request(
  method: string,
  target: string,
  headers: string[] = [],
  body = "",
  host = "api.anthropic.com",
): string {
  return [
    `${method} ${target} HTTP/1.1`,
    `Host: ${host}`,
    ...headers,
    ...(body || method === "POST"
      ? [`content-length: ${Buffer.byteLength(body)}`]
      : []),
    "connection: close",
    "",
    body,
  ].join("\r\n");
}

const PLACEHOLDER = `authorization: Bearer ${MACHINE_PLACEHOLDER}`;
const BODY = JSON.stringify({ model: "fake", messages: [] });

function assertMarked(answer: Answer, status: number, type: string): void {
  assert.equal(answer.status, status, answer.head);
  const text = answer.body.toString("utf8");
  assert.ok(isGatewayRefusal(text), text);
  const parsed = JSON.parse(text) as {
    type: string;
    error: { type: string; message: string };
  };
  assert.equal(parsed.type, "error");
  assert.equal(parsed.error.type, type);
}

const rows = (r: Rig) => r.records().filter((row) => row.rid);
const relayRows = (r: Rig) => rows(r).filter((row) => row.via === "relay");
const edgeRows = (r: Rig) => rows(r).filter((row) => row.via === "gateway");
/** Everything a test could leak a sentinel into. */
const surfaces = (r: Rig) =>
  [
    JSON.stringify(r.records()),
    JSON.stringify(r.commits.map((commit) => commit.batch)),
    r.lines.join("\n"),
  ].join("\n");

test("named domains: the edge's ingest accepts the relay's named hosts and nothing wider", async () => {
  assert.deepEqual(RELAY_NAMED_DOMAINS, NAMED_DOMAINS);
  const r = await rig();
  const boot = r.commits[0]!.boot;
  const report = (n: number, host: string, reason = "connect-port") => ({
    d: n + 1,
    rid: `${boot}:${n}`,
    at: Date.now(),
    host,
    method: "CONNECT",
    path: "/",
    status: 403,
    outcome: "refused",
    reason,
    clientCredential: "none",
    clientCookie: false,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
  });
  const before = relayRows(r).length;
  for (const host of [
    "example.com",
    "anthropic.com.evil.test",
    "evilanthropic.com",
    "API.ANTHROPIC.COM",
    "api..anthropic.com",
    "-api.anthropic.com",
    "10.0.0.1",
  ])
    assert.equal(await r.post({ boot, records: [report(90, host)] }), 400);
  assert.equal(
    await r.post({ boot, records: [report(90, "claude.ai", "SENTINEL-x")] }),
    400,
  );
  assert.equal(relayRows(r).length, before);
  assert.equal(
    await r.post({
      boot,
      records: [
        report(90, "api.anthropic.com", "connect-target"),
        report(91, "claude.ai", "connect-port"),
        report(92, "downloads.claude.com", "origin-form"),
        report(93, "anthropic.com", "upgrade"),
      ],
    }),
    200,
  );
  assert.equal(relayRows(r).length, before + 4);
});

test("restack: decrypted M-SEARCH and GET refusals share real ingest with both P7 token hosts", async () => {
  const r = await rig();
  await r.stopEdge();
  for (const [method, host] of [
    ["M-SEARCH", "api.anthropic.com"],
    ["GET", "mcp-proxy.anthropic.com"],
  ] as const) {
    const answer = await decrypted(
      r,
      request(method, `/relay/${method}?q=SENTINEL`, [PLACEHOLDER]),
      host,
    );
    assertMarked(answer, 403, "permission_error");
  }
  await r.restartEdge();
  await r.until(() => relayRows(r).length === 2);
  assert.deepEqual(
    relayRows(r).map((row) => [row.method, row.host, row.path, row.reason]),
    [
      ["M-SEARCH", "api.anthropic.com", "/relay/M-SEARCH", "reserved-path"],
      ["GET", "mcp-proxy.anthropic.com", "/relay/GET", "reserved-path"],
    ],
  );
  assert.ok(
    r.commits.some(
      (commit) =>
        commit.batch.records.filter((record) => "rid" in record).length === 2,
    ),
    "a genuine GET shares the M-SEARCH batch",
  );
  assert.equal(edgeRows(r).length, 0);
  assert.equal(upstreams.anthropic.length, 0);
  assert.ok(!r.lines.some((line) => line.includes("invalid batch")));
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T5: a decrypted POST /v1/messages reaches the fake Anthropic upstream with the account token and the same body; the client gets its answer unchanged", async () => {
  const r = await rig();
  await r.account();
  const answer = await decrypted(
    r,
    request(
      "POST",
      "/v1/messages",
      [PLACEHOLDER, "content-type: application/json"],
      BODY,
    ),
  );
  assert.equal(answer.status, 200, answer.head);
  assert.equal(answer.body.toString(), '{"ok":true}');
  assert.equal(upstreams.anthropic.length, 1);
  const seen = upstreams.anthropic[0]!;
  assert.equal(seen.url, "/v1/messages");
  assert.equal(seen.headers.authorization, `Bearer ${CLAUDE_ACCESS}`);
  assert.equal(seen.headers.host, "api.anthropic.com");
  assert.equal(sha(seen.body), sha(BODY));
  await r.until(() => edgeRows(r).length === 1);
  const row = edgeRows(r)[0]!;
  assert.match(row.rid!, RID);
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.path, "/v1/messages");
  assert.equal(row.clientCredential, "placeholder");
  assert.equal(relayRows(r).length, 0);
});

test("T6: caller x-pandeck-relay-id variants never reach the edge; its record carries the relay's own rid", async () => {
  const r = await rig();
  await r.account();
  const forged = `${"d".repeat(32)}:7`;
  const answer = await decrypted(
    r,
    request(
      "POST",
      "/v1/messages",
      [
        PLACEHOLDER,
        `x-pandeck-relay-id: ${forged}`,
        `X-Pandeck-Relay-Id: ${forged}`,
        "X-PANDECK-RELAY-ID: forged",
      ],
      BODY,
    ),
  );
  assert.equal(answer.status, 200, answer.head);
  await r.until(() => edgeRows(r).length === 1);
  const row = edgeRows(r)[0]!;
  assert.match(row.rid!, RID);
  assert.equal(row.rid!.split(":")[0], r.commits[0]!.boot);
  assert.notEqual(row.rid, forged);
  assert.ok(
    !Object.keys(upstreams.anthropic[0]!.headers).some((name) =>
      name.startsWith("x-pandeck-"),
    ),
  );
});

test("T7: an Origin on a decrypted request is the edge's machine-origin 403, recorded once by the edge", async () => {
  const r = await rig();
  await r.account();
  const answer = await decrypted(
    r,
    request(
      "POST",
      "/v1/messages",
      [PLACEHOLDER, "Origin: https://claude.ai"],
      BODY,
    ),
  );
  assertMarked(answer, 403, "permission_error");
  await r.until(() => edgeRows(r).length === 1);
  assert.equal(edgeRows(r)[0]!.status, 403);
  assert.equal(relayRows(r).length, 0);
  assert.equal(upstreams.anthropic.length, 0);
});

test("T8: an absolute-form target is the relay's marked 400 origin-form, one relay record and nothing at the edge", async () => {
  const r = await rig();
  const answer = await decrypted(
    r,
    request("GET", "https://api.anthropic.com/v1/models?q=SENTINEL", [
      PLACEHOLDER,
    ]),
  );
  assertMarked(answer, 400, "invalid_request_error");
  await r.until(() => relayRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.equal(row.reason, "origin-form");
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.path, "/");
  assert.equal(row.method, "GET");
  assert.equal(row.status, 400);
  assert.equal(row.outcome, "refused");
  assert.equal(row.clientCredential, "placeholder");
  assert.equal(edgeRows(r).length, 0);
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test.each([
  ["other-SENTINEL.example:443", 400, "origin-form"],
  ["api.anthropic.com:443", 400, "origin-form"],
  ["/v1/messages?q=SENTINEL", 400, "origin-form"],
  ["/relay/observations?q=SENTINEL", 403, "reserved-path"],
])(
  "F008: inner CONNECT %s is a marked local %i, not another tunnel",
  async (target, status, reason) => {
    const r = await rig();
    const answer = await decrypted(
      r,
      request(
        "CONNECT",
        target,
        [`Proxy-Authorization: Bearer ${CLAUDE_ACCESS}`, "cookie: SENTINEL"],
        "",
        "spoof-SENTINEL.example",
      ),
    );
    assertMarked(
      answer,
      status,
      status === 400 ? "invalid_request_error" : "permission_error",
    );
    await r.until(() => relayRows(r).length === 1);
    const row = relayRows(r)[0]!;
    assert.deepEqual(
      [row.host, row.method, row.path, row.status, row.outcome, row.reason],
      ["api.anthropic.com", "CONNECT", "/", status, "refused", reason],
    );
    assert.match(row.rid!, RID);
    assert.equal(row.clientCredential, "other");
    assert.equal(row.clientCookie, true);
    assert.equal(row.responseBytes, answer.body.length);
    assert.equal(edgeRows(r).length, 0);
    assert.equal(upstreams.anthropic.length, 0);
    assert.ok(!surfaces(r).includes("SENTINEL"));
    assert.ok(!surfaces(r).includes(CLAUDE_ACCESS));
  },
);

test("F008: inner CONNECT uses counted overflow when the reporting slot is occupied", async () => {
  const r = await rig({ capacity: 2 });
  await r.stopEdge();
  const first = await decrypted(
    r,
    request("POST", "/v1/messages", [PLACEHOLDER], BODY),
  );
  assert.equal(first.status, 502);
  const answer = await decrypted(
    r,
    request("CONNECT", "/relay/observations?q=SENTINEL"),
  );
  assertMarked(answer, 503, "api_error");
  assert.match(answer.body.toString(), /too busy to report/);
  await r.restartEdge();
  await r.until(() => r.records().some((row) => row.outcome === "overflow"));
  assert.equal(
    relayRows(r).length,
    1,
    "only the earlier fallback is a request record",
  );
  assert.equal(relayRows(r)[0]!.method, "POST");
  const notes = r.records().filter((row) => row.outcome === "overflow");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.count, 1);
  assert.equal(edgeRows(r).length, 0);
  assert.equal(upstreams.anthropic.length, 0);
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T9: a client that goes away mid-body aborts the upstream request", async () => {
  const r = await rig();
  await r.account();
  let upstream!: http.IncomingMessage;
  const started = new Promise<void>((resolve) => {
    upstreamStarted = (req) => {
      req.on("error", () => {});
      upstream = req;
      resolve();
    };
  });
  const secure = await tokenHost(r);
  secure.write(
    [
      "POST /v1/messages HTTP/1.1",
      "Host: api.anthropic.com",
      PLACEHOLDER,
      "content-length: 100000",
      "",
      "x".repeat(1000),
    ].join("\r\n"),
  );
  await started;
  // Not `once`: the abort's own "error" would reject it.
  const closed = new Promise((resolve) => upstream.once("close", resolve));
  secure.destroy();
  await closed;
  assert.equal(upstream.complete, false, "the upstream body never completed");
  assert.equal(upstreams.anthropic.length, 0, "no complete upstream request");
});

test("T10: an upgrade on a token host is the relay's marked 501, one record, no edge request", async () => {
  const r = await rig();
  const answer = await decrypted(
    r,
    "GET /v1/stream?q=SENTINEL HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: fake-ws-key\r\n\r\n",
  );
  assertMarked(answer, 501, "api_error");
  await r.until(() => relayRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.equal(row.reason, "upgrade");
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.path, "/v1/stream");
  assert.equal(row.status, 501);
  assert.equal(edgeRows(r).length, 0);
  assert.equal(upstreams.anthropic.length, 0);
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T11: CONNECT to a token host on another port is the marked 403 connect-port, classed by its Proxy-Authorization", async () => {
  const r = await rig();
  const answer = await connect(r, "api.anthropic.com:8443", [
    `Proxy-Authorization: Bearer ${MACHINE_PLACEHOLDER}`,
  ]);
  assertMarked(answer, 403, "permission_error");
  await r.until(() => relayRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.equal(row.reason, "connect-port");
  assert.equal(row.method, "CONNECT");
  assert.equal(row.path, "/");
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.clientCredential, "placeholder");
  assert.equal(edgeRows(r).length, 0);
});

test("T13 (before PR3): MCP is the edge's unknown-prefix 404 and an account call its 403, each recorded once", async () => {
  const r = await rig();
  await r.account();
  const mcp = await decrypted(
    r,
    request(
      "POST",
      "/v1/messages?q=SENTINEL",
      [PLACEHOLDER],
      BODY,
      "spoof-SENTINEL.example",
    ),
    "mcp-proxy.anthropic.com",
  );
  assertMarked(mcp, 404, "not_found_error");
  const profile = await decrypted(
    r,
    request("GET", "/api/oauth/profile", [PLACEHOLDER]),
  );
  assertMarked(profile, 403, "permission_error");
  await r.until(() => edgeRows(r).length === 2);
  assert.deepEqual(
    edgeRows(r)
      .map((row) => row.status)
      .sort(),
    [403, 404],
  );
  assert.equal(new Set(edgeRows(r).map((row) => row.rid)).size, 2);
  const mcpRow = edgeRows(r).find((row) => row.status === 404)!;
  assert.deepEqual(
    [mcpRow.host, mcpRow.path, mcpRow.reason, mcpRow.account],
    ["mcp-proxy.anthropic.com", "/v1/messages", "unknown-prefix", undefined],
  );
  const profileRow = edgeRows(r).find((row) => row.status === 403)!;
  assert.equal(profileRow.host, "api.anthropic.com");
  assert.equal(profileRow.path, "/api/oauth/profile");
  assert.equal(relayRows(r).length, 0, "edge headers suppress relay fallbacks");
  await r.stopEdge();
  const down = await decrypted(
    r,
    request("POST", "/v1/messages?q=SENTINEL", [PLACEHOLDER], BODY),
    "mcp-proxy.anthropic.com",
  );
  assert.equal(down.status, 502);
  await r.restartEdge();
  await r.until(() => relayRows(r).length === 1);
  assert.equal(relayRows(r)[0]!.host, mcpRow.host);
  assert.equal(relayRows(r)[0]!.path, mcpRow.path);
  assert.notEqual(relayRows(r)[0]!.rid, mcpRow.rid);
  assert.equal(
    edgeRows(r).length,
    0,
    "the answered requests did not acquire relay fallbacks after restart",
  );
  assert.equal(upstreams.anthropic.length, 0);
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T15: with the queue full and the edge down, a decrypted request, a connect-port refusal and an upgrade each get the 503 overflow; the edge later gets one overflow note of 3 and the earlier record", async () => {
  const r = await rig({ capacity: 2 });
  await r.stopEdge();
  // The one free slot: a decrypted request that falls back (edge down).
  const first = await decrypted(
    r,
    request("POST", "/v1/messages", [PLACEHOLDER], BODY),
  );
  assert.equal(first.status, 502);
  const overflowed = [
    await decrypted(r, request("POST", "/v1/messages", [PLACEHOLDER], BODY)),
    await connect(r, "api.anthropic.com:8443"),
    await decrypted(
      r,
      "GET /v1/stream HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ),
  ];
  for (const answer of overflowed) assertMarked(answer, 503, "api_error");
  await r.restartEdge();
  await r.until(() => r.records().some((row) => row.outcome === "overflow"));
  await r.until(() => relayRows(r).length === 1);
  const notes = r.records().filter((row) => row.outcome === "overflow");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.count, 3);
  assert.equal(relayRows(r)[0]!.host, "api.anthropic.com");
  assert.equal(relayRows(r)[0]!.outcome, "failed");
  assert.equal(upstreams.anthropic.length, 0, "no overflowed request left");
});

test("T19/T18: a decrypted fallback with capacity carries the token host and query-free path through real ingest; the edge's own record agrees; no sentinel anywhere", async () => {
  const r = await rig();
  await r.account();
  await r.stopEdge();
  const sentinel = request(
    "POST",
    "/v1/messages?q=SENTINEL",
    [`authorization: Bearer ${CLAUDE_ACCESS}`, "cookie: SENTINEL"],
    "SENTINEL",
  );
  const down = await decrypted(r, sentinel);
  assert.equal(down.status, 502, "the relay's edge-unreachable answer");
  assert.ok(!isGatewayRefusal(down.body.toString()), "PR2a keeps it unmarked");
  const invalidBefore = r.lines.filter((line) =>
    line.includes("invalid batch"),
  ).length;
  await r.restartEdge();
  await r.until(() => relayRows(r).length === 1);
  const fallback = relayRows(r)[0]!;
  assert.match(fallback.rid!, RID);
  assert.equal(fallback.host, "api.anthropic.com");
  assert.equal(fallback.path, "/v1/messages");
  assert.equal(fallback.method, "POST");
  assert.equal(fallback.outcome, "failed");
  assert.equal(fallback.status, 502);
  // PR2a reports the transport's error code as the reason.
  assert.match(fallback.reason!, /^[A-Z][A-Z0-9_]*$|^edge-unreachable$/);
  assert.equal(fallback.clientCredential, "other");
  assert.equal(fallback.clientCookie, true);
  assert.equal(
    r.lines.filter((line) => line.includes("invalid batch")).length,
    invalidBefore,
    "the batch was accepted",
  );
  const up = await decrypted(r, sentinel);
  assert.equal(up.status, 200, up.head);
  await r.until(() => edgeRows(r).length === 1);
  const edge = edgeRows(r)[0]!;
  assert.equal(edge.host, fallback.host);
  assert.equal(edge.path, fallback.path);
  assert.notEqual(edge.rid, fallback.rid);
  // The refusal paths with sentinels, too.
  await connect(r, "api.anthropic.com:8443", [
    `Proxy-Authorization: Bearer ${CLAUDE_ACCESS}`,
  ]);
  await decrypted(
    r,
    request("GET", "https://api.anthropic.com/x?q=SENTINEL", [
      `authorization: Bearer ${CLAUDE_ACCESS}`,
    ]),
  );
  await r.until(() => relayRows(r).length === 3);
  assert.ok(!surfaces(r).includes("SENTINEL"));
  assert.ok(!surfaces(r).includes(CLAUDE_ACCESS));
});

test("T4b: malformed CONNECT targets are answered without a record or a logged target; a trailing-dot token host is one connect-target record", async () => {
  const r = await rig();
  for (const target of [
    "api.anthropic.com?q=SENTINEL.anthropic.com:8443",
    "user-SENTINEL@api.anthropic.com:443",
  ]) {
    const answer = await connect(r, target, ["x-note: SENTINEL"]);
    assertMarked(answer, 400, "invalid_request_error");
  }
  const dotted = await connect(r, "API.ANTHROPIC.COM.:443");
  assertMarked(dotted, 403, "permission_error");
  await r.until(() => relayRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.reason, "connect-target");
  assert.equal(row.method, "CONNECT");
  assert.equal(row.path, "/");
  assert.equal(
    r.commits
      .flatMap((commit) => commit.batch.records)
      .filter((record) => "rid" in record).length,
    1,
    "no relay batch held the malformed targets",
  );
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T21a: a partial token-host CONNECT completed during an active stream drain gets one marked closing refusal", async () => {
  const r = await rig({ drainMs: 400 });
  await r.account();
  upstreamStream = true;
  const secure = await tokenHost(r);
  const gotHeaders = new Promise<void>((resolve) => {
    let seen = "";
    secure.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      if (seen.includes("data: stream")) resolve();
    });
  });
  secure.write(
    request(
      "POST",
      "/v1/messages",
      [PLACEHOLDER, "accept: text/event-stream"],
      BODY,
    ),
  );
  await gotHeaders;

  const partial = net.connect(r.relay.port, "127.0.0.1");
  partial.on("error", () => {});
  open.push(() => {
    partial.destroy();
  });
  await once(partial, "connect");
  const prefix =
    "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n";
  await new Promise<void>((resolve, reject) =>
    partial.write(prefix, (error) => (error ? reject(error) : resolve())),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(partial.bytesWritten, Buffer.byteLength(prefix));

  const refusal = readToClose(partial);
  const closing = r.relay.close();
  partial.write("\r\n");
  const answer = parse(await refusal);
  assertMarked(answer, 503, "api_error");
  assert.ok(!answer.head.includes("200 Connection Established"));
  await closing;
  await r.until(() => relayRows(r).length === 1);
  await r.until(() => edgeRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.equal(row.host, "api.anthropic.com");
  assert.equal(row.method, "CONNECT");
  assert.equal(row.path, "/");
  assert.equal(row.status, 503);
  assert.equal(row.reason, "relay-closing");
  assert.equal(
    edgeRows(r).length,
    1,
    "only the active stream reached the edge",
  );
});

test("F008: inner CONNECT on a streaming socket during drain gets one marked closing refusal", async () => {
  const r = await rig({ drainMs: 400 });
  await r.account();
  upstreamStream = true;
  const secure = await tokenHost(r);
  const received: Buffer[] = [];
  const gotHeaders = new Promise<void>((resolve) => {
    secure.on("data", (chunk: Buffer) => {
      received.push(chunk);
      if (Buffer.concat(received).includes("data: stream")) resolve();
    });
  });
  secure.write(
    request("POST", "/v1/messages", [PLACEHOLDER], BODY).replace(
      "connection: close",
      "connection: keep-alive",
    ),
  );
  await gotHeaders;
  const cut = once(secure, "close");
  const closing = r.relay.close();
  secure.write(request("CONNECT", "other-SENTINEL.example:443"));
  await cut;
  await closing;
  const raw = Buffer.concat(received);
  const answer = parse(raw.subarray(raw.lastIndexOf("HTTP/1.1")));
  assertMarked(answer, 503, "api_error");
  await r.until(() => relayRows(r).length === 1 && edgeRows(r).length === 1);
  const row = relayRows(r)[0]!;
  assert.deepEqual(
    [row.host, row.method, row.path, row.status, row.reason],
    ["api.anthropic.com", "CONNECT", "/", 503, "relay-closing"],
  );
  assert.ok(!surfaces(r).includes("SENTINEL"));
});

test("T21a: close with an active decrypted stream cuts it at the drain deadline, as on the plain listener, with exactly one edge record", async () => {
  const r = await rig();
  await r.account();
  upstreamStream = true;
  const secure = await tokenHost(r);
  const gotHeaders = new Promise<void>((resolve) => {
    let seen = "";
    secure.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      if (seen.includes("data: stream")) resolve();
    });
  });
  const cut = once(secure, "close");
  secure.write(
    request(
      "POST",
      "/v1/messages",
      [PLACEHOLDER, "accept: text/event-stream"],
      BODY,
    ),
  );
  await gotHeaders;
  await r.relay.close();
  await cut;
  await r.until(() => edgeRows(r).length === 1);
  assert.equal(relayRows(r).length, 0, "headers arrived: no relay fallback");
  assert.equal(new Set(rows(r).map((row) => row.rid)).size, 1);
});

test("T21b: close with an undelivered decrypted fallback logs the dropped count, writes no file, and the next boot reports unknown loss", async () => {
  const r = await rig();
  const before = readdirSync(r.dir).sort();
  assert.ok(before.includes("intercept-ca-key.pem"));
  await r.stopEdge();
  const answer = await decrypted(
    r,
    request("POST", "/v1/messages", [PLACEHOLDER], BODY),
  );
  assert.equal(answer.status, 502);
  await r.relay.close();
  assert.deepEqual(
    r.lines.filter((line) => line.includes("not delivered at close")),
    ["observations: 1 not delivered at close"],
  );
  assert.deepEqual(readdirSync(r.dir).sort(), before);
  await r.restartEdge();
  const commitsBefore = r.commits.length;
  await r.restartRelay();
  await r.until(() => r.commits.length > commitsBefore);
  const restart = r
    .records()
    .filter((row) => row.reason === "relay-restarted")
    .at(-1)!;
  assert.equal(restart.count, undefined);
  assert.equal(r.commits.at(-1)!.batch.records[0]!.d, 1);
  assert.equal(relayRows(r).length, 0, "the dropped fallback never arrives");
});
