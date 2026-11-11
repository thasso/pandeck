/**
 * The vault's sealed store (plan Task-1395): with recipients in
 * `<stateDir>/vault-recipients.json`, the vault's disk holds credentials only
 * as `pandeck-sealed/1` records (`sealedRecord.ts`), one per token file at
 * `<stateDir>/sealed/<accountId>/<file>.sealed`. The plaintext token files
 * keep their paths under `<stateDir>/accounts/`, which is then a private RAM
 * filesystem of the vault's service, so every reader and writer is unchanged.
 *
 * - The vault starts **locked**: nothing is read or renewed until `unlock`
 *   opens every record, with the YubiKey through the helper (`pivChild.ts`,
 *   the PIN verified once) or a software key, and writes the plaintext under
 *   `accounts/` (0600). A record that does not open is logged by account id
 *   and left alone: that account needs a login.
 * - **Seal after write:** each writer calls `written` right after it changed
 *   a token file (renewal in its lane, a login's ingest); `discarded` deletes
 *   an account's records. `sweep`, every renewal tick, seals any token file
 *   whose content differs from what was last sealed or opened. A missing
 *   plaintext never touches its record.
 * - Sealing needs public keys only, so it runs unattended.
 *
 * Without a recipients file there is no store and the vault behaves as
 * before. A present but invalid file, or `sealed/` without recipients, is a
 * startup error: the vault never falls back to plaintext on disk. No log line holds a PIN, a token or a file's content; only account ids, counts
 * and fixed codes.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";
import {
  PIV_HELPER,
  openPivHelper,
  type PivHelperCommand,
  type PivSession,
} from "./pivChild.ts";
import {
  keyIdOf,
  openRecord,
  parseSealedRecord,
  recipientPublicKey,
  sealRecord,
  softwareEcdh,
  type RecipientKey,
  type SealedRecord,
} from "./sealedRecord.ts";
import { LOGIN_CREDENTIAL_FILE } from "./vaultMethods.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLOT_RE = /^[0-9a-f]{2}$/;
const TOKEN_FILES = new Set(Object.values(LOGIN_CREDENTIAL_FILE));
const SEALED_SUFFIX = ".sealed";
/** `statfs` type of a tmpfs. */
const TMPFS_MAGIC = 0x01021994;
const HELPER_CODES = new Set(["no_device", "no_key", "failed"]);

export type Recipient =
  | (RecipientKey & { kind: "piv"; slot: string })
  /** A key on disk: tests and self-hosted installs without a YubiKey. */
  | (RecipientKey & { kind: "software"; privateKeyFile: string });

interface RecipientsFile {
  v: 1;
  recipients: Recipient[];
}

function recipientsFile(stateDir: string) {
  return createPrivateJsonFile(
    join(stateDir, "vault-recipients.json"),
    "vault recipients",
    { privateDirectory: "enforce" },
  );
}

function isRecipient(value: unknown): value is Recipient {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.kid !== "string" || typeof r.publicKeyPem !== "string")
    return false;
  return r.kind === "piv"
    ? typeof r.slot === "string" && SLOT_RE.test(r.slot)
    : r.kind === "software" && typeof r.privateKeyFile === "string";
}

/** Whether the entry's key is P-256 and its key id is that key's. */
function keyMatches(recipient: Recipient): boolean {
  try {
    return (
      keyIdOf(recipientPublicKey(recipient.publicKeyPem)) === recipient.kid
    );
  } catch {
    return false;
  }
}

/**
 * The vault's recipients; `[]` when there is no file. A file that is present
 * but unreadable, of another version, empty, or with any invalid entry (a bad
 * kind or field, a key that is not P-256, a key id not its key's) throws:
 * the vault never silently drops to storing plaintext.
 */
export function readRecipients(stateDir: string): Recipient[] {
  return recipientsFile(stateDir).read<RecipientsFile, Recipient[]>((value) => {
    if (value === undefined) return [];
    if (
      typeof value !== "object" ||
      value === null ||
      value.v !== 1 ||
      !Array.isArray(value.recipients) ||
      value.recipients.length === 0 ||
      !value.recipients.every((r) => isRecipient(r) && keyMatches(r))
    )
      throw new Error("invalid recipient list");
    return value.recipients;
  });
}

export function writeRecipients(
  stateDir: string,
  recipients: Recipient[],
): void {
  recipientsFile(stateDir).write({ v: 1, recipients } satisfies RecipientsFile);
}

/** A recipient for `publicKeyPem` (checked P-256), with its key id. */
export function recipientOf(
  publicKeyPem: string,
  where: { slot: string } | { privateKeyFile: string },
): Recipient {
  const key = recipientPublicKey(publicKeyPem);
  const base = {
    kid: keyIdOf(key),
    publicKeyPem: key.export({ type: "spki", format: "pem" }) as string,
  };
  if ("slot" in where) {
    if (!SLOT_RE.test(where.slot)) throw new Error("Not a PIV slot.");
    return { ...base, kind: "piv", slot: where.slot };
  }
  return { ...base, kind: "software", privateKeyFile: where.privateKeyFile };
}

/** The public key in a PIV slot, read through the helper; no PIN. */
export async function pivPublicKeyPem(
  slot: string,
  command: PivHelperCommand = PIV_HELPER,
): Promise<string> {
  const helper = openPivHelper(command);
  try {
    const answer = await helper.request({ op: "public", slot });
    if (answer.ok !== true || typeof answer.spki !== "string")
      throw new Error(
        `The YubiKey's public key could not be read (${helperCode(answer)}).`,
      );
    const der = Buffer.from(answer.spki, "base64").toString("base64");
    return `-----BEGIN PUBLIC KEY-----\n${der.replace(/(.{64})/g, "$1\n")}\n-----END PUBLIC KEY-----\n`;
  } finally {
    await helper.close();
  }
}

function helperCode(answer: Record<string, unknown>): string {
  return typeof answer.error === "string" && HELPER_CODES.has(answer.error)
    ? answer.error
    : "failed";
}

const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** Writes `data` by temp file and same-directory rename, 0600, dir 0700. */
function writePrivate(file: string, data: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = join(
    dirname(file),
    `.${basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Overwrites a file with random bytes, syncs it and removes it. */
function shred(file: string): void {
  const size = statSync(file).size;
  const fd = openSync(file, "r+");
  try {
    writeSync(fd, randomBytes(Math.max(size, 1)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  unlinkSync(file);
}

/** Every `[accountId, file]` with a token file under `accountsDir`. */
function tokenFilesUnder(accountsDir: string): [string, string][] {
  if (!existsSync(accountsDir)) return [];
  return readdirSync(accountsDir).flatMap((accountId) =>
    ID_RE.test(accountId)
      ? [...TOKEN_FILES]
          .filter((file) => existsSync(join(accountsDir, accountId, file)))
          .map((file): [string, string] => [accountId, file])
      : [],
  );
}

export type UnlockAnswer =
  | { ok: true; opened: number; unopened: number }
  | { wrong_pin: true; triesLeft: number }
  | { blocked: true }
  | { failed: string };

export interface SealedStore {
  locked(): boolean;
  /** Opens every record; the PIN goes to the helper and is kept nowhere. */
  unlock(pin: string): Promise<UnlockAnswer>;
  /** A writer changed `tokenFile`: seals it when it differs. Never throws. */
  written(tokenFile: string): void;
  /** Deletes the account's records. */
  discarded(accountId: string): void;
  /** Seals every token file that drifted from its record. */
  sweep(): void;
  /** Re-reads the recipients and seals every token file to them. */
  reseal(): number;
  /** Where logins leave their credential: inside the RAM filesystem. */
  readonly loginTempDir: string;
}

export interface SealedStoreOptions {
  stateDir: string;
  log: (line: string) => void;
  pivHelper?: PivHelperCommand | undefined;
  /** Refuse to start unless `accounts/` is a tmpfs; the real vault sets it. */
  requireTmpfs?: boolean | undefined;
}

/** The store, or undefined when the vault has no recipients. */
export function createSealedStore(
  options: SealedStoreOptions,
): SealedStore | undefined {
  const { stateDir, log } = options;
  let recipients = readRecipients(stateDir);
  const accountsDir = join(resolve(stateDir), "accounts");
  const sealedDir = join(resolve(stateDir), "sealed");
  if (recipients.length === 0) {
    // A sealed installation never downgrades to plaintext on disk.
    if (existsSync(sealedDir))
      throw new Error(
        "sealed records exist but vault-recipients.json is missing: refusing to start unsealed",
      );
    return undefined;
  }
  mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
  if (options.requireTmpfs && statfsSync(accountsDir).type !== TMPFS_MAGIC)
    throw new Error(
      `${accountsDir} is not a tmpfs: plaintext tokens would reach the disk`,
    );
  /** The hash of each token file as last sealed or opened. */
  const known = new Map<string, string>();
  let locked = true;
  let unlocking = false;

  const recordPath = (accountId: string, file: string): string =>
    join(sealedDir, accountId, `${file}${SEALED_SUFFIX}`);

  /** `[accountId, file]` of a token file under `accounts/`, else undefined. */
  const locate = (tokenFile: string): [string, string] | undefined => {
    const parts = relative(accountsDir, resolve(tokenFile)).split(sep);
    return parts.length === 2 &&
      ID_RE.test(parts[0]!) &&
      TOKEN_FILES.has(parts[1]!)
      ? [parts[0]!, parts[1]!]
      : undefined;
  };

  const seal = (accountId: string, file: string, force: boolean): boolean => {
    const path = join(accountsDir, accountId, file);
    let plaintext: Buffer;
    try {
      plaintext = readFileSync(path);
    } catch {
      return false;
    }
    const hash = sha256(plaintext);
    if (!force && known.get(path) === hash) return false;
    writePrivate(
      recordPath(accountId, file),
      JSON.stringify(sealRecord(plaintext, accountId, file, recipients)),
    );
    known.set(path, hash);
    return true;
  };

  const written = (tokenFile: string): void => {
    if (locked) return;
    const at = locate(tokenFile);
    if (!at) return;
    try {
      if (seal(at[0], at[1], false)) log(`sealed account ${at[0]}`);
    } catch {
      log(`sealing account ${at[0]} failed; the sweep retries`);
    }
  };

  /** Every record on disk, `[accountId, file, record or undefined]`. */
  const records = (): [string, string, SealedRecord | undefined][] => {
    if (!existsSync(sealedDir)) return [];
    return readdirSync(sealedDir).flatMap((accountId) =>
      ID_RE.test(accountId)
        ? readdirSync(join(sealedDir, accountId)).flatMap((name) => {
            const file = name.slice(0, -SEALED_SUFFIX.length);
            if (!name.endsWith(SEALED_SUFFIX) || !TOKEN_FILES.has(file))
              return [];
            let record: SealedRecord | undefined;
            try {
              record = parseSealedRecord(
                JSON.parse(
                  readFileSync(join(sealedDir, accountId, name), "utf8"),
                ),
              );
            } catch {
              record = undefined;
            }
            return [[accountId, file, record] as const];
          })
        : [],
    ) as [string, string, SealedRecord | undefined][];
  };

  const unlock = async (pin: string): Promise<UnlockAnswer> => {
    if (!locked) return { ok: true, opened: 0, unopened: 0 };
    if (unlocking) return { failed: "busy" };
    unlocking = true;
    let helper: PivSession | undefined;
    try {
      recipients = readRecipients(stateDir);
      const byKid = new Map(recipients.map((r) => [r.kid, r]));
      if (recipients.some((r) => r.kind === "piv")) {
        helper = openPivHelper(options.pivHelper ?? PIV_HELPER);
        const verified = await helper.request({ op: "verify", pin });
        if (verified.ok !== true) {
          if (verified.error === "wrong_pin")
            return {
              wrong_pin: true,
              triesLeft:
                typeof verified.triesLeft === "number" ? verified.triesLeft : 0,
            };
          if (verified.error === "blocked") return { blocked: true };
          return { failed: helperCode(verified) };
        }
      }
      const ecdh = async (kid: string, epk: Buffer) => {
        const recipient = byKid.get(kid);
        if (!recipient) return undefined;
        if (recipient.kind === "software")
          return softwareEcdh(
            readFileSync(recipient.privateKeyFile, "utf8"),
            epk,
          );
        const answer = await helper!.request({
          op: "ecdh",
          slot: recipient.slot,
          epk: epk.toString("base64"),
        });
        return answer.ok === true && typeof answer.secret === "string"
          ? Buffer.from(answer.secret, "base64")
          : undefined;
      };
      // Software recipients first: they need no round trip.
      const order = (record: SealedRecord): SealedRecord => ({
        ...record,
        recipients: [...record.recipients].sort(
          (a, b) =>
            Number(byKid.get(b.kid)?.kind === "software") -
            Number(byKid.get(a.kid)?.kind === "software"),
        ),
      });
      const opened: [string, string, Buffer][] = [];
      const unopened: string[] = [];
      for (const [accountId, file, record] of records()) {
        let plaintext: Buffer | undefined;
        try {
          plaintext = record
            ? await openRecord(order(record), accountId, file, ecdh)
            : undefined;
        } catch {
          plaintext = undefined;
        }
        if (plaintext) opened.push([accountId, file, plaintext]);
        else {
          unopened.push(join(accountsDir, accountId, file));
          log(
            `account ${accountId}: sealed ${file} did not open; it needs a login`,
          );
        }
      }
      await helper?.close();
      helper = undefined;
      // All or nothing: a failed write or removal clears every token file this
      // unlock touches (written, being written, stale or unopened) and stays
      // locked. A record that did not open keeps no live plaintext.
      const targets = opened.map(([accountId, file]) =>
        join(accountsDir, accountId, file),
      );
      try {
        opened.forEach(([, , plaintext], i) =>
          writePrivate(targets[i]!, plaintext),
        );
        for (const path of unopened) rmSync(path, { force: true });
      } catch {
        let left = 0;
        for (const path of [...targets, ...unopened])
          try {
            rmSync(path, { force: true });
          } catch {
            left++;
          }
        log(
          `unlock: writing the opened records failed; still locked${left ? ` (${left} files not removed)` : ""}`,
        );
        return { failed: "write" };
      }
      for (const [accountId, file, plaintext] of opened)
        known.set(join(accountsDir, accountId, file), sha256(plaintext));
      locked = false;
      log(
        `unlocked: ${opened.length} records opened, ${unopened.length} did not`,
      );
      return { ok: true, opened: opened.length, unopened: unopened.length };
    } finally {
      unlocking = false;
      await helper?.close();
    }
  };

  const sweep = (): void => {
    if (locked) return;
    for (const [accountId, file] of tokenFilesUnder(accountsDir))
      written(join(accountsDir, accountId, file));
  };

  return {
    locked: () => locked,
    unlock,
    written,
    discarded(accountId) {
      if (!ID_RE.test(accountId)) return;
      rmSync(join(sealedDir, accountId), { recursive: true, force: true });
      for (const file of TOKEN_FILES)
        known.delete(join(accountsDir, accountId, file));
    },
    sweep,
    reseal() {
      if (locked) throw new Error("The vault is locked.");
      const next = readRecipients(stateDir);
      if (next.length === 0) throw new Error("The vault has no recipients.");
      recipients = next;
      let count = 0;
      for (const [accountId, file] of tokenFilesUnder(accountsDir))
        if (seal(accountId, file, true)) count++;
      log(`resealed ${count} records to ${recipients.length} recipients`);
      return count;
    },
    loginTempDir: join(accountsDir, ".login-tmp"),
  };
}

/**
 * The one-time migration (`vault-seal-existing`), with the vault stopped:
 * seals every plaintext token file under `accounts/` to the recipients,
 * checks each record reads back (and opens, where a software key can open
 * it), then overwrites and removes the plaintext, and any leftover login
 * directory. Public keys only, no PIN.
 */
export async function sealExisting(
  stateDir: string,
): Promise<{ sealed: number }> {
  const recipients = readRecipients(stateDir);
  if (recipients.length === 0) throw new Error("The vault has no recipients.");
  const accountsDir = join(resolve(stateDir), "accounts");
  const sealedDir = join(resolve(stateDir), "sealed");
  const software = recipients.find((r) => r.kind === "software");
  let sealed = 0;
  for (const [accountId, file] of tokenFilesUnder(accountsDir)) {
    const path = join(accountsDir, accountId, file);
    const plaintext = readFileSync(path);
    const target = join(sealedDir, accountId, `${file}${SEALED_SUFFIX}`);
    writePrivate(
      target,
      JSON.stringify(sealRecord(plaintext, accountId, file, recipients)),
    );
    const back = parseSealedRecord(JSON.parse(readFileSync(target, "utf8")));
    if (!back)
      throw new Error(`The record of account ${accountId} is unreadable.`);
    if (software?.kind === "software") {
      const key = readFileSync(software.privateKeyFile, "utf8");
      const opened = await openRecord(back, accountId, file, (kid, epk) =>
        kid === software.kid ? softwareEcdh(key, epk) : undefined,
      );
      if (!opened?.equals(plaintext))
        throw new Error(`The record of account ${accountId} does not open.`);
    }
    shred(path);
    sealed++;
  }
  for (const temp of [
    join(stateDir, "login-tmp"),
    join(accountsDir, ".login-tmp"),
  ])
    if (existsSync(temp)) {
      for (const entry of readdirSync(temp, { recursive: true }))
        try {
          const path = join(temp, String(entry));
          if (statSync(path).isFile()) shred(path);
        } catch {
          // Gone meanwhile.
        }
      rmSync(temp, { recursive: true, force: true });
    }
  return { sealed };
}
