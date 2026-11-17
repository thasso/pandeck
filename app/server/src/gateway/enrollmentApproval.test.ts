/**
 * What the enrollment port's approval routes accept, and the per-request poll
 * limiter's interval, expiry and capacity (`enrollmentApproval.ts`).
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "vitest";
import { MAX_RETAINED_REQUESTS } from "./clientRegistry.ts";
import {
  POLL_INTERVAL_MS,
  PollLimiter,
  decodePoll,
  decodeStart,
  registryRefused,
} from "./enrollmentApproval.ts";

const p256 = () =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
const hash = createHash("sha256").update("synthetic").digest("hex");

test("a start needs a P-256 key, a lowercase hex token hash, a shown name and a known kind", () => {
  const publicKeyPem = p256();
  const valid = {
    publicKeyPem,
    mcpTokenHash: hash,
    name: " box ",
    kind: "laptop",
  };
  assert.deepEqual(decodeStart(valid), {
    publicKeyPem,
    mcpTokenHash: hash,
    name: "box",
    kind: "laptop",
  });
  // Kind defaults to other; extra fields are dropped.
  assert.deepEqual(
    decodeStart({ publicKeyPem, mcpTokenHash: hash, name: "n", extra: 1 }),
    { publicKeyPem, mcpTokenHash: hash, name: "n", kind: "other" },
  );
  // The stored key is the parsed key re-exported, not the text sent.
  const padded = decodeStart({
    ...valid,
    publicKeyPem: `\n${publicKeyPem}\n\n`,
  });
  assert.equal(padded?.publicKeyPem, publicKeyPem);
  // Up to 64 characters, counted as code points.
  assert.ok(decodeStart({ ...valid, name: "é".repeat(64) }));
  const rsa = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({
    type: "spki",
    format: "pem",
  }) as string;
  for (const bad of [
    undefined,
    null,
    "text",
    {},
    { ...valid, publicKeyPem: rsa },
    { ...valid, publicKeyPem: "not a key" },
    { ...valid, publicKeyPem: 1 },
    { ...valid, mcpTokenHash: hash.toUpperCase() },
    { ...valid, mcpTokenHash: hash.slice(1) },
    { ...valid, mcpTokenHash: undefined },
    { ...valid, name: "" },
    { ...valid, name: "   " },
    { ...valid, name: "x".repeat(65) },
    { ...valid, name: "evil‮txt.exe" },
    { ...valid, name: "two\nlines" },
    { ...valid, name: "zero​width" },
    { ...valid, name: 7 },
    { ...valid, kind: "server" },
    { ...valid, kind: null },
  ])
    assert.equal(decodeStart(bad), undefined, JSON.stringify(bad));
});

test("a start's devbox proof is optional: a Google access token of 1-2048 printable ASCII characters, else the start is malformed", () => {
  const publicKeyPem = p256();
  const valid = { publicKeyPem, mcpTokenHash: hash, name: "n", kind: "devbox" };
  const plain = { publicKeyPem, mcpTokenHash: hash, name: "n", kind: "devbox" };
  // Absent: the start as before, no token field at all.
  assert.deepEqual(decodeStart(valid), plain);
  assert.ok(!("devboxToken" in decodeStart(valid)!));
  const token = "FAKE_owner-google-access-token";
  assert.deepEqual(
    decodeStart({ ...valid, devbox: { googleAccessToken: token } }),
    { ...plain, devboxToken: token },
  );
  // The longest token, and every printable ASCII character.
  const longest = "x".repeat(2048);
  assert.equal(
    decodeStart({ ...valid, devbox: { googleAccessToken: longest } })
      ?.devboxToken,
    longest,
  );
  const printable = Array.from({ length: 94 }, (_, i) =>
    String.fromCharCode(0x21 + i),
  ).join("");
  assert.equal(
    decodeStart({ ...valid, devbox: { googleAccessToken: printable } })
      ?.devboxToken,
    printable,
  );
  for (const devbox of [
    { googleAccessToken: "" },
    { googleAccessToken: "x".repeat(2049) },
    { googleAccessToken: "FAKE token" },
    { googleAccessToken: "FAKE\ttoken" },
    { googleAccessToken: "FAKE\ntoken" },
    { googleAccessToken: "FAKE\u0000token" },
    { googleAccessToken: "FAKE\u007ftoken" },
    { googleAccessToken: "FAKE_tökén" },
    { googleAccessToken: 7 },
    {},
    null,
    "FAKE_owner-google-access-token",
    [token],
  ])
    assert.equal(
      decodeStart({ ...valid, devbox }),
      undefined,
      JSON.stringify(devbox),
    );
});

test("a refused automatic approval answers a fixed reason: an expired proof is a rejected token, a request gone meanwhile unavailable", () => {
  assert.equal(registryRefused("expired"), "token_rejected");
  assert.equal(registryRefused("unknown"), "unavailable");
  for (const status of [
    "claim_pending",
    "limit",
    "already_used",
    "unavailable",
  ] as const)
    assert.equal(registryRefused(status), status);
});

test("a poll needs a request id of 32 base64url bytes", () => {
  const requestId = randomBytes(32).toString("base64url");
  assert.equal(decodePoll({ requestId }), requestId);
  for (const bad of [
    undefined,
    {},
    { requestId: requestId.slice(1) },
    { requestId: `${requestId}A` },
    { requestId: requestId.replace(/^./, "+") },
    { requestId: 5 },
  ])
    assert.equal(decodePoll(bad), undefined);
});

test("the poll limiter admits one poll per request every interval, each request on its own", () => {
  const limiter = new PollLimiter();
  assert.equal(limiter.admit("a", 0), true);
  assert.equal(limiter.admit("a", POLL_INTERVAL_MS - 1), false);
  assert.equal(limiter.admit("b", POLL_INTERVAL_MS - 1), true);
  // A refused poll doesn't extend the wait.
  assert.equal(limiter.admit("a", POLL_INTERVAL_MS), true);
  assert.equal(limiter.admit("a", POLL_INTERVAL_MS + 1), false);
});

test("the poll limiter drops entries once their interval passes, also after a clock jump back", () => {
  const limiter = new PollLimiter();
  for (let i = 0; i < 10; i++) limiter.admit(`k${i}`, 1_000);
  assert.equal(limiter.size, 10);
  assert.equal(limiter.admit("late", 1_000 + POLL_INTERVAL_MS), true);
  assert.equal(limiter.size, 1);
  assert.equal(limiter.admit("back", 0), true);
  assert.equal(limiter.size, 1);
});

test("the poll limiter holds at most the retained-record bound and allocates nothing when full", () => {
  const limiter = new PollLimiter();
  for (let i = 0; i < MAX_RETAINED_REQUESTS; i++)
    assert.equal(limiter.admit(`k${i}`, 0), true);
  assert.equal(limiter.size, MAX_RETAINED_REQUESTS);
  assert.equal(limiter.admit("one more", 1), false);
  assert.equal(limiter.size, MAX_RETAINED_REQUESTS);
  assert.equal(limiter.admit("one more", POLL_INTERVAL_MS), true);
  assert.equal(limiter.size, 1);
});
