/**
 * The home transcript import's selection (`docs/credential-distribution.md`):
 * every non-deleted Claude row that ran as the default account, bound to it or
 * to nothing, in any scope and archived or not.
 *   pnpm --filter @assistant/server exec vitest run src/db/defaultClaudeTranscriptSelection.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultClaudeProviderSessionIds } from "./defaultClaudeTranscriptSelection.ts";
import { getDb } from "./index.ts";
import { sessionStore } from "./sessionStore.ts";

const DEFAULT = "claude-default";

function row(
  id: string,
  fields: {
    scope?: "user" | "internal";
    harness?: "claude-sdk" | "pi";
    providerSessionId?: string;
    credentialProfileId?: string;
  },
): void {
  sessionStore.upsert({
    id,
    scope: fields.scope ?? "user",
    harness: fields.harness ?? "claude-sdk",
    agentType: "developer",
    ...(fields.providerSessionId !== undefined
      ? { providerSessionId: fields.providerSessionId }
      : {}),
    ...(fields.credentialProfileId !== undefined
      ? { credentialProfileId: fields.credentialProfileId }
      : {}),
  });
}

test("selects default and unbound Claude rows in every scope, archived included, once each", () => {
  row("sel-default", {
    providerSessionId: "p-default",
    credentialProfileId: DEFAULT,
  });
  row("sel-null", { providerSessionId: "p-null" });
  row("sel-archived", {
    providerSessionId: "p-archived",
    credentialProfileId: DEFAULT,
  });
  sessionStore.setArchived("sel-archived", true);
  row("sel-internal", { scope: "internal", providerSessionId: "p-internal" });
  // The wire model has no `subagent` scope any more; old rows still do.
  getDb()
    .prepare(
      `INSERT INTO session_index (id, scope, harness, agent_type, title,
         created_at_ms, updated_at_ms, provider_session_id, credential_profile_id)
       VALUES ('sel-subagent', 'subagent', 'claude-sdk', 'developer', 'Sub', 1, 1,
         'p-subagent', ?)`,
    )
    .run(DEFAULT);
  // A second row sharing a provider id (a fork that never diverged) is one id.
  row("sel-dup", { providerSessionId: "p-default" });
  // Not selected:
  row("sel-named", {
    providerSessionId: "p-named",
    credentialProfileId: "claude-work",
  });
  row("sel-deleted", {
    providerSessionId: "p-deleted",
    credentialProfileId: DEFAULT,
  });
  sessionStore.markDeleted("sel-deleted");
  row("sel-no-provider-id", { credentialProfileId: DEFAULT });
  row("sel-pi", { harness: "pi", providerSessionId: "p-pi" });

  assert.deepEqual(defaultClaudeProviderSessionIds(DEFAULT), [
    "p-archived",
    "p-default",
    "p-internal",
    "p-null",
    "p-subagent",
  ]);
});
