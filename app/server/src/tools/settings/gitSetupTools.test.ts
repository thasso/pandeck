import assert from "node:assert/strict";
import { test } from "vitest";
import { githubPatCreationUrl } from "./gitSetupTools.ts";

test("GitHub classic PAT link prefills the full-featured scopes but never claims to select an account", () => {
  const url = new URL(githubPatCreationUrl("  Example-User  "));
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.pathname, "/settings/tokens/new");
  assert.deepEqual(
    [...url.searchParams],
    [
      ["description", "Pandeck"],
      ["scopes", "repo,workflow,read:packages,notifications"],
    ],
  );
  // Classic tokens belong to the currently signed-in account, not a URL target.
  assert.equal(githubPatCreationUrl("Another-User"), url.toString());
  assert.throws(
    () => githubPatCreationUrl("user&contents=write"),
    /valid GitHub username/,
  );
  assert.throws(
    () => githubPatCreationUrl("-invalid"),
    /valid GitHub username/,
  );
});
