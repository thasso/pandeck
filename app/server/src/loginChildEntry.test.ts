/**
 * The real login child entries under tsx (Task-1387 AC5): the Claude child
 * runs the CLI named by `ASSISTANT_CLAUDE_CLI_BIN` (a fake here) through the
 * vault's port, a malformed first line starts no driver in either child, and
 * the end of stdin cancels a running Claude login. No network, no real CLI;
 * every value is fake.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, test } from "vitest";
import { loginChildDriver } from "./gateway/loginChild.ts";

let dir: string;
let before: string | undefined;
/** Synthetic; not a real credential. */
const FAKE_ACCESS = "fake-entry-access";
const CREDENTIAL = JSON.stringify({
  claudeAiOauth: {
    accessToken: FAKE_ACCESS,
    expiresAt: Date.now() + 3_600_000,
  },
});

/** A fake official CLI: prints a login URL, writes its pid, then `body`. */
function fakeCli(name: string, body: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, String(process.pid));
if (!process.argv.slice(2).join(" ").includes("auth login")) process.exit(9);
process.stdout.write("Open https://claude.example/oauth?x=1\\nPaste code here: ");
${body}
`,
  );
  const shim = join(dir, name);
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "login-entry-"));
  before = process.env.ASSISTANT_CLAUDE_CLI_BIN;
});
afterAll(() => {
  if (before === undefined) delete process.env.ASSISTANT_CLAUDE_CLI_BIN;
  else process.env.ASSISTANT_CLAUDE_CLI_BIN = before;
  rmSync(dir, { recursive: true, force: true });
});

const entry = (name: string) => ({
  file: process.execPath,
  args: ["--import", "tsx", resolve("src", name)],
});

function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

/** Runs an entry directly; `feed` writes its stdin. Resolves with its exit. */
function direct(
  name: string,
  feed: (stdin: NodeJS.WritableStream, stdout: () => string) => void,
): Promise<{ code: number | null; stdout: string }> {
  const { file, args } = entry(name);
  const child = spawn(file, args, {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      ...(process.env.ASSISTANT_CLAUDE_CLI_BIN
        ? { ASSISTANT_CLAUDE_CLI_BIN: process.env.ASSISTANT_CLAUDE_CLI_BIN }
        : {}),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  feed(child.stdin, () => stdout);
  return new Promise((done) =>
    child.on("close", (code) => done({ code, stdout })),
  );
}

test("the Claude child runs the CLI login through the port: url, input, credential in configDir", async () => {
  process.env.ASSISTANT_CLAUDE_CLI_BIN = fakeCli(
    "cli-ok",
    `process.stdin.setEncoding("utf8");
process.stdin.once("data", (line) => {
  if (line.trim() !== "fake-pasted-code") process.exit(4);
  fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/.credentials.json", ${JSON.stringify(CREDENTIAL)});
  process.exit(0);
});`,
  );
  const configDir = mkdtempSync(join(dir, "cfg-"));
  const urls: string[] = [];
  const run = loginChildDriver(entry("claudeLoginMain.ts"), {
    log: () => {},
  })(configDir, {
    output: () => {},
    url: (url) => urls.push(url),
    code: () => {},
  });
  for (let i = 0; i < 1200 && urls.length === 0; i++) await delay(25);
  assert.deepEqual(urls, ["https://claude.example/oauth?x=1"]);
  run.input("fake-pasted-code");
  await run.done;
  assert.equal(
    readFileSync(join(configDir, ".credentials.json"), "utf8"),
    CREDENTIAL,
  );
}, 60_000);

test("a malformed first line answers done not ok and starts no driver, in either child", async () => {
  process.env.ASSISTANT_CLAUDE_CLI_BIN = fakeCli(
    "cli-unused",
    "process.exit(0);",
  );
  for (const name of ["claudeLoginMain.ts", "codexLoginMain.ts"]) {
    const answer = await direct(name, (stdin) => stdin.write("not json\n"));
    assert.equal(answer.code, 0, name);
    assert.equal(
      answer.stdout,
      `${JSON.stringify({ type: "done", ok: false })}\n`,
    );
  }
  assert.equal(existsSync(join(dir, "cli-unused.pid")), false);
}, 120_000);

test("the end of stdin cancels a running Claude login, and the CLI is gone", async () => {
  process.env.ASSISTANT_CLAUDE_CLI_BIN = fakeCli(
    "cli-wait",
    "setInterval(() => {}, 1000);",
  );
  const configDir = mkdtempSync(join(dir, "cfg-"));
  const answer = await direct("claudeLoginMain.ts", (stdin, stdout) => {
    stdin.write(`${JSON.stringify({ configDir })}\n`);
    void (async () => {
      for (let i = 0; i < 1200 && !stdout().includes('"url"'); i++)
        await delay(25);
      stdin.end();
    })();
  });
  assert.equal(answer.code, 0);
  const lines = answer.stdout.trim().split("\n");
  assert.ok(lines.some((line) => line.includes('"type":"url"')));
  assert.equal(lines.at(-1), JSON.stringify({ type: "done", ok: false }));
  assert.equal(
    running(Number(readFileSync(join(dir, "cli-wait.pid"), "utf8"))),
    false,
  );
}, 60_000);
