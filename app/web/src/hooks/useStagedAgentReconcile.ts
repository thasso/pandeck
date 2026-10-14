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
 * The staged agent follows the library (`docs/agent-definitions.md` "UI"): a
 * definition deleted, renamed or made unrunnable is dropped, and one whose
 * runtime changed is restaged, so the pickers keep showing what the first send
 * will run.
 *
 * Only on the new-session page, where the agents list is held: off it the pick
 * is already spent. Each write is written straight to the record — a passive
 * effect must neither flushSync nor pull focus to the composer the way a
 * click's restage does — and lands only on the record it was computed from, so
 * an update queued in the same commit (leaving the page spends the agent and
 * Plan) is never overwritten by one built from the record before it.
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
  accounts: ReadonlyArray<{ id: string; provider: string }>;
  accountId: string | undefined;
  setAccountId: (id: string) => void;
}): void {
  useEffect(() => {
    if (!active || !pendingStart?.agent) return;
    const change = reconcileStagedAgent(pendingStart, list);
    if (change === "keep") return;
    const draft =
      change === "restage"
        ? agentDraft(list, pendingStart.agent, accounts, accountId)
        : undefined;
    const read = pendingStart;
    if (!draft) {
      setPendingStart((current) =>
        current === read ? withoutAgent(read) : current,
      );
      return;
    }
    const { accountId: draftAccountId, ...runtime } = draft;
    setAccountId(draftAccountId);
    setPendingStart((current) =>
      current === read
        ? stagedSessionRecord({ ...runtime, id: read.id, mode: read.mode })
        : current,
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
