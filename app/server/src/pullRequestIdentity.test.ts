/**
 * Unit tests for pull-request identity: what counts as the same pull request,
 * and what proves no repository at all. Run:
 *   pnpm --filter @assistant/server test src/pullRequestIdentity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { pullRequestKey, repositoryKeyFromUrl } from "./pullRequestIdentity.ts";

test("a repository is read from its own URL or from one of its pull requests", () => {
  assert.equal(
    repositoryKeyFromUrl("https://github.com/acme/repo"),
    "acme/repo",
  );
  assert.equal(
    repositoryKeyFromUrl("https://github.com/acme/repo/pull/42"),
    "acme/repo",
  );
  assert.equal(
    repositoryKeyFromUrl("https://git.example/acme/repo/pulls/42"),
    "acme/repo",
  );
  // A Forgejo instance under a sub-path, a trailing slash, and `.git`.
  assert.equal(
    repositoryKeyFromUrl("https://git.example/git/acme/repo/"),
    "acme/repo",
  );
  assert.equal(
    repositoryKeyFromUrl("https://github.com/Acme/Repo.git"),
    "acme/repo",
  );
});

// The host is deliberately not part of the identity: one provider kind is one
// configured instance here, while the same repository's links legitimately
// arrive under different roots.
test("the same repository under two roots is one identity", () => {
  assert.equal(
    repositoryKeyFromUrl("http://127.0.0.1:3000/acme/repo/pulls/7"),
    repositoryKeyFromUrl("https://git.example/acme/repo"),
  );
});

test("a URL that proves no repository yields no identity", () => {
  assert.equal(repositoryKeyFromUrl(""), undefined);
  assert.equal(repositoryKeyFromUrl("   "), undefined);
  assert.equal(repositoryKeyFromUrl("https://git.example/acme"), undefined);
  assert.equal(repositoryKeyFromUrl("not-a-url"), undefined);
  assert.equal(
    pullRequestKey("forgejo", "https://git.example/acme", 7),
    undefined,
  );
});

// Two repositories numbering their pull requests from 1 is the ordinary case,
// and the same number in each must never collapse into one key.
test("the key separates repositories and providers", () => {
  assert.equal(
    pullRequestKey("forgejo", "https://git.example/acme/repo/pulls/7", 7),
    "forgejo#acme/repo#7",
  );
  assert.notEqual(
    pullRequestKey("forgejo", "https://git.example/acme/repo", 7),
    pullRequestKey("forgejo", "https://git.example/other/repo", 7),
  );
  assert.notEqual(
    pullRequestKey("forgejo", "https://git.example/acme/repo", 7),
    pullRequestKey("github", "https://github.com/acme/repo", 7),
  );
  assert.notEqual(
    pullRequestKey("forgejo", "https://git.example/acme/repo", 7),
    pullRequestKey("forgejo", "https://git.example/acme/repo", 8),
  );
});
