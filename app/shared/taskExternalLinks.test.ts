import { describe, expect, it } from "vitest";
import { isForgejoInstanceUrl, isTaskExternalLinkSource } from "./protocol.ts";

describe("isForgejoInstanceUrl", () => {
  it("matches the instance by host and port", () => {
    expect(
      isForgejoInstanceUrl(
        "https://git.example.test/acme/repo/pulls/7",
        "https://git.example.test",
      ),
    ).toBe(true);
    // Protocol is not part of the identity; host:port is.
    expect(
      isForgejoInstanceUrl(
        "http://git.example.test/acme/repo",
        "https://git.example.test",
      ),
    ).toBe(true);
    expect(
      isForgejoInstanceUrl(
        "http://localhost:8080/other",
        "http://localhost:3000",
      ),
    ).toBe(false);
    expect(
      isForgejoInstanceUrl("http://localhost/other", "http://localhost:3000"),
    ).toBe(false);
  });

  it("requires the base URL's path when it has one", () => {
    const base = "https://example.test/git";
    expect(
      isForgejoInstanceUrl("https://example.test/git/acme/repo", base),
    ).toBe(true);
    expect(isForgejoInstanceUrl("https://example.test/git", base)).toBe(true);
    expect(isForgejoInstanceUrl("https://example.test/gitlab/acme", base)).toBe(
      false,
    );
    expect(isForgejoInstanceUrl("https://example.test/wiki", base)).toBe(false);
  });

  it("classifies nothing without a configured instance or with junk input", () => {
    expect(isForgejoInstanceUrl("https://git.example.test/x", "")).toBe(false);
    expect(isForgejoInstanceUrl("https://git.example.test/x", undefined)).toBe(
      false,
    );
    expect(isForgejoInstanceUrl("not a url", "https://git.example.test")).toBe(
      false,
    );
    expect(
      isForgejoInstanceUrl("https://git.example.test/x", "not a url"),
    ).toBe(false);
  });
});

describe("isTaskExternalLinkSource", () => {
  it("accepts every provider and rejects anything else", () => {
    for (const source of ["slack", "jira", "github", "forgejo", "unknown"])
      expect(isTaskExternalLinkSource(source)).toBe(true);
    expect(isTaskExternalLinkSource("gitlab")).toBe(false);
    expect(isTaskExternalLinkSource(undefined)).toBe(false);
    expect(isTaskExternalLinkSource(7)).toBe(false);
  });
});
