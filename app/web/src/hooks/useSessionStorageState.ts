import { useEffect, useState } from "react";

/**
 * @hook useSessionStorageState
 * @purpose Persist small layout/navigation UI state across reloads in one browser
 * tab without sharing it with the user's other tabs.
 * @useWhen A browser-local state should survive reload but reset when its tab closes.
 * @avoidWhen The value is a cross-tab preference (use persistent preferences) or
 * authoritative/server-backed data.
 */
export function useSessionStorageState<T>(
  key: string,
  fallback: T,
  decode: (raw: string) => T | null,
  encode: (value: T) => string = JSON.stringify,
): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      return decode(window.sessionStorage.getItem(key) ?? "") ?? fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      window.sessionStorage.setItem(key, encode(value));
    } catch {
      // Storage may be unavailable (private mode or an embedded webview).
    }
  }, [encode, key, value]);

  return [value, setValue];
}

export function decodeBoolean(raw: string): boolean | null {
  return raw === "true" ? true : raw === "false" ? false : null;
}
