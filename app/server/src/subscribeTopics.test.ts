import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

test("topic subscriptions are validated against the known topic set", () => {
  assert.equal(
    validateClientMessage({ type: "subscribe", topics: ["tasks", "projects"] })
      .ok,
    true,
  );
  assert.equal(
    validateClientMessage({ type: "unsubscribe", topics: [] }).ok,
    true,
  );

  // An unknown topic must be rejected rather than normalized away: a silently
  // dropped topic subscribes a surface to nothing and it renders stale forever.
  const unknown = validateClientMessage({
    type: "subscribe",
    topics: ["everything"],
  });
  assert.equal(unknown.ok, false);
  assert.equal(
    validateClientMessage({ type: "subscribe", topics: "tasks" }).ok,
    false,
  );
  assert.equal(validateClientMessage({ type: "subscribe" }).ok, false);
});
