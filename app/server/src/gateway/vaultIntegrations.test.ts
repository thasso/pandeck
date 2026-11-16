/**
 * Users' integration credentials in the vault (Task-1397): `integrations.*`
 * over `gateway-vault/1.1` to a vault process in this one, sealed to a
 * software recipient, locked after a restart, swept and resealed like token
 * files, and every remote call bounded. Atlassian OAuth records (Task-1411):
 * connect, refresh and stop over the real link against a loopback Atlassian
 * fake, sealed, with nothing lost to an edge timeout, a stop or a failed
 * seal. Every value is fake.
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
  vaultMessage,
} from "./vaultMethods.ts";
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

/** The Atlassian fake for the OAuth records' tests (Task-1411). */
let atl: AtlassianFake;
let atlToken: AtlassianFake["token"];
beforeAll(async () => {
  atl = await startAtlassianFake();
  atlToken = atl.token;
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  atl.token = atlToken;
  atl.expiresInS = 3600;
});
afterAll(async () => {
  await atl.close();
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
async function holdingVault(): Promise<{
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
