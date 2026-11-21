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
  REDACTED,
  cappedText,
  hasAuthMarker,
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
  assert.equal(vettedText("bearer abc", TOKEN, options), "[redacted]abc");
  assert.equal(
    vettedText("x FAKE-TOKEN-SENTINEL-0123456789 y", TOKEN, {
      max: 100,
      fallback: "F",
    }),
    "x [redacted] y",
  );
  assert.equal(withoutControls("a\u0000b\u007fc\u0085d"), "a b c d");
  assert.equal(vettedText("a\nb", TOKEN, options), "a b");
  const long = "x".repeat(38) + "😀" + "y";
  const cut = vettedText(long, TOKEN, options);
  assert.ok(cut.length <= 40);
  assert.equal(cut, `${"x".repeat(38)}…`);
  assert.equal(vettedText("short", TOKEN, options), "short");
});

test("holdsSecret finds a 16-character piece of any form anywhere inside a text (Task-1463 fix-1 F001)", () => {
  const unpadded = BASIC.replace(/=+$/, "");
  for (const value of [
    "near TOKEN-SENTINEL-0 here",
    `created ${"FAKE-TOKEN-SENTINEL-0123456789".slice(10, 26)}!`,
    `x ${BASIC.slice(5, 21)} y`,
    `x ${unpadded.slice(-16)}`,
    "near TOKEN-SENTINEL\u0001-0 here".replace("\u0001", ""),
  ])
    assert.equal(holdsSecret(value, TOKEN), true, value);
  assert.equal(holdsSecret(`a ${FAKE_ACCESS.slice(2, 18)} b`, OAUTH), true);
  // 15 characters of a piece, or a piece broken by a control, pass.
  assert.equal(holdsSecret("near TOKEN-SENTINEL- here", TOKEN), false);
  assert.equal(holdsSecret("near TOKEN-SENT\u0001INEL-0 here", TOKEN), false);
});

test("D4's helpers: the auth marker alone, and the capped text without any secret check", () => {
  assert.equal(hasAuthMarker("Bearer\tx"), true);
  assert.equal(hasAuthMarker("TOKEN-SENTINEL-0123"), false);
  assert.equal(cappedText("TOKEN-SENTINEL-0\u0000", 40), "TOKEN-SENTINEL-0 ");
  assert.equal(cappedText("x".repeat(50), 10), `${"x".repeat(9)}…`);
});

// --- fix-2 F001: the cut text is what is vetted, and it never hides a redaction ---

const DIGITS: AtlassianCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "0123456789ABCDEFGHIJ",
};

test("F001-b: a cut that would split the placeholder keeps it whole and visible (the reviewer's [red… case)", () => {
  const out = vettedText("x".repeat(495) + DIGITS.token, DIGITS, {
    max: 500,
    fallback: "F",
  });
  assert.equal(out, `${"x".repeat(489)}${REDACTED}…`);
  assert.equal(out.length, 500);
});

test("F001-b: a cut that would drop the placeholder with the tail still ends [redacted]…", () => {
  const out = vettedText(`${"x".repeat(499)}${DIGITS.token} tail`, DIGITS, {
    max: 500,
    fallback: "F",
  });
  assert.equal(out, `${"x".repeat(489)}${REDACTED}…`);
  // A placeholder the shorter head would split is cut before, and shown once.
  const near = vettedText(
    `${"x".repeat(485)}${DIGITS.token}${"y".repeat(20)}${DIGITS.token}`,
    DIGITS,
    { max: 500, fallback: "F" },
  );
  assert.equal(near, `${"x".repeat(485)}${REDACTED}…`);
  // A tail without a placeholder is cut as before.
  assert.equal(
    vettedText("x".repeat(600), DIGITS, { max: 500, fallback: "F" }),
    `${"x".repeat(499)}…`,
  );
});

test("F001-a: an ellipsis or cut that completes a non-ASCII or non-BMP token gives the fallback", () => {
  const ellipsis = { ...DIGITS, token: "secret…" };
  const max = { max: 40, fallback: "FALLBACK" };
  // Cut after "secret": the ellipsis completes the token.
  assert.equal(
    vettedText(`${"x".repeat(33)}secret${"Z".repeat(10)}`, ellipsis, max),
    "FALLBACK",
  );
  // The cut drops half a pair, and the ellipsis follows "secret".
  assert.equal(
    vettedText(`${"x".repeat(32)}secret😀${"Z".repeat(10)}`, ellipsis, max),
    "FALLBACK",
  );
  // A non-BMP token the cut completes after a whole pair.
  const astral = { ...DIGITS, token: "secret😀…" };
  assert.equal(
    vettedText(`${"x".repeat(31)}secret😀${"Z".repeat(10)}`, astral, max),
    "FALLBACK",
  );
  // A fallback that holds the secret itself gives the placeholder alone.
  assert.equal(
    vettedText(`${"x".repeat(33)}secret${"Z".repeat(10)}`, ellipsis, {
      max: 40,
      fallback: "a secret… here",
    }),
    REDACTED,
  );
});

test("F001-a: a text whose JSON escaping spells the token gives the fallback", () => {
  // Shorter than a 16-character piece, so only the escaping spells it.
  const escaped = { ...DIGITS, token: 'q\\"FAKE-JSON' };
  assert.equal(vettedText('a q"FAKE-JSON b', escaped, options), "FALLBACK");
});

// --- Task-1463 fix-3: an accepted limit, pinned (ADR-0005 D-W2, docs/workers.md) ---

test("documented limit: a token that is the placeholder itself cannot be withheld, while a provider-shaped token is", () => {
  const placeholderToken: AtlassianCredential = {
    site: "acme.atlassian.net",
    email: "me@x.test",
    token: REDACTED,
  };
  // The fallback is shown only when it holds no secret, so "FALLBACK" stands in.
  assert.equal(
    vettedText(`x ${REDACTED} y`, placeholderToken, options),
    "FALLBACK",
  );
  // Only a fallback that also holds the placeholder gives the placeholder alone.
  assert.equal(
    vettedText(`x ${REDACTED} y`, placeholderToken, {
      max: 40,
      fallback: `fallback ${REDACTED}`,
    }),
    REDACTED,
  );
  // A provider-shaped token takes no scaffold shape: it is redacted and absent.
  const provider = `ATATT3xFfGF0${"Ab3_-".repeat(36)}`;
  const providerToken: AtlassianCredential = {
    site: "acme.atlassian.net",
    email: "me@x.test",
    token: provider,
  };
  const out = vettedText(`x ${REDACTED} ${provider} y`, providerToken, {
    max: 200,
    fallback: "FALLBACK",
  });
  assert.equal(out, `x ${REDACTED} ${REDACTED} y`);
  assert.equal(out.includes(provider), false);
});

test("F003: a text whose second JSON escaping (the /mcp body's) spells the token gives the fallback", () => {
  const twice = { ...DIGITS, token: 'Q\\\\\\"X123' };
  assert.ok(!JSON.stringify('a Q"X123 b').includes(twice.token));
  assert.equal(vettedText('a Q"X123 b', twice, options), "FALLBACK");
  // A third escaping is no transport's: left alone.
  const thrice = { ...DIGITS, token: 'Q\\\\\\\\\\\\\\"X123' };
  assert.equal(vettedText('a Q"X123 b', thrice, options), 'a Q"X123 b');
});
