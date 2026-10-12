import assert from "node:assert/strict";
import { test } from "vitest";
import { MAX_INBOX_POSITIONS } from "@assistant/shared";
import { validateClientMessage } from "./validateClientMessage.ts";

/**
 * `setInboxPositions` is checked whole at the wire: the server writes a
 * placement all-or-nothing, so one malformed entry must refuse the command
 * rather than reach the store.
 *   pnpm --filter @assistant/server test src/inboxPositionsMessage.test.ts
 */
test("setInboxPositions accepts sessions and runs at finite positions", () => {
  assert.equal(
    validateClientMessage({
      type: "setInboxPositions",
      positions: [
        { kind: "session", id: "s-1", position: 1_800_000_000_000.5 },
        { kind: "run", runId: "12", position: -3 },
      ],
      requestId: "r-1",
    }).ok,
    true,
  );
});

test("setInboxPositions refuses a malformed entry or list", () => {
  const refused = [
    [],
    undefined,
    [{ kind: "session", id: "s-1" }],
    [{ kind: "session", id: "s-1", position: Number.NaN }],
    [{ kind: "session", id: "s-1", position: Infinity }],
    [{ kind: "session", id: "s-1", position: "3" }],
    [{ kind: "session", position: 3 }],
    [{ kind: "run", id: "12", position: 3 }],
    [{ kind: "task", id: "1", position: 3 }],
    ["s-1"],
    Array.from({ length: MAX_INBOX_POSITIONS + 1 }, (_, index) => ({
      kind: "session",
      id: `s-${index}`,
      position: index,
    })),
  ];
  for (const positions of refused)
    assert.equal(
      validateClientMessage({ type: "setInboxPositions", positions }).ok,
      false,
      JSON.stringify(positions)?.slice(0, 80),
    );
});
