import assert from "node:assert/strict";
import { test } from "vitest";
import {
  openAiCompatibleApiKeyError,
  openAiCompatibleBaseUrlError,
} from "../../../shared/openAiCompatibleValidation.ts";
import { decodeCompatPair } from "./controlMethods.ts";

test("shared rules preserve compat.set acceptance and its key-free refusal wording", () => {
  const prefix = "https://llm.example.invalid/";
  const urls: unknown[] = [
    undefined,
    12,
    "",
    "http://[::1]:8080/v1",
    "https://llm.example.invalid/v1",
    " https://llm.example.invalid/v1 ",
    "https://llm.example.invalid/?",
    "https://llm.example.invalid/#",
    "https://@llm.example.invalid/",
    "https://user@llm.example.invalid/",
    "https://llm.example.invalid/?q=x",
    "https://llm.example.invalid/#x",
    "ftp://llm.example.invalid/",
    prefix + "a".repeat(2048 - prefix.length),
    prefix + "a".repeat(2049 - prefix.length),
    prefix + "é".repeat(1024),
  ];
  const keys: unknown[] = [
    undefined,
    12,
    "",
    "fake-key",
    "!~".repeat(4096),
    "a".repeat(8193),
    "fake key",
    "fake\tkey",
    "fake\nkey",
    "fake\rkey",
    "fake\x7fkey",
    "fake-é-key",
  ];
  // Independent copy of the pre-extraction rule, not another call to the
  // shared validator: an accidental acceptance change must fail this test.
  const acceptedUrlBefore = (value: unknown): boolean => {
    if (typeof value !== "string" || Buffer.byteLength(value) > 2048)
      return false;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  };
  const acceptedKeyBefore = (value: unknown): boolean =>
    typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value);

  for (const baseUrl of urls) {
    assert.equal(
      !openAiCompatibleBaseUrlError(baseUrl),
      acceptedUrlBefore(baseUrl),
    );
    for (const apiKey of keys) {
      assert.equal(
        !openAiCompatibleApiKeyError(apiKey),
        acceptedKeyBefore(apiKey),
      );
      const payload = { json: { baseUrl, apiKey } };
      if (!acceptedUrlBefore(baseUrl))
        assert.throws(() => decodeCompatPair(payload), {
          message: "Invalid base URL.",
        });
      else if (!acceptedKeyBefore(apiKey))
        assert.throws(() => decodeCompatPair(payload), {
          message: "Invalid API key.",
        });
      else assert.deepEqual(decodeCompatPair(payload), { baseUrl, apiKey });
    }
  }
});
