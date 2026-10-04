/**
 * The web renders Claude models from the optimistic copy in `@assistant/shared`
 * before the server's list arrives, and the server validates against its own
 * curated list. The two drifted once (thinking "off"); this keeps them equal.
 */
import assert from "node:assert/strict";
import { CLAUDE_SDK_MODELS as SHARED_CLAUDE_MODELS } from "@assistant/shared";
import { test } from "vitest";
import { CLAUDE_SDK_MODELS } from "./modelSettings.ts";

test("the shared optimistic Claude list mirrors the server's curated list", () => {
  assert.deepEqual(
    SHARED_CLAUDE_MODELS,
    CLAUDE_SDK_MODELS.map(({ sdkModelId: _sdkModelId, ...model }) => model),
  );
});
