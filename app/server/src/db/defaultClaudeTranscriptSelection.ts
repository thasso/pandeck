/**
 * Read-only selection for the one-time import of Pandeck's own Default Claude
 * transcripts out of the user's home (`claudeSdk/homeTranscriptImport.ts`,
 * `docs/credential-distribution.md`). No store already answers it, and SQL
 * stays in this folder.
 */
import { getDb } from "./index.ts";

/**
 * The provider session ids of every Claude session that ran as the default
 * account: bound to `defaultProfileId`, or bound to nothing (a NULL binding
 * runs as the default). Every scope, archived rows included; tombstoned rows
 * and rows with no provider id are left out. Each id appears once.
 */
export function defaultClaudeProviderSessionIds(
  defaultProfileId: string,
): string[] {
  return (
    getDb()
      .prepare(
        `SELECT DISTINCT provider_session_id
           FROM session_index
          WHERE harness = 'claude-sdk'
            AND deleted_at_ms IS NULL
            AND provider_session_id IS NOT NULL
            AND (credential_profile_id = ? OR credential_profile_id IS NULL)
          ORDER BY provider_session_id`,
      )
      .all(defaultProfileId) as Array<{ provider_session_id: string }>
  ).map((row) => row.provider_session_id);
}
