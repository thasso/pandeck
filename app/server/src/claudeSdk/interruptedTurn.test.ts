import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { scanInterruptedTurn } from "../interruptedTurnEvidence.ts";
import { claudeTurnLine } from "./interruptedTurn.ts";

const RUN_STARTED = Date.parse("2026-10-15T07:39:38.000Z");

function transcript(lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "claude-turn-")), "t.jsonl");
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

test("one response written in parts is one step; tool results are not prompts", () => {
  const path = transcript([
    {
      type: "user",
      timestamp: "2026-10-15T07:39:38.290Z",
      message: { role: "user", content: "fix the crash" },
    },
    // The CLI writes each content block of one message as its own line.
    {
      type: "assistant",
      timestamp: "2026-10-15T07:39:40.200Z",
      message: { id: "msg_1", content: [{ type: "thinking" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-10-15T07:39:40.264Z",
      message: { id: "msg_1", content: [{ type: "tool_use" }] },
    },
    {
      type: "user",
      timestamp: "2026-10-15T07:39:40.297Z",
      message: { role: "user", content: [{ type: "tool_result" }] },
    },
    {
      type: "assistant",
      timestamp: "2026-10-15T07:39:41.940Z",
      message: { id: "msg_2", content: [{ type: "tool_use" }] },
    },
    // A subagent's lines are not the session's own steps.
    {
      type: "assistant",
      isSidechain: true,
      timestamp: "2026-10-15T07:39:42.000Z",
      message: { id: "msg_3", content: [] },
    },
  ]);
  assert.deepEqual(scanInterruptedTurn(path, RUN_STARTED, claudeTurnLine), {
    promptKept: true,
    modelSteps: 2,
  });
});

test("a meta line or a tool result alone is not the cut turn's prompt", () => {
  const path = transcript([
    {
      type: "user",
      isMeta: true,
      timestamp: "2026-10-15T07:39:38.100Z",
      message: { role: "user", content: "<local-command-caveat>" },
    },
    {
      type: "user",
      timestamp: "2026-10-15T07:39:38.200Z",
      message: { role: "user", content: [{ type: "tool_result" }] },
    },
  ]);
  assert.deepEqual(scanInterruptedTurn(path, RUN_STARTED, claudeTurnLine), {
    promptKept: false,
    modelSteps: 0,
  });
});
