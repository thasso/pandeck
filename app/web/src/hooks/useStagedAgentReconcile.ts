import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { EntryLibraryList } from "@assistant/shared";
import {
  agentDraft,
  reconcileStagedAgent,
  stagedSessionRecord,
  withoutAgent,
  type StagedSessionRecord,
} from "../lib/stagedSession.ts";

/**
 * The staged agent follows the library and the accounts
 * (`docs/agent-definitions.md` "UI"): a definition deleted, renamed, made
 * unrunnable or moved to another persona is dropped, one whose model or effort
 * changed is restaged, and the draft's account stays one of the definition's
 * provider — moved to another when the picked one goes, the agent dropped when
 * none is left — so the pickers keep showing what the first send will run.
 *
 * Only on the new-session page, where the agents list is held. Off it the pick
 * is already spent, and leaving the page spends it in the same commit a
 * changed list may arrive in: a restage built from the record before that
 * would bring the agent and Plan back. Each write goes straight to the record —
 * a passive effect must neither flushSync nor pull focus to the composer the
 * way a click's restage does.
 */
export function useStagedAgentReconcile({
  active,
  list,
  pendingStart,
  setPendingStart,
  accounts,
  accountId,
  setAccountId,
}: {
  /** Whether the new-session page is showing. */
  active: boolean;
  list: EntryLibraryList | undefined;
  pendingStart: StagedSessionRecord | null;
  setPendingStart: Dispatch<SetStateAction<StagedSessionRecord | null>>;
  /** The enabled accounts; undefined until they are read. */
  accounts: ReadonlyArray<{ id: string; provider: string }> | undefined;
  accountId: string | null | undefined;
  setAccountId: (id: string) => void;
}): void {
  useEffect(() => {
    // An unread list or unread accounts say nothing about the pick.
    if (!active || !pendingStart?.agent || !list || !accounts) return;
    const change = reconcileStagedAgent(pendingStart, list);
    const draft =
      change === "drop"
        ? undefined
        : agentDraft(list, pendingStart.agent, accounts, accountId);
    if (!draft) {
      setPendingStart(withoutAgent(pendingStart));
      return;
    }
    const { accountId: draftAccountId, ...runtime } = draft;
    if (accountId !== null && draftAccountId !== accountId)
      setAccountId(draftAccountId);
    if (change === "keep") return;
    setPendingStart(
      stagedSessionRecord({
        ...runtime,
        id: pendingStart.id,
        mode: pendingStart.mode,
      }),
    );
  }, [
    active,
    list,
    pendingStart,
    setPendingStart,
    accounts,
    accountId,
    setAccountId,
  ]);
}
