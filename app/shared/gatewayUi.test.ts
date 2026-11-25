import { describe, expect, test } from "vitest";
import {
  ATLASSIAN_AUTHORIZE_URL,
  decodeGatewayUiAtlassian,
  decodeGatewayUiAtlassianConnectStart,
  decodeGatewayUiClients,
  decodeGatewayUiEnrollmentCode,
  decodeGatewayUiEnrollmentRequest,
  decodeGatewayUiGithub,
  decodeGatewayUiGithubCheck,
  decodeGatewayUiGithubCheckRequest,
  decodeGatewayUiGithubConnectStart,
  decodeGatewayUiMcpToken,
  decodeGatewayUiMe,
  decodeGatewayUiSlack,
  decodeGatewayUiSlackConnectStart,
  GATEWAY_UI_ATLASSIAN_CONNECT_CODES,
  GATEWAY_UI_GITHUB_CONNECT_CODES,
  GATEWAY_UI_SIGNIN_CODES,
  GATEWAY_UI_SLACK_CONNECT_CODES,
  GITHUB_AUTHORIZE_URL,
  isGatewayUiDisplayText,
  isGatewayUiGithubLogin,
  isGatewayUiGithubRepoName,
  SLACK_AUTHORIZE_URL,
} from "./gatewayUi.ts";

/** A value no decoded GitHub answer may carry onward. */
const LEAK_SENTINEL = "fake-t1445-leak-sentinel";

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

  test("decodes an Atlassian status; an unknown problem or kind drops; never a token", () => {
    expect(
      decodeGatewayUiAtlassian({ connected: false, connectWith: "token" }),
    ).toEqual({ connected: false, connectWith: "token" });
    expect(
      decodeGatewayUiAtlassian({
        connected: true,
        kind: "token",
        connectWith: "oauth",
        site: "x.atlassian.net",
        email: "a@x.test",
        displayName: "A",
        token: "never",
        accountId: "acc",
      }),
    ).toEqual({
      connected: true,
      kind: "token",
      connectWith: "oauth",
      site: "x.atlassian.net",
      email: "a@x.test",
      displayName: "A",
    });
    expect(
      decodeGatewayUiAtlassian({
        connected: true,
        kind: "oauth",
        connectWith: "oauth",
        site: "x.atlassian.net",
      }),
    ).toEqual({
      connected: true,
      kind: "oauth",
      connectWith: "oauth",
      site: "x.atlassian.net",
    });
    expect(
      decodeGatewayUiAtlassian({
        connected: false,
        connectWith: "token",
        problem: "vault_locked",
      }),
    ).toEqual({
      connected: false,
      connectWith: "token",
      problem: "vault_locked",
    });
    expect(
      decodeGatewayUiAtlassian({
        connected: false,
        kind: "oauth",
        connectWith: "oauth",
        problem: "rejected",
      }),
    ).toEqual({
      connected: false,
      kind: "oauth",
      connectWith: "oauth",
      problem: "rejected",
    });
    expect(
      decodeGatewayUiAtlassian({
        connected: false,
        kind: "saml",
        connectWith: "token",
        problem: "on_fire",
      }),
    ).toEqual({ connected: false, connectWith: "token" });
    for (const value of [
      undefined,
      null,
      {},
      { connected: false },
      { connected: false, connectWith: "saml" },
      { connected: "yes", connectWith: "token" },
      { connected: true, connectWith: "token", site: 1 },
      { connected: true, connectWith: "token", email: false },
      { connected: true, connectWith: "token", displayName: {} },
    ])
      expect(decodeGatewayUiAtlassian(value)).toBeUndefined();
  });

  test("a connect start decodes only with Atlassian's authorization endpoint", () => {
    expect(ATLASSIAN_AUTHORIZE_URL).toBe(
      "https://auth.atlassian.com/authorize",
    );
    const ok =
      "https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=FAKE_ID&state=FAKE_STATE";
    expect(decodeGatewayUiAtlassianConnectStart({ authorizeUrl: ok })).toEqual({
      authorizeUrl: ok,
    });
    for (const authorizeUrl of [
      "http://auth.atlassian.com/authorize?x=1",
      "https://auth.atlassian.com.evil.test/authorize?x=1",
      "https://auth.atlassian.com/authorize/x?x=1",
      "https://auth.atlassian.com/other?x=1",
      "https://user@auth.atlassian.com/authorize?x=1",
      "https://auth.atlassian.com:8443/authorize?x=1",
      "https://auth.atlassian.com/authorize#x",
      "javascript:alert(1)",
      "/authorize",
      "",
      7,
    ])
      expect(
        decodeGatewayUiAtlassianConnectStart({ authorizeUrl }),
        String(authorizeUrl),
      ).toBeUndefined();
    expect(decodeGatewayUiAtlassianConnectStart(null)).toBeUndefined();
  });

  test("the Atlassian connect codes are fixed", () => {
    expect([...GATEWAY_UI_ATLASSIAN_CONNECT_CODES]).toEqual([
      "rejected",
      "unreachable",
      "site_missing",
      "site_ambiguous",
      "not_configured",
      "vault_locked",
      "vault_unavailable",
      "busy",
      "tools_unavailable",
      "signed_out",
      "expired",
      "failed",
      "denied",
    ]);
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

  test("decodes an enrollment request and drops extra fields (Task-1410)", () => {
    const request = {
      name: "devbox-7",
      kind: "devbox",
      from: "100.64.0.7",
      createdAt: 1_000,
      expiresAt: 601_000,
    };
    expect(
      decodeGatewayUiEnrollmentRequest({
        ...request,
        userCode: "BCDF-GHJK",
        requestId: "secret",
        mcpTokenHash: "a".repeat(64),
      }),
    ).toEqual(request);
    for (const kind of ["laptop", "other"])
      expect(decodeGatewayUiEnrollmentRequest({ ...request, kind })).toEqual({
        ...request,
        kind,
      });
  });

  test("rejects an enrollment request with a missing or malformed field", () => {
    const request = {
      name: "devbox-7",
      kind: "devbox",
      from: "100.64.0.7",
      createdAt: 1_000,
      expiresAt: 601_000,
    };
    for (const value of [
      undefined,
      null,
      "devbox-7",
      [],
      { ...request, name: "" },
      { ...request, name: 7 },
      { ...request, kind: "server" },
      { ...request, kind: undefined },
      { ...request, from: undefined },
      { ...request, from: 1 },
      { ...request, createdAt: "1000" },
      { ...request, createdAt: Number.NaN },
      { ...request, expiresAt: Number.POSITIVE_INFINITY },
      { ...request, expiresAt: undefined },
    ])
      expect(
        decodeGatewayUiEnrollmentRequest(value),
        JSON.stringify(value),
      ).toBeUndefined();
  });

  test("a display text is 1-256 UTF-16 units, not only whitespace, with no control, format or separator character", () => {
    for (const value of ["castLabs", "Équipe ☃ 東京", "x".repeat(256), "😀"])
      expect(isGatewayUiDisplayText(value), value).toBe(true);
    for (const value of [
      "",
      "   ",
      "\t\n",
      "x".repeat(257),
      "a\u0000b",
      "a\u0007b",
      "a\u001b[2Jb",
      "a\u007fb",
      "a\u0085b",
      "a\u00adb",
      "a\u200bb",
      "a\u200eb",
      "a\u202eb",
      "a\u2066b",
      "a\u2028b",
      "a\u2029b",
      "a\ufeffb",
      "a\ud800b",
      "a\ue000b",
      undefined,
      null,
      7,
    ])
      expect(isGatewayUiDisplayText(value), JSON.stringify(value)).toBe(false);
  });

  test("a Slack status needs both booleans; an unknown problem and an undisplayable team name drop", () => {
    expect(
      decodeGatewayUiSlack({
        offered: true,
        connected: true,
        teamName: "Fake Workspace",
        extra: "x",
      }),
    ).toEqual({ offered: true, connected: true, teamName: "Fake Workspace" });
    expect(decodeGatewayUiSlack({ offered: false, connected: false })).toEqual({
      offered: false,
      connected: false,
    });
    for (const problem of [
      "vault_locked",
      "vault_unavailable",
      "invalid",
      "rejected",
    ])
      expect(
        decodeGatewayUiSlack({ offered: true, connected: false, problem }),
      ).toEqual({ offered: true, connected: false, problem });
    expect(
      decodeGatewayUiSlack({
        offered: true,
        connected: true,
        teamName: "Fake\u001b[2JWork\u202espace",
        problem: "exploded",
      }),
    ).toEqual({ offered: true, connected: true });
    expect(
      decodeGatewayUiSlack({ offered: true, connected: true, teamName: 7 }),
    ).toEqual({ offered: true, connected: true });
    for (const value of [
      null,
      [],
      { connected: true },
      { offered: true },
      { offered: "true", connected: false },
      { offered: true, connected: 1 },
    ])
      expect(
        decodeGatewayUiSlack(value),
        JSON.stringify(value),
      ).toBeUndefined();
  });

  test("a Slack connect start decodes only with Slack's authorization endpoint", () => {
    expect(SLACK_AUTHORIZE_URL).toBe("https://slack.com/oauth/v2/authorize");
    const ok =
      "https://slack.com/oauth/v2/authorize?client_id=FAKE_ID&user_scope=search%3Aread&state=FAKE_STATE";
    expect(decodeGatewayUiSlackConnectStart({ authorizeUrl: ok })).toEqual({
      authorizeUrl: ok,
    });
    for (const authorizeUrl of [
      "http://slack.com/oauth/v2/authorize?x=1",
      "https://slack.com.evil.example/oauth/v2/authorize?x=1",
      "https://u:p@slack.com/oauth/v2/authorize?x=1",
      "https://slack.com/oauth/v2/authorize#x",
      "https://slack.com/oauth/v2/authorize/x?x=1",
      "https://slack.com:8443/oauth/v2/authorize?x=1",
      "https://auth.atlassian.com/authorize?x=1",
      "javascript:alert(1)",
      "",
      7,
    ])
      expect(
        decodeGatewayUiSlackConnectStart({ authorizeUrl }),
        String(authorizeUrl),
      ).toBeUndefined();
    expect(decodeGatewayUiSlackConnectStart(null)).toBeUndefined();
  });

  test("the Slack connect codes are fixed", () => {
    expect([...GATEWAY_UI_SLACK_CONNECT_CODES]).toEqual([
      "rejected",
      "unreachable",
      "team_mismatch",
      "not_configured",
      "vault_locked",
      "vault_unavailable",
      "busy",
      "tools_unavailable",
      "signed_out",
      "expired",
      "failed",
      "denied",
    ]);
  });

  test("a GitHub status needs both booleans; an unknown problem, a bad login and any token drop", () => {
    expect(
      decodeGatewayUiGithub({
        offered: true,
        connected: true,
        login: "fake-user",
        token: LEAK_SENTINEL,
        accessToken: LEAK_SENTINEL,
      }),
    ).toEqual({ offered: true, connected: true, login: "fake-user" });
    expect(decodeGatewayUiGithub({ offered: false, connected: false })).toEqual(
      { offered: false, connected: false },
    );
    for (const problem of [
      "vault_locked",
      "vault_unavailable",
      "invalid",
      "rejected",
    ])
      expect(
        decodeGatewayUiGithub({ offered: true, connected: false, problem }),
      ).toEqual({ offered: true, connected: false, problem });
    expect(
      decodeGatewayUiGithub({ offered: true, connected: false, problem: "x" }),
    ).toEqual({ offered: true, connected: false });
    for (const login of ["a".repeat(40), "a b", "a\u0007", "", 7])
      expect(
        decodeGatewayUiGithub({ offered: true, connected: true, login }),
      ).toEqual({ offered: true, connected: true });
    for (const value of [
      null,
      "x",
      { offered: true },
      { connected: true },
      { offered: "true", connected: true },
    ])
      expect(decodeGatewayUiGithub(value)).toBeUndefined();
  });

  test("a GitHub connect start decodes only with GitHub's authorization endpoint", () => {
    expect(GITHUB_AUTHORIZE_URL).toBe(
      "https://github.com/login/oauth/authorize",
    );
    const ok =
      "https://github.com/login/oauth/authorize?client_id=FAKE_ID&redirect_uri=https%3A%2F%2Fgw.example%2Fauth%2Fgithub%2Fcallback&state=FAKE_STATE";
    expect(
      decodeGatewayUiGithubConnectStart({ authorizeUrl: ok, token: "x" }),
    ).toEqual({ authorizeUrl: ok });
    for (const authorizeUrl of [
      "http://github.com/login/oauth/authorize?x=1",
      "https://github.com.evil.example/login/oauth/authorize?x=1",
      "https://u:p@github.com/login/oauth/authorize?x=1",
      "https://github.com/login/oauth/authorize#x",
      "https://github.com/login/oauth/authorize/x?x=1",
      "https://github.com:8443/login/oauth/authorize?x=1",
      "https://api.github.com/login/oauth/authorize?x=1",
      "https://slack.com/oauth/v2/authorize?x=1",
      "not a url",
      7,
    ])
      expect(
        decodeGatewayUiGithubConnectStart({ authorizeUrl }),
        String(authorizeUrl),
      ).toBeUndefined();
    expect(decodeGatewayUiGithubConnectStart(null)).toBeUndefined();
  });

  test("the GitHub connect codes are fixed", () => {
    expect([...GATEWAY_UI_GITHUB_CONNECT_CODES]).toEqual([
      "rejected",
      "unreachable",
      "not_configured",
      "vault_locked",
      "vault_unavailable",
      "busy",
      "signed_out",
      "expired",
      "failed",
      "denied",
    ]);
  });

  test("GitHub names follow the vault's rules", () => {
    for (const login of ["a", "fake-user", "A-1", "a".repeat(39)])
      expect(isGatewayUiGithubLogin(login), login).toBe(true);
    for (const login of ["", "a".repeat(40), "a_b", "a.b", "a/b", " a", 7])
      expect(isGatewayUiGithubLogin(login), String(login)).toBe(false);
    for (const repo of ["r", "a.b", "a_b-c", ".github", "...", "r".repeat(100)])
      expect(isGatewayUiGithubRepoName("owner", repo), repo).toBe(true);
    for (const repo of [".", "..", "", "a/b", "r".repeat(101), "a b", 7])
      expect(isGatewayUiGithubRepoName("owner", repo), String(repo)).toBe(
        false,
      );
    expect(isGatewayUiGithubRepoName("a_b", "repo")).toBe(false);
  });

  test("a GitHub check request is exactly owner and repo", () => {
    expect(
      decodeGatewayUiGithubCheckRequest({ owner: "castlabs", repo: "r" }),
    ).toEqual({ owner: "castlabs", repo: "r" });
    for (const value of [
      null,
      [],
      "castlabs/r",
      { owner: "castlabs" },
      { repo: "r" },
      { owner: "castlabs", repo: "r", access: "write" },
      { owner: "castlabs", repo: "r", token: "x" },
      { owner: "castlabs", repo: "r", userId: "u2" },
      { owner: "castlabs", repo: 7 },
      { owner: "castlabs", repo: ".." },
      { owner: "a".repeat(40), repo: "r" },
      { owner: "castlabs", repo: "a/b" },
    ])
      expect(
        decodeGatewayUiGithubCheckRequest(value),
        JSON.stringify(value),
      ).toBeUndefined();
  });

  test("a GitHub check answer keeps the repository and expiry, never a token", () => {
    expect(
      decodeGatewayUiGithubCheck({
        repository: "castlabs/r",
        expiresAt: 1_800_000_000_000,
        token: LEAK_SENTINEL,
      }),
    ).toEqual({ repository: "castlabs/r", expiresAt: 1_800_000_000_000 });
    for (const value of [
      null,
      { repository: "castlabs/r" },
      { repository: "castlabs/r", expiresAt: "1" },
      { repository: "castlabs/r", expiresAt: Number.NaN },
      { repository: "castlabs/r", expiresAt: 0 },
      { repository: "castlabs", expiresAt: 1 },
      { repository: "castlabs/a/b", expiresAt: 1 },
      { repository: "castlabs/..", expiresAt: 1 },
      { repository: 7, expiresAt: 1 },
    ])
      expect(
        decodeGatewayUiGithubCheck(value),
        JSON.stringify(value),
      ).toBeUndefined();
  });
});
