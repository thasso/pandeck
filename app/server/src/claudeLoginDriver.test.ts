import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const { claudeLoginInput, claudeLoginDriver } =
  await import("./claudeLoginDriver.ts");

test.each([
  ["  fixture-code#fixture-state  ", "fixture-code#fixture-state"],
  [
    "http://localhost:12345/callback?code=fixture-code&state=fixture-state",
    "fixture-code#fixture-state",
  ],
  [
    "https://platform.claude.com/oauth/code/callback?state=fixture-state&code=fixture%2Bcode",
    "fixture+code#fixture-state",
  ],
  [
    "https://example.test/callback?code=fixture-code",
    "https://example.test/callback?code=fixture-code",
  ],
  [
    "https://example.test/callback?code=a%23b&state=state",
    "https://example.test/callback?code=a%23b&state=state",
  ],
  [
    "https://example.test/callback?code=a%0Ab&state=state",
    "https://example.test/callback?code=a%0Ab&state=state",
  ],
  ["  ", ""],
])(
  "normalizes the CLI input without fetching the pasted address",
  (input, expected) => {
    assert.equal(claudeLoginInput(input), expected);
  },
);

test("the gateway driver forwards callback input in CLI format without echoing it", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    kill: vi.fn(),
  });
  mocks.spawn.mockReturnValue(child);
  const output = vi.fn();
  const url = vi.fn();
  const driver = claudeLoginDriver("/fixtures/isolated-profile", {
    output,
    url,
  });
  let stdin = "";
  child.stdin.on("data", (chunk) => {
    stdin += chunk.toString();
  });
  driver.input(
    "http://localhost:12345/callback?code=fixture-code&state=fixture-state",
  );
  assert.equal(stdin, "fixture-code#fixture-state\n");
  assert.equal(output.mock.calls.length, 0);
  assert.equal(url.mock.calls.length, 0);
  assert.equal(
    mocks.spawn.mock.calls[0]![2].env.CLAUDE_CONFIG_DIR,
    "/fixtures/isolated-profile",
  );
  child.emit("close", 0, null);
  await driver.done;
});
