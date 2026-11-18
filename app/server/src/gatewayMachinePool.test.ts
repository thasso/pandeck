/**
 * Machine pools end to end (Task-1424 PR 1, plan v03 with amendments A1-A3):
 * a standalone harness on an enrolled machine sends the public placeholder,
 * another bearer or none to its relay (`relay/relay.ts`), and the edge
 * (`gateway/clientListener.ts`, `gateway/forward.ts`) serves it on an account
 * of the client's user picked and pinned by `gateway/machinePool.ts`, against
 * fake Anthropic and ChatGPT upstreams. A fake clock moves benches; a gated
 * Codex renewal holds a request's credential wait. Fake token files and a
 * temp `HOME`; every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import type { GatewayOptions, RunningGateway } from "./gateway/gateway.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-machine-home-"));
process.env.HOME = home;

const { startGateway } = await import("./gateway/gateway.ts");
const { isLeaseShaped } = await import("./gateway/leases.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { DATA_DIR } = await import("./config.ts");
const { fakeProcesses, startFakeUpstreams } =
  await import("./test/gatewayFixtures.ts");

/**
 * The documented placeholder (`docs/workers.md` "Standalone harnesses"): a
 * JWT-shaped string a harness accepts as its key. It grants nothing: the
 * capability is the relay's client certificate.
 */
const PLACEHOLDER =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck";

type Provider = "claude" | "openai-codex";
const MIN = 60_000;
const PATH: Record<Provider, string> = {
  claude: "/anthropic/v1/messages",
  "openai-codex": "/chatgpt/backend-api/codex/responses",
};
const KEY_HEADER: Record<Provider, string> = {
  claude: "x-claude-code-session-id",
  "openai-codex": "session-id",
};
const MARKER = "Pandeck gateway:";
const NEEDS_LOGIN_TEXT = "needs a new login";

const access = (id: string): string => `fake-${id}-access`;
const renewed = (id: string): string => `fake-${id}-renewed`;
const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
/** The header value a harness session named `name` sends. */
const sessionKey = (name: string): string => `harness-session-${name}-4f1c`;
/** The pin file's hash for that session. */
const pinHash = (name: string): string => sha256(sessionKey(name));

// --- fake clock, upstream answers and the Codex renewal port -------------

let clock = Date.now();
const now = (): number => clock;

/** One planned upstream answer for an access token; 200 when none is left. */
interface Answer {
  status: number;
  headers?: Record<string, string | string[]>;
  /** Answers only once this settles. */
  hold?: Promise<void>;
}
const answers = new Map<string, Answer[]>();
/** Every account's access tokens, for naming who an upstream request spent. */
const owners = new Map<string, string>();

function plan(id: string, ...planned: Answer[]): void {
  for (const token of [access(id), renewed(id)])
    answers.set(token, [...(answers.get(token) ?? []), ...planned]);
}

const respond = (
  seen: { headers: http.IncomingHttpHeaders },
  res: http.ServerResponse,
): void => {
  const token = String(seen.headers.authorization ?? "").replace(
    /^Bearer /,
    "",
  );
  const next = answers.get(token)?.shift();
  const answer = (): void => {
    res.writeHead(next?.status ?? 200, {
      "content-type": "application/json",
      ...next?.headers,
    });
    res.end(
      next && next.status !== 200
        ? '{"type":"error","error":{"type":"rate_limit_error","message":"fixture limit"}}'
        : '{"ok":true}',
    );
  };
  if (next?.hold) void next.hold.then(answer);
  else answer();
};

interface Gate {
  entered: Promise<void>;
  release: () => void;
}
/** Codex renewals held per token file; others renew at once. */
const gates = new Map<
  string,
  Gate & { enter: () => void; open: Promise<void> }
>();
/** Token files the renewal port was called for, in order. */
let renewCalls: string[] = [];
/** What the next renewal of a file does instead of renewing. */
const renewRejected = new Set<string>();

function gate(file: string): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const open = new Promise<void>((resolve) => (release = resolve));
  gates.set(file, { entered, enter, open, release });
  return { entered, release };
}

const renewCodex: NonNullable<GatewayOptions["renewCodex"]> = async (file) => {
  renewCalls.push(file);
  const held = gates.get(file);
  if (held) {
    held.enter();
    await held.open;
    gates.delete(file);
  }
  if (renewRejected.has(file))
    return { ok: false, kind: "rejected", code: "400" };
  const id = [...accountFiles].find(([, f]) => f === file)?.[0];
  writeToken("openai-codex", file, renewed(id ?? "unknown"), clock + 600 * MIN);
  return { ok: true };
};

// --- fixtures ------------------------------------------------------------

let upstreams: Awaited<ReturnType<typeof startFakeUpstreams>>;
const open: { close(): unknown }[] = [];
let lines: string[] = [];
const accountFiles = new Map<string, string>();

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: respond,
    mcp: respond,
    codex: respond,
  });
});

afterEach(async () => {
  // R3: no structured record holds a secret either, nor a query or body.
  const records = started.flatMap((rig) =>
    rig.users.flatMap(
      (user) => rig.gw.requests?.since(user, undefined, 0, 5000).records ?? [],
    ),
  );
  started.length = 0;
  while (open.length) await open.pop()!.close();
  // AC11: no log line holds the placeholder, a token or a session key.
  const logged = lines;
  const keys = [...usedKeys];
  upstreams.reset();
  answers.clear();
  gates.clear();
  renewCalls = [];
  renewRejected.clear();
  usedKeys.clear();
  lines = [];
  const recorded = JSON.stringify(records);
  for (const text of [PLACEHOLDER, "SENTINEL", ...owners.keys()])
    assert.ok(!recorded.includes(text), `a record holds ${text.slice(0, 12)}`);
  for (const key of keys)
    assert.ok(!recorded.includes(key) && !recorded.includes(sha256(key)));
  for (const line of logged) {
    assert.ok(!line.includes(PLACEHOLDER), `placeholder logged: ${line}`);
    assert.ok(!line.includes("SENTINEL"), `a query or body logged: ${line}`);
    for (const token of owners.keys())
      assert.ok(!line.includes(token), `a token is logged: ${line}`);
    for (const key of keys)
      assert.ok(
        !line.includes(key) && !line.includes(sha256(key)),
        `a session key is logged: ${line}`,
      );
  }
});

afterAll(async () => {
  await upstreams.close();
  rmSync(home, { recursive: true, force: true });
});

function writeToken(
  provider: Provider,
  file: string,
  token: string,
  expires: number,
): void {
  writeFileSync(
    file,
    JSON.stringify(
      provider === "claude"
        ? {
            claudeAiOauth: {
              accessToken: token,
              refreshToken: `${token}-refresh`,
              expiresAt: expires,
            },
          }
        : {
            "openai-codex": {
              type: "oauth",
              access: token,
              refresh: `${token}-refresh`,
              accountId: `acct-${token}`,
              expires,
            },
          },
    ),
  );
}

const usedKeys = new Set<string>();

interface Reply {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
  /** The account whose credential the upstream received, if one did. */
  account: string | undefined;
}

/** One HTTP request to a relay's loopback port. */
function rawRequest(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string | string[]>;
  } = {},
): Promise<{
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "POST",
        agent: false,
        headers: { "content-type": "application/json", ...options.headers },
      },
      (response) => {
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
      },
    );
    request.on("error", reject);
    request.end(options.method === "GET" ? undefined : '{"model":"fixture"}');
  });
}

/**
 * One HTTP request to a relay's loopback port with its header fields sent
 * exactly as given, repeats and `Host` included, answering the response's
 * raw header fields.
 */
function relayRaw(
  machine: Machine,
  path: string,
  rawHeaders: string[],
): Promise<{ status: number; text: string; rawHeaders: string[] }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: machine.relay.port,
        path,
        method: "POST",
        agent: false,
        headers: [...rawHeaders, "content-type", "application/json"],
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            rawHeaders: response.rawHeaders,
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end('{"model":"fixture"}');
  });
}

/** The values of every raw field named `name`, in order. */
function fields(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === name) values.push(rawHeaders[i + 1]!);
  return values;
}

/**
 * A request straight to the edge's model port with the relay's client
 * certificate, its headers sent exactly as given (repeats and `Host`
 * included): the edge's own checks without the relay in between.
 */
function edgeRequest(
  rig: Rig,
  machine: Machine,
  path: string,
  rawHeaders: string[],
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const file = (name: string): string =>
      readFileSync(join(machine.dir, name), "utf8");
    const request = https.request({
      host: "127.0.0.1",
      port: rig.edge.modelPort,
      servername: "localhost",
      key: file("client-key.pem"),
      cert: file("client-cert.pem"),
      ca: file("gateway-ca.pem"),
      path,
      method: "POST",
      agent: false,
      headers: [
        ...rawHeaders,
        "authorization",
        `Bearer ${PLACEHOLDER}`,
        "content-type",
        "application/json",
      ],
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.end('{"model":"fixture"}');
  });
}

/**
 * A free port below the kernel's ephemeral range (Linux starts it at
 * 32768): a restart binds its edge ports again, and a parallel test's
 * `listen(0)` cannot take one of these in between.
 */
let nextPort = 20_000 + Math.floor(Math.random() * 10_000);
async function stablePort(): Promise<number> {
  for (;;) {
    const port = nextPort;
    nextPort = nextPort + 1 >= 32_000 ? 20_000 : nextPort + 1;
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
}

function startMachineRelay(
  dir: string,
  port: number,
): ReturnType<typeof startRelay> {
  return startRelay({
    stateDir: dir,
    port,
    socketPath: join(dir, "relay.sock"),
    log: () => {},
  });
}

interface Machine {
  relay: Awaited<ReturnType<typeof startRelay>>;
  clientId: string;
  dir: string;
}

interface SendOptions {
  /** The session key; undefined sends none. */
  key?: string | undefined;
  machine?: Machine;
  /** The bearer; null sends no `authorization`. */
  bearer?: string | null;
  headers?: Record<string, string | string[]>;
  path?: string;
  method?: string;
}

/** The rigs this test started, for the records check after it. */
const started: Rig[] = [];

/** A gateway edge with fake upstreams, its users, accounts and relays. */
class Rig {
  gw!: RunningGateway;
  users: string[] = [];
  readonly stateDir = mkdtempSync(join(DATA_DIR, "machine-edge-"));
  machines: Machine[] = [];
  private ports: { modelPort: number; clientPort: number; enrollPort: number } =
    { modelPort: 0, clientPort: 0, enrollPort: 0 };

  static async start(users: string[] = ["thasso"]): Promise<Rig> {
    const rig = new Rig();
    rig.ports = {
      modelPort: await stablePort(),
      clientPort: await stablePort(),
      enrollPort: await stablePort(),
    };
    await rig.boot();
    for (const user of users) rig.edge.registry.addUser(user);
    rig.users = users;
    started.push(rig);
    open.push({ close: () => rig.gw.close() });
    return rig;
  }

  get edge(): NonNullable<RunningGateway["clients"]> {
    return this.gw.clients!;
  }

  private async boot(): Promise<void> {
    this.gw = await startGateway({
      stateDir: this.stateDir,
      upstreams: upstreams.overrides,
      claudeTokenEndpoint: upstreams.tokenEndpoint,
      renewCodex,
      processProbe: fakeProcesses().probe,
      log: (line) => lines.push(line),
      now,
      clients: this.ports,
    });
    const edge = this.edge;
    this.ports = {
      modelPort: edge.modelPort,
      clientPort: edge.clientPort,
      enrollPort: edge.enrollPort,
    };
  }

  /**
   * Closes the edge and starts it again on the same state and ports. Each
   * relay starts again too, on its own state and port, so no request rides
   * a pooled connection to the closed edge: these tests are about the
   * edge's state, not the relay's keep-alive pool.
   */
  async restart(): Promise<void> {
    for (const machine of this.machines) await machine.relay.close();
    await this.gw.close();
    await this.boot();
    for (const machine of this.machines)
      machine.relay = await startMachineRelay(machine.dir, machine.relay.port);
  }

  /** A login account of `userId` with a fresh fake token. */
  account(
    id: string,
    provider: Provider,
    userId = "thasso",
    options: { enabled?: boolean } = {},
  ): string {
    const dir = mkdtempSync(join(DATA_DIR, "machine-acct-"));
    const file = join(
      dir,
      provider === "claude" ? ".credentials.json" : "auth.json",
    );
    writeToken(provider, file, access(id), clock + 30 * 24 * 60 * MIN);
    accountFiles.set(id, file);
    owners.set(access(id), id);
    owners.set(renewed(id), id);
    this.edge.putAccount({
      id,
      provider,
      name: `Account ${id}`,
      enabled: options.enabled ?? true,
      tokenFile: file,
      userId,
    });
    return file;
  }

  setEnabled(id: string, provider: Provider, enabled: boolean): void {
    const userId = this.edge.registry.ownerOf(id)!;
    this.edge.putAccount({
      id,
      provider,
      name: `Account ${id}`,
      enabled,
      tokenFile: accountFiles.get(id)!,
      userId,
    });
  }

  /**
   * Enrolls a relay for `userId` and starts it; `host` is the gateway address
   * it enrolls with, an IP or a DNS name the edge's certificate holds.
   */
  async machine(
    userId = "thasso",
    label = "devbox",
    host = "127.0.0.1",
  ): Promise<Machine> {
    const dir = mkdtempSync(join(tmpdir(), "machine-relay-"));
    const before = new Set(this.edge.registry.clients().map((c) => c.id));
    await enrollRelay({
      stateDir: dir,
      host,
      enrollPort: this.edge.enrollPort,
      caPem: this.edge.caPem,
      code: this.edge.registry.createCode(userId, label),
    });
    const relay = await startMachineRelay(dir, await stablePort());
    open.push({ close: () => rmSync(dir, { recursive: true, force: true }) });
    const clientId = this.edge.registry
      .clients()
      .find((c) => !before.has(c.id))!.id;
    const machine = { relay, clientId, dir };
    open.push({ close: () => machine.relay.close() });
    this.machines.push(machine);
    return machine;
  }

  /** A harness request through a relay; names the account it reached. */
  async send(provider: Provider, options: SendOptions = {}): Promise<Reply> {
    const machine = options.machine ?? this.machines[0]!;
    const seen =
      provider === "claude" ? upstreams.anthropic : upstreams.chatgpt;
    const before = seen.length;
    const headers: Record<string, string | string[]> = {
      ...options.headers,
    };
    if (options.bearer !== null)
      headers.authorization = `Bearer ${options.bearer ?? PLACEHOLDER}`;
    if (options.key !== undefined) {
      usedKeys.add(sessionKey(options.key));
      headers[KEY_HEADER[provider]] = sessionKey(options.key);
    }
    const reply = await rawRequest(
      machine.relay.port,
      options.path ?? PATH[provider],
      {
        headers,
        ...(options.method ? { method: options.method } : {}),
      },
    );
    const reached = seen.slice(before);
    assert.ok(reached.length <= 1, "one request reaches one upstream");
    const token = String(reached[0]?.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    return { ...reply, account: reached[0] ? owners.get(token) : undefined };
  }

  /** The saved pins, as `machinePins.json` holds them. */
  pins(): {
    clientId: string;
    provider: string;
    keyHash: string | null;
    profileId: string;
    tried: string[];
  }[] {
    const file = join(this.stateDir, "machinePins.json");
    if (!existsSync(file)) return [];
    return (JSON.parse(readFileSync(file, "utf8")) as { pins: [] }).pins;
  }

  pinsText(): string {
    return readFileSync(join(this.stateDir, "machinePins.json"), "utf8");
  }

  machineLeases(): { leaseId: string; profileId: string; revoked?: string }[] {
    return this.gw.leases
      .records()
      .filter((record) => record.kind === "machine");
  }
}

/** A user with Claude accounts `a` and `b` and one relay. */
async function claudePair(): Promise<Rig> {
  const rig = await Rig.start();
  rig.account("a", "claude");
  rig.account("b", "claude");
  await rig.machine();
  return rig;
}

const long429: Answer = { status: 429, headers: { "retry-after": "120" } };
/** Anthropic's statement that a request hit a subscription limit. */
const REJECTED = { "anthropic-ratelimit-unified-status": "rejected" } as const;

// --- the placeholder ------------------------------------------------------

test("D4: the placeholder decodes to the documented payload and is not lease-shaped", () => {
  const [header, payload, signature] = PLACEHOLDER.split(".");
  const decode = (segment: string): unknown =>
    JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  assert.deepEqual(decode(header!), { alg: "none", typ: "JWT" });
  assert.deepEqual(decode(payload!), {
    "https://api.openai.com/auth": { chatgpt_account_id: "pandeck-gateway" },
    pandeck: { v: 1, machine: true },
  });
  assert.ok(signature!.length > 0);
  assert.equal(isLeaseShaped(PLACEHOLDER), false);
  assert.equal(isLeaseShaped(undefined), false);
  assert.equal(isLeaseShaped("sk-other"), false);
  const lease = Buffer.from(
    JSON.stringify({ pandeck: { v: 1, lease: "lease-1" } }),
  ).toString("base64url");
  assert.equal(isLeaseShaped(`${header}.${lease}.c2VjcmV0`), true);
});

// --- AC1, AC2, AC11 -------------------------------------------------------

test("AC1, AC2, AC11: placeholder, other bearers and none are served on the user's accounts, logged by kind and client", async () => {
  const rig = await Rig.start();
  rig.account("claude-a", "claude");
  rig.account("codex-a", "openai-codex");
  const { clientId } = await rig.machine();

  for (const bearer of [PLACEHOLDER, "sk-ant-other", null] as const) {
    const reply = await rig.send("claude", { bearer, key: "claude-session" });
    assert.equal(reply.status, 200);
    assert.equal(reply.account, "claude-a");
  }
  // A key in `x-api-key` never reaches the upstream.
  await rig.send("claude", { bearer: null, headers: { "x-api-key": "sk-x" } });
  assert.equal(upstreams.anthropic.at(-1)!.headers["x-api-key"], undefined);

  // pi sends its own `chatgpt-account-id`: it is replaced.
  const codex = await rig.send("openai-codex", {
    key: "codex-session",
    headers: { "chatgpt-account-id": "pi-own-account" },
  });
  assert.equal(codex.status, 200);
  assert.equal(codex.account, "codex-a");
  const seen = upstreams.chatgpt.at(-1)!.headers;
  assert.equal(seen.authorization, `Bearer ${access("codex-a")}`);
  assert.equal(seen["chatgpt-account-id"], `acct-${access("codex-a")}`);

  // No client call granted a lease: every lease is the edge's machine lease.
  const records = rig.gw.leases.records();
  assert.ok(records.length > 0);
  assert.ok(records.every((record) => record.kind === "machine"));
  assert.ok(records.every((record) => record.owner.clientId === clientId));

  // Every forward line on the client port names kind and client.
  const forwards = lines.filter((line) =>
    /^(claude|openai-codex) POST /.test(line),
  );
  assert.equal(forwards.length, 5);
  for (const line of forwards)
    assert.match(line, new RegExp(` kind=machine client=${clientId} lease=`));
});

// --- AC3 ------------------------------------------------------------------

test("AC3, AC5, AC6(d)(g), AC9: lease-shaped bearers keep today's path, and every lease kind's model runs are evidence", async () => {
  const rig = await claudePair();
  const { relay } = rig.machines[0]!;
  const linkLines: string[] = [];
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: (line) => linkLines.push(line),
  });
  open.push(link);
  assert.equal(await link.ready, true);

  // An engine lease forwards on its own profile, not the pool's pick (a).
  const engine = await link.grantEngineLease({
    workerId: undefined,
    profileId: "b",
  });
  owners.set(engine.token, "engine-token");
  const onB = await rig.send("claude", { bearer: engine.token });
  assert.equal(onB.status, 200);
  assert.equal(onB.account, "b");
  // AC9: a lease request carrying `Origin` behaves as today.
  const withOrigin = await rig.send("claude", {
    bearer: engine.token,
    headers: { origin: "https://evil.example" },
  });
  assert.equal(withOrigin.account, "b");

  // A lease-shaped token with a wrong secret is unknown, never the pool's.
  const [h, p] = engine.token.split(".");
  const forged = `${h}.${p}.${Buffer.alloc(32, 7).toString("base64url")}`;
  owners.set(forged, "forged-token");
  const unknown = await rig.send("claude", { bearer: forged });
  assert.equal(unknown.status, 401);
  assert.match(unknown.text, /the gateway does not know this session/);
  assert.equal(unknown.account, undefined);

  // AC5: a server lease's usage 429 creates no bench, and a count_tokens
  // 429 neither: a new session still gets `a`.
  const server = await link.serverAccess("a");
  owners.set(server.leaseToken, "server-token");
  plan("a", { status: 429, headers: { "retry-after": "120" } });
  const usage = await rig.send("claude", {
    bearer: server.leaseToken,
    method: "GET",
    path: "/anthropic/api/oauth/usage",
  });
  assert.equal(usage.status, 429);
  plan("a", long429);
  const count = await rig.send("claude", {
    key: "s-count",
    path: "/anthropic/v1/messages/count_tokens",
  });
  assert.equal(count.status, 429);
  assert.equal((await rig.send("claude", { key: "s-new-1" })).account, "a");

  // A long 429 benches `a`: X moves to `b`, a new session gets `b`.
  plan("a", long429);
  assert.equal((await rig.send("claude", { key: "X" })).status, 429);
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  assert.equal((await rig.send("claude", { key: "s-new-2" })).account, "b");
  // A 200 on a usage GET does not clear the bench.
  assert.equal(
    (
      await rig.send("claude", {
        bearer: server.leaseToken,
        method: "GET",
        path: "/anthropic/api/oauth/usage",
      })
    ).status,
    200,
  );
  assert.equal((await rig.send("claude", { key: "s-new-3" })).account, "b");

  // AC6(d)(g): an engine lease's model-run 2xx on `a` clears its bench; a
  // new session gets `a` again, X stays on `b`.
  const engineA = await link.grantEngineLease({
    workerId: undefined,
    profileId: "a",
  });
  owners.set(engineA.token, "engine-token-a");
  assert.equal(
    (await rig.send("claude", { bearer: engineA.token })).account,
    "a",
  );
  assert.equal((await rig.send("claude", { key: "s-new-4" })).account, "a");
  for (let i = 0; i < 3; i += 1)
    assert.equal((await rig.send("claude", { key: "X" })).account, "b");

  // A revoked engine lease is refused with today's text, never pooled.
  rig.gw.leases.revokeWhere(
    (record) => record.kind === "engine",
    "session-ended",
  );
  const revoked = await rig.send("claude", { bearer: engine.token });
  assert.equal(revoked.status, 401);
  assert.match(revoked.text, /model access ended \(the session ended\)/);
  assert.equal(revoked.account, undefined);

  // Lease lines name their kind too.
  assert.ok(lines.some((line) => / kind=engine client=/.test(line)));
  assert.ok(lines.some((line) => / kind=server client=/.test(line)));
});

// --- AC4 ------------------------------------------------------------------

test("AC4: one session key keeps one account, also across a restart; the pin file holds only hashes", async () => {
  const rig = await claudePair();
  rig.account("codex-a", "openai-codex");
  rig.account("codex-b", "openai-codex");
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  // A short 429 benches `a` briefly: a new session Y pins `b`.
  plan("a", { status: 429, headers: { "retry-after": "30" } });
  assert.equal((await rig.send("claude", { key: "X" })).status, 429);
  assert.equal((await rig.send("claude", { key: "Y" })).account, "b");
  clock += 31_000;
  // Both keep their accounts though `a` ranks first again.
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal((await rig.send("claude", { key: "Y" })).account, "b");
  // No header: one per-client pin, which the first pick decides.
  assert.equal((await rig.send("claude")).account, "a");
  assert.equal((await rig.send("claude")).account, "a");
  // `/chatgpt` keys by `session-id`.
  assert.equal(
    (await rig.send("openai-codex", { key: "X" })).account,
    "codex-a",
  );

  await rig.restart();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal((await rig.send("claude", { key: "Y" })).account, "b");
  assert.equal(
    (await rig.send("openai-codex", { key: "X" })).account,
    "codex-a",
  );

  const pins = rig.pins();
  assert.deepEqual(
    pins.map((pin) => [pin.provider, pin.keyHash, pin.profileId]).sort(),
    [
      ["claude", null, "a"],
      ["claude", pinHash("X"), "a"],
      ["claude", pinHash("Y"), "b"],
      ["openai-codex", pinHash("X"), "codex-a"],
    ].sort(),
  );
  // The raw keys are in no file under the state directory.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
    );
  for (const file of files(rig.stateDir)) {
    const text = readFileSync(file, "utf8");
    for (const key of ["X", "Y"])
      assert.ok(!text.includes(sessionKey(key)), `raw key ${key} in ${file}`);
    assert.ok(!text.includes(PLACEHOLDER));
  }
  assert.equal(
    statSync(join(rig.stateDir, "machinePins.json")).mode & 0o777,
    0o600,
  );
});

// --- AC5, AC6, AC6c -------------------------------------------------------

test("AC5: a long 429 reaches the harness unchanged and benches the account until its reset", async () => {
  const rig = await claudePair();
  plan("a", long429);
  const limited = await rig.send("claude", { key: "X" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["retry-after"], "120");
  assert.match(limited.text, /fixture limit/);
  assert.equal(limited.account, "a");
  assert.equal((await rig.send("claude", { key: "new-1" })).account, "b");
  clock += 121_000;
  assert.equal((await rig.send("claude", { key: "new-2" })).account, "a");
});

test("AC5, AC6c: a short 429 benches briefly and keeps the pin and the pin file", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const before = rig.pinsText();
  plan("a", { status: 429, headers: { "retry-after": "30" } });
  assert.equal((await rig.send("claude", { key: "X" })).status, 429);
  // A new session avoids `a` while the bench lasts; X stays.
  assert.equal((await rig.send("claude", { key: "Y" })).account, "b");
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal(
    JSON.stringify(rig.pins().find((p) => p.keyHash === pinHash("X"))),
    JSON.stringify(
      (JSON.parse(before) as { pins: unknown[] }).pins.find(
        (p) => (p as { keyHash: string }).keyHash === pinHash("X"),
      ),
    ),
  );
});

test.each([
  ["retry-after: 0", { "retry-after": "0" }, "a"],
  ["retry-after: 60", { "retry-after": "60" }, "a"],
  ["retry-after: 61", { "retry-after": "61" }, "b"],
  ["no stated limit (bare)", {}, "a"],
  [
    "a repeated retry-after (raw duplicates) and no stated limit",
    { "retry-after": ["30", "30"] },
    "a",
  ],
  ["a stated limit with no reset", REJECTED, "b"],
  [
    "a stated limit and a repeated retry-after",
    { ...REJECTED, "retry-after": ["30", "30"] },
    "b",
  ],
] as const)(
  "AC6c, A3: after a 429 with %s, X's next request reaches %s",
  async (_name, headers, next) => {
    const rig = await claudePair();
    assert.equal((await rig.send("claude", { key: "X" })).account, "a");
    const before = rig.pins();
    plan("a", {
      status: 429,
      headers: headers as Record<string, string | string[]>,
    });
    assert.equal((await rig.send("claude", { key: "X" })).status, 429);
    if (next === "a")
      assert.deepEqual(rig.pins(), before, "pin file unchanged");
    else
      assert.deepEqual(
        rig.pins().find((p) => p.keyHash === pinHash("X"))?.tried,
        ["a"],
      );
    assert.equal((await rig.send("claude", { key: "X" })).account, next);
  },
);

// --- Task-1428: Anthropic states its limits --------------------------------

/** Anthropic's unified reset `seconds` from the fake clock, in epoch seconds. */
function unifiedResetIn(seconds: number): { header: string; at: number } {
  const epoch = Math.ceil(clock / 1000) + seconds;
  return { header: String(epoch), at: epoch * 1000 };
}

test("Task-1428: a bare 429 on /anthropic passes through unchanged and is no evidence", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const before = rig.pinsText();
  plan("a", { status: 429 });
  const bare = await rig.send("claude", { key: "X" });
  assert.equal(bare.status, 429);
  assert.equal(bare.account, "a");
  assert.match(bare.text, /rate_limit_error/);
  assert.equal(bare.headers["retry-after"], undefined);
  assert.equal(bare.headers["anthropic-ratelimit-unified-status"], undefined);
  // No tried mark, no pin move, no save, no bench.
  assert.equal(rig.pinsText(), before);
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal((await rig.send("claude", { key: "Y" })).account, "a");
});

test("Task-1428: a weekly limit benches its account until the stated reset, not 5 minutes", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const reset = unifiedResetIn(3 * 24 * 3600);
  plan("a", {
    status: 429,
    headers: {
      ...REJECTED,
      "anthropic-ratelimit-unified-reset": reset.header,
    },
  });
  const limited = await rig.send("claude", { key: "X" });
  assert.equal(limited.status, 429);
  assert.equal(
    limited.headers["anthropic-ratelimit-unified-reset"],
    reset.header,
  );
  assert.deepEqual(rig.pins().find((p) => p.keyHash === pinHash("X"))?.tried, [
    "a",
  ]);
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  clock += 6 * MIN;
  assert.equal((await rig.send("claude", { key: "new-1" })).account, "b");
  clock = reset.at - 1000;
  assert.equal((await rig.send("claude", { key: "new-2" })).account, "b");
  clock = reset.at;
  assert.equal((await rig.send("claude", { key: "new-3" })).account, "a");
});

test("Task-1428: the captured weekly-limit answer passes through and moves the session until its reset", async () => {
  // Header set of a signed-in Claude Code weekly limit (Task-1430 evidence,
  // 2026-11-18), with the reset placed relative to the fake clock.
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const retryAfter = 59_120;
  const reset = unifiedResetIn(retryAfter);
  const headers = {
    ...REJECTED,
    "anthropic-ratelimit-unified-reset": reset.header,
    "retry-after": String(retryAfter),
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "x-should-retry": "true",
  };
  plan("a", { status: 429, headers });
  const limited = await rig.send("claude", { key: "X" });
  assert.equal(limited.status, 429);
  for (const [name, value] of Object.entries(headers))
    assert.equal(limited.headers[name], value, name);
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  clock += 6 * MIN;
  assert.equal((await rig.send("claude", { key: "new-1" })).account, "b");
  clock = Math.max(clock, reset.at);
  assert.equal((await rig.send("claude", { key: "new-2" })).account, "a");
});

test("Task-1428: a stated limit 30 s away keeps the pin", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const before = rig.pinsText();
  plan("a", {
    status: 429,
    headers: {
      ...REJECTED,
      "anthropic-ratelimit-unified-reset": unifiedResetIn(30).header,
    },
  });
  assert.equal((await rig.send("claude", { key: "X" })).status, 429);
  assert.equal((await rig.send("claude", { key: "Y" })).account, "b");
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal(
    JSON.stringify(rig.pins().find((p) => p.keyHash === pinHash("X"))),
    JSON.stringify(
      (JSON.parse(before) as { pins: unknown[] }).pins.find(
        (p) => (p as { keyHash: string }).keyHash === pinHash("X"),
      ),
    ),
  );
});

test("Task-1428: on the lease path a bare 429 is no evidence and a weekly limit is", async () => {
  const rig = await claudePair();
  const { relay } = rig.machines[0]!;
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);
  const engine = await link.grantEngineLease({
    workerId: undefined,
    profileId: "a",
  });
  owners.set(engine.token, "engine-token-1428");
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");

  // A bare 429 on an engine lease's model run: nothing benched or moved.
  plan("a", { status: 429 });
  const bare = await rig.send("claude", { bearer: engine.token });
  assert.equal(bare.status, 429);
  assert.equal(bare.account, "a");
  assert.equal((await rig.send("claude", { key: "Y" })).account, "a");
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");

  // A weekly limit on the same lease benches `a` until its reset: X moves.
  const reset = unifiedResetIn(3 * 24 * 3600);
  plan("a", {
    status: 429,
    headers: {
      ...REJECTED,
      "anthropic-ratelimit-unified-reset": reset.header,
    },
  });
  assert.equal(
    (await rig.send("claude", { bearer: engine.token })).status,
    429,
  );
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  clock += 6 * MIN;
  assert.equal((await rig.send("claude", { key: "Z" })).account, "b");
});

test("Task-1428: /chatgpt is unchanged: a 429 with no reset moves the pin", async () => {
  const rig = await Rig.start();
  rig.account("ca", "openai-codex");
  rig.account("cb", "openai-codex");
  await rig.machine();
  assert.equal((await rig.send("openai-codex", { key: "X" })).account, "ca");
  plan("ca", { status: 429 });
  assert.equal((await rig.send("openai-codex", { key: "X" })).status, 429);
  assert.equal((await rig.send("openai-codex", { key: "X" })).account, "cb");
  assert.deepEqual(rig.pins().find((p) => p.keyHash === pinHash("X"))?.tried, [
    "ca",
  ]);
});

test("AC6c: a Codex reset 20 s away on /chatgpt keeps the pin", async () => {
  const rig = await Rig.start();
  rig.account("ca", "openai-codex");
  rig.account("cb", "openai-codex");
  await rig.machine();
  assert.equal((await rig.send("openai-codex", { key: "X" })).account, "ca");
  plan("ca", {
    status: 429,
    headers: { "x-codex-primary-reset-after-seconds": "20" },
  });
  assert.equal((await rig.send("openai-codex", { key: "X" })).status, 429);
  // A new session avoids `ca` while its short bench lasts; X stays.
  assert.equal((await rig.send("openai-codex", { key: "Y" })).account, "cb");
  assert.equal((await rig.send("openai-codex", { key: "X" })).account, "ca");
  assert.deepEqual(
    rig.pins().find((p) => p.keyHash === pinHash("X"))?.tried,
    [],
  );
});

test.each([
  ["(a) at once", async () => {}],
  ["(b) after a restart", async (rig: Rig) => rig.restart()],
  [
    "(c) after A's bench expires",
    async () => {
      clock += 6 * MIN;
    },
  ],
] as const)(
  "AC6 %s: a long 429 moves X to B for good",
  async (_name, between) => {
    const rig = await claudePair();
    plan("a", long429);
    assert.equal((await rig.send("claude", { key: "X" })).status, 429);
    await between(rig);
    assert.equal((await rig.send("claude", { key: "X" })).account, "b");
    assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  },
);

test("AC6(e): after A 429 → B 2xx → B 429, X stays on B, also across a restart", async () => {
  const rig = await claudePair();
  plan("a", long429);
  await rig.send("claude", { key: "X" });
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  plan("b", long429, long429);
  const limited = await rig.send("claude", { key: "X" });
  assert.equal(limited.account, "b");
  assert.equal(limited.status, 429);
  // Both tried: X stays on B and gets B's answer, never A's credential.
  const again = await rig.send("claude", { key: "X" });
  assert.equal(again.account, "b");
  assert.equal(again.status, 429);
  await rig.restart();
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  assert.deepEqual(rig.pins().find((p) => p.keyHash === pinHash("X"))?.tried, [
    "a",
    "b",
  ]);
});

test("AC6(f): once A's bench ends, X's next ten requests stay on B", async () => {
  const rig = await claudePair();
  plan("a", long429);
  await rig.send("claude", { key: "X" });
  clock += 121_000;
  for (let i = 0; i < 10; i += 1)
    assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  // `a` is eligible and ranks first for a new session.
  assert.equal((await rig.send("claude", { key: "Y" })).account, "a");
});

// --- AC6b (amendment A1) --------------------------------------------------

test("AC6b: an unusable pin returns to an eligible tried account, else machine-session-limited", async () => {
  const rig = await claudePair();
  plan("a", long429);
  await rig.send("claude", { key: "X" });
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");

  // A still benched and B disabled: limited, no upstream request.
  rig.setEnabled("b", "claude", false);
  clock += 50_000;
  const limited = await rig.send("claude", { key: "X" });
  assert.equal(limited.status, 429);
  assert.equal(limited.account, undefined);
  assert.equal(limited.headers["retry-after"], "70");
  assert.match(limited.text, new RegExp(`${MARKER} every Claude account`));
  assert.ok(
    lines.some((line) =>
      / kind=machine client=\S+ refused machine-session-limited 429/.test(line),
    ),
  );
  // Once A's bench ends, X returns to A.
  clock += 71_000;
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");

  // After the return, a 429 on A with B re-enabled keeps X on A.
  rig.setEnabled("b", "claude", true);
  plan("a", long429, long429);
  const onA = await rig.send("claude", { key: "X" });
  assert.equal(onA.account, "a");
  assert.equal(onA.status, 429);
  const stillA = await rig.send("claude", { key: "X" });
  assert.equal(stillA.account, "a");
  assert.equal(stillA.status, 429);
});

test("AC6b: after a restart the bench is gone, so the return happens at once", async () => {
  const rig = await claudePair();
  plan("a", long429);
  await rig.send("claude", { key: "X" });
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  await rig.restart();
  rig.setEnabled("b", "claude", false);
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
});

// --- AC7 ------------------------------------------------------------------

test.each([
  ["removed", (rig: Rig) => rig.edge.removeAccount("a")],
  ["disabled", (rig: Rig) => rig.setEnabled("a", "claude", false)],
  ["needs a login", () => unlinkSync(accountFiles.get("a")!)],
] as const)(
  "AC7: when A is %s, X's next request reaches B",
  async (_name, change) => {
    const rig = await claudePair();
    assert.equal((await rig.send("claude", { key: "X" })).account, "a");
    change(rig);
    const moved = await rig.send("claude", { key: "X" });
    assert.equal(moved.status, 200);
    assert.equal(moved.account, "b");
    assert.ok(!moved.text.includes(NEEDS_LOGIN_TEXT));
  },
);

test("AC7: revoking the client drops its pins and revokes its machine leases", async () => {
  const rig = await claudePair();
  const other = await rig.machine("thasso", "laptop");
  await rig.send("claude", { key: "X" });
  await rig.send("claude", { key: "X", machine: other });
  const { clientId } = rig.machines[0]!;
  assert.equal(rig.pins().length, 2);
  rig.edge.registry.revoke(clientId);
  await vi.waitFor(() => {
    assert.deepEqual(
      rig.pins().map((pin) => pin.clientId),
      [other.clientId],
    );
    const leases = JSON.parse(
      readFileSync(join(rig.stateDir, "leases.json"), "utf8"),
    ) as {
      leases: { kind: string; owner: { clientId: string }; revoked?: string }[];
    };
    const own = leases.leases.filter((l) => l.owner.clientId === clientId);
    assert.ok(own.length > 0);
    assert.ok(own.every((l) => l.kind === "machine" && l.revoked));
  });
  // The other client keeps being served.
  assert.equal(
    (await rig.send("claude", { key: "X", machine: other })).account,
    "a",
  );
});

// --- AC7b: the final validation --------------------------------------------

/** A user with Codex accounts `ca`, `cb` (and `cc`), X pinned on `ca`. */
async function codexRace(third = false): Promise<Rig> {
  const rig = await Rig.start();
  rig.account("ca", "openai-codex");
  rig.account("cb", "openai-codex");
  if (third) rig.account("cc", "openai-codex");
  await rig.machine();
  assert.equal((await rig.send("openai-codex", { key: "X" })).account, "ca");
  return rig;
}

/** Makes the account's token due, so its next read waits on a renewal. */
function due(id: string): Gate {
  const file = accountFiles.get(id)!;
  writeToken("openai-codex", file, access(id), clock + 30_000);
  return gate(file);
}

test.each([
  ["(b) A is removed", (rig: Rig) => rig.edge.removeAccount("ca")],
  [
    "(c) A is disabled",
    (rig: Rig) => rig.setEnabled("ca", "openai-codex", false),
  ],
  [
    "(d) A needs a login",
    () => {
      renewRejected.add(accountFiles.get("ca")!);
    },
  ],
] as const)(
  "AC7b %s while X's request waits: it is re-selected onto B",
  async (_name, change) => {
    const rig = await codexRace();
    const wait = due("ca");
    const pending = rig.send("openai-codex", { key: "X" });
    await wait.entered;
    change(rig);
    wait.release();
    const reply = await pending;
    assert.equal(reply.status, 200);
    assert.equal(reply.account, "cb");
    assert.ok(
      upstreams.chatgpt.every(
        (seen, i) =>
          i === 0 || !String(seen.headers.authorization).includes("fake-ca-"),
      ),
      "A's credential never reached the upstream after the change",
    );
  },
);

test("AC7b(a): a client revoked while its request waits gets no upstream answer", async () => {
  const rig = await codexRace();
  const wait = due("ca");
  const pending = rig.send("openai-codex", { key: "X" }).catch(() => ({
    status: 0,
    account: undefined,
  }));
  await wait.entered;
  rig.edge.registry.revoke(rig.machines[0]!.clientId);
  await vi.waitFor(() =>
    assert.ok(rig.machineLeases().every((l) => l.revoked)),
  );
  wait.release();
  const reply = await pending;
  assert.notEqual(reply.status, 200);
  assert.equal(reply.account, undefined);
  assert.equal(upstreams.chatgpt.length, 1, "only the first request");
  assert.deepEqual(rig.pins(), []);
});

test("AC7b(e): X's own long 429 on A while another request of X waits moves that request to B", async () => {
  const rig = await codexRace();
  let release429!: () => void;
  plan("ca", {
    status: 429,
    headers: { "retry-after": "120" },
    hold: new Promise<void>((resolve) => (release429 = resolve)),
  });
  // R2 reaches A and is held there; then A's token falls due.
  const r2 = rig.send("openai-codex", { key: "X" });
  await vi.waitFor(() => assert.equal(upstreams.chatgpt.length, 2));
  const wait = due("ca");
  const r1 = rig.send("openai-codex", { key: "X" });
  await wait.entered;
  release429();
  assert.equal((await r2).status, 429);
  wait.release();
  const reply = await r1;
  assert.equal(reply.status, 200);
  assert.equal(reply.account, "cb");
});

test("AC7b(f): a second change during the re-selected wait is refused machine-retry, with no third lookup", async () => {
  const rig = await codexRace(true);
  let release429!: () => void;
  plan("ca", {
    status: 429,
    headers: { "retry-after": "120" },
    hold: new Promise<void>((resolve) => (release429 = resolve)),
  });
  const r2 = rig.send("openai-codex", { key: "X" });
  await vi.waitFor(() => assert.equal(upstreams.chatgpt.length, 2));
  const waitA = due("ca");
  const waitB = due("cb");
  due("cc");
  const r1 = rig.send("openai-codex", { key: "X" });
  await waitA.entered;
  release429();
  assert.equal((await r2).status, 429);
  waitA.release();
  // Re-selected onto B, whose credential wait is held too.
  await waitB.entered;
  rig.setEnabled("cb", "openai-codex", false);
  waitB.release();
  const reply = await r1;
  assert.equal(reply.status, 503);
  assert.match(
    reply.text,
    /this machine's account changed while the request waited; retry/,
  );
  assert.match(reply.text, new RegExp(MARKER));
  assert.equal(reply.account, undefined);
  assert.equal(upstreams.chatgpt.length, 2);
  assert.ok(
    !renewCalls.includes(accountFiles.get("cc")!),
    "no third credential lookup",
  );
});

// --- AC8 ------------------------------------------------------------------

test("AC8: no usable account gets the marked 403 naming the gateway's page", async () => {
  const rig = await Rig.start(["thasso", "noai"]);
  rig.account("a", "claude", "noai");
  const machine = await rig.machine("noai");
  const refused = await rig.send("openai-codex", { machine });
  assert.equal(refused.status, 403);
  assert.match(
    refused.text,
    /Pandeck gateway: no OpenAI account is available to this machine's user\. Add or log in to one on the gateway's page\./,
  );
  assert.equal(refused.account, undefined);
  assert.equal((await rig.send("claude", { machine })).account, "a");
  // The Codex error shape on /chatgpt.
  assert.ok(
    (JSON.parse(refused.text) as { error: { code: string } }).error.code,
  );
});

test("AC8: every account disabled, or every one needing a login, is the same 403, never the needs-login 401", async () => {
  const rig = await claudePair();
  rig.setEnabled("a", "claude", false);
  rig.setEnabled("b", "claude", false);
  const disabled = await rig.send("claude", { key: "X" });
  assert.equal(disabled.status, 403);
  assert.match(disabled.text, /no Claude account is available/);
  rig.setEnabled("a", "claude", true);
  rig.setEnabled("b", "claude", true);
  unlinkSync(accountFiles.get("a")!);
  unlinkSync(accountFiles.get("b")!);
  const replies = [];
  for (let i = 0; i < 3; i += 1)
    replies.push(await rig.send("claude", { key: "X" }));
  for (const reply of replies) {
    assert.ok(!reply.text.includes(NEEDS_LOGIN_TEXT), reply.text);
    assert.notEqual(reply.status, 401);
    assert.equal(reply.account, undefined);
  }
  assert.equal(replies.at(-1)!.status, 403);
  assert.match(replies.at(-1)!.text, /no Claude account is available/);
});

test("AC7b, AC8: when both credential waits find a dead login, the first reply is machine-retry and the next is the empty-pool 403", async () => {
  const rig = await codexRace();
  for (const id of ["ca", "cb"]) {
    const file = accountFiles.get(id)!;
    writeToken("openai-codex", file, access(id), clock + 30_000);
    renewRejected.add(file);
  }
  const first = await rig.send("openai-codex", { key: "X" });
  assert.equal(first.status, 503);
  assert.match(
    first.text,
    /^\{"error":\{"type":"api_error","code":"api_error","message":"Pandeck gateway: this machine's account changed while the request waited; retry\."\}\}$/,
  );
  assert.deepEqual(renewCalls, [
    accountFiles.get("ca")!,
    accountFiles.get("cb")!,
  ]);
  for (const key of ["X", "Z"]) {
    const next = await rig.send("openai-codex", { key });
    assert.equal(next.status, 403, key);
    assert.match(
      next.text,
      /Pandeck gateway: no OpenAI account is available to this machine's user\. Add or log in to one on the gateway's page\./,
    );
  }
  for (const reply of [first]) {
    assert.ok(!reply.text.includes(NEEDS_LOGIN_TEXT));
    assert.equal(reply.account, undefined);
  }
  // No third credential read, then none at all once the pool is known empty.
  assert.equal(renewCalls.length, 2);
  assert.equal(upstreams.chatgpt.length, 1);
});

test("AC8: with every account benched, a new session gets the best usable one and its answer", async () => {
  const rig = await claudePair();
  plan("a", long429);
  await rig.send("claude", { key: "X" });
  plan("b", long429);
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
  plan("a", long429);
  const fresh = await rig.send("claude", { key: "Z" });
  assert.equal(fresh.account, "a");
  assert.equal(fresh.status, 429);
});

// --- AC9, AC10 ------------------------------------------------------------

test("AC9: a machine request with Origin is refused 403, marked", async () => {
  const rig = await claudePair();
  const reply = await rig.send("claude", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(reply.status, 403);
  assert.match(
    reply.text,
    /Pandeck gateway: model access from this machine is for local tools only/,
  );
  assert.equal(reply.account, undefined);
  assert.equal(rig.machineLeases().length, 0);
});

test.each([
  ["Host attacker.example:8797", ["host", "attacker.example:8797"]],
  ["Host localhost.evil.example", ["host", "localhost.evil.example"]],
  ["Host 127.0.0.1.nip.io", ["host", "127.0.0.1.nip.io"]],
  ["Host localhost:80x", ["host", "localhost:80x"]],
  ["two Host headers", ["host", "localhost", "host", "127.0.0.1"]],
  ["Origin: null", ["host", "localhost", "origin", "null"]],
] as const)(
  "AC9: at the edge, a machine request with %s is refused 403, marked",
  async (_name, headers) => {
    const rig = await claudePair();
    const reply = await edgeRequest(rig, rig.machines[0]!, PATH.claude, [
      ...headers,
    ]);
    assert.equal(reply.status, 403);
    assert.match(
      reply.text,
      /model access from this machine is for local tools only/,
    );
    assert.equal(upstreams.anthropic.length, 0);
    assert.equal(rig.machineLeases().length, 0);
  },
);

test.each([
  ["an IP (127.0.0.1)", "127.0.0.1"],
  ["a DNS name (localhost)", "localhost"],
] as const)(
  "AC9, F005: a relay enrolled with %s takes a foreign Host to the edge, which refuses it 403, marked; loopback Hosts are served",
  async (_name, enrolledHost) => {
    const rig = await Rig.start();
    rig.account("a", "claude");
    const machine = await rig.machine("thasso", "devbox", enrolledHost);
    for (const host of ["attacker.example:8797", "localhost.evil.example"]) {
      const reply = await relayRaw(machine, PATH.claude, [
        "host",
        host,
        "authorization",
        `Bearer ${PLACEHOLDER}`,
      ]);
      assert.equal(reply.status, 403, host);
      const body = JSON.parse(reply.text) as {
        type: string;
        error: { type: string; message: string };
      };
      assert.equal(body.type, "error");
      assert.equal(body.error.type, "permission_error");
      assert.match(
        body.error.message,
        /^Pandeck gateway: model access from this machine is for local tools only\.$/,
      );
    }
    assert.equal(upstreams.anthropic.length, 0);
    assert.equal(rig.machineLeases().length, 0);
    for (const host of ["localhost", "127.0.0.1:8797", "[::1]"]) {
      const reply = await relayRaw(machine, PATH.claude, [
        "host",
        host,
        "authorization",
        `Bearer ${PLACEHOLDER}`,
      ]);
      assert.equal(reply.status, 200, host);
    }
    assert.equal(upstreams.anthropic.length, 3);
  },
);

test("AC9, F004: through the relay, two Host fields are refused 403, marked", async () => {
  const rig = await claudePair();
  for (const hosts of [
    ["localhost", "attacker.example"],
    ["localhost", "localhost"],
  ]) {
    const reply = await relayRaw(rig.machines[0]!, PATH.claude, [
      ...hosts.flatMap((host) => ["host", host]),
      "authorization",
      `Bearer ${PLACEHOLDER}`,
    ]);
    assert.equal(reply.status, 403, hosts.join(", "));
    assert.match(
      reply.text,
      /Pandeck gateway: model access from this machine is for local tools only/,
    );
  }
  assert.equal(upstreams.anthropic.length, 0);
  assert.equal(rig.machineLeases().length, 0);
});

test.each([
  [
    "a repeated x-claude-code-session-id",
    "claude",
    ["x-claude-code-session-id", "R1", "x-claude-code-session-id", "R2"],
  ],
  [
    "a repeated session-id",
    "openai-codex",
    ["session-id", "R1", "session-id", "R2"],
  ],
  [
    "a repeated x-opencode-session-id",
    "openai-codex",
    ["x-opencode-session-id", "R1", "x-opencode-session-id", "R2"],
  ],
  [
    "a repeated session-id beside one x-opencode-session-id",
    "openai-codex",
    ["session-id", "R1", "x-opencode-session-id", "R3", "session-id", "R2"],
  ],
] as const)(
  "F004: through the relay, %s pins the client's per-provider pin",
  async (_name, provider, keyFields) => {
    const rig = await Rig.start();
    rig.account("a", "claude");
    rig.account("ca", "openai-codex");
    const machine = await rig.machine();
    const raw = keyFields.map((value, i) =>
      i % 2 === 1 ? sessionKey(value) : value,
    );
    for (const value of keyFields) usedKeys.add(sessionKey(value));
    const reply = await relayRaw(machine, PATH[provider], [
      "host",
      "localhost",
      "authorization",
      `Bearer ${PLACEHOLDER}`,
      ...raw,
    ]);
    assert.equal(reply.status, 200);
    assert.deepEqual(
      rig.pins().map((pin) => [pin.provider, pin.keyHash]),
      [[provider, null]],
    );
    // One field of the same key is still a session's own pin.
    const single = await relayRaw(machine, PATH[provider], [
      "host",
      "localhost",
      "authorization",
      `Bearer ${PLACEHOLDER}`,
      ...raw.slice(0, 2),
    ]);
    assert.equal(single.status, 200);
    assert.ok(
      rig.pins().some((pin) => pin.keyHash === sha256(raw[1]!)),
      "the single field is keyed",
    );
  },
);

test("F004: a request without Host gets the relay's own edge address, as before", async () => {
  const rig = await claudePair();
  const machine = rig.machines[0]!;
  const answer = await new Promise<string>((resolve, reject) => {
    // HTTP/1.0: the relay closes after its answer; a half-close first would
    // abort the request.
    const socket = net.connect(machine.relay.port, "127.0.0.1", () =>
      socket.write(
        `POST ${PATH.claude} HTTP/1.0\r\nauthorization: Bearer ${PLACEHOLDER}\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`,
      ),
    );
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
  assert.match(answer, /^HTTP\/1\.1 200 /);
  assert.equal(upstreams.anthropic.length, 1);
});

test("F004: a repeated ordinary header still reaches the provider as Node joins it", async () => {
  const rig = await claudePair();
  const reply = await relayRaw(rig.machines[0]!, PATH.claude, [
    "host",
    "localhost",
    "authorization",
    `Bearer ${PLACEHOLDER}`,
    "anthropic-beta",
    "one",
    "anthropic-beta",
    "two",
  ]);
  assert.equal(reply.status, 200);
  assert.equal(upstreams.anthropic[0]!.headers["anthropic-beta"], "one, two");
  assert.equal(upstreams.anthropic[0]!.headers.host, "api.anthropic.com");
});

test("AC5, F007: a provider 429's header fields reach the harness unchanged through gateway and relay", async () => {
  const rig = await claudePair();
  plan("a", {
    status: 429,
    headers: {
      ...REJECTED,
      "retry-after": ["30", "30"],
      "x-fixture-repeat": ["one", "two"],
      "set-cookie": ["a=1", "b=2"],
      "proxy-fixture": "dropped",
    },
  });
  const reply = await relayRaw(rig.machines[0]!, PATH.claude, [
    "host",
    "localhost",
    "authorization",
    `Bearer ${PLACEHOLDER}`,
  ]);
  assert.equal(reply.status, 429);
  assert.equal(
    reply.text,
    '{"type":"error","error":{"type":"rate_limit_error","message":"fixture limit"}}',
  );
  assert.deepEqual(fields(reply.rawHeaders, "retry-after"), ["30", "30"]);
  assert.deepEqual(
    fields(reply.rawHeaders, "anthropic-ratelimit-unified-status"),
    ["rejected"],
  );
  assert.deepEqual(fields(reply.rawHeaders, "x-fixture-repeat"), [
    "one",
    "two",
  ]);
  assert.deepEqual(fields(reply.rawHeaders, "content-type"), [
    "application/json",
  ]);
  // The gateway's drop list and hop-by-hop handling are unchanged.
  assert.deepEqual(fields(reply.rawHeaders, "set-cookie"), []);
  assert.deepEqual(fields(reply.rawHeaders, "proxy-fixture"), []);
  assert.ok(fields(reply.rawHeaders, "transfer-encoding").length <= 1);
  // A stated limit whose retry-after repeats has no reset: long, the pin moves.
  assert.equal((await rig.send("claude")).account, "b");
});

test("a repeated session-key header pins the client's per-provider pin", async () => {
  const rig = await claudePair();
  usedKeys.add(sessionKey("R1"));
  usedKeys.add(sessionKey("R2"));
  const reply = await edgeRequest(rig, rig.machines[0]!, PATH.claude, [
    "host",
    "localhost",
    "x-claude-code-session-id",
    sessionKey("R1"),
    "x-claude-code-session-id",
    sessionKey("R2"),
  ]);
  assert.equal(reply.status, 200);
  assert.deepEqual(
    rig.pins().map((pin) => pin.keyHash),
    [null],
  );
});

test.each(["LOCALHOST:8797", "[::1]:80", "127.0.0.1", "localhost"])(
  "AC9: a loopback Host %s is served",
  async (host) => {
    const rig = await claudePair();
    assert.equal(
      (await rig.send("claude", { headers: { host } })).account,
      "a",
    );
  },
);

test("AC10: machine requests reach only /chatgpt's engine route, never /compat, and WebSockets stay refused", async () => {
  const rig = await claudePair();
  rig.account("ca", "openai-codex");
  for (const [method, path] of [
    ["GET", "/chatgpt/backend-api/wham/usage"],
    ["POST", "/chatgpt/backend-api/wham/rate-limit-reset-credits/consume"],
    ["POST", "/compat/v1/chat/completions"],
  ] as const) {
    const reply = await rig.send(
      path.startsWith("/anthropic") ? "claude" : "openai-codex",
      {
        method,
        path,
      },
    );
    assert.equal(reply.status, 403, path);
    assert.equal(reply.account, undefined);
  }
  assert.equal(rig.machineLeases().length, 0, "a refused route pins nothing");
  // R2′: the token route forwards an account call, fresh and pin-free.
  const usage = await rig.send("claude", {
    method: "GET",
    path: "/anthropic/api/oauth/usage",
  });
  assert.equal(usage.status, 200);
  assert.ok(usage.account);
  assert.deepEqual(rig.pins(), []);
  // A WebSocket upgrade never reaches an upstream.
  const upgraded = await new Promise<number | "closed">((resolve) => {
    const request = http.request({
      host: "127.0.0.1",
      port: rig.machines[0]!.relay.port,
      path: PATH["openai-codex"],
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        authorization: `Bearer ${PLACEHOLDER}`,
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
      },
    });
    request.on("upgrade", () => resolve(101));
    request.on("response", (res) => resolve(res.statusCode ?? 0));
    request.on("error", () => resolve("closed"));
    request.end();
  });
  assert.notEqual(upgraded, 101);
  assert.equal(upstreams.chatgpt.length, 0);
});

// --- AC17, AC18 -----------------------------------------------------------

test("AC17: pools and pins are scoped to the client's user, client and provider", async () => {
  const rig = await Rig.start(["u1", "u2", "u3"]);
  rig.account("u1-a", "claude", "u1");
  rig.account("u1-b", "claude", "u1");
  rig.account("u1-o", "openai-codex", "u1");
  rig.account("u2-a", "claude", "u2");
  rig.account("u2-o", "openai-codex", "u2");
  rig.account("u3-a", "claude", "u3");
  const m1 = await rig.machine("u1", "u1-devbox");
  const m1b = await rig.machine("u1", "u1-laptop");
  const m2 = await rig.machine("u2", "u2-devbox");
  const m3 = await rig.machine("u3", "u3-devbox");
  const key = "same-key";
  assert.equal(
    (await rig.send("claude", { key, machine: m1 })).account,
    "u1-a",
  );
  assert.equal(
    (await rig.send("claude", { key, machine: m2 })).account,
    "u2-a",
  );
  assert.equal(
    (await rig.send("openai-codex", { key, machine: m1 })).account,
    "u1-o",
  );
  assert.equal(
    (await rig.send("openai-codex", { key, machine: m2 })).account,
    "u2-o",
  );
  // Two clients of u1 with the same key: a 429 on one moves only that one.
  assert.equal(
    (await rig.send("claude", { key, machine: m1b })).account,
    "u1-a",
  );
  plan("u1-a", long429);
  assert.equal((await rig.send("claude", { key, machine: m1 })).status, 429);
  assert.equal(
    (await rig.send("claude", { key, machine: m1 })).account,
    "u1-b",
  );
  clock += 121_000;
  assert.equal(
    (await rig.send("claude", { key, machine: m1b })).account,
    "u1-a",
  );
  // A user without an OpenAI account is refused, never served another's.
  const refused = await rig.send("openai-codex", { key, machine: m3 });
  assert.equal(refused.status, 403);
  assert.equal(refused.account, undefined);
  const pins = rig.pins().filter((pin) => pin.keyHash === pinHash(key));
  assert.equal(pins.length, 5);
  assert.equal(
    new Set(pins.map((pin) => `${pin.clientId}/${pin.provider}`)).size,
    5,
  );
});

test("AC18: OpenCode's x-opencode-session-id pins on /chatgpt; session-id wins when both are sent", async () => {
  const rig = await Rig.start();
  rig.account("ca", "openai-codex");
  rig.account("cb", "openai-codex");
  await rig.machine();
  usedKeys.add(sessionKey("Y"));
  usedKeys.add(sessionKey("S"));
  const opencode = { "x-opencode-session-id": sessionKey("Y") };
  assert.equal(
    (await rig.send("openai-codex", { headers: opencode })).account,
    "ca",
  );
  await rig.send("openai-codex", {
    headers: { ...opencode, "session-id": sessionKey("S") },
  });
  assert.deepEqual(
    rig
      .pins()
      .map((pin) => pin.keyHash)
      .sort(),
    [pinHash("S"), pinHash("Y")].sort(),
  );
  plan("ca", long429);
  assert.equal(
    (await rig.send("openai-codex", { headers: opencode })).status,
    429,
  );
  assert.equal(
    (await rig.send("openai-codex", { headers: opencode })).account,
    "cb",
  );
});

// --- persistence failures and lifetime ------------------------------------

test("a registry that cannot be read while the response is recorded is logged, and the gateway keeps serving", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  let release!: () => void;
  plan("a", {
    ...long429,
    hold: new Promise<void>((resolve) => (release = resolve)),
  });
  const pending = rig.send("claude", { key: "X" });
  await vi.waitFor(() => assert.equal(upstreams.anthropic.length, 2));
  const registryFile = join(rig.stateDir, "clients.json");
  const saved = readFileSync(registryFile, "utf8");
  writeFileSync(registryFile, "{not json");
  release();
  const limited = await pending;
  assert.equal(limited.status, 429, "the 429 still reaches the harness");
  assert.ok(lines.some((line) => /^machine pool evidence failed/.test(line)));
  writeFileSync(registryFile, saved);
  // The bench was recorded before the failure: the next request moves.
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
});

test("a pin file that cannot be written inside the response callback keeps the move in memory", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  const pinsFile = join(rig.stateDir, "machinePins.json");
  rmSync(pinsFile);
  mkdirSync(join(pinsFile, "blocked"), { recursive: true });
  plan("a", long429);
  assert.equal((await rig.send("claude", { key: "X" })).status, 429);
  assert.ok(lines.includes("machine pins: save failed; kept in memory"));
  assert.equal((await rig.send("claude", { key: "X" })).account, "b");
});

test("a machine lease that cannot be saved refuses that request and the gateway keeps serving", async () => {
  const rig = await claudePair();
  const leasesFile = join(rig.stateDir, "leases.json");
  if (existsSync(leasesFile)) rmSync(leasesFile);
  mkdirSync(join(leasesFile, "blocked"), { recursive: true });
  const failed = await rig.send("claude", { key: "X" });
  assert.equal(failed.status, 500);
  assert.equal(failed.account, undefined);
  assert.ok(
    lines.some((line) => / kind=machine client=\S+ internal error/.test(line)),
  );
  rmSync(leasesFile, { recursive: true });
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
});

test("AC13, AC14: machine leases count as live for renewal; a pin idle 7 days is dropped on restart with its lease", async () => {
  const rig = await claudePair();
  assert.equal((await rig.send("claude", { key: "X" })).account, "a");
  assert.equal(rig.gw.leases.hasLiveLease("a"), true);
  assert.equal(rig.gw.leases.hasLiveLease("b"), false);
  clock += 7 * 24 * 60 * MIN + 1;
  await rig.restart();
  assert.deepEqual(rig.pins(), []);
  assert.ok(rig.machineLeases().every((lease) => lease.revoked));
  assert.equal(rig.gw.leases.hasLiveLease("a"), false);
});

// --- Task-1430 PR3: the permissive machine path on the token routes --------

function recordsOf(rig: Rig, userId = "thasso") {
  return rig.gw.requests!.since(userId, undefined, 0, 5000).records;
}

/** The account a fake upstream request spent, by its bearer. */
function spentBy(seen: {
  headers: http.IncomingHttpHeaders;
}): string | undefined {
  return owners.get(
    String(seen.headers.authorization ?? "").replace(/^Bearer /, ""),
  );
}

/** A machine request through the relay, bearer the placeholder. */
function machineSend(
  rig: Rig,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): ReturnType<typeof rawRequest> {
  return rawRequest(rig.machines[0]!.relay.port, path, {
    method,
    headers: { authorization: `Bearer ${PLACEHOLDER}`, ...headers },
  });
}

const REJECTED_LONG = {
  status: 429,
  headers: {
    "anthropic-ratelimit-unified-status": "rejected",
    "retry-after": "3600",
  },
};

test("AC1, AC2: /anthropic-mcp reaches only its fixed host with the account's bearer; unlisted paths forward, marked", async () => {
  const rig = await claudePair();
  const mcp = await machineSend(
    rig,
    "POST",
    "/anthropic-mcp/v1/mcp/linear?q=SENTINEL",
    { host: "127.0.0.1", "x-forwarded-host": "evil.example" },
  );
  assert.equal(mcp.status, 200);
  assert.equal(upstreams.anthropic.length, 0);
  assert.equal(upstreams.mcpProxy.length, 1);
  const [seen] = upstreams.mcpProxy;
  assert.equal(seen!.servername, "mcp-proxy.anthropic.com");
  assert.equal(seen!.headers.host, "mcp-proxy.anthropic.com");
  assert.ok(["a", "b"].includes(spentBy(seen!) ?? ""), "the account's bearer");
  assert.equal(seen!.url, "/v1/mcp/linear?q=SENTINEL");
  assert.equal(seen!.body.toString("utf8"), '{"model":"fixture"}');

  const unlisted = await machineSend(rig, "GET", "/anthropic/api/new_thing");
  assert.equal(unlisted.status, 200);
  assert.equal(upstreams.anthropic.at(-1)!.servername, "api.anthropic.com");
  assert.equal((await machineSend(rig, "PUT", "/anthropic-mcp/x")).status, 200);
  assert.equal(upstreams.mcpProxy.length, 2);
  const eval_ = await machineSend(
    rig,
    "POST",
    "/anthropic/api/eval/sdk-zAZezfDKGoZuXXKe",
  );
  assert.equal(eval_.status, 200);
  // An unknown prefix that only starts like the MCP one.
  assert.equal(
    (await machineSend(rig, "POST", "/anthropic-mcpX/v1")).status,
    404,
  );
  assert.deepEqual(rig.pins(), [], "a session-less account call pins nothing");

  await vi.waitFor(() => assert.equal(recordsOf(rig).length, 5));
  const marks = recordsOf(rig).map((r) => [
    r.host,
    r.method,
    r.path,
    r.pathKey,
    r.listed,
  ]);
  assert.deepEqual(marks, [
    [
      "mcp-proxy.anthropic.com",
      "POST",
      "/v1/mcp/linear",
      "/v1/mcp/:slug",
      true,
    ],
    ["api.anthropic.com", "GET", "/api/new_thing", "/api/new_thing", false],
    ["mcp-proxy.anthropic.com", "PUT", "/x", "/x", false],
    [
      "api.anthropic.com",
      "POST",
      "/api/eval/sdk-zAZezfDKGoZuXXKe",
      "/api/eval/sdk-zAZezfDKGoZuXXKe",
      true,
    ],
    // No token route, so no marking.
    ["", "POST", "/anthropic-mcpX/v1", "/anthropic-mcpX/v1", undefined],
  ]);

  // Conditional requests pass unchanged both ways.
  for (const id of ["a", "b"])
    plan(id, { status: 304, headers: { etag: '"v1"' } });
  const cached = await machineSend(
    rig,
    "GET",
    "/anthropic/api/claude_code/settings",
    {
      "if-none-match": '"v1"',
    },
  );
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.etag, '"v1"');
  assert.equal(upstreams.anthropic.at(-1)!.headers["if-none-match"], '"v1"');
});

test("AC11: engine leases reach neither /anthropic-mcp nor an unlisted /anthropic path", async () => {
  const rig = await claudePair();
  const { relay } = rig.machines[0]!;
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);
  const engine = await link.grantEngineLease({
    workerId: undefined,
    profileId: "a",
  });
  owners.set(engine.token, "engine-token");
  for (const [method, path] of [
    ["POST", "/anthropic-mcp/v1/mcp/x"],
    ["GET", "/anthropic/api/claude_code/settings"],
  ] as const) {
    const reply = await rig.send("claude", {
      bearer: engine.token,
      method,
      path,
    });
    assert.equal(reply.status, 403, path);
    assert.match(reply.text, /does not cover this request/);
  }
  assert.equal(upstreams.anthropic.length + upstreams.mcpProxy.length, 0);
  await vi.waitFor(() => assert.equal(recordsOf(rig).length, 2));
  for (const record of recordsOf(rig)) {
    assert.equal(record.listed, undefined, "a lease record is never marked");
    assert.equal(record.pathKey, record.path, "the projection's fallback");
  }
});

test("C7: account and MCP limits never bench, move or create a pin; a model run's still does", async () => {
  const rig = await claudePair();
  const first = await rig.send("claude", { key: "S" });
  assert.equal(first.status, 200);
  const home = first.account!;
  const pins = rig.pins();
  for (const [method, path] of [
    ["POST", "/anthropic-mcp/v1/messages"],
    ["POST", "/anthropic-mcp/v1/mcp/linear"],
    ["GET", "/anthropic/api/oauth/usage"],
    ["GET", "/anthropic/api/claude_code/settings"],
  ] as const)
    for (const key of ["S", undefined]) {
      plan("a", REJECTED_LONG);
      plan("b", REJECTED_LONG);
      const reply = await machineSend(
        rig,
        method,
        path,
        key ? { "x-claude-code-session-id": sessionKey(key) } : {},
      );
      if (key) usedKeys.add(sessionKey(key));
      answers.clear();
      assert.equal(reply.status, 429, `${path} ${key}`);
      assert.equal(reply.headers["retry-after"], "3600");
      assert.equal(
        reply.headers["anthropic-ratelimit-unified-status"],
        "rejected",
      );
      assert.ok(!reply.text.includes(MARKER), "the upstream's own 429");
      assert.deepEqual(
        rig.pins(),
        pins,
        `${path} ${key}: no pin moves or appears`,
      );
      // Unbenched: the session's next model run is served on its account.
      const next = await rig.send("claude", { key: "S" });
      assert.equal(next.status, 200);
      assert.equal(next.account, home);
    }
  // The route-bound model run still benches and moves.
  plan(home, REJECTED_LONG);
  assert.equal((await rig.send("claude", { key: "S" })).status, 429);
  const moved = await rig.send("claude", { key: "S" });
  assert.notEqual(moved.account, home);
});

test("D-PR3-4: a 401 from /anthropic-mcp forces no renewal; one from /anthropic still does", async () => {
  const rig = await claudePair();
  plan("a", { status: 401 });
  plan("b", { status: 401 });
  const mcp = await machineSend(rig, "POST", "/anthropic-mcp/v1/mcp/linear");
  assert.equal(mcp.status, 401);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(upstreams.platform.length, 0, "no forced renewal");
  answers.clear();
  plan("a", { status: 401 });
  plan("b", { status: 401 });
  const api = await machineSend(rig, "GET", "/anthropic/api/oauth/usage");
  assert.equal(api.status, 401);
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
});

test("S4: a fresh request leaves a key-less model run's null-key pin where it is", async () => {
  const rig = await claudePair();
  const run = await rig.send("claude", {});
  assert.equal(run.status, 200);
  const pins = rig.pins();
  assert.equal(pins.length, 1);
  assert.equal(pins[0]!.keyHash, null);
  for (let i = 0; i < 3; i += 1)
    assert.equal(
      (await machineSend(rig, "GET", "/anthropic/api/oauth/usage")).status,
      200,
    );
  assert.deepEqual(rig.pins(), pins);
});

test("S4, AC10: fresh requests whose logins are dead are never the vault's 401", async () => {
  const rig = await claudePair();
  unlinkSync(accountFiles.get("a")!);
  unlinkSync(accountFiles.get("b")!);
  const replies = [];
  for (let i = 0; i < 3; i += 1)
    replies.push(await machineSend(rig, "GET", "/anthropic/api/oauth/usage"));
  for (const reply of replies) {
    assert.notEqual(reply.status, 401, reply.text);
    assert.ok(!reply.text.includes(NEEDS_LOGIN_TEXT), reply.text);
  }
  assert.equal(replies.at(-1)!.status, 403);
  assert.match(replies.at(-1)!.text, /no Claude account is available/);
  assert.equal(upstreams.anthropic.length, 0);
});

test("S4: a sweep during a held fresh request keeps its lease; the next sweep after it ends revokes it", async () => {
  const rig = await claudePair();
  // A Codex session's model runs sweep the same pool, and pin no Claude lease.
  rig.account("ca", "openai-codex");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  plan("a", { status: 200, hold });
  plan("b", { status: 200, hold });
  const pending = machineSend(rig, "GET", "/anthropic/api/oauth/usage");
  await vi.waitFor(() => assert.equal(upstreams.anthropic.length, 1));
  answers.clear();
  const [freshLease] = rig.machineLeases();
  assert.ok(freshLease && !freshLease.revoked);
  const live = (): boolean =>
    !rig.machineLeases().find((l) => l.leaseId === freshLease.leaseId)!.revoked;
  clock += 61 * MIN;
  assert.equal((await rig.send("openai-codex", { key: "Z" })).status, 200);
  assert.equal(live(), true, "the held lease survives the sweep");
  release();
  assert.equal((await pending).status, 200);
  await vi.waitFor(() => assert.equal(recordsOf(rig).length, 2));
  assert.equal(live(), true, "a zero count revokes nothing by itself");
  clock += 61 * MIN;
  assert.equal((await rig.send("openai-codex", { key: "Z" })).status, 200);
  assert.equal(live(), false, "released, the next sweep revokes it");
});

// --- the real listener: CONNECT, TRACE, TRACK ------------------------------

/** A raw TLS exchange with the edge's model port: everything until close. */
function edgeRaw(rig: Rig, machine: Machine, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = (name: string): string =>
      readFileSync(join(machine.dir, name), "utf8");
    const socket = tls.connect({
      host: "127.0.0.1",
      port: rig.edge.modelPort,
      servername: "localhost",
      key: file("client-key.pem"),
      cert: file("client-cert.pem"),
      ca: file("gateway-ca.pem"),
    });
    const chunks: Buffer[] = [];
    socket.on("secureConnect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("no close"));
    });
  });
}

/** A body-less request to the model port, read by its length, not its close. */
function edgeAsk(
  rig: Rig,
  machine: Machine,
  method: string,
  path: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const file = (name: string): string =>
      readFileSync(join(machine.dir, name), "utf8");
    const request = https.request({
      host: "127.0.0.1",
      port: rig.edge.modelPort,
      servername: "localhost",
      key: file("client-key.pem"),
      cert: file("client-cert.pem"),
      ca: file("gateway-ca.pem"),
      path,
      method,
      agent: false,
      headers: { authorization: `Bearer ${PLACEHOLDER}`, host: "127.0.0.1" },
    });
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

test("rv-1430-03 obligation 4: CONNECT on the model port is refused 403 denied:method, recorded, never tunnelled", async () => {
  const rig = await claudePair();
  const machine = rig.machines[0]!;
  // A lease token's shape, naming a lease no table holds.
  const payload = Buffer.from(
    JSON.stringify({ pandeck: { v: 1, lease: "AAAAAAAAAAAAAAAAAAAAAA" } }),
  ).toString("base64url");
  const leaseShaped = `eyJhbGciOiJub25lIn0.${payload}.${Buffer.alloc(32, 7).toString("base64url")}`;
  assert.ok(isLeaseShaped(leaseShaped));
  owners.set(leaseShaped, "lease-shaped");
  const cases: {
    target: string;
    bearer: string;
    cookie?: boolean;
    expect: Record<string, unknown>;
  }[] = [
    {
      target: "api.anthropic.com:443",
      bearer: PLACEHOLDER,
      expect: { host: "", path: "api.anthropic.com:443", listed: undefined },
    },
    {
      target: "/anthropic/v1/x",
      bearer: PLACEHOLDER,
      expect: {
        host: "api.anthropic.com",
        path: "/v1/x",
        pathKey: "/v1/x",
        listed: false,
      },
    },
    {
      target: "/anthropic/v1/x",
      bearer: leaseShaped,
      expect: {
        host: "api.anthropic.com",
        path: "/v1/x",
        pathKey: "/v1/x",
        listed: undefined,
      },
    },
    {
      target: "/anthropic/x@y",
      bearer: PLACEHOLDER,
      expect: { host: "api.anthropic.com", path: "/x@y", listed: false },
    },
    {
      target: "user:pw@api.anthropic.com:443?q=SENTINEL",
      bearer: PLACEHOLDER,
      expect: { host: "", path: "api.anthropic.com:443", clientCookie: false },
    },
    {
      // A `@` in the query is never userinfo.
      target: "api.anthropic.com:443?q=SENTINEL@evil",
      bearer: PLACEHOLDER,
      expect: { host: "", path: "api.anthropic.com:443" },
    },
    {
      target: "user:pw@api.anthropic.com:443?q=SENTINEL",
      bearer: PLACEHOLDER,
      cookie: true,
      expect: { host: "", path: "api.anthropic.com:443", clientCookie: true },
    },
  ];
  for (const [i, c] of cases.entries()) {
    const reply = await edgeRaw(
      rig,
      machine,
      `CONNECT ${c.target} HTTP/1.1\r\nHost: ${c.target.startsWith("/") ? "127.0.0.1" : "api.anthropic.com:443"}\r\nAuthorization: Bearer ${c.bearer}\r\n${c.cookie ? "Cookie: c=SENTINEL\r\n" : ""}\r\n`,
    );
    assert.match(reply, /^HTTP\/1\.1 403 /, c.target);
    assert.ok(reply.includes(MARKER), "marked");
    assert.ok(!/^HTTP\/1\.1 200/m.test(reply), "never a tunnel");
    await vi.waitFor(() => assert.equal(recordsOf(rig).length, i + 1));
    const record = recordsOf(rig).at(-1)!;
    assert.deepEqual(
      [record.method, record.outcome, record.reason, record.status],
      ["CONNECT", "refused", "denied:method", 403],
    );
    for (const [field, value] of Object.entries(c.expect))
      assert.deepEqual(
        (record as unknown as Record<string, unknown>)[field],
        value,
        `${c.target}: ${field}`,
      );
    for (const text of ["user", "pw", "SENTINEL", "evil"])
      assert.ok(!record.path.includes(text), `${c.target}: ${text}`);
  }
  const connectLines = lines.filter(
    (l) => / CONNECT /.test(l) && l.includes("via=gateway"),
  );
  assert.equal(connectLines.length, cases.length);
  for (const line of connectLines) {
    assert.match(line, / refused denied:method 403 /);
    assert.ok(!/user|pw|SENTINEL|evil/.test(line), line);
  }
  assert.equal(upstreams.anthropic.length + upstreams.mcpProxy.length, 0);
  assert.equal(rig.machineLeases().length, 0, "no selection");
});

test("TRACE is refused by the forwarder on both token routes, read by its length", async () => {
  const rig = await claudePair();
  const machine = rig.machines[0]!;
  for (const path of ["/anthropic/v1/messages", "/anthropic-mcp/v1/mcp/x"]) {
    const reply = await edgeAsk(rig, machine, "TRACE", path);
    assert.equal(reply.status, 403);
    assert.ok(reply.text.includes(MARKER));
  }
  await vi.waitFor(() => assert.equal(recordsOf(rig).length, 2));
  for (const record of recordsOf(rig))
    assert.deepEqual(
      [record.method, record.reason, record.listed],
      ["TRACE", "denied:method", false],
    );
  assert.equal(
    lines.filter(
      (l) => / TRACE /.test(l) && / refused denied:method 403 /.test(l),
    ).length,
    2,
  );
  assert.equal(upstreams.anthropic.length + upstreams.mcpProxy.length, 0);
});

test("D-PR3-7: TRACK gets the runtime parser's 400, with no record, no line and no upstream or credential contact", async () => {
  const rig = await claudePair();
  const before = lines.length;
  const reply = await edgeRaw(
    rig,
    rig.machines[0]!,
    `TRACK /anthropic/v1/messages?q=SENTINEL HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${PLACEHOLDER}\r\nCookie: c=SENTINEL\r\n\r\n`,
  );
  assert.match(reply, /^HTTP\/1\.1 400 /);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(recordsOf(rig).length, 0);
  assert.ok(!lines.slice(before).some((l) => l.includes("TRACK")));
  assert.equal(upstreams.anthropic.length + upstreams.mcpProxy.length, 0);
  assert.equal(upstreams.platform.length, 0);
  assert.equal(
    rig.machineLeases().length,
    0,
    "no selection, so no credential read",
  );
});
