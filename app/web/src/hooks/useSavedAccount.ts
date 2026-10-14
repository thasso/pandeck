import { useCallback, useEffect, useState } from "react";

/**
 * Saves the account picked for new sessions as the default for the next ones
 * — except one an agent definition chose (`docs/agent-definitions.md` "UI"). A
 * definition's account is the draft's, like its model and effort, which are
 * not remembered either: saving the account alone would open every later
 * draft, after a reload too, on an account whose remembered model is not
 * there.
 *
 * `markAgentAccount` precedes the account change an agent pick or its
 * reconcile makes; `clearAgentAccount` precedes an explicit account or model
 * pick, which is the user's and is saved, even when it names the same account.
 */
export function useSavedAccount({
  accountId,
  savedAccountId,
  save,
}: {
  accountId: string;
  savedAccountId: string | undefined;
  save: (accountId: string) => void;
}): {
  markAgentAccount: (accountId: string) => void;
  clearAgentAccount: () => void;
} {
  const [agentAccount, setAgentAccount] = useState<string | null>(null);
  useEffect(() => {
    if (accountId && accountId !== savedAccountId && accountId !== agentAccount)
      save(accountId);
  }, [accountId, savedAccountId, agentAccount, save]);
  const clearAgentAccount = useCallback(() => setAgentAccount(null), []);
  return { markAgentAccount: setAgentAccount, clearAgentAccount };
}
