import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  brokerBoundedStdout,
  brokerExecFile,
  spawnBrokerPidForTests,
} from "./spawnBroker.ts";

const base = { cwd: process.cwd(), env: process.env, maxBuffer: 1024 * 1024 };

test("children start in the broker, not in this process", async () => {
  const pid = await spawnBrokerPidForTests();
  assert.ok(pid && pid !== process.pid);
  const parent = await brokerExecFile({
    ...base,
    file: "sh",
    args: ["-c", "echo $PPID"],
    encoding: "utf8",
  });
  assert.equal(Number(parent.stdout.trim()), pid);
});

test("execFile outcomes cross the broker unchanged", async () => {
  const ok = await brokerExecFile({
    ...base,
    file: "sh",
    args: ["-c", "printf 'grüße'; printf warn >&2"],
    encoding: "utf8",
  });
  assert.deepEqual(ok, { error: null, stdout: "grüße", stderr: "warn" });

  const failed = await brokerExecFile({
    ...base,
    file: "sh",
    args: ["-c", "echo out; exit 3"],
    encoding: "utf8",
  });
  assert.equal(failed.error?.code, 3);
  assert.equal(failed.stdout, "out\n");

  const missing = await brokerExecFile({
    ...base,
    file: "definitely-not-a-command-xyz",
    args: [],
    encoding: "utf8",
  });
  assert.equal(missing.error?.code, "ENOENT");

  const bytes = Buffer.from([0, 255, 10, 128]);
  const raw = await brokerExecFile({
    ...base,
    file: "cat",
    args: [],
    encoding: "buffer",
    input: bytes,
  });
  assert.deepEqual(raw.stdout, bytes);
});

test("cancelling a request kills its child", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = brokerExecFile({
    ...base,
    file: "sleep",
    args: ["30"],
    encoding: "utf8",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const outcome = await pending;
  assert.equal(outcome.error?.code, "ABORT_ERR");
  assert.ok(Date.now() - started < 10_000);
});

test("bounded stdout keeps a prefix and counts the whole stream", async () => {
  const outcome = await brokerBoundedStdout({
    ...base,
    file: "sh",
    args: ["-c", "printf 'abcdefghij'"],
    maxChars: 4,
    maxStderr: 100,
  });
  assert.deepEqual(outcome, {
    code: 0,
    aborted: false,
    patch: "abcd",
    totalChars: 10,
    stderr: "",
  });
});

test("with the broker disabled, the same handler runs in-process", async () => {
  process.env.ASSISTANT_SPAWN_BROKER = "0";
  try {
    const parent = await brokerExecFile({
      ...base,
      file: "sh",
      args: ["-c", "echo $PPID"],
      encoding: "utf8",
    });
    assert.equal(Number(parent.stdout.trim()), process.pid);
  } finally {
    delete process.env.ASSISTANT_SPAWN_BROKER;
  }
});

test("output past maxBuffer fails like execFile, and large output crosses intact", async () => {
  const overflow = await brokerExecFile({
    ...base,
    maxBuffer: 1024,
    file: "sh",
    args: ["-c", "head -c 5000 /dev/zero | tr '\\0' x"],
    encoding: "utf8",
  });
  assert.equal(overflow.error?.code, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");

  const large = await brokerExecFile({
    ...base,
    maxBuffer: 16 * 1024 * 1024,
    file: "sh",
    args: ["-c", "head -c 8000000 /dev/zero | tr '\\0' 'y'; printf '\\nend'"],
    encoding: "utf8",
  });
  assert.equal(large.error, null);
  assert.equal(large.stdout.length, 8_000_004);
  assert.ok(large.stdout.endsWith("\nend"));
});

test("a broker that dies mid-request fails it only once its children are gone", async () => {
  const pid = await spawnBrokerPidForTests();
  assert.ok(pid);
  const dir = mkdtempSync(join(tmpdir(), "broker-orphan-"));
  const log = join(dir, "log");
  try {
    // A stand-in for a git mutation still writing when its broker dies.
    const pending = brokerExecFile({
      ...base,
      cwd: dir,
      file: "sh",
      args: ["-c", "while true; do echo x >> log; sleep 0.02; done"],
      encoding: "utf8",
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    process.kill(pid, "SIGKILL");
    await assert.rejects(pending, /exited before answering/);
    const size = statSync(log).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      statSync(log).size,
      size,
      "nothing writes after the rejection",
    );
  } finally {
    // Should the group kill ever regress, the writer must not outlive the test.
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone — the expected case.
    }
    rmSync(dir, { recursive: true, force: true });
  }

  const again = await spawnBrokerPidForTests();
  assert.ok(again && again !== pid);
  const ok = await brokerExecFile({
    ...base,
    file: "sh",
    args: ["-c", "echo alive"],
    encoding: "utf8",
  });
  assert.equal(ok.stdout, "alive\n");
});
