/**
 * The edge's MCP endpoint end to end (Task-1397): the MCP SDK's own client
 * (1.30.1) through a real enrolled relay to the edge's `/mcp` gate, the tool
 * host and an in-process vault, against a stubbed Atlassian `fetch`. Two
 * users, three clients; credentials set over gateway client 1.0 through each
 * relay's socket. Every value is fake.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  encodeClientMessage,
} from "../gateway/clientMethods.ts";
import type { CredentialOutcome, EdgeTools } from "../gateway/edgeTools.ts";
import { startGateway, type RunningGateway } from "../gateway/gateway.ts";
import { enrollRelay, startRelay, type RunningRelay } from "../relay/relay.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import { dialUnixSocket } from "../workerProtocol/unixSocketTransport.ts";
import { createEdgeTools } from "./index.ts";

const realFetch = globalThis.fetch;
const relayRoot = mkdtempSync(join(tmpdir(), "mcp-edge-"));
const open: { close(): unknown }[] = [];

const A_TOKEN = "FAKE-ATL-TOKEN-A-SENTINEL";
const A_TOKEN_2 = "FAKE-ATL-TOKEN-A2-SENTINEL";
const B_TOKEN = "FAKE-ATL-TOKEN-B-SENTINEL";
const A_SITE = "alpha.atlassian.net";
const B_SITE = "beta.atlassian.net";
const basic = (email: string, token: string) =>
  `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

interface Outbound {
  url: URL;
  auth: string | null;
}
let outbound: Outbound[] = [];
/** What a stubbed issue read does; answers the issue unless replaced. */
let onIssue: (url: URL, signal: AbortSignal | undefined) => Promise<Response>;

function issueAnswer(url: URL): Promise<Response> {
  const key = decodeURIComponent(url.pathname.split("/").pop()!);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        id: "1",
        key,
        fields: { summary: `issue on ${url.host}` },
      }),
    ),
  );
}

beforeEach(() => {
  outbound = [];
  onIssue = issueAnswer;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      outbound.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname === "/rest/api/3/myself")
        return new Response(
          JSON.stringify({ displayName: "Fake User", accountId: "acc" }),
        );
      return onIssue(url, init?.signal ?? undefined);
    }),
  );
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(relayRoot, { recursive: true, force: true }));

/** Seams on the vault reads the tools see: lock, hold, and the signals. */
interface Seams {
  locked: boolean;
  hold: boolean;
  releases: (() => void)[];
  signals: AbortSignal[];
}

interface Edge {
  gateway: RunningGateway;
  stateDir: string;
  lines: string[];
  seams: Seams;
  relay(userId: string): Promise<{
    clientId: string;
    relay: RunningRelay;
    url: string;
  }>;
}

async function edge(deadlineMs?: number): Promise<Edge> {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const inner = createEdgeTools({ log, ...(deadlineMs ? { deadlineMs } : {}) });
  const seams: Seams = {
    locked: false,
    hold: false,
    releases: [],
    signals: [],
  };
  const tools: EdgeTools = {
    ...inner,
    handleMcp: (req, res, caller) =>
      inner.handleMcp(req, res, {
        clientId: caller.clientId,
        credential: async (integration, signal) => {
          seams.signals.push(signal);
          if (seams.locked) return { ok: false, locked: true };
          const real = await caller.credential(integration, signal);
          if (!seams.hold) return real;
          return new Promise<CredentialOutcome>((resolve) =>
            seams.releases.push(() => resolve(real)),
          );
        },
      }),
  };
  mkdirSync(DATA_DIR, { recursive: true });
  const stateDir = mkdtempSync(join(DATA_DIR, "mcp-edge-"));
  const gateway = await startGateway({
    stateDir,
    log,
    clients: {},
    tools,
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("A");
  gateway.clients!.registry.addUser("B");
  return {
    gateway,
    stateDir,
    lines,
    seams,
    async relay(userId) {
      const dir = mkdtempSync(join(relayRoot, "r-"));
      const clientId = await enrollRelay({
        stateDir: dir,
        host: "127.0.0.1",
        enrollPort: gateway.clients!.enrollPort,
        caPem: gateway.clients!.caPem,
        code: gateway.clients!.registry.createCode(userId, `relay-${userId}`),
      });
      const relay = await startRelay({
        stateDir: dir,
        port: 0,
        socketPath: join(dir, "s.sock"),
        log,
      });
      open.push(relay);
      return { clientId, relay, url: `${relay.url}/mcp` };
    },
  };
}

/** Gateway client 1.0 over the relay's socket, as Pandeck's link speaks it. */
async function clientLink(relay: RunningRelay) {
  const connection = new WorkerConnection(
    await dialUnixSocket(relay.socketPath),
    {
      handshake: { role: "worker", workerId: "test-server" },
      protocol: GATEWAY_CLIENT_PROTOCOL,
      handlers: Object.fromEntries(
        [CLIENT_METHODS.accountsChanged, CLIENT_METHODS.loginEvent].map((m) => [
          m,
          () => Promise.resolve(encodeClientMessage({})),
        ]),
      ),
    },
  );
  open.push({ close: () => connection.end("test done") });
  const call = async (method: string, json: object) =>
    ((await connection.request(method, encodeClientMessage(json))) as Payload)
      .json as Record<string, unknown>;
  return {
    set: (json: object) =>
      call(CLIENT_METHODS.integrationSet, {
        integration: "atlassian",
        ...json,
      }),
    clear: (json: object = {}) =>
      call(CLIENT_METHODS.integrationClear, {
        integration: "atlassian",
        ...json,
      }),
    status: (json: object = {}) =>
      call(CLIENT_METHODS.integrationStatus, {
        integration: "atlassian",
        ...json,
      }),
  };
}

async function mcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "edge-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: realFetch,
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  // The SDK's own class misses `exactOptionalPropertyTypes` on its handlers.
  await client.connect(transport as Transport);
  open.push({ close: () => client.close().catch(() => {}) });
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content.map((part) => part.text).join("");
}

/** A raw request to the relay's `/mcp`. */
function raw(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: options.method ?? "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  },
});

/** Two users' clients with their credentials set. */
async function twoUsers(deadlineMs?: number) {
  const e = await edge(deadlineMs);
  const a1 = await e.relay("A");
  const a2 = await e.relay("A");
  const b1 = await e.relay("B");
  const registry = e.gateway.clients!.registry;
  const tokens = {
    a1: registry.setMcpToken(a1.clientId),
    a2: registry.setMcpToken(a2.clientId),
    b1: registry.setMcpToken(b1.clientId),
  };
  const linkA = await clientLink(a1.relay);
  const linkB = await clientLink(b1.relay);
  assert.deepEqual(
    await linkA.set({ site: A_SITE, email: "a@x.test", token: A_TOKEN }),
    {
      connected: true,
      site: A_SITE,
      email: "a@x.test",
      displayName: "Fake User",
      accountId: "acc",
    },
  );
  await linkB.set({ site: B_SITE, email: "b@x.test", token: B_TOKEN });
  outbound = [];
  return { e, a1, a2, b1, tokens, linkA, linkB };
}

test("an SDK client lists and calls jira_get_issue through the relay, with its own user's credential", async () => {
  const { a1, a2, b1, tokens } = await twoUsers();
  const clientA = await mcpClient(a1.url, tokens.a1);
  const listed = await clientA.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ["jira_get_issue"],
  );
  assert.deepEqual(listed.tools[0]!.inputSchema.required, ["issue"]);
  const a = await clientA.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-73" },
  });
  assert.equal(a.isError, undefined);
  assert.equal(
    (JSON.parse(textOf(a)) as { jiraHost: string }).jiraHost,
    A_SITE,
  );
  assert.equal(outbound.at(-1)!.url.host, A_SITE);
  assert.equal(outbound.at(-1)!.auth, basic("a@x.test", A_TOKEN));

  const clientB = await mcpClient(b1.url, tokens.b1);
  await clientB.callTool({
    name: "jira_get_issue",
    arguments: { issue: "X-1" },
  });
  assert.equal(outbound.at(-1)!.url.host, B_SITE);
  assert.equal(outbound.at(-1)!.auth, basic("b@x.test", B_TOKEN));

  // A's second client, with its own token, reads A's credential: by user.
  const clientA2 = await mcpClient(a2.url, tokens.a2);
  await clientA2.callTool({
    name: "jira_get_issue",
    arguments: { issue: "Y-2" },
  });
  assert.equal(outbound.at(-1)!.auth, basic("a@x.test", A_TOKEN));

  // But A2's token is not A1's: by client.
  const refused = await raw(a1.url, {
    headers: { authorization: `Bearer ${tokens.a2}` },
    body: INIT,
  });
  assert.equal(refused.status, 401);
  assert.deepEqual(JSON.parse(refused.text), { error: "mcp token required" });
});

test("a userId in an integration payload is ignored: only the client's user is touched", async () => {
  const { linkA, linkB } = await twoUsers();
  await linkA.set({
    userId: "B",
    site: A_SITE,
    email: "a@x.test",
    token: A_TOKEN_2,
  });
  assert.equal((await linkB.status({ userId: "A" })).email, "b@x.test");
  await linkA.clear({ userId: "B" });
  assert.deepEqual(await linkA.status({ userId: "B" }), { connected: false });
  assert.equal((await linkB.status()).connected, true);
});

test("each call reads the vault: a replaced token goes out next, a cleared one fails with no request", async () => {
  const { a1, tokens, linkA } = await twoUsers();
  const client = await mcpClient(a1.url, tokens.a1);
  await linkA.set({ site: A_SITE, email: "a@x.test", token: A_TOKEN_2 });
  outbound = [];
  await client.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-1" },
  });
  assert.equal(outbound.at(-1)!.auth, basic("a@x.test", A_TOKEN_2));
  await linkA.clear();
  outbound = [];
  const cleared = await client.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-1" },
  });
  assert.equal(cleared.isError, true);
  assert.equal(
    textOf(cleared),
    "Jira is not connected for this user; connect it in Pandeck's Settings.",
  );
  assert.deepEqual(outbound, []);
});

test("a locked vault answers the fixed error with no request", async () => {
  const { e, a1, tokens } = await twoUsers();
  const client = await mcpClient(a1.url, tokens.a1);
  e.seams.locked = true;
  const answer = await client.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-1" },
  });
  assert.equal(answer.isError, true);
  assert.equal(textOf(answer), "The vault is locked.");
  assert.deepEqual(outbound, []);
});

test("a held vault read times out on schedule and its late credential sends nothing", async () => {
  const { e, a1, tokens } = await twoUsers(150);
  const client = await mcpClient(a1.url, tokens.a1);
  e.seams.hold = true;
  const started = Date.now();
  const answer = await client.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-1" },
  });
  assert.equal(answer.isError, true);
  assert.equal(textOf(answer), "The tool timed out.");
  assert.ok(Date.now() - started < 3_000);
  for (const release of e.seams.releases.splice(0)) release();
  await delay(50);
  assert.deepEqual(outbound, []);
});

test("an MCP client that goes away aborts the call and closes the SDK instances", async () => {
  const connects = vi.spyOn(Server.prototype, "connect");
  const serverCloses = vi.spyOn(Server.prototype, "close");
  const transportCloses = vi.spyOn(
    WebStandardStreamableHTTPServerTransport.prototype,
    "close",
  );
  const { e, a1, tokens } = await twoUsers();

  // Held in the vault read.
  e.seams.hold = true;
  const first = await mcpClient(a1.url, tokens.a1);
  const pending = first
    .callTool({ name: "jira_get_issue", arguments: { issue: "OPS-1" } })
    .catch(() => undefined);
  for (let i = 0; i < 100 && e.seams.releases.length === 0; i++)
    await delay(10);
  const heldSignal = e.seams.signals.at(-1)!;
  await first.close();
  await pending;
  for (let i = 0; i < 100 && !heldSignal.aborted; i++) await delay(10);
  assert.equal(heldSignal.aborted, true);
  for (const release of e.seams.releases.splice(0)) release();
  await delay(50);
  assert.deepEqual(outbound, []);

  // In the Jira request itself.
  e.seams.hold = false;
  let jiraSignal: AbortSignal | undefined;
  onIssue = (_url, signal) => {
    jiraSignal = signal;
    return new Promise<Response>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason as Error)),
    );
  };
  const second = await mcpClient(a1.url, tokens.a1);
  const inFlight = second
    .callTool({ name: "jira_get_issue", arguments: { issue: "OPS-2" } })
    .catch(() => undefined);
  for (let i = 0; i < 100 && !jiraSignal; i++) await delay(10);
  await second.close();
  await inFlight;
  for (let i = 0; i < 100 && !jiraSignal?.aborted; i++) await delay(10);
  assert.equal(jiraSignal?.aborted, true);

  await delay(50);
  assert.ok(connects.mock.calls.length > 0);
  assert.equal(serverCloses.mock.calls.length, connects.mock.calls.length);
  assert.equal(transportCloses.mock.calls.length, connects.mock.calls.length);
});

test("the gate refuses a missing, wrong, cleared or revoked token, an Origin, other methods and a large body", async () => {
  const { e, a1, a2, tokens } = await twoUsers();
  const registry = e.gateway.clients!.registry;
  const post = (token?: string, headers: Record<string, string> = {}) =>
    raw(a1.url, {
      headers: {
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: INIT,
    });
  assert.equal((await post(tokens.a1)).status, 200);
  assert.equal((await post()).status, 401);
  assert.equal((await post("pgmcp_wrong")).status, 401);
  assert.equal((await post(`${tokens.a1} extra`)).status, 401);

  const origin = await post(tokens.a1, { origin: "http://evil-origin.test" });
  assert.equal(origin.status, 403);
  assert.deepEqual(JSON.parse(origin.text), { error: "origin not allowed" });

  // One message per POST; no SDK text or request text comes back.
  const batch = await raw(a1.url, {
    headers: { authorization: `Bearer ${tokens.a1}` },
    body: JSON.stringify([JSON.parse(INIT), JSON.parse(INIT)]),
  });
  assert.equal(batch.status, 400);
  assert.match(batch.text, /Batches are not supported\./);
  const version = await post(tokens.a1, {
    "mcp-protocol-version": "SENTINEL-REQUEST-SECRET",
  });
  assert.equal(version.status, 400);
  assert.doesNotMatch(version.text, /SENTINEL/);

  for (const method of ["GET", "DELETE"])
    assert.equal(
      (
        await raw(a1.url, {
          method,
          headers: { authorization: `Bearer ${tokens.a1}` },
        })
      ).status,
      405,
    );
  const large = await raw(a1.url, {
    headers: { authorization: `Bearer ${tokens.a1}` },
    body: Buffer.alloc(1024 * 1024 + 10, 0x20),
  });
  assert.equal(large.status, 413);

  assert.equal(registry.clearMcpToken(a1.clientId), true);
  assert.equal((await post(tokens.a1)).status, 401);

  // A revoked client is refused at the edge, whatever its token.
  assert.equal(
    (
      await raw(a2.url, {
        headers: { authorization: `Bearer ${tokens.a2}` },
        body: INIT,
      })
    ).status,
    200,
  );
  registry.revoke(a2.clientId);
  const revoked = await raw(a2.url, {
    headers: { authorization: `Bearer ${tokens.a2}` },
    body: INIT,
  });
  assert.ok([403, 502].includes(revoked.status), String(revoked.status));
  assert.doesNotMatch(e.lines.join("\n"), /evil-origin|SENTINEL/);
});

test("no token or credential reaches a log, an MCP error, a method error or the edge's own files", async () => {
  const { e, a1, tokens, linkA } = await twoUsers();
  const client = await mcpClient(a1.url, tokens.a1);
  onIssue = () =>
    Promise.resolve(
      new Response(`echo ${A_TOKEN} ${basic("a@x.test", A_TOKEN)}`, {
        status: 401,
      }),
    );
  const rejected = await client.callTool({
    name: "jira_get_issue",
    arguments: { issue: "OPS-1" },
  });
  assert.equal(rejected.isError, true);
  assert.equal(
    textOf(rejected),
    "Atlassian rejected the credential; reconnect Jira in Pandeck's Settings.",
  );

  // A rejected set: the Atlassian body never reaches the method error.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(`denied ${A_TOKEN_2}`, {
          status: 401,
        }),
    ),
  );
  const error = await linkA
    .set({ site: A_SITE, email: "a@x.test", token: A_TOKEN_2 })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  assert.ok(error instanceof WorkerRequestError);
  assert.equal(error.code, "integration_rejected");
  assert.doesNotMatch(error.message, /SENTINEL/);
  const invalid = await linkA
    .set({ site: "evil.com", email: "a@x.test", token: A_TOKEN_2 })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  assert.ok(invalid instanceof WorkerRequestError);
  assert.equal(invalid.code, "integration_invalid");

  const sentinels = [
    A_TOKEN,
    A_TOKEN_2,
    B_TOKEN,
    tokens.a1,
    tokens.a2,
    tokens.b1,
  ];
  const all = [...e.lines, JSON.stringify(rejected)].join("\n");
  for (const sentinel of sentinels)
    assert.ok(!all.includes(sentinel), sentinel);
  assert.doesNotMatch(all, /Basic [A-Za-z0-9+/=]{8}/);

  // The edge's state holds no token outside the vault's own accounts/.
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  for (const file of files(e.stateDir)) {
    if (relative(e.stateDir, file).startsWith("accounts")) continue;
    const text = readFileSync(file, "utf8");
    for (const sentinel of sentinels)
      assert.ok(!text.includes(sentinel), `${file} holds a token`);
  }
  // clients.json holds the MCP tokens only as hashes.
  const clients = readFileSync(join(e.stateDir, "clients.json"), "utf8");
  assert.match(clients, /"mcpTokenHash": ?"[0-9a-f]{64}"/);
});
