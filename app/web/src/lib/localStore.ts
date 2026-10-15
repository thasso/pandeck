/**
 * The one door to `window.localStorage` (`localStorageAudit.test.ts`), for the
 * few values that must stay there: read before any module runs (the pre-paint
 * theme in `index.html`), or tiny flags not worth a migration. Everything else
 * belongs in `persistentStore.ts`, which explains why: WebKit's `localStorage`
 * WAL stops checkpointing once a value over 1 KB is overwritten, so what stays
 * here must stay small. `pendingCommentStore.ts` is the one other user — it
 * needs the cross-tab `storage` event — and its records are written rarely.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ListableStorage extends KeyValueStorage {
  /** Every key currently held. */
  keys(): string[];
}

/** WebKit's 1 KB in-memory threshold, in UTF-16 code units. */
const LOCAL_VALUE_LIMIT = 512;

/** Throws what `localStorage` throws (blocked, quota); callers own best-effort. */
export const localStore: KeyValueStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem(key, value) {
    if (import.meta.env.DEV && value.length > LOCAL_VALUE_LIMIT)
      console.warn(
        `[localStore] "${key}" is ${value.length} chars; values over ${LOCAL_VALUE_LIMIT} belong in persistentStore`,
      );
    window.localStorage.setItem(key, value);
  },
  removeItem: (key) => window.localStorage.removeItem(key),
};

/**
 * Raw access for `persistentStore`, the source it migrates from and its
 * pass-through when IndexedDB is unavailable — sizes are that store's concern.
 */
export function legacyLocalStorage(): ListableStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
    keys() {
      const keys: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key !== null) keys.push(key);
      }
      return keys;
    },
  };
}
