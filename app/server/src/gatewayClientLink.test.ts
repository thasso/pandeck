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
const { updateSlackSettings } = await import("./slackSettings.ts");
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
    host: {
      list: () => [],
      callForClient: () => Promise.reject(new Error("unused")),
      prepare: () => Promise.reject(new Error("unused")),
      apply: () => Promise.reject(new Error("unused")),
    },
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
          return site && email ? { site, email, kind: "token" } : undefined;
        },
      },
      slack: { describe: () => undefined },
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
  updateSlackSettings({ enabled: true });
  open.push({ close: () => updateSlackSettings({ enabled: false }) });
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

  // The edge's four Slack reads (Task-1455), in its listing order.
  assert.deepEqual(
    remoteTools.knownRemoteTools("slack").map((tool) => tool.name),
    [
      "slack_search",
      "slack_conversation_read",
      "slack_thread_read",
      "slack_unread",
    ],
  );
  assert.equal(remoteTools.remoteToolGate("slack"), true);
  assert.deepEqual(
    await port.call(
      "slack_search",
      { query: "x" },
      new AbortController().signal,
    ),
    {
      ok: false,
      code: "tool_error",
      message:
        "Slack is not connected for this user; connect it on the gateway's page.",
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

test("the real edge listing gives client mode exactly the three Confluence reads, the download and the two writes (Task-1463 P6b, Task-1441 P7a)", async () => {
  // The edge's own listing, as its `tools.list` answers it (Task-1439 P2).
  const { createEdgeTools } = await import("./gatewayTools/index.ts");
  const { host } = createEdgeTools({ log: () => {} });
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: host.list() })),
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  assert.deepEqual(
    remoteTools
      .knownRemoteTools("confluence")
      .map((tool) => [tool.name, tool.actionKey]),
    [
      ["confluence_search", "confluence:read"],
      ["confluence_get_page", "confluence:read"],
      ["confluence_lookup", "confluence:read"],
      ["confluence_download_attachment", "confluence:read"],
      ["confluence_mutate_page", "confluence:write"],
    ],
  );
  // The file tool keeps the edge's limits, which FILE_TOOLS admits.
  const download = remoteTools
    .knownRemoteTools("confluence")
    .find((tool) => tool.name === "confluence_download_attachment");
  assert.deepEqual(download && "file" in download && download.file, {
    limitParam: "maxBytes",
    defaultBytes: 50 * 1024 * 1024,
    maxBytes: 100 * 1024 * 1024,
  });
  assert.deepEqual(
    remoteTools
      .knownRemoteTools("jira")
      .filter((tool) => tool.effect === "write"),
    [
      {
        name: "jira_mutate_issue",
        effect: "write",
        actionKey: "jira:write",
        product: "jira",
        kind: "jiraIssue",
        twoPhase: true,
      },
    ],
  );
});

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

test("a gateway write's prepare: the edge's answer and refusal, an undecodable answer, an error answer, a caller's cancel and the 40 s bound (Task-1463 P6b)", async () => {
  const seen: AbortSignal[] = [];
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.toolsPrepare]: (payload, signal) => {
      const { name, args } = payload.json as {
        name: string;
        args: { mode?: string };
      };
      assert.equal(name, "jira_mutate_issue");
      switch (args.mode) {
        case "ok":
          return Promise.resolve(
            encodeClientMessage({
              ok: true,
              site: "acme.atlassian.net",
              items: [{ issueKey: "OPS-1" }],
              warnings: ["w"],
            }),
          );
        case "refused":
          return Promise.resolve(
            encodeClientMessage({
              ok: false,
              code: "tool_error",
              message: "Refused. Nothing was written.",
            }),
          );
        case "malformed":
          return Promise.resolve(
            encodeClientMessage({ ok: true, site: 7, items: [], warnings: [] }),
          );
        case "unavailable":
          return Promise.reject(
            new WorkerMethodError("tools_unavailable", "no tools"),
          );
        case "invalid":
          return Promise.reject(new WorkerMethodError("invalid_params", "bad"));
        default:
          seen.push(signal);
          return new Promise(() => {});
      }
    },
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const port = remoteTools.remoteToolPort()!;
  const prepare = (mode: string, signal = new AbortController().signal) =>
    port.prepare("jira_mutate_issue", { mode }, signal);

  assert.deepEqual(await prepare("ok"), {
    ok: true,
    site: "acme.atlassian.net",
    items: [{ issueKey: "OPS-1" }],
    warnings: ["w"],
  });
  assert.deepEqual(await prepare("refused"), {
    ok: false,
    code: "tool_error",
    message: "Refused. Nothing was written.",
  });
  // A decoder refusal is told apart from a transport failure.
  await assert.rejects(prepare("malformed"), (err: unknown) => {
    assert.ok(err instanceof remoteTools.RemoteToolRefusal);
    assert.equal(err.code, "undecodable");
    return true;
  });
  await assert.rejects(prepare("unavailable"), (err: unknown) => {
    assert.ok(err instanceof remoteTools.RemoteToolRefusal);
    assert.equal(err.code, "tools_unavailable");
    return true;
  });
  await assert.rejects(prepare("invalid"), (err: unknown) => {
    assert.ok(err instanceof remoteTools.RemoteToolRefusal);
    assert.equal(err.code, "gateway_unavailable");
    return true;
  });

  const caller = new AbortController();
  const cancelled = prepare("hang", caller.signal);
  await vi.waitFor(() => assert.equal(seen.length, 1));
  caller.abort();
  assert.deepEqual(await cancelled, {
    ok: false,
    code: "cancelled",
    message: "",
  });
  await vi.waitFor(() => assert.ok(seen[0]!.aborted));

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const silent = prepare("hang");
  while (seen.length < 2) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  void silent.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(39_999);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(await silent, { ok: false, code: "timeout", message: "" });
  await vi.waitFor(() => assert.ok(seen[1]!.aborted));
  vi.useRealTimers();
});

test("a gateway write's apply: an answer, an undecodable answer, an error answer and a lost connection may have written; not sent only without a connection (Task-1463 P6b, D2)", async () => {
  const applied: { name: string; site: string; items: unknown[] }[] = [];
  let edgeRef!: Awaited<ReturnType<typeof stubEdge>>;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.toolsApply]: (payload) => {
      const request = payload.json as {
        name: string;
        site: string;
        items: { mode: string }[];
      };
      applied.push(request);
      switch (request.items[0]!.mode) {
        case "ok":
          return Promise.resolve(
            encodeClientMessage({
              ok: true,
              results: [{ effects: "possible" }],
              effects: "possible",
            }),
          );
        case "failed":
          return Promise.resolve(
            encodeClientMessage({
              ok: false,
              code: "tool_error",
              message: "Site changed.",
              effects: "none",
            }),
          );
        case "malformed":
          // A root `none` beside a `possible` record is undecodable.
          return Promise.resolve(
            encodeClientMessage({
              ok: true,
              results: [{ effects: "possible" }],
              effects: "none",
            }),
          );
        case "error":
          return Promise.reject(new WorkerMethodError("invalid_params", "bad"));
        case "drop":
          edgeRef.connections.at(-1)!.end("dropped mid-apply");
          return new Promise(() => {});
      }
      return new Promise(() => {});
    },
  });
  edgeRef = edge;
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const port = remoteTools.remoteToolPort()!;
  const apply = (mode: string) =>
    port.apply("jira_mutate_issue", "acme.atlassian.net", [{ mode }]);

  assert.deepEqual(await apply("ok"), {
    outcome: "answer",
    answer: {
      ok: true,
      results: [{ effects: "possible" }],
      effects: "possible",
    },
  });
  assert.deepEqual(applied[0], {
    name: "jira_mutate_issue",
    site: "acme.atlassian.net",
    items: [{ mode: "ok" }],
  });
  // A decoded failed answer is the edge's certificate, passed through whole:
  // its `effects` decides what the executor may claim (D6(i), M2).
  assert.deepEqual(await apply("failed"), {
    outcome: "answer",
    answer: {
      ok: false,
      code: "tool_error",
      message: "Site changed.",
      effects: "none",
    },
  });
  assert.deepEqual(await apply("malformed"), { outcome: "undecodable" });
  // An error answer (a `WorkerRequestError` frame, D2) instead of an apply
  // answer is lost: it may have written.
  assert.deepEqual(await apply("error"), { outcome: "lost" });
  // The connection ends after the request left: it may have written.
  assert.deepEqual(await apply("drop"), { outcome: "lost" });
  // No published connection: the edge provably never saw it.
  await vi.waitFor(() =>
    assert.equal(remoteTools.remoteToolsConnected(), false),
  );
  const before = applied.length;
  assert.deepEqual(await apply("ok"), { outcome: "notSent" });
  assert.equal(applied.length, before);
});

test("a gateway write's apply is bounded at 55 s without a caller signal; it sends a cancel and drops the late answer (Task-1463 P6b)", async () => {
  const seen: AbortSignal[] = [];
  let answerLate!: () => void;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.toolsApply]: (_payload, signal) => {
      seen.push(signal);
      return new Promise((resolve) => {
        answerLate = () =>
          resolve(
            encodeClientMessage({
              ok: true,
              results: [{}],
              effects: "possible",
            }),
          );
      });
    },
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const port = remoteTools.remoteToolPort()!;

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const silent = port.apply("jira_mutate_issue", "acme.atlassian.net", [{}]);
  while (seen.length < 1) await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  void silent.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(54_999);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(await silent, { outcome: "timeout" });
  await vi.waitFor(() => assert.ok(seen[0]!.aborted));
  vi.useRealTimers();
  answerLate();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(remoteTools.remoteToolsConnected(), true);
});

test("a gateway card whose apply times out fails MAY_HAVE_WRITTEN; a late answer, valid in every other way, changes neither the card nor its broadcasts (Task-1463 P6b)", async () => {
  await import("./tools/jira/jiraTools.ts");
  const { sessionStore } = await import("./db/sessionStore.ts");
  const approvals = await import("./pendingApprovals.ts");
  const { checkJiraResult } = await import("./jiraMutationResult.ts");
  const { createEdgeTools } = await import("./gatewayTools/index.ts");
  const { host } = createEdgeTools({ log: () => {} });
  const item = {
    clientId: "item-1",
    issueKey: "OPS-1",
    operation: "comment" as const,
    commentBody: "Hi",
    fieldChanges: [],
  };
  // The answer the edge gives too late: it would pass every client check.
  const lateRecord = { effects: "possible" as const, resultIssueKey: "OPS-1" };
  assert.ok(checkJiraResult(lateRecord, item, "acme.atlassian.net"));
  let applies = 0;
  let answerLate!: () => void;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: host.list() })),
    [CLIENT_METHODS.toolsApply]: () => {
      applies++;
      return new Promise((resolve) => {
        answerLate = () =>
          resolve(
            encodeClientMessage({
              ok: true,
              effects: "possible",
              results: [lateRecord],
            }),
          );
      });
    },
  });
  await updateJiraSettings({ enabled: true });
  open.push({ close: () => updateJiraSettings({ enabled: false }) });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);

  const sessionId = "late-apply-session";
  sessionStore.upsert({
    id: sessionId,
    harness: "pi",
    agentType: "assistant",
    title: sessionId,
  });
  let broadcasts = 0;
  approvals.setApprovalBroadcastForTests(() => broadcasts++);
  open.push({ close: () => approvals.setApprovalBroadcastForTests(null) });
  const card = approvals.createApproval({
    sessionId,
    kind: "jiraIssue",
    title: "Comment on OPS-1",
    body: {
      kind: "jiraIssue",
      jiraHost: "acme.atlassian.net",
      items: [structuredClone(item)],
    },
    context: { via: "gateway" },
  });

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const decided = approvals.resolveApproval(card.id, "approved");
  while (applies < 1) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(55_000);
  const { card: failed } = await decided;
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /^The gateway did not confirm the result\./);
  const atFailure = structuredClone(approvals.approvalForId(card.id)!);
  const broadcastsAtFailure = broadcasts;
  vi.useRealTimers();

  answerLate();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(approvals.approvalForId(card.id), atFailure);
  assert.equal(broadcasts, broadcastsAtFailure);
  assert.equal(remoteTools.remoteToolsConnected(), true);
});

test("an upload's apply timer is the edge's deadline plus 10 s, at most 155 s (Task-1441 P8a, AC9)", async () => {
  const { uploadApplyCallMs } = await import("./gatewayClientLink.ts");
  const { uploadApplyDeadlineMs } = await import("./gatewayTools/uploads.ts");
  const MIB = 1024 * 1024;
  const table = [
    [1, 46_000, 56_000],
    [MIB, 46_000, 56_000],
    [MIB + 1, 47_000, 57_000],
    [50 * MIB, 95_000, 105_000],
    [100 * MIB, 145_000, 155_000],
  ];
  for (const [work, edge, pandeck] of table) {
    assert.equal(uploadApplyDeadlineMs(work!), edge, `edge at ${work}`);
    assert.equal(uploadApplyCallMs(work!), pandeck, `Pandeck at ${work}`);
    assert.equal(
      uploadApplyCallMs(work!),
      uploadApplyDeadlineMs(work!) + 10_000,
    );
  }
});

test("an upload's apply carries its uploadId and is bounded by the upload timer, not 55 s (Task-1441 P8a, AC9)", async () => {
  const payloads: unknown[] = [];
  const seen: AbortSignal[] = [];
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.toolsApply]: (payload, signal) => {
      payloads.push(payload.json);
      seen.push(signal);
      return new Promise(() => {});
    },
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const port = remoteTools.remoteToolPort()!;

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const uploadId = `upl-${"a".repeat(32)}`;
  const silent = port.apply(
    "confluence_mutate_page",
    "acme.atlassian.net",
    [{}],
    {
      uploadId,
      work: 100 * 1024 * 1024,
    },
  );
  while (seen.length < 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(payloads, [
    {
      name: "confluence_mutate_page",
      site: "acme.atlassian.net",
      items: [{}],
      uploadId,
    },
  ]);
  let settled = false;
  void silent.then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(154_999);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(await silent, { outcome: "timeout" });
  await vi.waitFor(() => assert.ok(seen[0]!.aborted));
});

test("the upload methods: exact requests, the chunk as the one bytes stream, refusals as text, a bad answer and the 30 s bound (Task-1441 P8a)", async () => {
  const requests: { method: string; json: unknown; bytes: string[] }[] = [];
  const uploadId = `upl-${"b".repeat(32)}`;
  let putAnswer: () => Promise<{ json?: unknown }> = () =>
    Promise.resolve(
      encodeClientMessage({
        ok: true,
        received: 3,
        streamComplete: true,
        sealed: true,
      }),
    );
  let openAnswer: () => Promise<{ json?: unknown }> = () =>
    Promise.resolve(encodeClientMessage({ ok: true, uploadId }));
  const record =
    (method: string, answer: () => Promise<{ json?: unknown }>): StubHandler =>
    (payload) => {
      const bytes = (payload as { bytes?: Record<string, Uint8Array> }).bytes;
      requests.push({
        method,
        json: payload.json,
        bytes: Object.entries(bytes ?? {}).map(
          ([name, value]) => `${name}:${Buffer.from(value).toString()}`,
        ),
      });
      return answer();
    };
  const released: unknown[] = [];
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsList]: () =>
      Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
    [CLIENT_METHODS.uploadsOpen]: record("open", () => openAnswer()),
    [CLIENT_METHODS.uploadsPut]: record("put", () => putAnswer()),
    [CLIENT_METHODS.uploadsRelease]: (payload) => {
      released.push(payload.json);
      return Promise.resolve(encodeClientMessage({ ok: true }));
    },
  });
  const link = linkTo(edge.socketPath);
  assert.equal(await link.ready, true);
  const { uploads } = remoteTools.remoteToolPort()!;
  const stream = {
    stagedAttachmentId: "p8a-0123456789abcdef",
    size: 3,
    sha256: "c".repeat(64),
  };

  assert.deepEqual(await uploads.open([stream], 6), { ok: true, uploadId });
  assert.deepEqual(
    await uploads.put(
      uploadId,
      stream.stagedAttachmentId,
      0,
      Buffer.from("abc"),
    ),
    { ok: true, received: 3, streamComplete: true, sealed: true },
  );
  uploads.release(uploadId);
  await vi.waitFor(() => assert.deepEqual(released, [{ uploadId }]));
  assert.deepEqual(requests, [
    { method: "open", json: { streams: [stream], work: 6 }, bytes: [] },
    {
      method: "put",
      json: {
        uploadId,
        stagedAttachmentId: stream.stagedAttachmentId,
        offset: 0,
      },
      bytes: ["chunk:abc"],
    },
  ]);

  // The edge's fixed refusal is text; anything else is undecodable.
  const BUSY =
    "The gateway is already transferring a file; try again when it finishes. Nothing was uploaded.";
  openAnswer = () =>
    Promise.resolve(
      encodeClientMessage({ ok: false, code: "tool_error", message: BUSY }),
    );
  assert.deepEqual(await uploads.open([stream], 3), {
    ok: false,
    message: BUSY,
  });
  putAnswer = () =>
    Promise.resolve(
      encodeClientMessage({
        ok: true,
        received: 3,
        streamComplete: false,
        sealed: true,
      }),
    );
  await assert.rejects(
    uploads.put(uploadId, stream.stagedAttachmentId, 0, Buffer.from("abc")),
    (err: unknown) => err instanceof remoteTools.RemoteToolRefusal,
  );

  // A put the edge never answers fails at 30 s.
  let heard = 0;
  putAnswer = () => {
    heard += 1;
    return new Promise(() => {});
  };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  open.push({ close: () => vi.useRealTimers() });
  const silent = uploads.put(
    uploadId,
    stream.stagedAttachmentId,
    0,
    Buffer.from("abc"),
  );
  let failed = false;
  silent.catch(() => (failed = true));
  while (heard < 1) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(29_999);
  assert.equal(failed, false);
  await vi.advanceTimersByTimeAsync(1);
  await assert.rejects(silent);
});
