import { describe, expect, test } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { toolBlockIsVisible } from "./registry.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

function block(output: string): ToolBlock {
  return {
    kind: "tool",
    name: "worktree_commit",
    args: { worktreeId: "wt-1" },
    output,
    done: true,
    isError: false,
  } as ToolBlock;
}

describe("worktree_commit rich result", () => {
  test("a complete CommitDisplay remains visible when ordinary tools are hidden", () => {
    expect(
      toolBlockIsVisible(
        block(
          JSON.stringify({
            status: "committed",
            dryRun: false,
            forced: false,
            commitHash: "123456789abc",
            commitMessage: "Add checked commit tool",
            blockers: [],
            warnings: [],
            files: [],
            totals: { files: 0, additions: 0, deletions: 0 },
          }),
        ),
        false,
      ),
    ).toBe(true);
  });

  test("malformed or failed results fall back to ordinary hidden tool output", () => {
    expect(toolBlockIsVisible(block('{"status":"committed"}'), false)).toBe(
      false,
    );
    expect(
      toolBlockIsVisible({ ...block("{}"), isError: true } as ToolBlock, false),
    ).toBe(false);
  });
});
