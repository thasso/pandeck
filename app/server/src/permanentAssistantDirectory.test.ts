import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pa-directory-"));
process.env.DATA_DIR = join(tmp, "data");
const {
  DEFAULT_ASSISTANT_WORKING_DIRECTORY,
  resolveAssistantWorkingDirectory,
  validateAssistantWorkingDirectory,
} = await import("./permanentAssistantDirectory.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("default cwd is dedicated and created on demand", () => {
  assert.equal(existsSync(DEFAULT_ASSISTANT_WORKING_DIRECTORY), false);
  assert.deepEqual(resolveAssistantWorkingDirectory(""), {
    cwd: join(tmp, "data", "personal-assistant"),
  });
  assert.equal(existsSync(DEFAULT_ASSISTANT_WORKING_DIRECTORY), true);
});

test("a configured directory is used unchanged", () => {
  const cwd = join(tmp, "configured");
  mkdirSync(cwd);
  validateAssistantWorkingDirectory(cwd);
  assert.deepEqual(resolveAssistantWorkingDirectory(cwd), { cwd });
});

test("a vanished directory falls back with a visible notice", () => {
  const cwd = join(tmp, "vanished");
  mkdirSync(cwd);
  validateAssistantWorkingDirectory(cwd);
  rmSync(cwd, { recursive: true });
  const result = resolveAssistantWorkingDirectory(cwd);
  assert.equal(result.cwd, DEFAULT_ASSISTANT_WORKING_DIRECTORY);
  assert.match(
    result.notice!,
    /configured Personal Assistant working directory is unavailable/,
  );
  assert.ok(result.notice!.includes(cwd));
});

test("saving rejects relative, missing and non-directory paths", () => {
  validateAssistantWorkingDirectory("");
  assert.throws(
    () => validateAssistantWorkingDirectory("relative"),
    /absolute path/,
  );
  assert.throws(
    () => validateAssistantWorkingDirectory(join(tmp, "missing")),
    /existing directory/,
  );
  const file = join(tmp, "file");
  writeFileSync(file, "text");
  assert.throws(
    () => validateAssistantWorkingDirectory(file),
    /existing directory/,
  );
});
