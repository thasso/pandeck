/**
 * A vault's stop (Task-1387 AC8): `close()` resolves only once every renewal
 * it started has been sealed and every login and child it started has ended,
 * and it admits no renewal after it began. A sealing vault with a software
 * recipient; Claude renews against a fake token endpoint, Codex through fake
 * ports and children. The source entry `vaultMain.ts` exits 0 on SIGTERM only
 * after its login child's group is gone. Every value is fake.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import {
  startFakeUpstreams,
  type FakeUpstreams,
} from "../test/gatewayFixtures.ts";
import { codexChildPort } from "./codexChild.ts";
import { loginChildDriver } from "./loginChild.ts";
import { ProfileRegistry } from "./profiles.ts";
import type { CodexRenewPort } from "./renewal.ts";
import { openRecord, parseSealedRecord, softwareEcdh } from "./sealedRecord.ts";
import {
  createSealedStore,
  recipientOf,
  sealExisting,
  writeRecipients,
  type SealedStore,
} from "./sealedStore.ts";
import { askVaultControl } from "./vaultControl.ts";
import { createRemoteVault } from "./remoteVault.ts";
import { createVault, type Vault } from "./vault.ts";
import { LOGIN_CREDENTIAL_FILE, vaultTlsFile } from "./vaultMethods.ts";
import type { LoginDrivers } from "./vaultPort.ts";
import { selfSignedIdentity } from "./x509.ts";
import { processRuns } from "../test/processState.ts";

/**
 * The continuation after a renewal's port or endpoint answered: while set,
 * the next post-port read waits for `gate`, and the next Claude save runs
 * `beforeSave` and waits for what it returns.
 */
const hold: {
  gate?: Promise<void> | undefined;
  beforeSave?: (() => Promise<void>) | undefined;
} = {};

vi.mock("./profileCredential.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./profileCredential.ts")>();
  return {
    ...actual,
    readCredential: async (
      ...args: Parameters<typeof actual.readCredential>
    ) => {
      const gate = hold.gate;
      hold.gate = undefined;
      await gate;
      return actual.readCredential(...args);
    },
  };
});
vi.mock("./claudeRenewal.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./claudeRenewal.ts")>();
  return {
    ...actual,
    // Async only while held; `renewal.ts` returns it from an async step.
    saveClaude: (...args: Parameters<typeof actual.saveClaude>) => {
      const before = hold.beforeSave;
      hold.beforeSave = undefined;
      return before
        ? before().then(() => actual.saveClaude(...args))
        : actual.saveClaude(...args);
    },
  };
});

// Synthetic fixture values; none is a real credential.
const OLD_CLAUDE_REFRESH = "fake-stop-claude-refresh-1";
const NEW_CLAUDE_REFRESH = "fake-stop-claude-refresh-2";
const CODEX_REFRESH = "fake-stop-codex-refresh";
const NEW_CLAUDE_ACCESS = "fake-stop-claude-renewed";

const root = mkdtempSync(join(tmpdir(), "vault-stop-"));
let upstreams: FakeUpstreams;

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claudeToken: (_seen, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: NEW_CLAUDE_ACCESS,
          refresh_token: NEW_CLAUDE_REFRESH,
          expires_in: 28_800,
          scope: "user:inference user:profile",
          token_type: "Bearer",
        }),
      );
    },
  });
});
afterEach(() => {
  hold.gate = undefined;
  hold.beforeSave = undefined;
});
afterAll(async () => {
  await upstreams.close();
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const soon = () => Date.now() + 60_000;

const CREDENTIAL = {
  claude: (access: string) =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: access,
        refreshToken: OLD_CLAUDE_REFRESH,
        expiresAt: soon(),
        scopes: ["user:inference", "user:profile"],
      },
    }),
  "openai-codex": (access: string) =>
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access,
        refresh: CODEX_REFRESH,
        accountId: "fake-stop-codex-account",
        expires: soon(),
      },
    }),
};

interface Rig {
  dir: string;
  vault: Vault;
  store: SealedStore;
  ecdh: (kid: string, epk: Buffer) => Buffer | undefined;
  tokenFile: string;
  written: string[];
}

/** A sealing vault, unlocked, with one leased account of `kind`. */
async function rig(
  kind: "claude" | "openai-codex",
  options: {
    renewCodex?: CodexRenewPort;
    drivers?: LoginDrivers;
  } = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(root, "vault-"));
  mkdirSync(join(dir, "accounts"), { mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const privateKeyFile = join(dir, "soft.pem");
  const privateKeyPem = privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  writeFileSync(privateKeyFile, privateKeyPem, { mode: 0o600 });
  const recipient = recipientOf(
    publicKey.export({ type: "spki", format: "pem" }) as string,
    { privateKeyFile },
  );
  writeRecipients(dir, [recipient]);
  const store = createSealedStore({ stateDir: dir, log: () => {} })!;
  const unlocked = await store.unlock("unused");
  assert.equal("ok" in unlocked && unlocked.ok, true);
  const tokenFile = join(dir, "accounts", "acc", LOGIN_CREDENTIAL_FILE[kind]);
  mkdirSync(join(dir, "accounts", "acc"), { mode: 0o700 });
  writeFileSync(tokenFile, CREDENTIAL[kind]("fake-stop-old-access"));
  const profiles = new ProfileRegistry();
  profiles.sync([
    { id: "acc", provider: kind, name: "acc", enabled: true, tokenFile },
  ]);
  const written: string[] = [];
  const vault = createVault({
    inputs: { profiles, hasLiveLease: () => true, report: () => {} },
    log: () => {},
    holds: {},
    renewal: {
      claudeEndpoint: upstreams.tokenEndpoint,
      renewCodex: options.renewCodex,
      written: (file) => {
        written.push(file);
        store.written(file);
      },
    },
    logins: {
      stateDir: dir,
      drivers: options.drivers ?? {},
      tempDir: store.loginTempDir,
      written: store.written,
    },
  });
  return {
    dir,
    vault,
    store,
    tokenFile,
    written,
    ecdh: (kid, epk) =>
      kid === recipient.kid ? softwareEcdh(privateKeyPem, epk) : undefined,
  };
}

async function sealedCredential(r: Rig, file: string): Promise<string> {
  const record = parseSealedRecord(
    JSON.parse(
      readFileSync(join(r.dir, "sealed", "acc", `${file}.sealed`), "utf8"),
    ),
  );
  assert.ok(record);
  const opened = await openRecord(record, "acc", file, r.ecdh);
  assert.ok(opened);
  return opened.toString("utf8");
}

/** Whether `promise` is still pending after a moment. */
async function pending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => false), delay(150).then(() => true)]);
}

test("a Codex renewal finishing during close: close waits for its post-port read and seal", async () => {
  let release!: () => void;
  let closing: Promise<void> | undefined;
  let calls = 0;
  const r: Rig = await rig("openai-codex", {
    renewCodex: async (file) => {
      calls += 1;
      writeFileSync(file, CREDENTIAL["openai-codex"]("fake-stop-codex-new"));
      hold.gate = new Promise((done) => (release = done));
      closing = r.vault.close();
      return { ok: true };
    },
  });
  void r.vault.renewDue();
  await until(() => closing !== undefined, "the port");
  assert.equal(await pending(closing!), true, "close did not wait");
  // Asked after close began: no renewal enters the lane.
  await r.vault.renewDue();
  await r.vault.recheck("acc");
  assert.equal(calls, 1);
  release();
  await closing;
  assert.deepEqual(r.written, [r.tokenFile]);
  assert.match(await sealedCredential(r, "auth.json"), /fake-stop-codex-new/);
});

test("a Claude renewal finishing during close: close waits for its save and seal", async () => {
  let release!: () => void;
  let closing: Promise<void> | undefined;
  const r = await rig("claude");
  // The endpoint has answered: its tokens are in hand, the save is next.
  hold.beforeSave = () => {
    closing = r.vault.close();
    return new Promise((done) => (release = done));
  };
  void r.vault.renewDue();
  await until(() => closing !== undefined, "the token endpoint's answer");
  assert.equal(await pending(closing!), true, "close did not wait");
  const requests = upstreams.platform.length;
  await r.vault.renewDue();
  assert.equal(upstreams.platform.length, requests);
  release();
  await closing;
  assert.deepEqual(r.written, [r.tokenFile]);
  assert.match(
    await sealedCredential(r, ".credentials.json"),
    /fake-stop-claude-renewed/,
  );
});

/** A fixture child: ignores SIGTERM, writes its pid, then `then`. */
function stubbornChild(pidFile: string, then: string): string {
  const path = join(root, `child-${Date.now()}-${Math.random()}.mjs`);
  writeFileSync(
    path,
    `import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
${then}
setInterval(() => {}, 1000);
`,
  );
  return path;
}

test("close during a login whose child ignores SIGTERM: resolves after escalation, an empty group and a removed directory", async () => {
  const pidFile = join(root, `login-${Date.now()}.pid`);
  const script = stubbornChild(
    pidFile,
    `process.stdout.write(JSON.stringify({ type: "output", text: "ready" }) + "\\n");`,
  );
  const r = await rig("claude", {
    drivers: {
      claude: loginChildDriver(
        { file: process.execPath, args: [script] },
        { killGraceMs: 300, log: () => {} },
      ),
    },
  });
  const seen: string[] = [];
  const run = r.vault.login(
    {
      kind: "claude",
      accountId: "acc-new",
      tokenFile: join(r.dir, "accounts", "acc-new", ".credentials.json"),
      commit: () => true,
    },
    { output: (text) => seen.push(text), url() {}, code() {} },
  )!;
  run.done.catch(() => {});
  await until(() => seen.includes("ready"), "the login child");
  const began = Date.now();
  await r.vault.close();
  assert.ok(Date.now() - began >= 300, "close returned before escalation");
  assert.equal(processRuns(Number(readFileSync(pidFile, "utf8"))), false);
  assert.deepEqual(readdirSync(r.store.loginTempDir), []);
  // A closed vault starts no login.
  assert.equal(
    r.vault.login(
      {
        kind: "claude",
        accountId: "acc-late",
        tokenFile: join(r.dir, "accounts", "acc-late", ".credentials.json"),
        commit: () => true,
      },
      { output() {}, url() {}, code() {} },
    ),
    undefined,
  );
});

test("close during a Codex renewal whose child hangs: resolves only once the child is reaped", async () => {
  const pidFile = join(root, `renew-${Date.now()}.pid`);
  const script = stubbornChild(pidFile, "");
  const r = await rig("openai-codex", {
    renewCodex: codexChildPort(
      { file: process.execPath, args: [script] },
      { killGraceMs: 300 },
    ),
  });
  void r.vault.renewDue();
  await until(() => existsSync(pidFile), "the renewal child");
  await r.vault.close();
  assert.equal(processRuns(Number(readFileSync(pidFile, "utf8"))), false);
});

test("vaultMain.ts on SIGTERM during a login exits 0 only after the login child's group is gone", async () => {
  const dir = mkdtempSync(join(root, "entry-"));
  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  vaultTlsFile(dir).write({
    v: 1,
    keyPem: vaultId.keyPem,
    certPem: vaultId.certPem,
    hosts: ["localhost", "127.0.0.1"],
    edgeCertPem: edgeId.certPem,
  });
  // A fake official CLI that ignores SIGTERM, so the driver must escalate.
  const cliPid = join(dir, "cli.pid");
  const cliScript = join(dir, "cli.mjs");
  writeFileSync(
    cliScript,
    `import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(${JSON.stringify(cliPid)}, String(process.pid));
process.stdout.write("Open https://claude.example/oauth?x=1\\n");
setInterval(() => {}, 1000);
`,
  );
  const cli = join(dir, "claude");
  writeFileSync(
    cli,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliScript)} "$@"\n`,
  );
  chmodSync(cli, 0o755);
  const entry = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("src/gateway/vaultMain.ts"),
      "--state-dir",
      dir,
      "--port",
      "0",
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TMPDIR: dir,
        ASSISTANT_CLAUDE_CLI_BIN: cli,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let stdout = "";
  entry.stdout.setEncoding("utf8");
  entry.stdout.on("data", (chunk: string) => (stdout += chunk));
  const exited = new Promise<number | null>((done) =>
    entry.on("exit", (code) => done(code)),
  );
  try {
    await until(() => /port (\d+)/.test(stdout), "the vault to listen");
    const port = Number(/port (\d+)/.exec(stdout)![1]);
    const tokenFile = join(dir, "accounts", "acc-new", ".credentials.json");
    const remote = createRemoteVault(
      {
        host: "127.0.0.1",
        port,
        tls: {
          keyPem: edgeId.keyPem,
          certPem: edgeId.certPem,
          peerCertPem: vaultId.certPem,
        },
      },
      {
        profiles: () => [
          {
            id: "acc-new",
            provider: "claude" as const,
            name: "acc-new",
            enabled: true,
            tokenFile,
          },
        ],
        liveLeases: () => [],
        report: () => {},
        log: () => {},
      },
    );
    try {
      await until(remote.connected, "the vault link");
      remote.inputsChanged();
      const urls: string[] = [];
      const run = remote.login(
        { kind: "claude", accountId: "acc-new", tokenFile, commit: () => true },
        { output() {}, url: (url) => urls.push(url), code() {} },
      )!;
      run.done.catch(() => {});
      await until(() => urls.length > 0 && existsSync(cliPid), "the login");
      entry.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.equal(processRuns(Number(readFileSync(cliPid, "utf8"))), false);
      assert.deepEqual(readdirSync(join(dir, "login-tmp")), []);
    } finally {
      remote.close();
    }
  } finally {
    if (entry.exitCode === null) entry.kill("SIGKILL");
    if (existsSync(cliPid)) {
      try {
        process.kill(Number(readFileSync(cliPid, "utf8")), "SIGKILL");
      } catch {
        // Gone, as it should be.
      }
    }
  }
}, 90_000);

/**
 * The stop-time seal failure through the real entry, with `accounts/` (made by
 * `prepareAccounts`) holding one sealed Claude account. After unlock a renewal
 * writes the file, then the record's directory is replaced by a plain file, so
 * the record cannot be written even by root (a read-only mode would not stop
 * root). `nodeArgs` go before the entry's own.
 */
async function assertSealFailureAtStop(
  dir: string,
  prepareAccounts: () => string,
  nodeArgs: string[] = [],
): Promise<void> {
  const accountsDir = prepareAccounts();
  mkdirSync(join(accountsDir, "claude-a"), { mode: 0o700 });
  const tokenFile = join(accountsDir, "claude-a", ".credentials.json");
  writeFileSync(tokenFile, CREDENTIAL.claude("fake-stop-old-access"));
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const privateKeyFile = join(dir, "soft.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 },
  );
  writeRecipients(dir, [
    recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
      privateKeyFile,
    }),
  ]);
  assert.deepEqual(await sealExisting(dir), { sealed: 1 });
  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  vaultTlsFile(dir).write({
    v: 1,
    keyPem: vaultId.keyPem,
    certPem: vaultId.certPem,
    hosts: ["127.0.0.1"],
    edgeCertPem: edgeId.certPem,
  });
  const controlSocket = join(dir, "c.sock");
  const entry = spawn(
    process.execPath,
    [
      ...nodeArgs,
      "--import",
      "tsx",
      resolve("src/gateway/vaultMain.ts"),
      "--state-dir",
      dir,
      "--port",
      "0",
      "--control-socket",
      controlSocket,
    ],
    {
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  entry.stdout.setEncoding("utf8");
  entry.stderr.setEncoding("utf8");
  entry.stdout.on("data", (chunk: string) => (output += chunk));
  entry.stderr.on("data", (chunk: string) => (output += chunk));
  const exited = new Promise<number | null>((done) =>
    entry.on("exit", (code) => done(code)),
  );
  try {
    await until(
      () => /port \d+/.test(output) || entry.exitCode !== null,
      "the vault to listen",
    );
    assert.match(output, /port \d+/, "the vault did not start");
    assert.deepEqual(
      await askVaultControl(controlSocket, {
        method: "unlock",
        pin: "unused",
      }),
      { ok: true, opened: 1, unopened: 0 },
    );
    // A renewal wrote the file; its record cannot be written.
    writeFileSync(tokenFile, CREDENTIAL.claude("fake-stop-unsealed-access"));
    const recordDir = join(dir, "sealed", "claude-a");
    rmSync(recordDir, { recursive: true });
    writeFileSync(recordDir, "", { mode: 0o600 });
    entry.kill("SIGTERM");
    assert.equal(await exited, 1);
    assert.match(output, /not sealed at stop: claude-a/);
    assert.equal(output.includes("fake-stop-unsealed-access"), false);
  } finally {
    if (entry.exitCode === null) entry.kill("SIGKILL");
  }
}

// Linux only: it needs a real tmpfs, and /dev/shm is one there. Sealing is a
// Linux-only feature (`docs/workers.md` "Sealed store"); macOS has no tmpfs.
test.runIf(process.platform === "linux")(
  "vaultMain.ts on a real tmpfs (Linux /dev/shm) exits 1, naming the account, when a credential cannot be sealed at stop",
  async () => {
    const dir = mkdtempSync(join(root, "seal-exit-"));
    const shm = mkdtempSync("/dev/shm/pandeck-t1387-");
    try {
      await assertSealFailureAtStop(dir, () => {
        symlinkSync(shm, join(dir, "accounts"));
        return shm;
      });
    } finally {
      rmSync(shm, { recursive: true, force: true });
    }
  },
  90_000,
);

/**
 * A test-only preload for the entry: `statfsSync` reports a tmpfs for exactly
 * `target` (canonical) and is the real call for every other path. Each call it
 * answers for `target` appends a line to `hits`, so a preload that never took
 * effect fails the test instead of passing it.
 */
function tmpfsPreload(target: string, hits: string): string {
  return `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const TARGET = ${JSON.stringify(target)};
const HITS = ${JSON.stringify(hits)};
const TMPFS_MAGIC = 0x01021994;
const realStatfsSync = fs.statfsSync;
fs.statfsSync = function statfsSync(path, options) {
  const stats = realStatfsSync.call(this, path, options);
  let canonical;
  try {
    canonical = fs.realpathSync(String(path));
  } catch {
    return stats;
  }
  if (canonical !== TARGET) return stats;
  fs.appendFileSync(HITS, canonical + "\\n");
  const type = typeof stats.type === "bigint" ? BigInt(TMPFS_MAGIC) : TMPFS_MAGIC;
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { type });
};
// The store imports \`statfsSync\` by name: rebind the ESM export too.
syncBuiltinESMExports();
`;
}

// Every platform: the same stop path, on a plain directory the preload above
// reports as a tmpfs. This covers the stop and seal logic, not sealing on a
// platform without a tmpfs: the product still refuses one (`sealedStore.ts`).
test("vaultMain.ts with a simulated tmpfs exits 1, naming the account, when a credential cannot be sealed at stop", async () => {
  const dir = mkdtempSync(join(root, "seal-exit-sim-"));
  const fixture = mkdtempSync(join(root, "tmpfs-preload-"));
  const hits = join(fixture, "statfs-hits");
  const preload = join(fixture, "tmpfs-preload.mjs");
  let target = "";
  await assertSealFailureAtStop(dir, () => {
    const accountsDir = join(dir, "accounts");
    mkdirSync(accountsDir, { mode: 0o700 });
    target = realpathSync(accountsDir);
    writeFileSync(preload, tmpfsPreload(target, hits));
    return accountsDir;
  }, ["--import", pathToFileURL(preload).href]);
  const consulted = readFileSync(hits, "utf8").trim().split("\n");
  assert.ok(consulted.length >= 1, "the simulated tmpfs was never consulted");
  assert.deepEqual(new Set(consulted), new Set([target]));
}, 90_000);
