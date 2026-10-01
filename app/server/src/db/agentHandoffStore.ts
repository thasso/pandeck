/**
 * SQL facade for the durable agent-handoff queue: the prompts that tell a
 * session how the user resolved something it is waiting on (an approval, a
 * question, a Task choice, a rebase offer, a review handoff) and that had to
 * wait because the session was mid-turn. Rows are per-session FIFO by `id`;
 * `agentHandoffs.ts` owns delivery.
 */
import { getDb } from "./index.ts";

/** The provenance of the turn a handoff becomes; mirrors `PromptOrigin`. */
export type AgentHandoffOrigin =
  { kind: "system"; source: string } | { kind: "human" };

/**
 * The object waiting to hear what became of a handoff — a pull-request card
 * that must stop offering a rebase once the agent has it. Durable, because the
 * card outlives the process that queued the handoff; `kind` selects the
 * registered handler and `token` guards the late write against a newer action
 * on the same object.
 */
export interface AgentHandoffOutcomeRef {
  kind: string;
  id: string;
  token?: string;
}

export interface AgentHandoffRecord {
  id: number;
  sessionId: string;
  origin: AgentHandoffOrigin;
  prompt: string;
  /** Model-only context that never reaches the durable transcript. */
  contextBlock?: string;
  hidden: boolean;
  outcomeRef?: AgentHandoffOutcomeRef;
  attempts: number;
  lastError?: string;
  createdAt: number;
}

export interface AgentHandoffInsert {
  sessionId: string;
  origin: AgentHandoffOrigin;
  prompt: string;
  contextBlock?: string;
  hidden: boolean;
  outcomeRef?: AgentHandoffOutcomeRef;
}

interface Row {
  id: number;
  session_id: string;
  origin_kind: "system" | "human";
  source: string | null;
  prompt: string;
  context_block: string | null;
  hidden: number;
  outcome_ref_json: string | null;
  attempts: number;
  last_error: string | null;
  created_at_ms: number;
}

/** A ref this process cannot read is a ref nobody answers for, never a throw. */
function parseOutcomeRef(json: string): AgentHandoffOutcomeRef | undefined {
  try {
    const parsed = JSON.parse(json) as Partial<AgentHandoffOutcomeRef>;
    return typeof parsed.kind === "string" && typeof parsed.id === "string"
      ? {
          kind: parsed.kind,
          id: parsed.id,
          ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Present only when the stored ref is both there and readable. */
function outcomeRefFields(
  json: string | null,
): { outcomeRef: AgentHandoffOutcomeRef } | Record<string, never> {
  const ref = json ? parseOutcomeRef(json) : undefined;
  return ref ? { outcomeRef: ref } : {};
}

const map = (r: Row): AgentHandoffRecord => ({
  id: r.id,
  sessionId: r.session_id,
  origin:
    r.origin_kind === "human"
      ? { kind: "human" }
      : { kind: "system", source: r.source ?? "" },
  prompt: r.prompt,
  ...(r.context_block ? { contextBlock: r.context_block } : {}),
  hidden: r.hidden === 1,
  ...outcomeRefFields(r.outcome_ref_json),
  attempts: r.attempts,
  ...(r.last_error ? { lastError: r.last_error } : {}),
  createdAt: r.created_at_ms,
});

export const agentHandoffStore = {
  enqueue(input: AgentHandoffInsert): AgentHandoffRecord {
    const now = Date.now();
    const id = getDb()
      .prepare(
        "INSERT INTO agent_handoffs(session_id,origin_kind,source,prompt,context_block,hidden,outcome_ref_json,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.sessionId,
        input.origin.kind,
        input.origin.kind === "system" ? input.origin.source : null,
        input.prompt,
        input.contextBlock ?? null,
        input.hidden ? 1 : 0,
        input.outcomeRef ? JSON.stringify(input.outcomeRef) : null,
        now,
        now,
      ).lastInsertRowid as number;
    return {
      id,
      sessionId: input.sessionId,
      origin: input.origin,
      prompt: input.prompt,
      ...(input.contextBlock ? { contextBlock: input.contextBlock } : {}),
      hidden: input.hidden,
      ...(input.outcomeRef ? { outcomeRef: input.outcomeRef } : {}),
      attempts: 0,
      createdAt: now,
    };
  },

  /** The oldest handoff still owed to this session, if any. */
  next(sessionId: string): AgentHandoffRecord | undefined {
    const row = getDb()
      .prepare(
        "SELECT * FROM agent_handoffs WHERE session_id=? ORDER BY id LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    return row ? map(row) : undefined;
  },

  /** Drop one handoff; `false` means it was already gone. */
  remove(id: number): boolean {
    return (
      (getDb().prepare("DELETE FROM agent_handoffs WHERE id=?").run(id)
        .changes as number) > 0
    );
  },

  /** Record a failed delivery attempt and return the row's new attempt count. */
  recordAttempt(id: number, error: string): number {
    getDb()
      .prepare(
        "UPDATE agent_handoffs SET attempts=attempts+1,last_error=?,updated_at_ms=? WHERE id=?",
      )
      .run(error, Date.now(), id);
    const row = getDb()
      .prepare("SELECT attempts FROM agent_handoffs WHERE id=?")
      .get(id) as { attempts: number } | undefined;
    return row?.attempts ?? 0;
  },

  /** Sessions with at least one owed handoff — one query for the session list. */
  queuedSessionIds(): string[] {
    return (
      getDb()
        .prepare("SELECT DISTINCT session_id FROM agent_handoffs")
        .all() as Array<{ session_id: string }>
    ).map((r) => r.session_id);
  },

  /**
   * Take handoffs older than `ttlMs` off the queue and RETURN them. The rows
   * come back rather than a count because an expired handoff is a terminal
   * outcome like any other: whatever was waiting on it has to be told, and it
   * cannot be told from a number.
   */
  purgeOlderThan(ttlMs: number): AgentHandoffRecord[] {
    const cutoff = Date.now() - ttlMs;
    const expired = (
      getDb()
        .prepare("SELECT * FROM agent_handoffs WHERE created_at_ms < ?")
        .all(cutoff) as unknown as Row[]
    ).map(map);
    if (expired.length > 0)
      getDb()
        .prepare("DELETE FROM agent_handoffs WHERE created_at_ms < ?")
        .run(cutoff);
    return expired;
  },

  /** Every handoff a session still owes, oldest first (tests and diagnostics). */
  listForSession(sessionId: string): AgentHandoffRecord[] {
    return (
      getDb()
        .prepare("SELECT * FROM agent_handoffs WHERE session_id=? ORDER BY id")
        .all(sessionId) as unknown as Row[]
    ).map(map);
  },
};
