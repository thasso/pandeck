/**
 * The signed-in user's enrolled clients on the gateway page (Task-1405): the
 * list with each client's MCP token state, a one-time enrollment code for a
 * new client, minting (or replacing) and revoking a client's MCP token, and
 * revoking a client. Every revoke and every replacement asks first, and a
 * client's actions are disabled while one of them is in flight. A new
 * code or token is shown once in `GatewaySecretDialog` and dropped when it
 * closes; the list never carries one.
 */
import { useCallback, useRef, useState, type SyntheticEvent } from "react";
import { Ban, KeyRound, Plus, Trash2 } from "lucide-react";
import type {
  GatewayUiClient,
  GatewayUiEnrollmentCode,
  GatewayUiError,
  GatewayUiMcpToken,
} from "@assistant/shared/gatewayUi";
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
import { GatewayApiError } from "./gatewayApi.ts";
import { GatewaySecretDialog } from "./GatewaySecretDialog.tsx";

export interface GatewayClientsProps {
  clients: LoadState<GatewayUiClient[]>;
  /** Each rejects with the gateway's refusal. */
  createCode: (label: string) => Promise<GatewayUiEnrollmentCode>;
  revoke: (clientId: string) => Promise<void>;
  mintMcpToken: (clientId: string) => Promise<GatewayUiMcpToken>;
  revokeMcpToken: (clientId: string) => Promise<void>;
  /** Reads the list again, once a shown code was closed. */
  reload: () => void;
}

/** Fixed text per refusal; nothing from the gateway's answer is shown. */
const REFUSAL_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  unknown_client: "This client is no longer enrolled. Reload the page.",
  limit_reached:
    "You have too many clients or unused codes. Revoke a client or wait for codes to expire.",
  signed_out: "Your session ended. Reload the page and sign in again.",
  bad_request: "Give the new client a name of at most 200 characters.",
};

function refusalText(err: unknown): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  return (
    (code && REFUSAL_TEXT[code]) ||
    "The gateway could not do this right now. Try again."
  );
}

type Pending =
  | { kind: "revoke"; client: GatewayUiClient }
  | { kind: "replaceToken"; client: GatewayUiClient }
  | { kind: "revokeToken"; client: GatewayUiClient };

type Shown =
  | { kind: "code"; code: GatewayUiEnrollmentCode }
  | { kind: "token"; client: GatewayUiClient; token: string };

const CONFIRM: Record<
  Pending["kind"],
  (client: GatewayUiClient) => {
    title: string;
    body: string;
    confirmLabel: string;
  }
> = {
  revoke: (client) => ({
    title: `Revoke ${client.label}?`,
    body: "Its connections end now, its running logins are cancelled and its MCP token stops working. The machine must enroll again with a new code. Accounts stay.",
    confirmLabel: "Revoke client",
  }),
  replaceToken: (client) => ({
    title: `Replace the MCP token of ${client.label}?`,
    body: "The current token stops working.",
    confirmLabel: "Replace token",
  }),
  revokeToken: (client) => ({
    title: `Revoke the MCP token of ${client.label}?`,
    body: "The token stops working. You can mint a new one later.",
    confirmLabel: "Revoke token",
  }),
};

const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function GatewayClients({
  clients,
  createCode,
  revoke,
  mintMcpToken,
  revokeMcpToken,
  reload,
}: GatewayClientsProps) {
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  /**
   * Clients with a mint or revoke in flight: the ref answers at once (a
   * repeated click before a re-render), the state disables their actions.
   */
  const inFlight = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  /** Runs one change of the client, unless one is already in flight. */
  const once = useCallback(
    <T,>(clientId: string, run: () => Promise<T>): Promise<T> | undefined => {
      if (inFlight.current.has(clientId)) return undefined;
      inFlight.current.add(clientId);
      setBusyIds(new Set(inFlight.current));
      return run().finally(() => {
        inFlight.current.delete(clientId);
        setBusyIds(new Set(inFlight.current));
      });
    },
    [],
  );

  const create = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    createCode(trimmed).then(
      (code) => {
        setCreating(false);
        setLabel("");
        setShown({ kind: "code", code });
      },
      (err: unknown) => {
        setCreating(false);
        setCreateError(refusalText(err));
      },
    );
  };

  const mint = useCallback(
    (client: GatewayUiClient) => mintMcpToken(client.id),
    [mintMcpToken],
  );

  const ask = (next: Pending) => {
    setPendingError(null);
    setPending(next);
  };

  const startMint = (client: GatewayUiClient) => {
    if (inFlight.current.has(client.id)) return;
    setRowError(null);
    if (client.mcpToken) return ask({ kind: "replaceToken", client });
    void once(client.id, () => mint(client))?.then(
      ({ token }) => setShown({ kind: "token", client, token }),
      (err: unknown) => setRowError(refusalText(err)),
    );
  };

  const confirm = useCallback(() => {
    if (!pending) return;
    const { client } = pending;
    const run = once(client.id, (): Promise<Shown | null> =>
      pending.kind === "revoke"
        ? revoke(client.id).then(() => null)
        : pending.kind === "revokeToken"
          ? revokeMcpToken(client.id).then(() => null)
          : mint(client).then(({ token }) => ({
              kind: "token" as const,
              client,
              token,
            })),
    );
    if (!run) return;
    setPendingBusy(true);
    setPendingError(null);
    run.then(
      (next) => {
        setPendingBusy(false);
        setPending(null);
        if (next) setShown(next);
      },
      (err: unknown) => {
        setPendingBusy(false);
        setPendingError(refusalText(err));
      },
    );
  }, [pending, once, revoke, revokeMcpToken, mint]);

  const closeShown = () => {
    const wasCode = shown?.kind === "code";
    setShown(null);
    if (wasCode) reload();
  };

  // Refreshing or a failed refresh keeps what is on screen.
  const list =
    clients.status === "idle" || clients.status === "loading"
      ? undefined
      : clients.data;
  const asked = pending ? CONFIRM[pending.kind](pending.client) : undefined;
  const minutes =
    shown?.kind === "code"
      ? Math.max(1, Math.round(shown.code.validForSeconds / 60))
      : 0;

  return (
    <section aria-label="Clients" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Clients</h2>
      {clients.status === "loading" || clients.status === "idle" ? (
        <PaneLoading />
      ) : null}
      {clients.status === "error" ? (
        <ErrorNote message="The clients could not be loaded. Reload the page to try again." />
      ) : null}
      {list && list.length === 0 ? (
        <EmptyBox>
          No clients yet. Create an enrollment code for a new machine below.
        </EmptyBox>
      ) : null}
      {rowError ? <ErrorNote message={rowError} /> : null}
      {list && list.length > 0 ? (
        <div role="list">
          {list.map((client) => (
            <ListRow
              key={client.id}
              role="listitem"
              interaction="content"
              title={client.label}
              details={`Enrolled ${dateOf(client.createdAt)}`}
              signals={
                client.mcpToken ? (
                  <Badge variant="secondary">MCP token</Badge>
                ) : null
              }
              actions={
                <ListRowActions
                  alwaysVisible
                  label={`${client.label} actions`}
                  actions={[
                    {
                      id: "mint",
                      label: client.mcpToken
                        ? `Replace MCP token of ${client.label}`
                        : `Mint MCP token for ${client.label}`,
                      icon: <KeyRound />,
                      primary: true,
                      disabled: busyIds.has(client.id),
                      onSelect: () => startMint(client),
                    },
                    ...(client.mcpToken
                      ? [
                          {
                            id: "revoke-token",
                            label: `Revoke MCP token of ${client.label}`,
                            icon: <Ban />,
                            disabled: busyIds.has(client.id),
                            onSelect: () =>
                              ask({ kind: "revokeToken", client }),
                          },
                        ]
                      : []),
                    {
                      id: "revoke",
                      label: `Revoke ${client.label}`,
                      icon: <Trash2 />,
                      primary: true,
                      disabled: busyIds.has(client.id),
                      variant: "destructive" as const,
                      onSelect: () => ask({ kind: "revoke", client }),
                    },
                  ]}
                />
              }
            />
          ))}
        </div>
      ) : null}
      <form className="flex flex-col gap-2" onSubmit={create}>
        <Field>
          <FieldLabel htmlFor="gateway-client-label">
            New client name
          </FieldLabel>
          <Input
            id="gateway-client-label"
            value={label}
            maxLength={200}
            placeholder="Work laptop"
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        {createError ? <ErrorNote message={createError} /> : null}
        <div>
          <Button
            type="submit"
            variant="outline"
            busy={creating}
            disabled={!label.trim()}
          >
            <Plus />
            Create enrollment code
          </Button>
        </div>
      </form>
      {pending && asked ? (
        <ConfirmDialog
          title={asked.title}
          body={asked.body}
          confirmLabel={asked.confirmLabel}
          danger={pending.kind !== "replaceToken"}
          busy={pendingBusy}
          error={pendingError}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {shown?.kind === "code" ? (
        <GatewaySecretDialog
          title="Enrollment code"
          label="Enrollment code"
          secret={shown.code.code}
          onDone={closeShown}
        >
          Valid for {minutes} minutes, once. Enter it in{" "}
          <code>gateway:relay enroll</code> on the new machine.
        </GatewaySecretDialog>
      ) : null}
      {shown?.kind === "token" ? (
        <GatewaySecretDialog
          title={`MCP token for ${shown.client.label}`}
          label="MCP token"
          secret={shown.token}
          onDone={closeShown}
        >
          Give it to the MCP client on that machine. If it is lost, mint a new
          one; the old one then stops working.
        </GatewaySecretDialog>
      ) : null}
    </section>
  );
}
