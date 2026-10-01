/**
 * Migration regression for the three-way session scope (Task-492): applying
 * `0047_session_scope.sql` to a database that holds real `visibility` rows must
 * carry every row over verbatim — a user session stays the user's, an internal
 * usage stub stays internal — and must leave a schema that refuses a row
 * without a scope and a scope nobody defined.
 *   pnpm --filter @assistant/server test src/db/sessionScopeMigration.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);
const SCOPE_MIGRATION = "0047_session_scope.sql";

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

/**
 * Apply migrations exactly as `runMigrations` does — foreign keys OFF for a
 * table rebuild, each file in its own transaction, the checked
 * `foreign_key_check` afterwards. The pragma dance is part of what is under
 * test: with foreign keys ON, a `RENAME TO … _old` rewrites the child tables'
 * references and leaves `session_links`/`session_usage_totals` pointing at a
 * table this migration then drops.
 */
function applyMigrations(db: DatabaseSync, names: string[]): void {
  for (const name of names) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.exec(sql);
    if (foreignKeysOff) {
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      assert.equal(violations.length, 0, `${name} left foreign-key violations`);
    }
    db.exec("COMMIT");
    if (foreignKeysOff) {
      db.exec("PRAGMA legacy_alter_table = OFF");
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

function migratedToScope(): DatabaseSync {
  const files = migrationFiles();
  const index = files.indexOf(SCOPE_MIGRATION);
  assert.ok(index > 0, "the session-scope migration ships");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));

  // Two rows that predate the scope column, plus the state a metadata refresh
  // must not disturb, so the rebuild is checked on more than the scope value.
  const insert = db.prepare(
    `INSERT INTO session_index (
       id, visibility, purpose, harness, agent_type, title, created_at_ms,
       updated_at_ms, message_count, provider, provider_session_id, model,
       thinking_level, credential_profile_id, mode, archived_at_ms,
       settled_at_ms, last_error_at_ms, last_error_text, read_at_ms,
       fork_origin_json, fork_auto_rename_pending, deleted_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    "user-1",
    "user",
    "chat",
    "pi",
    "developer",
    "A user session",
    10,
    20,
    7,
    "anthropic",
    "provider-1",
    "claude-opus-5",
    "high",
    "cp_1",
    "plan",
    null,
    30,
    40,
    "the run failed",
    25,
    '{"parentSessionFile":"f"}',
    1,
    null,
  );
  insert.run(
    "internal-1",
    "internal",
    "title",
    "claude-sdk",
    "assistant",
    "A naming helper",
    11,
    21,
    1,
    null,
    null,
    null,
    null,
    null,
    "build",
    50,
    null,
    null,
    null,
    0,
    null,
    0,
    null,
  );
  db.prepare(
    "INSERT INTO session_usage_totals (session_id, total_tokens, updated_at_ms) VALUES (?, ?, ?)",
  ).run("internal-1", 1234, 21);

  applyMigrations(db, [SCOPE_MIGRATION]);
  return db;
}

test("0047 carries every session row's classification over unchanged", () => {
  const db = migratedToScope();
  try {
    const rows = db
      .prepare("SELECT * FROM session_index ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((row) => [row.id, row.scope]),
      [
        ["internal-1", "internal"],
        ["user-1", "user"],
      ],
      "visibility values carry over verbatim; nothing is reclassified",
    );

    const user = rows.find((row) => row.id === "user-1")!;
    assert.deepEqual(
      {
        purpose: user.purpose,
        harness: user.harness,
        agentType: user.agent_type,
        title: user.title,
        createdAt: user.created_at_ms,
        updatedAt: user.updated_at_ms,
        messageCount: user.message_count,
        provider: user.provider,
        providerSessionId: user.provider_session_id,
        model: user.model,
        thinkingLevel: user.thinking_level,
        credentialProfileId: user.credential_profile_id,
        mode: user.mode,
        archivedAt: user.archived_at_ms,
        settledAt: user.settled_at_ms,
        lastErrorAt: user.last_error_at_ms,
        lastErrorText: user.last_error_text,
        readAt: user.read_at_ms,
        forkOrigin: user.fork_origin_json,
        forkAutoRenamePending: user.fork_auto_rename_pending,
        deletedAt: user.deleted_at_ms,
      },
      {
        purpose: "chat",
        harness: "pi",
        agentType: "developer",
        title: "A user session",
        createdAt: 10,
        updatedAt: 20,
        messageCount: 7,
        provider: "anthropic",
        providerSessionId: "provider-1",
        model: "claude-opus-5",
        thinkingLevel: "high",
        credentialProfileId: "cp_1",
        mode: "plan",
        archivedAt: null,
        settledAt: 30,
        lastErrorAt: 40,
        lastErrorText: "the run failed",
        readAt: 25,
        forkOrigin: '{"parentSessionFile":"f"}',
        forkAutoRenamePending: 1,
        deletedAt: null,
      },
      "the rebuild preserves every other column of an existing row",
    );

    // The rebuild must not orphan the rows that hang off a session.
    assert.equal(
      (
        db
          .prepare(
            "SELECT total_tokens AS t FROM session_usage_totals WHERE session_id = ?",
          )
          .get("internal-1") as { t: number }
      ).t,
      1234,
    );
    const links = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get("session_links") as { sql: string };
    assert.match(
      links.sql,
      /REFERENCES session_index\(id\)/,
      "child foreign keys still point at session_index, not the dropped rebuild table",
    );
  } finally {
    db.close();
  }
});

test("0047 leaves a schema where a session row cannot exist without a known scope", () => {
  const db = migratedToScope();
  try {
    const insert = db.prepare(
      `INSERT INTO session_index (id, scope, purpose, harness, agent_type, title, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'chat', 'pi', 'assistant', 't', 1, 1)`,
    );
    for (const scope of ["user", "internal", "subagent"]) {
      insert.run(`ok-${scope}`, scope);
    }
    assert.throws(
      () => insert.run("unknown-scope", "everyones"),
      /CHECK constraint failed/,
      "an unknown scope fails closed at the SQL layer",
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO session_index (id, purpose, harness, agent_type, title, created_at_ms, updated_at_ms)
               VALUES ('no-scope', 'chat', 'pi', 'assistant', 't', 1, 1)`,
          )
          .run(),
      /NOT NULL constraint failed/,
      "the column has no DEFAULT: an unscoped insert is refused, not silently a user session",
    );

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_index'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    assert.ok(
      indexes.includes("session_index_scope_updated_idx"),
      "the default projection keeps its (scope, updated_at) index",
    );
    assert.ok(indexes.includes("session_index_provider_session_idx"));
    assert.ok(indexes.includes("session_index_credential_profile_id_idx"));
  } finally {
    db.close();
  }
});
