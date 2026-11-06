import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { readEnrollmentCode } from "./enrollmentCode.ts";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("reads a 0600 code file and rejects public files, links and invalid codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-code-"));
  directories.push(dir);
  const path = join(dir, "code");
  writeFileSync(path, "fake-enrollment-code\n", { mode: 0o600 });
  assert.equal(readEnrollmentCode(path), "fake-enrollment-code");
  chmodSync(path, 0o644);
  assert.throws(() => readEnrollmentCode(path), /0600/);
  chmodSync(path, 0o600);
  const link = join(dir, "link");
  symlinkSync(path, link);
  assert.throws(() => readEnrollmentCode(link));
  for (const text of ["", "code1\ncode2", "x".repeat(513)]) {
    writeFileSync(path, text);
    assert.throws(() => readEnrollmentCode(path));
  }
});

function command(
  args: string[],
  input = "",
): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      stdio: "pipe",
    });
    let out = "",
      err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out, err }));
    child.stdin.end(input);
  });
}

test("reads stdin without a code in argv, and the CLI refuses --code", async () => {
  const url = new URL("./enrollmentCode.ts", import.meta.url).href;
  const result = await command(
    [
      "--input-type=module",
      "--eval",
      `import { readEnrollmentCode } from ${JSON.stringify(url)}; console.log(readEnrollmentCode());`,
    ],
    "fake-stdin-code\n",
  );
  assert.equal(result.status, 0);
  assert.equal(result.out.trim(), "fake-stdin-code");
  const cli = await command([
    new URL("./main.ts", import.meta.url).pathname,
    "enroll",
    "--state-dir",
    "/unused",
    "--code",
    "fake-argv-code",
  ]);
  assert.notEqual(cli.status, 0);
  assert.match(cli.err, /Unknown option/);
  assert.ok(!cli.err.includes("fake-argv-code"));
});
