import assert from "node:assert/strict";
import { test } from "vitest";
import { BoundedBackgroundMonitorBuffer } from "./monitorBuffer.ts";

test("monitor lines are batched within byte and line caps with a dropped count", () => {
  const buffer = new BoundedBackgroundMonitorBuffer(2, 6);
  buffer.push("abc");
  buffer.push("de");
  buffer.push("line-cap");
  buffer.push("éééé");
  assert.deepEqual(buffer.take(), {
    lines: ["abc", "de"],
    bytes: 5,
    droppedEventCount: 2,
  });
  assert.deepEqual(buffer.take(), {
    lines: [],
    bytes: 0,
    droppedEventCount: 0,
  });

  const utf8 = new BoundedBackgroundMonitorBuffer(10, 6);
  utf8.push("a");
  utf8.push("ééé"); // six UTF-8 bytes cannot fit in the five remaining
  assert.deepEqual(utf8.take(), {
    lines: ["a"],
    bytes: 1,
    droppedEventCount: 1,
  });
});
