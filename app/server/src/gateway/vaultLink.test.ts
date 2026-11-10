/**
 * The vault as its own process (plan Task-1394): an edge with a remote vault
 * over `gateway-vault/1.0` on loopback mutual TLS, both in this process,
 * against fake upstreams. Token files live only in the vault's state
 * directory. Every value is fake.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import { startGateway, type RunningGateway } from "./gateway.ts";
import type { LeaseProvider } from "./leases.ts";
import { refusalText } from "./refusals.ts";
import { createRemoteVault, type RemoteVault } from "./remoteVault.ts";
import { LOGIN_CREDENTIAL_FILE } from "./vaultMethods.ts";
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

test("an unpinned client or server certificate is refused", async () => {
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
