/**
 * What the enrollment port's approval routes accept, and the per-request poll
 * limiter's interval, expiry and capacity (`enrollmentApproval.ts`).
 */
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { test } from "vitest";
import { MAX_LIVE_REQUESTS } from "./clientRegistry.ts";
import {
  POLL_INTERVAL_MS,
  PollLimiter,
  decodePoll,
  decodeStart,
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

test("the poll limiter holds at most its capacity, the live-request bound, and allocates nothing when full", () => {
  const limiter = new PollLimiter();
  for (let i = 0; i < MAX_LIVE_REQUESTS; i++)
    assert.equal(limiter.admit(`k${i}`, 0), true);
  assert.equal(limiter.size, MAX_LIVE_REQUESTS);
  assert.equal(limiter.admit("one more", 1), false);
  assert.equal(limiter.size, MAX_LIVE_REQUESTS);
  assert.equal(limiter.admit("one more", POLL_INTERVAL_MS), true);
  assert.equal(limiter.size, 1);
});
