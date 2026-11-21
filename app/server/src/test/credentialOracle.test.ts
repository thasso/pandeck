/**
 * The credential oracle itself (Task-1463 fix-2): it rejects each kind of
 * material on its own, wherever it sits, and passes clean answers. Every
 * value is fake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { FAKE_ACCESS, FAKE_STORED_REFRESH } from "./atlassianFake.ts";
import { assertNoCredential, carriesMaterial } from "./credentialOracle.ts";

/** The shared fake values, joined past 16 characters. */
const CREDENTIAL = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: `${FAKE_STORED_REFRESH}-${FAKE_STORED_REFRESH}`,
};

test("the oracle rejects an authorization marker alone, in a value, a key or a serialized answer", () => {
  assert.throws(() =>
    assertNoCredential({ warning: "Authorization: marker-only" }, CREDENTIAL),
  );
  assert.throws(() => assertNoCredential({ "x AUTHORIZATION": 1 }, CREDENTIAL));
  assert.throws(() =>
    assertNoCredential(JSON.stringify({ a: ["Bearer xyz"] }), CREDENTIAL),
  );
  for (const gap of [" ", "\t", "\n", "\u0085", " "])
    assert.ok(carriesMaterial(`basic${gap}x`, CREDENTIAL), JSON.stringify(gap));
});

test("the oracle rejects a whole form, a 16-character window of the token or of the Basic value, at any depth", () => {
  const basic = Buffer.from(
    `${CREDENTIAL.email}:${CREDENTIAL.token}`,
    "utf8",
  ).toString("base64");
  for (const leak of [
    CREDENTIAL.token,
    CREDENTIAL.token.slice(5, 21),
    basic,
    basic.slice(3, 19),
  ]) {
    assert.throws(() =>
      assertNoCredential({ items: [{ error: `x ${leak} y` }] }, CREDENTIAL),
    );
    assert.throws(() => assertNoCredential({ [leak]: true }, CREDENTIAL));
  }
  // A 15-character piece is not material.
  assertNoCredential({ text: CREDENTIAL.token.slice(5, 20) }, CREDENTIAL);
});

test("the oracle passes clean answers, scheme words without a gap included", () => {
  assertNoCredential(
    {
      summary: "Applied 1 change(s) (created [redacted])",
      warnings: ["basically fine", "Bearers of news", "basic"],
    },
    CREDENTIAL,
  );
  assertNoCredential({ accessToken: "x" }, { accessToken: FAKE_ACCESS });
});

test("the oracle rejects a string whose first or second JSON escaping spells the token (fix-4)", () => {
  const once = { ...CREDENTIAL, token: 'Q\\"X123' };
  const twice = { ...CREDENTIAL, token: 'Q\\\\\\"X123' };
  for (const credential of [once, twice]) {
    assert.ok(!'{ "summary": Q"X123 }'.includes(credential.token));
    assert.throws(() => assertNoCredential({ summary: 'Q"X123' }, credential));
  }
  // A backslash-free token is unaffected by escaping.
  assertNoCredential({ summary: 'Q"X123' }, CREDENTIAL);
});
