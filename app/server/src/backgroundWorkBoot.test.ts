import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { sweepBackgroundTaskOutputTemps } from "./backgroundWorkBoot.ts";

test("temp sweep keeps trees owned by a live pid", () => {
  const path = join(tmpdir(), `pa-claude-${process.pid}-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  try {
    sweepBackgroundTaskOutputTemps();
    assert.equal(
      existsSync(path),
      true,
      "a live PA process retains its temp tree",
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("temp sweep removes a dead pi output tree but keeps a live one", () => {
  const live = join(tmpdir(), `pa-pi-${process.pid}-${randomUUID()}`);
  const dead = join(tmpdir(), `pa-pi-999999999-${randomUUID()}`);
  mkdirSync(live, { mode: 0o700 });
  mkdirSync(dead, { mode: 0o700 });
  try {
    sweepBackgroundTaskOutputTemps();
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(dead), false);
  } finally {
    rmSync(live, { recursive: true, force: true });
    rmSync(dead, { recursive: true, force: true });
  }
});

test("temp sweep removes a tree whose pid is dead", () => {
  const path = join(tmpdir(), `pa-claude-999999999-${randomUUID()}`);
  mkdirSync(path, { mode: 0o700 });
  sweepBackgroundTaskOutputTemps();
  assert.equal(existsSync(path), false, "a dead owner can be reclaimed");
});

test("temp sweep reclaims a dead tree left read-only by an agent's tools", () => {
  const path = join(tmpdir(), `pa-claude-999999999-${randomUUID()}`);
  const artifacts = join(path, "pytest-0", "case", "artifacts");
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  writeFileSync(join(artifacts, "output.png"), "x");
  chmodSync(artifacts, 0o555);
  try {
    assert.equal(
      sweepBackgroundTaskOutputTemps() >= 1,
      true,
      "the tree is counted as removed, not silently skipped",
    );
    assert.equal(existsSync(path), false);
  } finally {
    try {
      chmodSync(artifacts, 0o700);
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Already reclaimed by the sweep, which is exactly what this asserts.
    }
  }
});
