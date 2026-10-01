/**
 * SQL facade for the per-session prompt queue: messages the user queued behind
 * a running turn. Rows stay editable until sent, so order is an explicit
 * `position`, renumbered densely on every move. `promptQueue.ts` owns delivery.
 */
import type {
  PromptQueueState,
  QueuedPrompt,
  QueuedPromptAttachment,
} from "@assistant/shared";
import { getDb, withDbTransaction } from "./index.ts";

interface Row {
  id: string;
  session_id: string;
  position: number;
  text: string;
  attachments_json: string | null;
  command_json: string | null;
  error: string | null;
  created_at_ms: number;
}

/** A stored value this process cannot read is dropped, never a throw. */
function parseJson<T>(json: string | null, valid: (v: unknown) => v is T) {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isAttachments = (v: unknown): v is QueuedPromptAttachment[] =>
  Array.isArray(v) &&
  v.every(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as QueuedPromptAttachment).id === "string" &&
      typeof (a as QueuedPromptAttachment).name === "string",
  );

const isCommand = (v: unknown): v is { name: string; rawArgs: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { name?: unknown }).name === "string" &&
  typeof (v as { rawArgs?: unknown }).rawArgs === "string";

function map(row: Row): QueuedPrompt {
  const attachments = parseJson(row.attachments_json, isAttachments);
  const command = parseJson(row.command_json, isCommand);
  return {
    id: row.id,
    text: row.text,
    ...(attachments?.length ? { attachments } : {}),
    ...(command ? { command } : {}),
    createdAt: row.created_at_ms,
    ...(row.error ? { error: row.error } : {}),
  };
}

export interface QueuedPromptInsert {
  id: string;
  sessionId: string;
  text: string;
  attachments?: QueuedPromptAttachment[];
  command?: { name: string; rawArgs: string };
}

export const promptQueueStore = {
  list(sessionId: string): QueuedPrompt[] {
    return (
      getDb()
        .prepare(
          "SELECT * FROM session_prompt_queue WHERE session_id=? ORDER BY position, created_at_ms",
        )
        .all(sessionId) as unknown as Row[]
    ).map(map);
  },

  get(sessionId: string, id: string): QueuedPrompt | undefined {
    const row = getDb()
      .prepare("SELECT * FROM session_prompt_queue WHERE session_id=? AND id=?")
      .get(sessionId, id) as unknown as Row | undefined;
    return row ? map(row) : undefined;
  },

  state(sessionId: string): PromptQueueState {
    return { items: this.list(sessionId), paused: this.isPaused(sessionId) };
  },

  /** Sessions with anything queued, for the boot drain. */
  sessionIds(): string[] {
    return (
      getDb()
        .prepare("SELECT DISTINCT session_id FROM session_prompt_queue")
        .all() as unknown as { session_id: string }[]
    ).map((r) => r.session_id);
  },

  append(input: QueuedPromptInsert): void {
    const db = getDb();
    const now = Date.now();
    withDbTransaction(() => {
      const last = db
        .prepare(
          "SELECT MAX(position) AS p FROM session_prompt_queue WHERE session_id=?",
        )
        .get(input.sessionId) as unknown as { p: number | null };
      db.prepare(
        "INSERT INTO session_prompt_queue(id,session_id,position,text,attachments_json,command_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        input.sessionId,
        (last.p ?? -1) + 1,
        input.text,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        input.command ? JSON.stringify(input.command) : null,
        now,
        now,
      );
    });
  },

  /**
   * Replace a row's text; an edited command is plain text again. Its note
   * stays: editing a held row is not the user choosing to send it.
   */
  updateText(sessionId: string, id: string, text: string): boolean {
    return (
      getDb()
        .prepare(
          "UPDATE session_prompt_queue SET text=?, command_json=NULL, updated_at_ms=? WHERE session_id=? AND id=?",
        )
        .run(text, Date.now(), sessionId, id).changes > 0
    );
  },

  setError(sessionId: string, id: string, error: string): void {
    getDb()
      .prepare(
        "UPDATE session_prompt_queue SET error=?, updated_at_ms=? WHERE session_id=? AND id=?",
      )
      .run(error.slice(0, 500), Date.now(), sessionId, id);
  },

  clearError(sessionId: string, id: string): void {
    getDb()
      .prepare(
        "UPDATE session_prompt_queue SET error=NULL WHERE session_id=? AND id=?",
      )
      .run(sessionId, id);
  },

  remove(sessionId: string, id: string): boolean {
    return (
      getDb()
        .prepare("DELETE FROM session_prompt_queue WHERE session_id=? AND id=?")
        .run(sessionId, id).changes > 0
    );
  },

  /** Move one row to `toIndex` (clamped) and renumber the session densely. */
  move(sessionId: string, id: string, toIndex: number): boolean {
    const db = getDb();
    return withDbTransaction(() => {
      const ids = (
        db
          .prepare(
            "SELECT id FROM session_prompt_queue WHERE session_id=? ORDER BY position, created_at_ms",
          )
          .all(sessionId) as unknown as { id: string }[]
      ).map((r) => r.id);
      const from = ids.indexOf(id);
      if (from < 0) return false;
      ids.splice(from, 1);
      const to = Math.max(0, Math.min(ids.length, Math.trunc(toIndex)));
      ids.splice(to, 0, id);
      const update = db.prepare(
        "UPDATE session_prompt_queue SET position=? WHERE session_id=? AND id=?",
      );
      ids.forEach((rowId, index) => update.run(index, sessionId, rowId));
      return true;
    });
  },

  /**
   * Drop every row but `keep`, and the pause with them once nothing is left:
   * an empty queue has nothing to hold.
   */
  clear(sessionId: string, keep: ReadonlySet<string> = new Set()): void {
    const db = getDb();
    withDbTransaction(() => {
      const remove = db.prepare(
        "DELETE FROM session_prompt_queue WHERE session_id=? AND id=?",
      );
      for (const row of this.list(sessionId))
        if (!keep.has(row.id)) remove.run(sessionId, row.id);
      if (this.list(sessionId).length === 0)
        db.prepare(
          "DELETE FROM session_prompt_queue_pause WHERE session_id=?",
        ).run(sessionId);
    });
  },

  isPaused(sessionId: string): boolean {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM session_prompt_queue_pause WHERE session_id=?")
        .get(sessionId),
    );
  },

  setPaused(sessionId: string, paused: boolean): void {
    if (paused)
      getDb()
        .prepare(
          "INSERT INTO session_prompt_queue_pause(session_id,paused_at_ms) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
        )
        .run(sessionId, Date.now());
    else
      getDb()
        .prepare("DELETE FROM session_prompt_queue_pause WHERE session_id=?")
        .run(sessionId);
  },
};
