import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { ignoreCollectedFileHandle } from "./collectedFileHandle.ts";

/** Bun 1.4.2's error, as its `onFileHandleCollected` raises it. */
const BUN_MESSAGE =
  "A FileHandle object was closed during garbage collection. This used to be allowed with a deprecation warning but is now considered an error. Please close FileHandle objects explicitly. File descriptor: 7 (file:///tmp/leak.txt)";

function errorWith(code: unknown, message: string): Error {
  return Object.assign(new Error(message), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("Bun's error for a FileHandle closed during GC only warns", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  assert.equal(
    ignoreCollectedFileHandle(
      errorWith("ERR_INVALID_STATE", BUN_MESSAGE),
      "server",
    ),
    true,
  );
  assert.equal(warn.mock.calls.length, 1);
  const line = String(warn.mock.calls[0]?.[0]);
  assert.ok(line.startsWith("[server] Warning: a leaked FileHandle"), line);
  assert.ok(line.endsWith(BUN_MESSAGE), line);
});

test("every other error stays fatal and logs nothing", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const err of [
    // Another ERR_INVALID_STATE, as Node's web streams raise one.
    errorWith(
      "ERR_INVALID_STATE",
      "Invalid state: Controller is already closed",
    ),
    // The sentence, but not as the message's start.
    errorWith("ERR_INVALID_STATE", `Wrapped: ${BUN_MESSAGE}`),
    // The message under another code, or none.
    errorWith("ERR_UNHANDLED_ERROR", BUN_MESSAGE),
    new Error(BUN_MESSAGE),
    errorWith("EPIPE", "write EPIPE"),
    { code: "ERR_INVALID_STATE", message: 7 },
    BUN_MESSAGE,
    null,
    undefined,
  ])
    assert.equal(ignoreCollectedFileHandle(err, "server"), false, String(err));
  assert.equal(warn.mock.calls.length, 0);
});
