/**
 * The signed-in user's Claude and OpenAI accounts on the gateway page
 * (Task-1402 B2): the list with each account's needs-login state, Add (its
 * first login opens in the dialog, D5), Log in again, and Remove after a
 * confirmation. Logins render in B1's `AccountLoginDialogView`, the same
 * view Pandeck's Settings uses.
 */
import { useCallback, useState, type SyntheticEvent } from "react";
import { LogIn, Plus, Trash2 } from "lucide-react";
import type {
  GatewayUiAccount,
  GatewayUiProvider,
} from "@assistant/shared/gatewayUi";
import { AccountLoginDialogView } from "../components/AccountLoginDialogView.tsx";
import { ConfirmDialog } from "../components/common/dialogs.tsx";
import { ListRow } from "../components/common/ListRow.tsx";
import { ListRowActions } from "../components/common/ListRowActions.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
} from "../components/common/load.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import type { LoadState } from "../lib/loadState.ts";
import type { GatewayLogin } from "./useGatewayLogin.ts";

const PROVIDER_LABEL: Record<GatewayUiProvider, string> = {
  claude: "Claude",
  "openai-codex": "OpenAI",
};

export interface GatewayAccountsProps {
  accounts: LoadState<GatewayUiAccount[]>;
  login: GatewayLogin;
  /** Removes the account; rejects when the gateway did not. */
  remove: (accountId: string) => Promise<void>;
}

export function GatewayAccounts({
  accounts,
  login,
  remove,
}: GatewayAccountsProps) {
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<GatewayUiAccount | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const add = (provider: GatewayUiProvider) => {
    const trimmed = name.trim();
    login.open({
      provider,
      accountName: trimmed || PROVIDER_LABEL[provider],
      ...(trimmed ? { name: trimmed } : {}),
    });
    setName("");
  };

  const confirmRemove = useCallback(() => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    remove(removing.id).then(
      () => {
        setRemoveBusy(false);
        setRemoving(null);
      },
      () => {
        setRemoveBusy(false);
        setRemoveError("The account could not be removed. Try again.");
      },
    );
  }, [remove, removing]);

  // Refreshing or a failed refresh keeps what is on screen.
  const list =
    accounts.status === "idle" || accounts.status === "loading"
      ? undefined
      : accounts.data;

  return (
    <section aria-label="Accounts" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Accounts</h2>
      {accounts.status === "loading" || accounts.status === "idle" ? (
        <PaneLoading />
      ) : null}
      {accounts.status === "error" ? (
        <ErrorNote message="The accounts could not be loaded. Reload the page to try again." />
      ) : null}
      {list && list.length === 0 ? (
        <EmptyBox>
          No accounts yet. Add a Claude or OpenAI account below.
        </EmptyBox>
      ) : null}
      {list && list.length > 0 ? (
        <div role="list">
          {list.map((account) => (
            <ListRow
              key={account.id}
              role="listitem"
              interaction="content"
              title={account.name}
              details={PROVIDER_LABEL[account.provider]}
              signals={
                account.needsLogin ? (
                  <Badge variant="warning">Needs login</Badge>
                ) : null
              }
              actions={
                <ListRowActions
                  alwaysVisible
                  label={`${account.name} actions`}
                  actions={[
                    {
                      id: "login",
                      label: `Log in ${account.name}`,
                      icon: <LogIn />,
                      primary: true,
                      onSelect: () =>
                        login.open({
                          provider: account.provider,
                          accountName: account.name,
                          accountId: account.id,
                        }),
                    },
                    {
                      id: "remove",
                      label: `Remove ${account.name}`,
                      icon: <Trash2 />,
                      variant: "destructive",
                      onSelect: () => {
                        setRemoveError(null);
                        setRemoving(account);
                      },
                    },
                  ]}
                />
              }
            />
          ))}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event: SyntheticEvent<HTMLFormElement>) =>
          event.preventDefault()
        }
      >
        <Field>
          <FieldLabel htmlFor="gateway-account-name">
            New account name (optional)
          </FieldLabel>
          <Input
            id="gateway-account-name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="Work"
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => add("claude")}>
            <Plus />
            Add Claude account
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => add("openai-codex")}
          >
            <Plus />
            Add OpenAI account
          </Button>
        </div>
      </form>
      {login.dialog ? (
        <AccountLoginDialogView
          provider={login.dialog.provider}
          accountName={login.dialog.accountName}
          status={login.dialog.status}
          output={login.dialog.output}
          device={login.dialog.device}
          error={login.dialog.error}
          cancelUnconfirmed={login.dialog.cancelUnconfirmed}
          submit={login.submit}
          cancel={login.cancel}
          onClose={login.close}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          body="The gateway forgets this account and its login. Pandeck clients lose it too."
          confirmLabel="Remove"
          danger
          busy={removeBusy}
          error={removeError}
          onConfirm={confirmRemove}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
