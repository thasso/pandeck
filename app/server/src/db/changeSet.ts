/**
 * The write half of the state topic kernel (`docs/state-sync.md`, Server
 * contract): one change set per write transaction. A topic's touched rows are
 * stamped with ONE revision drawn from that topic's own persisted sequence,
 * inside the transaction, and every topic the write enlisted is handed its
 * touched ids only after COMMIT. A rollback stamps nothing and tells nobody
 * ({@link touchStateTopic} names the one exception).
 */
import type { BroadcastTopic } from "@assistant/shared";
import { getDb, withDbTransaction } from "./index.ts";
import { nextId } from "./sequences.ts";

/**
 * What a store declares for each topic it writes. The stamp SQL stays in that
 * store; the change set only decides WHEN it runs and with which revision.
 */
export interface StateTopicWrites {
  topic: BroadcastTopic;
  /** The `sequences` row this topic's revisions come from. */
  sequence: string;
  /** Write `revision` onto exactly these rows. Runs inside the transaction. */
  stamp(ids: readonly string[], revision: number): void;
}

export interface ChangeSet {
  /**
   * This transaction's revision for the topic, minted on first use, and
   * enlists the topic: its touched ids (possibly none) reach the sink after
   * commit. Revisions compare only within one topic.
   */
  revision(writes: StateTopicWrites): number;
  /**
   * Stamp `ids` with the topic's transaction revision, now. Touch AFTER
   * writing the rows. No ids: no enlistment and no mint.
   */
  touch(writes: StateTopicWrites, ids: readonly string[]): number | undefined;
}

type StateChangeSink = (topic: BroadcastTopic, ids: readonly string[]) => void;

let sink: StateChangeSink | undefined;

/** The change set whose `fn` is running now, if any; see {@link touchStateTopic}. */
let active: ChangeSet | undefined;

/**
 * The single after-commit hand-off, installed by the hub. With none installed,
 * committed ids are dropped: there is nobody to publish them to. Returns the
 * sink it replaced, so a test recorder can forward to it and put it back.
 */
export function setStateChangeSink(
  next: StateChangeSink | undefined,
): StateChangeSink | undefined {
  const previous = sink;
  sink = next;
  return previous;
}

/**
 * Run `fn` as one write transaction with a change set. Top-level only: joined
 * to a caller's transaction, the hand-off would run before that caller
 * commits, announcing rows a later rollback takes back. Refused before
 * anything is written.
 */
export function withChangeSet<T>(fn: (changes: ChangeSet) => T): T {
  if (getDb().isTransaction)
    throw new Error(
      "A change set must not open inside an open database transaction.",
    );
  const enlisted = new Map<
    BroadcastTopic,
    { revision: number; ids: Set<string> }
  >();
  const enlist = (writes: StateTopicWrites) => {
    let entry = enlisted.get(writes.topic);
    if (!entry) {
      entry = { revision: nextId(writes.sequence), ids: new Set() };
      enlisted.set(writes.topic, entry);
    }
    return entry;
  };
  const changes: ChangeSet = {
    revision: (writes) => enlist(writes).revision,
    touch: (writes, ids) => {
      if (!ids.length) return undefined;
      const entry = enlist(writes);
      for (const id of ids) entry.ids.add(id);
      writes.stamp(ids, entry.revision);
      return entry.revision;
    },
  };
  active = changes;
  let value: T;
  try {
    value = withDbTransaction(() => fn(changes));
  } finally {
    // Cleared before any hand-off: a write the sink triggers opens its own.
    active = undefined;
  }
  for (const [topic, entry] of enlisted) sink?.(topic, [...entry.ids]);
  return value;
}

/**
 * Stamp `ids` from wherever the caller stands, for a store whose stamp may be
 * reached from inside another domain's write:
 *
 * - inside a running {@link withChangeSet}, it joins that change set: the ids
 *   share its revision, are reported after its commit, and vanish with its
 *   rollback;
 * - inside any other open transaction, it stamps there with a fresh revision
 *   and reports AT ONCE. That is the one exception to "reported after commit":
 *   node:sqlite has no commit hook, and that transaction's owner is not a
 *   change set. The flush reads committed state, so after a rollback each id
 *   still publishes once, at its unchanged committed revision;
 * - otherwise it opens its own change set.
 */
export function touchStateTopic(
  writes: StateTopicWrites,
  ids: readonly string[],
): void {
  if (!ids.length) return;
  if (active) {
    active.touch(writes, ids);
    return;
  }
  if (getDb().isTransaction) {
    writes.stamp(ids, nextId(writes.sequence));
    sink?.(writes.topic, [...ids]);
    return;
  }
  withChangeSet((changes) => changes.touch(writes, ids));
}
