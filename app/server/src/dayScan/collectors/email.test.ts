import assert from "node:assert/strict";
import { test } from "vitest";
import { emailFact } from "./email.ts";

const OBSERVED = "2026-07-23T10:00:00.000Z";

test("an email fact commits ONLY header metadata — never body text (Task 141 privacy gate)", () => {
  const fact = emailFact(
    "email-followup",
    {
      id: "m123",
      threadId: "t9",
      internalDate: "1753257600000",
      payload: {
        headers: [
          { name: "Subject", value: "Follow up: DRM token binding" },
          { name: "From", value: "Ana <ana@acme.test>" },
          { name: "To", value: "alice@example.com" },
        ],
      },
    },
    OBSERVED,
  )!;
  assert.equal(fact.id, "email-followup:m123");
  assert.equal(fact.title, "Follow-up: Follow up: DRM token binding");
  assert.equal(fact.actor, "Ana <ana@acme.test>");
  assert.match(fact.links![0]!, /^https:\/\/mail\.google\.com\//);
  assert.ok(fact.tags?.includes("attention"));
  // Committed data carries only threadId + subject — no body/snippet/payload.
  assert.deepEqual(Object.keys(fact.data ?? {}).sort(), [
    "subject",
    "threadId",
  ]);
  assert.ok(
    !/body|snippet|\bpayload\b|textHtml/i.test(JSON.stringify(fact)),
    "no body-like keys are committed",
  );
});

test("sent mail uses the recipient as the counterparty and the own tag", () => {
  const fact = emailFact(
    "email-sent",
    {
      id: "s1",
      payload: {
        headers: [
          { name: "Subject", value: "Notes" },
          { name: "To", value: "team@acme.test" },
          { name: "From", value: "alice@example.com" },
        ],
      },
    },
    OBSERVED,
  )!;
  assert.equal(fact.actor, "team@acme.test");
  assert.deepEqual(fact.tags, ["own"]);
});

test("a message without an id is dropped, and a missing subject falls back", () => {
  assert.equal(
    emailFact("email-starred", { payload: { headers: [] } }, OBSERVED),
    null,
  );
  const fact = emailFact(
    "email-starred",
    { id: "x", payload: { headers: [] } },
    OBSERVED,
  )!;
  assert.equal(fact.title, "Starred: (no subject)");
});
