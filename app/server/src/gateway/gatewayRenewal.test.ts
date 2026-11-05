/**
 * Renewal through a running gateway (`docs/workers.md` "Renewal"): requests
 * that wait for one renewal (AC7, AC20), upstream 401s (AC8), a dead login
 * reported over control and refused with U7's text (AC9), missing and
 * malformed files (AC11), and a gateway restarted without its server (AC12).
 * G5b: every end of a login hold re-reads the file at once (G5b AC1); a
 * hold waits for a renewal in flight and fences every renewal (G5b AC2); and
 * a restart, a lost connection or elapsed time never ends one (G5b AC9).
 * Control runs over an in-process pair; Claude renews at a fake TLS
 * `platform.claude.com`, Codex through a fake port. Every token is a fake.
 */
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { isLoginDeath } from "../providerErrors.ts";
import {
  CLAUDE_PATH,
  CODEX_PATH,
  dialControl,
  endChild,
  fakeProcesses,
  rotatingClaudeTokens,
  spawnIdleChild,
  startFakeUpstreams,
  type FakeUpstreams,
  type UpstreamResponder,
} from "../test/gatewayFixtures.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import type { WorkerConnection } from "../workerProtocol/connection.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeLeaseGranted,
  decodeLoginHeld,
  encodeControlRequest,
  type CredentialStatus,
  type LeaseGrant,
} from "./controlMethods.ts";
import {
  startGateway,
  type GatewayOptions,
  type RunningGateway,
} from "./gateway.ts";
import type { HoldStatus } from "./holds.ts";
import { processStartTime, type ProcessProbe } from "./processIdentity.ts";
import type { GatewayProfile } from "./profiles.ts";
import type { CodexRenewPort } from "./renewal.ts";
import { refusalText } from "./refusals.ts";

// Synthetic fixture values; none is a real credential.
const OLD_ACCESS = "fake-gwrenew-old-access";
const OLD_REFRESH = "fake-gwrenew-old-refresh";
const LOGIN_ACCESS = "fake-gwrenew-login-access";
const LOGIN_REFRESH = "fake-gwrenew-login-refresh";
const CODEX_RENEWED = "fake-gwrenew-codex-renewed";
const ACCOUNT = "acct-gwrenew";
const RENEWED = "fake-claude-renewed";
const SENTINELS = [
  OLD_ACCESS,
  OLD_REFRESH,
  LOGIN_ACCESS,
  LOGIN_REFRESH,
  CODEX_RENEWED,
  RENEWED,
];
const MIN = 60_000;
const UPSTREAM_401 =
  '{"type":"error","error":{"type":"authentication_error","message":"fixture says no"}}';

let upstreams: FakeUpstreams;
let claudeRespond: UpstreamResponder;
let tokenRespond: UpstreamResponder;
const okResponder: UpstreamResponder = (_seen, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

/** The fake Codex port: what it does next, and every call it got. */
let portImpl: CodexRenewPort;
let portCalls: string[];

const running: RunningGateway[] = [];
let lines: string[] = [];
/** Every `profiles.credential` and other payload control sent the server. */
let statuses: CredentialStatus[] = [];
/** Every `profiles.status` control sent the server. */
let holdStatuses: HoldStatus[] = [];
let payloads: string[] = [];
let refusals: string[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: (seen, res) => claudeRespond(seen, res),
    claudeToken: (seen, res) => tokenRespond(seen, res),
  });
});

beforeEach(() => {
  claudeRespond = okResponder;
  tokenRespond = rotatingClaudeTokens();
  portCalls = [];
  portImpl = async (file) => {
    await delay(20);
    await writeCodex(file, Date.now() + 600 * MIN, CODEX_RENEWED);
    return { ok: true };
  };
});

afterEach(async () => {
  // AC16: no token in a log line, a control payload or a refusal body.
  for (const text of [...lines, ...payloads, ...refusals])
    for (const token of SENTINELS)
      assert.ok(!text.includes(token), `a token leaks: ${text}`);
  while (running.length) await running.pop()!.close();
  upstreams.reset();
  lines = [];
  statuses = [];
  holdStatuses = [];
  payloads = [];
  refusals = [];
});

afterAll(async () => {
  await upstreams.close();
});

async function gateway(options: GatewayOptions = {}): Promise<RunningGateway> {
  const gw = await startGateway({
    log: (line) => lines.push(line),
    upstreams: upstreams.overrides,
    claudeTokenEndpoint: upstreams.tokenEndpoint,
    renewCodex: (file, minValidityMs, signal) => {
      portCalls.push(file);
      return portImpl(file, minValidityMs, signal);
    },
    processProbe: fakeProcesses().probe,
    ...options,
  });
  running.push(gw);
  return gw;
}

async function profileDir(): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const dir = join(await mkdtemp(join(DATA_DIR, "gwrenew-")), "profile");
  await mkdir(dir);
  return dir;
}

async function writeClaude(
  file: string,
  expiresAt: number,
  access = OLD_ACCESS,
  refresh = OLD_REFRESH,
): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt },
    }),
  );
}

async function writeCodex(
  file: string,
  expires: number,
  access = OLD_ACCESS,
): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access,
        refresh: OLD_REFRESH,
        accountId: ACCOUNT,
        expires,
      },
    }),
  );
}

async function claudeProfile(
  id: string,
  expiresAt: number,
  enabled = true,
): Promise<GatewayProfile> {
  const tokenFile = join(await profileDir(), ".credentials.json");
  await writeClaude(tokenFile, expiresAt);
  return { id, provider: "claude", name: `Account ${id}`, enabled, tokenFile };
}

async function codexProfile(
  id: string,
  expires: number,
): Promise<GatewayProfile> {
  const tokenFile = join(await profileDir(), "auth.json");
  await writeCodex(tokenFile, expires);
  return {
    id,
    provider: "openai-codex",
    name: `Account ${id}`,
    enabled: true,
    tokenFile,
  };
}

/** A control connection after hello and a sync of `profiles`. */
async function ready(
  gw: RunningGateway,
  profiles: GatewayProfile[],
): Promise<WorkerConnection> {
  const connection = await connect(gw, "boot-x", 4242);
  await sync(connection, profiles);
  return connection;
}

/** A control connection after a hello as `serverBootId` with `pid`. */
async function connect(
  gw: RunningGateway,
  serverBootId: string,
  pid: number,
): Promise<WorkerConnection> {
  const connection = dialControl(
    createInProcessTransport(),
    gw.attachControl,
    GATEWAY_CONTROL_PROTOCOL,
    {
      [CONTROL_METHODS.credential]: (payload: Payload) => {
        payloads.push(JSON.stringify(payload.json));
        statuses.push(payload.json as CredentialStatus);
        return Promise.resolve({ json: {} });
      },
      [CONTROL_METHODS.status]: (payload: Payload) => {
        payloads.push(JSON.stringify(payload.json));
        holdStatuses.push(payload.json as HoldStatus);
        return Promise.resolve({ json: {} });
      },
    },
  );
  await connection.request(
    CONTROL_METHODS.hello,
    encodeControlRequest({ serverBootId, pid, startTime: "1234" }),
  );
  return connection;
}

async function sync(
  connection: WorkerConnection,
  profiles: GatewayProfile[],
): Promise<void> {
  await connection.request(
    CONTROL_METHODS.syncProfiles,
    encodeControlRequest({ profiles }),
  );
}

async function grant(
  connection: WorkerConnection,
  request: LeaseGrant,
): Promise<string> {
  const granted = decodeLeaseGranted(
    await connection.request(
      CONTROL_METHODS.grant,
      encodeControlRequest(request),
    ),
  );
  return granted.token;
}

const engine = (profileId: string): LeaseGrant => ({
  kind: "engine",
  workerId: "w",
  sessionId: "s1",
  profileId,
});

interface Reply {
  status: number;
  text: string;
}

function request(
  port: number,
  method: string,
  path: string,
  token: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) refusals.push(text);
          resolve({ status: res.statusCode ?? 0, text });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(method === "GET" ? undefined : '{"model":"fixture"}');
  });
}

const forward = (
  gw: RunningGateway,
  profile: GatewayProfile,
  token: string,
): Promise<Reply> =>
  request(
    gw.port,
    "POST",
    profile.provider === "claude" ? CLAUDE_PATH : CODEX_PATH,
    token,
  );

const usage = (gw: RunningGateway, token: string): Promise<Reply> =>
  request(gw.port, "GET", "/anthropic/api/oauth/usage", token);

const sentBearers = (seen: FakeUpstreams["anthropic"]): unknown[] =>
  seen.map((request) => request.headers.authorization);

function messageOf(reply: Reply): string {
  return JSON.parse(reply.text).error.message;
}

/** Lets a renewal started after a reply run to its end. */
const settled = (): Promise<unknown> => delay(150);

test("AC7: an expired Claude token and 5 concurrent requests share one POST, all sent with the new token", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() - MIN);
  const token = await grant(await ready(gw, [a]), engine(a.id));
  const replies = await Promise.all(
    [1, 2, 3, 4, 5].map(() => forward(gw, a, token)),
  );
  assert.deepEqual(
    replies.map((reply) => reply.status),
    [200, 200, 200, 200, 200],
  );
  assert.equal(upstreams.platform.length, 1);
  assert.deepEqual(
    sentBearers(upstreams.anthropic),
    Array(5).fill(`Bearer ${RENEWED}-access-1`),
  );
  assert.deepEqual(statuses, []);
});

test("AC7: an expired Codex token and 5 concurrent requests make one port call", async () => {
  const gw = await gateway();
  const b = await codexProfile("codex-b", Date.now() - MIN);
  const token = await grant(await ready(gw, [b]), engine(b.id));
  const replies = await Promise.all(
    [1, 2, 3, 4, 5].map(() => forward(gw, b, token)),
  );
  assert.deepEqual(
    replies.map((reply) => reply.status),
    [200, 200, 200, 200, 200],
  );
  assert.deepEqual(portCalls, [b.tokenFile]);
  assert.deepEqual(
    sentBearers(upstreams.chatgpt),
    Array(5).fill(`Bearer ${CODEX_RENEWED}`),
  );
});

test("AC7: a failing endpoint forwards with the old token and backs off; the next request does not wait", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() - MIN);
  const token = await grant(await ready(gw, [a]), engine(a.id));
  tokenRespond = (_seen, res) => {
    res.writeHead(500).end();
  };
  assert.equal((await forward(gw, a, token)).status, 200);
  assert.equal(upstreams.platform.length, 1);
  const started = Date.now();
  assert.equal((await forward(gw, a, token)).status, 200);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(upstreams.platform.length, 1, "in backoff");
  assert.deepEqual(
    sentBearers(upstreams.anthropic),
    Array(2).fill(`Bearer ${OLD_ACCESS}`),
  );
  assert.ok(
    lines.includes("renewal claude-a claude: failed (500)"),
    lines.join("\n"),
  );
  assert.deepEqual(statuses, []);
});

test("AC8: an upstream 401 for the current token passes through and forces one renewal, at most every 5 min", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const token = await grant(await ready(gw, [a]), engine(a.id));
  claudeRespond = (_seen, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(UPSTREAM_401);
  };
  const reply = await forward(gw, a, token);
  assert.deepEqual(reply, { status: 401, text: UPSTREAM_401 });
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
  await vi.waitFor(async () =>
    assert.equal(
      JSON.parse(await readFile(a.tokenFile, "utf8")).claudeAiOauth.accessToken,
      `${RENEWED}-access-1`,
    ),
  );
  // The renewed token is rejected too: within 5 min, no second renewal.
  assert.deepEqual(await forward(gw, a, token), {
    status: 401,
    text: UPSTREAM_401,
  });
  await settled();
  assert.equal(upstreams.platform.length, 1);
  assert.deepEqual(statuses, []);
});

test("AC8: a 401 on a Claude usage server lease forces a renewal; one for a replaced token or a held profile does not", async () => {
  const gw = await gateway();
  const usageProfile = await claudeProfile("claude-u", Date.now() + 60 * MIN);
  const replaced = await claudeProfile("claude-r", Date.now() + 60 * MIN);
  const held = await claudeProfile("claude-h", Date.now() + 60 * MIN);
  const connection = await ready(gw, [usageProfile, replaced, held]);
  claudeRespond = (_seen, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(UPSTREAM_401);
  };

  const server = await grant(connection, {
    kind: "server",
    profileId: usageProfile.id,
  });
  assert.deepEqual(await usage(gw, server), {
    status: 401,
    text: UPSTREAM_401,
  });
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));

  const replacedToken = await grant(connection, engine(replaced.id));
  claudeRespond = (_seen, res) => {
    void writeClaude(
      replaced.tokenFile,
      Date.now() + 60 * MIN,
      LOGIN_ACCESS,
    ).then(() => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(UPSTREAM_401);
    });
  };
  assert.equal((await forward(gw, replaced, replacedToken)).status, 401);

  const heldToken = await grant(connection, engine(held.id));
  await connection.request(
    CONTROL_METHODS.loginHold,
    encodeControlRequest({ profileId: held.id, holdId: "h1" }),
  );
  claudeRespond = (_seen, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(UPSTREAM_401);
  };
  assert.deepEqual(await forward(gw, held, heldToken), {
    status: 401,
    text: UPSTREAM_401,
  });
  await settled();
  assert.equal(upstreams.platform.length, 1);
  assert.deepEqual(statuses, []);
});

test("AC9: a rejected refresh reports needs-login, refuses with U7's text and never writes; a new login clears it", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 30_000);
  const bytes = await readFile(a.tokenFile);
  const token = await grant(await ready(gw, [a]), engine(a.id));
  tokenRespond = (_seen, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"invalid_grant","error_description":"fixture"}');
  };
  const reply = await forward(gw, a, token);
  assert.equal(reply.status, 401);
  const body = JSON.parse(reply.text);
  assert.equal(body.type, "error");
  assert.equal(body.error.type, "authentication_error");
  assert.equal(
    body.error.message,
    refusalText({ case: "needs-login", name: a.name }),
  );
  assert.equal(
    isLoginDeath(body.error.message, {
      statusCode: 401,
      provider: "anthropic",
    }),
    false,
  );
  assert.equal(upstreams.anthropic.length, 0);
  await vi.waitFor(() =>
    assert.deepEqual(statuses, [{ profileId: a.id, needsLogin: true }]),
  );
  assert.deepEqual(await readFile(a.tokenFile), bytes);
  assert.equal((await forward(gw, a, token)).status, 401);
  assert.equal(upstreams.platform.length, 1, "sticky: no second refresh");

  tokenRespond = rotatingClaudeTokens();
  await writeClaude(
    a.tokenFile,
    Date.now() + 60 * MIN,
    LOGIN_ACCESS,
    "fake-gwrenew-login-refresh",
  );
  assert.equal((await forward(gw, a, token)).status, 200);
  assert.deepEqual(sentBearers(upstreams.anthropic), [
    `Bearer ${LOGIN_ACCESS}`,
  ]);
  await vi.waitFor(() =>
    assert.deepEqual(statuses.at(-1), { profileId: a.id, needsLogin: false }),
  );
});

test("AC9: a Codex port rejection is the same needs-login, in Codex's shape", async () => {
  const gw = await gateway();
  const b = await codexProfile("codex-b", Date.now() + 30_000);
  const token = await grant(await ready(gw, [b]), engine(b.id));
  portImpl = async () => ({ ok: false, kind: "rejected", code: "400" });
  const reply = await forward(gw, b, token);
  assert.equal(reply.status, 401);
  const body = JSON.parse(reply.text);
  assert.equal(
    body.error.message,
    refusalText({ case: "needs-login", name: b.name }),
  );
  assert.equal(upstreams.chatgpt.length, 0);
  await vi.waitFor(() =>
    assert.deepEqual(statuses, [{ profileId: b.id, needsLogin: true }]),
  );
});

test("AC11: a missing or malformed file is 401 needs-login with a status a good read clears; never 503", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const b = await codexProfile("codex-b", Date.now() + 60 * MIN);
  const connection = await ready(gw, [a, b]);
  const claude = await grant(connection, engine(a.id));
  const codex = await grant(connection, engine(b.id));
  const original = await readFile(a.tokenFile);

  await rm(a.tokenFile);
  await rm(b.tokenFile);
  for (const [profile, token] of [
    [a, claude],
    [b, codex],
  ] as const) {
    const reply = await forward(gw, profile, token);
    assert.equal(reply.status, 401);
    assert.equal(
      messageOf(reply),
      refusalText({ case: "needs-login", name: profile.name }),
    );
  }
  assert.deepEqual(portCalls, []);
  await vi.waitFor(() =>
    assert.deepEqual(statuses, [
      { profileId: a.id, needsLogin: true },
      { profileId: b.id, needsLogin: true },
    ]),
  );
  await writeFile(a.tokenFile, original);
  assert.equal((await forward(gw, a, claude)).status, 200);
  await vi.waitFor(() =>
    assert.deepEqual(statuses.at(-1), { profileId: a.id, needsLogin: false }),
  );

  // The CLI's blank tokens are malformed: refused after its two re-reads.
  statuses = [];
  await writeFile(
    a.tokenFile,
    JSON.stringify({
      claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: null },
    }),
  );
  const started = Date.now();
  const blank = await forward(gw, a, claude);
  assert.ok(Date.now() - started >= 100);
  assert.equal(blank.status, 401);
  assert.equal(
    messageOf(blank),
    refusalText({ case: "needs-login", name: a.name }),
  );
  await vi.waitFor(() =>
    assert.deepEqual(statuses, [{ profileId: a.id, needsLogin: true }]),
  );
  await writeFile(a.tokenFile, original);
  assert.equal((await forward(gw, a, claude)).status, 200);
});

test("AC11: a file truncated for 30 ms is forwarded with no status; an unreadable one keeps the credential text", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const token = await grant(await ready(gw, [a]), engine(a.id));
  const original = await readFile(a.tokenFile);
  await writeFile(a.tokenFile, "");
  const restore = delay(30).then(() => writeFile(a.tokenFile, original));
  const reply = await forward(gw, a, token);
  await restore;
  assert.equal(reply.status, 200);
  await settled();
  assert.deepEqual(statuses, []);

  await chmod(a.tokenFile, 0o000);
  try {
    const refused = await forward(gw, a, token);
    assert.equal(refused.status, 401);
    assert.equal(
      messageOf(refused),
      refusalText({ case: "credential", problem: "unreadable" }),
    );
  } finally {
    await chmod(a.tokenFile, 0o600);
  }
  await settled();
  assert.deepEqual(statuses, []);
});

test("AC12: a gateway restarted on the same state without a server renews a leased profile within one tick", async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const stateDir = await mkdtemp(join(DATA_DIR, "gwrenew-state-"));
  const first = await gateway({ stateDir });
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  await grant(await ready(first, [a]), engine(a.id));
  await first.close();
  running.splice(running.indexOf(first), 1);

  await writeClaude(a.tokenFile, Date.now() + 9 * MIN);
  const second = await gateway({ stateDir });
  await second.renewDue();
  assert.equal(upstreams.platform.length, 1);
  assert.equal(
    JSON.parse(await readFile(a.tokenFile, "utf8")).claudeAiOauth.accessToken,
    `${RENEWED}-access-1`,
  );
});

test("AC20: a profile disabled after its grants still renews for its engine and server leases", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const connection = await ready(gw, [a]);
  const engineToken = await grant(connection, engine(a.id));
  const serverToken = await grant(connection, {
    kind: "server",
    profileId: a.id,
  });
  await sync(connection, [{ ...a, enabled: false }]);

  await writeClaude(a.tokenFile, Date.now() - MIN);
  assert.equal((await forward(gw, a, engineToken)).status, 200);
  assert.equal(upstreams.platform.length, 1);
  await writeClaude(
    a.tokenFile,
    Date.now() - MIN,
    OLD_ACCESS,
    `${RENEWED}-refresh-1`,
  );
  assert.equal((await usage(gw, serverToken)).status, 200);
  assert.equal(upstreams.platform.length, 2);
  assert.deepEqual(sentBearers(upstreams.anthropic), [
    `Bearer ${RENEWED}-access-1`,
    `Bearer ${RENEWED}-access-2`,
  ]);
});

test.each([
  ["openai-codex", "its profile is removed"],
  ["claude", "an account switch revokes it"],
] as const)(
  "F001: a %s request waiting on a renewal is refused, not sent, when %s meanwhile",
  async (provider, _how) => {
    const gw = await gateway();
    const p =
      provider === "claude"
        ? await claudeProfile("wait-a", Date.now() - MIN)
        : await codexProfile("wait-b", Date.now() - MIN);
    const connection = await ready(gw, [p]);
    const token = await grant(connection, engine(p.id));
    let entered!: () => void;
    let resume!: () => void;
    const renewing = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const renewClaude = tokenRespond;
    tokenRespond = (seen, res) => {
      entered();
      void gate.then(() => renewClaude(seen, res));
    };
    const renewCodex = portImpl;
    portImpl = async (...args) => {
      entered();
      await gate;
      return renewCodex(...args);
    };
    const waited = forward(gw, p, token);
    await renewing;
    if (provider === "claude")
      gw.leases.revokeWhere(() => true, "account-switch");
    else await sync(connection, []);
    resume();
    const reply = await waited;
    assert.equal(reply.status, 401);
    assert.deepEqual(reply, await forward(gw, p, token), "the revoked refusal");
    assert.equal(
      (provider === "claude" ? upstreams.anthropic : upstreams.chatgpt).length,
      0,
      "nothing reached the upstream",
    );
  },
);

/** Takes hold `holdId` on `profileId`; it must be held. */
async function hold(
  connection: WorkerConnection,
  profileId: string,
  holdId: string,
): Promise<void> {
  assert.deepEqual(
    decodeLoginHeld(
      await connection.request(
        CONTROL_METHODS.loginHold,
        encodeControlRequest({ profileId, holdId }),
      ),
    ),
    { held: true },
  );
}

const endHold = (
  connection: WorkerConnection,
  holdId: string,
  method: string = CONTROL_METHODS.loginRelease,
): Promise<Payload> =>
  connection.request(method, encodeControlRequest({ holdId }));

/** Rejects `a`'s next refresh: a sticky needs-login, reported once. */
async function rejectRefresh(
  gw: RunningGateway,
  a: GatewayProfile,
  token: string,
): Promise<void> {
  tokenRespond = (_seen, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"invalid_grant","error_description":"fixture"}');
  };
  assert.equal((await forward(gw, a, token)).status, 401);
  await vi.waitFor(() =>
    assert.deepEqual(statuses, [{ profileId: a.id, needsLogin: true }]),
  );
  tokenRespond = rotatingClaudeTokens();
}

const accessIn = async (file: string): Promise<string> =>
  JSON.parse(await readFile(file, "utf8")).claudeAiOauth.accessToken;

test.each([
  "release",
  "force release",
  "evidence at a hello",
  "evidence at the hold check",
] as const)(
  "G5b AC1: a %s ends a hold over a sticky needs-login; one re-read clears it and kicks one renewal, with no request or tick",
  async (how) => {
    const processes = fakeProcesses();
    const gw = await gateway({ processProbe: processes.probe });
    const a = await claudeProfile("claude-a", Date.now() + 30_000);
    const x = await ready(gw, [a]);
    const token = await grant(x, engine(a.id));
    await rejectRefresh(gw, a, token);
    assert.equal(upstreams.platform.length, 1);

    await hold(x, a.id, "h1");
    if (how.startsWith("evidence"))
      await x.request(
        CONTROL_METHODS.loginWriter,
        encodeControlRequest({ holdId: "h1", pid: 5151, startTime: null }),
      );
    // The login writes its file while the hold stands.
    await writeClaude(
      a.tokenFile,
      Date.now() + 60 * MIN,
      LOGIN_ACCESS,
      LOGIN_REFRESH,
    );
    await settled();
    assert.deepEqual(
      statuses,
      [{ profileId: a.id, needsLogin: true }],
      "nothing re-reads while held",
    );

    if (how === "release") await endHold(x, "h1");
    else if (how === "force release")
      await endHold(x, "h1", CONTROL_METHODS.loginForceRelease);
    else {
      processes.set(4242, "exited");
      processes.set(5151, "exited");
      if (how === "evidence at a hello") await connect(gw, "boot-y", 4343);
      else {
        // The newer boot's hello saw the processes running; the timer's check
        // is what observes their exit.
        processes.set(4242, "running");
        await connect(gw, "boot-y", 4343);
        assert.equal(gw.holds().length, 1);
        processes.set(4242, "exited");
        gw.checkHolds();
      }
    }
    assert.deepEqual(gw.holds(), []);
    await vi.waitFor(() =>
      assert.deepEqual(statuses.at(-1), { profileId: a.id, needsLogin: false }),
    );
    await vi.waitFor(() => assert.equal(upstreams.platform.length, 2));
    await settled();
    assert.equal(upstreams.platform.length, 2, "exactly one renewal");
    assert.equal(upstreams.anthropic.length, 0, "no model request was sent");
    assert.equal(await accessIn(a.tokenFile), `${RENEWED}-access-1`);
  },
);

test("G5b AC1: at a release a due token is renewed and one not due is not; nothing renews while held", async () => {
  const gw = await gateway();
  const due = await claudeProfile("claude-d", Date.now() + 60 * MIN);
  const fresh = await claudeProfile("claude-f", Date.now() + 60 * MIN);
  const connection = await ready(gw, [due, fresh]);
  await grant(connection, engine(due.id));
  await grant(connection, engine(fresh.id));
  await hold(connection, due.id, "hd");
  await hold(connection, fresh.id, "hf");
  await writeClaude(
    due.tokenFile,
    Date.now() + 5 * MIN,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  await writeClaude(
    fresh.tokenFile,
    Date.now() + 60 * MIN,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  const freshBytes = await readFile(fresh.tokenFile);
  await gw.renewDue();
  await settled();
  assert.equal(upstreams.platform.length, 0, "a held lane renews nothing");

  await endHold(connection, "hf");
  await settled();
  assert.equal(upstreams.platform.length, 0, "not due: no renewal");
  assert.deepEqual(await readFile(fresh.tokenFile), freshBytes);

  await endHold(connection, "hd");
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
  await settled();
  assert.equal(upstreams.platform.length, 1);
  assert.equal(await accessIn(due.tokenFile), `${RENEWED}-access-1`);
  assert.deepEqual(statuses, []);
});

test("G5b AC1: a release whose save fails still re-reads and renews a due token", async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const stateDir = await mkdtemp(join(DATA_DIR, "gwrenew-state-"));
  const gw = await gateway({ stateDir });
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const connection = await ready(gw, [a]);
  await grant(connection, engine(a.id));
  await hold(connection, a.id, "h1");
  await writeClaude(a.tokenFile, Date.now() + 5 * MIN);
  // The writer's temp file cannot be opened while a directory holds its name.
  await mkdir(join(stateDir, "holds.json.tmp"));
  await assert.rejects(
    endHold(connection, "h1"),
    (err: { code?: unknown }) => err.code === "state_write_failed",
  );
  assert.deepEqual(gw.holds(), [], "the release stands in memory");
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
  await rm(join(stateDir, "holds.json.tmp"), { recursive: true });
});

test("G5b AC9 (a): a restarted gateway keeps the hold and renews nothing until its release, then re-reads and renews", async () => {
  await mkdir(DATA_DIR, { recursive: true });
  const stateDir = await mkdtemp(join(DATA_DIR, "gwrenew-state-"));
  const first = await gateway({ stateDir });
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const before = await ready(first, [a]);
  const token = await grant(before, engine(a.id));
  await hold(before, a.id, "h1");
  await first.close();
  running.splice(running.indexOf(first), 1);

  const second = await gateway({ stateDir });
  await writeClaude(
    a.tokenFile,
    Date.now() + 30_000,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  const bytes = await readFile(a.tokenFile);
  assert.equal(second.holds().length, 1, "the hold survived the restart");
  await second.renewDue();
  assert.equal((await forward(second, a, token)).status, 200);
  await settled();
  assert.equal(upstreams.platform.length, 0, "no POST while held");
  assert.deepEqual(await readFile(a.tokenFile), bytes);

  const after = await connect(second, "boot-x", 4242);
  await endHold(after, "h1");
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
  assert.equal(await accessIn(a.tokenFile), `${RENEWED}-access-1`);
  assert.deepEqual(holdStatuses, []);
});

/** A token endpoint answer that waits for `open`, then rotates as usual. */
function gatedTokens(): { open(): void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const rotate = rotatingClaudeTokens();
  tokenRespond = (seen, res) => void opened.then(() => rotate(seen, res));
  return { open };
}

test("G5b AC2: an acquire during a renewal answers only after its save; while held no renewal, short-lived request or 401 posts, and a login's write stands byte for byte", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 30_000);
  const x = await ready(gw, [a]);
  const token = await grant(x, engine(a.id));
  const gate = gatedTokens();
  const renewing = gw.renewDue();
  await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));

  let seenAtAnswer: string | undefined;
  const held = hold(x, a.id, "h1").then(async () => {
    seenAtAnswer = await accessIn(a.tokenFile);
  });
  await settled();
  assert.equal(seenAtAnswer, undefined, "the acquire waits for the renewal");
  gate.open();
  await renewing;
  await held;
  assert.equal(seenAtAnswer, `${RENEWED}-access-1`, "answered after the save");

  // The login writes a token about to expire; nothing may renew it now.
  await writeClaude(
    a.tokenFile,
    Date.now() + 30_000,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  const due = await readFile(a.tokenFile);
  await gw.renewDue();
  assert.equal((await forward(gw, a, token)).status, 200);
  claudeRespond = (_seen, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(UPSTREAM_401);
  };
  assert.equal((await forward(gw, a, token)).status, 401);
  await settled();
  assert.equal(upstreams.platform.length, 1, "no POST while held");
  assert.deepEqual(await readFile(a.tokenFile), due);

  // Its final write is what the release finds.
  claudeRespond = okResponder;
  await writeClaude(
    a.tokenFile,
    Date.now() + 60 * MIN,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  const login = await readFile(a.tokenFile);
  await endHold(x, "h1");
  await settled();
  assert.deepEqual(await readFile(a.tokenFile), login);
  assert.equal(upstreams.platform.length, 1);
});

test("G5b AC9 (b): after a server restart lost the release, a live writer keeps the hold and every renewal off; its exit releases it and renews", async () => {
  const child = spawnIdleChild();
  try {
    const fake = fakeProcesses();
    // The writer is this test's own child, observed for real; every other
    // process through the fake.
    const probe: ProcessProbe = {
      kill: (pid, signal) =>
        pid === child.pid
          ? void process.kill(pid, signal)
          : fake.probe.kill(pid, signal),
      startTime: (pid) => (pid === child.pid ? processStartTime(pid) : null),
    };
    const gw = await gateway({ processProbe: probe });
    const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
    const x = await ready(gw, [a]);
    await hold(x, a.id, "h1");
    await x.request(
      CONTROL_METHODS.loginWriter,
      encodeControlRequest({
        holdId: "h1",
        pid: child.pid,
        startTime: processStartTime(child.pid),
      }),
    );
    await writeClaude(
      a.tokenFile,
      Date.now() + 30_000,
      LOGIN_ACCESS,
      LOGIN_REFRESH,
    );

    // The server restarts without releasing: its old process is gone.
    x.end("the server restarted");
    fake.set(4242, "exited");
    const y = await connect(gw, "boot-y", 4343);
    await sync(y, [a]);
    const token = await grant(y, engine(a.id));
    gw.checkHolds();
    await gw.renewDue();
    assert.equal((await forward(gw, a, token)).status, 200);
    await settled();
    assert.equal(gw.holds().length, 1, "the writer still runs");
    assert.equal(upstreams.platform.length, 0, "no POST while it runs");

    await endChild(child);
    gw.checkHolds();
    assert.deepEqual(gw.holds(), []);
    await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
    assert.equal(await accessIn(a.tokenFile), `${RENEWED}-access-1`);
  } finally {
    await endChild(child);
  }
});

test("G5b AC9 (d): a lost control connection keeps the hold and the renewal fenced", async () => {
  const gw = await gateway();
  const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
  const x = await ready(gw, [a]);
  await grant(x, engine(a.id));
  await hold(x, a.id, "h1");
  await writeClaude(
    a.tokenFile,
    Date.now() + 30_000,
    LOGIN_ACCESS,
    LOGIN_REFRESH,
  );
  const bytes = await readFile(a.tokenFile);

  x.end("the connection was lost");
  await settled();
  gw.checkHolds();
  await gw.renewDue();
  await settled();
  assert.equal(gw.holds().length, 1);
  assert.equal(upstreams.platform.length, 0);
  assert.deepEqual(await readFile(a.tokenFile), bytes);
});

test.each(["the writer exits", "Clear force-releases it"] as const)(
  "G5b AC9 (e): a writer past the deadline is login-stuck and renews nothing until %s",
  async (how) => {
    const processes = fakeProcesses();
    let now = Date.now();
    const gw = await gateway({ processProbe: processes.probe, now: () => now });
    const a = await claudeProfile("claude-a", Date.now() + 60 * MIN);
    const x = await ready(gw, [a]);
    await grant(x, engine(a.id));
    await hold(x, a.id, "h1");
    await x.request(
      CONTROL_METHODS.loginWriter,
      encodeControlRequest({ holdId: "h1", pid: 5151, startTime: null }),
    );
    await writeClaude(
      a.tokenFile,
      Date.now() + 30_000,
      LOGIN_ACCESS,
      LOGIN_REFRESH,
    );

    now += 31 * MIN;
    gw.checkHolds();
    await vi.waitFor(() =>
      assert.deepEqual(holdStatuses, [
        { profileId: a.id, loginStuck: true, holdId: "h1" },
      ]),
    );
    await gw.renewDue();
    await settled();
    assert.equal(gw.holds().length, 1, "elapsed time releases nothing");
    assert.equal(upstreams.platform.length, 0);

    if (how === "the writer exits") {
      // The owner's boot is gone and its writer exited: evidence.
      processes.set(4242, "exited");
      processes.set(5151, "exited");
      await connect(gw, "boot-y", 4343);
    } else await endHold(x, "h1", CONTROL_METHODS.loginForceRelease);
    assert.deepEqual(gw.holds(), []);
    await vi.waitFor(() =>
      assert.deepEqual(holdStatuses.at(-1), {
        profileId: a.id,
        loginStuck: false,
        holdId: "h1",
      }),
    );
    await vi.waitFor(() => assert.equal(upstreams.platform.length, 1));
  },
);
