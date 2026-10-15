import { legacyLocalStorage, type ListableStorage } from "./localStore.ts";

/**
 * The browser-local store for everything that is not tiny: caches, drafts,
 * remembered positions and tree state. IndexedDB underneath, `localStorage`'s
 * synchronous shape on top.
 *
 * Why not `localStorage`: WebKit keeps it in SQLite in WAL mode, and since
 * mid-2025 `SQLiteStorageArea` leaves its cached read statement un-reset after
 * reading a value over 1 KB (which every overwrite of one does). That pins a
 * read transaction, no checkpoint ever completes, and the WAL grows by every
 * byte written until the networking process exits — 41 GB in a week of the
 * Tauri shell. IndexedDB resets its statements and truncates its WAL. See
 * `app/web/docs/loading-states.md` § Browser storage.
 *
 * Reads are synchronous from memory: `loadPersistentStore()` reads every entry
 * once, and `main.tsx` waits for it (bounded) before the first render, so the
 * boot caches still paint in the first frame. Writes land in memory at once and
 * reach IndexedDB on a short coalescing delay, flushed when the page hides.
 * Other windows of the same origin hear every write over a `BroadcastChannel`,
 * so their memory never serves a value this window has replaced.
 *
 * Windows write the same keys, their messages arrive late, and the database
 * applies their commits in no order this store controls. So every write carries
 * a stamp — a clock that never runs behind any stamp this window has seen, then
 * the window's id — and the newest stamp wins everywhere: a commit leaves an
 * entry alone that holds a newer one, a message older than the entry in memory
 * is ignored. A write made before the load answered waits unstamped and is
 * stamped (and broadcast, and committed) once the clock has seen what was
 * stored, unless another window wrote the key meanwhile. A removal is kept as a
 * stamped tombstone so an older write landing
 * later cannot bring the value back; tombstones are dropped after
 * `TOMBSTONE_TTL_MS`.
 *
 * A render that the bounded wait let through before the read answered sees an
 * empty store, and the backend's entries arrive in memory later. Whatever that
 * render wrote would count as newer than the backend and replace it, so a
 * consumer writes only what the user changed until `isLoaded()`, and re-reads
 * (or replays its unsaved changes onto) the stored value on `whenLoaded()`.
 *
 * Without IndexedDB (jsdom, a blocked or broken database) the store is a plain
 * pass-through to `localStorage`, which is also where the keys it took over
 * are migrated from on the first load.
 */

export interface PersistentStore extends ListableStorage {
  /** Read the backend into memory; resolves at the latest after `timeoutMs`. */
  load(timeoutMs: number): Promise<void>;
  /** The backend read has answered, or failed over to `localStorage`. */
  isLoaded(): boolean;
  /** Resolves once `isLoaded()`, however long after `load`'s bound that is. */
  whenLoaded(): Promise<void>;
  /** Start writing every pending change now. */
  flush(): void;
  /**
   * While the page is hidden every write starts at once: the app's own caches
   * flush on the same `pagehide`/hidden events, after this store has heard
   * them, and a write waiting on the coalescing delay would die with the page.
   */
  setHidden(hidden: boolean): void;
}

/** One key's latest write; `value: null` is a removal (a tombstone). */
export interface StoredEntry {
  value: string | null;
  /** Clock time of the write: never behind any stamp its window had seen. */
  at: number;
  /** The writing window: orders two writes with the same `at`. */
  by: string;
}

export interface PersistentStoreBackend {
  /** Every entry, tombstones included. */
  load(): Promise<Map<string, StoredEntry>>;
  /** Store each entry unless the backend holds one it `supersedes`-or-equals. */
  commit(entries: Map<string, StoredEntry>): Promise<void>;
}

/** Whether `next` is a later write than `held`. */
export function supersedes(next: StoredEntry, held: StoredEntry): boolean {
  return next.at !== held.at ? next.at > held.at : next.by > held.by;
}

interface ChannelLike {
  postMessage(message: ChannelMessage): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface ChannelMessage extends StoredEntry {
  key: string;
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredEntry>;
  return (
    (typeof entry.value === "string" || entry.value === null) &&
    typeof entry.at === "number" &&
    typeof entry.by === "string"
  );
}

const DB_NAME = "assistant-persistent-store";
const DB_VERSION = 1;
const STORE_NAME = "entries";
const CHANNEL_NAME = "assistant-persistent-store";
const FLUSH_DELAY_MS = 250;
/** Long past any write still on its way to the database. */
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOAD_TIMEOUT_MS = 300;

/**
 * The keys this store took over from `localStorage`, moved on the first load.
 * A composer outbox (`….chatComments#…`) shares the draft prefix but stays in
 * `localStorage` with the rest of `pendingCommentStore`.
 */
function migratesFromLocalStorage(key: string): boolean {
  if (key.includes(".chatComments")) return false;
  return (
    MIGRATED_KEYS.has(key) ||
    MIGRATED_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

const MIGRATED_KEYS = new Set([
  "assistant.prefs",
  "assistant.transcriptScroll.v1",
  "assistant.listScroll.v1",
  "assistant.dictation.recent",
  "assistant.personal-assistant-panel-draft.v1",
  "assistant.sidebarProjects.collapsed.v1",
  "assistant.worktreeBrowser.expanded.v1",
  "backlog.collapsedProjects",
  "backlog.collapsedTasks",
]);

const MIGRATED_PREFIXES = [
  "assistant.composerDraft.",
  "assistant.agentQuestionDraft.",
  "assistant.worktreeViewed",
];

/** Superseded caches: dropped from `localStorage`, never carried over. */
const DISCARDED_KEYS = [
  "assistant.appShellCache.v1",
  "assistant.sessionPreview.v1",
];

export function createPersistentStore(options: {
  backend: PersistentStoreBackend;
  /** `localStorage`: where migrated keys come from, and the fallback. */
  legacy: ListableStorage;
  channel?: ChannelLike | null;
  schedule?: (run: () => void, ms: number) => void;
  /** This window's id in its stamps; random by default. */
  windowId?: string;
  now?: () => number;
}): PersistentStore {
  const { backend, legacy } = options;
  const channel = options.channel ?? null;
  const schedule =
    options.schedule ?? ((run, ms) => void globalThis.setTimeout(run, ms));
  const windowId = options.windowId ?? Math.random().toString(36).slice(2);
  const now = options.now ?? Date.now;
  /** The newest write known here per key; the store's memory. */
  const entries = new Map<string, StoredEntry>();
  const pending = new Map<string, StoredEntry>();
  /**
   * Written here before the load answered, unstamped: until the clock has seen
   * the stored stamps, any stamp could sort below an entry the write replaces.
   * Stamped and written once the load answers, unless another window wrote the
   * key after them.
   */
  const early = new Map<string, string | null>();
  let clock = 0;
  let flushScheduled = false;
  let hidden = false;
  /** The backend failed: from then on this is plain `localStorage`. */
  let fallback = false;
  /** The backend's entries are in memory. */
  let loaded = false;
  /** `loaded` or `fallback`, and the legacy migration is done. */
  let settled = false;
  let loading: Promise<void> | null = null;

  const scheduleFlush = () => {
    if (hidden) return flush();
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flush, FLUSH_DELAY_MS);
  };

  function flush(): void {
    flushScheduled = false;
    if (fallback || pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();
    backend.commit(batch).catch(() => {
      // Best effort, like the `localStorage` writes this replaces.
    });
  }

  /** Take `entry` for `key` if it is newer than what memory holds. */
  const take = (key: string, entry: StoredEntry): boolean => {
    clock = Math.max(clock, entry.at);
    const held = entries.get(key);
    if (held && !supersedes(entry, held)) return false;
    entries.set(key, entry);
    return true;
  };

  const write = (key: string, value: string | null) => {
    if (!loaded) return void early.set(key, value);
    clock = Math.max(now(), clock + 1);
    const entry: StoredEntry = { value, at: clock, by: windowId };
    entries.set(key, entry);
    pending.set(key, entry);
    channel?.postMessage({ key, ...entry });
    scheduleFlush();
  };

  if (channel)
    channel.onmessage = (event) => {
      const message = event.data as Partial<ChannelMessage> | null;
      if (typeof message?.key !== "string" || !isStoredEntry(message)) return;
      const { key, value, at, by } = message as ChannelMessage;
      // Only a write newer than what memory holds displaces ours: an early
      // write of ours (theirs was heard after it), or one still queued (their
      // commit wins over it in the database anyway). A stale or repeated
      // message changes nothing.
      if (!take(key, { value, at, by })) return;
      early.delete(key);
      pending.delete(key);
    };

  async function loadFromBackend(): Promise<void> {
    let stored: Map<string, StoredEntry>;
    try {
      stored = await backend.load();
    } catch {
      // No database: keep what this page already wrote, then pass through.
      fallback = true;
      try {
        const written = [
          ...[...entries].map(([key, { value }]) => [key, value] as const),
          ...early,
        ];
        for (const [key, value] of written) {
          if (value === null) legacy.removeItem(key);
          else legacy.setItem(key, value);
        }
      } catch {
        // Blocked `localStorage`: those writes live for this page only.
      }
      settled = true;
      return;
    }
    for (const [key, entry] of stored) take(key, entry);
    loaded = true;
    // Now above every stored stamp: what this page wrote early replaces them.
    for (const [key, value] of early) write(key, value);
    early.clear();
    try {
      await migrateFromLegacy();
    } catch {
      // Blocked `localStorage`: nothing to carry over.
    }
    settled = true;
  }

  async function migrateFromLegacy() {
    for (const key of DISCARDED_KEYS) legacy.removeItem(key);
    const legacyKeys = legacy.keys().filter(migratesFromLocalStorage);
    const migrated = new Map<string, StoredEntry>();
    for (const key of legacyKeys) {
      const value = legacy.getItem(key);
      if (value === null || entries.has(key)) continue;
      // Older than any write: another window's entry for the key wins.
      const entry: StoredEntry = { value, at: 0, by: "" };
      entries.set(key, entry);
      migrated.set(key, entry);
    }
    if (migrated.size > 0) {
      try {
        await backend.commit(migrated);
      } catch {
        // Not carried over: leave them where they are and retry next boot.
        return;
      }
    }
    for (const key of legacyKeys) legacy.removeItem(key);
  }

  const valueOf = (key: string) =>
    early.has(key)
      ? (early.get(key) ?? null)
      : (entries.get(key)?.value ?? null);

  return {
    getItem(key) {
      if (fallback) return legacy.getItem(key);
      return valueOf(key);
    },
    setItem(key, value) {
      if (fallback) return legacy.setItem(key, value);
      if (valueOf(key) === value) return;
      write(key, value);
    },
    removeItem(key) {
      if (fallback) return legacy.removeItem(key);
      // Until the load answers, the backend may hold a key memory does not.
      if (loaded && valueOf(key) === null) return;
      write(key, null);
    },
    keys() {
      if (fallback) return legacy.keys();
      const keys = new Set([...entries.keys(), ...early.keys()]);
      return [...keys].filter((key) => valueOf(key) !== null);
    },
    load(timeoutMs) {
      loading ??= loadFromBackend();
      return Promise.race([
        loading,
        new Promise<void>((resolve) => schedule(resolve, timeoutMs)),
      ]);
    },
    isLoaded: () => settled,
    whenLoaded: () => (loading ??= loadFromBackend()),
    flush,
    setHidden(next) {
      hidden = next;
      if (hidden) flush();
    },
  };
}

/* ------------------------------ browser wiring ------------------------------ */

function indexedDbBackend(): PersistentStoreBackend {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME))
          request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => {
        const db = request.result;
        // A newer build upgrading the schema in another window wins.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("persistent store open failed"));
      request.onblocked = () =>
        reject(new Error("persistent store open blocked"));
    }));

  /** Delete the tombstones that are still the expired ones read. */
  async function prune(expired: Map<string, StoredEntry>) {
    const db = await open();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    for (const [key, entry] of expired) {
      const read = store.get(key);
      read.onsuccess = () => {
        const held = read.result as unknown;
        if (isStoredEntry(held) && !supersedes(held, entry)) store.delete(key);
      };
    }
    await transactionDone(tx);
  }

  return {
    async load() {
      const db = await open();
      const store = db
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME);
      const [keys, values] = await Promise.all([
        requestResult<IDBValidKey[]>(store.getAllKeys()),
        requestResult<unknown[]>(store.getAll()),
      ]);
      const entries = new Map<string, StoredEntry>();
      const expired = new Map<string, StoredEntry>();
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      keys.forEach((key, index) => {
        const raw = values[index];
        // A bare string is a value from before stamps: older than any write.
        const entry =
          typeof raw === "string" ? { value: raw, at: 0, by: "" } : raw;
        if (typeof key !== "string" || !isStoredEntry(entry)) return;
        entries.set(key, entry);
        if (entry.value === null && entry.at < cutoff) expired.set(key, entry);
      });
      if (expired.size > 0)
        prune(expired).catch(() => {
          // Tried again on the next load.
        });
      return entries;
    },
    async commit(batch) {
      const db = await open();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      // Read and write in one transaction, so no other commit lands between.
      for (const [key, entry] of batch) {
        const read = store.get(key);
        read.onsuccess = () => {
          const held = read.result as unknown;
          if (isStoredEntry(held) && !supersedes(entry, held)) return;
          store.put(entry, key);
        };
      }
      await transactionDone(tx);
    },
  };
}

function requestResult<T>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () =>
      reject(request.error ?? new Error("persistent store request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error("persistent store transaction failed"));
    tx.onabort = () =>
      reject(tx.error ?? new Error("persistent store transaction aborted"));
  });
}

let shared: PersistentStore | null = null;

/** The app's one persistent store. */
export function persistentStore(): PersistentStore {
  if (shared) return shared;
  const legacy = legacyLocalStorage();
  if (typeof indexedDB === "undefined") {
    shared = {
      ...legacy,
      load: () => Promise.resolve(),
      isLoaded: () => true,
      whenLoaded: () => Promise.resolve(),
      flush: () => {},
      setHidden: () => {},
    };
    return shared;
  }
  shared = createPersistentStore({
    backend: indexedDbBackend(),
    legacy,
    channel:
      typeof BroadcastChannel === "undefined"
        ? null
        : (new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike),
  });
  const store = shared;
  // The last moment a phone reliably runs code; a write still pending then
  // would otherwise be lost with the page.
  window.addEventListener("pagehide", () => store.setHidden(true));
  window.addEventListener("pageshow", () => store.setHidden(false));
  document.addEventListener("visibilitychange", () =>
    store.setHidden(document.visibilityState === "hidden"),
  );
  return shared;
}

/**
 * Read the store before the first render, bounded so a slow database delays the
 * app by at most `LOAD_TIMEOUT_MS` (it then renders as a fresh profile would,
 * and entries arrive in memory once the read completes; see `whenLoaded`).
 */
export async function loadPersistentStore(): Promise<void> {
  const started = performance.now();
  await persistentStore().load(LOAD_TIMEOUT_MS);
  const elapsed = Math.round(performance.now() - started);
  if (elapsed >= LOAD_TIMEOUT_MS)
    console.warn(
      `[persistentStore] load exceeded ${LOAD_TIMEOUT_MS} ms; rendering without it`,
    );
  else console.debug(`[persistentStore] loaded in ${elapsed} ms`);
}
