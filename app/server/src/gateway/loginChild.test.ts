/**
 * The login children's port (Task-1387): events and input over the JSON
 * lines, the process group ended before `done` settles on every path, the
 * bounds and fixed texts, and the minimal environment. The children are
 * fixture scripts that speak the child's side; every value is fake.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, onTestFinished, test } from "vitest";
import { loginChildDriver, type LoginChildOptions } from "./loginChild.ts";

let dir: string;
let count = 0;
const SENTINEL = "PANDECK_T1387_SENTINEL";
/** Synthetic child text that must never reach a rejection. */
const CHILD_TEXT = "fake-child-text-sentinel-1387";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "login-child-"));
  process.env[SENTINEL] = "must-not-reach-the-child";
});
afterAll(() => {
  delete process.env[SENTINEL];
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A child script speaking the child's side: `start` runs once the first line
 * named `configDir`; `onInput` gets each later line's input.
 */
function child(body: string): { file: string; args: string[] } {
  const path = join(dir, `child-${(count += 1)}.mjs`);
  writeFileSync(
    path,
    `import fs from "node:fs";
import { spawn } from "node:child_process";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let configDir;
let onInput = () => {};
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (let at = buffered.indexOf("\\n"); at !== -1; at = buffered.indexOf("\\n")) {
    const line = JSON.parse(buffered.slice(0, at));
    buffered = buffered.slice(at + 1);
    if (configDir === undefined) {
      configDir = line.configDir;
      start();
    } else onInput(line.input);
  }
});
function start() {
${body}
}
`,
  );
  return { file: process.execPath, args: [path] };
}

/** A login directory and a run of `command` in it. */
function login(
  command: { file: string; args: string[] },
  options: LoginChildOptions = {},
) {
  const configDir = mkdtempSync(join(dir, "cfg-"));
  const seen: string[] = [];
  const lines: string[] = [];
  const run = loginChildDriver(command, {
    log: (line) => lines.push(line),
    ...options,
  })(configDir, {
    output: (text) => seen.push(`output:${text}`),
    url: (url) => seen.push(`url:${url}`),
    code: (code) => seen.push(`code:${code}`),
  });
  return { run, seen, lines, configDir };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Whether `pid` runs: a zombie or a reaped process does not. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/**
 * Starts a grandchild in the leader's group, then reports `ready`. The
 * grandchild ignores SIGTERM, writes its pid to `pidFile` and, 300 ms after
 * its parent is gone, tries to write `late` into the login directory.
 */
function withGrandchild(pidFile: string, then: string): string {
  return `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(
    `const fs = require("node:fs");
process.on("SIGTERM", () => {});
const parent = process.ppid;
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const watch = setInterval(() => {
  if (process.ppid === parent) return;
  clearInterval(watch);
  setTimeout(() => fs.writeFileSync(process.argv[1] + "/late", "x"), 300);
}, 10);
setInterval(() => {}, 1000);`,
  )}, configDir], { stdio: "ignore" });
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
  clearInterval(ready);
  send({ type: "output", text: "ready" });
  ${then}
}, 10);
setInterval(() => {}, 1000);`;
}

const pidOf = (pidFile: string): number =>
  Number(readFileSync(pidFile, "utf8"));

/** The grandchild is gone at settle, and its late write never lands. */
async function noLateWriter(pidFile: string, configDir: string): Promise<void> {
  assert.equal(running(pidOf(pidFile)), false, "a group member outlived done");
  await delay(600);
  assert.equal(existsSync(join(configDir, "late")), false);
}

test("events arrive in order, input reaches the child, and done ok with exit 0 resolves", async () => {
  const { run, seen, configDir } = login(
    child(`send({ type: "output", text: "Paste the code: " });
send({ type: "url", text: "https://login.example/oauth?x=1" });
send({ type: "code", text: "ABCD-1234" });
onInput = (text) => {
  fs.writeFileSync(configDir + "/got", text);
  send({ type: "done", ok: true });
  process.exit(0);
};`),
  );
  await until(() => seen.length === 3, "the events");
  run.input("fake-typed-code");
  await run.done;
  assert.deepEqual(seen, [
    "output:Paste the code: ",
    "url:https://login.example/oauth?x=1",
    "code:ABCD-1234",
  ]);
  assert.equal(readFileSync(join(configDir, "got"), "utf8"), "fake-typed-code");
});

test("the child gets the minimal environment and only its entry in argv", async () => {
  const runtimeDir = join(dir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const before = process.env.ASSISTANT_RUNTIME_DIR;
  process.env.ASSISTANT_RUNTIME_DIR = runtimeDir;
  try {
    const { run, configDir } = login(
      child(`fs.writeFileSync(configDir + "/env.json", JSON.stringify({
  keys: Object.keys(process.env),
  argv: process.argv.slice(2),
}));
send({ type: "done", ok: true });
process.exit(0);`),
    );
    await run.done;
    const { keys, argv } = JSON.parse(
      readFileSync(join(configDir, "env.json"), "utf8"),
    ) as { keys: string[]; argv: string[] };
    assert.equal(keys.includes(SENTINEL), false);
    assert.equal(keys.includes("ASSISTANT_RUNTIME_DIR"), true);
    assert.deepEqual(argv, []);
  } finally {
    if (before === undefined) delete process.env.ASSISTANT_RUNTIME_DIR;
    else process.env.ASSISTANT_RUNTIME_DIR = before;
  }
});

test("cancel with a leader that exits at once: the grandchild is gone before done", async () => {
  const pidFile = join(dir, `gc-${(count += 1)}.pid`);
  const { run, seen, configDir } = login(child(withGrandchild(pidFile, "")));
  await until(() => seen.includes("output:ready"), "the child");
  run.cancel();
  await assert.rejects(run.done, { message: "The login did not complete." });
  await noLateWriter(pidFile, configDir);
});

test("cancel with a leader that ignores SIGTERM: the group is killed after the grace", async () => {
  const pidFile = join(dir, `gc-${(count += 1)}.pid`);
  const { run, seen, configDir } = login(
    child(`process.on("SIGTERM", () => {});
${withGrandchild(pidFile, "")}`),
    { killGraceMs: 200 },
  );
  await until(() => seen.includes("output:ready"), "the child");
  const began = Date.now();
  run.cancel();
  await assert.rejects(run.done, { message: "The login did not complete." });
  assert.ok(Date.now() - began >= 200, "settled before the escalation");
  await noLateWriter(pidFile, configDir);
});

test("a leader exiting 1 on its own: the grandchild is gone before done", async () => {
  const pidFile = join(dir, `gc-${(count += 1)}.pid`);
  const { run, seen, configDir } = login(
    child(withGrandchild(pidFile, "setTimeout(() => process.exit(1), 50);")),
  );
  await assert.rejects(run.done, { message: "The login did not complete." });
  assert.ok(seen.includes("output:ready"));
  await noLateWriter(pidFile, configDir);
});

test("success with a leftover grandchild resolves only once the group is empty", async () => {
  const pidFile = join(dir, `gc-${(count += 1)}.pid`);
  const { run, configDir } = login(
    child(
      withGrandchild(
        pidFile,
        `send({ type: "done", ok: true }); process.exit(0);`,
      ),
    ),
  );
  await run.done;
  await noLateWriter(pidFile, configDir);
});

/** Each fault, as the child's stdout, then an event that must not pass. */
const FAULTS: [string, string][] = [
  [
    "a line over 16 KiB",
    `send({ type: "output", text: "${CHILD_TEXT}" + "x".repeat(17 * 1024) });`,
  ],
  [
    "output over 256 KiB",
    `for (let i = 0; i < 40; i++) send({ type: "output", text: "${CHILD_TEXT}" + "x".repeat(8 * 1024) });`,
  ],
  ["malformed JSON", `process.stdout.write("not json ${CHILD_TEXT}\\n");`],
  ["an unknown type", `send({ type: "token", text: "${CHILD_TEXT}" });`],
  ["a text that is no string", `send({ type: "output", text: 42 });`],
  [
    "an http url",
    `send({ type: "url", text: "http://login.example/${CHILD_TEXT}" });`,
  ],
  [
    "a url over 2048 chars",
    `send({ type: "url", text: "https://login.example/${CHILD_TEXT}" + "x".repeat(2048) });`,
  ],
  [
    "a code over 64 chars",
    `send({ type: "code", text: "${CHILD_TEXT}" + "x".repeat(64) });`,
  ],
  [
    "a second done",
    `send({ type: "done", ok: true }); send({ type: "done", ok: true });`,
  ],
];

for (const [name, fault] of FAULTS)
  test(`${name} cancels the login with the fixed text`, async () => {
    const { run, seen } = login(
      child(`process.stderr.write("${CHILD_TEXT}\\n");
${fault}
send({ type: "output", text: "after-fault" });
setInterval(() => {}, 1000);`),
    );
    const err = await run.done.then(
      () => assert.fail("the login resolved"),
      (error: unknown) => error as Error,
    );
    assert.equal(err.message, "The login did not complete.");
    assert.equal(seen.includes("output:after-fault"), false);
    for (const event of seen)
      if (!name.startsWith("output over"))
        assert.equal(event.includes(CHILD_TEXT), false, event);
  });

test("exit 0 without done ok, done ok with a non-zero exit, and done not ok all reject", async () => {
  for (const body of [
    `send({ type: "output", text: "${CHILD_TEXT}" }); process.exit(0);`,
    `send({ type: "done", ok: true }); process.exit(3);`,
    `send({ type: "done", ok: false }); process.exit(0);`,
    `process.stdout.write(JSON.stringify({ type: "done", ok: true })); process.exit(0);`,
  ]) {
    const { run } = login(child(body));
    await assert.rejects(run.done, { message: "The login did not complete." });
  }
});

test("a child that cannot spawn rejects with the fixed start text", async () => {
  const { run } = login({ file: join(dir, "absent-binary"), args: [] });
  await assert.rejects(run.done, { message: "The login could not start." });
  run.cancel();
  run.input("ignored");
});

test("a leader that ignores SIGTERM and a descendant outside the group holding the pipes: done still settles within the bound", async () => {
  // The descendant leaves the group (its own session) and inherits stdout,
  // so the leader's pipes never close and no group kill reaches it.
  const pidFile = join(dir, `escaped-${(count += 1)}.pid`);
  const killGraceMs = 200;
  const closeWaitMs = 200;
  const groupWaitMs = 200;
  const { run, seen } = login(
    child(`process.on("SIGTERM", () => {});
const escaped = spawn(process.execPath, ["-e", ${JSON.stringify(
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);`,
    )}], { detached: true, stdio: ["ignore", "inherit", "ignore"] });
escaped.unref();
const ready = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(pidFile)})) return;
  clearInterval(ready);
  send({ type: "output", text: "ready" });
}, 10);
setInterval(() => {}, 1000);`),
    { killGraceMs, closeWaitMs, groupWaitMs },
  );
  // Runs even when the test times out: the escaped process is ours.
  onTestFinished(() => {
    try {
      process.kill(pidOf(pidFile), "SIGKILL");
    } catch {
      // Already gone, or never started.
    }
  });
  await until(() => seen.includes("output:ready"), "the child");
  const began = Date.now();
  run.cancel();
  await assert.rejects(run.done, { message: "The login did not complete." });
  const took = Date.now() - began;
  assert.ok(took >= killGraceMs, "settled before the escalation");
  assert.ok(
    took < killGraceMs + closeWaitMs + groupWaitMs + 1_000,
    `settled after ${took} ms`,
  );
});
