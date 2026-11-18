/**
 * The request log on a real edge (Task-1430 PR1): every request on a client's
 * model port becomes exactly one record and one text line, whichever path
 * ends it, and neither holds a credential, query, body or raw session key.
 * Requests go straight to the model port with an enrolled client's
 * certificate, as the relay sends them.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { RunningGateway } from "./gateway/gateway.ts";
import type { RequestRecord } from "./gateway/requestLog.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-request-log-home-"));
process.env.HOME = home;

const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
const { fakeProcesses, startFakeUpstreams } =
  await import("./test/gatewayFixtures.ts");
const { createEdgeTools } = await import("./gatewayTools/index.ts");

const PLACEHOLDER =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck";
const SENTINEL = "SENTINEL-7d1e";
const SESSION_KEY = `session-${SENTINEL}`;
const ACCESS = "fake-request-log-access";
const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

type Mode =
  | { kind: "ok" }
  | { kind: "truncate" }
  | { kind: "hold"; until: Promise<void> };
let mode: Mode = { kind: "ok" };
/** Each upstream request as it starts, before its body. */
let started: http.IncomingMessage[] = [];
/** Body bytes the upstream has read of the started requests. */
let startedBytes = 0;

let upstreams: Awaited<ReturnType<typeof startFakeUpstreams>>;
const open: { close(): unknown }[] = [];
let lines: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: (_seen, res) => {
      const current = mode;
      if (current.kind === "truncate") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("event: message_start\n\n");
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      const answer = () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `upstream=${SENTINEL}-cookie`,
        });
        res.end('{"ok":true}');
      };
      if (current.kind === "hold") void current.until.then(answer);
      else answer();
    },
    claudeStarted: (req) => {
      started.push(req);
      req.on("data", (chunk: Buffer) => (startedBytes += chunk.length));
    },
  });
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  const logged = lines;
  lines = [];
  mode = { kind: "ok" };
  started = [];
  startedBytes = 0;
  upstreams.reset();
  // No line holds a sentinel, the placeholder, a token or a session hash.
  for (const line of logged) {
    for (const secret of [
      SENTINEL,
      PLACEHOLDER,
      ACCESS,
      sha256(SESSION_KEY).slice(0, 12),
    ])
      assert.ok(!line.includes(secret), `logged ${secret}: ${line}`);
  }
});

afterAll(async () => {
  await upstreams.close();
  rmSync(home, { recursive: true, force: true });
});

interface Machine {
  clientId: string;
  userId: string;
  dir: string;
}

async function startEdge(
  overrides = upstreams.overrides,
  stateDir = mkdtempSync(join(DATA_DIR, "request-log-edge-")),
  withTools = false,
): Promise<RunningGateway> {
  const gw = await startGateway({
    ...(withTools ? { tools: createEdgeTools({ log: () => {} }) } : {}),
    stateDir,
    upstreams: overrides,
    claudeTokenEndpoint: upstreams.tokenEndpoint,
    processProbe: fakeProcesses().probe,
    log: (line) => lines.push(line),
    clients: { modelPort: 0, clientPort: 0, enrollPort: 0 },
  });
  open.push({ close: () => gw.close() });
  // Registered users persist; a restart on the same state has them.
  if (!gw.clients!.registry.user("thasso"))
    gw.clients!.registry.addUser("thasso");
  return gw;
}

/** A Claude account of `userId`, its token far from expiry. */
function account(gw: RunningGateway, id: string, userId: string): string {
  const dir = mkdtempSync(join(DATA_DIR, "request-log-acct-"));
  const file = join(dir, ".credentials.json");
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: `${ACCESS}-refresh`,
        expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
      },
    }),
  );
  gw.clients!.putAccount({
    id,
    provider: "claude",
    name: `Account ${id}`,
    enabled: true,
    tokenFile: file,
    userId,
  });
  return file;
}

async function machine(
  gw: RunningGateway,
  userId: string,
  label: string,
): Promise<Machine> {
  const edge = gw.clients!;
  const dir = mkdtempSync(join(tmpdir(), "request-log-relay-"));
  open.push({ close: () => rmSync(dir, { recursive: true, force: true }) });
  const before = new Set(edge.registry.clients().map((c) => c.id));
  await enrollRelay({
    stateDir: dir,
    host: "127.0.0.1",
    enrollPort: edge.enrollPort,
    caPem: edge.caPem,
    code: edge.registry.createCode(userId, label),
  });
  const clientId = edge.registry.clients().find((c) => !before.has(c.id))!.id;
  return { clientId, userId, dir };
}

interface Sent {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

/** The machine's certificate, for a request to the model port. */
function tlsOf(gw: RunningGateway, m: Machine): https.RequestOptions {
  const file = (name: string): string =>
    readFileSync(join(m.dir, name), "utf8");
  return {
    host: "127.0.0.1",
    port: gw.clients!.modelPort,
    servername: "localhost",
    key: file("client-key.pem"),
    cert: file("client-cert.pem"),
    ca: file("gateway-ca.pem"),
    agent: false,
  };
}

/** One request to the model port with the machine's certificate. */
function send(
  gw: RunningGateway,
  m: Machine,
  path: string,
  options: {
    method?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
    /** A keep-alive agent built from `tlsOf`, to reuse one connection. */
    agent?: https.Agent;
  } = {},
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      ...tlsOf(gw, m),
      ...(options.agent ? { agent: options.agent } : {}),
      path,
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", ...options.headers },
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          headers: response.headers,
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(options.body ?? '{"model":"fixture"}');
  });
}

/** The user's records, as the page's API answers them. */
function recordsOf(gw: RunningGateway, userId: string): RequestRecord[] {
  return gw.requests!.since(userId, undefined, 0, 500).records;
}

const requestLines = (): string[] =>
  lines.filter((line) => line.includes(" via=gateway"));

test("a machine request: one record with the C3 fields, one line, and nothing secret anywhere", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const body = JSON.stringify({ model: "fixture", note: SENTINEL });
  const reply = await send(gw, m, `/anthropic/v1/messages?q=${SENTINEL}`, {
    headers: {
      authorization: `Bearer ${PLACEHOLDER}`,
      "x-claude-code-session-id": SESSION_KEY,
      cookie: `c=${SENTINEL}`,
    },
    body,
  });
  assert.equal(reply.status, 200);
  // The upstream's cookie never reaches the client; its body did, unchanged.
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(upstreams.anthropic.length, 1);
  assert.equal(sha256(upstreams.anthropic[0]!.body), sha256(body));

  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.deepEqual(
    { ...record, at: 0, durationMs: 0 },
    {
      seq: 1,
      epoch: gw.requests!.epoch,
      at: 0,
      client: { id: m.clientId, label: "devbox" },
      via: "gateway",
      host: "api.anthropic.com",
      method: "POST",
      path: "/v1/messages",
      pathKey: "/v1/messages",
      status: 200,
      outcome: "forwarded",
      account: "Account a",
      session: sha256(SESSION_KEY).slice(0, 12),
      clientCredential: "placeholder",
      clientCookie: true,
      requestBytes: Buffer.byteLength(body),
      responseBytes: Buffer.byteLength('{"ok":true}'),
      durationMs: 0,
      firstSeen: true,
    },
  );
  assert.match(gw.requests!.epoch, /^[0-9a-f]{32}$/);
  // The answer the page reads, serialized as the route sends it.
  const answer = JSON.stringify(
    gw.requests!.since("thasso", undefined, 0, 500),
  );
  for (const secret of [SENTINEL, PLACEHOLDER, ACCESS, SESSION_KEY])
    assert.ok(!answer.includes(secret), secret);
  assert.ok(!answer.includes(sha256(SESSION_KEY)), "the full session hash");
  assert.deepEqual(requestLines().length, 1);
  assert.match(
    requestLines()[0]!,
    new RegExp(
      `^claude POST "/v1/messages" kind=machine client=${m.clientId} lease=\\S+ 200 \\d+ms outcome=forwarded via=gateway$`,
    ),
  );

  // The same path again is not first seen.
  await send(gw, m, "/anthropic/v1/messages", {
    headers: { authorization: `Bearer ${PLACEHOLDER}` },
  });
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 2));
  assert.equal(recordsOf(gw, "thasso")[1]!.firstSeen, false);
  assert.equal(recordsOf(gw, "thasso")[1]!.session, undefined);
});

test("a sentinel bearer, API key and session key are classed, never kept", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const reply = await send(gw, m, "/anthropic/v1/messages", {
    headers: {
      authorization: `Bearer ${SENTINEL}`,
      "x-api-key": [PLACEHOLDER, SENTINEL],
      "x-claude-code-session-id": SESSION_KEY,
      // A client's own header text reaches no line on its port.
      "user-agent": `agent ${SENTINEL}`,
      originator: SENTINEL,
    },
  });
  // Not lease-shaped: the machine path serves it.
  assert.equal(reply.status, 200);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  assert.ok(!lines.some((line) => line.startsWith("client user-agent=")));
  const [record] = recordsOf(gw, "thasso");
  assert.equal(record!.clientCredential, "other");
  assert.equal(record!.clientCookie, false);
  const answer = JSON.stringify(record);
  assert.ok(!answer.includes(SENTINEL));
  assert.ok(!answer.includes(SESSION_KEY));
  // Only the session key passes upstream, as before; the client's credentials
  // never do.
  const { headers } = upstreams.anthropic[0]!;
  assert.equal(headers["x-api-key"], undefined);
  assert.ok(!String(headers.authorization).includes(SENTINEL));
});

test("a lease request names the lease's account; another client's lease is refused without one", async () => {
  const gw = await startEdge();
  const tokenFile = account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const other = await machine(gw, "thasso", "laptop");
  const binding = { profileId: "a", provider: "claude" as const, tokenFile };
  const own = gw.leases.grant(binding, {
    kind: "engine",
    owner: { workerId: "w1", clientId: m.clientId },
  });
  const theirs = gw.leases.grant(binding, {
    kind: "engine",
    owner: { workerId: "w2", clientId: other.clientId },
  });
  assert.equal(
    (
      await send(gw, m, "/anthropic/v1/messages", {
        headers: { authorization: `Bearer ${own.token}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send(gw, m, "/anthropic/v1/messages", {
        headers: { authorization: `Bearer ${theirs.token}` },
      })
    ).status,
    403,
  );
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 2));
  const [served, refused] = recordsOf(gw, "thasso");
  assert.equal(served!.clientCredential, "lease");
  assert.equal(served!.outcome, "forwarded");
  assert.equal(served!.account, "Account a");
  assert.equal(refused!.clientCredential, "lease");
  assert.equal(refused!.outcome, "refused");
  assert.equal(refused!.reason, "forbidden");
  assert.equal(refused!.status, 403);
  assert.equal(refused!.account, undefined);
  assert.equal(refused!.requestBytes, 0);
  for (const token of [own.token, theirs.token]) {
    assert.ok(!JSON.stringify(recordsOf(gw, "thasso")).includes(token));
    for (const line of lines) assert.ok(!line.includes(token), line);
  }
  assert.equal(requestLines().length, 2);
});

test("refusals: one record each, with the fixed case and the bytes of the refusal", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const origin = await send(gw, m, "/anthropic/v1/messages", {
    headers: { origin: "https://elsewhere.test" },
  });
  assert.equal(origin.status, 403);
  const unknown = await send(gw, m, `/nowhere/x?token=${SENTINEL}`);
  assert.equal(unknown.status, 404);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 2));
  const [first, second] = recordsOf(gw, "thasso");
  assert.deepEqual(
    [first!.outcome, first!.reason, first!.status, first!.host, first!.path],
    ["refused", "machine-origin", 403, "api.anthropic.com", "/v1/messages"],
  );
  assert.equal(first!.clientCredential, "none");
  assert.equal(first!.responseBytes, Buffer.byteLength(origin.text));
  assert.equal(first!.requestBytes, 0);
  assert.deepEqual(
    [second!.outcome, second!.reason, second!.status, second!.host],
    ["refused", "unknown-prefix", 404, ""],
  );
  assert.equal(second!.path, "/nowhere/x");
  assert.equal(second!.session, undefined);
  assert.equal(upstreams.anthropic.length, 0);
  assert.equal(requestLines().length, 2);
});

test("an upstream that fails after its headers: one failed record with the status sent", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  mode = { kind: "truncate" };
  await send(gw, m, "/anthropic/v1/messages").then(
    () => undefined,
    () => undefined,
  );
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.equal(record!.outcome, "failed");
  assert.equal(record!.status, 200);
  assert.ok(
    record!.reason === "upstream-truncated" || /^[A-Z]/.test(record!.reason!),
  );
  assert.ok(record!.responseBytes > 0);
  assert.equal(requestLines().length, 1);
  assert.match(
    requestLines()[0]!,
    /upstream error after headers .* outcome=failed via=gateway$/,
  );
});

test("an unreachable upstream: one failed record with the error code", async () => {
  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as net.AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const gw = await startEdge({
    ...upstreams.overrides,
    claude: {
      ...upstreams.overrides.claude,
      connect: { host: "127.0.0.1", port },
    },
  });
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  assert.equal((await send(gw, m, "/anthropic/v1/messages")).status, 502);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.deepEqual(
    [record!.outcome, record!.reason, record!.status, record!.account],
    ["failed", "ECONNREFUSED", 502, "Account a"],
  );
});

test("a client abort mid-body cancels the upstream and is recorded once", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const partial = `{"model":"fixture","pad":"${"x".repeat(2_000)}`;
  const request = https.request({
    ...tlsOf(gw, m),
    path: "/anthropic/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(partial) + 1_000,
    },
  });
  request.on("error", () => {});
  request.write(partial);
  await vi.waitFor(() => assert.equal(started.length, 1));
  const upstreamReq = started[0]!;
  const upstreamClosed = new Promise<void>((resolve) =>
    upstreamReq.once("close", () => resolve()),
  );
  await vi.waitFor(() => assert.ok(startedBytes > 0));
  const reached = startedBytes;
  request.destroy();
  // The edge cancels the upstream request; it never completes there.
  await upstreamClosed;
  assert.equal(upstreams.anthropic.length, 0);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.deepEqual(
    [record!.outcome, record!.reason, record!.status],
    ["failed", "client-closed", null],
  );
  assert.ok(record!.requestBytes >= reached);
  assert.ok(record!.requestBytes <= Buffer.byteLength(partial));
  assert.equal(requestLines().length, 1);
});

test("a client revoked while its request waits keeps the record it was admitted with", async () => {
  const gw = await startEdge();
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  let release!: () => void;
  mode = { kind: "hold", until: new Promise((resolve) => (release = resolve)) };
  const pending = send(gw, m, "/anthropic/v1/messages").catch(() => undefined);
  await vi.waitFor(() => assert.equal(upstreams.anthropic.length, 1));
  gw.clients!.userOperations.revokeClient("thasso", m.clientId);
  release();
  await pending;
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.deepEqual(record!.client, { id: m.clientId, label: "devbox" });
  assert.equal(record!.account, "Account a");
  assert.equal(requestLines().length, 1);
});

test.each([
  [
    "renamed",
    (gw: RunningGateway, tokenFile: string) =>
      gw.clients!.putAccount({
        id: "a",
        provider: "claude",
        name: "Account a renamed",
        enabled: true,
        tokenFile,
        userId: "thasso",
      }),
  ],
  ["removed", (gw: RunningGateway) => gw.clients!.removeAccount("a")],
] as const)(
  "an account %s while its request streams stays the account the record spent",
  async (_change, change) => {
    const gw = await startEdge();
    const tokenFile = account(gw, "a", "thasso");
    const m = await machine(gw, "thasso", "devbox");
    const own = gw.leases.grant(
      { profileId: "a", provider: "claude", tokenFile },
      { kind: "engine", owner: { workerId: "w1", clientId: m.clientId } },
    );
    let release!: () => void;
    mode = {
      kind: "hold",
      until: new Promise((resolve) => (release = resolve)),
    };
    const viaMachine = send(gw, m, "/anthropic/v1/messages");
    const viaLease = send(gw, m, "/anthropic/v1/messages", {
      headers: { authorization: `Bearer ${own.token}` },
    });
    await vi.waitFor(() => assert.equal(upstreams.anthropic.length, 2));
    change(gw, tokenFile);
    release();
    assert.equal((await viaMachine).status, 200);
    assert.equal((await viaLease).status, 200);
    await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 2));
    for (const record of recordsOf(gw, "thasso")) {
      assert.equal(record.outcome, "forwarded");
      assert.equal(record.account, "Account a");
    }
  },
);

test("users see only their own clients' records", async () => {
  const gw = await startEdge();
  gw.clients!.registry.addUser("other");
  account(gw, "a", "thasso");
  account(gw, "b", "other");
  const mine = await machine(gw, "thasso", "devbox");
  const theirs = await machine(gw, "other", "their box");
  await send(gw, mine, "/anthropic/v1/messages");
  await send(gw, theirs, "/anthropic/v1/messages/count_tokens");
  await vi.waitFor(() => {
    assert.equal(recordsOf(gw, "thasso").length, 1);
    assert.equal(recordsOf(gw, "other").length, 1);
  });
  assert.equal(recordsOf(gw, "thasso")[0]!.client.id, mine.clientId);
  assert.equal(recordsOf(gw, "thasso")[0]!.account, "Account a");
  assert.equal(recordsOf(gw, "other")[0]!.client.id, theirs.clientId);
  assert.equal(recordsOf(gw, "other")[0]!.account, "Account b");
  assert.deepEqual(recordsOf(gw, "nobody"), []);
});

test("the seen set survives a restart; the epoch does not", async () => {
  const stateDir = mkdtempSync(join(DATA_DIR, "request-log-edge-"));
  const first = await startEdge(upstreams.overrides, stateDir);
  account(first, "a", "thasso");
  const m = await machine(first, "thasso", "devbox");
  await send(first, m, "/anthropic/v1/messages");
  await vi.waitFor(() => assert.equal(recordsOf(first, "thasso").length, 1));
  assert.equal(recordsOf(first, "thasso")[0]!.firstSeen, true);
  const epoch = first.requests!.epoch;
  await first.close();
  const second = await startEdge(upstreams.overrides, stateDir);
  assert.notEqual(second.requests!.epoch, epoch);
  await send(second, m, "/anthropic/v1/messages");
  await vi.waitFor(() => assert.equal(recordsOf(second, "thasso").length, 1));
  const [record] = recordsOf(second, "thasso");
  assert.equal(record!.firstSeen, false);
  assert.equal(record!.seq, 1);
  const stored = readFileSync(join(stateDir, "seenRequests.json"), "utf8");
  assert.deepEqual(JSON.parse(stored), {
    seen: [
      { host: "api.anthropic.com", method: "POST", pathKey: "/v1/messages" },
    ],
  });
});

test("/mcp: each answered or refused request is one record and one line, classed by its status, with no token, query or JSON-RPC content", async () => {
  const gw = await startEdge(upstreams.overrides, undefined, true);
  const m = await machine(gw, "thasso", "devbox");
  const token = gw.clients!.registry.setMcpToken(m.clientId);
  const rpc = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: SENTINEL, arguments: { note: SENTINEL } },
  });
  const auth = { authorization: `Bearer ${token}` };
  const answered = await send(gw, m, `/mcp?q=${SENTINEL}`, {
    headers: { ...auth, accept: "application/json, text/event-stream" },
    body: rpc,
  });
  const notAllowed = await send(gw, m, "/mcp", {
    method: "GET",
    headers: auth,
  });
  const origin = await send(gw, m, "/mcp", {
    headers: { ...auth, origin: "https://example.org" },
    body: rpc,
  });
  const noToken = await send(gw, m, "/mcp", {
    headers: { authorization: `Bearer pgmcp_${SENTINEL}` },
    body: rpc,
  });
  const badVersion = await send(gw, m, "/mcp", {
    headers: { ...auth, "mcp-protocol-version": "1999-01-01" },
    body: rpc,
  });
  assert.equal(answered.status, 200);
  assert.equal(notAllowed.status, 405);
  assert.equal(origin.status, 403);
  assert.equal(noToken.status, 401);
  assert.equal(badVersion.status, 400);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 5));
  const records = recordsOf(gw, "thasso");
  assert.deepEqual(
    records.map((r) => [r.method, r.status, r.outcome, r.reason]),
    [
      ["POST", 200, "forwarded", undefined],
      ["GET", 405, "refused", "method-not-allowed"],
      ["POST", 403, "refused", "mcp-origin"],
      ["POST", 401, "refused", "mcp-token"],
      ["POST", 400, "refused", "bad-request"],
    ],
  );
  for (const record of records) {
    assert.equal(record.host, "");
    assert.equal(record.path, "/mcp");
    assert.equal(record.pathKey, "/mcp");
    assert.equal(record.clientCredential, "other");
    assert.equal(record.account, undefined);
    assert.equal(record.session, undefined);
    assert.deepEqual(record.client, { id: m.clientId, label: "devbox" });
  }
  // Measured, never assumed: the answered request's body and answer.
  assert.equal(records[0]!.requestBytes, Buffer.byteLength(rpc));
  assert.equal(records[0]!.responseBytes, Buffer.byteLength(answered.text));
  assert.ok(records[0]!.responseBytes > 0);
  // A gate refuses before the body is read.
  assert.equal(records[2]!.requestBytes, 0);
  assert.equal(records[3]!.requestBytes, 0);
  assert.equal(records[2]!.responseBytes, Buffer.byteLength(origin.text));
  assert.equal(records[4]!.responseBytes, Buffer.byteLength(badVersion.text));
  const stored = JSON.stringify(records);
  for (const secret of [SENTINEL, token, "tools/call", "jsonrpc"])
    assert.ok(!stored.includes(secret), secret);
  // One line each, written by its record; none holds the token.
  const mcpLines = requestLines().filter((line) => line.includes('"/mcp"'));
  assert.equal(mcpLines.length, 5);
  assert.ok(lines.every((line) => !line.includes(token)));
  assert.ok(!lines.some((line) => line.startsWith("mcp refused")));
  assert.match(
    mcpLines[3]!,
    new RegExp(
      `^- POST "/mcp" kind=- client=${m.clientId} refused mcp-token 401 \\d+ms outcome=refused via=gateway$`,
    ),
  );
  assert.match(
    mcpLines[1]!,
    / refused method-not-allowed 405 \d+ms outcome=refused via=gateway$/,
  );
});

test("/mcp: an upload over the cap is one refused record, too-large", async () => {
  const gw = await startEdge(upstreams.overrides, undefined, true);
  const m = await machine(gw, "thasso", "devbox");
  const token = gw.clients!.registry.setMcpToken(m.clientId);
  const body = `{"pad":"${"x".repeat(1024 * 1024)}"}`;
  // The edge answers before the upload ends and then closes the connection,
  // so the client may see the answer or a reset; the record is the edge's.
  await send(gw, m, "/mcp", {
    headers: { authorization: `Bearer ${token}` },
    body,
  }).catch(() => undefined);
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.deepEqual(
    [record!.outcome, record!.reason, record!.status],
    ["refused", "too-large", 413],
  );
  assert.ok(record!.requestBytes > 1024 * 1024);
  assert.ok(record!.requestBytes <= Buffer.byteLength(body));
  assert.ok(record!.responseBytes > 0);
  assert.ok(!JSON.stringify(record).includes("xxxx"));
  assert.equal(
    requestLines().filter((line) => line.includes('"/mcp"')).length,
    1,
  );
});

test("a refusal before the forwarder without a resolvable client is a line only", async () => {
  const stateDir = mkdtempSync(join(DATA_DIR, "request-log-edge-"));
  const gw = await startEdge(upstreams.overrides, stateDir);
  account(gw, "a", "thasso");
  const m = await machine(gw, "thasso", "devbox");
  const { key, cert, ca, servername } = tlsOf(gw, m);
  const agent = new https.Agent({
    ...{ key, cert, ca, servername },
    keepAlive: true,
    maxSockets: 1,
  });
  open.push({ close: () => agent.destroy() });
  assert.equal(
    (await send(gw, m, "/anthropic/v1/messages", { agent })).status,
    200,
  );
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  // The registry cannot be read: the open connection's next request is 503.
  const file = join(stateDir, "clients.json");
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "temporarily invalid JSON");
  const refused = await send(gw, m, `/anthropic/v1/messages?q=${SENTINEL}`, {
    agent,
  });
  writeFileSync(file, good);
  assert.equal(refused.status, 503);
  await vi.waitFor(() =>
    assert.ok(
      requestLines().some((line) =>
        line.includes("refused registry-unavailable 503"),
      ),
    ),
  );
  const records = recordsOf(gw, "thasso");
  assert.equal(records.length, 2);
  assert.deepEqual(
    [
      records[1]!.client,
      records[1]!.outcome,
      records[1]!.reason,
      records[1]!.status,
    ],
    [
      { id: m.clientId, label: "devbox" },
      "refused",
      "registry-unavailable",
      503,
    ],
  );
  assert.ok(!JSON.stringify(records[1]).includes(SENTINEL));
  assert.equal(requestLines().length, 2);
});

test("/mcp: a client that hangs up mid-body is one failed record, client-closed", async () => {
  const gw = await startEdge(upstreams.overrides, undefined, true);
  const m = await machine(gw, "thasso", "devbox");
  const token = gw.clients!.registry.setMcpToken(m.clientId);
  const request = https.request({
    ...tlsOf(gw, m),
    path: "/mcp",
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": 1_000,
    },
  });
  request.on("error", () => {});
  request.write('{"jsonrpc":');
  await new Promise((resolve) => setTimeout(resolve, 50));
  request.destroy();
  await vi.waitFor(() => assert.equal(recordsOf(gw, "thasso").length, 1));
  const [record] = recordsOf(gw, "thasso");
  assert.equal(record!.outcome, "failed");
  assert.equal(record!.reason, "client-closed");
  assert.equal(record!.status, null);
  assert.equal(record!.responseBytes, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(recordsOf(gw, "thasso").length, 1);
  assert.equal(
    requestLines().filter((line) => line.includes('"/mcp"')).length,
    1,
  );
});
