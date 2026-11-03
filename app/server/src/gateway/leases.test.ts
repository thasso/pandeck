import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { LeaseTable } from "./leases.ts";

const BINDING = {
  profileId: "claude-work",
  provider: "claude",
  tokenFile: "/tmp/fixture/.credentials.json",
} as const;

function decode(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

test("a lease token is JWT-shaped and its secret is stored only as a hash", () => {
  const leases = new LeaseTable();
  const first = leases.grant(BINDING);
  const second = leases.grant(BINDING);
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
  });
});

test("verify answers with the lease's own binding, and a revoked lease names its reason", () => {
  const leases = new LeaseTable();
  const { leaseId, token } = leases.grant(BINDING);
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
  const { leaseId, token } = leases.grant(BINDING);
  leases.revoke(leaseId, "session-ended");
  const [header, payload, secret] = token.split(".") as [
    string,
    string,
    string,
  ];
  const forged = `${header}.${payload}.${secret[0] === "A" ? "B" : "A"}${secret.slice(1)}`;
  assert.deepEqual(leases.verify(forged), { ok: false, refusal: "unknown" });
});
