import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createRelayDedup } from "./relayDedup.ts";
const close: (() => void)[] = [];
afterEach(() => {
  while (close.length) close.pop()!();
});
function fixture(maxIntervals = 4096) {
  let now = 0;
  const lines: string[] = [];
  const dedup = createRelayDedup({
    now: () => now,
    maxIntervals,
    log: (line) => lines.push(line),
  });
  close.push(() => dedup.close());
  return {
    dedup,
    lines,
    advance(ms: number) {
      now += ms;
    },
  };
}
test("intervals merge in both directions without confusing holes or clients", () => {
  const { dedup } = fixture();
  for (const n of [1, 5, 3, 2, 4, 7, 6])
    assert.equal(dedup.enter("a", "boot", n), "new");
  for (let n = 1; n <= 7; n++)
    assert.equal(dedup.enter("a", "boot", n), "present");
  assert.equal(dedup.enter("b", "boot", 1), "new");
  assert.equal(dedup.enter("a", "other", 1), "new");
});
test("activity refreshes the six-hour lifetime of both rid intervals and delivery ack", () => {
  const f = fixture();
  f.dedup.enter("a", "boot", 1);
  f.dedup.acknowledge("a", "boot", 9);
  f.advance(6 * 60 * 60_000 - 1);
  assert.equal(f.dedup.ack("a", "boot"), 9);
  f.advance(6 * 60 * 60_000 - 1);
  assert.equal(f.dedup.enter("a", "boot", 1), "present");
  f.advance(6 * 60 * 60_000);
  assert.equal(f.dedup.enter("a", "boot", 1), "new");
  assert.equal(f.dedup.ack("a", "boot"), 0);
});
test("the 65th boot evicts only that client's least recently used boot", () => {
  const { dedup } = fixture();
  dedup.enter("b", "0", 1);
  for (let n = 0; n < 64; n++) dedup.enter("a", String(n), 1);
  assert.equal(dedup.enter("a", "0", 1), "present");
  dedup.enter("a", "64", 1);
  assert.equal(dedup.enter("a", "0", 1), "present");
  assert.equal(dedup.enter("a", "1", 1), "new");
  assert.equal(dedup.enter("b", "0", 1), "present");
});
test("compaction loses a genuinely missing old rid, with counted diagnostics rather than silence", () => {
  const { dedup, lines } = fixture(4);
  for (const n of [1, 3, 5, 7, 9, 11]) dedup.enter("a", "aaaaaaaa", n);
  // 2 was never entered. This is real loss, not an ordinary duplicate.
  assert.equal(dedup.enter("a", "aaaaaaaa", 2), "below-floor");
  dedup.dropped("a", "aaaaaaaa", 1);
  assert.deepEqual(lines, [
    "relay observations: client=a boot=aaaaaaaa below-floor dropped=1 total=1",
  ]);
  dedup.dropped("a", "aaaaaaaa", 2);
  assert.match(lines[1]!, /dropped=2 total=3$/);
  assert.equal(dedup.enter("a", "aaaaaaaa", 4), "new");
});
