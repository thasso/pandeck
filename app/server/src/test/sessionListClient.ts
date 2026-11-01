/**
 * A registered connection subscribed to the `sessions` topic, with the list a
 * client would hold: the subscribe snapshot, then every `stateEvents` batch
 * applied in order (`docs/session-list.md`). Tests read what a browser shows
 * instead of the retired `sessions`/`sessionUpdated` messages.
 */
import type {
  ServerMessage,
  SessionListItem,
  StateEvent,
} from "@assistant/shared";
import { Connection } from "../connection.ts";
import { hub } from "../hub.ts";
import { parseServerFrame } from "./serverFrames.ts";

type SessionEvents = Extract<
  ServerMessage,
  { type: "stateEvents"; topic: "sessions" }
>;

export interface SessionListClient {
  connection: Connection;
  /** Every message the connection sent, in order. */
  readonly sent: ServerMessage[];
  /** The rows the client holds now, by id. */
  rows(): Map<string, SessionListItem>;
  row(id: string): SessionListItem | undefined;
  /** The `sessions` event batches received since the last `clear`. */
  events(): SessionEvents[];
  /** The ids of upsert (or delete) events since the last `clear`. */
  upserted(): string[];
  deleted(): string[];
  /** The last archived count a snapshot or signal carried. */
  archivedCount(): number | undefined;
  /** Forget the messages so far; the held rows stay. */
  clear(): void;
  close(): void;
}

/** `subscribe: false` registers without subscribing (the caller does). */
export function sessionListClient(
  options: { subscribe?: boolean } = {},
): SessionListClient {
  const sent: ServerMessage[] = [];
  const held = new Map<string, SessionListItem>();
  let archivedCount: number | undefined;
  let events: SessionEvents[] = [];
  const apply = (message: ServerMessage) => {
    if (message.type === "sessionList") {
      held.clear();
      for (const row of message.sessions) held.set(row.id, row);
      archivedCount = message.archivedSessionCount;
    } else if (message.type === "archivedSessionCount") {
      archivedCount = message.count;
    } else if (message.type === "stateEvents" && message.topic === "sessions") {
      events.push(message);
      for (const event of message.events) {
        if (event.kind === "upsert") held.set(event.id, event.item);
        else held.delete(event.id);
      }
    }
  };
  const socket = {
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => {
      const message = parseServerFrame(frame);
      sent.push(message);
      apply(message);
    },
  } as unknown as ConstructorParameters<typeof Connection>[0];
  const connection = new Connection(socket);
  hub.register(connection);
  if (options.subscribe !== false)
    void connection.handle({ type: "subscribe", topics: ["sessions"] });
  const ids = (kind: "upsert" | "delete") =>
    events.flatMap((batch) =>
      batch.events.filter((e) => e.kind === kind).map((e) => e.id),
    );
  return {
    connection,
    sent,
    rows: () => new Map(held),
    row: (id) => held.get(id),
    events: () => [...events],
    upserted: () => ids("upsert"),
    deleted: () => ids("delete"),
    archivedCount: () => archivedCount,
    clear: () => {
      sent.length = 0;
      events = [];
    },
    close: () => hub.unregister(connection),
  };
}

/** A bare hub viewer subscribed to `sessions` (and `extra` topics). */
export function sessionTopicViewer(
  sent: ServerMessage[],
  extra: readonly string[] = [],
): { send: (message: ServerMessage) => void; wantsTopic: (t: string) => boolean } {
  return {
    send: (message) => sent.push(message),
    wantsTopic: (topic) => topic === "sessions" || extra.includes(topic),
  };
}

/**
 * The latest state of `id` that `messages` carried: a snapshot row, an upsert
 * item, or `null` for a delete; `undefined` when none named it.
 */
export function sessionRowIn(
  messages: readonly ServerMessage[],
  id: string,
): SessionListItem | null | undefined {
  for (const message of [...messages].reverse()) {
    if (message.type === "stateEvents" && message.topic === "sessions") {
      const event = [...message.events].reverse().find((e) => e.id === id);
      if (event) return event.kind === "upsert" ? event.item : null;
    }
    if (message.type === "sessionList")
      return message.sessions.find((row) => row.id === id) ?? null;
  }
  return undefined;
}

/** Every `sessions` upsert/delete event `messages` carried, in order. */
export function sessionEventsIn(
  messages: readonly ServerMessage[],
): StateEvent<SessionListItem>[] {
  return messages.flatMap((message) =>
    message.type === "stateEvents" && message.topic === "sessions"
      ? message.events
      : [],
  );
}
