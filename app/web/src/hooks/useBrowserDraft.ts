import { useEffect, useRef, useState } from "react";
import {
  LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY,
  NEW_SESSION_DRAFT_STORAGE_KEY,
} from "../lib/newSessionRuntime.ts";

/** Best-effort browser-local text draft, isolated by the caller-owned key. */
export function useBrowserDraft(
  storageKey: string | undefined,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState(() => loadBrowserDraft(storageKey));
  const keyRef = useRef(storageKey);

  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    setDraft(loadBrowserDraft(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      if (draft) window.localStorage.setItem(storageKey, draft);
      else window.localStorage.removeItem(storageKey);
    } catch {
      // Best-effort; losing a draft must never break composing.
    }
  }, [draft, storageKey]);

  return [draft, setDraft];
}

function loadBrowserDraft(storageKey: string | undefined): string {
  if (!storageKey) return "";
  try {
    if (storageKey === NEW_SESSION_DRAFT_STORAGE_KEY) {
      window.localStorage.removeItem(LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY);
      window.localStorage.removeItem(
        `${LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY}.chatComments`,
      );
    }
    return window.localStorage.getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

export function clearBrowserDraft(storageKey: string | undefined): void {
  if (!storageKey) return;
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Best-effort, like draft persistence itself.
  }
}
