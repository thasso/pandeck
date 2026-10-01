import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

const runtime = {
  provider: "claude-sdk",
  modelId: "sonnet",
  thinkingLevel: "medium",
};
const candidate = { ...runtime, family: "claude" };

function message(baseBranch?: unknown): Record<string, unknown> {
  return {
    type: "startWorkflowRun",
    taskId: "42",
    requestId: "request-1",
    config: {
      coordinator: runtime,
      roles: {
        implementer: [candidate],
        reviewer: [candidate],
        fixer: [],
        verdict: [],
      },
    },
    ...(baseBranch !== undefined ? { baseBranch } : {}),
  };
}

test("startWorkflowRun accepts an omitted or string base branch", () => {
  assert.equal(validateClientMessage(message()).ok, true);
  assert.equal(validateClientMessage(message("epic")).ok, true);
  assert.equal(validateClientMessage(message(7)).ok, false);
});
