import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isGatewayRefusal,
  isNeedsLoginRefusal,
  refusalResponse,
  refusalText,
  type Refusal,
} from "./refusals.ts";

const OTHERS: Refusal[] = [
  { case: "unknown-lease" },
  { case: "revoked-lease", reason: "profile-removed" },
  { case: "forbidden" },
  { case: "unknown-prefix" },
  { case: "websocket" },
  { case: "credential", problem: "missing" },
  { case: "compat-unset" },
  { case: "unreachable", upstream: "Anthropic", reason: "ECONNREFUSED" },
];

test.each(["Work Claude", "a (b) [c] ", "Ünïcødé → name", ""])(
  "1368 AC9: the needs-login refusal is recognised for the name %j, bare and in either body",
  (name) => {
    const refusal: Refusal = { case: "needs-login", name };
    const text = refusalText(refusal);
    assert.equal(isNeedsLoginRefusal(text), true);
    assert.equal(isNeedsLoginRefusal(`API Error: 401 ${text}`), true);
    for (const shape of ["claude", "codex"] as const)
      assert.equal(
        isNeedsLoginRefusal(refusalResponse(refusal, shape).body),
        true,
      );
  },
);

test.each(OTHERS.map((refusal) => [refusalText(refusal)]))(
  "1368 AC9: no other refusal is the needs-login one: %s",
  (text) => {
    assert.equal(isNeedsLoginRefusal(text), false);
  },
);

test("1368 AC9: the wording without the marker is not the gateway's", () => {
  assert.equal(
    isNeedsLoginRefusal(
      "the account Work needs a new login (Settings → Accounts).",
    ),
    false,
  );
  assert.equal(
    isNeedsLoginRefusal("API Error: 401 authentication_error"),
    false,
  );
});

test.each([
  [
    { case: "machine-pool-empty", provider: "OpenAI" },
    403,
    "no OpenAI account is available to this machine's user. Add or log in to one on the gateway's page.",
  ],
  [
    {
      case: "machine-session-limited",
      provider: "Claude",
      retryAfterSeconds: 70,
    },
    429,
    "every Claude account this session can use is rate-limited; retry later.",
  ],
  [
    { case: "machine-origin" },
    403,
    "model access from this machine is for local tools only.",
  ],
  [
    { case: "machine-retry" },
    503,
    "this machine's account changed while the request waited; retry.",
  ],
] as const)(
  "1424: the machine refusal %j is marked, fixed and in both shapes",
  (refusal, status, text) => {
    assert.equal(refusalText(refusal), `Pandeck gateway: ${text}`);
    assert.equal(isNeedsLoginRefusal(refusalText(refusal)), false);
    for (const shape of ["claude", "codex"] as const) {
      const response = refusalResponse(refusal, shape);
      assert.equal(response.status, status);
      assert.ok(response.body.includes(`Pandeck gateway: ${text}`));
      assert.equal(
        response.retryAfter,
        refusal.case === "machine-session-limited" ? 70 : undefined,
      );
    }
  },
);

test("1424: machine-session-limited takes Anthropic's rate-limit type", () => {
  const { body } = refusalResponse(
    {
      case: "machine-session-limited",
      provider: "Claude",
      retryAfterSeconds: 1,
    },
    "claude",
  );
  assert.equal(
    (JSON.parse(body) as { error: { type: string } }).error.type,
    "rate_limit_error",
  );
});

test("1430 PR3: the floors' refusals are marked 403s in each shape and echo nothing", () => {
  for (const refusal of [
    { case: "denied", id: "method" },
    { case: "denied", id: "oauth-token" },
    { case: "non-canonical-path" },
  ] satisfies Refusal[]) {
    const text = refusalText(refusal);
    assert.ok(isGatewayRefusal(text));
    assert.equal(isNeedsLoginRefusal(text), false);
    // The id is the record's reason, never the refusal's text.
    if (refusal.case === "denied") assert.ok(!text.includes(refusal.id));
    for (const shape of ["claude", "codex"] as const) {
      const { status, body } = refusalResponse(refusal, shape);
      assert.equal(status, 403);
      assert.ok(body.includes("permission_error"));
      assert.ok(body.includes(text));
    }
  }
});
