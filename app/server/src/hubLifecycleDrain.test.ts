import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "hub-lifecycle-drain-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { hub } = await import("./hub.ts");

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("lifecycle admission closes synchronously before a failing drain and clean exit stays blocked", async () => {
  const order: string[] = [];
  hub.registerLifecycleDrainParticipant({
    closeAdmissions: () => order.push("close"),
    drain: () => {
      order.push("drain");
      throw new Error("injected drain failure");
    },
  });

  hub.requestReload();
  assert.deepEqual(
    order,
    ["close"],
    "admission closes in the requesting stack",
  );
  assert.equal(hub.isReloadQueued(), true);
  await flush();
  assert.deepEqual(order, ["close", "drain"]);
  assert.equal(
    hub.isReloadQueued(),
    true,
    "a failed participant cannot authorize the clean-exit timer",
  );
});
