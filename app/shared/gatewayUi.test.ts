import { describe, expect, test } from "vitest";
import { decodeGatewayUiMe, GATEWAY_UI_SIGNIN_CODES } from "./gatewayUi.ts";

describe("gateway UI wire model", () => {
  test("decodes a well-formed signed-in user and drops extra fields", () => {
    expect(
      decodeGatewayUiMe({
        userId: "u_abc",
        email: "person@example.org",
        label: "Person",
        extra: true,
      }),
    ).toEqual({
      userId: "u_abc",
      email: "person@example.org",
      label: "Person",
    });
  });

  test("rejects a body with a missing or non-string field", () => {
    for (const value of [
      undefined,
      null,
      "u_abc",
      { error: "signed_out" },
      { email: "a@example.org", label: "a" },
      { userId: "", email: "a@example.org", label: "a" },
      { userId: "u_abc", label: "a" },
      { userId: "u_abc", email: 1, label: "a" },
      { userId: "u_abc", email: "a@example.org" },
      { userId: 7, email: "a@example.org", label: "a" },
    ])
      expect(decodeGatewayUiMe(value), JSON.stringify(value)).toBeUndefined();
  });

  test("the sign-in codes are fixed", () => {
    expect([...GATEWAY_UI_SIGNIN_CODES]).toEqual([
      "denied",
      "expired",
      "failed",
      "busy",
    ]);
  });
});
