import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { EntryLibraryList } from "@assistant/shared";
import {
  reconcileStagedAgent,
  withoutAgent,
  type StagedSessionRecord,
} from "../lib/stagedSession.ts";

/**
 * The staged role follows the library (`docs/agent-definitions.md` "UI"): a
 * definition deleted, renamed, broken or moved to another persona is dropped.
 * Its runtime is left alone: the model, effort and account the pickers show
 * are the user's choice, and the first send runs them.
 *
 * Only on the new-session page, where the agents list is held. Off it the pick
 * is already spent, and leaving the page spends it in the same commit a
 * changed list may arrive in. The write goes straight to the record — a
 * passive effect must neither flushSync nor pull focus to the composer the way
 * a click's restage does.
 */
export function useStagedAgentReconcile({
  active,
  list,
  pendingStart,
  setPendingStart,
}: {
  /** Whether the new-session page is showing. */
  active: boolean;
  list: EntryLibraryList | undefined;
  pendingStart: StagedSessionRecord | null;
  setPendingStart: Dispatch<SetStateAction<StagedSessionRecord | null>>;
}): void {
  useEffect(() => {
    // An unread list says nothing about the pick.
    if (!active || !pendingStart?.agent || !list) return;
    if (reconcileStagedAgent(pendingStart, list) === "drop")
      setPendingStart(withoutAgent(pendingStart));
  }, [active, list, pendingStart, setPendingStart]);
}
