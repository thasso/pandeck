import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionPullRequestSummary } from "@assistant/shared";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";

function mark(pullRequest: SessionPullRequestSummary): string {
  return renderToStaticMarkup(
    <SessionDeliveryMark
      session={{ pullRequest }}
      variant="responsive"
      showNumber
    />,
  );
}

describe("SessionDeliveryMark with its number", () => {
  it("puts the number beside a state label that can collapse", () => {
    const html = mark({
      status: "open",
      number: 12,
      ci: { state: "failure", total: 2 },
    });
    expect(html).toContain(">#12<");
    expect(html).toContain("session-status-badge-label");
    // The square icon-only collapse would clip the number.
    expect(html).not.toContain("session-status-responsive-badge");
  });

  it("never says the number twice when the label already is the number", () => {
    const html = mark({
      status: "open",
      number: 12,
      ci: { state: "success", total: 2 },
    });
    expect(html).toContain(">#12<");
    expect(html).not.toContain(">PR #12<");
  });
});
