import { describe, expect, it } from "vitest";
import type { IdleWorktreesResponse } from "@assistant/shared";
import { failed, idle, loading, ready, refreshing } from "../lib/loadState.ts";
import { idleClock } from "./useIdleWorktrees.ts";

describe("idleClock", () => {
  const answer: IdleWorktreesResponse = { worktrees: [], fetchedAt: 864_000 };

  it("keeps the retained answer's clock through a refresh and a failed one", () => {
    expect(idleClock(ready(answer))).toBe(864_000);
    expect(idleClock(refreshing(answer))).toBe(864_000);
    expect(idleClock(failed("poll failed", answer))).toBe(864_000);
  });

  it("has no clock before anything answered", () => {
    expect(idleClock(idle())).toBeUndefined();
    expect(idleClock(loading())).toBeUndefined();
    expect(idleClock(failed("first read failed"))).toBeUndefined();
  });
});
