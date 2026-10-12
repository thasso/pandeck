import { describe, expect, test } from "vitest";
import { normalizeTaskTicket } from "./protocol.ts";

describe("Task tickets", () => {
  test("a bare key, ref or link names its ticket in canonical form", () => {
    expect(normalizeTaskTicket(" abc-12 ")).toEqual({
      source: "jira",
      ref: "ABC-12",
    });
    expect(
      normalizeTaskTicket("https://acme.atlassian.net/browse/abc-12?focus=1"),
    ).toEqual({ source: "jira", ref: "ABC-12" });
    expect(normalizeTaskTicket("acme/app#7")).toEqual({
      source: "github",
      ref: "acme/app#7",
    });
    expect(
      normalizeTaskTicket("https://github.com/acme/app/pull/7/files"),
    ).toEqual({ source: "github", ref: "acme/app#7" });
  });

  test("a ticket object is normalized against its own source", () => {
    expect(normalizeTaskTicket({ source: "jira", ref: "abc-12" })).toEqual({
      source: "jira",
      ref: "ABC-12",
    });
    expect(
      normalizeTaskTicket({
        source: "github",
        ref: "https://github.com/acme/app/issues/3",
      }),
    ).toEqual({ source: "github", ref: "acme/app#3" });
    expect(normalizeTaskTicket({ source: "github", ref: "ABC-12" })).toBeNull();
    expect(
      normalizeTaskTicket({ source: "jira", ref: "acme/app#3" }),
    ).toBeNull();
    expect(normalizeTaskTicket({ source: "linear", ref: "ABC-12" })).toBeNull();
  });

  test("anything else names no ticket", () => {
    for (const value of ["", "#12", "nope", 12, null, undefined, []])
      expect(normalizeTaskTicket(value)).toBeNull();
  });
});
