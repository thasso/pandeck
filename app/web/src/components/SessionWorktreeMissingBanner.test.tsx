import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKTREE_MISSING_BLOCKED_REASON } from "@assistant/shared";
import { SessionWorktreeMissingBanner } from "./SessionWorktreeMissingBanner.tsx";

describe("SessionWorktreeMissingBanner", () => {
  it("explains the block in the SHARED wording the server refuses with", () => {
    const html = renderToStaticMarkup(
      <SessionWorktreeMissingBanner onAcknowledge={() => {}} />,
    );
    // The one wording, so the banner and the server's refusal cannot drift.
    expect(html).toContain(WORKTREE_MISSING_BLOCKED_REASON);
    // The banner carries the only affordance that unblocks the composer.
    expect(html).toContain("Run in the app directory anyway");
  });
});
