import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CLAUDE_REFUSAL_RESULT,
  CLAUDE_REFUSAL_TEXTS,
  CLAUDE_REFUSAL_THROWN,
  CLAUDE_REFUSED_MODELS,
  CODEX_REFUSAL_MESSAGES,
  CODEX_REFUSED_MODELS,
  claudeRefusalText,
  claudeRefusalThrown,
  codexRefusalText,
} from "./modelRefusalCaptures.ts";

test("the id-replacing builders reproduce every capture exactly", () => {
  CLAUDE_REFUSED_MODELS.forEach((model, index) => {
    assert.equal(claudeRefusalText(model), CLAUDE_REFUSAL_TEXTS[index]);
    assert.equal(claudeRefusalThrown(model), CLAUDE_REFUSAL_THROWN[index]);
  });
  CODEX_REFUSED_MODELS.forEach((model, index) =>
    assert.equal(codexRefusalText(model), CODEX_REFUSAL_MESSAGES[index]),
  );
  assert.equal(CLAUDE_REFUSAL_RESULT.result, CLAUDE_REFUSAL_TEXTS[0]);
});
