import { describe, expect, test } from "vitest";
import { confluenceWebUrl } from "./confluenceClient.ts";

const HOST = "example.atlassian.net";

describe("confluenceWebUrl", () => {
  test("resolves a wiki-relative path against /wiki", () => {
    expect(confluenceWebUrl(HOST, "/spaces/ENG/pages/123/Runbook")).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
    );
  });

  test("does not prefix /wiki twice when the path already names it", () => {
    expect(confluenceWebUrl(HOST, "/wiki/spaces/ENG/pages/123/Runbook")).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
    );
  });

  test("passes an absolute URL through and answers null for nothing", () => {
    expect(confluenceWebUrl(HOST, "https://other.test/x")).toBe(
      "https://other.test/x",
    );
    expect(confluenceWebUrl(HOST, undefined)).toBeNull();
    expect(confluenceWebUrl(HOST, "")).toBeNull();
  });
});
