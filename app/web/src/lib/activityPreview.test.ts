import { describe, expect, it } from "vitest";
import { activityPreview } from "./activityPreview.ts";

describe("activityPreview", () => {
  it("flattens common Markdown without exposing link destinations", () => {
    expect(
      activityPreview(
        "## Review\n\n- **Check** the [diff](/private/path).\n> `pnpm test` passes.",
      ),
    ).toBe("Review Check the diff. pnpm test passes.");
  });
  it("preserves identifiers and literal code while stripping paired emphasis", () => {
    expect(
      activityPreview("Use session_send_prompt and FOO_BAR with *.log."),
    ).toBe("Use session_send_prompt and FOO_BAR with *.log.");
    expect(
      activityPreview(
        "**Review** _this_ and `rm -f *.log && FOO_BAR=1`, then `__literal__`.",
      ),
    ).toBe("Review this and rm -f *.log && FOO_BAR=1, then __literal__.");
    expect(
      activityPreview("some_identifier_with_underscores and ~/work/**"),
    ).toBe("some_identifier_with_underscores and ~/work/**");
  });
  it("only flattens and bounds plain labels, never their syntax", () => {
    expect(activityPreview("rm -f *.log && FOO_BAR=1", "text")).toBe(
      "rm -f *.log && FOO_BAR=1",
    );
    expect(activityPreview("__literal__\n **/*.log** ~`cmd`~", "text")).toBe(
      "__literal__ **/*.log** ~`cmd`~",
    );
  });
  it("bounds the hint and leaves empty content empty", () => {
    expect(activityPreview("x".repeat(10_000))).toHaveLength(180);
    expect(activityPreview("x".repeat(10_000))).toMatch(/…$/);
    expect(activityPreview(" \n\t ")).toBe("");
  });
});
