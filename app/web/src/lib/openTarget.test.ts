import { describe, expect, test } from "vitest";
import { pathFromOpenTarget } from "./openTarget.ts";

/**
 * The interesting cases are the rejections. This value crosses a trust boundary
 * — any program on the machine can hand the app a `pa://` URL — so a shape that
 * resolves to somewhere off-site is the failure that matters, and it is silent:
 * the app would simply navigate away.
 */
describe("pathFromOpenTarget", () => {
  test("resolves a pa:// object link to its canonical route", () => {
    expect(pathFromOpenTarget("pa://task/274")).toBe("/tasks/274");
    expect(pathFromOpenTarget("pa://session/abc-123")).toBe(
      "/sessions/abc-123",
    );
    expect(pathFromOpenTarget("PA://TASK/274")).toBe("/tasks/274");
  });

  test("keeps a query and fragment on a pa:// link", () => {
    expect(pathFromOpenTarget("pa://worktree/w1?from=a&to=b")).toBe(
      "/worktrees/w1?from=a&to=b",
    );
  });

  test("passes an app path through", () => {
    expect(pathFromOpenTarget("/assistant")).toBe("/assistant");
    expect(pathFromOpenTarget("/sessions/xyz")).toBe("/sessions/xyz");
  });

  test("drops an unknown pa:// object type rather than navigating", () => {
    // `paObjectLinkHref` answers with a `#unresolved-pa-link:` marker, which is
    // for rendering prose, not a destination.
    expect(pathFromOpenTarget("pa://nonsense/1")).toBeNull();
  });

  test("drops anything that could leave the app", () => {
    for (const hostile of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example",
      "javascript:alert(1)",
      "pa:/task/1",
      "tasks/274",
      "",
      "   ",
    ])
      expect(pathFromOpenTarget(hostile)).toBeNull();
  });
});
