/**
 * Deleting a session that ran on more than one engine (design 24 in
 * `docs/session-runtime-switching.md`): every engine an earlier binding used
 * deletes its data, and every Claude native session any binding named is swept
 * from every profile, whichever engine is active.
 *
 * Bindings are seeded with SQL: until the cross-harness switch writes them, no
 * production writer starts a second binding.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "vitest";

const { sessionStore } = await import("../db/sessionStore.ts");
const { getDb } = await import("../db/index.ts");
const { harnessRegistry } = await import("./registry.ts");
const { canonicalPiSessionPath, CLAUDE_SDK_STORE_DIR } =
  await import("../sessionStorage.ts");
const { claudeProfileSessionStore } =
  await import("../claudeSdk/profileSessionStore.ts");

let counter = 0;
const freshId = (prefix: string) => `${prefix}-${Date.now()}-${counter++}`;

const PROFILE_OLD = "cp_sweep_old";
const PROFILE_NEW = "cp_sweep_new";

function claudeTranscript(profile: string, nativeId: string): string {
  return join(
    claudeProfileSessionStore(profile).root,
    "projects",
    "sweep-project",
    `${nativeId}.jsonl`,
  );
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}\n");
}

/** Append binding `seq` and make it the active one, mirroring the projection. */
function switchTo(
  id: string,
  seq: number,
  binding: {
    harness: "pi" | "claude-sdk";
    profile: string;
    native: string;
    model: string;
  },
): void {
  const db = getDb();
  db.prepare(
    "UPDATE session_engine_binding SET ended_at_ms = ? WHERE session_id = ? AND ended_at_ms IS NULL",
  ).run(Date.now(), id);
  db.prepare(
    `INSERT INTO session_engine_binding (
       session_id, seq, harness, credential_profile_id, provider, model,
       thinking_level, native_session_id, started_seq, started_run_id,
       created_at_ms, ended_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, 'medium', ?, ?, NULL, ?, NULL)`,
  ).run(
    id,
    seq,
    binding.harness,
    binding.profile,
    binding.harness === "pi" ? "openai-codex" : "claude",
    binding.model,
    binding.native,
    seq * 10,
    Date.now(),
  );
  db.prepare(
    `UPDATE session_index
        SET harness = ?, credential_profile_id = ?, provider = ?, model = ?,
            provider_session_id = ?
      WHERE id = ?`,
  ).run(
    binding.harness,
    binding.profile,
    binding.harness === "pi" ? "openai-codex" : "claude",
    binding.model,
    binding.native,
    id,
  );
}

test("deleting a pi → Claude → Claude session sweeps the pi transcript, the record and both Claude natives", async () => {
  const id = freshId("sweep-pi-claude");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  // A first Claude binding whose native session could not be resumed later,
  // then a fresh one: both native transcripts are this session's.
  switchTo(id, 2, {
    harness: "claude-sdk",
    profile: PROFILE_OLD,
    native: "native-claude-1",
    model: "claude-opus-5-5",
  });
  switchTo(id, 3, {
    harness: "claude-sdk",
    profile: PROFILE_NEW,
    native: "native-claude-2",
    model: "claude-opus-5-5",
  });
  const piFile = canonicalPiSessionPath(id);
  const record = join(CLAUDE_SDK_STORE_DIR, `${id}.json`);
  const first = claudeTranscript(PROFILE_OLD, "native-claude-1");
  const second = claudeTranscript(PROFILE_NEW, "native-claude-2");
  for (const path of [piFile, record, first, second]) touch(path);

  await harnessRegistry.remove({
    harness: "claude-sdk",
    id,
    agentType: "developer",
    file: id,
  });

  assert.equal(existsSync(piFile), false, "the pi transcript is deleted");
  assert.equal(existsSync(record), false, "the Claude record is deleted");
  assert.equal(existsSync(first), false, "the earlier Claude native is swept");
  assert.equal(existsSync(second), false, "the current Claude native is swept");
  assert.ok(sessionStore.getIncludingDeleted(id)?.deletedAt);
});

test("deleting a Claude → pi session removes the Claude record and native as well as the pi transcript", async () => {
  const id = freshId("sweep-claude-pi");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude",
      providerSessionId: "native-claude-3",
      model: "claude-opus-5-5",
      credentialProfileId: PROFILE_OLD,
    }),
  );
  switchTo(id, 2, {
    harness: "pi",
    profile: "cp_pi",
    native: id,
    model: "gpt-5.6-sol",
  });
  const piFile = canonicalPiSessionPath(id);
  const record = join(CLAUDE_SDK_STORE_DIR, `${id}.json`);
  const native = claudeTranscript(PROFILE_OLD, "native-claude-3");
  for (const path of [piFile, record, native]) touch(path);

  await harnessRegistry.remove({
    harness: "pi",
    id,
    agentType: "developer",
    file: piFile,
  });

  assert.equal(existsSync(piFile), false);
  assert.equal(existsSync(record), false);
  assert.equal(existsSync(native), false);
});

test("a session with one binding is removed, and nothing another engine keeps under its id survives", async () => {
  const id = freshId("sweep-single");
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "cp_pi",
    }),
  );
  const piFile = canonicalPiSessionPath(id);
  // Ids are unique across engines, so a Claude record under this id is this
  // session's: a switch's uncommitted target persists one.
  const claudeRecord = join(CLAUDE_SDK_STORE_DIR, `${id}.json`);
  touch(piFile);
  touch(claudeRecord);
  await harnessRegistry.remove({
    harness: "pi",
    id,
    agentType: "developer",
    file: piFile,
  });
  assert.equal(existsSync(piFile), false);
  assert.equal(existsSync(claudeRecord), false);
});
