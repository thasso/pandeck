/**
 * Users' integration credentials in the vault (Task-1397): `integrations.*`
 * over `gateway-vault/1.2` to a vault process in this one, sealed to a
 * software recipient, locked after a restart, swept and resealed like token
 * files, and every remote call bounded. Atlassian OAuth records (Task-1411):
 * connect, refresh and stop over the real link against a loopback Atlassian
 * fake, sealed, with nothing lost to an edge timeout, a stop or a failed
 * seal. Slack OAuth records (Task-1452): the same over the link against a
 * loopback Slack fake, the 1.2 wire's refusals and answer decoding, and both
 * integrations side by side. Every value is fake.
 */
import assert from "node:assert/strict";
import { X509Certificate, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_CLIENT,
  FAKE_CLOUD_ID,
  FAKE_CODE,
  FAKE_REDIRECT,
  FAKE_SITE,
  jsonResponder,
  startAtlassianFake,
  type AtlassianFake,
} from "../test/atlassianFake.ts";
import {
  FAKE_SLACK_CLIENT,
  FAKE_SLACK_CODE,
  FAKE_SLACK_REDIRECT,
  FAKE_SLACK_SCOPE,
  FAKE_TEAM_ID,
  FAKE_TEAM_NAME,
  FAKE_USER_ID,
  FAKE_WORKSPACE_HOST,
  slackJson,
  startSlackFake,
  type SlackFake,
} from "../test/slackFake.ts";
import { WorkerConnection } from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { createRemoteVault, type RemoteVault } from "./remoteVault.ts";
import { recipientOf, writeRecipients } from "./sealedStore.ts";
import { askVaultControl } from "./vaultControl.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  GATEWAY_VAULT_VERSION,
  INTEGRATION_FILE,
  MAX_INTEGRATION_CREDENTIAL,
  VAULT_LIMITS,
  VAULT_METHODS,
  integrationDirId,
  isPinnedPeer,
  vaultBody,
  vaultMessage,
} from "./vaultMethods.ts";
import type { Integration } from "./vaultPort.ts";
import {
  startVaultServer,
  type RunningVaultServer,
  type VaultServerOptions,
} from "./vaultServer.ts";
import { selfSignedIdentity } from "./x509.ts";

const root = mkdtempSync(join(tmpdir(), "vault-int-"));
const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
  "localhost",
  "127.0.0.1",
]);
const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
const open: { close(): unknown }[] = [];
const CREDENTIAL = JSON.stringify({
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-INT-TOKEN",
});

/**
 * The Atlassian (Task-1411) and Slack (Task-1452) fakes for the OAuth
 * records' tests.
 */
let atl: AtlassianFake;
let atlToken: AtlassianFake["token"];
let slack: SlackFake;
beforeAll(async () => {
  atl = await startAtlassianFake();
  atlToken = atl.token;
  slack = await startSlackFake();
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  atl.token = atlToken;
  atl.expiresInS = 3600;
  slack.reset();
});
afterAll(async () => {
  await atl.close();
  await slack.close();
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A vault directory with one software recipient. */
function sealingDir(): { dir: string; addRecipient(): void } {
  const dir = mkdtempSync(join(root, "vault-"));
  const keys: ReturnType<typeof recipientOf>[] = [];
  const addRecipient = (): void => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const privateKeyFile = join(dir, `software-key-${keys.length}.pem`);
    writeFileSync(
      privateKeyFile,
      privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    );
    keys.push(
      recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
        privateKeyFile,
      }),
    );
    writeRecipients(dir, [keys.at(-1)!]);
  };
  addRecipient();
  return { dir, addRecipient };
}

async function vault(
  dir: string,
  extra: Partial<VaultServerOptions> = {},
): Promise<RunningVaultServer & { lines: string[]; control: string }> {
  const lines: string[] = [];
  const control = join(dir, "control.sock");
  const running = await startVaultServer({
    stateDir: dir,
    port: 0,
    tls: {
      keyPem: vaultId.keyPem,
      certPem: vaultId.certPem,
      peerCertPem: edgeId.certPem,
    },
    controlSocket: control,
    log: (line) => lines.push(line),
    ...extra,
  });
  open.push(running);
  return Object.assign(running, { lines, control });
}

async function link(
  port: number,
  integrationTimeoutMs?: number,
): Promise<RemoteVault> {
  const remote = createRemoteVault(
    {
      host: "127.0.0.1",
      port,
      tls: {
        keyPem: edgeId.keyPem,
        certPem: edgeId.certPem,
        peerCertPem: vaultId.certPem,
      },
      ...(integrationTimeoutMs !== undefined ? { integrationTimeoutMs } : {}),
    },
    {
      profiles: () => [],
      liveLeases: () => [],
      report: () => {},
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  return remote;
}

const unlock = (control: string) =>
  askVaultControl(control, { method: "unlock", pin: "unused" });

test("a sealing vault keeps the record sealed on disk, locked after a restart, opened with the logins", async () => {
  const { dir } = sealingDir();
  const first = await vault(dir);
  const remote = await link(first.port);
  assert.deepEqual(await remote.integrationPut("u1", "atlassian", CREDENTIAL), {
    ok: false,
    locked: true,
  });
  assert.deepEqual(await remote.integrationGet("u1", "atlassian"), {
    ok: false,
    locked: true,
  });
  assert.deepEqual(await remote.integrationClear("u1", "atlassian"), {
    ok: false,
    locked: true,
  });
  assert.deepEqual(await unlock(first.control), {
    ok: true,
    opened: 0,
    unopened: 0,
  });

  assert.deepEqual(await remote.integrationPut("u1", "atlassian", CREDENTIAL), {
    ok: true,
  });
  const dirId = integrationDirId("u1", "atlassian");
  assert.match(dirId, /^int-[0-9a-f]{40}$/);
  const record = join(dir, "sealed", dirId, `${INTEGRATION_FILE}.sealed`);
  assert.ok(existsSync(record));
  assert.doesNotMatch(readFileSync(record, "utf8"), /FAKE-INT-TOKEN/);
  assert.ok(existsSync(join(dir, "accounts", dirId, INTEGRATION_FILE)));
  // No user id on the disk.
  assert.ok(!readdirSync(join(dir, "sealed")).some((name) => name === "u1"));
  assert.deepEqual(await remote.integrationGet("u1", "atlassian"), {
    ok: true,
    credential: CREDENTIAL,
  });
  assert.deepEqual(await remote.integrationGet("u2", "atlassian"), {
    ok: false,
    absent: true,
  });

  // A restart: the plaintext (tmpfs in production) is gone and it is locked.
  remote.close();
  await first.close();
  open.length = 0;
  rmSync(join(dir, "accounts"), { recursive: true, force: true });
  const second = await vault(dir);
  const again = await link(second.port);
  assert.deepEqual(await again.integrationGet("u1", "atlassian"), {
    ok: false,
    locked: true,
  });
  assert.deepEqual(await unlock(second.control), {
    ok: true,
    opened: 1,
    unopened: 0,
  });
  assert.deepEqual(await again.integrationGet("u1", "atlassian"), {
    ok: true,
    credential: CREDENTIAL,
  });
  for (const line of [...first.lines, ...second.lines])
    assert.doesNotMatch(line, /FAKE-INT-TOKEN|u1/);
});

test("a record moved to another user's directory does not open", async () => {
  const { dir } = sealingDir();
  const first = await vault(dir);
  const remote = await link(first.port);
  await unlock(first.control);
  await remote.integrationPut("u1", "atlassian", CREDENTIAL);
  remote.close();
  await first.close();
  open.length = 0;
  const from = join(dir, "sealed", integrationDirId("u1", "atlassian"));
  const to = join(dir, "sealed", integrationDirId("u2", "atlassian"));
  renameSync(from, to);
  rmSync(join(dir, "accounts"), { recursive: true, force: true });
  const second = await vault(dir);
  const again = await link(second.port);
  assert.deepEqual(await unlock(second.control), {
    ok: true,
    opened: 0,
    unopened: 1,
  });
  assert.deepEqual(await again.integrationGet("u2", "atlassian"), {
    ok: false,
    absent: true,
  });
});

test("clear deletes record and plaintext; nothing comes back after a restart", async () => {
  const { dir } = sealingDir();
  const first = await vault(dir);
  const remote = await link(first.port);
  await unlock(first.control);
  await remote.integrationPut("u1", "atlassian", CREDENTIAL);
  const dirId = integrationDirId("u1", "atlassian");
  const plaintext = join(dir, "accounts", dirId, INTEGRATION_FILE);
  const record = join(dir, "sealed", dirId, `${INTEGRATION_FILE}.sealed`);
  assert.deepEqual(await remote.integrationClear("u1", "atlassian"), {
    ok: true,
  });
  assert.equal(existsSync(record), false);
  assert.equal(existsSync(plaintext), false);
  remote.close();
  await first.close();
  open.length = 0;
  const second = await vault(dir);
  const again = await link(second.port);
  await unlock(second.control);
  assert.deepEqual(await again.integrationGet("u1", "atlassian"), {
    ok: false,
    absent: true,
  });
});

test("a resealed record opens with the new recipient after a restart", async () => {
  const { dir, addRecipient } = sealingDir();
  const first = await vault(dir);
  const remote = await link(first.port);
  await unlock(first.control);
  await remote.integrationPut("u1", "atlassian", CREDENTIAL);
  addRecipient();
  await askVaultControl(first.control, { method: "reseal" });
  remote.close();
  await first.close();
  open.length = 0;
  rmSync(join(dir, "accounts"), { recursive: true, force: true });
  const second = await vault(dir);
  const again = await link(second.port);
  assert.deepEqual(await unlock(second.control), {
    ok: true,
    opened: 1,
    unopened: 0,
  });
  assert.deepEqual(await again.integrationGet("u1", "atlassian"), {
    ok: true,
    credential: CREDENTIAL,
  });
});

test("the vault refuses a profile whose token file is an integration record", async () => {
  const { dir } = sealingDir();
  rmSync(join(dir, "vault-recipients.json"));
  const v = await vault(dir);
  const dirId = integrationDirId("u1", "atlassian");
  const remote = createRemoteVault(
    {
      host: "127.0.0.1",
      port: v.port,
      tls: {
        keyPem: edgeId.keyPem,
        certPem: edgeId.certPem,
        peerCertPem: vaultId.certPem,
      },
    },
    {
      profiles: () => [
        {
          id: "claude-x",
          provider: "claude",
          name: "x",
          enabled: true,
          tokenFile: join(dir, "accounts", dirId, INTEGRATION_FILE),
        },
      ],
      liveLeases: () => [],
      report: () => {},
      log: () => {},
    },
  );
  open.push(remote);
  await until(remote.connected, "the vault link");
  await until(
    () => v.lines.some((line) => line.includes("1 profiles not kept")),
    "the refused profile",
  );
});

/** A vault that answers hello and holds every integration reply. */
async function holdingVault(connectAnswers: unknown[] = []): Promise<{
  port: number;
  held: number;
  release(): void;
}> {
  const releases: (() => void)[] = [];
  const state = { held: 0 };
  const pinned = new X509Certificate(edgeId.certPem).fingerprint256;
  const server = tls.createServer(
    {
      key: vaultId.keyPem,
      cert: vaultId.certPem,
      ca: edgeId.certPem,
      requestCert: true,
      // Match the real vault link: Bun rejects a self-signed CA anchor.
      rejectUnauthorized: false,
    },
    (socket) => {
      if (!isPinnedPeer(socket, pinned)) {
        socket.destroy();
        return;
      }
      const hold = () =>
        new Promise<ReturnType<typeof vaultMessage>>((resolve) => {
          state.held++;
          releases.push(() =>
            resolve(
              vaultMessage({
                record: { ok: true, credential: CREDENTIAL },
              }),
            ),
          );
        });
      const connection = new WorkerConnection(socketEndpoint(socket), {
        protocol: GATEWAY_VAULT_PROTOCOL,
        handshake: { role: "server", admit: () => undefined },
        limits: VAULT_LIMITS,
        handlers: {
          [VAULT_METHODS.hello]: () =>
            Promise.resolve(
              vaultMessage({
                version: GATEWAY_VAULT_VERSION,
                needsLogin: [],
                locked: false,
                accountsDir: "/nowhere",
                loginKinds: [],
              }),
            ),
          [VAULT_METHODS.profiles]: () => Promise.resolve(vaultMessage({})),
          [VAULT_METHODS.liveLeases]: () => Promise.resolve(vaultMessage({})),
          [VAULT_METHODS.integrationGet]: hold,
          [VAULT_METHODS.integrationPut]: hold,
          [VAULT_METHODS.integrationClear]: hold,
          // Scripted answers, in order (Task-1452's decoding).
          [VAULT_METHODS.integrationConnect]: () =>
            Promise.resolve(vaultMessage({ connect: connectAnswers.shift() })),
        },
      });
      open.push({ close: () => connection.end("test done") });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push({ close: () => new Promise((done) => server.close(done)) });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    get held() {
      return state.held;
    },
    release: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

test("the holding vault refuses an unpinned client before its protocol handshake", async () => {
  const held = await holdingVault();
  const stranger = selfSignedIdentity("pandeck-gateway-edge", "client");
  const lines: string[] = [];
  const remote = createRemoteVault(
    {
      host: "127.0.0.1",
      port: held.port,
      tls: {
        keyPem: stranger.keyPem,
        certPem: stranger.certPem,
        peerCertPem: vaultId.certPem,
      },
    },
    {
      profiles: () => [],
      liveLeases: () => [],
      report: () => {},
      log: (line) => lines.push(line),
    },
  );
  open.push(remote);
  await until(
    () => lines.some((line) => line.startsWith("vault unreachable:")),
    "the unpinned link refusal",
  );
  assert.equal(remote.connected(), false);
  assert.equal(
    lines.some((line) => line.startsWith("vault link up")),
    false,
  );
  assert.equal(held.held, 0);
});

test("bounded remote calls: a held reply answers unavailable on schedule, an aborted read at once, a late reply changes nothing", async () => {
  const held = await holdingVault();
  const remote = await link(held.port, 60);
  const started = Date.now();
  assert.deepEqual(await remote.integrationGet("u1", "atlassian"), {
    ok: false,
    unavailable: true,
  });
  assert.deepEqual(await remote.integrationPut("u1", "atlassian", CREDENTIAL), {
    ok: false,
    unavailable: true,
  });
  assert.deepEqual(await remote.integrationClear("u1", "atlassian"), {
    ok: false,
    unavailable: true,
  });
  assert.ok(Date.now() - started < 2_000, "each answered near its deadline");
  const aborted = new AbortController();
  aborted.abort();
  const sent = held.held;
  assert.deepEqual(
    await remote.integrationGet("u1", "atlassian", { signal: aborted.signal }),
    { ok: false, unavailable: true },
  );
  assert.equal(held.held, sent, "an aborted read sends no request");
  const pending = new AbortController();
  const read = remote.integrationGet("u1", "atlassian", {
    signal: pending.signal,
  });
  pending.abort();
  assert.deepEqual(await read, { ok: false, unavailable: true });
  held.release();
  await delay(50);
  remote.close();
  assert.deepEqual(await remote.integrationGet("u1", "atlassian"), {
    ok: false,
    unavailable: true,
  });
});

// --- Atlassian OAuth records (Task-1411) -----------------------------------

const DIR_ID = integrationDirId("u1", "atlassian");
const plaintextOf = (dir: string): string =>
  join(dir, "accounts", DIR_ID, INTEGRATION_FILE);
const sealedOf = (dir: string): string =>
  join(dir, "sealed", DIR_ID, `${INTEGRATION_FILE}.sealed`);
const storedRefresh = (dir: string): unknown =>
  (
    JSON.parse(readFileSync(plaintextOf(dir), "utf8")) as Record<
      string,
      unknown
    >
  ).refreshToken;
const refreshesSent = (): string[] =>
  atl
    .on("token")
    .map((request) => JSON.parse(request.body) as Record<string, string>)
    .filter((body) => body.grant_type === "refresh_token")
    .map((body) => body.refresh_token!);
const connectU1 = (remote: RemoteVault) =>
  remote.integrationConnect("u1", "atlassian", {
    code: FAKE_CODE,
    redirectUri: FAKE_REDIRECT,
  });
const accessOf = (
  record: Awaited<ReturnType<RemoteVault["integrationGet"]>>,
) => {
  assert.equal(record.ok, true, JSON.stringify(record));
  return (
    JSON.parse((record as { credential: string }).credential) as {
      accessToken: string;
    }
  ).accessToken;
};
/** Every file under `accounts/` with its content. */
const accountsSnapshot = (dir: string): string =>
  JSON.stringify(
    readdirSync(join(dir, "accounts"), { recursive: true })
      .map(String)
      .sort()
      .map((name) => {
        try {
          return [name, readFileSync(join(dir, "accounts", name), "utf8")];
        } catch {
          return [name, "(directory)"];
        }
      }),
  );
const noSecretsIn = (lines: string[]): void => {
  for (const line of lines)
    assert.doesNotMatch(line, /fake-atl-|fake-atlassian-|u1\b/, line);
};

async function oauthVault(dir: string) {
  return vault(dir, {
    integrationClients: { atlassian: FAKE_CLIENT },
    atlassianEndpoint: atl.endpoint,
  });
}

/** A restart on `dir` (tmpfs plaintext gone), unlocked, linked. */
async function restarted(dir: string) {
  rmSync(join(dir, "accounts"), { recursive: true, force: true });
  const v = await oauthVault(dir);
  const remote = await link(v.port);
  assert.deepEqual(await unlock(v.control), {
    ok: true,
    opened: 1,
    unopened: 0,
  });
  return { v, remote };
}

test("connect over the link: a sealed record without the access token; access views, rejected and the record cap", async () => {
  const { dir } = sealingDir();
  const v = await oauthVault(dir);
  const remote = await link(v.port);
  assert.deepEqual(await connectU1(remote), { ok: false, locked: true });
  await unlock(v.control);
  atl.expiresInS = 60;
  const answer = await connectU1(remote);
  assert.deepEqual(answer, {
    ok: true,
    site: FAKE_SITE,
    cloudId: FAKE_CLOUD_ID,
  });
  assert.ok(existsSync(sealedOf(dir)));
  assert.doesNotMatch(readFileSync(sealedOf(dir), "utf8"), /fake-atl-/);
  assert.doesNotMatch(
    readFileSync(plaintextOf(dir), "utf8"),
    /fake-atl-access/,
  );
  assert.equal(storedRefresh(dir), atl.issuedRefresh.at(-1));
  // Due within the margin: the get refreshes, and the view crosses the link.
  const record = await remote.integrationGet("u1", "atlassian");
  assert.match(accessOf(record), /^fake-atl-access-\d+$/);
  assert.doesNotMatch(JSON.stringify(record), /fake-atl-refresh/);
  atl.token = jsonResponder(400, { error: "invalid_grant" });
  assert.deepEqual(await remote.integrationGet("u1", "atlassian"), {
    ok: false,
    rejected: true,
  });
  // A malformed connect is refused before the vault runs it.
  assert.deepEqual(
    await remote.integrationConnect("u1", "atlassian", {
      code: FAKE_CODE,
      redirectUri: "http://plain.example.test/callback",
    }),
    { ok: false, unavailable: true },
  );
  // A code over 8,192 characters is refused before the vault runs it; one of
  // 8,192 (Atlassian's grows with the scopes) reaches the exchange.
  assert.deepEqual(
    await remote.integrationConnect("u1", "atlassian", {
      code: "x".repeat(8_193),
      redirectUri: FAKE_REDIRECT,
    }),
    { ok: false, unavailable: true },
  );
  assert.deepEqual(
    await remote.integrationConnect("u1", "atlassian", {
      code: "x".repeat(8_192),
      redirectUri: FAKE_REDIRECT,
    }),
    { ok: false, rejected: true },
  );
  // The record cap is 16 KiB.
  assert.deepEqual(
    await remote.integrationPut(
      "u2",
      "atlassian",
      "x".repeat(MAX_INTEGRATION_CREDENTIAL),
    ),
    { ok: true },
  );
  assert.deepEqual(
    await remote.integrationPut(
      "u2",
      "atlassian",
      "x".repeat(MAX_INTEGRATION_CREDENTIAL + 1),
    ),
    { ok: false, unavailable: true },
  );
  assert.equal(MAX_INTEGRATION_CREDENTIAL, 16_384);
  noSecretsIn(v.lines);
});

for (const route of ["token", "resources"] as const)
  test(`a stop during a connect held at ${route === "token" ? "the code exchange" : "the site list"} waits, then the record is written and sealed before the flush`, async () => {
    const { dir } = sealingDir();
    const v = await oauthVault(dir);
    const remote = await link(v.port);
    await unlock(v.control);
    atl.expiresInS = 60;
    const held = atl.hold(route);
    const connecting = connectU1(remote);
    await held.arrived;
    let closed = false;
    const closing = v.close().then(() => (closed = true));
    await delay(150);
    assert.equal(closed, false, "the stop waits for the running connect");
    held.release();
    await closing;
    await connecting;
    const issued = atl.issuedRefresh.at(-1);
    assert.equal(storedRefresh(dir), issued);
    assert.ok(existsSync(sealedOf(dir)));
    const after = accountsSnapshot(dir);
    await delay(100);
    assert.equal(
      accountsSnapshot(dir),
      after,
      "nothing written after the stop",
    );
    remote.close();
    // The sealed record holds the exchanged token: the restart refreshes it.
    const again = await restarted(dir);
    accessOf(await again.remote.integrationGet("u1", "atlassian"));
    assert.equal(refreshesSent().at(-1), issued);
    noSecretsIn([...v.lines, ...again.v.lines]);
  });

test("a stop during a held refresh waits; the rotation is on disk and sealed, a queued clear refused", async () => {
  const { dir } = sealingDir();
  const v = await oauthVault(dir);
  const remote = await link(v.port);
  await unlock(v.control);
  atl.expiresInS = 60;
  await connectU1(remote);
  const held = atl.hold("token");
  const reading = remote.integrationGet("u1", "atlassian");
  await held.arrived;
  const clearing = remote.integrationClear("u1", "atlassian");
  await delay(50);
  let closed = false;
  const closing = v.close().then(() => (closed = true));
  await delay(150);
  assert.equal(closed, false, "the stop waits for the running refresh");
  held.release();
  await closing;
  await reading;
  assert.deepEqual(await clearing, { ok: false, unavailable: true });
  const rotated = atl.issuedRefresh.at(-1);
  assert.equal(storedRefresh(dir), rotated, "the clear never ran");
  const after = accountsSnapshot(dir);
  await delay(100);
  assert.equal(accountsSnapshot(dir), after);
  remote.close();
  const again = await restarted(dir);
  accessOf(await again.remote.integrationGet("u1", "atlassian"));
  assert.equal(refreshesSent().at(-1), rotated);
  noSecretsIn([...v.lines, ...again.v.lines]);
});

test("an edge-side timeout during a held refresh answers unavailable; the vault still stores and serves the rotation", async () => {
  const { dir } = sealingDir();
  const v = await oauthVault(dir);
  const first = await link(v.port);
  await unlock(v.control);
  atl.expiresInS = 60;
  await connectU1(first);
  first.close();
  const remote = await link(v.port, 300);
  atl.expiresInS = 3600;
  const held = atl.hold("token");
  const reading = remote.integrationGet("u1", "atlassian");
  await held.arrived;
  assert.deepEqual(await reading, { ok: false, unavailable: true });
  held.release();
  const rotated = (): boolean =>
    storedRefresh(dir) === atl.issuedRefresh.at(-1);
  await until(rotated, "the rotated record");
  const sent = refreshesSent().length;
  // Cached by the finished refresh: no second refresh.
  accessOf(await remote.integrationGet("u1", "atlassian"));
  assert.equal(refreshesSent().length, sent);
  noSecretsIn(v.lines);
});

test("a failed seal after a refresh still answers; the record is sealed later and the rotation survives a restart", async () => {
  const { dir } = sealingDir();
  const v = await oauthVault(dir);
  const remote = await link(v.port);
  await unlock(v.control);
  atl.expiresInS = 60;
  await connectU1(remote);
  // The record's sealed directory refuses the write once.
  chmodSync(join(dir, "sealed", DIR_ID), 0o500);
  let rotated: string | undefined;
  try {
    accessOf(await remote.integrationGet("u1", "atlassian"));
    rotated = atl.issuedRefresh.at(-1);
    assert.equal(storedRefresh(dir), rotated);
  } finally {
    chmodSync(join(dir, "sealed", DIR_ID), 0o700);
  }
  const failures = v.lines.filter((line) => line.includes("sealing"));
  assert.deepEqual(failures, [
    `sealing account ${DIR_ID} failed; the sweep retries`,
  ]);
  // The stop's flush seals what drifted and reports nothing unsealed.
  remote.close();
  await v.close();
  const again = await restarted(dir);
  accessOf(await again.remote.integrationGet("u1", "atlassian"));
  assert.equal(refreshesSent().at(-1), rotated);
  noSecretsIn([...v.lines, ...again.v.lines]);
});

// --- Slack OAuth records (Task-1452) ---------------------------------------

const SLACK_DIR_ID = integrationDirId("u1", "slack");
const slackPlaintextOf = (dir: string, dirId = SLACK_DIR_ID): string =>
  join(dir, "accounts", dirId, INTEGRATION_FILE);
const slackSealedOf = (dir: string): string =>
  join(dir, "sealed", SLACK_DIR_ID, `${INTEGRATION_FILE}.sealed`);
const slackStored = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(slackPlaintextOf(dir), "utf8")) as Record<
    string,
    unknown
  >;
const connectSlackU1 = (remote: RemoteVault, team?: string) =>
  remote.integrationConnect("u1", "slack", {
    code: FAKE_SLACK_CODE,
    redirectUri: FAKE_SLACK_REDIRECT,
    ...(team !== undefined ? { team } : {}),
  });
const noSlackSecretsIn = (lines: string[]): void => {
  for (const line of lines)
    assert.doesNotMatch(
      line,
      /fake-slack-|fake-atl-|fake-atlassian-|u1\b|UFAKE|TFAKE/,
      line,
    );
};

async function bothVault(dir: string) {
  return vault(dir, {
    integrationClients: { atlassian: FAKE_CLIENT, slack: FAKE_SLACK_CLIENT },
    atlassianEndpoint: atl.endpoint,
    slackEndpoint: slack.endpoint,
  });
}

/**
 * A bare `gateway-vault` client on the pinned link: sends any body, answers
 * the reply's body or `refused` for a request error.
 */
async function rawLink(
  port: number,
): Promise<(method: string, json: unknown) => Promise<unknown>> {
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const dialed = tls.connect({
      host: "127.0.0.1",
      port,
      key: edgeId.keyPem,
      cert: edgeId.certPem,
      ca: vaultId.certPem,
      rejectUnauthorized: false,
    });
    dialed.once("secureConnect", () => resolve(dialed));
    dialed.once("error", reject);
  });
  const connection = new WorkerConnection(socketEndpoint(socket), {
    handshake: { role: "worker", workerId: "pandeck-gateway-edge" },
    protocol: GATEWAY_VAULT_PROTOCOL,
    handlers: {
      [VAULT_METHODS.report]: () => Promise.resolve(vaultMessage({})),
    },
    limits: VAULT_LIMITS,
  });
  open.push({ close: () => connection.end("test done") });
  await connection.request(VAULT_METHODS.hello, vaultMessage({}));
  return (method, json) =>
    connection.request(method, vaultMessage(json)).then(
      (payload) => vaultBody(payload),
      () => "refused",
    );
}

test("Slack over the link: connect seals a record without the access token; get rotates, rejected, clear deletes", async () => {
  const { dir } = sealingDir();
  const v = await bothVault(dir);
  const remote = await link(v.port);
  assert.deepEqual(await connectSlackU1(remote), { ok: false, locked: true });
  assert.equal(slack.seen.length, 0, "a locked vault calls nobody");
  await unlock(v.control);
  slack.expiresInS = 60;
  assert.deepEqual(await connectSlackU1(remote, FAKE_TEAM_ID), {
    ok: true,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
  });
  assert.ok(existsSync(slackSealedOf(dir)));
  assert.doesNotMatch(readFileSync(slackSealedOf(dir), "utf8"), /fake-slack-/);
  const plaintext = readFileSync(slackPlaintextOf(dir), "utf8");
  assert.doesNotMatch(plaintext, /fake-slack-access/);
  assert.doesNotMatch(plaintext, /accessToken/);
  const exchanged = slack.issuedRefresh.at(-1);
  assert.deepEqual(slackStored(dir), {
    kind: "slack-oauth",
    v: 1,
    teamId: FAKE_TEAM_ID,
    teamName: FAKE_TEAM_NAME,
    workspaceHost: FAKE_WORKSPACE_HOST,
    userId: FAKE_USER_ID,
    refreshToken: exchanged,
    scope: FAKE_SLACK_SCOPE,
  });
  // Due within the margin: the get rotates, and the view crosses the link.
  const record = await remote.integrationGet("u1", "slack");
  assert.equal(record.ok, true, JSON.stringify(record));
  const view = JSON.parse((record as { credential: string }).credential) as {
    accessToken: string;
  };
  assert.deepEqual(Object.keys(view), [
    "kind",
    "teamId",
    "teamName",
    "workspaceHost",
    "userId",
    "scope",
    "accessToken",
    "expiresAt",
  ]);
  assert.equal(view.accessToken, slack.issuedAccess.at(-1));
  assert.doesNotMatch(JSON.stringify(record), /fake-slack-refresh/);
  assert.deepEqual(slack.refreshesSent(), [exchanged]);
  assert.equal(slackStored(dir).refreshToken, slack.issuedRefresh.at(-1));
  slack.access = slackJson(200, { ok: false, error: "invalid_refresh_token" });
  assert.deepEqual(await remote.integrationGet("u1", "slack"), {
    ok: false,
    rejected: true,
  });
  assert.deepEqual(await remote.integrationClear("u1", "slack"), { ok: true });
  assert.equal(existsSync(slackPlaintextOf(dir)), false);
  assert.equal(existsSync(slackSealedOf(dir)), false);
  assert.deepEqual(await remote.integrationGet("u1", "slack"), {
    ok: false,
    absent: true,
  });
  noSlackSecretsIn(v.lines);
});

test("Slack over the link: a team mismatch stores nothing; a put, a site with Slack and a team with Atlassian are refused before any effect", async () => {
  const { dir } = sealingDir();
  const v = await bothVault(dir);
  const remote = await link(v.port);
  await unlock(v.control);
  const before = accountsSnapshot(dir);
  assert.deepEqual(await connectSlackU1(remote, "TOTHER0001"), {
    ok: false,
    team: "mismatch",
  });
  assert.equal(slack.on("authTest").length, 0);
  // Only a connect writes a Slack record.
  assert.deepEqual(await remote.integrationPut("u1", "slack", CREDENTIAL), {
    ok: false,
    unavailable: true,
  });
  const raw = await rawLink(v.port);
  const connect = {
    userId: "u1",
    code: FAKE_SLACK_CODE,
    redirectUri: FAKE_SLACK_REDIRECT,
  };
  const sent = slack.seen.length + atl.seen.length;
  for (const body of [
    { ...connect, integration: "slack", site: FAKE_SITE },
    { ...connect, integration: "atlassian", team: FAKE_TEAM_ID },
    { ...connect, integration: "slack", team: "not-a-team" },
    { ...connect, integration: "slack", team: 7 },
    { ...connect, integration: "github" },
  ])
    assert.equal(
      await raw(VAULT_METHODS.integrationConnect, body),
      "refused",
      JSON.stringify(body),
    );
  assert.equal(
    await raw(VAULT_METHODS.integrationPut, {
      userId: "u1",
      integration: "slack",
      credential: CREDENTIAL,
    }),
    "refused",
  );
  assert.equal(slack.seen.length + atl.seen.length, sent, "nobody called");
  assert.equal(accountsSnapshot(dir), before, "nothing written");
  noSlackSecretsIn(v.lines);
});

test("connect answers decode per integration; any other shape is unavailable", async () => {
  const name = "n".repeat(256);
  const answers: [Integration, unknown, unknown][] = [
    [
      "slack",
      { ok: true, teamId: FAKE_TEAM_ID },
      { ok: true, teamId: FAKE_TEAM_ID },
    ],
    [
      "slack",
      { ok: true, teamId: FAKE_TEAM_ID, teamName: name },
      { ok: true, teamId: FAKE_TEAM_ID, teamName: name },
    ],
    ["slack", { ok: false, team: "mismatch" }, { ok: false, team: "mismatch" }],
    ["slack", { ok: false, rejected: true }, { ok: false, rejected: true }],
    [
      "slack",
      { ok: false, unreachable: true },
      { ok: false, unreachable: true },
    ],
    [
      "slack",
      { ok: false, notConfigured: true },
      { ok: false, notConfigured: true },
    ],
    ["slack", { ok: false, locked: true }, { ok: false, locked: true }],
    ["slack", { ok: true, teamId: "tfake" }, { ok: false, unavailable: true }],
    [
      "slack",
      { ok: true, teamId: FAKE_TEAM_ID, teamName: "" },
      { ok: false, unavailable: true },
    ],
    [
      "slack",
      { ok: true, teamId: FAKE_TEAM_ID, teamName: `${name}n` },
      { ok: false, unavailable: true },
    ],
    [
      "slack",
      { ok: true, teamId: FAKE_TEAM_ID, teamName: 1 },
      { ok: false, unavailable: true },
    ],
    [
      "slack",
      { ok: true, site: FAKE_SITE, cloudId: FAKE_CLOUD_ID },
      { ok: false, unavailable: true },
    ],
    ["slack", { ok: false, site: "missing" }, { ok: false, unavailable: true }],
    ["slack", { ok: false, team: "other" }, { ok: false, unavailable: true }],
    ["slack", "ok", { ok: false, unavailable: true }],
    [
      "atlassian",
      { ok: true, teamId: FAKE_TEAM_ID },
      { ok: false, unavailable: true },
    ],
    [
      "atlassian",
      { ok: false, team: "mismatch" },
      { ok: false, unavailable: true },
    ],
    [
      "atlassian",
      { ok: true, site: FAKE_SITE, cloudId: FAKE_CLOUD_ID },
      { ok: true, site: FAKE_SITE, cloudId: FAKE_CLOUD_ID },
    ],
    [
      "atlassian",
      { ok: false, site: "ambiguous" },
      { ok: false, site: "ambiguous" },
    ],
  ];
  const held = await holdingVault(answers.map(([, answer]) => answer));
  const remote = await link(held.port);
  for (const [integration, answer, decoded] of answers) {
    const request = { code: FAKE_CODE, redirectUri: FAKE_REDIRECT };
    assert.deepEqual(
      integration === "slack"
        ? await remote.integrationConnect("u1", "slack", request)
        : await remote.integrationConnect("u1", "atlassian", request),
      decoded,
      JSON.stringify(answer),
    );
  }
});

test("Slack: an edge-side timeout during a held refresh answers unavailable; the vault still stores and serves the rotation", async () => {
  const { dir } = sealingDir();
  const v = await bothVault(dir);
  const first = await link(v.port);
  await unlock(v.control);
  slack.expiresInS = 60;
  await connectSlackU1(first);
  first.close();
  const remote = await link(v.port, 300);
  slack.expiresInS = 43_200;
  const held = slack.hold("access");
  const reading = remote.integrationGet("u1", "slack");
  await held.arrived;
  assert.deepEqual(await reading, { ok: false, unavailable: true });
  held.release();
  const rotated = (): boolean =>
    slackStored(dir).refreshToken === slack.issuedRefresh.at(-1);
  await until(rotated, "the rotated record");
  assert.ok(existsSync(slackSealedOf(dir)));
  const sent = slack.refreshesSent().length;
  // Cached by the finished refresh: no second refresh.
  const record = await remote.integrationGet("u1", "slack");
  assert.equal(record.ok, true, JSON.stringify(record));
  assert.equal(slack.refreshesSent().length, sent);
  noSlackSecretsIn(v.lines);
});

test("Atlassian and Slack side by side over the link: separate records and refreshes; clearing one leaves the other", async () => {
  const { dir } = sealingDir();
  const v = await bothVault(dir);
  const remote = await link(v.port);
  await unlock(v.control);
  atl.expiresInS = 60;
  slack.expiresInS = 60;
  const [atlassian, slackAnswer] = await Promise.all([
    connectU1(remote),
    connectSlackU1(remote),
  ]);
  assert.equal(atlassian.ok, true, JSON.stringify(atlassian));
  assert.equal(slackAnswer.ok, true, JSON.stringify(slackAnswer));
  assert.notEqual(DIR_ID, SLACK_DIR_ID);
  assert.equal(storedRefresh(dir), atl.issuedRefresh.at(-1));
  assert.equal(slackStored(dir).refreshToken, slack.issuedRefresh.at(-1));
  const atlBefore = refreshesSent().length;
  const [a, s] = await Promise.all([
    remote.integrationGet("u1", "atlassian"),
    remote.integrationGet("u1", "slack"),
  ]);
  assert.match(accessOf(a), /^fake-atl-access-\d+$/);
  assert.equal(accessOf(s), slack.issuedAccess.at(-1));
  assert.equal(refreshesSent().length, atlBefore + 1);
  assert.equal(slack.refreshesSent().length, 1);
  assert.deepEqual(await remote.integrationClear("u1", "slack"), { ok: true });
  assert.deepEqual(await remote.integrationGet("u1", "slack"), {
    ok: false,
    absent: true,
  });
  accessOf(await remote.integrationGet("u1", "atlassian"));
  assert.ok(existsSync(sealedOf(dir)));
  noSlackSecretsIn(v.lines);
});
