import assert from "node:assert/strict";
import { test } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

function message(selectors: Record<string, unknown>) {
  return {
    type: "addComment",
    target: {
      kind: "worktree",
      worktreeId: "wt-1",
      path: "src/app.ts",
      side: "new",
      revision: "HEAD",
    },
    body: "review this",
    selectors,
  };
}

test("worktree selection anchors require a position at the protocol boundary", () => {
  const withoutPosition = validateClientMessage(
    message({ quote: { exact: "value", prefix: "", suffix: "" } }),
  );
  assert.equal(withoutPosition.ok, false);
  if (!withoutPosition.ok)
    assert.match(withoutPosition.reason, /position is required/i);

  assert.equal(
    validateClientMessage(
      message({
        quote: { exact: "value", prefix: "", suffix: "" },
        position: { start: 10, end: 15 },
        block: { id: "4", occurrence: 1 },
      }),
    ).ok,
    true,
  );
});
