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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "vitest";
import {
  ClientRegistry,
  ENROLLMENT_REQUEST_RETAIN_MS,
  ENROLLMENT_REQUEST_TTL_MS,
  EnrollmentLimitError,
  MAX_OPEN_REQUESTS,
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

test("admission: at most 4 open requests per source and 64 in all; a refusal writes nothing; expiry frees the place", () => {
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
  // Decided and collected requests stay open until they expire.
  const decided = start(registry, "10.0.0.3");
  registry.decide(decided.userCode, "u", false);
  for (let i = 0; i < 3; i++) start(registry, "10.0.0.3");
  assert.deepEqual(
    registry.startRequest({
      publicKeyPem: KEY,
      mcpTokenHash: sha256(TOKEN),
      name: "x",
      kind: "other",
      from: "10.0.0.3",
    }),
    { ok: false, reason: "source_limit" },
  );
  let source = 10;
  for (let open = 9; open < MAX_OPEN_REQUESTS; open++)
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
  assert.equal(stored(path).requests!.length, MAX_OPEN_REQUESTS + 1);
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
