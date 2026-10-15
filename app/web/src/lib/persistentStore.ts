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
 * Without IndexedDB (jsdom, a blocked or broken database) the store is a plain
 * pass-through to `localStorage`, which is also where the keys it took over
 * are migrated from on the first load.
 */

export interface PersistentStore extends ListableStorage {
  /** Read the backend into memory; resolves at the latest after `timeoutMs`. */
  load(timeoutMs: number): Promise<void>;
  /** Start writing every pending change now. */
  flush(): void;
  /**
   * While the page is hidden every write starts at once: the app's own caches
   * flush on the same `pagehide`/hidden events, after this store has heard
   * them, and a write waiting on the coalescing delay would die with the page.
   */
  setHidden(hidden: boolean): void;
}

export interface PersistentStoreBackend {
  load(): Promise<Map<string, string>>;
  commit(puts: Map<string, string>, deletes: Set<string>): Promise<void>;
}

interface ChannelLike {
  postMessage(message: ChannelMessage): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

interface ChannelMessage {
  key: string;
  value: string | null;
}

const DB_NAME = "assistant-persistent-store";
const DB_VERSION = 1;
const STORE_NAME = "entries";
const CHANNEL_NAME = "assistant-persistent-store";
const FLUSH_DELAY_MS = 250;
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
}): PersistentStore {
  const { backend, legacy } = options;
  const channel = options.channel ?? null;
  const schedule =
    options.schedule ?? ((run, ms) => void globalThis.setTimeout(run, ms));
  const memory = new Map<string, string>();
  /** Keys written here (or by another window) since boot: newer than the backend. */
  const touched = new Set<string>();
  const puts = new Map<string, string>();
  const deletes = new Set<string>();
  let flushScheduled = false;
  let hidden = false;
  /** The backend failed: from then on this is plain `localStorage`. */
  let fallback = false;
  let loaded = false;
  let loading: Promise<void> | null = null;

  const scheduleFlush = () => {
    if (hidden) return flush();
    if (flushScheduled) return;
    flushScheduled = true;
    schedule(flush, FLUSH_DELAY_MS);
  };

  function flush(): void {
    flushScheduled = false;
    if (fallback || (puts.size === 0 && deletes.size === 0)) return;
    const batchPuts = new Map(puts);
    const batchDeletes = new Set(deletes);
    puts.clear();
    deletes.clear();
    backend.commit(batchPuts, batchDeletes).catch(() => {
      // Best effort, like the `localStorage` writes this replaces.
    });
  }

  const remember = (key: string, value: string | null) => {
    touched.add(key);
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  };

  if (channel)
    channel.onmessage = (event) => {
      const message = event.data as Partial<ChannelMessage> | null;
      if (!message || typeof message.key !== "string") return;
      remember(
        message.key,
        typeof message.value === "string" ? message.value : null,
      );
    };

  async function loadFromBackend(): Promise<void> {
    let stored: Map<string, string>;
    try {
      stored = await backend.load();
    } catch {
      // No database: keep what this page already wrote, then pass through.
      fallback = true;
      for (const key of touched) {
        const value = memory.get(key);
        if (value === undefined) legacy.removeItem(key);
        else legacy.setItem(key, value);
      }
      return;
    }
    for (const [key, value] of stored)
      if (!touched.has(key)) memory.set(key, value);
    loaded = true;
    try {
      await migrateFromLegacy(stored);
    } catch {
      // Blocked `localStorage`: nothing to carry over.
    }
  }

  async function migrateFromLegacy(stored: Map<string, string>) {
    for (const key of DISCARDED_KEYS) legacy.removeItem(key);
    const legacyKeys = legacy.keys().filter(migratesFromLocalStorage);
    const migrated = new Map<string, string>();
    for (const key of legacyKeys) {
      const value = legacy.getItem(key);
      if (value === null || touched.has(key) || stored.has(key)) continue;
      memory.set(key, value);
      migrated.set(key, value);
    }
    if (migrated.size > 0) {
      try {
        await backend.commit(migrated, new Set());
      } catch {
        // Not carried over: leave them where they are and retry next boot.
        return;
      }
    }
    for (const key of legacyKeys) legacy.removeItem(key);
  }

  return {
    getItem(key) {
      if (fallback) return legacy.getItem(key);
      return memory.get(key) ?? null;
    },
    setItem(key, value) {
      if (fallback) return legacy.setItem(key, value);
      if (memory.get(key) === value) return;
      remember(key, value);
      deletes.delete(key);
      puts.set(key, value);
      channel?.postMessage({ key, value });
      scheduleFlush();
    },
    removeItem(key) {
      if (fallback) return legacy.removeItem(key);
      // Until the load answers, the backend may hold a key memory does not.
      if (loaded && !memory.has(key)) return;
      remember(key, null);
      puts.delete(key);
      deletes.add(key);
      channel?.postMessage({ key, value: null });
      scheduleFlush();
    },
    keys() {
      return fallback ? legacy.keys() : [...memory.keys()];
    },
    load(timeoutMs) {
      loading ??= loadFromBackend();
      return Promise.race([
        loading,
        new Promise<void>((resolve) => schedule(resolve, timeoutMs)),
      ]);
    },
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
      const entries = new Map<string, string>();
      keys.forEach((key, index) => {
        const value = values[index];
        if (typeof key === "string" && typeof value === "string")
          entries.set(key, value);
      });
      return entries;
    },
    async commit(puts, deletes) {
      const db = await open();
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      for (const key of deletes) store.delete(key);
      for (const [key, value] of puts) store.put(value, key);
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
 * and entries arrive in memory once the read completes).
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
