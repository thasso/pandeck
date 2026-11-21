import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  assert.equal(assets.claudeCliPath(), "/nix/store/example-claude");
  assert.equal(
    assets.KOKORO_SIDECAR_PATH,
    "/nix/store/example-runtime/speech/kokoroSidecar.py",
  );
});

test("a checkout runs the CLI the Agent SDK ships, never one on PATH", async () => {
  delete process.env.ASSISTANT_RUNTIME_DIR;
  delete process.env.ASSISTANT_CLAUDE_CLI_BIN;
  vi.resetModules();
  const assets = await import("./runtimeAssets.ts");

  const path = assets.claudeCliPath();
  assert.equal(existsSync(path), true);
  assert.match(path, /claude-agent-sdk-[a-z0-9-]+\/claude(?:\.exe)?$/);
  assert.deepEqual(assets.claudeSdkExecutableOptions(), {
    pathToClaudeCodeExecutable: path,
  });
});

test("looks for the platform's CLI package in the SDK's order", async () => {
  const { claudeCliPackageNames } = await import("./runtimeAssets.ts");
  const sdk = "@anthropic-ai/claude-agent-sdk";
  assert.deepEqual(claudeCliPackageNames("darwin", "arm64", false), [
    `${sdk}-darwin-arm64`,
  ]);
  assert.deepEqual(claudeCliPackageNames("linux", "x64", false), [
    `${sdk}-linux-x64`,
    `${sdk}-linux-x64-musl`,
  ]);
  assert.deepEqual(claudeCliPackageNames("linux", "arm64", true), [
    `${sdk}-linux-arm64-musl`,
    `${sdk}-linux-arm64`,
  ]);
});
