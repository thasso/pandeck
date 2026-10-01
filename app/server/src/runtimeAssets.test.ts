import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const originalRuntimeDir = process.env.ASSISTANT_RUNTIME_DIR;
const originalClaudeCli = process.env.ASSISTANT_CLAUDE_CLI_BIN;

afterEach(() => {
  if (originalRuntimeDir === undefined)
    delete process.env.ASSISTANT_RUNTIME_DIR;
  else process.env.ASSISTANT_RUNTIME_DIR = originalRuntimeDir;
  if (originalClaudeCli === undefined)
    delete process.env.ASSISTANT_CLAUDE_CLI_BIN;
  else process.env.ASSISTANT_CLAUDE_CLI_BIN = originalClaudeCli;
  vi.resetModules();
});

test("captures the packaged root before the instance environment is scrubbed", async () => {
  process.env.ASSISTANT_RUNTIME_DIR = "/nix/store/example-runtime";
  process.env.ASSISTANT_CLAUDE_CLI_BIN = "/nix/store/example-claude";
  vi.resetModules();
  const assets = await import("./runtimeAssets.ts");

  delete process.env.ASSISTANT_RUNTIME_DIR;
  delete process.env.ASSISTANT_CLAUDE_CLI_BIN;

  assert.equal(assets.IS_PACKAGED_RUNTIME, true);
  assert.equal(assets.RUNTIME_ASSET_ROOT, "/nix/store/example-runtime");
  assert.equal(
    assets.PACKAGED_XHR_SYNC_WORKER,
    "/nix/store/example-runtime/workers/xhr-sync-worker.js",
  );
  assert.equal(assets.packagedClaudeCliPath(), "/nix/store/example-claude");
});
