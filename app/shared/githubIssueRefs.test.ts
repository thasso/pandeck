import { describe, expect, test } from "vitest";
import {
  normalizeGithubIssueRef,
  normalizeGithubIssueRefs,
  parseGithubIssueRef,
} from "./protocol.ts";

describe("GitHub issue refs", () => {
  test("typed refs and github.com issue/PR URLs share one canonical form", () => {
    expect(normalizeGithubIssueRef(" acme/app#12 ")).toBe("acme/app#12");
    expect(
      normalizeGithubIssueRef("https://github.com/acme/app/issues/12"),
    ).toBe("acme/app#12");
    expect(
      normalizeGithubIssueRef(
        "https://github.com/acme/app/pull/12/files#diff-1",
      ),
    ).toBe("acme/app#12");
    expect(normalizeGithubIssueRef("acme/my.repo_1#7")).toBe(
      "acme/my.repo_1#7",
    );
  });

  test("repository names take GitHub's own alphabet, dot-prefixed ones included", () => {
    expect(normalizeGithubIssueRef("nodejs/.github#1")).toBe(
      "nodejs/.github#1",
    );
    expect(
      normalizeGithubIssueRef("https://github.com/nodejs/.github/issues/1"),
    ).toBe("nodejs/.github#1");
    expect(normalizeGithubIssueRef("acme/_tools#2")).toBe("acme/_tools#2");
    expect(normalizeGithubIssueRef("acme/-x#3")).toBe("acme/-x#3");
    expect(normalizeGithubIssueRef("acme/.#1")).toBeNull();
    expect(normalizeGithubIssueRef("acme/..#1")).toBeNull();
    expect(normalizeGithubIssueRef("-acme/app#1")).toBeNull();
    expect(normalizeGithubIssueRef("cast_labs/app#1")).toBeNull();
  });

  test("anything without an owner, repo and positive number is refused", () => {
    for (const value of [
      "#12",
      "app#12",
      "acme/app#0",
      "acme/app",
      "https://github.com/acme/app/commit/abc",
      "https://gitlab.com/acme/app/issues/1",
      12,
      null,
    ])
      expect(normalizeGithubIssueRef(value)).toBeNull();
  });

  test("lists drop invalid refs and de-duplicate case-insensitively in order", () => {
    expect(
      normalizeGithubIssueRefs([
        "acme/app#2",
        "Acme/App#2",
        "junk",
        "acme/app#1",
      ]),
    ).toEqual(["acme/app#2", "acme/app#1"]);
    expect(normalizeGithubIssueRefs("acme/app#2")).toEqual([]);
  });

  test("parse returns the parts of a canonical ref", () => {
    expect(parseGithubIssueRef("acme/app#12")).toEqual({
      owner: "acme",
      repo: "app",
      number: 12,
    });
    expect(parseGithubIssueRef("nope")).toBeNull();
  });
});
