import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { scanInterruptedTurn } from "../interruptedTurnEvidence.ts";
import { piTurnLine } from "./interruptedTurn.ts";

const RUN_STARTED = Date.parse("2026-10-15T07:36:10.988Z");

function transcript(lines: unknown[], tail = ""): string {
  const path = join(mkdtempSync(join(tmpdir(), "pi-turn-")), "native.jsonl");
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n${tail}`,
  );
  return path;
}

function message(timestamp: string, role: string): unknown {
  return { type: "message", timestamp, message: { role, content: [] } };
}

test("the cut turn's prompt and the steps after it are counted", () => {
  // The shape of the session that prompted this: earlier history, then the cut
  // turn's prompt, two responses, one tool result — and a torn last line.
  const path = transcript(
    [
      { type: "session", timestamp: "2026-10-15T07:30:00.000Z" },
      message("2026-10-15T07:30:01.000Z", "user"),
      message("2026-10-15T07:30:05.000Z", "assistant"),
      message("2026-10-15T07:36:11.037Z", "user"),
      message("2026-10-15T07:36:17.355Z", "assistant"),
      message("2026-10-15T07:36:17.358Z", "toolResult"),
      message("2026-10-15T07:36:24.281Z", "assistant"),
    ],
    '{"type":"message","timest',
  );
  assert.deepEqual(scanInterruptedTurn(path, RUN_STARTED, piTurnLine), {
    promptKept: true,
    modelSteps: 2,
  });
});

test("history from before the cut turn does not count as its prompt", () => {
  const path = transcript([
    message("2026-10-15T07:30:01.000Z", "user"),
    message("2026-10-15T07:30:05.000Z", "assistant"),
  ]);
  assert.deepEqual(scanInterruptedTurn(path, RUN_STARTED, piTurnLine), {
    promptKept: false,
    modelSteps: 0,
  });
});

test("an unreadable transcript is unknown, not lost", () => {
  assert.equal(
    scanInterruptedTurn("/nonexistent/native.jsonl", RUN_STARTED, piTurnLine),
    undefined,
  );
});
