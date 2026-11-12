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
import { ErrorNote, PaneLoading } from "../components/common/load.tsx";
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
  /** The write in flight, set before any re-render can disable a control. */
  const writing = useRef<"save" | "clear" | null>(null);

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (writing.current) return;
    writing.current = "save";
    setSaving(true);
    setSaveError(null);
    save({ site: site.trim(), email: email.trim(), token }).then(
      () => {
        writing.current = null;
        setSaving(false);
        setToken("");
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

  return (
    <section aria-label="Jira" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Jira</h2>
      {status.status === "loading" || status.status === "idle" ? (
        <PaneLoading />
      ) : null}
      {status.status === "error" ? (
        <ErrorNote message="The Jira credential could not be loaded. Reload the page to try again." />
      ) : null}
      {current ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {current.connected ? (
            <>
              <Badge variant="success">Connected</Badge>
              <span>
                as <span className="font-medium">{current.email}</span> on{" "}
                <span className="font-medium">{current.site}</span>
              </span>
            </>
          ) : current.problem ? (
            <>
              <Badge variant="warning">Unavailable</Badge>
              <span>{PROBLEM_TEXT[current.problem]}</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              No Atlassian credential is set.
            </span>
          )}
          {current.connected || current.problem ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setClearError(null);
                setClearing(true);
              }}
            >
              Clear
            </Button>
          ) : null}
        </div>
      ) : null}
      <form className="flex flex-col gap-2" onSubmit={submit}>
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
        <Field>
          <FieldLabel htmlFor="gateway-atlassian-email">Email</FieldLabel>
          <Input
            id="gateway-atlassian-email"
            type="email"
            value={email}
            maxLength={300}
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="gateway-atlassian-token">API token</FieldLabel>
          <Input
            id="gateway-atlassian-token"
            type="password"
            value={token}
            maxLength={600}
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <FieldDescription>
            Atlassian checks the credential before the gateway keeps it. The
            token is never shown again.
          </FieldDescription>
        </Field>
        {saveError ? <ErrorNote message={saveError} /> : null}
        <div>
          <Button
            type="submit"
            busy={saving}
            disabled={clearBusy || !site.trim() || !email.trim() || !token}
          >
            {current?.connected ? "Replace credential" : "Save credential"}
          </Button>
        </div>
      </form>
      {clearing ? (
        <ConfirmDialog
          title="Clear the Atlassian credential?"
          body="Jira tools in your Pandeck clients stop working until you set it again."
          confirmLabel="Clear"
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
