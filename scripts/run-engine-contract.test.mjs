import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("./run-engine-contract.mjs", import.meta.url),
);

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** An `unshare` stand-in that records its arguments and exits 1. */
function failingUnshare() {
  const dir = mkdtempSync(join(tmpdir(), "pa-engine-contract-"));
  tempDirs.push(dir);
  const calls = join(dir, "calls");
  const unshare = join(dir, "unshare");
  writeFileSync(unshare, `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`);
  chmodSync(unshare, 0o755);
  return {
    unshare,
    calls: () =>
      existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

/** At most the probe ran: no contract run was started. */
function assertNoRun(calls) {
  assert.ok(calls.length <= 1, calls.join("\n"));
  for (const args of calls) assert.ok(!args.includes("--reporter"), args);
}

function run(extraEnv) {
  const fake = failingUnshare();
  const env = { ...process.env, PANDECK_UNSHARE: fake.unshare, ...extraEnv };
  if (!("CI" in extraEnv)) delete env.CI;
  const result = spawnSync(process.execPath, [SCRIPT], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, calls: fake.calls() };
}

test("no namespace outside CI is a visible skip that exits 0", () => {
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^engine-contract: SKIP: no network namespace: /m,
  );
  assertNoRun(result.calls);
});

test("no namespace under CI=true fails", () => {
  const result = run({ CI: "true" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stdout,
    /^engine-contract: FAIL: no network namespace: /m,
  );
  assertNoRun(result.calls);
});
