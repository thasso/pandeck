import assert from "node:assert/strict";
import { test } from "vitest";
import { parseStartTime, processStartTime } from "./processIdentity.ts";

/** A `/proc/<pid>/stat` line: `comm` holds spaces and parentheses. */
function statLine(comm: string, startTime: string): string {
  const after = Array.from({ length: 50 }, (_, i) => String(i + 3));
  after[22 - 3] = startTime;
  return `4242 (${comm}) ${after.join(" ")}\n`;
}

test("the start time is field 22, counted from the last parenthesis", () => {
  assert.equal(parseStartTime(statLine("node", "987654")), "987654");
  assert.equal(parseStartTime(statLine("a) (b c) ) x", "12")), "12");
  assert.equal(parseStartTime("garbage"), null);
  assert.equal(parseStartTime("1 (x) R 1 2"), null);
});

test("this process has a start time where /proc exists, and a missing pid has none", () => {
  const own = processStartTime(process.pid);
  if (process.platform === "linux") assert.match(own ?? "", /^\d+$/);
  // Above the kernel's largest pid_max, so never a live process.
  assert.equal(processStartTime(4_194_305), null);
});
