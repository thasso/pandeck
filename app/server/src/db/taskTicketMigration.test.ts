/**
 * Migration regression for the single Task ticket (Task-762): applying
 * `0071_task_single_ticket.sql` to Tasks that hold several Jira keys or GitHub
 * refs keeps the first as the ticket and loses none of the rest — they become
 * related links, or a description line when no Jira site is known.
 *   pnpm --filter @assistant/server test src/db/taskTicketMigration.test.ts
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
const TICKET_MIGRATION = "0071_task_single_ticket.sql";

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

/** A database migrated up to, not including, the ticket migration. */
function beforeTicketMigration(): DatabaseSync {
  const files = migrationFiles();
  const index = files.indexOf(TICKET_MIGRATION);
  assert.ok(index > 0, "the ticket migration ships");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, files.slice(0, index));
  return db;
}

function addTask(db: DatabaseSync, id: number, description = ""): void {
  db.prepare(
    `INSERT INTO tasks (id, title, description, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 1, 1)`,
  ).run(id, `Task ${id}`, description);
}

function addEdge(
  db: DatabaseSync,
  taskId: number,
  relation: "jira" | "github" | "link",
  toId: string,
  position: number | null,
  metadata?: unknown,
): void {
  db.prepare(
    `INSERT INTO links (from_type, from_id, relation, to_type, to_id, position,
                        metadata_json, created_at_ms)
     VALUES ('task', ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    String(taskId),
    relation,
    relation === "link" ? "url" : relation,
    toId,
    position,
    metadata === undefined ? null : JSON.stringify(metadata),
  );
}

function edges(db: DatabaseSync, taskId: number): string[] {
  return (
    db
      .prepare(
        `SELECT relation, to_id, metadata_json FROM links
          WHERE from_type = 'task' AND from_id = ?
          ORDER BY relation, to_id`,
      )
      .all(String(taskId)) as Array<{
      relation: string;
      to_id: string;
      metadata_json: string | null;
    }>
  ).map((row) =>
    row.relation === "link"
      ? `link:${row.to_id} ${row.metadata_json}`
      : `${row.relation}:${row.to_id}`,
  );
}

function revision(db: DatabaseSync, taskId: number): number {
  return (
    db.prepare("SELECT revision FROM tasks WHERE id = ?").get(taskId) as {
      revision: number;
    }
  ).revision;
}

test("the first ref stays the ticket and the others become related links", () => {
  const db = beforeTicketMigration();
  addTask(db, 1);
  addEdge(db, 1, "jira", "APP-2", 1);
  addEdge(db, 1, "jira", "APP-1", 0);
  addEdge(db, 1, "github", "acme/app#7", 0);
  // Already linked as a URL: kept once, with its own title.
  addEdge(db, 1, "link", "https://acme.atlassian.net/browse/APP-2", null, {
    kind: "related",
    source: "jira",
    title: "APP-2 — Known",
  });
  addTask(db, 2);
  addEdge(db, 2, "github", "acme/app#1", 0);
  addEdge(db, 2, "github", "acme/tools#3", 1);
  addTask(db, 3);
  addEdge(db, 3, "jira", "OPS-9", 0);
  addTask(db, 4);

  applyMigrations(db, [TICKET_MIGRATION]);

  assert.deepEqual(edges(db, 1), [
    "jira:APP-1",
    'link:https://acme.atlassian.net/browse/APP-2 {"kind":"related","source":"jira","title":"APP-2 — Known"}',
    'link:https://github.com/acme/app/issues/7 {"kind":"related","source":"github","title":"acme/app#7"}',
  ]);
  assert.deepEqual(edges(db, 2), [
    "github:acme/app#1",
    'link:https://github.com/acme/tools/issues/3 {"kind":"related","source":"github","title":"acme/tools#3"}',
  ]);
  assert.deepEqual(edges(db, 3), ["jira:OPS-9"], "a single ref is untouched");
  const bumped = revision(db, 1);
  assert.ok(bumped > 0, "a Task with a ticket takes a new revision");
  assert.equal(revision(db, 2), bumped);
  assert.equal(revision(db, 3), bumped);
  assert.equal(revision(db, 4), 0, "a Task without one keeps its revision");
  db.close();
});

test("without a known Jira site the extra keys are kept in the description", () => {
  const db = beforeTicketMigration();
  addTask(db, 1, "Existing body.");
  addEdge(db, 1, "jira", "APP-1", 0);
  addEdge(db, 1, "jira", "APP-2", 1);
  addEdge(db, 1, "jira", "OPS-3", 2);
  addTask(db, 2);
  addEdge(db, 2, "jira", "APP-5", 0);
  addEdge(db, 2, "jira", "APP-6", 1);

  applyMigrations(db, [TICKET_MIGRATION]);

  assert.deepEqual(edges(db, 1), ["jira:APP-1"]);
  const description = (id: number) =>
    (
      db.prepare("SELECT description FROM tasks WHERE id = ?").get(id) as {
        description: string;
      }
    ).description;
  assert.equal(
    description(1),
    "Existing body.\n\nAlso linked Jira issues: APP-2, OPS-3",
  );
  assert.equal(description(2), "Also linked Jira issues: APP-6");
  db.close();
});
