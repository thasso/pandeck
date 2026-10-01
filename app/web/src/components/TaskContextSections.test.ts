import { describe, expect, it } from "vitest";
import {
  detectLinkSource,
  jiraUrlForKey,
  normalizeJiraKeys,
} from "./TaskContextSections.tsx";

describe("normalizeJiraKeys", () => {
  it("uppercases, trims, validates, and dedupes", () => {
    expect(
      normalizeJiraKeys([" abc-12 ", "ABC-12", "nope", "", undefined, "X2-9"]),
    ).toEqual(["ABC-12", "X2-9"]);
  });
});

describe("jiraUrlForKey", () => {
  it("builds a clickable browse URL from the configured Jira host", () => {
    expect(jiraUrlForKey("ABC-12", [], "acme.atlassian.net")).toBe(
      "https://acme.atlassian.net/browse/ABC-12",
    );
  });

  it("uses the Jira link host when no configured host is available", () => {
    expect(
      jiraUrlForKey("ABC-12", [
        {
          url: "https://jira.example.test/issues/ABC-12",
          type: "related",
          source: "jira",
        },
      ]),
    ).toBe("https://jira.example.test/browse/ABC-12");
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
