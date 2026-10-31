/**
 * SQL facade for the durable direct-child registry (`0092`): which sessions a
 * coordinator started through the direct `session_spawn` path, how each one is
 * counted, and the runtime it was spawned on. `peerSpawnRuntimes.ts` counts
 * from it; `heldDirectPeers.ts` re-checks a waiting child against it.
 */
import { getDb } from "./index.ts";
import { touchSessionRows } from "./sessionListChanges.ts";

export interface DirectPeerChild {
  childSessionId: string;
  spawnerSessionId: string;
  costClass: "low" | "counted";
  /** An approved roster row (`profileId`) or an agent definition (`agentName`). */
  source:
    | { kind: "profile"; profileId: string }
    | { kind: "agent"; agentName: string };
  provider: string;
  modelId: string;
  thinkingLevel: string;
  credentialProfileId: string;
  createdAt: number;
}

interface Row {
  child_session_id: string;
  spawner_session_id: string;
  cost_class: "low" | "counted";
  source_kind: "profile" | "agent";
  profile_id: string | null;
  agent_name: string | null;
  provider: string;
  model_id: string;
  thinking_level: string;
  credential_profile_id: string;
  created_at_ms: number;
}

function map(r: Row): DirectPeerChild {
  return {
    childSessionId: r.child_session_id,
    spawnerSessionId: r.spawner_session_id,
    costClass: r.cost_class,
    source:
      r.source_kind === "agent"
        ? { kind: "agent", agentName: r.agent_name ?? "" }
        : { kind: "profile", profileId: r.profile_id ?? "" },
    provider: r.provider,
    modelId: r.model_id,
    thinkingLevel: r.thinking_level,
    credentialProfileId: r.credential_profile_id,
    createdAt: r.created_at_ms,
  };
}

/** A child whose session row is tombstoned holds nothing and is never started. */
const LIVE_CHILD = `NOT EXISTS (
  SELECT 1 FROM session_index s
   WHERE s.id = c.child_session_id AND s.deleted_at_ms IS NOT NULL)`;

export const directPeerChildStore = {
  /** Record a child the direct path just created; a repeat changes nothing. */
  record(child: DirectPeerChild): void {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO direct_peer_children (
           child_session_id, spawner_session_id, cost_class, source_kind,
           profile_id, agent_name, provider, model_id, thinking_level,
           credential_profile_id, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        child.childSessionId,
        child.spawnerSessionId,
        child.costClass,
        child.source.kind,
        child.source.kind === "profile" ? child.source.profileId : null,
        child.source.kind === "agent" ? child.source.agentName : null,
        child.provider,
        child.modelId,
        child.thinkingLevel,
        child.credentialProfileId,
        child.createdAt,
      );
    touchSessionRows([child.childSessionId]);
  },

  get(childSessionId: string): DirectPeerChild | undefined {
    const row = getDb()
      .prepare("SELECT * FROM direct_peer_children WHERE child_session_id = ?")
      .get(childSessionId) as Row | undefined;
    return row ? map(row) : undefined;
  },

  /** Every child of this coordinator whose session was not deleted. */
  childrenOf(spawnerSessionId: string): DirectPeerChild[] {
    return (
      getDb()
        .prepare(
          `SELECT c.* FROM direct_peer_children c
            WHERE c.spawner_session_id = ? AND ${LIVE_CHILD}
            ORDER BY c.created_at_ms, c.child_session_id`,
        )
        .all(spawnerSessionId) as unknown as Row[]
    ).map(map);
  },

  /** The coordinator that started this child directly, if one did. */
  spawnerOf(childSessionId: string): string | undefined {
    const row = getDb()
      .prepare(
        "SELECT spawner_session_id FROM direct_peer_children WHERE child_session_id = ?",
      )
      .get(childSessionId) as { spawner_session_id: string } | undefined;
    return row?.spawner_session_id;
  },

  /**
   * Which of these sessions are recorded children, in one primary-key read:
   * the session list keeps them even before their first message.
   */
  childIdsAmong(sessionIds: Iterable<string>): Set<string> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return new Set();
    const rows = getDb()
      .prepare(
        `SELECT child_session_id FROM direct_peer_children
          WHERE child_session_id IN (${ids.map(() => "?").join(", ")})`,
      )
      .all(...ids) as { child_session_id: string }[];
    return new Set(rows.map((r) => r.child_session_id));
  },

  /** Test seam: forget every recorded child. */
  clearForTests(): void {
    getDb().prepare("DELETE FROM direct_peer_children").run();
  },
};
