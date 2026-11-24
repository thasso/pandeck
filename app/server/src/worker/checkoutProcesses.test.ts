import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
import {
  brokerToolRunner,
  darwinTable,
  type ToolRunner,
} from "./processTable.ts";

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

/**
 * A fake `/proc/<pid>/cwd` link. The kernel's is always resolved, and the temp
 * directory itself may sit behind a symlink (macOS's `/var`).
 */
function linkCwd(dir: string, checkout: string): void {
  symlinkSync(realpathSync(checkout), join(dir, "cwd"));
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
    linkCwd(dir, checkout);
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
    linkCwd(dir, checkout);
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

/**
 * A fake macOS: `ps` and `lsof` answer from `procs`, as the real tools print
 * under `LC_ALL=C TZ=UTC`; `calls` records every invocation.
 */
function fakeDarwin(
  procs: Map<number, { ppid: number; start: string; cwd: string }>,
) {
  const calls: Array<[string, readonly string[]]> = [];
  const run: ToolRunner = async (file, args) => {
    calls.push([file, args]);
    if (file === "/bin/ps" && args[0] === "-A")
      return [...procs]
        .map(
          ([pid, p]) =>
            `${String(pid).padStart(5)} ${String(p.ppid).padStart(5)} ${p.start}    `,
        )
        .join("\n");
    const list = (args[args.length - 1] ?? "").split(",").map(Number);
    if (file === "/bin/ps")
      return list
        .filter((pid) => procs.has(pid))
        .map(
          (pid) =>
            `${pid} ${procs.get(pid)!.ppid} ${procs.get(pid)!.start}    `,
        )
        .join("\n");
    if (file === "/usr/sbin/lsof")
      return list
        .filter((pid) => procs.has(pid))
        .map((pid) => `p${pid}\nfcwd\nn${procs.get(pid)!.cwd}`)
        .join("\n");
    return undefined;
  };
  return { run, calls };
}

test("on macOS, ps and lsof find only our grandchildren in the checkout", async () => {
  const checkout = realpathSync(mkdtempSync(join(root, "darwin-")));
  const at = (start: string, ppid: number, cwd = checkout) => ({
    ppid,
    start,
    cwd,
  });
  // 5 our parent, 10 us, 20 our child (a harness), 21 its child, 22 its child
  // beside the checkout, 23 in a sibling whose name extends the checkout's,
  // 30 a user's shell in the checkout. `ps` pads one-digit days with a space.
  const procs = new Map([
    [5, at("Mon Nov  2 09:00:00 2026", 1)],
    [10, at("Mon Nov  2 09:00:01 2026", 5)],
    [20, at("Mon Nov  2 09:00:02 2026", 10)],
    [21, at("Mon Nov 23 10:00:00 2026", 20, join(checkout, "app"))],
    [22, at("Mon Nov 23 10:00:00 2026", 20, "/tmp")],
    [23, at("Mon Nov 23 10:00:00 2026", 20, `${checkout}-x`)],
    [30, at("Mon Nov 23 10:00:00 2026", 1)],
  ]);
  const { run, calls } = fakeDarwin(procs);
  const table = darwinTable(run);
  assert.deepEqual(
    await checkoutProcesses(checkout, { table, selfPid: 10 }),
    [21],
  );
  // Only our descendants have their working directory read.
  const lsof = calls.find(([file]) => file === "/usr/sbin/lsof");
  assert.deepEqual(lsof?.[1].at(-1), "21,22,23");

  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    table,
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === "SIGTERM") procs.delete(pid);
    },
  });
  assert.deepEqual(sent, [[21, "SIGTERM"]]);
  assert.deepEqual(stop, { terminated: [21], killed: [] });
});

test("on macOS, a reused pid or an unreadable table is never signalled", async () => {
  const checkout = realpathSync(mkdtempSync(join(root, "darwin-reuse-")));
  const procs = new Map([
    [10, { ppid: 1, start: "Mon Nov 23 09:00:00 2026", cwd: "/" }],
    [20, { ppid: 10, start: "Mon Nov 23 09:00:01 2026", cwd: checkout }],
    [21, { ppid: 20, start: "Mon Nov 23 09:00:02 2026", cwd: checkout }],
    [22, { ppid: 20, start: "Mon Nov 23 09:00:02 2026", cwd: checkout }],
  ]);
  const fake = fakeDarwin(procs);
  let psBroken = false;
  const run: ToolRunner = async (file, args) =>
    psBroken && file === "/bin/ps" ? undefined : fake.run(file, args);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    table: darwinTable(run),
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig !== "SIGTERM") return;
      // 21 ignores SIGTERM, exits, and a NEW process takes its pid; 22 keeps
      // running while ps cannot be read for the rest of the grace.
      if (pid === 21)
        procs.set(21, { ...procs.get(21)!, start: "Mon Nov 23 09:00:03 2026" });
      if (pid === 22) psBroken = true;
    },
  });
  assert.deepEqual(sent, [
    [21, "SIGTERM"],
    [22, "SIGTERM"],
  ]);
  assert.deepEqual(stop, { terminated: [21, 22], killed: [] });
});

test("on macOS, a same-second reused pid that is no longer ours is never signalled", async () => {
  const checkout = realpathSync(mkdtempSync(join(root, "darwin-same-second-")));
  const start = "Mon Nov 23 09:00:02 2026";
  const procs = new Map([
    [10, { ppid: 1, start: "Mon Nov 23 09:00:00 2026", cwd: "/" }],
    [20, { ppid: 10, start: "Mon Nov 23 09:00:01 2026", cwd: checkout }],
    [21, { ppid: 20, start, cwd: checkout }],
    [22, { ppid: 20, start, cwd: checkout }],
    [23, { ppid: 20, start, cwd: checkout }],
  ]);
  const fake = fakeDarwin(procs);
  let snapshotsBroken = false;
  const run: ToolRunner = async (file, args) =>
    snapshotsBroken && args[0] === "-A" ? undefined : fake.run(file, args);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    table: darwinTable(run),
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig !== "SIGTERM") return;
      // Each exits and, within the same second, a new process takes its pid
      // with the SAME lstart: 21's is a user's process (parent launchd), 22's
      // is ours but outside the checkout. 23 keeps running, but the fresh
      // table cannot be read when its SIGKILL is due.
      if (pid === 21) procs.set(21, { ppid: 1, start, cwd: checkout });
      if (pid === 22) procs.set(22, { ppid: 20, start, cwd: "/tmp" });
      if (pid === 23) snapshotsBroken = true;
    },
  });
  assert.deepEqual(sent, [
    [21, "SIGTERM"],
    [22, "SIGTERM"],
    [23, "SIGTERM"],
  ]);
  assert.deepEqual(stop, { terminated: [21, 22, 23], killed: [] });
});

test("on macOS, a process still ours after the grace is killed", async () => {
  const checkout = realpathSync(mkdtempSync(join(root, "darwin-kill-")));
  const procs = new Map([
    [10, { ppid: 1, start: "Mon Nov 23 09:00:00 2026", cwd: "/" }],
    [20, { ppid: 10, start: "Mon Nov 23 09:00:01 2026", cwd: checkout }],
    [21, { ppid: 20, start: "Mon Nov 23 09:00:02 2026", cwd: checkout }],
  ]);
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    table: darwinTable(fakeDarwin(procs).run),
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === "SIGKILL") procs.delete(pid);
    },
  });
  assert.deepEqual(sent, [
    [21, "SIGTERM"],
    [21, "SIGKILL"],
  ]);
  assert.deepEqual(stop, { terminated: [21], killed: [21] });
});

test("on macOS, an old identity never pairs with a reused pid's directory", async () => {
  const checkout = realpathSync(mkdtempSync(join(root, "darwin-mixed-")));
  const start = "Mon Nov 23 09:00:02 2026";
  const procs = new Map([
    [10, { ppid: 1, start: "Mon Nov 23 09:00:00 2026", cwd: "/" }],
    [20, { ppid: 10, start: "Mon Nov 23 09:00:01 2026", cwd: checkout }],
    [21, { ppid: 20, start, cwd: checkout }],
  ]);
  const fake = fakeDarwin(procs);
  let reuseAtLsof = false;
  const run: ToolRunner = async (file, args) => {
    // Between the ownership snapshot and the directory read, 21 exits and a
    // user's process (parent launchd) takes its pid in the same second, in
    // the checkout: the snapshot still says ours, the directory says inside.
    if (reuseAtLsof && file === "/usr/sbin/lsof") {
      reuseAtLsof = false;
      procs.set(21, { ppid: 1, start, cwd: checkout });
    }
    return fake.run(file, args);
  };
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  const stop = await stopCheckoutProcesses(checkout, {
    table: darwinTable(run),
    selfPid: 10,
    graceMs: 300,
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === "SIGTERM") reuseAtLsof = true;
    },
  });
  assert.deepEqual(sent, [[21, "SIGTERM"]]);
  assert.deepEqual(stop, { terminated: [21], killed: [] });
});

test("a tool that does not answer in time is no answer, through the real broker", async () => {
  const run = brokerToolRunner(200);
  const started = Date.now();
  assert.equal(await run("/bin/sleep", ["30"]), undefined);
  assert.ok(Date.now() - started < 5_000, "the timeout ended the wait");
  // A tool that answers in time still does, exit 1 included.
  assert.equal(
    await run("/bin/sh", ["-c", "echo partial; exit 1"]),
    "partial\n",
  );

  // A table whose reads time out finds nothing and signals nothing.
  const sent: number[] = [];
  const hung: ToolRunner = () => run("/bin/sleep", ["30"]);
  const stop = await stopCheckoutProcesses(root, {
    table: darwinTable(hung),
    signal: (pid) => sent.push(pid),
  });
  assert.deepEqual(stop, { terminated: [], killed: [] });
  assert.deepEqual(sent, []);
});
