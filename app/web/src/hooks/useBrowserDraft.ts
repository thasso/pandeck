import { useEffect, useRef, useState } from "react";
import {
  LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY,
  NEW_SESSION_DRAFT_STORAGE_KEY,
} from "../lib/newSessionRuntime.ts";
import { persistentStore } from "../lib/persistentStore.ts";

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
      if (draft) persistentStore().setItem(storageKey, draft);
      else persistentStore().removeItem(storageKey);
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
      persistentStore().removeItem(LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY);
      persistentStore().removeItem(
        `${LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY}.chatComments`,
      );
    }
    return persistentStore().getItem(storageKey) ?? "";
  } catch {
    return "";
  }
}

export function clearBrowserDraft(storageKey: string | undefined): void {
  if (!storageKey) return;
  try {
    persistentStore().removeItem(storageKey);
  } catch {
    // Best-effort, like draft persistence itself.
  }
}
