import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import {
  extractPaObjectLinkUris,
  paObjectKey,
  parsePaObjectLink,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import { paObjectReferenceKey } from "../lib/transcriptKeys.ts";

/**
 * Every `pa://` object the app can name (sessions, Tasks, projects, worktrees,
 * plus what the server resolved), and a way to ask the server for the rest.
 */
interface PaObjectLinkSource {
  references: readonly PaObjectLinkResolution[];
  /** Resolve these URIs on the server; already known or asked ones are skipped. */
  request: (uris: string[]) => void;
  /** Open a clicked link in the app. */
  open: (link: PaObjectLinkResolution) => void;
}

const PaObjectLinkSourceContext = createContext<PaObjectLinkSource | null>(
  null,
);

export const PaObjectLinkSourceProvider = PaObjectLinkSourceContext.Provider;

/**
 * The `pa://` resolutions a text the host never sees needs (a document file
 * fetched inside its viewer), so its links read as titles — a session's name,
 * a Task's title — instead of ids. Asks the server for the ones the app does
 * not hold.
 *
 * The answer's identity follows its CONTENT: the source list is rebuilt on
 * every session broadcast, and a new array each time would re-render the
 * whole Markdown pipeline for a title nothing here shows.
 */
export function useMentionedPaObjectReferences(text: string): {
  references: PaObjectLinkResolution[] | undefined;
  onOpen: ((link: PaObjectLinkResolution) => void) | undefined;
} {
  const source = useContext(PaObjectLinkSourceContext);
  const uris = useMemo(() => extractPaObjectLinkUris(text), [text]);
  const keys = useMemo(() => {
    const out = new Set<string>();
    for (const uri of uris) {
      const parsed = parsePaObjectLink(uri);
      if (parsed) out.add(paObjectKey(parsed));
    }
    return out;
  }, [uris]);
  const mentioned = source
    ? source.references.filter((ref) => keys.has(paObjectKey(ref)))
    : undefined;
  const key = mentioned ? paObjectReferenceKey(mentioned) : "";
  const cache = useRef<{ key: string; value: typeof mentioned } | null>(null);
  if (!cache.current || cache.current.key !== key)
    cache.current = { key, value: mentioned };

  useEffect(() => {
    if (source && uris.length > 0) source.request(uris);
  }, [source, uris]);

  return { references: cache.current.value, onOpen: source?.open };
}
