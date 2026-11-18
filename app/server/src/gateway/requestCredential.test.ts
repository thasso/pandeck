/**
 * The credential classifier on its own fixtures (Task-1430 C3, rv-1430-02
 * F04): never through a record, so the class rules are pinned apart from
 * what a record keeps. The cases are data in `test/requestCredentialCases.ts`
 * so the relay's copy (PR2a) runs the same ones.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  COOKIE_CASES,
  CREDENTIAL_CASES,
  LEASE_FIXTURE,
  PLACEHOLDER_FIXTURE,
} from "../test/requestCredentialCases.ts";
import { isLeaseShaped, LeaseTable } from "./leases.ts";
import {
  classifyClientCredential,
  hasClientCookie,
  MACHINE_PLACEHOLDER,
} from "./requestCredential.ts";

test("the shared fixtures are the real placeholder and a lease-shaped token", () => {
  assert.equal(PLACEHOLDER_FIXTURE, MACHINE_PLACEHOLDER);
  assert.ok(isLeaseShaped(LEASE_FIXTURE));
  assert.ok(!isLeaseShaped(PLACEHOLDER_FIXTURE));
});

test("every shared case classifies as expected", () => {
  for (const { name, rawHeaders, expected } of CREDENTIAL_CASES)
    assert.equal(classifyClientCredential(rawHeaders), expected, name);
});

test("a token the lease table grants is a lease", () => {
  const { token } = new LeaseTable().grant(
    { profileId: "p1", provider: "claude", tokenFile: "/tmp/none" },
    { kind: "engine", owner: { workerId: "w1" } },
  );
  assert.equal(
    classifyClientCredential(["authorization", `Bearer ${token}`]),
    "lease",
  );
  assert.equal(classifyClientCredential(["x-api-key", token]), "lease");
});

test("a cookie is any cookie field, whatever its value", () => {
  for (const { rawHeaders, expected } of COOKIE_CASES)
    assert.equal(hasClientCookie(rawHeaders), expected, rawHeaders.join(": "));
});
