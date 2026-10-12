import { describe, expect, it } from "vitest";
import { detectLinkSource } from "./TaskContextSections.tsx";
import { ticketFallbackUrl } from "./TaskTicketProperty.tsx";

describe("ticketFallbackUrl", () => {
  it("builds a Jira browse URL from the configured host", () => {
    expect(
      ticketFallbackUrl(
        { source: "jira", ref: "ABC-12" },
        "acme.atlassian.net",
      ),
    ).toBe("https://acme.atlassian.net/browse/ABC-12");
    expect(
      ticketFallbackUrl(
        { source: "jira", ref: "ABC-12" },
        "https://jira.example.test/",
      ),
    ).toBe("https://jira.example.test/browse/ABC-12");
  });

  it("has no Jira URL without a configured host", () => {
    expect(
      ticketFallbackUrl({ source: "jira", ref: "ABC-12" }),
    ).toBeUndefined();
  });

  it("links a GitHub ref to its issue page", () => {
    expect(ticketFallbackUrl({ source: "github", ref: "acme/app#7" })).toBe(
      "https://github.com/acme/app/issues/7",
    );
  });
});

describe("detectLinkSource", () => {
  it("classifies known hosts", () => {
    expect(detectLinkSource("https://acme.slack.com/archives/C1/p2")).toBe(
      "slack",
    );
    expect(detectLinkSource("https://acme.atlassian.net/browse/ABC-12")).toBe(
      "jira",
    );
    expect(detectLinkSource("https://github.com/acme/repo/pull/5")).toBe(
      "github",
    );
    expect(detectLinkSource("https://example.com/doc")).toBe("unknown");
    expect(detectLinkSource("not a url")).toBe("unknown");
  });

  it("classifies the configured Forgejo instance only", () => {
    const base = "https://git.example.test";
    expect(
      detectLinkSource("https://git.example.test/acme/repo/pulls/7", base),
    ).toBe("forgejo");
    expect(
      detectLinkSource("https://other.example.test/acme/repo/pulls/7", base),
    ).toBe("unknown");
    expect(detectLinkSource("https://git.example.test/acme/repo/pulls/7")).toBe(
      "unknown",
    );
  });

  it("matches the instance by port and base path, not host alone", () => {
    expect(
      detectLinkSource(
        "http://localhost:3000/acme/repo",
        "http://localhost:3000",
      ),
    ).toBe("forgejo");
    expect(
      detectLinkSource("http://localhost:8080/other", "http://localhost:3000"),
    ).toBe("unknown");
    expect(
      detectLinkSource("https://example.test/wiki", "https://example.test/git"),
    ).toBe("unknown");
  });
});
