/**
 * Enrollment requests in the client registry (Task-1410): a machine starts a
 * request, a user decides it once by its user code, the machine collects its
 * certificate idempotently. Fake certificates; every value is synthetic and
 * stays inside this process or the child processes it starts, which read the
 * request id from a file in the test's directory.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  AUTOMATIC_APPROVAL_RETAIN_MS,
  type AutomaticProof,
  ClientRegistry,
  ENROLLMENT_REQUEST_RETAIN_MS,
  ENROLLMENT_REQUEST_TTL_MS,
  EnrollmentLimitError,
  MAX_OPEN_REQUESTS,
  MAX_AUTOMATIC_APPROVALS,
  MAX_OPEN_REQUESTS_PER_SOURCE,
  mcpTokenMatches,
  newClientId,
} from "./clientRegistry.ts";

const run = promisify(execFile);
const moduleUrl = new URL("./clientRegistry.ts", import.meta.url).href;
const directories: string[] = [];
const LIMITS = { maxPendingCodes: 4, maxClients: 16 };
const TOKEN = "pgmcp_synthetic-machine-token";
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const KEY = "-----BEGIN PUBLIC KEY-----\nsynthetic\n-----END PUBLIC KEY-----\n";

afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "client-requests-"));
  directories.push(dir);
  const clock = { t: Date.now() };
  /** Runs once, inside the next clock read. */
  let hook: (() => void) | undefined;
  const now = () => {
    const pending = hook;
    hook = undefined;
    pending?.();
    return clock.t;
  };
  const registry = new ClientRegistry(dir, now);
  registry.addUser("u");
  registry.addUser("v");
  return {
    dir,
    clock,
    registry,
    path: join(dir, "clients.json"),
    /** Another process's view of the same file, on the same clock. */
    other: () => new ClientRegistry(dir, () => clock.t),
    onNextClockRead: (run: () => void) => {
      hook = run;
    },
  };
}

function start(registry: ClientRegistry, from = "10.0.0.1", name = "devbox-1") {
  const outcome = registry.startRequest({
    publicKeyPem: KEY,
    mcpTokenHash: sha256(TOKEN),
    name,
    kind: "devbox",
    from,
  });
  assert.ok(outcome.ok);
  return outcome;
}

/** A fake issuer that counts its calls. */
function issuer() {
  const keys: string[] = [];
  return {
    keys,
    issue: (publicKeyPem: string) => {
      keys.push(publicKeyPem);
      const clientId = newClientId();
      const serial = randomBytes(8).toString("hex");
      return {
        clientId,
        certificatePem: `CERT ${clientId} ${serial}`,
        fingerprint: `FP:${serial}`,
      };
    },
  };
}

const never = () => {
  throw new Error("must not issue");
};

function snapshot(path: string) {
  const stat = statSync(path);
  return {
    text: readFileSync(path, "utf8"),
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
  };
}

function stored(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as {
    clients: {
      id: string;
      userId: string;
      label: string;
      mcpTokenHash?: string;
      fingerprint: string;
    }[];
    requests?: Record<string, unknown>[];
  };
}

test("a start keeps only hashes of the request id and user code", () => {
  const { registry, path, clock } = fixture();
  const outcome = start(registry);
  assert.match(outcome.requestId, /^[A-Za-z0-9_-]{43}$/);
  assert.match(
    outcome.userCode,
    /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
  );
  assert.equal(outcome.expiresAt, clock.t + ENROLLMENT_REQUEST_TTL_MS);
  const text = readFileSync(path, "utf8");
  const bare = outcome.userCode.replace("-", "");
  for (const secret of [outcome.requestId, outcome.userCode, bare, TOKEN])
    assert.ok(!text.includes(secret));
  const [request] = stored(path).requests!;
  assert.equal(request!.idHash, sha256(outcome.requestId));
  assert.equal(request!.userCodeHash, sha256(bare));
  assert.equal(request!.mcpTokenHash, sha256(TOKEN));
  assert.equal(request!.from, "10.0.0.1");
});

test("a lookup by user code ignores dash, spaces and case and shows only display fields", () => {
  const { registry, clock } = fixture();
  const { userCode } = start(registry);
  const view = {
    name: "devbox-1",
    kind: "devbox",
    from: "10.0.0.1",
    createdAt: clock.t,
    expiresAt: clock.t + ENROLLMENT_REQUEST_TTL_MS,
  };
  for (const typed of [
    userCode,
    userCode.replace("-", ""),
    userCode.toLowerCase(),
    ` ${userCode.slice(0, 4)} ${userCode.slice(5)} `,
  ])
    assert.deepEqual(registry.enrollmentRequest(typed), view);
  for (const wrong of ["", "AAAA-AAAA", "BCDF-GHJ", `${userCode}B`])
    assert.equal(registry.enrollmentRequest(wrong), undefined);
});

test("misses and waiting collects are read-only, even while a writer holds the lock", () => {
  const { registry, path } = fixture();
  const { requestId, userCode } = start(registry);
  const before = snapshot(path);
  writeFileSync(`${path}.lock`, "another writer");
  assert.deepEqual(registry.collect(requestId, never), { status: "pending" });
  assert.deepEqual(
    registry.collect(randomBytes(32).toString("base64url"), never),
    {
      status: "unknown",
    },
  );
  assert.deepEqual(registry.collect("not an id", never), { status: "unknown" });
  const miss = userCode === "BCDF-BCDF" ? "ZZZZ-ZZZZ" : "BCDF-BCDF";
  assert.equal(registry.decide(miss, "u", true), "unknown");
  assert.equal(registry.decide("nope", "u", false), "unknown");
  assert.equal(registry.knownRequest("not an id"), undefined);
  assert.deepEqual(snapshot(path), before);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), "another writer");
});

test("approve, then collect: one client with the start's token hash; repeats answer the stored certificate and write nothing", () => {
  const { dir, registry, path, clock } = fixture();
  const { requestId, userCode } = start(registry, "10.0.0.1", "laptop");
  assert.equal(registry.decide(userCode, "u", true, LIMITS), "approved");
  assert.equal(registry.enrollmentRequest(userCode), undefined);
  const { issue, keys } = issuer();
  const first = registry.collect(requestId, issue);
  assert.equal(first.status, "approved");
  assert.ok(first.status === "approved" && first.first);
  assert.deepEqual(keys, [KEY]);
  const [client] = stored(path).clients;
  assert.equal(client!.userId, "u");
  assert.equal(client!.id, first.clientId);
  assert.equal(client!.label, "laptop");
  assert.ok(mcpTokenMatches(registry.clients()[0]!, TOKEN));
  assert.deepEqual(stored(path).requests![0]!.issued, {
    clientId: first.clientId,
    certificatePem: first.certificatePem,
  });

  const after = snapshot(path);
  const again = registry.collect(requestId, never);
  assert.deepEqual(again, { ...first, first: false });
  // A restart: a new registry on the same file answers byte-identically.
  clock.t += 60_000;
  const restarted = new ClientRegistry(dir, () => clock.t);
  assert.deepEqual(restarted.collect(requestId, never), {
    ...first,
    first: false,
  });
  assert.deepEqual(snapshot(path), after);
  assert.equal(registry.clients().length, 1);
});

test("the first decision wins; a denied request answers denied and can't be approved", () => {
  const { registry, path } = fixture();
  const a = start(registry);
  assert.equal(registry.decide(a.userCode, "u", false), "denied");
  const before = snapshot(path);
  assert.equal(registry.decide(a.userCode, "u", true), "unknown");
  assert.equal(registry.decide(a.userCode, "v", false), "unknown");
  assert.deepEqual(registry.collect(a.requestId, never), { status: "denied" });
  assert.deepEqual(snapshot(path), before);

  const b = start(registry);
  assert.equal(registry.decide(b.userCode, "u", true), "approved");
  assert.equal(registry.decide(b.userCode, "v", true), "unknown");
  assert.equal(registry.decide(b.userCode, "u", false), "unknown");
  const { issue } = issuer();
  const collected = registry.collect(b.requestId, issue);
  assert.equal(collected.status, "approved");
  assert.equal(registry.clients()[0]!.userId, "u");
  assert.throws(
    () => registry.decide(start(registry).userCode, "nobody", true),
    /No user/,
  );
});

test("expiry: before collect, polls answer expired and issue nothing; lookup and decide are unknown from expiry on", () => {
  const { registry, path, clock } = fixture();
  const pending = start(registry);
  const approved = start(registry);
  assert.equal(registry.decide(approved.userCode, "u", true), "approved");
  clock.t += ENROLLMENT_REQUEST_TTL_MS - 1;
  assert.ok(registry.enrollmentRequest(pending.userCode));
  clock.t += 1;
  const before = snapshot(path);
  assert.equal(registry.enrollmentRequest(pending.userCode), undefined);
  assert.equal(registry.decide(pending.userCode, "u", true), "unknown");
  assert.deepEqual(registry.collect(pending.requestId, never), {
    status: "expired",
  });
  assert.deepEqual(registry.collect(approved.requestId, never), {
    status: "expired",
  });
  assert.deepEqual(snapshot(path), before);
  assert.equal(registry.clients().length, 0);
  clock.t += ENROLLMENT_REQUEST_RETAIN_MS;
  assert.deepEqual(registry.collect(pending.requestId, never), {
    status: "unknown",
  });
  assert.equal(registry.knownRequest(pending.requestId), undefined);
});

test("expiry: after a collect, repeats answer the certificate until the record is swept, then unknown", () => {
  const { registry, path, clock } = fixture();
  const { requestId, userCode } = start(registry);
  registry.decide(userCode, "u", true);
  const first = registry.collect(requestId, issuer().issue);
  assert.equal(first.status, "approved");
  clock.t += ENROLLMENT_REQUEST_TTL_MS + ENROLLMENT_REQUEST_RETAIN_MS - 1;
  assert.deepEqual(registry.collect(requestId, never), {
    ...first,
    first: false,
  });
  clock.t += 1;
  // Past retention the record is gone, whether or not a sweep ran.
  assert.deepEqual(registry.collect(requestId, never), { status: "unknown" });
  assert.equal(stored(path).requests!.length, 1);
  // Another start sweeps it from the file.
  start(registry, "10.0.0.9");
  assert.equal(stored(path).requests!.length, 1);
  assert.ok(!readFileSync(path, "utf8").includes(sha256(requestId)));
  assert.deepEqual(registry.collect(requestId, never), { status: "unknown" });
  // The client stays, for its user to see and revoke.
  assert.equal(registry.clients().length, 1);
});

test("fencing: a repeat collect leaves a cleared or replaced token as it is, and answers revoked for a revoked client", () => {
  const { registry, path } = fixture();
  const collected = (registry_: ClientRegistry) => {
    const { requestId, userCode } = start(registry_);
    registry_.decide(userCode, "u", true);
    const outcome = registry_.collect(requestId, issuer().issue);
    assert.equal(outcome.status, "approved");
    return {
      requestId,
      clientId: outcome.status === "approved" ? outcome.clientId : "",
    };
  };
  const hashOf = (clientId: string) =>
    stored(path).clients.find((c) => c.id === clientId)!.mcpTokenHash;

  const cleared = collected(registry);
  assert.ok(registry.clearMcpToken(cleared.clientId));
  assert.equal(registry.collect(cleared.requestId, never).status, "approved");
  assert.equal(hashOf(cleared.clientId), undefined);

  const replaced = collected(registry);
  const replacement = registry.setMcpToken(replaced.clientId);
  const replacedHash = hashOf(replaced.clientId);
  assert.equal(registry.collect(replaced.requestId, never).status, "approved");
  assert.equal(hashOf(replaced.clientId), replacedHash);
  const client = registry.clients().find((c) => c.id === replaced.clientId)!;
  assert.ok(mcpTokenMatches(client, replacement));
  assert.ok(!mcpTokenMatches(client, TOKEN));

  const revoked = collected(registry);
  assert.ok(registry.revoke(revoked.clientId));
  const before = snapshot(path);
  assert.deepEqual(registry.collect(revoked.requestId, never), {
    status: "revoked",
  });
  assert.deepEqual(snapshot(path), before);
});

test("races: a revocation, a decision or a collect by another instance between the read-only check and the change", () => {
  const { registry, other, onNextClockRead } = fixture();
  // Revoked after the read-only check found the request issued.
  const a = start(registry);
  registry.decide(a.userCode, "u", true);
  const first = registry.collect(a.requestId, issuer().issue);
  assert.equal(first.status, "approved");
  onNextClockRead(() => {
    assert.ok(
      other().revoke(first.status === "approved" ? first.clientId : ""),
    );
  });
  assert.deepEqual(registry.collect(a.requestId, never), { status: "revoked" });

  // Denied after the read-only check found the request undecided.
  const b = start(registry);
  onNextClockRead(() => {
    assert.equal(other().decide(b.userCode, "v", false), "denied");
  });
  assert.equal(registry.decide(b.userCode, "u", true), "unknown");
  assert.deepEqual(registry.collect(b.requestId, never), { status: "denied" });

  // Collected by another instance after the read-only check found it approved.
  const c = start(registry);
  registry.decide(c.userCode, "u", true);
  let theirs: ReturnType<ClientRegistry["collect"]> | undefined;
  onNextClockRead(() => {
    theirs = other().collect(c.requestId, issuer().issue);
  });
  const ours = registry.collect(c.requestId, never);
  assert.equal(theirs!.status, "approved");
  assert.deepEqual(ours, { ...theirs!, first: false });
  assert.equal(
    registry.clients().filter((client) => client.revokedAt === undefined)
      .length,
    1,
  );
});

test("a throwing issue or a failed write leaves no client, no certificate and the request intact", () => {
  const { registry, path } = fixture();
  const { requestId, userCode } = start(registry);
  registry.decide(userCode, "u", true);
  const before = snapshot(path);
  assert.throws(
    () =>
      registry.collect(requestId, () => {
        throw new Error("signing failed");
      }),
    /signing failed/,
  );
  assert.deepEqual(snapshot(path), before);
  assert.equal(existsSync(`${path}.lock`), false);

  // The write itself fails (a full disk, say): the file stays as it was.
  const file = (
    registry as unknown as { file: { write: (value: unknown) => void } }
  ).file;
  const write = file.write;
  file.write = () => {
    throw new Error("ENOSPC");
  };
  assert.throws(() => registry.collect(requestId, issuer().issue), /ENOSPC/);
  file.write = write;
  assert.equal(readFileSync(path, "utf8"), before.text);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(registry.clients().length, 0);
  assert.equal(stored(path).requests![0]!.issued, undefined);

  const outcome = registry.collect(requestId, issuer().issue);
  assert.equal(outcome.status, "approved");
  assert.equal(registry.clients().length, 1);
});

test("admission: open limits release on denial and collection; retention has a separate hard cap", () => {
  const { registry, path, clock } = fixture();
  for (let i = 0; i < MAX_OPEN_REQUESTS_PER_SOURCE; i++)
    start(registry, "10.0.0.1");
  const before = snapshot(path);
  assert.deepEqual(
    registry.startRequest({
      publicKeyPem: KEY,
      mcpTokenHash: sha256(TOKEN),
      name: "x",
      kind: "other",
      from: "10.0.0.1",
    }),
    { ok: false, reason: "source_limit" },
  );
  assert.deepEqual(snapshot(path), before);
  start(registry, "10.0.0.2");
  // Denial frees one of four source slots, while the record remains retained.
  const denied = start(registry, "10.0.0.3");
  registry.decide(denied.userCode, "u", false);
  for (let i = 0; i < 3; i++) start(registry, "10.0.0.3");
  start(registry, "10.0.0.3");

  // A collected approval also frees its source slot and global open slot.
  const completed = start(registry, "10.0.0.4");
  registry.decide(completed.userCode, "u", true);
  assert.equal(
    registry.collect(completed.requestId, issuer().issue).status,
    "approved",
  );
  for (let i = 0; i < 3; i++) start(registry, "10.0.0.4");
  start(registry, "10.0.0.4");

  let source = 10;
  for (let open = 13; open < MAX_OPEN_REQUESTS; open++)
    start(registry, `10.0.1.${source++ % 200}`);
  const full = snapshot(path);
  assert.deepEqual(
    registry.startRequest({
      publicKeyPem: KEY,
      mcpTokenHash: sha256(TOKEN),
      name: "x",
      kind: "other",
      from: "10.9.9.9",
    }),
    { ok: false, reason: "capacity" },
  );
  assert.deepEqual(snapshot(path), full);
  clock.t += ENROLLMENT_REQUEST_TTL_MS;
  // Expired records stay for retention, but no longer count as open.
  start(registry, "10.0.0.1");
  assert.equal(stored(path).requests!.length, MAX_OPEN_REQUESTS + 3);
});

test("retained records have a separate hard cap of 256", () => {
  const { registry, path, clock } = fixture();
  for (let wave = 0; wave < 4; wave++) {
    if (wave > 0) clock.t += ENROLLMENT_REQUEST_TTL_MS / 2;
    for (let i = 0; i < MAX_OPEN_REQUESTS; i++) {
      const request = start(
        registry,
        `10.${wave}.${Math.floor(i / 250)}.${(i % 250) + 1}`,
      );
      assert.equal(registry.decide(request.userCode, "u", false), "denied");
    }
  }
  assert.equal(stored(path).requests!.length, 256);
  const before = snapshot(path);
  assert.deepEqual(
    registry.startRequest({
      publicKeyPem: KEY,
      mcpTokenHash: sha256(TOKEN),
      name: "x",
      kind: "other",
      from: "10.8.8.8",
    }),
    { ok: false, reason: "capacity" },
  );
  assert.deepEqual(snapshot(path), before);
});

test("limits: approved-uncollected requests count as pending codes, codes then approvals", () => {
  const { registry, path } = fixture();
  for (let i = 0; i < 4; i++) registry.createCode("u", `c${i}`, LIMITS);
  const request = start(registry);
  const before = snapshot(path);
  assert.equal(registry.decide(request.userCode, "u", true, LIMITS), "limit");
  assert.deepEqual(snapshot(path), before);
  // Still undecided: another user may approve it, or it may be denied.
  assert.ok(registry.enrollmentRequest(request.userCode));
  assert.equal(
    registry.decide(request.userCode, "v", true, LIMITS),
    "approved",
  );
});

test("limits: approved-uncollected requests count as pending codes, approvals then codes", () => {
  const { registry, path, clock } = fixture();
  const requests = Array.from({ length: 4 }, (_, i) =>
    start(registry, `10.0.0.${i}`),
  );
  for (const request of requests)
    assert.equal(
      registry.decide(request.userCode, "u", true, LIMITS),
      "approved",
    );
  const fifth = start(registry, "10.0.0.9");
  const before = snapshot(path);
  assert.throws(
    () => registry.createCode("u", "fifth", LIMITS),
    EnrollmentLimitError,
  );
  assert.equal(registry.decide(fifth.userCode, "u", true, LIMITS), "limit");
  assert.deepEqual(snapshot(path), before);
  // A collected request is a client, no longer pending.
  assert.equal(
    registry.collect(requests[0]!.requestId, issuer().issue).status,
    "approved",
  );
  registry.createCode("u", "now fits", LIMITS);
  // An expired approval no longer reserves a place.
  clock.t += ENROLLMENT_REQUEST_TTL_MS;
  for (let i = 0; i < 3; i++) registry.createCode("u", `after${i}`, LIMITS);
});

test("limits: active clients plus pending codes and approvals stay within 16", () => {
  const { registry } = fixture();
  for (let i = 0; i < 13; i++) {
    const { requestId, userCode } = start(registry, `10.0.${i}.1`);
    registry.decide(userCode, "u", true, LIMITS);
    registry.collect(requestId, issuer().issue);
  }
  registry.createCode("u", "c", LIMITS);
  const approvals = [0, 1].map((i) => start(registry, `10.1.${i}.1`));
  for (const request of approvals)
    assert.equal(
      registry.decide(request.userCode, "u", true, LIMITS),
      "approved",
    );
  const over = start(registry, "10.2.0.1");
  assert.equal(registry.decide(over.userCode, "u", true, LIMITS), "limit");
  assert.throws(
    () => registry.createCode("u", "over", LIMITS),
    EnrollmentLimitError,
  );
});

test("an older file without requests loads; a malformed requests field is refused", () => {
  const { registry, path } = fixture();
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      users: [{ id: "u", label: "u" }],
      clients: [],
      codes: [],
      accounts: [],
    }),
  );
  assert.deepEqual(
    registry.collect(randomBytes(32).toString("base64url"), never),
    {
      status: "unknown",
    },
  );
  start(registry);
  assert.equal(stored(path).requests!.length, 1);
  writeFileSync(
    path,
    JSON.stringify({
      v: 1,
      users: [],
      clients: [],
      codes: [],
      accounts: [],
      requests: {},
    }),
  );
  assert.throws(
    () => registry.clients(),
    /Failed to read|Invalid gateway client registry/,
  );
});

function child(source: string) {
  return run(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    source,
  ]);
}

test("across processes, competing collects create exactly one client and all answer its certificate", async () => {
  const { dir, registry } = fixture();
  const { requestId, userCode } = start(registry);
  registry.decide(userCode, "u", true);
  const input = join(dir, "race-input.json");
  writeFileSync(input, JSON.stringify({ requestId }), { mode: 0o600 });
  const answers = await Promise.all(
    [0, 1, 2, 3].map(async () => {
      const { stdout } = await child(
        `import { readFileSync } from "node:fs";
         import { randomBytes } from "node:crypto";
         import { ClientRegistry, newClientId } from ${JSON.stringify(moduleUrl)};
         const { requestId } = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"));
         const r = new ClientRegistry(${JSON.stringify(dir)});
         const outcome = r.collect(requestId, () => {
           const clientId = newClientId();
           const serial = randomBytes(8).toString("hex");
           return { clientId, certificatePem: "CERT " + clientId + " " + serial, fingerprint: "FP:" + serial };
         });
         console.log(JSON.stringify(outcome));`,
      );
      return JSON.parse(stdout) as {
        status: string;
        clientId: string;
        certificatePem: string;
        first: boolean;
      };
    }),
  );
  assert.equal(registry.clients().length, 1);
  assert.equal(answers.filter((answer) => answer.first).length, 1);
  for (const answer of answers) {
    assert.equal(answer.status, "approved");
    assert.equal(answer.clientId, registry.clients()[0]!.id);
    assert.equal(answer.certificatePem, answers[0]!.certificatePem);
  }
}, 20_000);

test("across processes, competing decisions: exactly one wins and the file holds it", async () => {
  const { dir, registry, path } = fixture();
  const { requestId, userCode } = start(registry);
  const input = join(dir, "race-input.json");
  writeFileSync(input, JSON.stringify({ userCode }), { mode: 0o600 });
  const outcomes = await Promise.all(
    [true, false, true, false].map(async (approve, i) => {
      const { stdout } = await child(
        `import { readFileSync } from "node:fs";
         import { ClientRegistry } from ${JSON.stringify(moduleUrl)};
         const { userCode } = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"));
         const r = new ClientRegistry(${JSON.stringify(dir)});
         console.log(JSON.stringify(r.decide(userCode, ${JSON.stringify(i % 2 ? "v" : "u")}, ${approve})));`,
      );
      return JSON.parse(stdout) as string;
    }),
  );
  const won = outcomes.filter((outcome) => outcome !== "unknown");
  assert.equal(won.length, 1);
  assert.equal(outcomes.filter((outcome) => outcome === "unknown").length, 3);
  const decision = stored(path).requests![0]!.decision;
  if (won[0] === "denied") {
    assert.equal(decision, "denied");
    assert.deepEqual(registry.collect(requestId, never), { status: "denied" });
  } else {
    assert.equal((decision as { userId: string }).userId, "u");
    assert.equal(
      registry.collect(requestId, issuer().issue).status,
      "approved",
    );
  }
}, 20_000);

// Automatic approval (Task-1410 PR2): a devbox proof approves a request
// without a click. Every token, subject and email here is synthetic.

const GOOGLE = "https://accounts.google.com";
const FAKE_OWNER_TOKEN = "FAKE_owner-google-access-token-1";
const FAKE_OTHER_TOKEN = "FAKE_owner-google-access-token-2";
const MINUTE = 60_000;

/** A proof for `subject`, valid ten minutes from `at` unless told. */
function proof(
  at: number,
  change: Partial<AutomaticProof> & { token?: string } = {},
): AutomaticProof {
  const { token = FAKE_OWNER_TOKEN, ...rest } = change;
  return {
    issuer: GOOGLE,
    subject: "FAKE_sub-owner",
    email: "owner@example.test",
    tokenHash: sha256(token),
    notAfter: at + 10 * MINUTE,
    ...rest,
  };
}

function storedState(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as {
    users: { id: string; label: string; email?: string; oidc?: unknown }[];
    claims?: unknown[];
    requests?: { decision?: unknown }[];
    automaticApprovals?: { tokenHash: string; at: number }[];
  };
}

/** Rewrites the file with `automaticApprovals` as given, mode kept. */
function seedApprovals(
  path: string,
  entries: { tokenHash: string; at: number }[],
) {
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  state.automaticApprovals = entries;
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

const usersWith = (registry: ClientRegistry, subject: string) =>
  registry
    .users()
    .filter(
      (user) => user.oidc?.issuer === GOOGLE && user.oidc.subject === subject,
    );

test("automatic: an unknown identity gets exactly one new user, which a later sign-in finds; the decision is marked automatic and collects", () => {
  const { registry, clock, path } = fixture();
  const request = start(registry);
  const outcome = registry.approveAutomatically(
    request.requestId,
    proof(clock.t),
    LIMITS,
  );
  assert.equal(outcome.status, "approved");
  assert.ok(outcome.status === "approved" && outcome.created);
  const [user, ...more] = usersWith(registry, "FAKE_sub-owner");
  assert.equal(more.length, 0);
  assert.deepEqual(user, {
    id: outcome.userId,
    label: "owner@example.test",
    oidc: { issuer: GOOGLE, subject: "FAKE_sub-owner" },
    email: "owner@example.test",
  });
  assert.deepEqual(storedState(path).requests![0]!.decision, {
    userId: outcome.userId,
    at: clock.t,
    automatic: true,
  });
  assert.deepEqual(
    registry.signIn({
      issuer: GOOGLE,
      subject: "FAKE_sub-owner",
      email: "owner@example.test",
    }),
    { userId: outcome.userId, outcome: "existing" },
  );
  // The page no longer sees it; the machine's first poll collects.
  assert.equal(registry.enrollmentRequest(request.userCode), undefined);
  const collected = registry.collect(request.requestId, issuer().issue);
  assert.equal(collected.status, "approved");
  assert.equal(registry.clients()[0]!.userId, outcome.userId);
  assert.equal(registry.clients()[0]!.mcpTokenHash, sha256(TOKEN));
});

test("automatic: an existing identity approves for that user and updates its email as a sign-in does", () => {
  const { registry, clock } = fixture();
  const signedIn = registry.signIn({
    issuer: GOOGLE,
    subject: "FAKE_sub-owner",
    email: "old@example.test",
  });
  const outcome = registry.approveAutomatically(
    start(registry).requestId,
    proof(clock.t, { email: "Owner@Example.test" }),
    LIMITS,
  );
  assert.deepEqual(outcome, {
    status: "approved",
    userId: signedIn.userId,
    created: false,
  });
  const user = registry.user(signedIn.userId)!;
  assert.equal(user.email, "owner@example.test");
  assert.equal(
    user.label,
    "owner@example.test",
    "a label that was the email follows it",
  );
  assert.equal(registry.users().length, 3);
});

test("automatic: a user with the same email and no identity is never bound; a new user is made", () => {
  const { registry, clock } = fixture();
  registry.addUser("w", "owner@example.test");
  const outcome = registry.approveAutomatically(
    start(registry).requestId,
    proof(clock.t),
    LIMITS,
  );
  assert.ok(outcome.status === "approved" && outcome.created);
  assert.notEqual(outcome.userId, "w");
  assert.equal(registry.user("w")!.oidc, undefined);
});

test("automatic: an unexpired claim on the email answers claim_pending and leaves the file byte-identical; the page's sign-in then binds it", () => {
  const { registry, clock, path } = fixture();
  registry.claimUser("u", "owner@example.test", 15 * MINUTE);
  const request = start(registry);
  const before = snapshot(path);
  assert.deepEqual(
    registry.approveAutomatically(request.requestId, proof(clock.t), LIMITS),
    { status: "claim_pending" },
  );
  assert.deepEqual(snapshot(path), before);
  assert.deepEqual(registry.collect(request.requestId, never), {
    status: "pending",
  });
  assert.deepEqual(
    registry.signIn({
      issuer: GOOGLE,
      subject: "FAKE_sub-owner",
      email: "owner@example.test",
    }),
    { userId: "u", outcome: "bound" },
  );
  // Bound, the identity now approves for that user.
  const outcome = registry.approveAutomatically(
    request.requestId,
    proof(clock.t),
    LIMITS,
  );
  assert.deepEqual(outcome, {
    status: "approved",
    userId: "u",
    created: false,
  });
  // An expired claim does not hold a new identity back.
  registry.claimUser("v", "late@example.test", MINUTE);
  clock.t += 2 * MINUTE;
  const late = registry.approveAutomatically(
    start(registry, "10.0.0.2").requestId,
    proof(clock.t, {
      subject: "FAKE_sub-late",
      email: "late@example.test",
      token: FAKE_OTHER_TOKEN,
    }),
    LIMITS,
  );
  assert.ok(late.status === "approved" && late.created);
  assert.notEqual(late.userId, "v");
});

test("automatic: a page decision first leaves no second decision; an expired or unknown request answers unknown; nothing written", () => {
  const { registry, clock, path } = fixture();
  const decided = start(registry);
  assert.equal(registry.decide(decided.userCode, "u", false), "denied");
  const expired = start(registry, "10.0.0.2");
  const before = snapshot(path);
  for (const requestId of [decided.requestId, "A".repeat(43), "not-an-id"])
    assert.deepEqual(
      registry.approveAutomatically(requestId, proof(clock.t), LIMITS),
      { status: "unknown" },
    );
  assert.deepEqual(snapshot(path), before);
  assert.deepEqual(registry.collect(decided.requestId, never), {
    status: "denied",
  });
  clock.t += ENROLLMENT_REQUEST_TTL_MS;
  assert.deepEqual(
    registry.approveAutomatically(expired.requestId, proof(clock.t), LIMITS),
    { status: "unknown" },
  );
  assert.deepEqual(snapshot(path), before);
});

test("automatic: an existing user at its limits answers limit, the request undecided, the file byte-identical", () => {
  const { registry, clock, path } = fixture();
  const { userId } = registry.signIn({
    issuer: GOOGLE,
    subject: "FAKE_sub-owner",
    email: "owner@example.test",
  });
  for (let i = 0; i < LIMITS.maxPendingCodes; i++)
    registry.createCode(userId, `code ${i}`, LIMITS);
  const request = start(registry);
  const before = snapshot(path);
  // A changed email would be written by an approval; a refusal drops it.
  assert.deepEqual(
    registry.approveAutomatically(
      request.requestId,
      proof(clock.t, { email: "renamed@example.test" }),
      LIMITS,
    ),
    { status: "limit" },
  );
  assert.deepEqual(snapshot(path), before);
  assert.deepEqual(registry.collect(request.requestId, never), {
    status: "pending",
  });
});

test("automatic: a proof at or past its notAfter answers expired and writes nothing", () => {
  const { registry, clock, path } = fixture();
  const request = start(registry);
  const before = snapshot(path);
  for (const notAfter of [clock.t, clock.t - 1])
    assert.deepEqual(
      registry.approveAutomatically(
        request.requestId,
        proof(clock.t, { notAfter }),
        LIMITS,
      ),
      { status: "expired" },
    );
  assert.deepEqual(snapshot(path), before);
  assert.equal(
    registry.approveAutomatically(
      request.requestId,
      proof(clock.t, { notAfter: clock.t + 1 }),
      LIMITS,
    ).status,
    "approved",
  );
});

test("automatic: a proof whose notAfter passes while it waits for the lock answers expired; users, ledger and request untouched", () => {
  const { dir, clock, path, registry } = fixture();
  const request = start(registry);
  const notAfter = clock.t + 2_000;
  const lock = `${path}.lock`;
  writeFileSync(lock, "another writer");
  let waits = 0;
  // The other writer finishes while time passes the proof's notAfter.
  const waiting = new ClientRegistry(
    dir,
    () => clock.t,
    undefined,
    () => {
      waits += 1;
      clock.t = notAfter;
      unlinkSync(lock);
    },
  );
  const before = snapshot(path);
  assert.deepEqual(
    waiting.approveAutomatically(
      request.requestId,
      proof(clock.t, { notAfter }),
      LIMITS,
    ),
    { status: "expired" },
  );
  assert.equal(waits, 1);
  assert.deepEqual(snapshot(path), before);
  assert.equal(usersWith(registry, "FAKE_sub-owner").length, 0);
  assert.equal(storedState(path).automaticApprovals, undefined);
  assert.equal(storedState(path).requests![0]!.decision, undefined);
});

test("automatic: one token approves once, also after its request was swept and after a restart", () => {
  const { registry, clock, path, other } = fixture();
  const t0 = clock.t;
  const first = start(registry);
  assert.equal(
    registry.approveAutomatically(
      first.requestId,
      proof(t0, { notAfter: t0 + 60 * MINUTE }),
      LIMITS,
    ).status,
    "approved",
  );
  // Never collected: expired at 10 min, swept at 20 min.
  clock.t = t0 + 21 * MINUTE;
  const second = start(registry);
  assert.equal(storedState(path).requests!.length, 1, "the first is swept");
  const before = snapshot(path);
  const again = proof(clock.t, {
    notAfter: clock.t + 30 * MINUTE,
    subject: "FAKE_sub-other",
    email: "other@example.test",
  });
  assert.deepEqual(
    registry.approveAutomatically(second.requestId, again, LIMITS),
    { status: "already_used" },
  );
  assert.deepEqual(
    other().approveAutomatically(second.requestId, again, LIMITS),
    { status: "already_used" },
    "a new registry instance reads the same record",
  );
  assert.deepEqual(snapshot(path), before, "the refused new user is not kept");
  assert.equal(usersWith(registry, "FAKE_sub-other").length, 0);
  // Another token of the same owner approves.
  const third = registry.approveAutomatically(
    second.requestId,
    proof(clock.t, { token: FAKE_OTHER_TOKEN }),
    LIMITS,
  );
  assert.equal(third.status, "approved");
  assert.deepEqual(
    storedState(path).automaticApprovals!.map((entry) => entry.tokenHash),
    [sha256(FAKE_OWNER_TOKEN), sha256(FAKE_OTHER_TOKEN)],
  );
  const text = readFileSync(path, "utf8");
  assert.ok(
    !text.includes(FAKE_OWNER_TOKEN) && !text.includes(FAKE_OTHER_TOKEN),
    "no token in the file",
  );
});

test("automatic: two requests around a token's expiry: before it already_used, after it expired, never two approvals", () => {
  const { registry, clock, path } = fixture();
  const t0 = clock.t;
  const notAfter = t0 + 2_000;
  const a = start(registry, "10.0.0.1");
  const b = start(registry, "10.0.0.2");
  assert.equal(
    registry.approveAutomatically(a.requestId, proof(t0, { notAfter }), LIMITS)
      .status,
    "approved",
  );
  // B's proof of the same token, taken before it expired.
  clock.t = t0 + 1_000;
  assert.deepEqual(
    registry.approveAutomatically(b.requestId, proof(t0, { notAfter }), LIMITS),
    { status: "already_used" },
  );
  clock.t = t0 + 3_000;
  assert.deepEqual(
    registry.approveAutomatically(b.requestId, proof(t0, { notAfter }), LIMITS),
    { status: "expired" },
  );
  const decided = storedState(path).requests!.filter(
    (r) => r.decision !== undefined,
  );
  assert.equal(decided.length, 1);
  assert.equal(storedState(path).automaticApprovals!.length, 1);
});

test("automatic: a token's record blocks for 61 minutes: at 60 min 59 s already_used, at 61 min dropped and approved again", () => {
  const { registry, clock, path } = fixture();
  const t0 = clock.t;
  registry.approveAutomatically(start(registry).requestId, proof(t0), LIMITS);
  assert.equal(AUTOMATIC_APPROVAL_RETAIN_MS, 61 * MINUTE);
  // Test-only notAfter values: a real proof of this token ended long before.
  clock.t = t0 + 61 * MINUTE - 1_000;
  const late = start(registry);
  assert.deepEqual(
    registry.approveAutomatically(late.requestId, proof(clock.t), LIMITS),
    { status: "already_used" },
  );
  clock.t = t0 + 61 * MINUTE;
  assert.equal(
    registry.approveAutomatically(late.requestId, proof(clock.t), LIMITS)
      .status,
    "approved",
  );
  assert.deepEqual(storedState(path).automaticApprovals, [
    { tokenHash: sha256(FAKE_OWNER_TOKEN), at: clock.t },
  ]);
});

test("automatic: 256 live records answer unavailable and write nothing; 256 records older than 61 minutes are dropped", () => {
  const { registry, clock, path } = fixture();
  const request = start(registry);
  const filler = (at: number) =>
    Array.from({ length: MAX_AUTOMATIC_APPROVALS }, (_, i) => ({
      tokenHash: sha256(`FAKE_filler-${i}`),
      at,
    }));
  assert.equal(MAX_AUTOMATIC_APPROVALS, 256);
  seedApprovals(path, filler(clock.t - 60 * MINUTE));
  const before = snapshot(path);
  assert.deepEqual(
    registry.approveAutomatically(request.requestId, proof(clock.t), LIMITS),
    { status: "unavailable" },
  );
  assert.deepEqual(snapshot(path), before);
  assert.equal(usersWith(registry, "FAKE_sub-owner").length, 0);
  seedApprovals(path, filler(clock.t - 61 * MINUTE));
  assert.equal(
    registry.approveAutomatically(request.requestId, proof(clock.t), LIMITS)
      .status,
    "approved",
  );
  assert.deepEqual(storedState(path).automaticApprovals, [
    { tokenHash: sha256(FAKE_OWNER_TOKEN), at: clock.t },
  ]);
});

test("an older file without automaticApprovals loads; a malformed one is refused", () => {
  const { registry, path } = fixture();
  start(registry);
  assert.equal(storedState(path).automaticApprovals, undefined);
  const state = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  state.automaticApprovals = {};
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
  assert.throws(
    () => registry.clients(),
    /Failed to read|Invalid gateway client registry/,
  );
});

/** Resolves once every path exists; polls every 10 ms, 10 s at most. */
async function whenAll(paths: string[], what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("across processes, a page sign-in and an automatic approval for one new subject make exactly one user, and both name it", async () => {
  const { dir, registry } = fixture();
  const rounds = [0, 1, 2].map((i) => ({
    requestId: start(registry, `10.0.1.${i}`).requestId,
    subject: `FAKE_sub-race-${i}`,
    email: `race-${i}@example.test`,
    tokenHash: sha256(`FAKE_race-token-${i}`),
  }));
  const input = join(dir, "race-input.json");
  writeFileSync(input, JSON.stringify(rounds), { mode: 0o600 });
  // The writers overlap by construction. Each child loads and builds its
  // registry, says it is ready, and waits for the go. This test holds the
  // registry's lock (a fake lock wait) until every writer's lock wait has
  // begun, so whatever a writer does before its locked change sees the state
  // from before the race, and every locked change runs after both have
  // started.
  const lock = join(dir, "clients.json.lock");
  const go = join(dir, "race-go");
  writeFileSync(lock, "test\n", { mode: 0o600 });
  const writers = rounds.flatMap((_, i) =>
    (["signIn", "auto"] as const).map((kind) => ({
      i,
      kind,
      ready: join(dir, `race-ready-${i}-${kind}`),
      waiting: join(dir, `race-waiting-${i}-${kind}`),
    })),
  );
  const runs = writers.map(async ({ i, kind, ready, waiting }) => {
    const { stdout } = await child(
      `import { existsSync, readFileSync, writeFileSync } from "node:fs";
       import { ClientRegistry } from ${JSON.stringify(moduleUrl)};
       const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
       const round = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"))[${i}];
       const pause = (ms) => {
         if (!existsSync(${JSON.stringify(waiting)})) writeFileSync(${JSON.stringify(waiting)}, "");
         sleep(ms);
       };
       const r = new ClientRegistry(${JSON.stringify(dir)}, Date.now, () => {}, pause);
       const identity = { issuer: ${JSON.stringify(GOOGLE)}, subject: round.subject, email: round.email };
       writeFileSync(${JSON.stringify(ready)}, "");
       while (!existsSync(${JSON.stringify(go)})) sleep(5);
       console.log(JSON.stringify(${JSON.stringify(kind)} === "signIn"
         ? r.signIn(identity)
         : r.approveAutomatically(round.requestId, { ...identity, tokenHash: round.tokenHash, notAfter: Date.now() + 600000 }, { maxPendingCodes: 4, maxClients: 16 })));`,
    );
    return {
      i,
      kind,
      answer: JSON.parse(stdout) as { userId: string; status?: string },
    };
  });
  try {
    await whenAll(
      writers.map((writer) => writer.ready),
      "every writer ready",
    );
    writeFileSync(go, "");
    await whenAll(
      writers.map((writer) => writer.waiting),
      "every writer at the lock",
    );
  } finally {
    unlinkSync(lock);
  }
  const answers = await Promise.all(runs);
  for (const round of rounds.map((_, i) => i)) {
    const users = usersWith(registry, rounds[round]!.subject);
    assert.equal(users.length, 1, `round ${round}: one user`);
    const mine = answers.filter((answer) => answer.i === round);
    assert.equal(
      mine.find((a) => a.kind === "auto")!.answer.status,
      "approved",
    );
    for (const answer of mine)
      assert.equal(
        answer.answer.userId,
        users[0]!.id,
        `round ${round}: ${answer.kind}`,
      );
  }
}, 20_000);

test("across processes, competing automatic approvals with one token: exactly one approves", async () => {
  const { dir, registry, path } = fixture();
  const requestIds = [0, 1, 2, 3].map(
    (i) => start(registry, `10.0.2.${i}`).requestId,
  );
  const input = join(dir, "race-input.json");
  writeFileSync(
    input,
    JSON.stringify({ requestIds, tokenHash: sha256(FAKE_OWNER_TOKEN) }),
    { mode: 0o600 },
  );
  const outcomes = await Promise.all(
    requestIds.map(async (_, i) => {
      const { stdout } = await child(
        `import { readFileSync } from "node:fs";
         import { ClientRegistry } from ${JSON.stringify(moduleUrl)};
         const { requestIds, tokenHash } = JSON.parse(readFileSync(${JSON.stringify(input)}, "utf8"));
         const r = new ClientRegistry(${JSON.stringify(dir)});
         console.log(JSON.stringify(r.approveAutomatically(requestIds[${i}], { issuer: ${JSON.stringify(GOOGLE)}, subject: "FAKE_sub-owner", email: "owner@example.test", tokenHash, notAfter: Date.now() + 600000 }, { maxPendingCodes: 4, maxClients: 16 }).status));`,
      );
      return JSON.parse(stdout) as string;
    }),
  );
  assert.deepEqual([...outcomes].sort(), [
    "already_used",
    "already_used",
    "already_used",
    "approved",
  ]);
  assert.equal(usersWith(registry, "FAKE_sub-owner").length, 1);
  assert.equal(
    storedState(path).requests!.filter((r) => r.decision !== undefined).length,
    1,
  );
  assert.equal(storedState(path).automaticApprovals!.length, 1);
}, 20_000);
