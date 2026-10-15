import { useCallback, useEffect, useRef, useState } from "react";
import {
  LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY,
  NEW_SESSION_DRAFT_STORAGE_KEY,
} from "../lib/newSessionRuntime.ts";
import { persistentStore } from "../lib/persistentStore.ts";

/** Best-effort browser-local text draft, isolated by the caller-owned key. */
export function useBrowserDraft(
  storageKey: string | undefined,
): [string, (value: string) => void] {
  // `edited`: the user changed the text since it was read for `key`. Only then
  // is it written: writing back what was read (or the empty field a slow store
  // load rendered) would replace the stored draft.
  const [state, setState] = useState(() => ({
    key: storageKey,
    text: loadBrowserDraft(storageKey),
    edited: false,
  }));
  const keyRef = useRef(storageKey);

  useEffect(() => {
    if (keyRef.current === storageKey) return;
    keyRef.current = storageKey;
    setState({
      key: storageKey,
      text: loadBrowserDraft(storageKey),
      edited: false,
    });
  }, [storageKey]);

  useEffect(() => {
    const store = persistentStore();
    if (store.isLoaded()) return;
    let live = true;
    void store.whenLoaded().then(() => {
      if (!live) return;
      setState((current) =>
        current.edited
          ? current
          : { ...current, text: readBrowserDraft(current.key) },
      );
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!state.edited || !storageKey || state.key !== storageKey) return;
    try {
      if (state.text) persistentStore().setItem(storageKey, state.text);
      else persistentStore().removeItem(storageKey);
    } catch {
      // Best-effort; losing a draft must never break composing.
    }
  }, [state, storageKey]);

  const setDraft = useCallback((text: string) => {
    setState((current) =>
      current.text === text ? current : { ...current, text, edited: true },
    );
  }, []);

  return [state.text, setDraft];
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
  } catch {
    // Best-effort cleanup of a retired key.
  }
  return readBrowserDraft(storageKey);
}

function readBrowserDraft(storageKey: string | undefined): string {
  if (!storageKey) return "";
  try {
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
