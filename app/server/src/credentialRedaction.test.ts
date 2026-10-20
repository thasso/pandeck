import assert from "node:assert/strict";
import { test } from "vitest";
import {
  redactCredentials,
  textLooksLikeCredential,
} from "./credentialRedaction.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("masks pasted credentials and keeps the text around them", () => {
  const cases: Array<[string, string]> = [
    [
      'export AWS_ACCESS_KEY_ID="ASIA2UC3BAT77R2S3DGM"',
      'export AWS_ACCESS_KEY_ID="[redacted]"',
    ],
    [`Authorization: Bearer ${JWT}`, "Authorization: Bearer [redacted]"],
    [
      'curl -H "Authorization: Basic dXNlcjpwYXNz" https://x.test',
      'curl -H "Authorization: Basic [redacted]" https://x.test',
    ],
    [`use Bearer ${JWT} for the call`, "use Bearer [redacted] for the call"],
    ["password=shortpw please", "password=[redacted] please"],
    ['{"api_key": "abc"}', '{"api_key": "[redacted]"}'],
  ];
  for (const [input, expected] of cases)
    assert.equal(redactCredentials(input), expected, input);
});

test("leaves ordinary prose alone", () => {
  const prose = "The bearer of this note should check the token count.";
  assert.equal(redactCredentials(prose), prose);
});

test("flags credentials that would be published, not prose about them", () => {
  for (const text of [
    "Subject\n\n-----BEGIN RSA " + "PRIVATE KEY-----",
    `Use ${"ghp_" + "a".repeat(36)} here`,
    `key ${"AKIA" + "ABCDEFGHIJKLMNOP"}`,
    `auth_token: ${'"' + "abcdefghijklmnop"}"`,
    JWT,
    `Authorization: Basic dXNlcjpwYXNz`,
    `Bearer ${"a".repeat(32)}`,
    `bearer ${"b".repeat(32)}`,
    `TOKEN=${"a".repeat(32)}`,
    `export CUSTOM_API_KEY=${"a".repeat(32)}`,
  ])
    assert.equal(textLooksLikeCredential(text), true, text);
  for (const text of [
    "Rotate the token and mask the password field.",
    "The secret: check refuses on a hit.",
    'password = "short"',
    "TOKEN=short",
    "The Authorization header and Bearer scheme are supported.",
    "Bearer authentication is supported.",
    "## Notes for Percy\n\n- The `api_key` setting is read from the env.",
  ])
    assert.equal(textLooksLikeCredential(text), false, text);
});
