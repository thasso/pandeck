import { expect, test } from "vitest";
import { getGoogleSettings } from "./googleSettings.ts";

test("requests Gmail archive access and fails legacy grants closed", () => {
  const settings = getGoogleSettings();

  expect(settings.scopes).toContain(
    "https://www.googleapis.com/auth/gmail.modify",
  );
  expect(settings.scopes).not.toContain(
    "https://www.googleapis.com/auth/gmail.readonly",
  );
  // Settings written before archive support have no grantedScopes field. The
  // normalized empty list must require one explicit reauthorization rather
  // than claiming that a legacy read-only token can archive mail.
  expect(settings.gmailArchiveAuthorized).toBe(false);
});
