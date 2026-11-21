/**
 * The vetting shared by D4 and D-W2 (`upstreamText.ts`, Task-1463): auth
 * markers, every secret form, long fragments of a secret, control stripping
 * and a surrogate-safe cut. Every value is fake.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { FAKE_ACCESS } from "../test/atlassianFake.ts";
import type { AtlassianCredential } from "./descriptor.ts";
import {
  holdsSecret,
  secretForms,
  vettedText,
  withoutControls,
} from "./upstreamText.ts";

const TOKEN: AtlassianCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const OAUTH: AtlassianCredential = {
  site: "acme.atlassian.net",
  cloudId: "00000000-0000-4000-8000-00000000fa4e",
  accessToken: FAKE_ACCESS,
};
const BASIC = Buffer.from("me@x.test:FAKE-TOKEN-SENTINEL-0123456789").toString(
  "base64",
);
const options = { max: 40, fallback: "FALLBACK" };

test("the secret forms are the token and its padded and unpadded Basic value, or the access token", () => {
  assert.deepEqual(secretForms(TOKEN), [
    "FAKE-TOKEN-SENTINEL-0123456789",
    BASIC,
    BASIC.replace(/=+$/, ""),
  ]);
  assert.deepEqual(secretForms(OAUTH), [FAKE_ACCESS]);
});

test("holdsSecret: markers, whole forms and long fragments; short or unrelated text passes", () => {
  for (const value of [
    "Authorization: x",
    "bearer x",
    "Basic\tx",
    "BEARER\u0085x",
    "see FAKE-TOKEN-SENTINEL-0123456789 here",
    `x${BASIC}y`,
    `x${BASIC.replace(/=+$/, "")}`,
    // A 16-character slice of the token.
    "TOKEN-SENTINEL-0",
  ])
    assert.equal(holdsSecret(value, TOKEN), true, value);
  assert.equal(holdsSecret(FAKE_ACCESS.slice(3, 19), OAUTH), true);
  for (const value of ["STAR-135", "TOKEN-SENTINEL", "basically fine", ""])
    assert.equal(holdsSecret(value, TOKEN), false, value);
});

test("vettedText falls back on a secret, strips controls and cuts without splitting a pair", () => {
  assert.equal(vettedText("bearer abc", TOKEN, options), "FALLBACK");
  assert.equal(withoutControls("a\u0000b\u007fc\u0085d"), "a b c d");
  assert.equal(vettedText("a\nb", TOKEN, options), "a b");
  const long = "x".repeat(38) + "😀" + "y";
  const cut = vettedText(long, TOKEN, options);
  assert.ok(cut.length <= 40);
  assert.equal(cut, `${"x".repeat(38)}…`);
  assert.equal(vettedText("short", TOKEN, options), "short");
});
