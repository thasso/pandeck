import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { LeaseTable } from "./leases.ts";

const BINDING = {
  profileId: "claude-work",
  provider: "claude",
  tokenFile: "/tmp/fixture/.credentials.json",
} as const;
const OWNER = { kind: "engine", owner: { workerId: "w" } } as const;
const GRANTED_AT = 1_800_000_000_000;

function decode(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

test("a lease token is JWT-shaped and its secret is stored only as a hash", () => {
  const leases = new LeaseTable({ now: () => GRANTED_AT });
  const first = leases.grant(BINDING, OWNER);
  const second = leases.grant(BINDING, OWNER);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.leaseId, second.leaseId);

  const segments = first.token.split(".");
  assert.equal(segments.length, 3);
  for (const segment of segments) assert.match(segment, /^[A-Za-z0-9_-]+$/);
  const [header, payload, secret] = segments as [string, string, string];
  assert.deepEqual(JSON.parse(decode(header).toString("utf8")), {
    alg: "none",
    typ: "JWT",
  });
  const claims = JSON.parse(decode(payload).toString("utf8"));
  // pi's openai-codex provider reads this claim from the bearer it is given.
  assert.equal(
    claims["https://api.openai.com/auth"].chatgpt_account_id,
    "pandeck-gateway",
  );
  assert.deepEqual(claims.pandeck, { v: 1, lease: first.leaseId });
  assert.equal(decode(secret).length, 32);

  const records = JSON.stringify(leases.records());
  assert.ok(!records.includes(first.token));
  assert.ok(!records.includes(secret));
  const record = leases.records().find((r) => r.leaseId === first.leaseId);
  assert.deepEqual(record, {
    leaseId: first.leaseId,
    secretHash: createHash("sha256").update(decode(secret)).digest("hex"),
    ...BINDING,
    ...OWNER,
    grantedAt: GRANTED_AT,
  });
});

test("verify answers with the lease's own binding, and a revoked lease names its reason", () => {
  const leases = new LeaseTable();
  const { leaseId, token } = leases.grant(BINDING, OWNER);
  assert.deepEqual(leases.verify(token), {
    ok: true,
    leaseId,
    binding: BINDING,
  });
  assert.equal(leases.revoke("never-granted", "session-ended"), false);
  assert.equal(leases.revoke(leaseId, "account-switch"), true);
  assert.deepEqual(leases.verify(token), {
    ok: false,
    refusal: "revoked",
    leaseId,
    reason: "account-switch",
  });
  assert.equal(
    leases.records().find((r) => r.leaseId === leaseId)?.revoked,
    "account-switch",
  );
});

test("a revoked lease with the wrong secret is unknown, not revoked", () => {
  const leases = new LeaseTable();
  const { leaseId, token } = leases.grant(BINDING, OWNER);
  leases.revoke(leaseId, "session-ended");
  const [header, payload, secret] = token.split(".") as [
    string,
    string,
    string,
  ];
  const forged = `${header}.${payload}.${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;
  assert.deepEqual(leases.verify(forged), { ok: false, refusal: "unknown" });
});

test("a machine lease: one live per client and profile, never verified by token, revoked by the client and profile predicates", () => {
  const leases = new LeaseTable({ now: () => GRANTED_AT });
  const leaseId = leases.grantMachine(BINDING, "client-1");
  const record = leases.records().find((r) => r.leaseId === leaseId)!;
  assert.equal(record.kind, "machine");
  assert.deepEqual(record.owner, { clientId: "client-1" });
  assert.equal(leases.kindOf(leaseId), "machine");
  assert.equal(leases.clientOf(leaseId), "client-1");
  assert.equal(leases.liveMachineLease("client-1", BINDING.profileId), leaseId);
  assert.equal(
    leases.liveMachineLease("client-2", BINDING.profileId),
    undefined,
  );
  assert.equal(leases.liveMachineLease("client-1", "claude-other"), undefined);
  // An engine lease of the same client and profile is no machine lease.
  leases.grant(BINDING, {
    kind: "engine",
    owner: { workerId: "w", clientId: "client-2" },
  });
  assert.equal(
    leases.liveMachineLease("client-2", BINDING.profileId),
    undefined,
  );
  // A machine lease has no session.
  assert.equal(leases.bindSession(leaseId, "s1"), "server");
  assert.equal(leases.isLive(leaseId), true);

  // Even a token carrying its id and secret is refused: grants discard it.
  const other = new LeaseTable({ now: () => GRANTED_AT });
  const { token, leaseId: forged } = other.grant(BINDING, {
    kind: "machine",
    owner: { clientId: "client-1" },
  });
  assert.equal(other.kindOf(forged), "machine");
  assert.deepEqual(other.verify(token), { ok: false, refusal: "unknown" });

  // The client-revoke predicate (`clientListener.ts` revokeClient).
  assert.deepEqual(
    leases.revokeWhere((r) => r.owner.clientId === "client-1", "session-ended"),
    [leaseId],
  );
  assert.equal(leases.isLive(leaseId), false);
  assert.equal(
    leases.liveMachineLease("client-1", BINDING.profileId),
    undefined,
  );
  // The profile-removal predicate.
  const again = leases.grantMachine(BINDING, "client-1");
  assert.ok(
    leases
      .revokeWhere((r) => r.profileId === BINDING.profileId, "profile-removed")
      .includes(again),
  );
  assert.equal(leases.isLive("no-such-lease"), false);
});

test("AC13: a machine lease keeps its profile live for renewal until it is revoked", () => {
  const leases = new LeaseTable({ now: () => GRANTED_AT });
  assert.equal(leases.hasLiveLease(BINDING.profileId), false);
  const leaseId = leases.grantMachine(BINDING, "client-1");
  assert.equal(leases.hasLiveLease(BINDING.profileId), true);
  leases.revoke(leaseId, "session-ended");
  assert.equal(leases.hasLiveLease(BINDING.profileId), false);
});

test("a machine lease survives persist and restore with its kind and client", () => {
  const saved: ReturnType<LeaseTable["records"]>[] = [];
  const leases = new LeaseTable({
    now: () => GRANTED_AT,
    persist: (records) => saved.push(records),
  });
  const leaseId = leases.grantMachine(BINDING, "client-1");
  const restored = new LeaseTable({ now: () => GRANTED_AT });
  restored.restore(saved.at(-1)!);
  assert.equal(
    restored.liveMachineLease("client-1", BINDING.profileId),
    leaseId,
  );
  assert.deepEqual(restored.records(), leases.records());
});
