import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { apiPathSkipsAuth } from "./apiAuthPolicy.ts";

/**
 * The token gate is this app's only access control, so the set of paths that
 * skip it is worth pinning by name. The served-files feature added one
 * (`docs/served-files.md`) and deliberately did NOT add the two beside it; a
 * prefix slip there would expose every file on the host unauthenticated, and no
 * handler test would notice.
 */
describe("api paths that carry their own credential", () => {
  test("a grant document and its subresources skip the checks", () => {
    assert.equal(apiPathSkipsAuth("/api/file-grants/abc123/page.html"), true);
    assert.equal(
      apiPathSkipsAuth("/api/file-grants/abc123/assets/app.js"),
      true,
    );
  });

  test("MINTING a grant does not, and never may", () => {
    // The mint answers with a credential, so it has to be authenticated. It
    // sits one character from the exempt prefix, which is the whole risk.
    assert.equal(apiPathSkipsAuth("/api/file-grants"), false);
    assert.equal(apiPathSkipsAuth("/api/file-grants?path=/etc/passwd"), false);
  });

  test("raw host file bytes are always gated", () => {
    assert.equal(apiPathSkipsAuth("/api/files/tmp/example/report.md"), false);
    assert.equal(
      apiPathSkipsAuth(
        "/api/files/tmp/example/assistant-data/.assistant-token",
      ),
      false,
    );
  });

  test("only health and the OAuth navigations are otherwise exempt", () => {
    assert.equal(apiPathSkipsAuth("/api/health"), true);
    assert.equal(apiPathSkipsAuth("/api/google/oauth/callback"), true);
    assert.equal(apiPathSkipsAuth("/api/slack/oauth/start"), true);
    for (const gated of [
      "/api/session-artifacts/s/page.png",
      "/api/session-attachment/s/1700000000000-abc",
      "/api/knowledge/asset",
      "/api/worktrees/list",
      "/api/google/drive/file/example/preview",
      "/mcp/browser",
      "/api/file-grantsX/abc/page.html",
    ])
      assert.equal(apiPathSkipsAuth(gated), false, gated);
  });
});
