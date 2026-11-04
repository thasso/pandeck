/**
 * The credential gateway over real loopback HTTP, against fake TLS upstreams
 * that stand in for `api.anthropic.com` and `chatgpt.com`. Token files are
 * fixtures under the test's temp `DATA_DIR`; every value in them is fake.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, type Hash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import type tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  issueLeafCertificate,
  loadOrCreateCa,
  type CertificatePair,
} from "../packageProxy/certificateAuthority.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import type { LeaseProvider } from "./leases.ts";
import { refusalText } from "./refusals.ts";

// Synthetic fixture values; none is a real credential.
const CLAUDE_ACCESS = "fake-claude-access";
const CODEX_ACCESS = "fake-codex-access";
const CODEX_ACCOUNT = "acct-test";
const BODY_SENTINEL = "body-sentinel-g1";
const TEST_CLIENT = "pandeck-test-client/1.0";
const PROXY_USERINFO = "fixture-proxy:fixture";

const ANTHROPIC_HOST = "api.anthropic.com";
const CHATGPT_HOST = "chatgpt.com";
const CLAUDE_PATH = "/anthropic/v1/messages";
const CODEX_PATH = "/chatgpt/backend-api/codex/responses";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  servername: string | undefined;
  body: Buffer;
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

interface FakeUpstream {
  server: https.Server;
  port: number;
  /** Every request the upstream received: "no upstream request" is 0. */
  seen: Seen[];
  handler: Handler;
}

const okHandler: Handler = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

let ca: CertificatePair;
let anthropic: FakeUpstream;
let chatgpt: FakeUpstream;
const running: RunningGateway[] = [];
/** Every gateway log line of the current test. */
let logLines: string[] = [];

async function fakeUpstream(host: string): Promise<FakeUpstream> {
  const leaf = issueLeafCertificate(ca, host);
  const fake = { seen: [], handler: okHandler } as unknown as FakeUpstream;
  fake.server = https.createServer(
    { key: leaf.keyPem, cert: leaf.certPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        fake.seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          servername: (req.socket as tls.TLSSocket).servername || undefined,
          body: Buffer.concat(chunks),
        });
        void fake.handler(req, res);
      });
    },
  );
  await new Promise<void>((resolve) =>
    fake.server.listen(0, "127.0.0.1", () => resolve()),
  );
  fake.port = (fake.server.address() as net.AddressInfo).port;
  return fake;
}

beforeAll(async () => {
  ca = await loadOrCreateCa();
  anthropic = await fakeUpstream(ANTHROPIC_HOST);
  chatgpt = await fakeUpstream(CHATGPT_HOST);
});

afterEach(async () => {
  while (running.length) await running.pop()!.close();
  for (const fake of [anthropic, chatgpt]) {
    fake.seen = [];
    fake.handler = okHandler;
    fake.server.closeAllConnections();
  }
  logLines = [];
});

afterAll(async () => {
  for (const fake of [anthropic, chatgpt])
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

function upstreamOverride(port: number) {
  return { connect: { host: "127.0.0.1", port }, ca: ca.certPem };
}

async function gateway(
  claudePort = anthropic.port,
): Promise<RunningGateway & { lines: string[] }> {
  const lines: string[] = [];
  const gw = await startGateway({
    log: (line) => {
      lines.push(line);
      logLines.push(line);
    },
    upstreams: {
      claude: upstreamOverride(claudePort),
      "openai-codex": upstreamOverride(chatgpt.port),
    },
  });
  running.push(gw);
  return Object.assign(gw, { lines });
}

interface TokenFiles {
  claudeDir: string;
  claudeFile: string;
  codexDir: string;
  codexFile: string;
}

async function tokenFiles(): Promise<TokenFiles> {
  await mkdir(DATA_DIR, { recursive: true });
  const root = await mkdtemp(join(DATA_DIR, "gateway-tokens-"));
  const claudeDir = join(root, "claude");
  const codexDir = join(root, "pi");
  await mkdir(claudeDir);
  await mkdir(codexDir);
  const claudeFile = join(claudeDir, ".credentials.json");
  const codexFile = join(codexDir, "auth.json");
  const expires = Date.now() + 3_600_000;
  await writeFile(
    claudeFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: CLAUDE_ACCESS,
        refreshToken: "fake-claude-refresh",
        expiresAt: expires,
      },
    }),
  );
  await writeFile(
    codexFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: CODEX_ACCESS,
        refresh: "fake-codex-refresh",
        accountId: CODEX_ACCOUNT,
        expires,
      },
    }),
  );
  return { claudeDir, claudeFile, codexDir, codexFile };
}

function grant(
  gw: RunningGateway,
  provider: LeaseProvider,
  tokenFile: string,
): { leaseId: string; token: string } {
  return gw.leases.grant(
    { profileId: `${provider}-work`, provider, tokenFile },
    { kind: "engine", owner: { workerId: "local", sessionId: "s1" } },
  );
}

interface SendOptions {
  method?: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
}

interface Opened {
  request: http.ClientRequest;
  response: http.IncomingMessage;
}

/** Sends a request and resolves at the response headers. */
function open(
  port: number,
  { method = "POST", path, headers = {}, body }: SendOptions,
): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      agent: false,
      headers: { "user-agent": TEST_CLIENT, ...headers },
    });
    request.on("response", (response) => resolve({ request, response }));
    request.on("error", reject);
    request.end(body);
  });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function send(port: number, options: SendOptions): Promise<Reply> {
  const { response } = await open(port, options);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks),
  };
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** The message of a provider-shaped refusal body, checking the shape. */
function refusalMessage(
  reply: Reply,
  shape: "claude" | "codex",
  type: string,
): string {
  assert.equal(reply.headers["content-type"], "application/json");
  const body = JSON.parse(reply.body.toString("utf8"));
  if (shape === "claude") {
    assert.deepEqual(Object.keys(body).sort(), ["error", "type"]);
    assert.equal(body.type, "error");
    assert.equal(body.error.type, type);
  } else {
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(body.error.type, type);
    assert.equal(body.error.code, type);
  }
  return body.error.message;
}

function upstreamRequests(): number {
  return anthropic.seen.length + chatgpt.seen.length;
}

/** A Claude Messages request forwarded with the profile's credential. */
async function claudeForward(
  gw: RunningGateway,
  files: TokenFiles,
): Promise<string[]> {
  const { token } = grant(gw, "claude", files.claudeFile);
  anthropic.handler = (_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "upstream-session=1",
      connection: "keep-alive, x-upstream-hop",
      "x-upstream-hop": "1",
      "x-upstream": "kept",
    });
    res.end('{"id":"msg_fixture"}');
  };
  const body = JSON.stringify({
    model: "claude-fixture",
    messages: [{ role: "user", content: BODY_SENTINEL }],
  });
  const reply = await send(gw.port, {
    path: `${CLAUDE_PATH}?beta=true`,
    headers: {
      ...bearer(token),
      "x-api-key": "k",
      "anthropic-beta": "oauth-2025-04-20,x",
      "content-type": "application/json",
      connection: "close, x-client-hop",
      "x-client-hop": "1",
      "proxy-authorization": `Basic ${Buffer.from(PROXY_USERINFO).toString("base64")}`,
    },
    body,
  });

  assert.equal(anthropic.seen.length, 1);
  const seen = anthropic.seen[0]!;
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/messages?beta=true");
  assert.equal(seen.headers.host, ANTHROPIC_HOST);
  assert.equal(seen.servername, ANTHROPIC_HOST);
  assert.equal(seen.headers.authorization, `Bearer ${CLAUDE_ACCESS}`);
  assert.equal(seen.headers["anthropic-beta"], "oauth-2025-04-20,x");
  assert.equal(seen.headers["x-api-key"], undefined);
  assert.equal(seen.headers["x-client-hop"], undefined);
  assert.equal(seen.headers["proxy-authorization"], undefined);
  assert.deepEqual(seen.body, Buffer.from(body));
  const secret = token.split(".")[2]!;
  assert.ok(!seen.rawHeaders.some((value) => value.includes(secret)));

  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString("utf8"), '{"id":"msg_fixture"}');
  assert.equal(reply.headers["content-type"], "application/json");
  assert.equal(reply.headers["x-upstream"], "kept");
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(reply.headers["x-upstream-hop"], undefined);
  return [token];
}

/** A Codex responses request: chunked SSE without a content type. */
async function codexForward(
  gw: RunningGateway,
  files: TokenFiles,
): Promise<string[]> {
  const { token } = grant(gw, "openai-codex", files.codexFile);
  chatgpt.handler = async (_req, res) => {
    res.writeHead(200, { "set-cookie": "__cf_bm=fixture" });
    res.write("event: response.created\ndata: {}\n\n");
    await delay(20);
    res.end("event: response.completed\ndata: {}\n\n");
  };
  const reply = await send(gw.port, {
    path: CODEX_PATH,
    headers: {
      ...bearer(token),
      "chatgpt-account-id": "pandeck-gateway",
      "content-type": "application/json",
    },
    body: JSON.stringify({ input: BODY_SENTINEL }),
  });

  assert.equal(chatgpt.seen.length, 1);
  const seen = chatgpt.seen[0]!;
  assert.equal(seen.url, "/backend-api/codex/responses");
  assert.equal(seen.headers.host, CHATGPT_HOST);
  assert.equal(seen.servername, CHATGPT_HOST);
  assert.equal(seen.headers.authorization, `Bearer ${CODEX_ACCESS}`);
  const accountIds = seen.rawHeaders.filter(
    (_value, i) =>
      i % 2 === 1 &&
      seen.rawHeaders[i - 1]!.toLowerCase() === "chatgpt-account-id",
  );
  assert.deepEqual(accountIds, [CODEX_ACCOUNT]);

  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-type"], undefined);
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(
    reply.body.toString("utf8"),
    "event: response.created\ndata: {}\n\nevent: response.completed\ndata: {}\n\n",
  );
  return [token];
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Every malformed, unknown, forged and revoked lease is refused locally. */
async function leaseRefusals(
  gw: RunningGateway,
  files: TokenFiles,
): Promise<string[]> {
  const tokens: string[] = [];
  for (const [provider, path, shape, tokenFile] of [
    ["claude", CLAUDE_PATH, "claude", files.claudeFile],
    ["openai-codex", CODEX_PATH, "codex", files.codexFile],
  ] as const) {
    const { leaseId, token } = grant(gw, provider, tokenFile);
    tokens.push(token);
    const [header, payload, secret] = token.split(".") as [
      string,
      string,
      string,
    ];
    const claims = (v: number, lease: string) =>
      base64url({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "pandeck-gateway",
        },
        pandeck: { v, lease },
      });
    const otherFirst = secret[0] === "A" ? "B" : "A";
    const unknown = refusalText({ case: "unknown-lease" });
    const cases: [string, string | undefined, string][] = [
      ["no authorization", undefined, unknown],
      ["a bare word", "x", unknown],
      ["two segments", `${header}.${payload}`, unknown],
      ["a non-base64url segment", `${header}.${payload}.${secret}+`, unknown],
      [
        "a non-JSON payload",
        `${header}.${Buffer.from("not json").toString("base64url")}.${secret}`,
        unknown,
      ],
      ["version 2", `${header}.${claims(2, leaseId)}.${secret}`, unknown],
      ["a 5 KiB bearer", `${header}.${payload}.${"A".repeat(5120)}`, unknown],
      [
        "an unknown lease id",
        `${header}.${claims(1, "unknown-lease-id")}.${secret}`,
        unknown,
      ],
      [
        "a forged secret",
        `${header}.${payload}.${otherFirst}${secret.slice(1)}`,
        unknown,
      ],
    ];
    for (const reason of [
      "profile-removed",
      "account-switch",
      "session-ended",
    ] as const) {
      const revoked = grant(gw, provider, tokenFile);
      tokens.push(revoked.token);
      gw.leases.revoke(revoked.leaseId, reason);
      cases.push([
        `revoked: ${reason}`,
        revoked.token,
        refusalText({ case: "revoked-lease", reason }),
      ]);
    }
    for (const [name, value, text] of cases) {
      const reply = await send(gw.port, {
        path,
        headers:
          value === undefined ? {} : { authorization: `Bearer ${value}` },
        body: BODY_SENTINEL,
      });
      assert.equal(reply.status, 401, name);
      assert.equal(
        refusalMessage(reply, shape, "authentication_error"),
        text,
        name,
      );
    }
  }
  assert.equal(upstreamRequests(), 0);
  return tokens;
}

/** Upstream unreachable, and token files that give no credential. */
async function localFailures(files: TokenFiles): Promise<string[]> {
  const tokens: string[] = [];
  const closed = net.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  const unreachable = await gateway(closedPort);
  const lease = grant(unreachable, "claude", files.claudeFile);
  tokens.push(lease.token);
  const reply = await send(unreachable.port, {
    path: CLAUDE_PATH,
    headers: bearer(lease.token),
    body: BODY_SENTINEL,
  });
  assert.equal(reply.status, 502);
  assert.equal(
    refusalMessage(reply, "claude", "api_error"),
    "Pandeck gateway: Anthropic could not be reached: ECONNREFUSED.",
  );

  const gw = await gateway();
  const root = await mkdtemp(join(DATA_DIR, "gateway-broken-"));
  const notJson = join(root, "not-json.json");
  await writeFile(notJson, "{ not json");
  const noAccess = join(root, "no-access.json");
  await writeFile(
    noAccess,
    JSON.stringify({ claudeAiOauth: { refreshToken: "fake-claude-refresh" } }),
  );
  const noAccount = join(root, "no-account.json");
  await writeFile(
    noAccount,
    JSON.stringify({ "openai-codex": { access: CODEX_ACCESS } }),
  );
  for (const [provider, tokenFile, problem] of [
    ["claude", join(root, "missing.json"), "missing"],
    ["claude", notJson, "malformed"],
    ["claude", noAccess, "malformed"],
    ["openai-codex", noAccount, "malformed"],
  ] as const) {
    const { token } = grant(gw, provider, tokenFile);
    tokens.push(token);
    const codex = provider === "openai-codex";
    const failed = await send(gw.port, {
      path: codex ? CODEX_PATH : CLAUDE_PATH,
      headers: bearer(token),
      body: BODY_SENTINEL,
    });
    assert.equal(failed.status, 503, tokenFile);
    assert.equal(
      refusalMessage(failed, codex ? "codex" : "claude", "api_error"),
      `Pandeck gateway: the credential for this session's account could not be read (${problem}).`,
    );
  }
  assert.equal(upstreamRequests(), 0);
  return tokens;
}

test("a Claude request goes upstream with the profile's credential and nothing else replaced", async () => {
  await claudeForward(await gateway(), await tokenFiles());
});

test("a Codex request gets exactly the profile's account id, and its cookies stay upstream", async () => {
  await codexForward(await gateway(), await tokenFiles());
});

test("SSE reaches the client as the upstream writes it", async () => {
  const gw = await gateway();
  const { token } = grant(gw, "claude", (await tokenFiles()).claudeFile);
  let release!: () => void;
  const clientHasEventOne = new Promise<void>((resolve) => (release = resolve));
  let eventTwoWritten = false;
  let released: boolean | undefined;
  anthropic.handler = async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: one\ndata: 1\n\n");
    const timeout = new AbortController();
    released = await Promise.race([
      clientHasEventOne.then(() => true),
      delay(5_000, false, { signal: timeout.signal }).catch(() => false),
    ]);
    timeout.abort();
    eventTwoWritten = true;
    res.end("event: two\ndata: 2\n\n");
  };
  const { response } = await open(gw.port, {
    path: CLAUDE_PATH,
    headers: bearer(token),
    body: "{}",
  });
  let text = "";
  let eventTwoWrittenAtEventOne: boolean | undefined;
  for await (const chunk of response) {
    text += (chunk as Buffer).toString("utf8");
    if (eventTwoWrittenAtEventOne === undefined && text.includes("data: 1")) {
      eventTwoWrittenAtEventOne = eventTwoWritten;
      release();
    }
  }
  assert.equal(eventTwoWrittenAtEventOne, false);
  assert.equal(released, true, "the client got event 1 within 5 s");
  assert.equal(text, "event: one\ndata: 1\n\nevent: two\ndata: 2\n\n");
});

const STALL_CHUNK = 64 * 1024;
const STALL_TOTAL = 64 * 1024 * 1024;

interface StallUpstream {
  written: number;
  hash: Hash;
}

/** An SSE upstream that honours its own `drain`, counting what it wrote. */
function stallUpstream(state: StallUpstream): Handler {
  const base = randomBytes(STALL_CHUNK);
  return async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    while (state.written < STALL_TOTAL && !res.destroyed) {
      const chunk = Buffer.from(base);
      chunk.writeUInt32BE(state.written / STALL_CHUNK, 0);
      state.hash.update(chunk);
      state.written += chunk.length;
      if (!res.write(chunk))
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.on("drain", done);
          res.on("close", done);
        });
    }
    res.end();
  };
}

/**
 * Pauses the client right after headers and watches the upstream: STALL when
 * its `written` count is unchanged for 1 s before it wrote everything.
 */
async function measureStall(
  port: number,
  token: string,
): Promise<Opened & { state: StallUpstream; stalled: boolean }> {
  const state: StallUpstream = { written: 0, hash: createHash("sha256") };
  anthropic.handler = stallUpstream(state);
  const opened = await open(port, {
    path: CLAUDE_PATH,
    headers: bearer(token),
    body: "{}",
  });
  opened.response.pause();
  const started = Date.now();
  let last = state.written;
  let unchangedSince = Date.now();
  while (Date.now() - started < 15_000) {
    await delay(100);
    if (state.written >= STALL_TOTAL)
      return { ...opened, state, stalled: false };
    if (state.written !== last) {
      last = state.written;
      unchangedSince = Date.now();
    } else if (Date.now() - unchangedSince >= 1_000)
      return { ...opened, state, stalled: true };
  }
  return { ...opened, state, stalled: false };
}

test(
  "a client that stops reading holds the upstream back",
  { timeout: 90_000 },
  async () => {
    const gw = await gateway();
    const { token } = grant(gw, "claude", (await tokenFiles()).claudeFile);

    // (a) The gateway: the upstream stalls while the client is paused, then
    // everything arrives once it reads again.
    const run = await measureStall(gw.port, token);
    assert.equal(
      run.stalled,
      true,
      `the upstream wrote ${run.state.written} B`,
    );
    assert.ok(run.state.written <= 32 * 1024 * 1024, `${run.state.written} B`);
    const received = createHash("sha256");
    let bytes = 0;
    run.response.on("data", (chunk: Buffer) => {
      received.update(chunk);
      bytes += chunk.length;
    });
    run.response.resume();
    await new Promise<void>((resolve, reject) => {
      run.response.once("end", resolve);
      run.response.once("error", reject);
    });
    assert.equal(bytes, STALL_TOTAL);
    assert.equal(received.digest("hex"), run.state.hash.digest("hex"));

    // (b) The control: a forwarder that ignores `write()`'s result. The upstream
    // must run to the end while the client is paused, or the oracle above shows
    // nothing.
    const control = http.createServer((req, res) => {
      const upstreamReq = https.request(
        {
          host: "127.0.0.1",
          port: anthropic.port,
          servername: ANTHROPIC_HOST,
          method: req.method,
          path: "/v1/messages",
          headers: { host: ANTHROPIC_HOST },
          ca: ca.certPem,
          agent: false,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.on("data", (chunk: Buffer) => res.write(chunk));
          upstreamRes.on("end", () => res.end());
          upstreamRes.on("error", () => res.destroy());
        },
      );
      upstreamReq.on("error", () => res.destroy());
      req.pipe(upstreamReq);
    });
    await new Promise<void>((resolve) =>
      control.listen(0, "127.0.0.1", resolve),
    );
    try {
      const controlRun = await measureStall(
        (control.address() as net.AddressInfo).port,
        token,
      );
      assert.equal(controlRun.stalled, false);
      assert.equal(controlRun.state.written, STALL_TOTAL);
      controlRun.request.destroy();
    } finally {
      control.closeAllConnections();
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
  },
);

test("a compressed body reaches the upstream byte for byte", async () => {
  const gw = await gateway();
  const { token } = grant(gw, "openai-codex", (await tokenFiles()).codexFile);
  const body = gzipSync(randomBytes(200 * 1024));
  const reply = await send(gw.port, {
    path: CODEX_PATH,
    headers: {
      ...bearer(token),
      "content-encoding": "gzip",
      "content-type": "application/json",
    },
    body,
  });
  assert.equal(reply.status, 200);
  const seen = chatgpt.seen[0]!;
  assert.equal(seen.headers["content-encoding"], "gzip");
  assert.equal(
    createHash("sha256").update(seen.body).digest("hex"),
    createHash("sha256").update(body).digest("hex"),
  );
});

test("a client closing an endless stream cancels the upstream and is no error", async () => {
  const gw = await gateway();
  const { token } = grant(gw, "claude", (await tokenFiles()).claudeFile);
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
  anthropic.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const timer = setInterval(() => res.write("data: tick\n\n"), 20);
    res.on("close", () => {
      clearInterval(timer);
      upstreamClosed();
    });
  };
  const { request, response } = await open(gw.port, {
    path: CLAUDE_PATH,
    headers: bearer(token),
    body: "{}",
  });
  response.on("error", () => {});
  await new Promise<void>((resolve) => response.once("data", () => resolve()));
  request.destroy();
  const timeout = new AbortController();
  await Promise.race([
    closed,
    delay(2_000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error("the upstream request stayed open for 2 s");
    }),
  ]);
  timeout.abort();
  await delay(50);
  assert.equal(gw.stats.clientClosed, 1);
  assert.equal(gw.stats.upstreamErrors, 0);
  assert.ok(logLines.some((line) => line.includes("client closed")));
  assert.ok(!logLines.some((line) => /upstream error|unreachable/.test(line)));
});

test("an upstream abort mid-stream reaches the client as a failure, not an end", async () => {
  const gw = await gateway();
  const { token } = grant(gw, "claude", (await tokenFiles()).claudeFile);
  anthropic.handler = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    setTimeout(() => res.socket?.destroy(), 50);
  };
  const { response } = await open(gw.port, {
    path: CLAUDE_PATH,
    headers: bearer(token),
    body: "{}",
  });
  let text = "";
  let ended = false;
  response.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  response.on("end", () => (ended = true));
  response.on("error", () => {});
  await new Promise<void>((resolve) => response.once("close", resolve));
  assert.equal(text, "data: 1\n\n");
  assert.equal(ended, false);
  assert.equal(response.complete, false);
  assert.ok(
    logLines.some((line) => line.includes("upstream error after headers")),
  );
});

test("a missing, malformed, unknown, forged or revoked lease never reaches upstream", async () => {
  await leaseRefusals(await gateway(), await tokenFiles());
});

test("a lease covers only its own provider's allowlisted route", async () => {
  const gw = await gateway();
  const files = await tokenFiles();
  const claude = grant(gw, "claude", files.claudeFile).token;
  const codex = grant(gw, "openai-codex", files.codexFile).token;
  const forbidden = refusalText({ case: "forbidden" });
  for (const [method, path, token, status, shape, text] of [
    ["POST", CODEX_PATH, claude, 403, "codex", forbidden],
    ["POST", CLAUDE_PATH, codex, 403, "claude", forbidden],
    ["GET", CLAUDE_PATH, claude, 403, "claude", forbidden],
    ["POST", "/anthropic/v1/models", claude, 403, "claude", forbidden],
    ["POST", "/anthropic/v1/messages/../x", claude, 403, "claude", forbidden],
    ["POST", "/anthropic/v1/messagesX", claude, 403, "claude", forbidden],
    [
      "POST",
      "/other/v1/messages",
      claude,
      404,
      "claude",
      refusalText({ case: "unknown-prefix" }),
    ],
  ] as const) {
    const reply = await send(gw.port, {
      method,
      path,
      headers: bearer(token),
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(reply.status, status, `${method} ${path}`);
    const type = status === 404 ? "not_found_error" : "permission_error";
    assert.equal(refusalMessage(reply, shape, type), text, `${method} ${path}`);
  }
  assert.equal(upstreamRequests(), 0);
});

test("a WebSocket upgrade is refused without contacting upstream", async () => {
  const gw = await gateway();
  const { token } = grant(gw, "openai-codex", (await tokenFiles()).codexFile);
  const { response } = await open(gw.port, {
    method: "GET",
    path: CODEX_PATH,
    headers: {
      ...bearer(token),
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    },
  });
  const socketClosed = new Promise<void>((resolve) =>
    response.socket.once("close", () => resolve()),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  const reply = {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks),
  };
  assert.equal(reply.status, 403);
  assert.equal(
    refusalMessage(reply, "codex", "permission_error"),
    refusalText({ case: "websocket" }),
  );
  await socketClosed;
  assert.equal(upstreamRequests(), 0);
});

test("an unreachable upstream or unreadable credential is a local 5xx", async () => {
  await localFailures(await tokenFiles());
});

test("token files are only read, and an upstream 401 passes through untouched", async () => {
  const gw = await gateway();
  const files = await tokenFiles();
  const before = await Promise.all(
    [files.claudeFile, files.codexFile].map(async (file) => ({
      bytes: await readFile(file),
      mtimeMs: (await stat(file)).mtimeMs,
    })),
  );
  await claudeForward(gw, files);
  anthropic.seen = [];
  await codexForward(gw, files);
  const upstream401 =
    '{"type":"error","error":{"type":"authentication_error","message":"invalid x"}}';
  anthropic.handler = (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(upstream401);
  };
  const { token } = grant(gw, "claude", files.claudeFile);
  const reply = await send(gw.port, {
    path: CLAUDE_PATH,
    headers: bearer(token),
    body: "{}",
  });
  assert.equal(reply.status, 401);
  assert.equal(reply.body.toString("utf8"), upstream401);

  const after = await Promise.all(
    [files.claudeFile, files.codexFile].map(async (file) => ({
      bytes: await readFile(file),
      mtimeMs: (await stat(file)).mtimeMs,
    })),
  );
  assert.deepEqual(after, before);
  assert.deepEqual(await readdir(files.claudeDir), [".credentials.json"]);
  assert.deepEqual(await readdir(files.codexDir), ["auth.json"]);
});

test("no log line holds a credential, lease token, query or body", async () => {
  const files = await tokenFiles();
  const gw = await gateway();
  const tokens = [
    ...(await claudeForward(gw, files)),
    ...(await codexForward(gw, files)),
  ];
  anthropic.seen = [];
  chatgpt.seen = [];
  tokens.push(...(await leaseRefusals(gw, files)));
  tokens.push(...(await localFailures(files)));

  const forbidden = [
    CLAUDE_ACCESS,
    CODEX_ACCESS,
    CODEX_ACCOUNT,
    "beta=true",
    BODY_SENTINEL,
    ...tokens,
    ...tokens.map((token) => token.split(".")[2]!),
  ];
  for (const line of logLines)
    for (const value of forbidden)
      assert.ok(!line.includes(value), `a log line holds ${value}: ${line}`);
  for (const refusal of [
    "refused unknown-lease 401",
    "refused revoked-lease (profile-removed) 401",
    "refused revoked-lease (account-switch) 401",
    "refused revoked-lease (session-ended) 401",
    "refused unreachable (ECONNREFUSED) 502",
    "refused credential (missing) 503",
    "refused credential (malformed) 503",
  ])
    assert.ok(
      logLines.some((line) => line.includes(refusal)),
      `no log line names ${refusal}`,
    );
  assert.equal(
    gw.lines.filter((line) => line.startsWith("client user-agent=")).length,
    1,
  );
  assert.ok(
    gw.lines.includes(
      `client user-agent=${JSON.stringify(TEST_CLIENT)} originator=""`,
    ),
  );
});

/** A server lease of this boot, as the link grants one for one-shots and usage. */
function grantServer(
  gw: RunningGateway,
  provider: LeaseProvider,
  tokenFile: string,
): { leaseId: string; token: string } {
  return gw.leases.grant(
    { profileId: `${provider}-work`, provider, tokenFile },
    { kind: "server", owner: { serverBootId: "boot-fixture" } },
  );
}

const WHAM_ROUTES = [
  ["GET", "/backend-api/wham/usage"],
  ["GET", "/backend-api/wham/rate-limit-reset-credits"],
  ["POST", "/backend-api/wham/rate-limit-reset-credits/consume"],
] as const;

test("AC1: only a server lease reaches the wham usage, credits and consume routes", async () => {
  const gw = await gateway();
  const files = await tokenFiles();
  const server = grantServer(gw, "openai-codex", files.codexFile).token;
  const engine = grant(gw, "openai-codex", files.codexFile).token;

  for (const [method, pathname] of WHAM_ROUTES) {
    const reply = await send(gw.port, {
      method,
      path: `/chatgpt${pathname}`,
      headers: { ...bearer(engine), "chatgpt-account-id": "forged" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    assert.equal(reply.status, 403, `${method} ${pathname}`);
    assert.equal(
      refusalMessage(reply, "codex", "permission_error"),
      refusalText({ case: "forbidden" }),
    );
  }
  assert.equal(upstreamRequests(), 0, "an engine lease reaches no wham route");

  for (const [method, pathname] of WHAM_ROUTES) {
    const reply = await send(gw.port, {
      method,
      path: `/chatgpt${pathname}`,
      headers: { ...bearer(server), "chatgpt-account-id": "forged" },
      ...(method === "POST" ? { body: '{"credit_id":"c1"}' } : {}),
    });
    assert.equal(reply.status, 200, `${method} ${pathname}`);
  }
  assert.deepEqual(
    chatgpt.seen.map((seen) => [seen.method, seen.url]),
    WHAM_ROUTES.map(([method, pathname]) => [method, pathname]),
  );
  for (const seen of chatgpt.seen) {
    assert.equal(seen.headers.authorization, `Bearer ${CODEX_ACCESS}`);
    assert.equal(seen.headers["chatgpt-account-id"], CODEX_ACCOUNT);
  }
});

test("AC2: a server lease's extra routes match exactly and only its provider's", async () => {
  const gw = await gateway();
  const files = await tokenFiles();
  const codex = grantServer(gw, "openai-codex", files.codexFile).token;
  const claude = grantServer(gw, "claude", files.claudeFile).token;
  const forbidden = refusalText({ case: "forbidden" });
  for (const [method, path, token, shape] of [
    ["GET", "/chatgpt/backend-api/wham/usage/../x", codex, "codex"],
    ["GET", "/chatgpt/backend-api/wham/usageX", codex, "codex"],
    ["POST", "/chatgpt/backend-api/wham/usage", codex, "codex"],
    [
      "GET",
      "/chatgpt/backend-api/wham/rate-limit-reset-credits/consume",
      codex,
      "codex",
    ],
    [
      "PUT",
      "/chatgpt/backend-api/wham/rate-limit-reset-credits/consume",
      codex,
      "codex",
    ],
    ["GET", "/chatgpt/backend-api/wham/usage", claude, "codex"],
    [
      "POST",
      "/chatgpt/backend-api/wham/rate-limit-reset-credits/consume",
      claude,
      "codex",
    ],
    ["GET", "/anthropic/backend-api/wham/usage", claude, "claude"],
  ] as const) {
    const reply = await send(gw.port, {
      method,
      path,
      headers: bearer(token),
      ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}),
    });
    assert.equal(reply.status, 403, `${method} ${path}`);
    assert.equal(
      refusalMessage(reply, shape, "permission_error"),
      forbidden,
      `${method} ${path}`,
    );
  }
  assert.equal(upstreamRequests(), 0);

  // The model routes stay open to a server lease, as to an engine's.
  const codexModel = await send(gw.port, {
    path: CODEX_PATH,
    headers: bearer(codex),
    body: "{}",
  });
  assert.equal(codexModel.status, 200);
  const claudeModel = await send(gw.port, {
    path: CLAUDE_PATH,
    headers: bearer(claude),
    body: "{}",
  });
  assert.equal(claudeModel.status, 200);
  assert.deepEqual(
    [...chatgpt.seen, ...anthropic.seen].map((seen) => [seen.method, seen.url]),
    [
      ["POST", "/backend-api/codex/responses"],
      ["POST", "/v1/messages"],
    ],
  );
});
