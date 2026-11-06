import assert from "node:assert/strict";
import { test } from "vitest";
import {
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
