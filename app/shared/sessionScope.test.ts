import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_SCOPE,
  SESSION_SCOPES,
  sessionScopeOrFailClosed,
} from "./protocol.ts";

describe("sessionScopeOrFailClosed", () => {
  it("passes every scope this build knows through unchanged", () => {
    for (const scope of SESSION_SCOPES)
      expect(sessionScopeOrFailClosed(scope)).toBe(scope);
    expect(DEFAULT_SESSION_SCOPE).toBe("user");
  });

  it("resolves anything else to a scope no default projection shows", () => {
    // The whole point: an unreadable classification must never become the
    // user's. A newer build's scope, a truncated value, a missing column and
    // `null` all land on the hidden side.
    for (const raw of ["", "USER", "user ", "operator", undefined, null])
      expect(sessionScopeOrFailClosed(raw)).toBe("internal");
  });

  it("reads the retired subagent value as internal", () => {
    // The session_index CHECK still accepts it, so a stored row may carry it.
    expect(SESSION_SCOPES).toEqual(["user", "internal"]);
    expect(sessionScopeOrFailClosed("subagent")).toBe("internal");
  });
});
