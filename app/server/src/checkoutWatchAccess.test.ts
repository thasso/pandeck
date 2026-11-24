import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import { checkoutWatchOn } from "./checkoutWatchAccess.ts";
import parcelWatcher from "./parcelWatcher.ts";

const scratch = mkdtempSync(join(tmpdir(), "checkout-watch-access-"));
afterAll(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (check()) return;
    await new Promise<void>((done) => setTimeout(done, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the server side watches a linked root at its real path and reports paths under the link", async () => {
  // macOS FSEvents names real paths whatever was subscribed (`/var` is
  // `/private/var`); the watcher relates events to the root it asked for.
  const real = join(scratch, "real");
  mkdirSync(real);
  const alias = join(scratch, "alias");
  symlinkSync(real, alias);
  const subscribe = vi.spyOn(parcelWatcher, "subscribe");
  const seen: string[] = [];
  const subscription = await checkoutWatchOn("server").subscribe(
    alias,
    alias,
    (err, events) => {
      if (!err) seen.push(...events.map((event) => event.path));
    },
    { ignore: [], onOverflow: () => undefined, onLost: () => undefined },
  );
  try {
    assert.equal(subscribe.mock.calls[0]?.[0], realpathSync(real));
    writeFileSync(join(alias, "through-link.txt"), "x\n");
    await until("the file's event", () =>
      seen.includes(join(alias, "through-link.txt")),
    );
    assert.ok(
      seen.every((path) => path === alias || path.startsWith(`${alias}/`)),
      seen.join("\n"),
    );
  } finally {
    await subscription.unsubscribe();
    subscribe.mockRestore();
  }
});
