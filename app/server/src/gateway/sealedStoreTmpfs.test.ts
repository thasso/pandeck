/**
 * The sealed store's tmpfs requirement on every platform: `node:fs`'s
 * `statfsSync` is mocked here, so these run the same on a host whose temp
 * directory is itself a tmpfs. The real, unmocked refusal is in
 * `sealedStore.test.ts`. Every key is a fake.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import {
  createSealedStore,
  recipientOf,
  writeRecipients,
} from "./sealedStore.ts";

const TMPFS_MAGIC = 0x01021994;
const EXT4_MAGIC = 0xef53;

/** What the mocked `statfsSync` answers as `type`, and the paths it got. */
const statfs: { type: number; paths: string[] } = { type: 0, paths: [] };

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const statfsSync = ((path: fs.PathLike, options?: fs.StatFsOptions) => {
    statfs.paths.push(String(path));
    return { ...actual.statfsSync(path, options), type: statfs.type };
  }) as typeof actual.statfsSync;
  return { ...actual, default: { ...actual, statfsSync }, statfsSync };
});

const root = fs.mkdtempSync(join(tmpdir(), "sealed-tmpfs-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let platform: PropertyDescriptor | undefined;
beforeEach(() => {
  statfs.paths = [];
  platform = Object.getOwnPropertyDescriptor(process, "platform");
});
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
});

function onPlatform(name: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { ...platform, value: name });
}

/** A state directory with one software recipient. */
function sealingStateDir(): string {
  const dir = fs.mkdtempSync(join(root, "vault-"));
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const privateKeyFile = join(dir, "soft.pem");
  fs.writeFileSync(
    privateKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    { mode: 0o600 },
  );
  writeRecipients(dir, [
    recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
      privateKeyFile,
    }),
  ]);
  return dir;
}

const create = (dir: string, requireTmpfs: boolean) =>
  createSealedStore({ stateDir: dir, log: () => {}, requireTmpfs });

test("accounts/ on a tmpfs: the sealing store starts, having asked about accounts/", () => {
  statfs.type = TMPFS_MAGIC;
  const dir = sealingStateDir();
  assert.ok(create(dir, true));
  assert.deepEqual(statfs.paths, [join(resolve(dir), "accounts")]);
});

test("accounts/ not a tmpfs on Linux: refused, saying plaintext would reach the disk", () => {
  statfs.type = EXT4_MAGIC;
  onPlatform("linux");
  const dir = sealingStateDir();
  const accountsDir = join(resolve(dir), "accounts");
  assert.throws(() => create(dir, true), {
    message: `${accountsDir} is not a tmpfs: plaintext tokens would reach the disk`,
  });
  assert.deepEqual(statfs.paths, [accountsDir]);
  assert.deepEqual(fs.readdirSync(accountsDir), []);
  assert.equal(fs.existsSync(join(dir, "sealed")), false);
});

test("accounts/ not a tmpfs on macOS: refused, saying a sealed vault needs Linux", () => {
  statfs.type = EXT4_MAGIC;
  onPlatform("darwin");
  const dir = sealingStateDir();
  const accountsDir = join(resolve(dir), "accounts");
  assert.throws(() => create(dir, true), {
    message: `${accountsDir} is not a tmpfs: plaintext tokens would reach the disk; a sealed vault needs Linux, where accounts/ is a tmpfs it can verify (on darwin, run the vault without recipients)`,
  });
  assert.deepEqual(fs.readdirSync(accountsDir), []);
});

test("without requireTmpfs (an in-process vault) the filesystem is not asked", () => {
  statfs.type = EXT4_MAGIC;
  assert.ok(create(sealingStateDir(), false));
  assert.deepEqual(statfs.paths, []);
});

test("without recipients there is no store, sealing or not, on any filesystem", () => {
  statfs.type = EXT4_MAGIC;
  const dir = fs.mkdtempSync(join(root, "unsealed-"));
  assert.equal(create(dir, true), undefined);
  assert.deepEqual(statfs.paths, []);
});
