import {
  isDocumentComment,
  type CommentDocument,
  type PendingChatComment,
} from "./chatCommentPrompt.ts";

/**
 * The browser-local home of every pending comment (`docs/comments.md`). Two
 * kinds of LIST live here:
 *
 * - a composer's OUTBOX, beside its text draft, which the next prompt sends;
 * - a document's TRAY, where comments collect until they are sent to a session.
 *
 * Every comment is its OWN localStorage record, `<list key>#<comment id>`,
 * never an element of one shared array. Two tabs share this storage without a
 * lock, so a list stored as one value loses whichever of two concurrent
 * read-modify-writes lands first. With one record per comment an append or a
 * move writes a key no one else writes, and an edit compares and writes the
 * one record it changes. A list is read by enumerating its records.
 *
 * Both sides of a move may be mounted at once (a document in the side panel
 * beside the session it is sent to), so every write notifies the readers of
 * its list, and a write in another tab arrives through the `storage` event.
 */

const OUTBOX_SUFFIX = ".chatComments";
const TRAY_PREFIX = "assistant.documentComments:";
/** Separates a list key from a comment id; ids never contain it. */
const RECORD_SEPARATOR = "#";

const EMPTY: readonly PendingChatComment[] = Object.freeze([]);
const listeners = new Map<string, Set<() => void>>();
/**
 * Parsed lists keyed by the raw records they came from, so
 * `useSyncExternalStore` sees one stable snapshot per stored state and a change
 * made behind this module's back (another tab, a cleared storage) is read.
 */
const cache = new Map<
  string,
  { signature: string; comments: readonly PendingChatComment[] }
>();

/** A composer's outbox key, derived from its text draft's key. */
export function outboxStorageKey(draftStorageKey: string): string {
  return `${draftStorageKey}${OUTBOX_SUFFIX}`;
}

/** A document tray's key. */
export function trayStorageKey(documentKey: string): string {
  return `${TRAY_PREFIX}${documentKey}`;
}

function recordKey(listKey: string, id: string): string {
  return `${listKey}${RECORD_SEPARATOR}${id}`;
}

interface StoredRecord {
  /** Position in the list: when the comment arrived in it. */
  order: number;
  comment: PendingChatComment;
}

function isSelectorBundle(value: unknown): boolean {
  const bundle = value as { quote?: { exact?: unknown } } | undefined;
  return typeof bundle?.quote?.exact === "string";
}

function isCommentDocument(value: unknown): value is CommentDocument {
  const document = value as Partial<Record<string, unknown>> | undefined;
  if (!document || typeof document !== "object") return false;
  return document.kind === "hostFile" && typeof document.path === "string";
}

function isPendingComment(value: unknown): value is PendingChatComment {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown> & {
    anchor?: Record<string, unknown>;
    transcriptPosition?: Record<string, unknown>;
    lines?: Record<string, unknown>;
  };
  if (typeof item.id !== "string" || typeof item.body !== "string")
    return false;
  if (item.anchor?.kind === "session")
    return (
      typeof item.anchor.sessionId === "string" &&
      typeof item.anchor.entryId === "string" &&
      Number.isInteger(item.anchor.blockIndex) &&
      typeof item.quote === "string" &&
      typeof item.transcriptPosition?.rowCreatedAt === "string" &&
      typeof item.transcriptPosition.rowId === "string" &&
      Number.isInteger(item.transcriptPosition.blockIndex) &&
      isSelectorBundle(item.selectors)
    );
  if (item.anchor?.kind === "document")
    return (
      isCommentDocument(item.anchor.document) &&
      typeof item.createdAt === "string" &&
      (item.quote === undefined || typeof item.quote === "string") &&
      (item.selectors === undefined || isSelectorBundle(item.selectors)) &&
      (item.lines === undefined ||
        (Number.isInteger(item.lines.start) &&
          Number.isInteger(item.lines.end)))
    );
  return false;
}

function parseRecord(raw: string | null): StoredRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredRecord>;
    return typeof value.order === "number" && isPendingComment(value.comment)
      ? { order: value.order, comment: value.comment }
      : null;
  } catch {
    return null;
  }
}

/**
 * The list as it stood before comments were records: one JSON array at the
 * list key itself. Still read, so an outbox saved by an older client keeps its
 * comments; the next write to that list migrates them into records.
 */
function readLegacyList(listKey: string): PendingChatComment[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(listKey) ?? "[]",
    );
    return Array.isArray(value) ? value.filter(isPendingComment) : [];
  } catch {
    return [];
  }
}

let lastOrder = 0;
/** Strictly increasing within this tab, and roughly the time across tabs. */
function nextOrder(): number {
  lastOrder = Math.max(Date.now(), lastOrder + 1);
  return lastOrder;
}

const LOCK_NAME = "assistant.pendingComments";

/**
 * Run `operation` holding the one cross-tab lock every read-then-write of this
 * store takes (the Web Locks API): localStorage itself has no compare-and-set,
 * so an edit checking a record and then writing it, or a move reading a tray
 * and then emptying it, would otherwise let another tab act in between. An
 * append needs no lock — it writes a key no one else writes. Where the API is
 * missing (an old engine, a test DOM) the operation runs unlocked.
 */
function withStoreLock<T>(operation: () => T): Promise<T> {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (!locks?.request) return Promise.resolve().then(operation);
  return locks.request(LOCK_NAME, () => operation());
}

function recordKeysOf(listKey: string): string[] {
  const prefix = `${listKey}${RECORD_SEPARATOR}`;
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith(prefix) &&
        !key.slice(prefix.length).includes(RECORD_SEPARATOR)
      )
        keys.push(key);
    }
  } catch {
    // Storage unavailable: the list is simply empty.
  }
  return keys;
}

function notify(listKey: string): void {
  for (const listener of listeners.get(listKey) ?? []) listener();
}

/** The current list under `listKey`, in arrival order; stable until it changes. */
export function readPendingComments(
  listKey: string | undefined,
): readonly PendingChatComment[] {
  if (!listKey) return EMPTY;
  const raws: [string, string][] = [];
  for (const key of recordKeysOf(listKey)) {
    try {
      raws.push([key, window.localStorage.getItem(key) ?? ""]);
    } catch {
      // Unreadable record: skipped.
    }
  }
  let legacyRaw: string | null = null;
  try {
    legacyRaw = window.localStorage.getItem(listKey);
  } catch {
    legacyRaw = null;
  }
  raws.sort(([a], [b]) => a.localeCompare(b));
  const signature = JSON.stringify([legacyRaw, raws]);
  const cached = cache.get(listKey);
  if (cached && cached.signature === signature) return cached.comments;

  const records = raws
    .map(([, raw]) => parseRecord(raw))
    .filter((record): record is StoredRecord => record !== null);
  const recorded = new Set(records.map((record) => record.comment.id));
  // Legacy comments predate every record, so they lead, in their own order.
  const legacy = readLegacyList(listKey)
    .filter((comment) => !recorded.has(comment.id))
    .map((comment, index) => ({ order: index - 1e15, comment }));
  const comments = [...legacy, ...records]
    .sort(
      (a, b) => a.order - b.order || a.comment.id.localeCompare(b.comment.id),
    )
    .map((record) => record.comment);
  const result = comments.length > 0 ? comments : EMPTY;
  cache.set(listKey, { signature, comments: result });
  return result;
}

/** Turn an older client's array into records before this list is written. */
function migrateLegacyList(listKey: string): boolean {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(listKey);
  } catch {
    return false;
  }
  if (raw === null) return true;
  const legacy = readLegacyList(listKey);
  try {
    legacy.forEach((comment, index) => {
      const key = recordKey(listKey, comment.id);
      if (window.localStorage.getItem(key) === null)
        window.localStorage.setItem(
          key,
          JSON.stringify({ order: index - 1e15, comment }),
        );
    });
    window.localStorage.removeItem(listKey);
    return true;
  } catch {
    return false;
  }
}

function putRecord(listKey: string, record: StoredRecord): boolean {
  if (!migrateLegacyList(listKey)) return false;
  try {
    window.localStorage.setItem(
      recordKey(listKey, record.comment.id),
      JSON.stringify(record),
    );
    return true;
  } catch {
    return false;
  }
}

function dropRecord(listKey: string, id: string): boolean {
  if (!migrateLegacyList(listKey)) return false;
  try {
    window.localStorage.removeItem(recordKey(listKey, id));
    return true;
  } catch {
    return false;
  }
}

/** Append one comment to a list. Returns whether storage accepted it. */
export function addPendingComment(
  listKey: string,
  comment: PendingChatComment,
): boolean {
  const stored = putRecord(listKey, { order: nextOrder(), comment });
  notify(listKey);
  return stored;
}

/** What a conditional edit found when it came to write. */
export type PendingCommentUpdate =
  | { status: "saved" }
  /** Sent or removed meanwhile (another view, another tab). */
  | { status: "missing" }
  /** Changed meanwhile: `current` is what is stored now. */
  | { status: "conflict"; current: PendingChatComment }
  | { status: "failed" };

/**
 * Replace one comment's body, read and compared against storage at the moment
 * of writing: `expectedBody` is the body the editor started from, and anything
 * else stored there now is a conflict rather than something to overwrite.
 */
export function updatePendingComment(
  listKey: string,
  id: string,
  body: string,
  expectedBody?: string,
): Promise<PendingCommentUpdate> {
  return withStoreLock(() => updateUnderLock(listKey, id, body, expectedBody));
}

function updateUnderLock(
  listKey: string,
  id: string,
  body: string,
  expectedBody: string | undefined,
): PendingCommentUpdate {
  const current = readPendingComments(listKey).find(
    (comment) => comment.id === id,
  );
  if (!current) return { status: "missing" };
  if (expectedBody !== undefined && current.body !== expectedBody)
    return { status: "conflict", current };
  let order = nextOrder();
  try {
    order =
      parseRecord(window.localStorage.getItem(recordKey(listKey, id)))?.order ??
      order;
  } catch {
    // Keep the fresh position.
  }
  const stored = putRecord(listKey, {
    order,
    comment: { ...current, body: body.trim() },
  });
  notify(listKey);
  return stored ? { status: "saved" } : { status: "failed" };
}

/** Remove one comment. Resolves to whether storage accepted it. */
export function removePendingComment(
  listKey: string,
  id: string,
): Promise<boolean> {
  return withStoreLock(() => {
    const removed = dropRecord(listKey, id);
    notify(listKey);
    return removed;
  });
}

/**
 * Remove every comment of a list, or just `ids`. Returns whether storage
 * accepted every removal.
 */
export function clearPendingComments(
  listKey: string,
  ids?: readonly string[],
): Promise<boolean> {
  return withStoreLock(() => clearUnderLock(listKey, ids));
}

function clearUnderLock(
  listKey: string,
  ids: readonly string[] | undefined,
): boolean {
  let removed = migrateLegacyList(listKey);
  const keys = ids
    ? ids.map((id) => recordKey(listKey, id))
    : recordKeysOf(listKey);
  for (const key of keys)
    try {
      window.localStorage.removeItem(key);
    } catch {
      removed = false;
    }
  notify(listKey);
  return removed;
}

/** Replace a whole list (tests, seeding). */
export function writePendingComments(
  listKey: string,
  comments: readonly PendingChatComment[],
): boolean {
  let stored = clearUnderLock(listKey, undefined);
  for (const comment of comments)
    stored = putRecord(listKey, { order: nextOrder(), comment }) && stored;
  notify(listKey);
  return stored;
}

export function subscribePendingComments(
  listKey: string | undefined,
  listener: () => void,
): () => void {
  if (!listKey) return () => {};
  const set = listeners.get(listKey) ?? new Set();
  set.add(listener);
  listeners.set(listKey, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(listKey);
  };
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    // A write in another tab: the readers of its list re-read.
    if (event.key === null) {
      for (const key of listeners.keys()) notify(key);
      return;
    }
    const cut = event.key.lastIndexOf(RECORD_SEPARATOR);
    notify(event.key);
    if (cut > 0) notify(event.key.slice(0, cut));
  });

/**
 * Move a tray's comments to the end of a composer's outbox, one record at a
 * time: each comment is written under the outbox's key for it and only then
 * removed from the tray. Records are keyed by comment id, and an id the outbox
 * already holds is left as it is, so a move repeated after an interruption
 * neither duplicates a comment nor overwrites an edit made to it meanwhile. A refused
 * outbox write leaves that comment in the tray; a tray removal refused AFTER
 * its outbox write is reported too, since the comment is then in both.
 */
export function moveTrayToOutbox(
  trayKey: string,
  draftStorageKey: string,
): Promise<{ moved: number } | { error: string }> {
  return withStoreLock(() => moveUnderLock(trayKey, draftStorageKey));
}

function moveUnderLock(
  trayKey: string,
  draftStorageKey: string,
): { moved: number } | { error: string } {
  const moving = readPendingComments(trayKey).filter(isDocumentComment);
  if (moving.length === 0) return { moved: 0 };
  const outboxKey = outboxStorageKey(draftStorageKey);
  let moved = 0;
  let stranded = 0;
  let refused = 0;
  for (const comment of moving) {
    // Already in the outbox (a retry after a refused tray removal): keep that
    // record, which the reader may have edited since, and only finish the move.
    let present = false;
    try {
      present =
        window.localStorage.getItem(recordKey(outboxKey, comment.id)) !== null;
    } catch {
      present = false;
    }
    if (!present && !putRecord(outboxKey, { order: nextOrder(), comment })) {
      refused += 1;
      continue;
    }
    moved += 1;
    if (!dropRecord(trayKey, comment.id)) stranded += 1;
  }
  notify(outboxKey);
  notify(trayKey);
  if (refused > 0)
    return {
      error:
        moved > 0
          ? `Only ${moved} of ${moving.length} comments moved: this browser's storage is full or unavailable. The rest are still here.`
          : "Couldn't move these comments: this browser's storage is full or unavailable.",
    };
  if (stranded > 0)
    return {
      error: `The comments were moved, but ${stranded} could not be removed from this document; remove ${stranded === 1 ? "it" : "them"} here before sending again.`,
    };
  return { moved };
}

export function newPendingCommentId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
