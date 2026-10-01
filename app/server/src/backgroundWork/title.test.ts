import assert from "node:assert/strict";
import { test } from "vitest";
import { backgroundWorkDescription, backgroundWorkTitle } from "./title.ts";

test("the description wins, collapsed and bounded", () => {
  assert.equal(
    backgroundWorkTitle({
      description: "  Start   dev\nserver ",
      command: "pnpm dev",
      fallback: "Shell",
    }),
    "Start dev server",
  );
  assert.equal(
    backgroundWorkTitle({ description: "x".repeat(300), fallback: "Shell" })
      .length,
    200,
  );
});

test("without a description the command's first non-empty line is the title", () => {
  assert.equal(
    backgroundWorkTitle({
      command: "\n\n  cd app &&   pnpm build  \necho done",
      fallback: "Shell",
    }),
    "cd app && pnpm build",
  );
  assert.equal(
    backgroundWorkTitle({
      description: "   ",
      command: "  \n ",
      fallback: "Shell",
    }),
    "Shell",
  );
});

test("a blank description is no description", () => {
  assert.equal(backgroundWorkDescription("  \n "), undefined);
  assert.equal(backgroundWorkDescription(" watch  it "), "watch it");
});
