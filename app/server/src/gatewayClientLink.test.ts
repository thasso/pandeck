/**
 * Client mode end to end (plan Task-1384): the server's remote link
 * (`gatewayClientLink.ts`) through an enrolled relay (`relay/relay.ts`) to the
 * gateway edge's mutual-TLS ports (`gateway/clientListener.ts`), and on to
 * fake Anthropic and ChatGPT upstreams. The gateway's accounts are mirrored
 * into the credential profile registry; a model response streams through
 * relay and edge before the upstream has finished it. Fake token files and a
 * temp `HOME`; every value is fake.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { EdgeTools } from "./gateway/edgeTools.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-client-home-"));
process.env.HOME = home;

const profiles = await import("./credentialProfiles.ts");
const { GatewayUnavailableError } = await import("./gatewayLink.ts");
const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
const remoteTools = await import("./remoteTools.ts");
const { subscribeIntegrationToolChanges } =
  await import("./integrationToolChanges.ts");
const { updateJiraSettings } = await import("./jiraSettings.ts");
const { WorkerConnection, WorkerMethodError } =
  await import("./workerProtocol/connection.ts");
const { socketEndpoint } =
  await import("./workerProtocol/unixSocketTransport.ts");
const { CLIENT_METHODS, GATEWAY_CLIENT_PROTOCOL, encodeClientMessage } =
  await import("./gateway/clientMethods.ts");
const {
  CLAUDE_ACCESS,
  CLAUDE_PATH,
  CODEX_ACCESS,
  CODEX_PATH,
  fakeCodexStream,
  modelRequest,
  startFakeUpstreams,
  writeTokenFiles,
} = await import("./test/gatewayFixtures.ts");

const open: { close(): unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Posts through the relay; resolves at the first body bytes. */
function streamingRequest(
  port: number,
  path: string,
  token: string,
): Promise<{ status: number; first: string; rest: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: { authorization: `Bearer ${token}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        const rest = new Promise<string>((done) =>
          response.on("end", () =>
            done(Buffer.concat(chunks).toString("utf8")),
          ),
        );
        response.once("data", (chunk: Buffer) => {
          resolve({
            status: response.statusCode ?? 0,
            first: chunk.toString("utf8"),
            rest,
          });
          response.on("data", (more: Buffer) => chunks.push(more));
        });
      },
    );
    request.on("error", reject);
    request.end('{"model":"fixture"}');
  });
}

test("a server in client mode streams model responses through relay and edge", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const upstreams = await startFakeUpstreams({
    // Half a stream, then the rest only once the client has the first half.
    claude: (_seen, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      void released.then(() => res.end("event: message_stop\ndata: {}\n\n"));
    },
    codex: fakeCodexStream("hello from codex"),
  });
  open.push(upstreams);
  const { claudeFile, codexFile } = await writeTokenFiles();

  const gatewayDir = mkdtempSync(join(DATA_DIR, "edge-"));
  const gateway = await startGateway({
    stateDir: gatewayDir,
    upstreams: upstreams.overrides,
    log: () => {},
    clients: {},
  });
  open.push(gateway);
  const edge = gateway.clients!;
  edge.registry.addUser("thasso");
  edge.putAccount({
    id: "claude-gw",
    provider: "claude",
    name: "Claude (gateway)",
    enabled: true,
    tokenFile: claudeFile,
    userId: "thasso",
  });
  edge.putAccount({
    id: "codex-gw",
    provider: "openai-codex",
    name: "Codex (gateway)",
    enabled: true,
    tokenFile: codexFile,
    userId: "thasso",
  });

  // The relay enrolls with a one-time code, then serves loopback and socket.
  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: edge.enrollPort,
    caPem: edge.caPem,
    code: edge.registry.createCode("thasso", "devbox"),
  });
  const relay = await startRelay({
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  });
  open.push(relay);
  assert.equal(statSync(relay.socketPath).mode & 0o777, 0o600);

  const lines: string[] = [];
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: (line) => lines.push(line),
  });
  open.push(link);
  assert.equal(await link.ready, true);
  assert.equal(link.baseUrl, relay.url);

  // The gateway's accounts are the server's, metadata only.
  assert.deepEqual(
    profiles.listCredentialProfiles().map((p) => [p.id, p.provider, p.status]),
    [
      ["claude-gw", "claude", "ready"],
      ["codex-gw", "openai-codex", "ready"],
    ],
  );
  assert.throws(() =>
    profiles.createCredentialProfile({ name: "local", provider: "claude" }),
  );

  // Claude: the first event arrives while the upstream still holds the rest.
  const claude = await link.grantEngineLease({
    workerId: undefined,
    profileId: "claude-gw",
  });
  const streamed = await streamingRequest(
    relay.port,
    CLAUDE_PATH,
    claude.token,
  );
  assert.equal(streamed.status, 200);
  assert.match(streamed.first, /message_start/);
  release();
  assert.match(await streamed.rest, /message_stop/);
  assert.equal(
    upstreams.anthropic[0]!.headers.authorization,
    `Bearer ${CLAUDE_ACCESS}`,
  );

  // Codex, on the server's own client lease.
  const access = await link.serverAccess("codex-gw");
  assert.equal(access.baseUrl, relay.url);
  const codex = await modelRequest(relay.port, CODEX_PATH, access.leaseToken);
  assert.equal(codex.status, 200);
  assert.match(codex.text, /hello from codex/);
  assert.equal(
    upstreams.chatgpt[0]!.headers.authorization,
    `Bearer ${CODEX_ACCESS}`,
  );

  // A removed account leaves the mirror, and a grant for it fails with U7.
  edge.removeAccount("codex-gw");
  await vi.waitFor(() =>
    assert.deepEqual(
      profiles.credentialProfilesOfKind("openai-codex").map((p) => p.id),
      [],
    ),
  );
  await assert.rejects(
    link.grantEngineLease({ workerId: undefined, profileId: "codex-gw" }),
    GatewayUnavailableError,
  );
  // Its client lease was revoked with it.
  assert.equal(
    (await modelRequest(relay.port, CODEX_PATH, access.leaseToken)).status,
    401,
  );
  assert.ok(lines.some((line) => line.startsWith("ready as client")));
});

test("after every connect the link reads the gateway's Jira status and announces the section", async () => {
  const { createEdgeTools } = await import("./gatewayTools/index.ts");
  const { onSettingsChanged } = await import("./settingsService.ts");
  const { getJiraSettings, updateJiraSettings } =
    await import("./jiraSettings.ts");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ displayName: "Fake" }))),
  );
  open.push({ close: () => vi.unstubAllGlobals() });

  const gatewayDir = mkdtempSync(join(DATA_DIR, "edge-"));
  const gateway = await startGateway({
    stateDir: gatewayDir,
    log: () => {},
    clients: {},
    tools: createEdgeTools({ log: () => {} }),
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("thasso");
  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "devbox"),
  });
  const relayOptions = {
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  };
  let relay = await startRelay(relayOptions);

  const heard: string[][] = [];
  open.push({
    close: onSettingsChanged((change) => heard.push(change.sections)),
  });
  const announced = async (count: number) => {
    for (let i = 0; i < 400 && heard.length < count; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(heard.length, count);
  };

  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);
  await announced(1);
  assert.deepEqual(heard[0], ["jira"]);
  assert.equal(getJiraSettings().credentialStore, "gateway");
  assert.equal(getJiraSettings().atlassianTokenConfigured, false);

  // The token goes to the gateway; Pandeck's own file never sees it.
  const site = getJiraSettings().jiraHost;
  await updateJiraSettings({
    atlassianEmail: "me@example.com",
    atlassianToken: "fake-link-token",
  });
  assert.equal(getJiraSettings().atlassianTokenConfigured, true);

  // A reconnect reads the status again: a restarted server shows it too.
  await relay.close();
  relay = await startRelay(relayOptions);
  open.push(relay);
  await announced(2);
  assert.deepEqual(heard[1], ["jira"]);
  assert.deepEqual(
    {
      email: getJiraSettings().atlassianEmail,
      configured: getJiraSettings().atlassianTokenConfigured,
      site,
    },
    { email: "me@example.com", configured: true, site },
  );
});

test("a write while the gateway runs another for the user: integration_busy reaches Settings as its own text", async () => {
  const { updateJiraSettings } = await import("./jiraSettings.ts");
  // Fake Atlassian tools whose checks the test releases.
  const releases: (() => void)[] = [];
  const tools: EdgeTools = {
    handleMcp: (_req, res) => {
      res.writeHead(404);
      res.end();
    },
    host: { list: () => [], call: () => Promise.reject(new Error("unused")) },
    integrations: {
      atlassian: {
        parse: (input) => {
          const { site, email, token } = input as Record<string, unknown>;
          return typeof site === "string" &&
            typeof email === "string" &&
            typeof token === "string"
            ? {
                ok: true,
                credential: JSON.stringify({ site, email, token }),
                site,
                email,
              }
            : { ok: false };
        },
        check: () =>
          new Promise((resolve) => releases.push(() => resolve({ ok: true }))),
        describe: (credential) => {
          const { site, email } = JSON.parse(credential) as Record<
            string,
            string
          >;
          return site && email ? { site, email } : undefined;
        },
      },
    },
  };
  const gateway = await startGateway({
    stateDir: mkdtempSync(join(DATA_DIR, "edge-")),
    log: () => {},
    clients: {},
    tools,
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("thasso");
  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "devbox"),
  });
  const relay = await startRelay({
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  });
  open.push(relay);
  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  assert.equal(await link.ready, true);

  // The gateway page's set for the same user is still checking.
  const held = gateway.clients!.userOperations.setAtlassian("thasso", {
    site: "x.atlassian.net",
    email: "page@example.com",
    token: "fake-page-token",
  });
  await vi.waitFor(() => assert.equal(releases.length, 1));
  await assert.rejects(
    updateJiraSettings({
      atlassianEmail: "me@example.com",
      atlassianToken: "fake-busy-token",
    }),
    /^Error: Jira: another change to this credential is still running; try again\.$/,
  );
  releases[0]!();
  await held;
});

// --- the gateway's tools (Task-1398) ---------------------------------------

test("the link lists the edge's tools before it is ready, and calls them through relay and edge", async () => {
  const { createEdgeTools } = await import("./gatewayTools/index.ts");
  const gateway = await startGateway({
    stateDir: mkdtempSync(join(DATA_DIR, "edge-")),
    log: () => {},
    clients: {},
    tools: createEdgeTools({ log: () => {} }),
  });
  open.push(gateway);
  gateway.clients!.registry.addUser("thasso");
  const relayDir = mkdtempSync(join(tmpdir(), "relay-"));
  open.push({
    close: () => rmSync(relayDir, { recursive: true, force: true }),
  });
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: gateway.clients!.enrollPort,
    caPem: gateway.clients!.caPem,
    code: gateway.clients!.registry.createCode("thasso", "devbox"),
  });
  const relayOptions = {
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  };
  let relay = await startRelay(relayOptions);
  let changes = 0;
  open.push({ close: subscribeIntegrationToolChanges(() => changes++) });

  const link = startGatewayClientLink({
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  });
  open.push(link);
  await updateJiraSettings({ enabled: true });
  assert.equal(await link.ready, true);
  // Listed before `ready`: the real descriptor, gate on.
  const [listed] = remoteTools.knownRemoteTools("jira");
  assert.equal(listed?.name, "jira_get_issue");
  assert.equal(listed.actionKey, "jira:read");
  assert.deepEqual(listed.inputSchema.required, ["issue"]);
  assert.equal(remoteTools.remoteToolGate("jira"), true);
  assert.ok(changes >= 1);

  // The edge answers with the user's own (absent) credential: its fixed text.
  const port = remoteTools.remoteToolPort()!;
  assert.deepEqual(
    await port.call(
      "jira_get_issue",
      { issue: "OPS-1" },
      new AbortController().signal,
    ),
    {
      ok: false,
      code: "tool_error",
      message:
        "Jira is not connected for this user; connect it in Pandeck's Settings.",
    },
  );

  // A lost connection turns the gate off; the redial lists again.
  const before = changes;
  await relay.close();
  await vi.waitFor(() =>
    assert.equal(remoteTools.remoteToolGate("jira"), false),
  );
  assert.ok(changes > before);
  await assert.rejects(
    port.call("jira_get_issue", {}, new AbortController().signal),
    (err: unknown) =>
      err instanceof remoteTools.RemoteToolRefusal &&
      err.code === "gateway_unavailable",
  );
  relay = await startRelay(relayOptions);
  open.push(relay);
  await vi.waitFor(
    () => assert.equal(remoteTools.remoteToolGate("jira"), true),
    { timeout: 8_000 },
  );
});

type StubHandler = (
  payload: { json?: unknown },
  signal: AbortSignal,
) => Promise<{ json?: unknown }>;

/** A stub edge on a Unix socket: hello, accounts and reconcile, plus `handlers`. */
async function stubEdge(handlers: Record<string, StubHandler>): Promise<{
  socketPath: string;
  connections: InstanceType<typeof WorkerConnection>[];
}> {
  const dir = mkdtempSync(join(tmpdir(), "stub-edge-"));
  const socketPath = join(dir, "edge.sock");
  const connections: InstanceType<typeof WorkerConnection>[] = [];
  const server = net.createServer((socket) => {
    connections.push(
      new WorkerConnection(socketEndpoint(socket), {
        protocol: GATEWAY_CLIENT_PROTOCOL,
        handshake: { role: "server", admit: () => undefined },
        handlers: {
          [CLIENT_METHODS.hello]: () =>
            Promise.resolve(
              encodeClientMessage({ clientId: "c-stub", userId: "u-stub" }),
            ),
          [CLIENT_METHODS.listAccounts]: () =>
            Promise.resolve(encodeClientMessage({ accounts: [] })),
          [CLIENT_METHODS.reconcileWorker]: () =>
            Promise.resolve(encodeClientMessage({ revoked: [] })),
          ...handlers,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  open.push({
    close: async () => {
      for (const connection of connections) connection.end("stub closed");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  });
  return { socketPath, connections };
}

const STUB_TOOL = {
  name: "jira_stub_read",
  description: "A stub read tool.",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  actionKey: "jira:read",
};

function linkTo(socketPath: string) {
  const link = startGatewayClientLink({
    socketPath,
    relayPort: 1,
    log: () => {},
  });
  open.push(link);
  return link;
}

test("a held listing holds `ready`; an edge without tools is ready with none", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: async () => {
      await held;
      return encodeClientMessage({ tools: [STUB_TOOL] });
    },
  });
  const link = linkTo(edge.socketPath);
  let ready = false;
  void link.ready.then(() => (ready = true));
  await vi.waitFor(() => assert.equal(edge.connections.length, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ready, false);
  assert.equal(remoteTools.remoteToolsConnected(), false);
  release();
  assert.equal(await link.ready, true);
  assert.deepEqual(
    remoteTools.knownRemoteTools("jira").map((tool) => tool.name),
    ["jira_stub_read"],
  );
  await link.close();

  const bare = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.reject(
        new WorkerMethodError(
          "tools_unavailable",
          "This gateway runs no tools.",
        ),
      ),
  });
  const second = linkTo(bare.socketPath);
  assert.equal(await second.ready, true);
  assert.deepEqual(remoteTools.knownRemoteTools("jira"), []);
  assert.equal(remoteTools.remoteToolsConnected(), true);
  // The first listing, though empty, lets a pi open go on.
  await remoteTools.remoteToolsReady(10);
});

test("a dial that ends after its listing's answer, or a closing link, publishes nothing", async () => {
  const lines: string[] = [];
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
  });
  // The answer arrives, then the connection ends before the link goes on.
  const request = WorkerConnection.prototype.request;
  let ended = 0;
  const spy = vi
    .spyOn(WorkerConnection.prototype, "request")
    .mockImplementation(async function (
      this: InstanceType<typeof WorkerConnection>,
      method,
      payload,
      signal,
    ) {
      const answer = await request.call(this, method, payload, signal);
      if (method === CLIENT_METHODS.toolsList && ended++ === 0)
        this.end("ended after the listing");
      return answer;
    });
  open.push({ close: () => spy.mockRestore() });
  const link = startGatewayClientLink({
    socketPath: edge.socketPath,
    relayPort: 1,
    log: (line) => lines.push(line),
  });
  open.push(link);
  await vi.waitFor(() => assert.equal(ended, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(link.connectionState(), "connecting");
  assert.equal(remoteTools.remoteToolsConnected(), false);
  assert.deepEqual(remoteTools.knownRemoteTools("jira"), []);
  assert.ok(lines.includes("connection ended: ended after the listing"));
  // The redial publishes.
  assert.equal(await link.ready, true);
  assert.equal(ended, 2);
  assert.equal(remoteTools.remoteToolsConnected(), true);
  await link.close();
  spy.mockRestore();

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let listed = false;
  const slow = await stubEdge({
    [CLIENT_METHODS.toolsList]: async () => {
      await held;
      listed = true;
      return encodeClientMessage({ tools: [STUB_TOOL] });
    },
  });
  const closing = linkTo(slow.socketPath);
  await vi.waitFor(() => assert.equal(slow.connections.length, 1));
  await closing.close();
  release();
  await vi.waitFor(() => assert.ok(listed));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remoteTools.remoteToolsConnected(), false);
  assert.equal(remoteTools.remoteToolPort(), undefined);
});

test("a gateway tool call: the edge's answer, a caller's cancel, and the 40 s bound", async () => {
  const seen: AbortSignal[] = [];
  let answerLate!: () => void;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.toolsCall]: (payload, signal) => {
      const { args } = payload.json as { args: { mode?: string } };
      if (args.mode === "big")
        return Promise.resolve(
          encodeClientMessage({ ok: true, text: "x".repeat(60_000) }),
        );
      seen.push(signal);
      // Never answers on its own; the cancel or the test settles it.
      return new Promise((resolve) => {
        answerLate = () =>
          resolve(encodeClientMessage({ ok: true, text: "late" }));
        if (args.mode === "cancellable")
          signal.addEventListener("abort", () =>
            resolve(
              encodeClientMessage({
                ok: false,
                code: "cancelled",
                message: "The call was cancelled.",
              }),
            ),
          );
      });
    },
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const port = remoteTools.remoteToolPort()!;

  // The maximum answer arrives intact.
  const big = await port.call(
    "jira_stub_read",
    { mode: "big" },
    new AbortController().signal,
  );
  assert.ok(big.ok && big.text.length === 60_000);

  // The caller's abort settles the call and cancels the edge's handler.
  const caller = new AbortController();
  const cancelled = port.call(
    "jira_stub_read",
    { mode: "cancellable" },
    caller.signal,
  );
  await vi.waitFor(() => assert.equal(seen.length, 1));
  caller.abort();
  assert.deepEqual(await cancelled, {
    ok: false,
    code: "cancelled",
    message: "",
  });
  await vi.waitFor(() => assert.ok(seen[0]!.aborted));

  // A silent edge: the call settles at 40 s and sends a cancel.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const silent = port.call(
    "jira_stub_read",
    { mode: "silent" },
    new AbortController().signal,
  );
  // Not `vi.waitFor`: it would advance the faked clock while it polls.
  while (seen.length < 2) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  void silent.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(39_999);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(await silent, { ok: false, code: "timeout", message: "" });
  await vi.waitFor(() => assert.ok(seen[1]!.aborted));
  vi.useRealTimers();
  // Its late answer is dropped unread; the link goes on.
  answerLate();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remoteTools.remoteToolsConnected(), true);
  assert.ok(
    (
      await port.call(
        "jira_stub_read",
        { mode: "big" },
        new AbortController().signal,
      )
    ).ok,
  );
});

test("a malformed listing fails that connect: its dial ends and the redial publishes", async () => {
  let lists = 0;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(
        encodeClientMessage(
          lists++ === 0 ? { tools: "not a list" } : { tools: [STUB_TOOL] },
        ),
      ),
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  assert.equal(lists, 2);
  await vi.waitFor(() => assert.ok(edge.connections[0]!.isEnded));
  assert.equal(edge.connections[1]!.isEnded, false);
  assert.equal(remoteTools.remoteToolsConnected(), true);
});
