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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "gateway-client-home-"));
process.env.HOME = home;

const profiles = await import("./credentialProfiles.ts");
const { GatewayUnavailableError } = await import("./gatewayLink.ts");
const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");
const { DATA_DIR } = await import("./config.ts");
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
