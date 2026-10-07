import { useEffect, useState } from "react";

import {
  ensureLanguageLoaded,
  isLanguageSupported,
  resolveHighlighterLanguage,
} from "./highlighter";

/**
 * Return whether a Shiki language is ready, importing an on-demand grammar when
 * needed. Callers can render plaintext while this is false and will re-render
 * once loading completes.
 */
export function useHighlighterLanguage(language?: string): boolean {
  const resolved = resolveHighlighterLanguage(language);
  // The counter's VALUE is never read: bumping it is only how a finished grammar
  // import asks for the re-render that re-reads the registry below.
  const [, setLoadVersion] = useState(0);

  useEffect(() => {
    if (!resolved || isLanguageSupported(resolved)) return;
    let cancelled = false;
    void ensureLanguageLoaded(resolved).then((loaded) => {
      if (!cancelled && loaded) setLoadVersion((current) => current + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [resolved]);

  // A lookup against the module-level registry the effect above mutates, so it
  // is read on every render. Memoizing it would key the answer on `resolved`
  // alone and freeze a language at "unsupported" for as long as it stayed
  // mounted, however long ago its grammar finished loading.
  return isLanguageSupported(resolved);
}
