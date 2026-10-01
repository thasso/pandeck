import assert from "node:assert/strict";
import { test } from "vitest";
import { memoryLogLine } from "./memoryLog.ts";

test("the memory line names the runtime whose heap it reports", () => {
  const mb = 1_048_576;
  const runtime = process.versions.bun
    ? `bun-${process.versions.bun}`
    : `node-${process.versions.node}`;
  assert.equal(
    memoryLogLine({
      rss: 300 * mb,
      heapUsed: 120 * mb,
      heapTotal: 150 * mb,
      external: 10 * mb,
      arrayBuffers: 2 * mb,
    }),
    `[memory] runtime=${runtime} rss=300MB heapUsed=120MB heapTotal=150MB external=10MB arrayBuffers=2MB`,
  );
});
