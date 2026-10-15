import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { noteServerExit, takePreviousServerExit } from "./serverExitRecord.ts";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "server-exit-"));
}

test("the next boot takes the last words exactly once", () => {
  const dir = dataDir();
  noteServerExit(
    { kind: "crash", detail: "Uncaught exception: boom\n    at stack" },
    dir,
  );
  assert.deepEqual(takePreviousServerExit(dir), {
    kind: "crash",
    detail: "Uncaught exception: boom",
  });
  assert.equal(existsSync(join(dir, "server-exit.json")), false);
  assert.equal(
    takePreviousServerExit(dir),
    undefined,
    "a later boot must not blame its own exit on the old words",
  );
});

test("no record, or a torn one, says nothing", () => {
  const dir = dataDir();
  assert.equal(takePreviousServerExit(dir), undefined);
  writeFileSync(join(dir, "server-exit.json"), '{"kind":"cra');
  assert.equal(takePreviousServerExit(dir), undefined);
  assert.equal(existsSync(join(dir, "server-exit.json")), false);
});

test("writing never throws on the way out", () => {
  noteServerExit(
    { kind: "restart", detail: "Stopped by SIGTERM" },
    "/nonexistent/dir",
  );
});
