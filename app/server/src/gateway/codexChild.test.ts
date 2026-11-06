import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import { codexChildPort } from "./codexChild.ts";

let dir: string;
const SENTINEL = "PA_CODEX_CHILD_SENTINEL";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-"));
  process.env[SENTINEL] = "must-not-reach-the-child";
});
afterAll(() => {
  delete process.env[SENTINEL];
  rmSync(dir, { recursive: true, force: true });
});

/** A child script: `body` runs once the request line is read as `request`. */
function child(name: string, body: string): { file: string; args: string[] } {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(
    path,
    `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const request = JSON.parse(input.split("\\n")[0]);
  ${body}
});
`,
  );
  return { file: process.execPath, args: [path] };
}

/** The pid a child script wrote to `pidFile`, once it has. */
async function pidOf(pidFile: string): Promise<number> {
  for (let i = 0; i < 200; i += 1) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("the child never wrote its pid");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const signal = (): AbortSignal => new AbortController().signal;

test("a child answering one line and exiting 0 gives its result, with one request on stdin and a minimal env", async () => {
  const port = codexChildPort(
    child(
      "ok",
      `const env = Object.keys(process.env).filter((name) => !["PATH", "HOME", "TMPDIR", "NODE_ENV"].includes(name));
const good = request.authFile === "/x/auth.json" && request.minValidityMs === 42 && env.length === 0 && process.argv.length === 2;
process.stdout.write(JSON.stringify(good ? { ok: true } : { ok: false, kind: "failed", code: "bad_input" }) + "\\n");
process.exit(0);`,
    ),
  );
  assert.deepEqual(await port("/x/auth.json", 42, signal()), { ok: true });
});

test("a refusal line passes through without extra fields", async () => {
  const port = codexChildPort(
    child(
      "rejected",
      `process.stdout.write(JSON.stringify({ ok: false, kind: "rejected", code: "invalid_grant", token: "x" }) + "\\n");
process.exit(0);`,
    ),
  );
  assert.deepEqual(await port("/x", 1, signal()), {
    ok: false,
    kind: "rejected",
    code: "invalid_grant",
  });
});

test("a malformed line, a missing line, a non-zero exit or a spawn error fails closed", async () => {
  const failed = { ok: false, kind: "failed", code: "child" };
  for (const body of [
    `process.stdout.write("not json\\n"); process.exit(0);`,
    `process.stdout.write(JSON.stringify({ ok: "yes" }) + "\\n"); process.exit(0);`,
    `process.stdout.write('{"ok":true}\\n{"ok":true}\\n'); process.exit(0);`,
    `process.stdout.write('{"ok":true}'); process.exit(0);`,
    `process.stdout.write(' '.repeat(5000) + '{"ok":true}\\n'); process.exit(0);`,
    `process.exit(0);`,
    `process.stdout.write(JSON.stringify({ ok: true }) + "\\n"); process.exit(3);`,
  ])
    assert.deepEqual(
      await codexChildPort(child(`bad${body.length}`, body))("/x", 1, signal()),
      failed,
      body,
    );
  assert.deepEqual(
    await codexChildPort({ file: join(dir, "missing-binary"), args: [] })(
      "/x",
      1,
      signal(),
    ),
    failed,
  );
});

test("a child past the deadline is killed and fails closed", async () => {
  const pidFile = join(dir, "deadline.pid");
  const port = codexChildPort(
    child(
      "deadline",
      `import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
setInterval(() => {}, 1000);`,
    ),
    { deadlineMs: 300 },
  );
  const answer = port("/x", 1, signal());
  const pid = await pidOf(pidFile);
  assert.deepEqual(await answer, { ok: false, kind: "failed", code: "child" });
  assert.equal(alive(pid), false);
});

test("an abort sends SIGTERM, then SIGKILL after the grace, and answers aborted once the child is gone", async () => {
  const pidFile = join(dir, "abort.pid");
  const port = codexChildPort(
    child(
      "abort",
      `process.on("SIGTERM", () => {});
import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
setInterval(() => {}, 1000);`,
    ),
    { killGraceMs: 200 },
  );
  const controller = new AbortController();
  const answer = port("/x", 1, controller.signal);
  const pid = await pidOf(pidFile);
  controller.abort();
  assert.deepEqual(await answer, {
    ok: false,
    kind: "failed",
    code: "aborted",
  });
  assert.equal(alive(pid), false);
});

test("the real renewal child answers failed for a missing file, with no network", async () => {
  const port = codexChildPort({
    file: process.execPath,
    args: ["--import", "tsx", resolve("src/codexRenewMain.ts")],
  });
  const answer = await port(join(dir, "absent", "auth.json"), 1, signal());
  assert.equal(answer.ok, false);
  assert.equal(answer.ok === false && answer.kind, "failed");
  assert.notEqual(answer.ok === false && answer.code, "child");
}, 60_000);
