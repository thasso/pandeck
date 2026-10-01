import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { sweepChildOomScores } from "./childOomScore.ts";

let root: string;
let procsPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "child-oom-score-"));
  procsPath = join(root, "cgroup.procs");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setScore(pid: number, score: number): void {
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), "oom_score_adj"), `${score}\n`);
}

function processes(scores: Record<number, number>): void {
  for (const [pid, score] of Object.entries(scores))
    setScore(Number(pid), score);
  writeFileSync(procsPath, `${Object.keys(scores).join("\n")}\n`);
}

function scoreOf(pid: number): number {
  return Number(readFileSync(join(root, String(pid), "oom_score_adj"), "utf8"));
}

test("raises inherited protection on every process except the kept ones", () => {
  processes({ 10: -900, 11: -900, 20: -900, 21: -900, 22: 300 });

  assert.deepEqual(
    sweepChildOomScores({ procRoot: root, procsPath, keep: new Set([10, 11]) }),
    [20, 21],
  );
  assert.equal(scoreOf(10), -900);
  assert.equal(scoreOf(11), -900);
  assert.equal(scoreOf(20), 0);
  assert.equal(scoreOf(21), 0);
  // A child that chose a higher score keeps it: the sweep never lowers.
  assert.equal(scoreOf(22), 300);
});

test("a pid reused between two passes is raised again", () => {
  processes({ 10: -900, 20: -900 });
  const options = { procRoot: root, procsPath, keep: new Set([10]) };
  assert.deepEqual(sweepChildOomScores(options), [20]);
  assert.deepEqual(sweepChildOomScores(options), []);

  // Pid 20 exited and a new process inheriting -900 took the number before
  // the next listing: it was never absent from one.
  setScore(20, -900);
  assert.deepEqual(sweepChildOomScores(options), [20]);
  assert.equal(scoreOf(20), 0);
});

test("a process that failed once is retried on the next pass", () => {
  processes({ 20: -900 });
  const options = { procRoot: root, procsPath, keep: new Set<number>() };
  // Unreadable this pass (the path is a directory): no raise, no error.
  rmSync(join(root, "20"), { recursive: true });
  mkdirSync(join(root, "20", "oom_score_adj"), { recursive: true });
  assert.deepEqual(sweepChildOomScores(options), []);

  rmSync(join(root, "20"), { recursive: true });
  setScore(20, -900);
  assert.deepEqual(sweepChildOomScores(options), [20]);
});

test("a vanished process or an unreadable cgroup is not an error", () => {
  processes({ 10: -900 });
  writeFileSync(procsPath, "10\n30\n");
  const options = { procRoot: root, procsPath, keep: new Set<number>() };
  assert.deepEqual(sweepChildOomScores(options), [10]);

  rmSync(procsPath);
  assert.deepEqual(sweepChildOomScores(options), []);
});
