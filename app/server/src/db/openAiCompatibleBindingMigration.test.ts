/**
 * Migration regression for rebinding OpenAI-compatible rows (0099): every
 * session and held peer child running a model of the former single endpoint
 * (pi provider `openai-compatible`) is bound to the account that endpoint
 * migrated to, whatever account carried it before; every other row keeps its
 * binding.
 *   pnpm --filter @assistant/server test src/db/openAiCompatibleBindingMigration.test.ts
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
const REBIND_MIGRATION = "0099_openai_compatible_account_bindings.sql";
const TABLES = ["session_index", "direct_peer_children"] as const;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

/** Apply migrations the way `runMigrations` does, one transaction each. */
function applyMigrations(db: DatabaseSync, names: string[]): void {
  for (const name of names) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    const foreignKeysOff = sql.includes(
      "-- assistant:migration:foreign_keys_off",
    );
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    db.exec(sql);
    db.exec("COMMIT");
    if (foreignKeysOff) {
      db.exec("PRAGMA legacy_alter_table = OFF");
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/**
 * Insert a row with `values`, filling every other required column with a
 * placeholder of its type, so the test follows the schema as it changes.
 */
function insert(
  db: DatabaseSync,
  table: string,
  values: Record<string, string | number | null>,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }>;
  const row: Record<string, string | number | null> = { ...values };
  for (const column of columns) {
    if (column.name in row) continue;
    if (!column.notnull || column.dflt_value !== null) continue;
    row[column.name] = /INT|REAL|NUM/i.test(column.type)
      ? 1
      : `${column.name}-${String(values.id ?? values.child_session_id)}`;
  }
  const names = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
  ).run(...names.map((name) => row[name]!));
}

function bindings(db: DatabaseSync, table: string): Array<[string, unknown]> {
  return (
    db
      .prepare(`SELECT provider, credential_profile_id FROM ${table}`)
      .all() as Array<{ provider: string; credential_profile_id: unknown }>
  )
    .map(
      (row) => [row.provider, row.credential_profile_id] as [string, unknown],
    )
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
}

test("compatible rows bind to the migrated account; every other row keeps its own", () => {
  const files = migrationFiles();
  const index = files.indexOf(REBIND_MIGRATION);
  assert.ok(index > 0, "the rebind migration ships");

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  applyMigrations(db, files.slice(0, index));

  // The columns a CHECK constrains, with values it admits.
  const fixed = {
    session_index: (id: string) => ({ id, scope: "user", harness: "pi" }),
    direct_peer_children: (id: string) => ({
      child_session_id: id,
      cost_class: "low",
      source_kind: "profile",
    }),
  };
  for (const table of TABLES) {
    insert(db, table, {
      ...fixed[table](`${table}-compatible`),
      provider: "openai-compatible",
      credential_profile_id: "cp_0123456789abcdef",
    });
    insert(db, table, {
      ...fixed[table](`${table}-codex`),
      provider: "openai-codex",
      credential_profile_id: "cp_fedcba9876543210",
    });
  }

  for (const table of TABLES)
    insert(db, table, {
      ...fixed[table](`${table}-default`),
      provider: "openai-compatible",
      credential_profile_id: "default",
    });
  // Held peer rows require a pin; only session_index admits a legacy null.
  insert(db, "session_index", {
    ...fixed.session_index("session-null"),
    provider: "openai-compatible",
    credential_profile_id: null,
  });
  applyMigrations(db, [REBIND_MIGRATION]);

  for (const table of TABLES)
    assert.deepEqual(bindings(db, table), [
      ["openai-codex", "cp_fedcba9876543210"],
      ...Array.from({ length: table === "session_index" ? 3 : 2 }, () => [
        "openai-compatible",
        "openai-compatible",
      ]),
    ]);
  db.close();
});
