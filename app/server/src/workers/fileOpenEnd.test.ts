import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { checkWorkerFileOpenEnd } from "../../../../scripts/worker-file-open-end-probe.ts";

const closes = vi.hoisted(() => [] as { path: string; calls: number }[]);

// Passthrough observation of the real native descriptors, including the FIFO.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      const receipt = { path: String(args[0]), calls: 0 };
      closes.push(receipt);
      handle.close = () => {
        receipt.calls += 1;
        return close();
      };
      return handle;
    },
  };
});

test.each(["direct", "grant"] as const)(
  "%s: a native open orphaned on connection end cannot hold unrelated cleanup",
  async (route) => {
    closes.length = 0;
    await checkWorkerFileOpenEnd([route]);
    assert.equal(
      closes.filter(({ path }) => path.endsWith("swapped.bin")).length,
      1,
    );
    for (const receipt of closes) assert.equal(receipt.calls, 1, receipt.path);
  },
  15000,
);
