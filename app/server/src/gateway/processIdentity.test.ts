import assert from "node:assert/strict";
import { test } from "vitest";
import { endChild, spawnIdleChild } from "../test/gatewayFixtures.ts";
import {
  parseStartTime,
  processStartTime,
  processState,
  type ProcessProbe,
} from "./processIdentity.ts";

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

test("processState: a live child is running, and exited once its start time differs or it is gone", async () => {
  // Real process: an idle child of this test, ended through its own handle.
  const child = spawnIdleChild();
  try {
    const startTime = processStartTime(child.pid);
    if (process.platform === "linux") assert.match(startTime ?? "", /^\d+$/);
    assert.equal(processState(child.pid, startTime), "running");
    if (process.platform === "linux")
      assert.equal(processState(child.pid, "1"), "exited");
    await endChild(child);
    assert.equal(processState(child.pid, startTime), "exited");
  } finally {
    await endChild(child);
  }
});

test("processState: only ESRCH or a different readable start time is an exit; anything uncertain is running", () => {
  const thrown = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };
  const probe = (
    kill: ProcessProbe["kill"],
    startTime: string | null = "100",
  ): ProcessProbe => ({ kill, startTime: () => startTime });
  const alive = () => {};
  // No real process is observed: pid 9 only names the fake.
  assert.equal(processState(9, "100", probe(thrown("EPERM"))), "running");
  assert.equal(processState(9, "100", probe(thrown("EINVAL"))), "running");
  assert.equal(processState(9, "100", probe(thrown("ESRCH"))), "exited");
  assert.equal(processState(9, null, probe(alive, "200")), "running");
  assert.equal(processState(9, "100", probe(alive, null)), "running");
  assert.equal(processState(9, "100", probe(alive, "100")), "running");
  assert.equal(processState(9, "100", probe(alive, "200")), "exited");
});
