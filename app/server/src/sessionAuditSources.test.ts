/**
 * Where the session audit finds a Claude session's CLI transcript: under its own
 * account's `credential-profiles/<account>/claude/projects` in the data dir (no
 * account means `claude-default`), never under HOME.
 *   pnpm --filter @assistant/server exec vitest run src/sessionAuditSources.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  resolveAuditSource,
  resolveAuditSourceFromDataDir,
} from "./sessionAuditSources.ts";

const LINE = `${JSON.stringify({ type: "assistant", message: { usage: {} } })}\n`;

function transcriptUnder(
  profilesRoot: string,
  account: string,
  providerSessionId: string,
): string {
  const dir = join(profilesRoot, account, "claude", "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${providerSessionId}.jsonl`);
  writeFileSync(path, LINE);
  return path;
}

// A throwaway HOME for the whole file, so the decoys never land in whatever
// HOME the run has; a reader that regressed to HOME would find them here.
const HOME = mkdtempSync(join(tmpdir(), "audit-home-"));
const previousHome = process.env.HOME;
process.env.HOME = HOME;
afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(HOME, { recursive: true, force: true });
});

/** The same transcript where the CLI used to keep it: it must never be found. */
function homeCopy(providerSessionId: string): void {
  const dir = join(HOME, ".claude", "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${providerSessionId}.jsonl`), LINE);
}

function claudeRow(id: string, credentialProfileId?: string): void {
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "claude-sdk",
    agentType: "developer",
    title: id,
    providerSessionId: `${id}-provider`,
    ...(credentialProfileId !== undefined ? { credentialProfileId } : {}),
  });
}

const ROOT = join(DATA_DIR, "credential-profiles");
const CASES = [
  { id: "audit-default", account: "claude-default", bound: "claude-default" },
  { id: "audit-null", account: "claude-default", bound: undefined },
  { id: "audit-named", account: "claude-work", bound: "claude-work" },
] as const;

for (const { id, bound } of CASES) {
  claudeRow(id, bound);
  homeCopy(`${id}-provider`);
}
const expected = new Map(
  CASES.map(({ id, account }) => [
    id,
    transcriptUnder(ROOT, account, `${id}-provider`),
  ]),
);

test.each(CASES)(
  "in process, $id resolves its transcript under its own account ($account)",
  ({ id }) => {
    const source = resolveAuditSource(id);
    assert.deepEqual(source.callTranscript, {
      source: "claude-transcript",
      path: expected.get(id),
    });
  },
);

test.each(CASES)(
  "from the CLI, $id resolves its transcript under the data dir's account ($account)",
  ({ id }) => {
    const source = resolveAuditSourceFromDataDir(id, DATA_DIR);
    assert.deepEqual(source.callTranscript, {
      source: "claude-transcript",
      path: expected.get(id),
    });
  },
);

test("a transcript only under HOME, or under another account, is never found", () => {
  claudeRow("audit-home-only");
  homeCopy("audit-home-only-provider");
  claudeRow("audit-wrong-account", "claude-other");
  transcriptUnder(ROOT, "claude-default", "audit-wrong-account-provider");
  for (const id of ["audit-home-only", "audit-wrong-account"]) {
    assert.equal(resolveAuditSource(id).callTranscript, undefined, id);
    assert.equal(
      resolveAuditSourceFromDataDir(id, DATA_DIR).callTranscript,
      undefined,
      id,
    );
  }
});

test("turning the join off reads no transcript at all", () => {
  assert.equal(
    resolveAuditSource("audit-default", { credentialProfilesRoot: undefined })
      .callTranscript,
    undefined,
  );
  assert.equal(
    resolveAuditSourceFromDataDir("audit-default", DATA_DIR, {
      credentialProfilesRoot: undefined,
    }).callTranscript,
    undefined,
  );
});

test("a data dir from before account bindings reads its sessions as the default's", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "audit-old-schema-"));
  try {
    const db = new DatabaseSync(join(dataDir, "app.sqlite3"));
    db.exec(`
      CREATE TABLE session_index (id TEXT PRIMARY KEY, title TEXT, harness TEXT,
        agent_type TEXT, model TEXT, provider TEXT, provider_session_id TEXT,
        thinking_level TEXT, created_at_ms INTEGER, updated_at_ms INTEGER,
        archived_at_ms INTEGER, deleted_at_ms INTEGER, scope TEXT,
        message_count INTEGER);
      CREATE TABLE session_usage_totals (session_id TEXT);
      CREATE TABLE session_prompt_conditions (session_id TEXT, conditions_json TEXT);
      CREATE TABLE links (from_type TEXT, from_id TEXT, relation TEXT,
        to_type TEXT, to_id TEXT);
      INSERT INTO session_index (id, title, harness, agent_type,
        provider_session_id, created_at_ms, updated_at_ms, scope, message_count)
        VALUES ('old', 'Old', 'claude-sdk', 'developer', 'old-provider', 1, 1,
          'user', 0);
    `);
    db.close();
    const path = transcriptUnder(
      join(dataDir, "credential-profiles"),
      "claude-default",
      "old-provider",
    );
    assert.deepEqual(
      resolveAuditSourceFromDataDir("old", dataDir).callTranscript,
      { source: "claude-transcript", path },
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
