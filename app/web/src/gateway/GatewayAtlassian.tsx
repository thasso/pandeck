/**
 * The signed-in user's Atlassian credential on the gateway page (Task-1405):
 * whether it is set (site and email only), a form that checks a new one with
 * Atlassian before the gateway stores it, and Clear after a confirmation. The
 * API token is write-only: the field is a password field, emptied once the
 * gateway took it, and nothing ever shows a stored token. A Save and a Clear
 * never overlap from this page: each waits for the other to settle.
 */
import { useCallback, useRef, useState, type SyntheticEvent } from "react";
import type {
  GatewayUiAtlassian,
  GatewayUiAtlassianProblem,
  GatewayUiAtlassianSetRequest,
  GatewayUiError,
} from "@assistant/shared/gatewayUi";
import { ConfirmDialog } from "../components/common/dialogs.tsx";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
} from "../components/common/load.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import type { LoadState } from "../lib/loadState.ts";
import { GatewayApiError } from "./gatewayApi.ts";
import { GatewayRow } from "./GatewayRow.tsx";

export interface GatewayAtlassianProps {
  status: LoadState<GatewayUiAtlassian>;
  /** Checks and stores the credential; rejects with the gateway's refusal. */
  save: (request: GatewayUiAtlassianSetRequest) => Promise<GatewayUiAtlassian>;
  clear: () => Promise<void>;
}

/** Fixed text per stored-record problem. */
const PROBLEM_TEXT: Record<GatewayUiAtlassianProblem, string> = {
  vault_locked:
    "The gateway's vault is locked, so the credential cannot be read now.",
  vault_unavailable:
    "The gateway's vault did not answer. Reload the page to try again.",
  invalid: "The stored credential cannot be read. Set it again.",
};

/** Fixed text per refusal; nothing from the gateway's answer is shown. */
const SAVE_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  integration_invalid:
    "The site, email or API token is not valid. The site looks like your-team.atlassian.net.",
  integration_rejected: "Atlassian rejected this email and API token.",
  integration_unreachable:
    "Atlassian could not be reached to check the credential. Try again.",
  vault_locked: "The gateway's vault is locked. Ask its operator to unlock it.",
  vault_unavailable: "The gateway's vault did not answer. Try again.",
  tools_unavailable: "This gateway does not run the Jira tools.",
  integration_busy:
    "Another change to this credential is still running. Try again.",
  signed_out: "Your session ended. Reload the page and sign in again.",
  bad_request: "Fill in the site, email and API token.",
};

function refusalText(err: unknown, fallback: string): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  return (code && SAVE_TEXT[code]) || fallback;
}

export function GatewayAtlassian({
  status,
  save,
  clear,
}: GatewayAtlassianProps) {
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  /** The replace form is open over a stored credential. */
  const [editing, setEditing] = useState(false);
  const preset =
    status.status === "idle" || status.status === "loading"
      ? undefined
      : status.data?.preset;
  /** The write in flight, set before any re-render can disable a control. */
  const writing = useRef<"save" | "clear" | null>(null);

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (writing.current) return;
    writing.current = "save";
    setSaving(true);
    setSaveError(null);
    save({
      site: (preset?.site ?? site).trim(),
      email: (preset?.email ?? email).trim(),
      token,
    }).then(
      () => {
        writing.current = null;
        setSaving(false);
        setToken("");
        setEditing(false);
      },
      (err: unknown) => {
        writing.current = null;
        setSaving(false);
        setSaveError(
          refusalText(err, "The credential could not be saved. Try again."),
        );
      },
    );
  };

  const confirmClear = useCallback(() => {
    if (writing.current) return;
    writing.current = "clear";
    setClearBusy(true);
    setClearError(null);
    clear().then(
      () => {
        writing.current = null;
        setClearBusy(false);
        setClearing(false);
        setEditing(false);
      },
      (err: unknown) => {
        writing.current = null;
        setClearBusy(false);
        setClearError(
          refusalText(err, "The credential could not be cleared. Try again."),
        );
      },
    );
  }, [clear]);

  // Refreshing or a failed refresh keeps what is on screen.
  const current =
    status.status === "idle" || status.status === "loading"
      ? undefined
      : status.data;

  const hasCredential = Boolean(current?.connected || current?.problem);

  return (
    <section
      aria-label="Jira"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="-mx-5 border-b border-border px-5 pb-3 text-base font-semibold">
        Jira
      </h2>
      {status.status === "loading" || status.status === "idle" ? (
        <PaneLoading />
      ) : null}
      {status.status === "error" ? (
        <ErrorNote message="The Jira credential could not be loaded. Reload the page to try again." />
      ) : null}
      {current && (current.connected || current.problem) ? (
        <div role="list">
          <GatewayRow
            title={
              current.displayName ?? current.email ?? "Atlassian credential"
            }
            subtitle={
              current.problem
                ? PROBLEM_TEXT[current.problem]
                : [current.email, current.site].filter(Boolean).join(" · ")
            }
            status={
              current.connected ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="warning">Unavailable</Badge>
              )
            }
            menuLabel="More actions for the Jira credential"
            menu={[
              {
                id: "replace",
                label: "Reconnect",
                icon: <RefreshCw />,
                disabled: editing || saving || clearBusy,
                onSelect: () => {
                  setSite(current.site ?? "");
                  setEmail(current.email ?? "");
                  setSaveError(null);
                  setEditing(true);
                },
              },
              {
                id: "clear",
                label: "Remove credential",
                icon: <Trash2 />,
                destructive: true,
                disabled: saving,
                onSelect: () => {
                  setClearError(null);
                  setClearing(true);
                },
              },
            ]}
          />
        </div>
      ) : null}
      {current && !current.connected && !current.problem ? (
        <EmptyBox>No Atlassian credential yet.</EmptyBox>
      ) : null}
      {current && !current.connected && !current.problem ? (
        <div className="-mx-5 -mb-5 mt-1 flex items-center gap-3 rounded-b-xl border-t border-border bg-muted/40 px-5 py-4">
          <h3 className="flex-1 text-sm font-semibold">Connect Jira</h3>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSaveError(null);
              setEditing(true);
            }}
          >
            <Plus />
            Connect
          </Button>
        </div>
      ) : null}
      {editing ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !saving) {
              setEditing(false);
              setToken("");
              setSaveError(null);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <form className="flex flex-col gap-4" onSubmit={submit}>
              <DialogHeader>
                <DialogTitle>
                  {hasCredential ? "Reconnect Jira" : "Connect Jira"}
                </DialogTitle>
                <DialogDescription>
                  {preset?.site && preset.email
                    ? "Paste an Atlassian API token."
                    : "Your Atlassian site, email and an API token."}
                </DialogDescription>
              </DialogHeader>
              {preset?.site || preset?.email ? (
                <p className="text-sm text-muted-foreground">
                  For{" "}
                  {preset.email ? (
                    <span className="font-medium text-foreground">
                      {preset.email}
                    </span>
                  ) : (
                    "your account"
                  )}
                  {preset.site ? (
                    <>
                      {" "}
                      on{" "}
                      <span className="font-medium text-foreground">
                        {preset.site}
                      </span>
                    </>
                  ) : null}
                  .
                </p>
              ) : null}
              {preset?.site ? null : (
                <Field>
                  <FieldLabel htmlFor="gateway-atlassian-site">Site</FieldLabel>
                  <Input
                    id="gateway-atlassian-site"
                    value={site}
                    maxLength={300}
                    placeholder="your-team.atlassian.net"
                    autoComplete="off"
                    onChange={(event) => setSite(event.target.value)}
                  />
                </Field>
              )}
              {preset?.email ? null : (
                <Field>
                  <FieldLabel htmlFor="gateway-atlassian-email">
                    Email
                  </FieldLabel>
                  <Input
                    id="gateway-atlassian-email"
                    type="email"
                    value={email}
                    maxLength={300}
                    autoComplete="off"
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="gateway-atlassian-token">
                  API token
                </FieldLabel>
                <Input
                  id="gateway-atlassian-token"
                  type="password"
                  value={token}
                  maxLength={600}
                  autoComplete="off"
                  onChange={(event) => setToken(event.target.value)}
                />
                <FieldDescription>
                  Atlassian checks the credential before the gateway keeps it.
                  The token is never shown again.
                </FieldDescription>
              </Field>
              {saveError ? <ErrorNote message={saveError} /> : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setToken("");
                    setSaveError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  busy={saving}
                  disabled={
                    clearBusy ||
                    !(preset?.site ?? site).trim() ||
                    !(preset?.email ?? email).trim() ||
                    !token
                  }
                >
                  {hasCredential ? "Reconnect" : "Connect"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title="Remove the Atlassian credential?"
          body="Jira tools in your Pandeck clients stop working until you set it again."
          confirmLabel="Remove"
          danger
          busy={clearBusy}
          confirmDisabled={saving}
          error={clearError}
          onConfirm={confirmClear}
          onCancel={() => setClearing(false)}
        />
      ) : null}
    </section>
  );
}
