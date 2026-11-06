import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import { ClientRegistry } from "./clientRegistry.ts";

const directories: string[] = [];
const run = promisify(execFile);
const moduleUrl = new URL("./clientRegistry.ts", import.meta.url).href;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "client-registry-"));
  directories.push(dir);
  const registry = new ClientRegistry(dir);
  registry.addUser("u");
  return { dir, registry, path: join(dir, "clients.json") };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("unknown and expired codes write nothing, not even a lock file", () => {
  const { dir, registry, path } = fixture();
  const expired = registry.createCode("u", "expired");
  const contents = readFileSync(path, "utf8");
  const before = statSync(path);
  // A read-only miss must work even while a writer holds the lock.
  writeFileSync(`${path}.lock`, "another writer");
  const register = () => {
    throw new Error("must not register");
  };
  assert.equal(registry.redeem("unknown", register), undefined);
  assert.equal(
    new ClientRegistry(dir, () => Date.now() + 16 * 60_000).redeem(
      expired,
      register,
    ),
    undefined,
  );
  assert.equal(readFileSync(path, "utf8"), contents);
  assert.equal(statSync(path).ino, before.ino);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), "another writer");
});

test("separate processes preserve revocations and additions under concurrent writes", async () => {
  const { dir, registry } = fixture();
  for (let i = 0; i < 40; i++) {
    const code = registry.createCode("u", "seed");
    registry.redeem(code, () => ({
      id: `c${i}`,
      userId: "u",
      label: "seed",
      fingerprint: `fp${i}`,
      createdAt: 1,
    }));
  }
  const codes = Array.from({ length: 20 }, () =>
    registry.createCode("u", "new client"),
  );
  const redemption = run(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `import { ClientRegistry } from ${JSON.stringify(moduleUrl)};
     const r = new ClientRegistry(${JSON.stringify(dir)});
     for (const [i, code] of ${JSON.stringify(codes)}.entries()) {
       const client = r.redeem(code, () => ({ id: 'new' + i, userId: 'u', label: 'new', fingerprint: 'new' + i, createdAt: 1 }));
       if (!client) throw new Error('redemption lost');
     }`,
  ]);
  await Promise.all([
    redemption,
    ...[0, 1].map((worker) =>
      run(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `import { ClientRegistry } from ${JSON.stringify(moduleUrl)};
     const r = new ClientRegistry(${JSON.stringify(dir)});
     for (let i = ${worker}; i < 40; i += 2) {
       if (!r.revoke('c' + i)) throw new Error('revocation lost');
       r.addUser('u' + i);
       r.setAccountOwner('p' + i, 'u');
     }`,
      ]),
    ),
  ]);
  assert.equal(registry.clients().length, 60);
  assert.equal(
    registry.clients().filter((client) => client.revokedAt !== undefined)
      .length,
    40,
  );
  assert.equal(registry.accountsOf("u").length, 40);
  for (let i = 0; i < 40; i++) assert.ok(registry.user(`u${i}`));
}, 10_000);

test("admin mutations fail loudly on a stale lock and never report success", async () => {
  const { dir, registry, path } = fixture();
  const code = registry.createCode("u", "seed");
  registry.redeem(code, () => ({
    id: "c0",
    userId: "u",
    label: "seed",
    fingerprint: "fp0",
    createdAt: 1,
  }));
  const lock = `${path}.lock`;
  writeFileSync(lock, "2147483647\n");
  const cli = new URL("./adminMain.ts", import.meta.url).pathname;
  await Promise.all(
    [
      ["clients", "revoke", "c0"],
      ["user", "add", "other"],
      ["enroll-code", "--user", "u", "--label", "test"],
    ].map((args) =>
      assert.rejects(
        run(process.execPath, [
          "--import",
          "tsx",
          cli,
          "--state-dir",
          dir,
          ...args,
        ]),
        (err: unknown) => {
          const failure = err as Error & {
            code: number;
            stdout: string;
            stderr: string;
          };
          assert.equal(failure.code, 1);
          assert.equal(failure.stdout, "");
          assert.ok(failure.stderr.includes(lock));
          assert.match(
            failure.stderr,
            /Check that the writer PID.*no longer running before removing the lock/,
          );
          return true;
        },
      ),
    ),
  );
  assert.ok(registry.active("c0", "fp0"));
}, 10_000);

test("failed writes release their lock and corrupt data is not overwritten", () => {
  const { registry, path } = fixture();
  writeFileSync(path, "broken JSON");
  assert.throws(() => registry.addUser("other"), /Failed to read/);
  assert.equal(readFileSync(path, "utf8"), "broken JSON");
  writeFileSync(
    path,
    JSON.stringify({ v: 1, users: [], clients: [], codes: [], accounts: [] }),
  );
  registry.addUser("repaired");
  assert.ok(registry.user("repaired"));
});
