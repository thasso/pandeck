import { useCallback, useMemo } from "react";
import { paObjectKey } from "@assistant/shared/objectLinks";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import { useMentionedPaObjectReferences } from "../PaObjectLinks.tsx";

/**
 * The `pa://` resolution of every session a Schedules surface names (targets
 * and creators), whether or not the client holds the row: a held session
 * resolves from the app's own list, an archived or unseen one is asked of the
 * server, so a title never falls back to an id because of what happens to be
 * loaded. `missing` is a deleted session.
 */
export function useScheduleSessionTitles(
  sessionIds: readonly string[],
): (sessionId: string) => PaObjectLinkResolution | undefined {
  const text = useMemo(
    () =>
      [...new Set(sessionIds)]
        .sort()
        .map((id) => `pa://session/${encodeURIComponent(id)}`)
        .join("\n"),
    [sessionIds],
  );
  const { references } = useMentionedPaObjectReferences(text);
  const byKey = useMemo(
    () => new Map((references ?? []).map((ref) => [paObjectKey(ref), ref])),
    [references],
  );
  return useCallback(
    (sessionId: string) =>
      byKey.get(paObjectKey({ objectType: "session", id: sessionId })),
    [byKey],
  );
}
