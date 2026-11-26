/**
 * The page's copy of the GitHub name rules (`@assistant/shared/gatewayUi`,
 * Task-1445) and the vault's (`gateway/vaultMethods.ts`, Task-1444) agree:
 * `gatewayWeb/` and the page cannot import `gateway/`, so one table runs
 * against both.
 */
import { expect, test } from "vitest";
import {
  decodeGatewayUiGithubCheckRequest,
  isGatewayUiGithubLogin,
  isGatewayUiGithubRepoName,
} from "@assistant/shared/gatewayUi";
import { isGithubLogin, isGithubTokenRequest } from "./gateway/vaultMethods.ts";

const LOGINS: unknown[] = [
  "a",
  "fake-user",
  "A-1",
  "-a",
  "a".repeat(39),
  "a".repeat(40),
  "",
  "a_b",
  "a.b",
  "a/b",
  " a",
  "a\n",
  "ä",
  7,
  null,
];

const REPOS: unknown[] = [
  "r",
  "a.b",
  "a_b-c",
  ".github",
  "...",
  "r".repeat(100),
  "r".repeat(101),
  ".",
  "..",
  "",
  "a/b",
  "a b",
  "a\n",
  7,
];

test("the page's and the vault's GitHub login rules agree", () => {
  for (const login of LOGINS)
    expect(isGatewayUiGithubLogin(login), JSON.stringify(login)).toBe(
      isGithubLogin(login),
    );
});

test("the page's and the vault's repository rules agree", () => {
  for (const owner of LOGINS)
    for (const repo of REPOS) {
      const request = { owner, repo };
      const vault = isGithubTokenRequest(request);
      const name = JSON.stringify(request);
      expect(isGatewayUiGithubRepoName(owner, repo), name).toBe(vault);
      expect(
        decodeGatewayUiGithubCheckRequest(request) !== undefined,
        name,
      ).toBe(vault);
    }
});

test("both refuse a request with any other member", () => {
  for (const extra of ["access", "token", "userId"]) {
    const request = { owner: "castlabs", repo: "r", [extra]: "x" };
    expect(isGithubTokenRequest(request)).toBe(false);
    expect(decodeGatewayUiGithubCheckRequest(request)).toBeUndefined();
  }
});
