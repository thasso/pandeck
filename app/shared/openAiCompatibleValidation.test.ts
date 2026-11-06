import { describe, expect, it } from "vitest";
import {
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleApiKeyError,
  openAiCompatibleBaseUrlError,
} from "./openAiCompatibleValidation.ts";

describe("compatible endpoint rules", () => {
  it("accepts exactly the URL forms the gateway previously accepted", () => {
    for (const baseUrl of [
      "http://localhost:8080/v1",
      "https://llm.example.invalid/v1",
      "http://[::1]:8080/v1",
      "https://llm.example.invalid/?",
      "https://llm.example.invalid/#",
      "https://@llm.example.invalid/v1",
    ])
      expect(openAiCompatibleBaseUrlError(baseUrl)).toBeUndefined();
    for (const baseUrl of [
      "",
      "/v1",
      "not a URL",
      "ftp://llm.example.invalid/v1",
      "https://user@llm.example.invalid/v1",
      "https://user:password@llm.example.invalid/v1",
      "https://llm.example.invalid/v1?param=value",
      "https://llm.example.invalid/v1#fragment",
    ])
      expect(openAiCompatibleBaseUrlError(baseUrl)).toBeTruthy();
  });

  it("counts raw UTF-8 bytes, not URL-encoded bytes or characters", () => {
    const prefix = "https://llm.example.invalid/";
    const ascii = prefix + "a".repeat(2048 - prefix.length);
    const unicode = prefix + "a".repeat(2046 - prefix.length) + "é";
    for (const baseUrl of [ascii, unicode]) {
      expect(openAiCompatibleBaseUrlError(baseUrl)).toBeUndefined();
      expect(openAiCompatibleBaseUrlError(baseUrl + "a")).toContain("2048");
    }
  });

  it("accepts key boundaries and rejects non-visible characters without echoing them", () => {
    for (const key of ["!", "~", "!~".repeat(4096)])
      expect(openAiCompatibleApiKeyError(key)).toBeUndefined();
    for (const key of [
      "",
      "a".repeat(8193),
      "fake key",
      "fake\tkey",
      "fake\r\nkey",
      "fake\0key",
      "fake\x7fkey",
      "fake-é-key",
    ]) {
      const error = openAiCompatibleApiKeyError(key);
      expect(error).toContain("visible ASCII");
      if (key) expect(error?.includes(key)).toBe(false);
    }
    expect(openAiCompatibleApiKeyError(undefined)).toBeTruthy();
    expect(openAiCompatibleBaseUrlError(undefined)).toBeTruthy();
  });

  it("leaves normalization to account edits, not gateway control", () => {
    expect(
      normalizeOpenAiCompatibleBaseUrl(" https://llm.example.invalid/v1/// "),
    ).toBe("https://llm.example.invalid/v1");
  });
});
