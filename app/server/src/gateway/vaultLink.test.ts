/**
 * The vault as its own process (plan Task-1394): an edge with a remote vault
 * over `gateway-vault/1.0` on loopback mutual TLS, both in this process,
 * against fake upstreams. Token files live only in the vault's state
 * directory. Every value is fake.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  CLAUDE_ACCESS,
  CLAUDE_PATH,
  CODEX_ACCESS,
  CODEX_ACCOUNT,
  CODEX_PATH,
  fakeClaudeStream,
  fakeCodexStream,
  modelRequest,
  startFakeUpstreams,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import { encodeControlFrame, encodeMessage } from "../workerProtocol/codec.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { startGateway, type RunningGateway } from "./gateway.ts";
import type { LeaseProvider } from "./leases.ts";
import { loginChildDriver } from "./loginChild.ts";
import { refusalText } from "./refusals.ts";
import { openRecord, parseSealedRecord, softwareEcdh } from "./sealedRecord.ts";
import { recipientOf, sealExisting, writeRecipients } from "./sealedStore.ts";
import { askVaultControl } from "./vaultControl.ts";
import { createRemoteVault, type RemoteVault } from "./remoteVault.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  GATEWAY_VAULT_VERSION,
  LOGIN_CREDENTIAL_FILE,
  isPinnedPeer,
} from "./vaultMethods.ts";
import type { CodexRenewPort } from "./renewal.ts";
import type { LoginDrivers, LoginRun } from "./vaultPort.ts";
import { startVaultServer, type RunningVaultServer } from "./vaultServer.ts";
import { selfSignedIdentity, type PinnedIdentity } from "./x509.ts";

const root = mkdtempSync(join(tmpdir(), "vault-link-"));
let upstreams: FakeUpstreams;
let vaultId: PinnedIdentity;
let edgeId: PinnedIdentity;
const open: { close(): unknown }[] = [];

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claude: fakeClaudeStream("hi"),
    codex: fakeCodexStream("hello"),
  });
  vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

afterAll(async () => {
  await upstreams.close();
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const expires = () => Date.now() + 3_600_000;

/** A token file of `kind` for `accountId` in the vault's accounts. */
function writeAccountFile(
  vaultDir: string,
  kind: LeaseProvider,
  accountId: string,
): string {
  const file = join(
    vaultDir,
    "accounts",
    accountId,
    LOGIN_CREDENTIAL_FILE[kind],
  );
  mkdirSync(join(vaultDir, "accounts", accountId), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      kind === "claude"
        ? {
            claudeAiOauth: { accessToken: CLAUDE_ACCESS, expiresAt: expires() },
          }
        : {
            "openai-codex": {
              type: "oauth",
              access: CODEX_ACCESS,
              accountId: CODEX_ACCOUNT,
              expires: expires(),
            },
          },
    ),
  );
  return file;
}

interface Vault extends RunningVaultServer {
  dir: string;
  lines: string[];
}

async function vault(
  options: {
    dir?: string;
    port?: number;
    peer?: PinnedIdentity;
    self?: PinnedIdentity;
    drivers?: LoginDrivers;
    loginTimeoutMs?: number;
    controlSocket?: string;
    renewCodex?: CodexRenewPort;
  } = {},
): Promise<Vault> {
  const dir = options.dir ?? mkdtempSync(join(root, "vault-"));
  const lines: string[] = [];
  const self = options.self ?? vaultId;
  const running = await startVaultServer({
    stateDir: dir,
    port: options.port ?? 0,
    tls: {
      keyPem: self.keyPem,
      certPem: self.certPem,
      peerCertPem: (options.peer ?? edgeId).certPem,
    },
    ...(options.drivers ? { loginDrivers: options.drivers } : {}),
    ...(options.loginTimeoutMs
      ? { loginTimeoutMs: options.loginTimeoutMs }
      : {}),
    ...(options.controlSocket ? { controlSocket: options.controlSocket } : {}),
    ...(options.renewCodex ? { renewCodex: options.renewCodex } : {}),
    log: (line) => lines.push(line),
  });
  open.push(running);
  return Object.assign(running, { dir, lines });
}

const linkTls = (
  self: PinnedIdentity = edgeId,
  peer: PinnedIdentity = vaultId,
) => ({
  keyPem: self.keyPem,
  certPem: self.certPem,
  peerCertPem: peer.certPem,
});

async function edge(
  vaultPort: number,
): Promise<RunningGateway & { lines: string[] }> {
  const lines: string[] = [];
  const gw = await startGateway({
    stateDir: mkdtempSync(join(root, "edge-")),
    upstreams: upstreams.overrides,
    clients: {},
    vault: { host: "127.0.0.1", port: vaultPort, tls: linkTls() },
    log: (line) => lines.push(line),
  });
  open.push(gw);
  gw.clients!.registry.addUser("u1");
  return Object.assign(gw, { lines });
}

/** Registers a login account on the edge and grants it a lease. */
function account(
  gw: RunningGateway,
  id: string,
  provider: LeaseProvider,
  tokenFile: string,
): string {
  gw.clients!.putAccount({
    id,
    provider,
    name: id,
    enabled: true,
    tokenFile,
    userId: "u1",
  });
  return gw.leases.grant(
    { profileId: id, provider, tokenFile },
    { kind: "engine", owner: { workerId: "w1" } },
  ).token;
}

const linkUp = (gw: { lines: string[] }) => () =>
  gw.lines.some((line) => line.startsWith("vault link up"));

test("an edge with a remote vault forwards Claude and Codex requests", async () => {
  const v = await vault();
  const claudeFile = writeAccountFile(v.dir, "claude", "claude-a");
  const codexFile = writeAccountFile(v.dir, "openai-codex", "codex-a");
  const gw = await edge(v.port);
  await until(linkUp(gw), "the vault link");
  const claudeToken = account(gw, "claude-a", "claude", claudeFile);
  const codexToken = account(gw, "codex-a", "openai-codex", codexFile);

  const claude = await modelRequest(gw.port, CLAUDE_PATH, claudeToken);
  assert.equal(claude.status, 200);
  assert.equal(
    upstreams.anthropic.at(-1)?.headers.authorization,
    `Bearer ${CLAUDE_ACCESS}`,
  );
  const codex = await modelRequest(gw.port, CODEX_PATH, codexToken);
  assert.equal(codex.status, 200);
  const seen = upstreams.chatgpt.at(-1)!.headers;
  assert.equal(seen.authorization, `Bearer ${CODEX_ACCESS}`);
  assert.equal(seen["chatgpt-account-id"], CODEX_ACCOUNT);

  // The vault mirrored both inputs and saved them.
  const saved = JSON.parse(
    readFileSync(join(v.dir, "vault-inputs.json"), "utf8"),
  ) as { profiles: { id: string }[]; liveLeases: string[] };
  assert.deepEqual(saved.profiles.map((p) => p.id).sort(), [
    "claude-a",
    "codex-a",
  ]);
  assert.deepEqual(saved.liveLeases.sort(), ["claude-a", "codex-a"]);
  for (const line of [...gw.lines, ...v.lines]) {
    assert.ok(!line.includes(CLAUDE_ACCESS), line);
    assert.ok(!line.includes(CODEX_ACCESS), line);
  }
});

test("link down answers the marked vault-unavailable refusal; a restarted vault serves again", async () => {
  const v = await vault();
  const claudeFile = writeAccountFile(v.dir, "claude", "claude-a");
  const gw = await edge(v.port);
  await until(linkUp(gw), "the vault link");
  const token = account(gw, "claude-a", "claude", claudeFile);
  assert.equal((await modelRequest(gw.port, CLAUDE_PATH, token)).status, 200);

  await v.close();
  open.splice(open.indexOf(v), 1);
  await until(
    () => gw.lines.some((line) => line.startsWith("vault link ended")),
    "the link to end",
  );
  const before = upstreams.anthropic.length;
  const down = await modelRequest(gw.port, CLAUDE_PATH, token);
  assert.equal(down.status, 503);
  assert.match(down.text, /Pandeck gateway:/);
  assert.ok(
    down.text.includes(refusalText({ case: "vault-unavailable" })),
    down.text,
  );
  assert.equal(upstreams.anthropic.length, before);

  // The restarted vault keeps the mirrored inputs; the edge redials.
  const again = await vault({ dir: v.dir, port: v.port });
  await until(
    () => again.lines.includes("edge connected"),
    "the edge to reconnect",
  );
  await until(
    () =>
      gw.lines.filter((line) => line.startsWith("vault link up")).length === 2,
    "the link up again",
  );
  assert.equal((await modelRequest(gw.port, CLAUDE_PATH, token)).status, 200);
});

test("the vault refuses a binding outside its accounts directory", async () => {
  const v = await vault();
  const gw = await edge(v.port);
  await until(linkUp(gw), "the vault link");
  // A valid credential, but not the vault's to keep.
  const outside = join(
    mkdtempSync(join(root, "outside-")),
    ".credentials.json",
  );
  writeFileSync(
    outside,
    JSON.stringify({
      claudeAiOauth: { accessToken: CLAUDE_ACCESS, expiresAt: expires() },
    }),
  );
  const token = account(gw, "claude-x", "claude", outside);
  const before = upstreams.anthropic.length;
  const refused = await modelRequest(gw.port, CLAUDE_PATH, token);
  assert.equal(refused.status, 403);
  assert.ok(refused.text.includes(refusalText({ case: "forbidden" })));
  assert.equal(upstreams.anthropic.length, before);
  await until(
    () => v.lines.some((line) => line.includes("profiles not kept")),
    "the vault to drop the profile",
  );
});

test("the link's pin: exactly the pinned certificate, inside its dates, else refused", () => {
  const cert = new X509Certificate(edgeId.certPem);
  const peer = (presented: object) => ({
    getPeerCertificate: () => presented as tls.PeerCertificate,
  });
  const pinned = {
    fingerprint256: cert.fingerprint256,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
  };
  const now = Date.now();
  assert.equal(isPinnedPeer(peer(pinned), cert.fingerprint256, now), true);
  // No certificate, another one, expired, not yet valid.
  assert.equal(isPinnedPeer(peer({}), cert.fingerprint256, now), false);
  assert.equal(
    isPinnedPeer(
      peer({ ...pinned, fingerprint256: "AA:BB" }),
      cert.fingerprint256,
      now,
    ),
    false,
  );
  assert.equal(
    isPinnedPeer(
      peer(pinned),
      cert.fingerprint256,
      Date.parse(cert.validTo) + 1000,
    ),
    false,
  );
  assert.equal(
    isPinnedPeer(
      peer(pinned),
      cert.fingerprint256,
      Date.parse(cert.validFrom) - 1000,
    ),
    false,
  );
});

test("an unpinned client or server certificate is refused", async () => {
  // Self-signed with the same subject as the pinned one: only the pin differs.
  const stranger = selfSignedIdentity("pandeck-gateway-edge", "client");
  const v = await vault();
  const deps = {
    profiles: () => [],
    liveLeases: () => [],
    report: () => {},
    log: () => {},
  };
  // The edge's certificate is not the one the vault pins.
  const unpinnedClient = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls(stranger) },
    deps,
  );
  open.push(unpinnedClient);
  // The vault's certificate is not the one the edge pins.
  const otherVault = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "127.0.0.1",
  ]);
  const unpinnedServer = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls(edgeId, otherVault) },
    deps,
  );
  open.push(unpinnedServer);
  await until(
    () => v.lines.some((line) => line.startsWith("edge connection refused")),
    "the vault to refuse",
  );
  await delay(300);
  assert.equal(unpinnedClient.connected(), false);
  assert.equal(unpinnedServer.connected(), false);
  assert.ok(!v.lines.includes("edge connected"));
  const credential = await unpinnedServer.credentialFor({
    profileId: "claude-a",
    provider: "claude",
    tokenFile: join(v.dir, "accounts", "claude-a", ".credentials.json"),
  });
  assert.deepEqual(credential, {
    ok: false,
    refusal: { case: "vault-unavailable" },
  });
  // No client certificate at all: the pin refuses it before any frame.
  const unpinned = () =>
    v.lines.filter((line) => line.endsWith("unpinned certificate")).length;
  const before = unpinned();
  const bare = tls.connect({
    host: "127.0.0.1",
    port: v.port,
    ca: vaultId.certPem,
    checkServerIdentity: () => undefined,
  });
  bare.on("error", () => {});
  let received = 0;
  bare.on("data", (chunk: Buffer) => (received += chunk.length));
  await new Promise((resolve) => bare.once("close", resolve));
  assert.equal(unpinned(), before + 1);
  assert.equal(received, 0, "the vault answered an unpinned peer");
  assert.ok(!v.lines.includes("edge connected"));
});

test("a login runs on the vault through the link: events, input, cancel, withdraw", async () => {
  const cancelled: string[] = [];
  /** Settles a driver from the test, as the user's approval would. */
  const finishers = new Map<string, (token: string) => void>();
  const fakeClaude: NonNullable<LoginDrivers["claude"]> = (dir, events) => {
    let settle!: { resolve: () => void; reject: (err: Error) => void };
    const done = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const finish = (token: string) => {
      writeFileSync(
        join(dir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: token, expiresAt: expires() },
        }),
      );
      settle.resolve();
    };
    finishers.set(dir, finish);
    events.output("Paste code: ");
    events.url("https://claude.example/oauth");
    return {
      input: (text) => finish(`claude-${text}`),
      // Records the cancel but finishes anyway: only withdrawal stops it.
      cancel: () => cancelled.push(dir),
      done,
    };
  };
  const v = await vault({ drivers: { claude: fakeClaude } });
  const accounts = new Map<string, string>();
  const remote: RemoteVault = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls() },
    {
      profiles: () =>
        [...accounts].map(([id, tokenFile]) => ({
          id,
          provider: "claude" as const,
          name: id,
          enabled: true,
          tokenFile,
        })),
      liveLeases: () => [],
      report: () => {},
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  assert.equal(
    remote.login(
      {
        kind: "openai-codex",
        accountId: "x",
        tokenFile: "/x",
        commit: () => true,
      },
      { output() {}, url() {}, code() {} },
    ),
    undefined,
  );

  const start = (accountId: string) => {
    const tokenFile = remote.newTokenFile("claude", accountId);
    accounts.set(accountId, tokenFile);
    remote.inputsChanged();
    const seen: string[] = [];
    const run = remote.login(
      { kind: "claude", accountId, tokenFile, commit: () => true },
      {
        output: (text) => seen.push(`output:${text}`),
        url: (url) => seen.push(`url:${url}`),
        code: (code) => seen.push(`code:${code}`),
      },
    ) as LoginRun;
    assert.ok(run);
    return { run, seen, tokenFile };
  };

  // Events and input: the credential lands in the vault's token file.
  const a = start("claude-a");
  await until(() => a.seen.length === 2, "the login's events");
  assert.deepEqual(a.seen, [
    "output:Paste code: ",
    "url:https://claude.example/oauth",
  ]);
  assert.ok(a.tokenFile.startsWith(join(v.dir, "accounts")));
  a.run.input("abc");
  await a.run.done;
  assert.match(readFileSync(a.tokenFile, "utf8"), /claude-abc/);

  // Cancel withdraws: a driver that finishes anyway commits nothing.
  const b = start("claude-b");
  await until(() => b.seen.length === 2, "the second login's events");
  b.run.cancel();
  await until(() => cancelled.length === 1, "the cancel to reach the driver");
  finishers.get(cancelled[0]!)!("late");
  await assert.rejects(b.run.done, /cancelled/);
  assert.equal(existsSync(b.tokenFile), false);
});

// --- review fixes (C1-C5) ---------------------------------------------------

const SENTINEL = "access_token=sentinel-c3";

/** A raw TLS socket with the pinned edge certificate, past the handshake. */
async function rawEdge(port: number): Promise<tls.TLSSocket> {
  const socket = tls.connect({
    host: "127.0.0.1",
    port,
    key: edgeId.keyPem,
    cert: edgeId.certPem,
    ca: vaultId.certPem,
    checkServerIdentity: () => undefined,
  });
  socket.on("error", () => {});
  socket.resume();
  await new Promise((resolve) => socket.once("secureConnect", resolve));
  socket.write(
    encodeControlFrame({
      type: "hello",
      workerId: "raw",
      version: GATEWAY_VAULT_VERSION,
    }),
  );
  return socket;
}

const closed = (socket: net.Socket) =>
  new Promise<void>((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });

/** One fake Claude driver per test: input finishes the login. */
function claudeDriver() {
  const cancelled: string[] = [];
  const driver: NonNullable<LoginDrivers["claude"]> = (dir, events) => {
    let resolveDone!: () => void;
    let rejectDone!: (err: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    events.output("Paste code: ");
    return {
      input: (text) => {
        writeFileSync(
          join(dir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: `claude-${text}`,
              expiresAt: expires(),
            },
          }),
        );
        resolveDone();
      },
      cancel: () => {
        cancelled.push(dir);
        rejectDone(new Error(`stopped ${SENTINEL}`));
      },
      done,
    };
  };
  return { driver, cancelled };
}

/** A remote vault whose registry holds every account a login is started for. */
async function loginLink(v: Vault) {
  const accounts = new Map<string, string>();
  const remote = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls() },
    {
      profiles: () =>
        [...accounts].map(([id, tokenFile]) => ({
          id,
          provider: "claude" as const,
          name: id,
          enabled: true,
          tokenFile,
        })),
      liveLeases: () => [],
      report: () => {},
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  const start = (accountId: string, commit: () => boolean = () => true) => {
    const tokenFile = remote.newTokenFile("claude", accountId);
    accounts.set(accountId, tokenFile);
    remote.inputsChanged();
    const run = remote.login(
      { kind: "claude", accountId, tokenFile, commit },
      { output() {}, url() {}, code() {} },
    )!;
    assert.ok(run);
    run.done.catch(() => {});
    return { run, tokenFile };
  };
  return { remote, start };
}

test("C1: the vault ends a link that streams a message over its bounds", async () => {
  const v = await vault();
  const socket = await rawEdge(v.port);
  // One request's data frames, 3 MiB in all, never completed.
  const frames = encodeMessage(
    "request",
    1,
    { method: "vault.hello" },
    { json: "x".repeat(3 * 1024 * 1024) },
  );
  for (const frame of frames.slice(0, -1)) socket.write(frame);
  await closed(socket);
  await until(
    () => v.lines.includes("edge disconnected (protocol)"),
    "the vault to end the link",
  );
  // Only that connection: an edge still connects and forwards.
  const claudeFile = writeAccountFile(v.dir, "claude", "claude-a");
  const gw = await edge(v.port);
  await until(linkUp(gw), "the vault link");
  const token = account(gw, "claude-a", "claude", claudeFile);
  assert.equal((await modelRequest(gw.port, CLAUDE_PATH, token)).status, 200);
});

test("C3: no peer text from a malformed frame or unknown method reaches logs or replies", async () => {
  const v = await vault();
  // A frame whose type is peer text.
  const socket = await rawEdge(v.port);
  const head = Buffer.from(JSON.stringify({ type: `SECRET?${SENTINEL}` }));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(head.length, 0);
  prefix.writeUInt32BE(0, 4);
  await delay(50);
  socket.write(Buffer.concat([prefix, head]));
  await closed(socket);
  await until(
    () => v.lines.includes("edge disconnected (protocol)"),
    "the vault to end the link",
  );

  // An unknown method: the reply is fixed.
  const tlsSocket = tls.connect({
    host: "127.0.0.1",
    port: v.port,
    key: edgeId.keyPem,
    cert: edgeId.certPem,
    ca: vaultId.certPem,
    checkServerIdentity: () => undefined,
  });
  await new Promise((resolve) => tlsSocket.once("secureConnect", resolve));
  const connection = new WorkerConnection(socketEndpoint(tlsSocket), {
    handshake: { role: "worker", workerId: "raw" },
    protocol: GATEWAY_VAULT_PROTOCOL,
  });
  open.push({ close: () => connection.end("test done") });
  await assert.rejects(
    connection.request(`SECRET.${SENTINEL}`, { json: {} }),
    (err: unknown) =>
      err instanceof WorkerRequestError &&
      err.code === "unknown_method" &&
      !err.message.includes(SENTINEL),
  );
  for (const line of v.lines) assert.ok(!line.includes(SENTINEL), line);
});

test("C2: the vault installs a login's credential only on the edge's commit", async () => {
  const { driver } = claudeDriver();
  const v = await vault({ drivers: { claude: driver } });
  const { start } = await loginLink(v);
  const refused = start("claude-a", () => false);
  await delay(50);
  refused.run.input("abc");
  await assert.rejects(refused.run.done, /cancelled/);
  assert.equal(existsSync(refused.tokenFile), false);

  const committed = start("claude-b", () => true);
  await delay(50);
  committed.run.input("def");
  await committed.run.done;
  assert.match(readFileSync(committed.tokenFile, "utf8"), /claude-def/);
});

test("a login child's credential stays in its directory: ingested, the directory removed, never on the pipe", async () => {
  // The real child side (`loginChildEntry.ts`) over a fake driver, its stdout
  // copied to a file so the test can read what crossed the pipe.
  const pipeLog = join(root, `pipe-${Date.now()}.log`);
  const entry = join(root, `login-entry-${Date.now()}.ts`);
  writeFileSync(
    entry,
    `import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLoginChild } from ${JSON.stringify(resolve("src/loginChildEntry.ts"))};
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string, ...rest: never[]) => {
  appendFileSync(${JSON.stringify(pipeLog)}, String(chunk));
  return write(chunk, ...rest);
}) as typeof process.stdout.write;
runLoginChild((configDir, events) => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  events.output("Paste code: ");
  events.url("https://claude.example/oauth");
  return {
    input: (text) => {
      writeFileSync(
        join(configDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: { accessToken: "claude-" + text, expiresAt: ${expires()} },
        }),
      );
      finish();
    },
    cancel: () => {},
    done,
  };
});
`,
  );
  const v = await vault({
    drivers: {
      claude: loginChildDriver(
        { file: process.execPath, args: ["--import", "tsx", entry] },
        { log: () => {} },
      ),
    },
  });
  const { start } = await loginLink(v);
  const login = start("claude-child");
  await until(
    () => existsSync(pipeLog) && readFileSync(pipeLog, "utf8").includes("url"),
    "the child's events",
  );
  login.run.input("fake-child-code-1387");
  await login.run.done;
  assert.match(
    readFileSync(login.tokenFile, "utf8"),
    /claude-fake-child-code-1387/,
  );
  assert.deepEqual(readdirSync(join(v.dir, "login-tmp")), []);
  const pipe = readFileSync(pipeLog, "utf8");
  assert.match(pipe, /"type":"done","ok":true/);
  assert.equal(pipe.includes("fake-child-code-1387"), false);
}, 60_000);

test("C4: the vault runs one login per account, at most four, each with a deadline", async () => {
  const { driver, cancelled } = claudeDriver();
  const v = await vault({ drivers: { claude: driver }, loginTimeoutMs: 500 });
  const { start } = await loginLink(v);
  const first = start("claude-a");
  const again = start("claude-a");
  await assert.rejects(again.run.done, /cannot run that login/);
  const more = ["claude-b", "claude-c", "claude-d"].map((id) => start(id));
  const fifth = start("claude-e");
  await assert.rejects(fifth.run.done, /cannot run that login/);
  // The deadline cancels the four, withdrawn: none commits.
  for (const login of [first, ...more])
    await assert.rejects(login.run.done, /cancelled/);
  assert.equal(cancelled.length, 4);
  for (const line of v.lines) assert.ok(!line.includes(SENTINEL), line);
});

test("C5: dial, TLS and hello have deadlines; close stops a dial in flight", async () => {
  // A TCP peer that never speaks TLS.
  const silent = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  open.push({
    close: () => new Promise<void>((resolve) => silent.close(() => resolve())),
  });
  let accepted = 0;
  silent.on("connection", (socket) => {
    accepted += 1;
    open.push({ close: () => socket.destroy() });
  });
  const lines: string[] = [];
  const deps = {
    profiles: () => [],
    liveLeases: () => [],
    report: () => {},
    log: (line: string) => lines.push(line),
    connectTimeoutMs: 150,
  };
  const stalled = createRemoteVault(
    {
      host: "127.0.0.1",
      port: (silent.address() as net.AddressInfo).port,
      tls: linkTls(),
    },
    deps,
  );
  await until(
    () => lines.filter((l) => l === "vault unreachable: ETIMEDOUT").length >= 2,
    "two timed-out dials",
  );
  stalled.close();
  const after = accepted;
  await delay(1_500);
  assert.equal(accepted, after, "no dial after close");

  // A vault that completes TLS and the handshake but never answers hello.
  const mute = tls.createServer(
    {
      key: vaultId.keyPem,
      cert: vaultId.certPem,
      ca: edgeId.certPem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      const connection = new WorkerConnection(socketEndpoint(socket), {
        protocol: GATEWAY_VAULT_PROTOCOL,
        handshake: { role: "server", admit: () => undefined },
        handlers: { "vault.hello": () => new Promise(() => {}) },
      });
      open.push({ close: () => connection.end("test done") });
    },
  );
  await new Promise<void>((resolve) => mute.listen(0, "127.0.0.1", resolve));
  open.push({
    close: () => new Promise<void>((resolve) => mute.close(() => resolve())),
  });
  lines.length = 0;
  const hung = createRemoteVault(
    {
      host: "127.0.0.1",
      port: (mute.address() as net.AddressInfo).port,
      tls: linkTls(),
    },
    deps,
  );
  open.push(hung);
  await until(
    () => lines.includes("vault unreachable: ETIMEDOUT"),
    "the hello deadline",
  );
  assert.equal(hung.connected(), false);
});

test("C1: empty data frames with a new stream name each count against the bounds", async () => {
  const v = await vault();
  const socket = await rawEdge(v.port);
  // Zero-byte frames, each naming a new stream, never completed.
  for (let seq = 0; seq < 40_000 && !socket.destroyed; seq++) {
    const head = Buffer.from(
      JSON.stringify({
        type: "data",
        of: "request",
        id: 1,
        stream: `text:s${seq}`,
        seq,
      }),
    );
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32BE(head.length, 0);
    prefix.writeUInt32BE(0, 4);
    socket.write(Buffer.concat([prefix, head]));
  }
  await closed(socket);
  await until(
    () => v.lines.includes("edge disconnected (protocol)"),
    "the vault to end the link",
  );
});

test("a sealing vault starts locked: the edge refuses 503 vault locked, nothing needs a login, logins are refused; unlocked it serves", async () => {
  const dir = mkdtempSync(join(root, "sealed-vault-"));
  const claudeFile = writeAccountFile(dir, "claude", "claude-a");
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const privateKeyFile = join(dir, "software-key.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  writeRecipients(dir, [
    recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
      privateKeyFile,
    }),
  ]);
  assert.deepEqual(await sealExisting(dir), { sealed: 1 });
  assert.equal(existsSync(claudeFile), false);

  const controlSocket = join(dir, "control.sock");
  const v = await vault({
    dir,
    controlSocket,
    drivers: {
      claude: () => ({
        input: () => {},
        cancel: () => {},
        done: Promise.resolve(),
      }),
    },
  });
  // A bare link: no needs-login report, and a login is refused.
  const reports: [string, boolean][] = [];
  const remote = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls() },
    {
      profiles: () => [
        {
          id: "claude-a",
          provider: "claude",
          name: "claude-a",
          enabled: true,
          tokenFile: claudeFile,
        },
      ],
      liveLeases: () => ["claude-a"],
      report: (id, needs) => reports.push([id, needs]),
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  await v.renewDue();
  assert.deepEqual(remote.needsLogin(), []);
  const run = remote.login(
    {
      kind: "claude",
      accountId: "claude-b",
      tokenFile: remote.newTokenFile("claude", "claude-b"),
      commit: () => true,
    },
    { output() {}, url() {}, code() {} },
  );
  await assert.rejects(run!.done);
  assert.deepEqual(reports, []);
  remote.close();
  open.splice(open.indexOf(remote), 1);

  const gw = await edge(v.port);
  await until(linkUp(gw), "the vault link");
  assert.ok(
    gw.lines.some((line) => line.endsWith("(vault locked)")),
    gw.lines.join("\n"),
  );
  const token = account(gw, "claude-a", "claude", claudeFile);
  const before = upstreams.anthropic.length;
  const refused = await modelRequest(gw.port, CLAUDE_PATH, token);
  assert.equal(refused.status, 503);
  assert.ok(
    refused.text.includes(refusalText({ case: "vault-locked" })),
    refused.text,
  );
  assert.equal(upstreams.anthropic.length, before);

  // Unlocked: the record opens into accounts/ and the edge serves again.
  assert.deepEqual(
    await askVaultControl(controlSocket, { method: "unlock", pin: "unused" }),
    { ok: true, opened: 1, unopened: 0 },
  );
  assert.equal(existsSync(claudeFile), true);
  assert.equal((await modelRequest(gw.port, CLAUDE_PATH, token)).status, 200);
  for (const line of [...gw.lines, ...v.lines])
    assert.ok(!line.includes(CLAUDE_ACCESS), line);
});

// --- the stop (Task-1387 review C1, C2) -----------------------------------

/** Synthetic; not a real credential. */
const RENEWED_ACCESS = "fake-stop-renewed-access";

/** A vault dir with a software recipient and `claude-a`'s record sealed. */
async function sealedVaultDir(): Promise<{
  dir: string;
  claudeFile: string;
  controlSocket: string;
  privateKeyFile: string;
}> {
  const dir = mkdtempSync(join(root, "sealed-stop-"));
  const claudeFile = writeAccountFile(dir, "claude", "claude-a");
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const privateKeyFile = join(dir, "software-key.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  writeRecipients(dir, [
    recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
      privateKeyFile,
    }),
  ]);
  assert.deepEqual(await sealExisting(dir), { sealed: 1 });
  return {
    dir,
    claudeFile,
    controlSocket: join(dir, "control.sock"),
    privateKeyFile,
  };
}

async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(ms).then(() => false),
  ]);
}

test("C1: a stop admits nothing from its first moment, and an open control connection does not hold it", async () => {
  const { dir, controlSocket } = await sealedVaultDir();
  let portCalls = 0;
  let driverStarts = 0;
  const v = await vault({
    dir,
    controlSocket,
    renewCodex: async () => {
      portCalls += 1;
      return { ok: true };
    },
    drivers: {
      claude: (configDir) => {
        driverStarts += 1;
        writeFileSync(
          join(configDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: { accessToken: CLAUDE_ACCESS, expiresAt: expires() },
          }),
        );
        return { input: () => {}, cancel: () => {}, done: Promise.resolve() };
      },
    },
  });
  open.splice(open.indexOf(v), 1);
  assert.deepEqual(
    await askVaultControl(controlSocket, { method: "unlock", pin: "unused" }),
    { ok: true, opened: 1, unopened: 0 },
  );
  // A Codex account due for renewal, leased.
  const codexFile = join(v.dir, "accounts", "codex-a", "auth.json");
  mkdirSync(join(v.dir, "accounts", "codex-a"), { recursive: true });
  writeFileSync(
    codexFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: CODEX_ACCESS,
        accountId: CODEX_ACCOUNT,
        expires: Date.now() + 60_000,
      },
    }),
  );
  const accounts = new Map<string, string>([["codex-a", codexFile]]);
  const remote = createRemoteVault(
    { host: "127.0.0.1", port: v.port, tls: linkTls() },
    {
      profiles: () =>
        [...accounts].map(([id, tokenFile]) => ({
          id,
          provider: id.startsWith("codex") ? "openai-codex" : "claude",
          name: id,
          enabled: true,
          tokenFile,
        })),
      liveLeases: () => ["codex-a"],
      report: () => {},
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  const start = (accountId: string) => {
    const tokenFile = remote.newTokenFile("claude", accountId);
    accounts.set(accountId, tokenFile);
    remote.inputsChanged();
    const run = remote.login(
      { kind: "claude", accountId, tokenFile, commit: () => true },
      { output() {}, url() {}, code() {} },
    )!;
    run.done.catch(() => {});
    return { run, tokenFile };
  };
  // The vault takes both inputs before the stop.
  await delay(100);
  // An idle control connection, held open across the stop.
  const held = net.connect(controlSocket);
  held.on("error", () => {});
  await new Promise((resolve) => held.once("connect", resolve));
  const heldClosed = new Promise((resolve) => held.once("close", resolve));

  const closing = v.close();
  // Asked once the stop began: no login runs, no renewal reaches the port.
  const late = start("claude-late");
  await assert.rejects(late.run.done);
  await v.renewDue();
  assert.equal(await settledWithin(closing, 10_000), true, "the stop hung");
  await closing;
  await heldClosed;
  assert.equal(driverStarts, 0);
  assert.equal(portCalls, 0);
  assert.equal(existsSync(late.tokenFile), false);
});

test("C2: a seal that keeps failing at stop rejects the stop, naming the account; one that recovers seals the new credential", async () => {
  for (const recovers of [false, true]) {
    const { dir, claudeFile, controlSocket, privateKeyFile } =
      await sealedVaultDir();
    const v = await vault({ dir, controlSocket });
    open.splice(open.indexOf(v), 1);
    assert.deepEqual(
      await askVaultControl(controlSocket, { method: "unlock", pin: "unused" }),
      { ok: true, opened: 1, unopened: 0 },
    );
    // A renewal wrote the file and its seal failed: the record is stale.
    const renewed = JSON.stringify({
      claudeAiOauth: {
        accessToken: RENEWED_ACCESS,
        expiresAt: expires(),
      },
    });
    writeFileSync(claudeFile, renewed);
    const recordDir = join(dir, "sealed", "claude-a");
    chmodSync(recordDir, 0o500);
    try {
      const closing = v.close();
      if (recovers) {
        await until(
          () => v.lines.some((line) => line.includes("failed at stop")),
          "a failed seal",
        );
        chmodSync(recordDir, 0o700);
        await closing;
        const record = parseSealedRecord(
          JSON.parse(
            readFileSync(join(recordDir, ".credentials.json.sealed"), "utf8"),
          ),
        );
        assert.ok(record);
        const opened = await openRecord(
          record,
          "claude-a",
          ".credentials.json",
          (_kid, epk) =>
            softwareEcdh(readFileSync(privateKeyFile, "utf8"), epk),
        );
        assert.equal(opened?.toString("utf8"), renewed);
      } else {
        await assert.rejects(closing, {
          message: "not sealed at stop: claude-a",
        });
        for (const line of v.lines)
          assert.ok(!line.includes(RENEWED_ACCESS), line);
      }
    } finally {
      chmodSync(recordDir, 0o700);
    }
  }
});
