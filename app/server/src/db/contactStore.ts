/**
 * The `contacts` store (migration `0026_contacts.sql`): pure persistence for the
 * general contacts database — a first-class people directory reused across the
 * assistant (time-logging routing is one consumer). Normalization, validation,
 * merge policy, and projection live in `../contacts.ts`; this module only does
 * row I/O. Writes are synchronous (node:sqlite + WAL), durable at call time.
 */
import { getDb } from "./index.ts";

export interface ContactRow {
  id: string;
  name: string;
  roles: string[];
  email: string | null;
  jiraId: string | null;
  slackId: string | null;
  /** Extensible id map for ids we do not model as columns yet (e.g. github). */
  ids: Record<string, string>;
  /** Responsibility area tags used by routing. */
  areas: string[];
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

interface DbRow {
  id: string;
  name: string;
  roles_json: string;
  email: string | null;
  jira_id: string | null;
  slack_id: string | null;
  ids_json: string;
  areas_json: string;
  notes: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStringMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function fromRow(row: DbRow): ContactRow {
  return {
    id: row.id,
    name: row.name,
    roles: parseStringArray(row.roles_json),
    email: row.email,
    jiraId: row.jira_id,
    slackId: row.slack_id,
    ids: parseStringMap(row.ids_json),
    areas: parseStringArray(row.areas_json),
    notes: row.notes,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

/** Insert or fully replace a contact row (caller passes the complete assembled record). */
function put(record: ContactRow): void {
  getDb()
    .prepare(
      `
      INSERT INTO contacts (id, name, roles_json, email, jira_id, slack_id, ids_json, areas_json, notes, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, roles_json=excluded.roles_json, email=excluded.email, jira_id=excluded.jira_id,
        slack_id=excluded.slack_id, ids_json=excluded.ids_json, areas_json=excluded.areas_json, notes=excluded.notes,
        updated_at_ms=excluded.updated_at_ms
    `,
    )
    .run(
      record.id,
      record.name,
      JSON.stringify(record.roles),
      record.email,
      record.jiraId,
      record.slackId,
      JSON.stringify(record.ids),
      JSON.stringify(record.areas),
      record.notes,
      record.createdAt,
      record.updatedAt,
    );
}

function get(id: string): ContactRow | null {
  const row = getDb().prepare("SELECT * FROM contacts WHERE id = ?").get(id) as
    DbRow | undefined;
  return row ? fromRow(row) : null;
}

function listAll(): ContactRow[] {
  const rows = getDb()
    .prepare("SELECT * FROM contacts ORDER BY name, id")
    .all() as unknown as DbRow[];
  return rows.map(fromRow);
}

/** First contact whose normalized email/jiraId/slackId matches (nulls ignored). */
function findByIdentity(identity: {
  email?: string | null;
  jiraId?: string | null;
  slackId?: string | null;
}): ContactRow | null {
  const db = getDb();
  if (identity.email) {
    const row = db
      .prepare("SELECT * FROM contacts WHERE email = ? LIMIT 1")
      .get(identity.email) as DbRow | undefined;
    if (row) return fromRow(row);
  }
  if (identity.jiraId) {
    const row = db
      .prepare("SELECT * FROM contacts WHERE jira_id = ? LIMIT 1")
      .get(identity.jiraId) as DbRow | undefined;
    if (row) return fromRow(row);
  }
  if (identity.slackId) {
    const row = db
      .prepare("SELECT * FROM contacts WHERE slack_id = ? LIMIT 1")
      .get(identity.slackId) as DbRow | undefined;
    if (row) return fromRow(row);
  }
  return null;
}

function remove(id: string): boolean {
  const info = getDb().prepare("DELETE FROM contacts WHERE id = ?").run(id);
  return Number(info.changes) > 0;
}

function resetForTests(): void {
  getDb().prepare("DELETE FROM contacts").run();
}

export const contactStore = {
  put,
  get,
  listAll,
  findByIdentity,
  remove,
  resetForTests,
};
