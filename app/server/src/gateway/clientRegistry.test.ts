import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
  ClientRegistry,
  ClientRegistryLockedError,
  clientListLine,
  mcpTokenMatches,
} from "./clientRegistry.ts";

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

test("a first start without a registry file remains valid", () => {
  const dir = mkdtempSync(join(tmpdir(), "client-registry-new-"));
  directories.push(dir);
  const registry = new ClientRegistry(dir);
  assert.deepEqual(registry.clients(), []);
  assert.deepEqual(registry.clients(), []);
  assert.equal(existsSync(join(dir, "clients.json")), false);
  registry.addUser("u");
  assert.ok(registry.user("u"));
});

test("a previously observed registry must not become empty when its file disappears", () => {
  const { dir, registry, path } = fixture();
  const contents = readFileSync(path, "utf8");
  // The writer has seen its own successful creation even before another read.
  unlinkSync(path);
  assert.throws(() => registry.clients(), /registry.*missing/i);
  assert.throws(() => registry.addUser("other"), /registry.*missing/i);
  assert.equal(existsSync(path), false);
  writeFileSync(path, contents);
  const reader = new ClientRegistry(dir);
  assert.deepEqual(reader.clients(), []);
  unlinkSync(path);
  assert.throws(() => reader.clients(), /registry.*missing/i);
  writeFileSync(path, contents);
  assert.ok(reader.user("u"));
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

test("an MCP token is minted once, kept only as its hash, replaced, cleared and refused for a revoked client", () => {
  const { registry, path } = fixture();
  const client = registry.redeem(
    registry.createCode("u", "box"),
    (pending) => ({
      id: "c1",
      userId: pending.userId,
      label: pending.label,
      fingerprint: "fp",
      createdAt: 1,
    }),
  )!;
  assert.equal(clientListLine(client), "c1\tuser=u\tactive\tmcp=no\tbox");
  const token = registry.setMcpToken("c1");
  assert.match(token, /^pgmcp_[A-Za-z0-9_-]{43}$/);
  assert.ok(!readFileSync(path, "utf8").includes(token));
  const stored = registry.clients()[0]!;
  assert.match(stored.mcpTokenHash!, /^[0-9a-f]{64}$/);
  assert.equal(mcpTokenMatches(stored, token), true);
  assert.equal(mcpTokenMatches(stored, `${token}x`), false);
  assert.equal(clientListLine(stored), "c1\tuser=u\tactive\tmcp=yes\tbox");

  const next = registry.setMcpToken("c1");
  assert.equal(mcpTokenMatches(registry.clients()[0]!, token), false);
  assert.equal(mcpTokenMatches(registry.clients()[0]!, next), true);
  // A stored hash that is not 64 hex characters counts as none.
  assert.equal(
    mcpTokenMatches({ ...stored, mcpTokenHash: "zz" }, token),
    false,
  );

  assert.equal(registry.clearMcpToken("c1"), true);
  assert.equal(registry.clearMcpToken("c1"), false);
  assert.equal(registry.clients()[0]!.mcpTokenHash, undefined);
  assert.throws(() => registry.setMcpToken("nope"), /No active client nope/);
  registry.revoke("c1");
  assert.throws(() => registry.setMcpToken("c1"), /No active client c1/);
});

test("a v1 file without identities or claims loads, and new fields round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "client-registry-v1-"));
  directories.push(dir);
  const path = join(dir, "clients.json");
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      users: [{ id: "thasso", label: "Thasso" }],
      clients: [],
      codes: [],
      accounts: [],
    }),
    { mode: 0o600 },
  );
  const registry = new ClientRegistry(dir);
  assert.deepEqual(registry.users(), [{ id: "thasso", label: "Thasso" }]);
  registry.claimUser("thasso", "Person@Example.org", 60_000);
  assert.deepEqual(
    registry.signIn({
      issuer: "https://issuer.example",
      subject: "s1",
      email: "person@example.org",
    }),
    { userId: "thasso", outcome: "bound" },
  );
  const stored = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(stored.v, 1);
  assert.deepEqual(stored.claims, []);
  assert.deepEqual(stored.users, [
    {
      id: "thasso",
      label: "Thasso",
      oidc: { issuer: "https://issuer.example", subject: "s1" },
      email: "person@example.org",
    },
  ]);
  assert.deepEqual(new ClientRegistry(dir).user("thasso"), stored.users[0]);
});

test("claims expire and are pruned on the next write", () => {
  let clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "client-registry-claims-"));
  directories.push(dir);
  const registry = new ClientRegistry(dir, () => clock);
  registry.addUser("a");
  registry.addUser("b");
  registry.claimUser("a", "a@example.org", 60_000);
  registry.claimUser("b", "b@example.org", 120_000);
  const claims = () =>
    JSON.parse(readFileSync(join(dir, "clients.json"), "utf8")).claims;
  assert.equal(claims().length, 2);
  clock += 90_000;
  registry.addUser("c");
  assert.deepEqual(
    claims().map((c: { userId: string }) => c.userId),
    ["b"],
  );
  // The expired one binds nothing: a new user instead.
  const answer = registry.signIn({
    issuer: "https://issuer.example",
    subject: "s",
    email: "a@example.org",
  });
  assert.equal(answer.outcome, "created");
  assert.match(answer.userId, /^u_[A-Za-z0-9_-]{16}$/);
  assert.throws(
    () => registry.claimUser("nobody", "x@example.org", 1),
    /No user/,
  );
  assert.throws(() => registry.claimUser("b", "not-an-email", 1), /email/);
});

test("signIn writes under the registry lock, and only when something changed", () => {
  const { registry, path } = fixture();
  const identity = {
    issuer: "https://issuer.example",
    subject: "s1",
    email: "p@example.org",
  };
  writeFileSync(`${path}.lock`, "2147483647\n");
  assert.throws(() => registry.signIn(identity), ClientRegistryLockedError);
  assert.equal(registry.users().length, 1);
  unlinkSync(`${path}.lock`);
  const created = registry.signIn(identity);
  assert.equal(created.outcome, "created");
  const before = statSync(path).mtimeMs;
  const written = readFileSync(path, "utf8");
  assert.deepEqual(registry.signIn(identity), {
    userId: created.userId,
    outcome: "existing",
  });
  assert.equal(readFileSync(path, "utf8"), written);
  assert.equal(statSync(path).mtimeMs, before);
});
