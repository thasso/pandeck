/**
 * The sealed store (plan Task-1395): the `pandeck-sealed/1` record format,
 * seal-after-write, the sweep, reseal, the migration, and unlock through the
 * control socket with a fake YubiKey helper that speaks `pivChild.ts`'s
 * protocol over a software key. Every key and token is a fake.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { PivHelperCommand } from "./pivChild.ts";
import {
  keyIdOf,
  openRecord,
  parseSealedRecord,
  recipientPublicKey,
  sealRecord,
  softwareEcdh,
  type SealedRecord,
} from "./sealedRecord.ts";
import {
  createSealedStore,
  pivPublicKeyPem,
  readRecipients,
  recipientOf,
  sealExisting,
  writeRecipients,
  type Recipient,
  type SealedStore,
} from "./sealedStore.ts";
import { askVaultControl, startVaultControl } from "./vaultControl.ts";
import { createVaultLogins } from "./vaultLogins.ts";

const root = mkdtempSync(join(tmpdir(), "sealed-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "fake-sealed-access-token";
const PIN = "fake-pin-271828";
const EXPIRES = Date.now() + 3_600_000;

function keyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
  };
}

function softwareRecipient(dir: string, name: string): Recipient {
  const pair = keyPair();
  const privateKeyFile = join(dir, `${name}.pem`);
  writeFileSync(privateKeyFile, pair.privateKeyPem, { mode: 0o600 });
  return recipientOf(pair.publicKeyPem, { privateKeyFile });
}

const ecdhWith =
  (privateKeyPem: string, kid: string) => (wanted: string, epk: Buffer) =>
    wanted === kid ? softwareEcdh(privateKeyPem, epk) : undefined;

/**
 * A fake helper over a software key: the PIN and key file in argv (test
 * only), three tries, the same JSON lines as `pivHelper.py`.
 */
function fakeHelper(dir: string): {
  command: PivHelperCommand;
  recipient: Recipient;
} {
  const pair = keyPair();
  const keyFile = join(dir, "piv-key.pem");
  writeFileSync(keyFile, pair.privateKeyPem, { mode: 0o600 });
  const script = join(dir, "fake-piv.mjs");
  writeFileSync(
    script,
    `
import { createInterface } from "node:readline";
import { createECDH, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
const [keyFile, pin] = process.argv.slice(2);
const key = createPrivateKey(readFileSync(keyFile, "utf8"));
let tries = 3;
let verified = false;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  let a = { error: "failed" };
  if (m.op === "public")
    a = { ok: true, spki: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") };
  else if (m.op === "verify") {
    if (m.pin === pin) { verified = true; a = { ok: true }; }
    else { tries--; a = tries === 0 ? { error: "blocked" } : { error: "wrong_pin", triesLeft: tries }; }
  } else if (m.op === "ecdh" && verified) {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(key.export({ format: "jwk" }).d, "base64url"));
    a = { ok: true, secret: ecdh.computeSecret(Buffer.from(m.epk, "base64")).toString("base64") };
  }
  process.stdout.write(JSON.stringify(a) + "\\n");
}
`,
  );
  return {
    command: { file: process.execPath, args: [script, keyFile, PIN] },
    recipient: recipientOf(pair.publicKeyPem, { slot: "9d" }),
  };
}

function claudeJson(access: string): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: access, expiresAt: EXPIRES },
  });
}

function stateDir(): string {
  const dir = mkdtempSync(join(root, "vault-"));
  mkdirSync(join(dir, "accounts"), { mode: 0o700 });
  return dir;
}

const tokenPath = (dir: string, accountId: string) =>
  join(dir, "accounts", accountId, ".credentials.json");
const recordPath = (dir: string, accountId: string) =>
  join(dir, "sealed", accountId, ".credentials.json.sealed");

function writeToken(dir: string, accountId: string, access: string): string {
  mkdirSync(join(dir, "accounts", accountId), { recursive: true });
  writeFileSync(tokenPath(dir, accountId), claudeJson(access));
  return tokenPath(dir, accountId);
}

function readRecord(dir: string, accountId: string): SealedRecord {
  const record = parseSealedRecord(
    JSON.parse(readFileSync(recordPath(dir, accountId), "utf8")),
  );
  assert.ok(record);
  return record;
}

async function opensWith(
  dir: string,
  accountId: string,
  recipient: Recipient,
): Promise<string | undefined> {
  assert.equal(recipient.kind, "software");
  if (recipient.kind !== "software") return undefined;
  const opened = await openRecord(
    readRecord(dir, accountId),
    accountId,
    ".credentials.json",
    ecdhWith(readFileSync(recipient.privateKeyFile, "utf8"), recipient.kid),
  );
  return opened?.toString("utf8");
}

/** A store unlocked by its software recipient. */
async function unlockedStore(
  dir: string,
  lines: string[] = [],
): Promise<SealedStore> {
  const store = createSealedStore({ stateDir: dir, log: (l) => lines.push(l) });
  assert.ok(store);
  const answer = await store.unlock("unused");
  assert.equal("ok" in answer && answer.ok, true);
  return store;
}

// --- the record format ------------------------------------------------------

test("a record opens with its recipient, with either of two, and only as its own account and file", async () => {
  const a = keyPair();
  const b = keyPair();
  const kidA = keyIdOf(recipientPublicKey(a.publicKeyPem));
  const kidB = keyIdOf(recipientPublicKey(b.publicKeyPem));
  const plaintext = Buffer.from(claudeJson(TOKEN));
  const record = sealRecord(plaintext, "acc-1", ".credentials.json", [
    { kid: kidA, publicKeyPem: a.publicKeyPem },
    { kid: kidB, publicKeyPem: b.publicKeyPem },
  ]);
  assert.ok(!JSON.stringify(record).includes(TOKEN));
  for (const [pem, kid] of [
    [a.privateKeyPem, kidA],
    [b.privateKeyPem, kidB],
  ] as const) {
    const opened = await openRecord(
      record,
      "acc-1",
      ".credentials.json",
      ecdhWith(pem, kid),
    );
    assert.ok(opened?.equals(plaintext));
  }
  // A record moved to another account or file does not open.
  const open = (r: SealedRecord, accountId: string, file: string) =>
    openRecord(r, accountId, file, ecdhWith(a.privateKeyPem, kidA));
  assert.equal(await open(record, "acc-2", ".credentials.json"), undefined);
  assert.equal(await open(record, "acc-1", "auth.json"), undefined);
  // A wrong key does not open it.
  const c = keyPair();
  assert.equal(
    await openRecord(
      record,
      "acc-1",
      ".credentials.json",
      ecdhWith(c.privateKeyPem, kidA),
    ),
    undefined,
  );
});

test("tampered ciphertext, wrapped key or tag fails to open", async () => {
  const a = keyPair();
  const kid = keyIdOf(recipientPublicKey(a.publicKeyPem));
  const record = sealRecord(
    Buffer.from(claudeJson(TOKEN)),
    "acc",
    "auth.json",
    [{ kid, publicKeyPem: a.publicKeyPem }],
  );
  const flip = (b64: string): string => {
    const bytes = Buffer.from(b64, "base64");
    bytes[0] = bytes[0]! ^ 1;
    return bytes.toString("base64");
  };
  const tampered: SealedRecord[] = [
    { ...record, ct: flip(record.ct) },
    { ...record, tag: flip(record.tag) },
    {
      ...record,
      recipients: [
        {
          ...record.recipients[0]!,
          wrapped: flip(record.recipients[0]!.wrapped),
        },
      ],
    },
    {
      ...record,
      recipients: [
        { ...record.recipients[0]!, epk: flip(record.recipients[0]!.epk) },
      ],
    },
  ];
  for (const bad of tampered) {
    let opened: Buffer | undefined;
    try {
      opened = await openRecord(
        bad,
        "acc",
        "auth.json",
        ecdhWith(a.privateKeyPem, kid),
      );
    } catch {
      opened = undefined;
    }
    assert.equal(opened, undefined);
  }
});

// --- the store --------------------------------------------------------------

test("without recipients there is no store", () => {
  assert.equal(
    createSealedStore({ stateDir: stateDir(), log: () => {} }),
    undefined,
  );
});

test("written seals a changed file; discard deletes the record; the sweep reseals drift and leaves an unopenable record alone", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  const lines: string[] = [];
  const store = await unlockedStore(dir, lines);

  const file = writeToken(dir, "acc-1", TOKEN);
  store.written(file);
  assert.equal(await opensWith(dir, "acc-1", recipient), claudeJson(TOKEN));
  // Unchanged: not sealed again.
  const before = readFileSync(recordPath(dir, "acc-1"), "utf8");
  store.written(file);
  assert.equal(readFileSync(recordPath(dir, "acc-1"), "utf8"), before);

  // A drifted file: the sweep reseals it.
  writeFileSync(file, claudeJson("fake-drifted-token"));
  store.sweep();
  assert.equal(
    await opensWith(dir, "acc-1", recipient),
    claudeJson("fake-drifted-token"),
  );

  // A record without plaintext (one that did not open) is never touched.
  mkdirSync(join(dir, "sealed", "acc-bad"), { recursive: true });
  writeFileSync(recordPath(dir, "acc-bad"), "not a record");
  store.sweep();
  assert.equal(
    readFileSync(recordPath(dir, "acc-bad"), "utf8"),
    "not a record",
  );

  store.discarded("acc-1");
  assert.equal(existsSync(join(dir, "sealed", "acc-1")), false);
  for (const line of lines) assert.ok(!line.includes("fake-"), line);
});

test("a login's ingest seals the moved-in file in the lane; discard deletes both copies", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  const store = await unlockedStore(dir);
  const sealedInLane: boolean[] = [];
  let inLane = false;
  const logins = createVaultLogins(
    {
      stateDir: dir,
      tempDir: store.loginTempDir,
      written: (f) => {
        sealedInLane.push(inLane);
        store.written(f);
      },
      discarded: store.discarded,
      drivers: {
        claude: (configDir) => {
          // The driver writes inside the RAM filesystem's login directory.
          assert.ok(configDir.startsWith(store.loginTempDir));
          writeFileSync(
            join(configDir, ".credentials.json"),
            claudeJson(TOKEN),
          );
          return { input: () => {}, cancel: () => {}, done: Promise.resolve() };
        },
      },
    },
    {
      run: async <T>(_id: string, fn: () => Promise<T>) => {
        inLane = true;
        try {
          return await fn();
        } finally {
          inLane = false;
        }
      },
    },
    () => {},
  );
  const tokenFile = logins.newTokenFile("claude", "acc-login");
  const run = logins.login(
    { kind: "claude", accountId: "acc-login", tokenFile, commit: () => true },
    { output: () => {}, url: () => {}, code: () => {} },
  );
  await run!.done;
  assert.deepEqual(sealedInLane, [true]);
  assert.equal(await opensWith(dir, "acc-login", recipient), claudeJson(TOKEN));
  logins.discardCredential("acc-login");
  assert.equal(existsSync(tokenFile), false);
  assert.equal(existsSync(join(dir, "sealed", "acc-login")), false);
});

test("reseal after adding a recipient opens with either key; after removing the old, only with the new", async () => {
  const dir = stateDir();
  const oldKey = softwareRecipient(dir, "old");
  writeRecipients(dir, [oldKey]);
  const store = await unlockedStore(dir);
  store.written(writeToken(dir, "acc-1", TOKEN));

  const newKey = softwareRecipient(dir, "new");
  writeRecipients(dir, [...readRecipients(dir), newKey]);
  assert.equal(store.reseal(), 1);
  assert.equal(await opensWith(dir, "acc-1", oldKey), claudeJson(TOKEN));
  assert.equal(await opensWith(dir, "acc-1", newKey), claudeJson(TOKEN));

  writeRecipients(dir, [newKey]);
  assert.equal(store.reseal(), 1);
  assert.equal(await opensWith(dir, "acc-1", oldKey), undefined);
  assert.equal(await opensWith(dir, "acc-1", newKey), claudeJson(TOKEN));
});

test("vault-seal-existing seals the plaintext files and removes them", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  writeToken(dir, "acc-1", TOKEN);
  writeToken(dir, "acc-2", "fake-other-token");
  mkdirSync(join(dir, "login-tmp", "claude-x"), { recursive: true });
  writeFileSync(join(dir, "login-tmp", "claude-x", ".credentials.json"), "x");
  assert.deepEqual(await sealExisting(dir), { sealed: 2 });
  assert.equal(existsSync(tokenPath(dir, "acc-1")), false);
  assert.equal(existsSync(join(dir, "login-tmp")), false);
  assert.equal(await opensWith(dir, "acc-1", recipient), claudeJson(TOKEN));
  // The unlock brings them back under accounts/.
  await unlockedStore(dir);
  assert.equal(
    readFileSync(tokenPath(dir, "acc-2"), "utf8"),
    claudeJson("fake-other-token"),
  );
});

// --- unlock with the YubiKey helper ---------------------------------------

test("the helper's public key makes a piv recipient with the same key id", async () => {
  const dir = stateDir();
  const helper = fakeHelper(dir);
  const pem = await pivPublicKeyPem("9d", helper.command);
  assert.equal(recipientOf(pem, { slot: "9d" }).kid, helper.recipient.kid);
});

test("unlock through the control socket: a wrong PIN stays locked with tries left; the right one opens every good record, a bad one needs a login", async () => {
  const dir = stateDir();
  const helper = fakeHelper(dir);
  writeRecipients(dir, [helper.recipient]);
  // Two records sealed to the YubiKey's public key, no PIN needed.
  writeToken(dir, "acc-1", TOKEN);
  writeToken(dir, "acc-2", "fake-second-token");
  await sealExisting(dir);
  // A third record that does not open: tampered.
  const record = readRecord(dir, "acc-2");
  mkdirSync(join(dir, "sealed", "acc-3"), { recursive: true });
  writeFileSync(
    recordPath(dir, "acc-3"),
    JSON.stringify({ ...record, accountId: "acc-3" }),
  );
  assert.deepEqual(readdirSync(join(dir, "accounts", "acc-1")), []);

  const lines: string[] = [];
  const store = createSealedStore({
    stateDir: dir,
    log: (l) => lines.push(l),
    pivHelper: helper.command,
  });
  assert.ok(store);
  const unlocked: string[] = [];
  const socket = join(dir, "control.sock");
  const control = await startVaultControl(socket, {
    store,
    log: (l) => lines.push(l),
    unlocked: () => unlocked.push("unlocked"),
  });
  try {
    assert.deepEqual(await askVaultControl(socket, { method: "status" }), {
      locked: true,
    });
    // Sealing and sweeping are no-ops while locked.
    store.sweep();
    assert.deepEqual(
      await askVaultControl(socket, { method: "unlock", pin: "fake-wrong" }),
      { wrong_pin: true, triesLeft: 2 },
    );
    assert.equal(store.locked(), true);
    assert.equal(existsSync(tokenPath(dir, "acc-1")), false);
    assert.deepEqual(await askVaultControl(socket, { method: "reseal" }), {
      failed: "locked",
    });

    assert.deepEqual(
      await askVaultControl(socket, { method: "unlock", pin: PIN }),
      {
        ok: true,
        opened: 2,
        unopened: 1,
      },
    );
    assert.equal(store.locked(), false);
    assert.deepEqual(unlocked, ["unlocked"]);
    assert.equal(
      readFileSync(tokenPath(dir, "acc-1"), "utf8"),
      claudeJson(TOKEN),
    );
    assert.equal(
      readFileSync(tokenPath(dir, "acc-2"), "utf8"),
      claudeJson("fake-second-token"),
    );
    assert.equal(existsSync(tokenPath(dir, "acc-3")), false);
    assert.ok(
      lines.some((l) => l.includes("account acc-3: sealed")),
      lines.join("\n"),
    );
    // The sweep leaves the unopenable record as it was.
    const bad = readFileSync(recordPath(dir, "acc-3"), "utf8");
    store.sweep();
    assert.equal(readFileSync(recordPath(dir, "acc-3"), "utf8"), bad);
  } finally {
    await control.close();
  }
  // Sentinel: no PIN or token in any log line.
  for (const line of lines)
    for (const secret of [PIN, "fake-wrong", TOKEN, "fake-second-token"])
      assert.ok(!line.includes(secret), line);
});
