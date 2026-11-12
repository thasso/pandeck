import { describe, expect, test } from "vitest";
import {
  decodeGatewayUiAtlassian,
  decodeGatewayUiClients,
  decodeGatewayUiEnrollmentCode,
  decodeGatewayUiMcpToken,
  decodeGatewayUiMe,
  GATEWAY_UI_SIGNIN_CODES,
} from "./gatewayUi.ts";

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

  test("decodes an Atlassian status; an unknown problem drops; never a token", () => {
    expect(decodeGatewayUiAtlassian({ connected: false })).toEqual({
      connected: false,
    });
    expect(
      decodeGatewayUiAtlassian({
        connected: true,
        site: "x.atlassian.net",
        email: "a@x.test",
        displayName: "A",
        token: "never",
        accountId: "acc",
      }),
    ).toEqual({
      connected: true,
      site: "x.atlassian.net",
      email: "a@x.test",
      displayName: "A",
    });
    expect(
      decodeGatewayUiAtlassian({ connected: false, problem: "vault_locked" }),
    ).toEqual({ connected: false, problem: "vault_locked" });
    expect(
      decodeGatewayUiAtlassian({ connected: false, problem: "on_fire" }),
    ).toEqual({ connected: false });
    for (const value of [
      undefined,
      null,
      {},
      { connected: "yes" },
      { connected: true, site: 1 },
      { connected: true, email: false },
      { connected: true, displayName: {} },
    ])
      expect(decodeGatewayUiAtlassian(value)).toBeUndefined();
  });

  test("decodes the client list; one malformed client rejects it", () => {
    const client = { id: "c1", label: "laptop", createdAt: 5, mcpToken: true };
    expect(
      decodeGatewayUiClients({ clients: [{ ...client, extra: 1 }] }),
    ).toEqual({ clients: [client] });
    expect(decodeGatewayUiClients({ clients: [] })).toEqual({ clients: [] });
    for (const bad of [
      { ...client, id: "" },
      { ...client, label: 3 },
      { ...client, createdAt: "today" },
      { ...client, createdAt: Number.NaN },
      { ...client, mcpToken: "yes" },
      { id: "c1", label: "l", createdAt: 5 },
    ])
      expect(decodeGatewayUiClients({ clients: [bad] })).toBeUndefined();
    expect(decodeGatewayUiClients({})).toBeUndefined();
    expect(decodeGatewayUiClients(null)).toBeUndefined();
  });

  test("decodes an enrollment code and an MCP token", () => {
    expect(
      decodeGatewayUiEnrollmentCode({ code: "abc", validForSeconds: 900 }),
    ).toEqual({ code: "abc", validForSeconds: 900 });
    for (const value of [
      { code: "", validForSeconds: 900 },
      { code: "abc" },
      { code: "abc", validForSeconds: 0 },
      { code: "abc", validForSeconds: 1.5 },
      { code: 1, validForSeconds: 900 },
      null,
    ])
      expect(decodeGatewayUiEnrollmentCode(value)).toBeUndefined();
    expect(decodeGatewayUiMcpToken({ token: "pgmcp_x" })).toEqual({
      token: "pgmcp_x",
    });
    for (const value of [{ token: "" }, { token: 5 }, {}, "pgmcp_x"])
      expect(decodeGatewayUiMcpToken(value)).toBeUndefined();
  });
});
