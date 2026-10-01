import { describe, expect, test } from "vitest";
import { claudeLoginAuthorizationUrl } from "./ClaudeLoginTerminal.tsx";

describe("ClaudeLoginTerminal", () => {
  test("extracts the official authorization URL from streamed CLI output", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=abc";
    expect(
      claudeLoginAuthorizationUrl(
        `Opening browser…\nIf it did not open, visit: ${url}\nPaste code here > `,
      ),
    ).toBe(url);
  });

  test("does not turn unrelated terminal URLs into the authorization action", () => {
    expect(
      claudeLoginAuthorizationUrl("See https://example.com/help"),
    ).toBeUndefined();
  });
});
