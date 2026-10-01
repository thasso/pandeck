import { describe, expect, test } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { toolBlockIsVisible } from "./registry.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

function block(output: string): ToolBlock {
  return {
    kind: "tool",
    name: "worktree_push",
    args: { worktreeId: "wt-1" },
    output,
    done: true,
    isError: false,
  } as ToolBlock;
}

describe("worktree_push rich result", () => {
  test("a complete checked PushDisplay remains visible when tools are hidden", () => {
    expect(
      toolBlockIsVisible(
        block(
          JSON.stringify({
            status: "pushed",
            remote: "origin",
            branch: "feature",
            forced: false,
            setUpstream: true,
            localHead: "123456789abcdef",
          }),
        ),
        false,
      ),
    ).toBe(true);
  });

  test("malformed or failed results fall back to ordinary hidden output", () => {
    expect(toolBlockIsVisible(block('{"status":"pushed"}'), false)).toBe(false);
    expect(
      toolBlockIsVisible({ ...block("{}"), isError: true } as ToolBlock, false),
    ).toBe(false);
  });
});
