import type {
  ServerMessage,
  SessionListItem,
  StateEventsMessage,
} from "@assistant/shared";

type SessionList = Extract<ServerMessage, { type: "sessionList" }>;

/**
 * The server side of one connection's `sessions` topic, for driving the app
 * through real frames (`docs/session-list.md`): a snapshot answers a
 * subscribe at the current `seq`, and each event batch continues it, every
 * row at a fresh revision. Rows sent without `archived` are live rows; an
 * archived row only ever travels in an `archivedSessions` answer.
 */
export function sessionTopic() {
  let seq = 0;
  let revision = 0;
  return {
    /** The subscribe answer: the live rows, revisioned, and the count. */
    snapshot(
      sessions: SessionListItem[],
      archivedSessionCount = 0,
    ): SessionList {
      return {
        type: "sessionList",
        seq,
        sessions,
        revisions: sessions.map(({ id }) => ({ id, revision: ++revision })),
        archivedSessionCount,
      };
    },
    /** One batch of upserts, newest revision each. */
    upsert(
      ...rows: SessionListItem[]
    ): StateEventsMessage<"sessions", SessionListItem> {
      return {
        type: "stateEvents",
        topic: "sessions",
        seq: ++seq,
        events: rows.map((item) => ({
          kind: "upsert",
          id: item.id,
          revision: ++revision,
          item,
        })),
      };
    },
    /** One batch of deletes. */
    remove(...ids: string[]): StateEventsMessage<"sessions", SessionListItem> {
      return {
        type: "stateEvents",
        topic: "sessions",
        seq: ++seq,
        events: ids.map((id) => ({ kind: "delete", id, revision: ++revision })),
      };
    },
  };
}

/** A one-off subscribe answer at `seq` 0, every row at revision 1. */
export function sessionListMessage(
  sessions: SessionListItem[],
  archivedSessionCount = 0,
): SessionList {
  return {
    type: "sessionList",
    seq: 0,
    sessions,
    revisions: sessions.map(({ id }) => ({ id, revision: 1 })),
    archivedSessionCount,
  };
}
