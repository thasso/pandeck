/**
 * The sealed store (plan Task-1395): the `pandeck-sealed/1` record format,
 * seal-after-write, the sweep, reseal, the migration, and unlock through the
 * control socket with a fake YubiKey helper that speaks `pivChild.ts`'s
 * protocol over a software key. Every key and token is a fake.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { openPivHelper, type PivHelperCommand } from "./pivChild.ts";
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
import { createVaultIntegrations } from "./vaultIntegrations.ts";
import { createVaultLogins } from "./vaultLogins.ts";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";

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

test("integration records are sealed after a write, swept on drift, left alone without plaintext, and discarded on clear", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  const lines: string[] = [];
  const store = await unlockedStore(dir, lines);
  const integrations = createVaultIntegrations({
    stateDir: dir,
    written: store.written,
    discarded: store.discarded,
  });
  const dirId = integrationDirId("u1", "atlassian");
  const record = join(dir, "sealed", dirId, `${INTEGRATION_FILE}.sealed`);
  const plaintext = join(dir, "accounts", dirId, INTEGRATION_FILE);
  const opened = async (): Promise<string | undefined> =>
    recipient.kind === "software"
      ? (
          await openRecord(
            parseSealedRecord(JSON.parse(readFileSync(record, "utf8")))!,
            dirId,
            INTEGRATION_FILE,
            ecdhWith(
              readFileSync(recipient.privateKeyFile, "utf8"),
              recipient.kid,
            ),
          )
        )?.toString("utf8")
      : undefined;

  assert.deepEqual(
    await integrations.integrationPut("u1", "atlassian", '{"fake":1}'),
    { ok: true },
  );
  assert.equal(await opened(), '{"fake":1}');
  // The AAD binds it to its directory: it opens as no other.
  assert.equal(
    await openRecord(
      parseSealedRecord(JSON.parse(readFileSync(record, "utf8")))!,
      integrationDirId("u2", "atlassian"),
      INTEGRATION_FILE,
      ecdhWith(
        readFileSync(
          (recipient as { privateKeyFile: string }).privateKeyFile,
          "utf8",
        ),
        recipient.kid,
      ),
    ),
    undefined,
  );

  writeFileSync(plaintext, '{"fake":2}');
  store.sweep();
  assert.equal(await opened(), '{"fake":2}');

  rmSync(plaintext);
  const kept = readFileSync(record, "utf8");
  store.sweep();
  assert.equal(readFileSync(record, "utf8"), kept);

  assert.deepEqual(await integrations.integrationClear("u1", "atlassian"), {
    ok: true,
  });
  assert.equal(existsSync(join(dir, "sealed", dirId)), false);
  store.sweep();
  assert.equal(existsSync(record), false);
  for (const line of lines) assert.ok(!line.includes("fake"), line);
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
  await logins.discardCredential("acc-login");
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

// --- review fixes ----------------------------------------------------------

/** A sealed record to one fresh key, and that key's ECDH. */
function sealedToOne(): {
  record: SealedRecord;
  ecdh: (kid: string, epk: Buffer) => Buffer | undefined;
} {
  const a = keyPair();
  const kid = keyIdOf(recipientPublicKey(a.publicKeyPem));
  return {
    record: sealRecord(Buffer.from(claudeJson(TOKEN)), "acc", "auth.json", [
      { kid, publicKeyPem: a.publicKeyPem },
    ]),
    ecdh: ecdhWith(a.privateKeyPem, kid),
  };
}

const truncate = (b64: string, bytes: number): string =>
  Buffer.from(b64, "base64").subarray(0, bytes).toString("base64");

test("C1: a truncated tag never opens, on the body or the wrapped key", async () => {
  const { record, ecdh } = sealedToOne();
  assert.ok(await openRecord(record, "acc", "auth.json", ecdh));
  const entry = record.recipients[0]!;
  for (const bad of [
    { ...record, tag: truncate(record.tag, 4) },
    { ...record, recipients: [{ ...entry, tag: truncate(entry.tag, 4) }] },
    {
      ...record,
      tag: truncate(record.tag, 4),
      recipients: [{ ...entry, tag: truncate(entry.tag, 4) }],
    },
  ]) {
    assert.equal(parseSealedRecord(bad), undefined);
    assert.equal(await openRecord(bad, "acc", "auth.json", ecdh), undefined);
  }
});

test("C1: malformed fields do not parse", () => {
  const { record } = sealedToOne();
  const entry = record.recipients[0]!;
  const offCurve = Buffer.from(entry.epk, "base64");
  offCurve[64] = offCurve[64]! ^ 1;
  const withEntry = (patch: Partial<typeof entry>) => ({
    ...record,
    recipients: [{ ...entry, ...patch }],
  });
  for (const bad of [
    { ...record, iv: truncate(record.iv, 11) },
    { ...record, ct: `${record.ct.slice(0, -1)}!` },
    { ...record, recipients: [] },
    withEntry({ iv: truncate(entry.iv, 11) }),
    withEntry({ wrapped: truncate(entry.wrapped, 31) }),
    withEntry({ epk: offCurve.toString("base64") }),
    withEntry({ epk: truncate(entry.epk, 33) }),
    withEntry({ kid: entry.kid.toUpperCase() }),
    withEntry({ kid: entry.kid.slice(1) }),
    // Non-canonical base64: the last pad bits set.
    withEntry({
      tag: entry.tag.replace(/.(==)$/, (_m, pad: string) => `B${pad}`),
    }),
  ])
    assert.equal(parseSealedRecord(bad), undefined, JSON.stringify(bad));
  assert.ok(parseSealedRecord(JSON.parse(JSON.stringify(record))));
});

test("C2: an invalid recipients file is a startup error, and sealed/ never runs unsealed", () => {
  const good = (dir: string) => softwareRecipient(dir, "soft");
  const cases: [string, (dir: string) => string][] = [
    ["malformed JSON", () => "{"],
    ["another version", (d) => JSON.stringify({ v: 2, recipients: [good(d)] })],
    ["an empty list", () => JSON.stringify({ v: 1, recipients: [] })],
    [
      "a misspelled kind",
      (d) =>
        JSON.stringify({ v: 1, recipients: [{ ...good(d), kind: "sofware" }] }),
    ],
    [
      "a missing field",
      (d) => {
        const { privateKeyFile: _drop, ...rest } = good(d) as Extract<
          Recipient,
          { kind: "software" }
        >;
        return JSON.stringify({ v: 1, recipients: [rest] });
      },
    ],
    [
      "a key that is not P-256",
      (d) => {
        const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
        return JSON.stringify({
          v: 1,
          recipients: [
            {
              ...good(d),
              publicKeyPem: rsa.publicKey.export({
                type: "spki",
                format: "pem",
              }),
            },
          ],
        });
      },
    ],
    [
      "a key id not its key's",
      (d) =>
        JSON.stringify({
          v: 1,
          recipients: [{ ...good(d), kid: "0".repeat(64) }],
        }),
    ],
  ];
  for (const [what, content] of cases) {
    const dir = stateDir();
    writeFileSync(join(dir, "vault-recipients.json"), content(dir));
    assert.throws(
      () => createSealedStore({ stateDir: dir, log: () => {} }),
      /vault recipients/,
      what,
    );
  }
  // A sealed installation without its recipients file refuses to start.
  const sealedDir = stateDir();
  mkdirSync(join(sealedDir, "sealed", "acc-1"), { recursive: true });
  assert.throws(
    () => createSealedStore({ stateDir: sealedDir, log: () => {} }),
    /refusing to start unsealed/,
  );
});

test("C3: a helper that cannot spawn answers failed and closes", async () => {
  const helper = openPivHelper({
    file: join(root, "no-such-python"),
    args: [],
  });
  assert.deepEqual(await helper.request({ op: "public", slot: "9d" }), {
    error: "failed",
  });
  await helper.close();
});

test("C4: a failed write leaves the vault locked with nothing installed; a retry leaves no plaintext for a record that does not open", async () => {
  const dir = stateDir();
  writeRecipients(dir, [softwareRecipient(dir, "soft")]);
  writeToken(dir, "acc-1", TOKEN);
  writeToken(dir, "acc-2", "fake-second-token");
  await sealExisting(dir);
  // acc-2's directory is a file: its write fails.
  rmSync(join(dir, "accounts", "acc-2"), { recursive: true });
  writeFileSync(join(dir, "accounts", "acc-2"), "blocker");
  // A stale copy of acc-1 is cleared by the rollback too.
  writeToken(dir, "acc-1", "fake-stale-token");
  const store = createSealedStore({ stateDir: dir, log: () => {} });
  assert.ok(store);
  assert.deepEqual(await store.unlock("unused"), { failed: "write" });
  assert.equal(store.locked(), true);
  assert.equal(existsSync(tokenPath(dir, "acc-1")), false);

  // Retry: acc-1's record no longer opens, and a stale copy of it is removed.
  rmSync(join(dir, "accounts", "acc-2"));
  writeFileSync(recordPath(dir, "acc-1"), "not a record");
  writeToken(dir, "acc-1", "fake-stale-token");
  assert.deepEqual(await store.unlock("unused"), {
    ok: true,
    opened: 1,
    unopened: 1,
  });
  assert.equal(existsSync(tokenPath(dir, "acc-1")), false);
  assert.equal(
    readFileSync(tokenPath(dir, "acc-2"), "utf8"),
    claudeJson("fake-second-token"),
  );
});

test("C5: a stale first recipient falls through to a usable second (software and piv)", async () => {
  // Software: the first key's file is gone.
  const dir = stateDir();
  const first = softwareRecipient(dir, "first");
  const second = softwareRecipient(dir, "second");
  writeRecipients(dir, [first, second]);
  writeToken(dir, "acc-1", TOKEN);
  await sealExisting(dir);
  assert.equal(first.kind, "software");
  if (first.kind === "software") rmSync(first.privateKeyFile);
  assert.deepEqual(
    await createSealedStore({ stateDir: dir, log: () => {} })!.unlock("unused"),
    {
      ok: true,
      opened: 1,
      unopened: 0,
    },
  );

  // PIV: an old key in the same slot, replaced on the YubiKey by the new one.
  const pivDir = stateDir();
  const helper = fakeHelper(pivDir);
  const old = recipientOf(keyPair().publicKeyPem, { slot: "9d" });
  writeRecipients(pivDir, [old, helper.recipient]);
  writeToken(pivDir, "acc-1", TOKEN);
  await sealExisting(pivDir);
  assert.deepEqual(readRecord(pivDir, "acc-1").recipients[0]!.kid, old.kid);
  const store = createSealedStore({
    stateDir: pivDir,
    log: () => {},
    pivHelper: helper.command,
  });
  assert.deepEqual(await store!.unlock(PIN), {
    ok: true,
    opened: 1,
    unopened: 0,
  });
  assert.equal(
    readFileSync(tokenPath(pivDir, "acc-1"), "utf8"),
    claudeJson(TOKEN),
  );
});

test("an unreadable account directory is not skipped: the sweep logs it and reseal refuses", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  const lines: string[] = [];
  const store = await unlockedStore(dir, lines);
  writeToken(dir, "acc-dir", TOKEN);
  const accountDir = join(dir, "accounts", "acc-dir");
  chmodSync(accountDir, 0o000);
  try {
    store.sweep();
    assert.ok(
      lines.includes("sealing account acc-dir failed; the sweep retries"),
      lines.join("\n"),
    );
    assert.throws(() => store.reseal(), /could not be read/);
  } finally {
    chmodSync(accountDir, 0o700);
  }
  store.sweep();
  assert.equal(await opensWith(dir, "acc-dir", recipient), claudeJson(TOKEN));
});

test("vault-seal-existing fails naming an unreadable account, seals the readable one, and a rerun completes", async () => {
  const dir = stateDir();
  const recipient = softwareRecipient(dir, "soft");
  writeRecipients(dir, [recipient]);
  writeToken(dir, "acc-ok", TOKEN);
  writeToken(dir, "acc-locked", "fake-locked-token");
  mkdirSync(join(dir, "login-tmp", "claude-x"), { recursive: true });
  writeFileSync(join(dir, "login-tmp", "claude-x", ".credentials.json"), "x");
  const locked = join(dir, "accounts", "acc-locked");
  chmodSync(locked, 0o000);
  let message = "";
  try {
    await sealExisting(dir).then(
      () => assert.fail("the migration succeeded"),
      (err: Error) => (message = err.message),
    );
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.match(message, /acc-locked/);
  assert.equal(message.includes("acc-ok"), false);
  // The readable one is sealed, verified and removed as before.
  assert.equal(existsSync(tokenPath(dir, "acc-ok")), false);
  assert.equal(await opensWith(dir, "acc-ok", recipient), claudeJson(TOKEN));
  // The unreadable one is untouched: no record, its plaintext kept, and the
  // login leftovers stay until a run succeeds.
  assert.equal(existsSync(recordPath(dir, "acc-locked")), false);
  assert.equal(
    readFileSync(tokenPath(dir, "acc-locked"), "utf8"),
    claudeJson("fake-locked-token"),
  );
  assert.equal(existsSync(join(dir, "login-tmp")), true);
  // The rerun seals the rest and cleans up.
  assert.deepEqual(await sealExisting(dir), { sealed: 1 });
  assert.equal(existsSync(tokenPath(dir, "acc-locked")), false);
  assert.equal(
    await opensWith(dir, "acc-locked", recipient),
    claudeJson("fake-locked-token"),
  );
  assert.equal(existsSync(join(dir, "login-tmp")), false);
});

test("gateway-admin vault-seal-existing exits 1 and names the unreadable account", () => {
  const dir = stateDir();
  writeRecipients(dir, [softwareRecipient(dir, "soft")]);
  writeToken(dir, "acc-locked", TOKEN);
  const locked = join(dir, "accounts", "acc-locked");
  chmodSync(locked, 0o000);
  try {
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("src/gateway/adminMain.ts"),
        "--state-dir",
        dir,
        "--control-socket",
        join(dir, "absent.sock"),
        "vault-seal-existing",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } },
    );
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /vault-seal-existing failed: .*acc-locked/);
    assert.equal(run.stdout.includes("the plaintext is removed"), false);
    assert.equal(`${run.stdout}${run.stderr}`.includes(TOKEN), false);
  } finally {
    chmodSync(locked, 0o700);
  }
}, 60_000);
