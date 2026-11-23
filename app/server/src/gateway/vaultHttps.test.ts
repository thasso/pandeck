/**
 * The vault's bounded HTTPS call (`vaultHttps.ts`) for GitHub's two hosts
 * (Task-1444): each connects with its own TLS name and `Host`, `DELETE`
 * reaches the server, and a 3xx is not followed. Atlassian's and Slack's own
 * suites cover their hosts unchanged. Every value is fake.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { startGithubFake, type GithubFake } from "../test/githubFake.ts";
import { vaultCall } from "./vaultHttps.ts";

let github: GithubFake;
beforeAll(async () => {
  github = await startGithubFake();
});
afterEach(() => github.reset());
afterAll(() => github.close());

test("github.com and api.github.com each connect with that TLS name and Host", async () => {
  for (const host of ["github.com", "api.github.com"] as const) {
    github.reset();
    const answer = await vaultCall(
      host,
      { method: "GET", path: "/fake-path", headers: {} },
      github.endpoint,
    );
    assert.deepEqual(answer.kind, "answer");
    const [seen] = github.seen;
    assert.equal(seen?.servername, host);
    assert.equal(seen?.host, host);
  }
});

test("a DELETE reaches api.github.com; a 3xx is not followed", async () => {
  const deleted = await vaultCall(
    "api.github.com",
    {
      method: "DELETE",
      path: "/installation/token",
      headers: {},
    },
    github.endpoint,
  );
  assert.deepEqual(deleted, { kind: "answer", status: 204, body: "" });
  assert.equal(github.on("revoke").length, 1);
  github.script.repo = (_seen, res) => {
    res.raw.writeHead(301, { location: "https://api.github.com/elsewhere" });
    res.raw.end();
  };
  const moved = await vaultCall(
    "api.github.com",
    { method: "GET", path: "/repos/fake-owner/fake-repo", headers: {} },
    github.endpoint,
  );
  assert.deepEqual(moved, { kind: "unreachable", code: "redirect" });
  assert.equal(github.seen.length, 2, "the redirect was not followed");
});
