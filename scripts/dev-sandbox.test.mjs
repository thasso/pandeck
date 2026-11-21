import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSandboxRoot, sandboxEnvironment } from "./dev-sandbox.mjs";

test("only an absent, empty or marked folder may become a sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-sandbox-"));
  try {
    assertSandboxRoot(join(root, "absent"));
    assertSandboxRoot(root);
    writeFileSync(join(root, "keep.txt"), "user data");
    assert.throws(() => assertSandboxRoot(root), /not created by dev:sandbox/);
    writeFileSync(join(root, ".pandeck-sandbox"), "");
    assertSandboxRoot(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the environment inherits nothing but PATH and lives under the sandbox", () => {
  const env = sandboxEnvironment("/sandbox", 8890, {
    PATH: "/bin",
    HOME: "/home/me",
    GITHUB_TOKEN: "secret",
    ASSISTANT_TOKEN: "secret",
    NODE_ENV: "production",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/sandbox/home");
  assert.equal(env.DATA_DIR, "/sandbox/data");
  assert.equal(env.ASSISTANT_CWD, "/sandbox/work");
  assert.equal(env.ASSISTANT_HOST, "127.0.0.1");
  assert.doesNotMatch(JSON.stringify(env), /secret|production|\/home\/me/);
  for (const [key, value] of Object.entries(env))
    if (key.startsWith("XDG_")) assert.match(value, /^\/sandbox\/home\//);
});
