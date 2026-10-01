import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import {
  checkoutProcesses,
  stopCheckoutProcesses,
} from "./checkoutProcesses.ts";

const root = mkdtempSync(join(tmpdir(), "checkout-procs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function exited(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
}

/** A `/proc/<pid>/stat` line: comm with spaces and `)`, starttime field 22. */
function fakeStat(pid: number, ppid: number, start: number): string {
  return `${pid} (name with) spaces) S ${ppid} ${"0 ".repeat(17)}${start} 0\n`;
}

/** Like an agent's shell starting a dev server: the server is a grandchild. */
function startBelowShell(cwd: string, script: string) {
  const shell = spawn("sh", ["-c", `${script} & echo $!; wait`], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = new Promise<number>((resolve) =>
    shell.stdout.once("data", (data: Buffer) =>
      resolve(Number(String(data).trim())),
    ),
  );
  const shellExited = new Promise<void>((resolve) =>
    shell.once("exit", () => resolve()),
  );
  return { shell, pid, shellExited };
}

test("a process left running in the checkout is found and terminated", async () => {
  const checkout = join(root, "wt");
  mkdirSync(join(checkout, "app", "web"), { recursive: true });
  const started = startBelowShell(join(checkout, "app", "web"), "sleep 30");
  const pid = await started.pid;
  // The shell is our direct child — a harness stand-in — and is left alone.
  assert.deepEqual(await checkoutProcesses(checkout), [pid]);
  assert.deepEqual(await checkoutProcesses(join(root, "wt-sibling")), []);

  const stop = await stopCheckoutProcesses(checkout);
  assert.deepEqual(stop, { terminated: [pid], killed: [] });
  await started.shellExited;
});

test("a process that ignores SIGTERM is killed after the grace", async () => {
  const checkout = join(root, "stubborn");
  mkdirSync(checkout, { recursive: true });
  // An ignored SIGTERM is inherited across exec, so the sleep ignores it too.
  const started = startBelowShell(checkout, "trap '' TERM; sleep 30");
  const pid = await started.pid;
  const stop = await stopCheckoutProcesses(checkout, { graceMs: 300 });
  assert.deepEqual(stop, { terminated: [pid], killed: [pid] });
  await exited(pid);
  await started.shellExited;
});

test("only our processes are candidates, and never our own ancestry", async () => {
  // A fake /proc: 10 = us (in a terminal scope), 5 = our parent, 20 = our child
  // (a harness), 21 = its child, 30 = an unrelated process of the user. All of
  // them sit in the checkout.
  const proc = join(root, "proc");
  const checkout = join(root, "fake-checkout");
  mkdirSync(checkout, { recursive: true });
  const entries: Array<[number, number, string]> = [
    [5, 1, "0::/user.slice/session-1.scope"],
    [10, 5, "0::/user.slice/session-1.scope"],
    [20, 10, "0::/user.slice/session-1.scope"],
    [21, 20, "0::/user.slice/session-1.scope"],
    [30, 1, "0::/user.slice/session-1.scope"],
  ];
  for (const [pid, ppid, cgroup] of entries) {
    const dir = join(proc, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), fakeStat(pid, ppid, 1000 + pid));
    writeFileSync(join(dir, "cgroup"), `${cgroup}\n`);
    symlinkSync(checkout, join(dir, "cwd"));
  }
  const found = await checkoutProcesses(checkout, {
    procRoot: proc,
    selfPid: 10,
  });
  assert.deepEqual(found, [21]);

  // Sharing the server's service cgroup proves nothing: a process re-parented
  // out of our tree is left alone, whatever unit it runs in.
  for (const pid of [5, 10, 20, 21, 30])
    writeFileSync(
      join(proc, String(pid), "cgroup"),
      "0::/system.slice/personal-assistant.service\n",
    );
  const asService = await checkoutProcesses(checkout, {
    procRoot: proc,
    selfPid: 10,
  });
  assert.deepEqual(asService, [21]);
});

test("a pid reused during the grace is never signalled again", async () => {
  const proc = join(root, "proc-reuse");
  const checkout = join(root, "reuse-checkout");
  mkdirSync(checkout, { recursive: true });
  for (const [pid, ppid] of [
    [10, 1],
    [20, 10],
    [21, 20],
  ] as const) {
    const dir = join(proc, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stat"), fakeStat(pid, ppid, 1000 + pid));
    writeFileSync(join(dir, "cgroup"), "0::/user.slice/session-1.scope\n");
    symlinkSync(checkout, join(dir, "cwd"));
  }
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    procRoot: proc,
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      // It ignores SIGTERM, exits later, and a NEW process takes its pid.
      if (sig === "SIGTERM")
        setTimeout(
          () =>
            writeFileSync(join(proc, "21", "stat"), fakeStat(21, 1, 99_999)),
          50,
        );
    },
  });
  assert.deepEqual(sent, [[21, "SIGTERM"]]);
  assert.deepEqual(stop, { terminated: [21], killed: [] });
});
