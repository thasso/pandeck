import type {
  ClientSessionSnapshot,
  ClientTimelineEntry,
  TimelineCacheDescriptor,
} from "@assistant/shared/runtime";
import {
  describeTimelineCache,
  timelineMatchesCacheDescriptor,
  timelineRangeIsRenderable,
} from "@assistant/shared/runtime";

const DB_NAME = "assistant-session-timelines";
const DB_VERSION = 1;
const STORE_NAME = "timelines";
const SAVED_AT_INDEX = "savedAt";
const CACHE_LIMIT = 8;

export interface SessionTimelineCacheRecord {
  /** 2 since the descriptor became a RANGE: a v1 prefix record no longer parses. */
  version: 2;
  sessionId: string;
  /** The entries at `[descriptor.startIndex, +entryCount)` of the projection. */
  timeline: ClientTimelineEntry[];
  descriptor: TimelineCacheDescriptor;
  savedAt: number;
}

/**
 * Reconstruct the range the transcript renders from a server snapshot plus the
 * persisted range it was built on. Returns null when local storage is
 * absent/corrupt so the caller can ask for a fresh windowed snapshot instead of
 * splicing a gap into the transcript.
 *
 * A well-formed splice that renders NOTHING counts as corrupt (Task 450): the
 * cached range can be a run of orphan tool results, in which case the transcript
 * would be blank on a session that has entries, and every open would re-save the
 * same record. Only a SPLICE is refused this way — a window is the server's
 * authoritative answer, and refusing it would re-request forever.
 *
 * The result is deliberately PARTIAL for a long session: it is the timeline's
 * gapless suffix from `timelineStart` to the live tail, and older entries arrive
 * through `loadTimelineRange`.
 */
export function expandTimelineSnapshot(
  snapshot: ClientSessionSnapshot,
  cached: SessionTimelineCacheRecord | undefined,
): ClientSessionSnapshot | null {
  const base = snapshot.timelineBase;
  if (!Number.isInteger(snapshot.timelineStart) || snapshot.timelineStart < 0)
    return null;
  if (!base) {
    // A windowed (or complete) snapshot stands on its own.
    return snapshot.timelineCache &&
      !rangeMatchesDescriptor(
        snapshot.timeline,
        snapshot.timelineStart,
        snapshot.timelineCache,
      )
      ? null
      : snapshot;
  }
  if (
    !cached ||
    cached.sessionId !== snapshot.sessionId ||
    base.startIndex + base.entryCount !== snapshot.timelineStart ||
    !sameDescriptor(cached.descriptor, base)
  )
    return null;
  const timeline = [...cached.timeline, ...snapshot.timeline];
  if (
    snapshot.timelineCache &&
    !rangeMatchesDescriptor(timeline, base.startIndex, snapshot.timelineCache)
  )
    return null;
  if (!timelineRangeIsRenderable(timeline)) return null;
  return { ...snapshot, timeline, timelineStart: base.startIndex };
}

export function cacheRecordForSnapshot(
  snapshot: ClientSessionSnapshot,
  savedAt = Date.now(),
): SessionTimelineCacheRecord | null {
  const descriptor =
    snapshot.timelineCache ??
    describeTimelineCache(snapshot.timeline, snapshot.timelineStart);
  if (
    descriptor.startIndex !== snapshot.timelineStart ||
    !descriptorShapeMatchesTimeline(snapshot.timeline, descriptor)
  )
    return null;
  // An UNRENDERABLE range never becomes durable (Task 450). Such a range shows
  // an empty transcript, and persisting it makes that permanent: the anchor
  // matches the server's projection, so every reopen is answered with the tail
  // delta after it and re-saves the same record. Declining to store it means the
  // next open asks for a window, which the server's renderability floor keeps
  // renderable.
  if (!timelineRangeIsRenderable(snapshot.timeline)) return null;
  // expandTimelineSnapshot already verified the descriptor fingerprint before a
  // server snapshot reaches this path; avoid hashing a multi-megabyte timeline a
  // second time on the browser's main thread.
  return {
    version: 2,
    sessionId: snapshot.sessionId,
    timeline: snapshot.timeline,
    descriptor,
    savedAt,
  };
}

export async function loadSessionTimelineCache(
  sessionId: string,
): Promise<SessionTimelineCacheRecord | undefined> {
  const db = await openCacheDb();
  if (!db) return undefined;
  try {
    const record = await requestResult<unknown>(
      db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(sessionId),
    );
    return validRecord(record, sessionId) ? record : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

export async function saveSessionTimelineCache(
  record: SessionTimelineCacheRecord,
): Promise<void> {
  if (!recordShapeValid(record, record.sessionId)) return;
  const db = await openCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    await transactionDone(tx);
    await pruneCache(db);
  } catch {
    // Best-effort acceleration only. Quota/private-mode failures fall back to a
    // full authoritative server snapshot on the next load.
  } finally {
    db.close();
  }
}

export async function deleteSessionTimelineCache(
  sessionId: string,
): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(sessionId);
    await transactionDone(tx);
  } catch {
    // Best effort.
  } finally {
    db.close();
  }
}

function recordShapeValid(
  value: unknown,
  sessionId: string,
): value is SessionTimelineCacheRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SessionTimelineCacheRecord>;
  return (
    record.version === 2 &&
    record.sessionId === sessionId &&
    Array.isArray(record.timeline) &&
    Boolean(record.descriptor) &&
    descriptorShapeMatchesTimeline(record.timeline, record.descriptor!)
  );
}

function validRecord(
  value: unknown,
  sessionId: string,
): value is SessionTimelineCacheRecord {
  return (
    recordShapeValid(value, sessionId) &&
    rangeMatchesDescriptor(
      value.timeline,
      value.descriptor.startIndex,
      value.descriptor,
    )
  );
}

function descriptorShapeMatchesTimeline(
  timeline: readonly ClientTimelineEntry[],
  descriptor: TimelineCacheDescriptor,
): boolean {
  if (
    !Number.isInteger(descriptor.startIndex) ||
    descriptor.startIndex < 0 ||
    !Number.isInteger(descriptor.entryCount) ||
    descriptor.entryCount !== timeline.length
  )
    return false;
  const last = timeline.at(-1);
  return (
    descriptor.lastEntryId === (last?.id ?? null) &&
    descriptor.lastEntrySeq === (last?.seq ?? null) &&
    typeof descriptor.fingerprint === "string"
  );
}

/**
 * Whether `descriptor` describes exactly the entries in `range`, which sit at
 * `startIndex` of the server's projection. The shared matcher takes a FULL
 * timeline, so the range is checked as one starting at zero plus an explicit
 * start-index equality.
 */
function rangeMatchesDescriptor(
  range: readonly ClientTimelineEntry[],
  startIndex: number,
  descriptor: TimelineCacheDescriptor,
): boolean {
  if (descriptor.startIndex !== startIndex) return false;
  return timelineMatchesCacheDescriptor(range, {
    ...descriptor,
    startIndex: 0,
  });
}

function sameDescriptor(
  a: TimelineCacheDescriptor,
  b: TimelineCacheDescriptor,
): boolean {
  return (
    a.projectionVersion === b.projectionVersion &&
    a.startIndex === b.startIndex &&
    a.entryCount === b.entryCount &&
    a.lastEntryId === b.lastEntryId &&
    a.lastEntrySeq === b.lastEntrySeq &&
    a.fingerprint === b.fingerprint
  );
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      if (!store.indexNames.contains(SAVED_AT_INDEX))
        store.createIndex(SAVED_AT_INDEX, SAVED_AT_INDEX);
    };
    request.onsuccess = () => {
      if (settled) request.result.close();
      else {
        settled = true;
        resolve(request.result);
      }
    };
    request.onerror = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
    request.onblocked = () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    };
  });
}

async function pruneCache(db: IDBDatabase): Promise<void> {
  const countTx = db.transaction(STORE_NAME, "readonly");
  const count = await requestResult<number>(
    countTx.objectStore(STORE_NAME).count(),
  );
  let remaining = count - CACHE_LIMIT;
  if (remaining <= 0) return;
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const cursorRequest = store.index(SAVED_AT_INDEX).openKeyCursor();
  await new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || remaining <= 0) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      remaining -= 1;
      cursor.continue();
    };
    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error("timeline cache cursor failed"));
  });
  await transactionDone(tx);
}

function requestResult<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("timeline cache request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("timeline cache transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("timeline cache transaction aborted"));
  });
}
