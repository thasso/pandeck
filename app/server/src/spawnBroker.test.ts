import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import {
  awaitGroupExit,
  brokerBoundedStdout,
  brokerExecFile,
  setGroupIoForTests,
  spawnBrokerPidForTests,
  type GroupIo,
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

/** A process's `/proc` state letter; `gone` once reaped. */
function procState(pid: number): string {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "latin1");
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] ?? "?";
  } catch {
    return "gone";
  }
}

test.skipIf(process.platform !== "linux")(
  "on broker death, a request without an exit receipt fails at once, before one with it",
  async () => {
    const pid = await spawnBrokerPidForTests();
    assert.ok(pid);
    const dir = mkdtempSync(join(tmpdir(), "broker-receipt-"));
    const pidFile = join(dir, "pid");
    const order: string[] = [];
    let stateAtRejection: string | undefined;
    try {
      // Submitted first, so only the exit receipt can make it answer last.
      const receipt = brokerExecFile({
        ...base,
        cwd: dir,
        file: "sh",
        args: ["-c", "echo $$ > pid; exec sleep 30"],
        encoding: "utf8",
        awaitExit: true,
      }).then(
        () => assert.fail("must not answer"),
        () => {
          stateAtRejection = procState(Number(readFileSync(pidFile, "utf8")));
          order.push("awaitExit");
        },
      );
      const plain = brokerExecFile({
        ...base,
        cwd: dir,
        file: "sleep",
        args: ["30"],
        encoding: "utf8",
      }).then(
        () => assert.fail("must not answer"),
        () => order.push("plain"),
      );
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
        assert.ok(Date.now() < deadline, "the child started");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      process.kill(pid, "SIGKILL");
      await Promise.all([receipt, plain]);
      assert.deepEqual(order, ["plain", "awaitExit"]);
      assert.ok(
        ["gone", "Z", "X"].includes(stateAtRejection ?? ""),
        `the child was ${stateAtRejection} at rejection`,
      );
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone — the expected case.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const errno = (code: string) => Object.assign(new Error(code), { code });
const statLine = (pid: number, state: string, pgrp: number) =>
  `${pid} (git (x) y) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194304`;
const settles = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

/** A group observer over a fixed `/proc`; `probe` by default finds members. */
function fakeGroupIo(
  over: Partial<GroupIo> & { procs?: Record<string, string> },
) {
  const warnings: string[] = [];
  const procs = over.procs ?? {};
  const io: GroupIo = {
    probe: () => undefined,
    scannable: true,
    list: () => ["self", ...Object.keys(procs)],
    stat: (pid) => {
      const line = procs[pid];
      if (line === undefined) throw errno("ENOENT");
      return line;
    },
    warn: (message) => warnings.push(message),
    ...over,
  };
  return { io, warnings };
}

test("a group counts as exited only on ESRCH or a scan that finds just zombies", async () => {
  const empty = fakeGroupIo({
    probe: () => {
      throw errno("ESRCH");
    },
  });
  assert.ok(await settles(awaitGroupExit(7, empty.io), 200));

  const zombies = fakeGroupIo({
    procs: {
      8: statLine(8, "Z", 7),
      9: statLine(9, "X", 7),
      10: statLine(10, "R", 3),
    },
  });
  assert.ok(await settles(awaitGroupExit(7, zombies.io), 500));

  const vanished = fakeGroupIo({
    procs: { 8: statLine(8, "Z", 7) },
    list: () => ["8", "11"],
  });
  assert.ok(
    await settles(awaitGroupExit(7, vanished.io), 500),
    "ENOENT is no member",
  );
});

test("any uncertainty about a dead broker's group keeps waiting", async () => {
  const cases: Record<
    string,
    Partial<GroupIo> & { procs?: Record<string, string> }
  > = {
    "a running member": { procs: { 8: statLine(8, "R", 7) } },
    "a member in uninterruptible sleep": { procs: { 8: statLine(8, "D", 7) } },
    "EPERM without /proc": {
      scannable: false,
      probe: () => {
        throw errno("EPERM");
      },
    },
    "an unexpected probe errno": {
      scannable: false,
      probe: () => {
        throw errno("EINVAL");
      },
    },
    "an unreadable /proc": {
      list: () => {
        throw errno("EACCES");
      },
    },
    "an unreadable stat": {
      procs: { 8: statLine(8, "Z", 7) },
      stat: () => {
        throw errno("EACCES");
      },
    },
    "an unparsable stat": { procs: { 8: "8 (git) ?" } },
    "a scan that sees no member the probe found": {
      procs: { 10: statLine(10, "R", 3) },
    },
  };
  for (const [name, over] of Object.entries(cases)) {
    const { io } = fakeGroupIo(over);
    // Past the grace and a second scan.
    assert.equal(await settles(awaitGroupExit(7, io), 1_200), false, name);
  }
});

test("a group that has not exited is reported once, at ten seconds", async () => {
  vi.useFakeTimers();
  try {
    const { io, warnings } = fakeGroupIo({
      procs: { 8: statLine(8, "D", 7), 9: statLine(9, "Z", 7) },
    });
    let done = false;
    void awaitGroupExit(7, io).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(9_999);
    assert.deepEqual(warnings, []);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /process group 7 .*still running: 8:D$/);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(warnings.length, 1);
    assert.equal(done, false, "no release deadline");
  } finally {
    vi.useRealTimers();
  }
});

test.skipIf(process.platform !== "linux")(
  "a receipt lost with its broker stays pending while the group cannot be proven gone",
  async () => {
    let uncertain = true;
    setGroupIoForTests({
      probe: (pgid) => {
        if (uncertain) throw errno("EPERM");
        process.kill(-pgid, 0);
      },
      list: () => {
        if (uncertain) throw errno("EIO");
        return readdirSync("/proc");
      },
    });
    try {
      const pid = await spawnBrokerPidForTests();
      assert.ok(pid);
      let rejected = false;
      const pending = brokerExecFile({
        ...base,
        file: "sleep",
        args: ["30"],
        encoding: "utf8",
        awaitExit: true,
      }).catch((error: unknown) => {
        rejected = true;
        return error;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.equal(rejected, false, "still pending after two failed scans");
      uncertain = false;
      assert.match(String(await pending), /exited before answering/);
    } finally {
      setGroupIoForTests();
    }
  },
);
