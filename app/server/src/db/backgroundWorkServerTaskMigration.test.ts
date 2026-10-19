/**
 * Migration regression for server tasks (0090): the one rebuild of
 * `background_work_items` keeps every row byte for byte, every index, and every
 * constraint it did not deliberately widen, and accepts hostless `server-task`
 * rows of the three kinds the background-wait pieces need.
 *   pnpm --filter @assistant/server test src/db/backgroundWorkServerTaskMigration.test.ts
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
const SERVER_TASK_MIGRATION = "0090_background_work_server_tasks.sql";

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

/** A database migrated up to, but not including, the server-task rebuild. */
function baseline(): { db: DatabaseSync; rest: string[] } {
  const files = migrationFiles();
  const index = files.indexOf(SERVER_TASK_MIGRATION);
  assert.ok(index > 0, "the server-task migration ships");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));
  db.prepare(
    `INSERT INTO session_index (id, scope, purpose, harness, agent_type, title, created_at_ms, updated_at_ms)
     VALUES ('owner', 'user', 'chat', 'pi', 'developer', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO background_hosts (
       id, owner_session_id, backend, epoch_key, boot_epoch, provenance, state,
       empty_grace_ms, settings_generation, created_at_ms, updated_at_ms
     ) VALUES ('host-1', 'owner', 'claude-query', 'epoch-1', 'boot-a',
               'reserved', 'live', 0, 1, 1, 1)`,
  ).run();
  return { db, rest: files.slice(index) };
}

type Row = Record<string, string | number | null>;

/** A valid running hostless `host-process` row; each case overrides it. */
function row(id: string, overrides: Row = {}): Row {
  return {
    id,
    owner_session_id: "owner",
    host_id: null,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run test",
    source_request_id: `source-${id}`,
    provenance: "reserved",
    state: "running",
    lifetime_ms: 60_000,
    deadline_at_ms: 61_000,
    settings_generation: 1,
    boot_epoch: "boot-a",
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    started_at_ms: 1_000,
    ...overrides,
  };
}

function insert(db: DatabaseSync, values: Row): void {
  const columns = Object.keys(values);
  db.prepare(
    `INSERT INTO background_work_items (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((column) => values[column]!));
}

function allRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return (
    db
      .prepare("SELECT * FROM background_work_items ORDER BY id")
      .all() as Array<Record<string, unknown>>
  ).map((entry) => ({ ...entry }));
}

function columnOrder(db: DatabaseSync): string[] {
  return (
    db.prepare("PRAGMA table_info(background_work_items)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function indexes(db: DatabaseSync): Array<Record<string, unknown>> {
  return (
    db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'background_work_items'
           AND sql IS NOT NULL
         ORDER BY name`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((entry) => ({ ...entry }));
}

/** Every invalid shape the baseline schema rejects; 0090 must reject each. */
const PRESERVED_REJECTIONS: Array<[string, Row]> = [
  ["blank label", { label: "  " }],
  ["unknown provenance", { provenance: "guessed" }],
  ["unknown state", { state: "paused" }],
  ["unknown stop state", { stop_state: "maybe", stop_requested_at_ms: 1 }],
  ["negative stop attempts", { stop_attempts: -1 }],
  ["zero lifetime", { lifetime_ms: 0 }],
  ["negative settings generation", { settings_generation: -1 }],
  ["negative revision", { revision: -1 }],
  ["tombstone without deletion time", { is_member: 0 }],
  ["member with deletion time", { deleted_at_ms: 5 }],
  ["terminal without terminal time", { state: "completed" }],
  ["running with terminal time", { terminal_at_ms: 5 }],
  [
    "terminal with an unconfirmed Stop",
    {
      state: "stopped",
      terminal_at_ms: 5,
      stop_state: "unconfirmed",
      stop_requested_at_ms: 2,
    },
  ],
  ["running without start time", { started_at_ms: null }],
  ["Stop without request time", { stop_state: "requested" }],
  ["provider id on a hostless row", { provider_task_id: "task-1" }],
  ["provider type without id", { provider_task_type: "local_bash" }],
  [
    "captured more than existed",
    { evidence_original_bytes: 5, evidence_captured_bytes: 6 },
  ],
  ["truncated without sizes", { evidence_truncated: 1 }],
  ["negative original size", { evidence_original_bytes: -1 }],
  ["negative captured size", { evidence_captured_bytes: -1 }],
  ["non-boolean truncated", { evidence_truncated: 2 }],
  ["non-boolean text", { evidence_text: 2 }],
  ["non-boolean command cut", { command_truncated: 2 }],
  ["unknown intent", { intent: "other" }],
  ["unknown stop origin", { stop_origin: "other" }],
  ["negative event sequence", { last_event_seq: -1 }],
  ["owner without a session", { owner_session_id: "nobody" }],
  ["host that does not exist", { backend: "claude-query", host_id: "nope" }],
];

test("the rebuild keeps every row, column, index and foreign key", () => {
  const { db, rest } = baseline();
  insert(
    db,
    row("a-service", {
      description: "dev server",
      command: "pnpm dev",
      command_truncated: 1,
      intent: "service",
    }),
  );
  insert(
    db,
    row("b-claude", {
      backend: "claude-query",
      host_id: "host-1",
      provider_task_id: "task-9",
      provider_task_type: "local_bash",
      state: "stopped",
      terminal_at_ms: 9_000,
      terminal_reason: "stopped-for-deployment",
      stop_state: "requested",
      stop_requested_at_ms: 8_000,
      stop_attempts: 1,
      stop_origin: "requester",
      drain_reason: "stopped-for-deployment",
      exit_code: 143,
      outcome_summary: "Stopped",
      evidence_artifact_id: "artifact-1",
      evidence_original_bytes: 10,
      evidence_captured_bytes: 8,
      evidence_truncated: 1,
      evidence_text: 1,
      last_event_id: "event-1",
      last_event_seq: 3,
      revision: 17,
    }),
  );
  insert(
    db,
    row("c-tombstone", {
      state: "completed",
      terminal_at_ms: 2_000,
      is_member: 0,
      deleted_at_ms: 3_000,
      revision: 4,
    }),
  );
  const rowsBefore = allRows(db);
  const columnsBefore = columnOrder(db);
  const indexesBefore = indexes(db);

  applyMigrations(db, rest);

  assert.deepEqual(allRows(db), rowsBefore);
  assert.deepEqual(columnOrder(db), columnsBefore);
  assert.deepEqual(indexes(db), indexesBefore);
  assert.equal(indexesBefore.length, 6);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("server tasks are hostless and of the background-wait kinds", () => {
  const { db, rest } = baseline();
  assert.throws(
    () => insert(db, row("before", { backend: "server-task" })),
    /CHECK constraint failed/,
    "the baseline refuses the backend",
  );
  applyMigrations(db, rest);
  for (const kind of ["check-watch", "image-pull", "merge-when-ready"])
    insert(db, row(`server-${kind}`, { backend: "server-task", kind }));

  const rejected: Array<[string, Row]> = [
    ["hostful server task", { backend: "server-task", host_id: "host-1" }],
    ["hostful host process", { host_id: "host-1" }],
    ["hostless Claude query", { backend: "claude-query" }],
    ["unknown kind", { kind: "bogus" }],
    ["unknown backend", { backend: "elsewhere" }],
  ];
  for (const [name, overrides] of rejected)
    assert.throws(
      () => insert(db, row(`rejected-${name}`, overrides)),
      /constraint failed/,
      name,
    );
  assert.throws(
    () =>
      insert(
        db,
        row("duplicate-request", {
          backend: "server-task",
          kind: "check-watch",
          source_request_id: "source-server-check-watch",
        }),
      ),
    /UNIQUE constraint failed/,
  );
});

test("every constraint the rebuild did not widen rejects what it rejected before", () => {
  const before = baseline();
  const after = baseline();
  applyMigrations(after.db, after.rest);
  // The valid base row is accepted on both sides, so each case below fails
  // only on its own override.
  insert(before.db, row("valid"));
  insert(after.db, row("valid"));
  for (const [name, overrides] of PRESERVED_REJECTIONS) {
    const id = `case-${name}`;
    assert.throws(
      () => insert(before.db, row(id, overrides)),
      /constraint failed/,
      `baseline: ${name}`,
    );
    assert.throws(
      () => insert(after.db, row(id, overrides)),
      /constraint failed/,
      `after 0090: ${name}`,
    );
  }
});
