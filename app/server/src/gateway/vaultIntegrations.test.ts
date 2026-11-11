/**
 * Users' integration credentials in the vault (Task-1397): `integrations.*`
 * over `gateway-vault/1.0` to a vault process in this one, sealed to a
 * software recipient, locked after a restart, swept and resealed like token
 * files, and every remote call bounded. Every value is fake.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
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
import { afterAll, afterEach, test } from "vitest";
import { WorkerConnection } from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import { createRemoteVault, type RemoteVault } from "./remoteVault.ts";
import { recipientOf, writeRecipients } from "./sealedStore.ts";
import { askVaultControl } from "./vaultControl.ts";
import {
  GATEWAY_VAULT_PROTOCOL,
  GATEWAY_VAULT_VERSION,
  INTEGRATION_FILE,
  VAULT_LIMITS,
  VAULT_METHODS,
  integrationDirId,
  vaultMessage,
} from "./vaultMethods.ts";
import { startVaultServer, type RunningVaultServer } from "./vaultServer.ts";
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

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
  const server = tls.createServer(
    {
      key: vaultId.keyPem,
      cert: vaultId.certPem,
      ca: edgeId.certPem,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
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
