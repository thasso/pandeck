/**
 * The signed-in user's Slack connection on the gateway page (Task-1453),
 * shown only where the gateway offers "Sign in with Slack". The button asks
 * the gateway for Slack's authorize URL and the browser goes there; no token
 * is ever typed or shown. A connected record reads as its workspace's name,
 * already checked by the shared decoder, or as "your Slack workspace".
 * Disconnect asks first. A sign-in start and a Disconnect never overlap from
 * this page. The callback's result arrives as a fixed code and shows only as
 * its own text; success is silent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GatewayUiError,
  GatewayUiSlack,
  GatewayUiSlackConnectCode,
  GatewayUiSlackProblem,
} from "@assistant/shared/gatewayUi";
import { LogIn, Unplug } from "lucide-react";
import { ConfirmDialog } from "../components/common/dialogs.tsx";
import { EmptyBox, ErrorNote } from "../components/common/load.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import type { LoadState } from "../lib/loadState.ts";
import { GatewayApiError } from "./gatewayApi.ts";
import { goTo } from "./navigate.ts";
import { GatewayRow } from "./GatewayRow.tsx";

export interface GatewaySlackProps {
  status: LoadState<GatewayUiSlack>;
  clear: () => Promise<void>;
  /** Starts "Sign in with Slack": the authorize URL to go to next. */
  connect: () => Promise<string>;
  /** Where the browser goes; the page's own address by default. */
  navigate?: (url: string) => void;
  /** The sign-in's result code the page came back with, if any. */
  callback?: GatewayUiSlackConnectCode | undefined;
}

/**
 * Fixed text per callback code; success comes back without one. Each describes
 * the failed attempt only: an earlier connection may still be stored and work.
 */
const CONNECT_TEXT: Record<GatewayUiSlackConnectCode, string> = {
  rejected: "Slack did not accept the sign-in. Sign in with Slack again.",
  unreachable: "Slack could not be reached to finish the sign-in. Try again.",
  team_mismatch:
    "You signed in to a different Slack workspace than this gateway's. Sign in with Slack again and pick its workspace.",
  not_configured:
    "This gateway is not set up to finish Slack sign-ins. Ask its operator.",
  vault_locked:
    "The gateway's vault is locked, so the sign-in could not be kept. Ask its operator to unlock it.",
  vault_unavailable:
    "The gateway's vault did not answer, so the sign-in may not have been kept. Reload the page to see the connection.",
  busy: "Another change to this connection was still running. Sign in with Slack again.",
  tools_unavailable: "This gateway does not run the Slack tools.",
  signed_out:
    "Your gateway session ended before Slack answered. Sign in, then use Sign in with Slack again.",
  expired:
    "The sign-in took too long or was started in another browser. Sign in with Slack again.",
  failed: "The sign-in with Slack did not finish. Try again.",
  denied:
    "Access was not granted on Slack's page, so the sign-in did not finish.",
};

/** Fixed text per stored-record problem. */
const PROBLEM_TEXT: Record<GatewayUiSlackProblem, string> = {
  vault_locked:
    "The gateway's vault is locked, so the connection cannot be read now.",
  vault_unavailable:
    "The gateway's vault did not answer. Reload the page to try again.",
  invalid: "The stored connection cannot be read. Sign in with Slack again.",
  rejected: "Slack no longer accepts this sign-in. Sign in with Slack again.",
};

/** Fixed text per refusal; nothing from the gateway's answer is shown. */
const REFUSAL_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  vault_locked: "The gateway's vault is locked. Ask its operator to unlock it.",
  vault_unavailable: "The gateway's vault did not answer. Try again.",
  tools_unavailable: "This gateway does not run the Slack tools.",
  integration_busy:
    "Another change to this connection is still running. Try again.",
  signed_out: "Your session ended. Reload the page and sign in again.",
  unavailable:
    "The gateway has too many sign-ins in progress. Try again in a few minutes.",
};

function refusalText(err: unknown, fallback: string): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  return (code && REFUSAL_TEXT[code]) || fallback;
}

export function GatewaySlack({
  status,
  clear,
  connect,
  navigate = goTo,
  callback,
}: GatewaySlackProps) {
  const [clearing, setClearing] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  /** A sign-in start is in flight or the browser is leaving for Slack. */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The callback's note stays until the user acts on the connection. */
  const [callbackShown, setCallbackShown] = useState(true);
  /** The write in flight, set before any re-render can disable a control. */
  const writing = useRef<"clear" | "start" | null>(null);

  // Back from Slack can restore this page from the back/forward cache with
  // the start still marked pending: the user left Slack by choice, so the
  // start is abandoned without a note and the controls work again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || writing.current !== "start") return;
      writing.current = null;
      setStarting(false);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const startSignIn = () => {
    if (writing.current) return;
    writing.current = "start";
    setStarting(true);
    setStartError(null);
    setCallbackShown(false);
    connect().then(
      (url) => {
        // Stays busy: the browser is leaving for Slack.
        navigate(url);
      },
      (err: unknown) => {
        writing.current = null;
        setStarting(false);
        setStartError(
          refusalText(err, "Sign in with Slack could not start. Try again."),
        );
      },
    );
  };

  const confirmClear = useCallback(() => {
    if (writing.current) return;
    writing.current = "clear";
    setClearBusy(true);
    setClearError(null);
    setCallbackShown(false);
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
          refusalText(err, "The connection could not be removed. Try again."),
        );
      },
    );
  }, [clear]);

  // Refreshing or a failed refresh keeps what is on screen.
  const current =
    status.status === "idle" || status.status === "loading"
      ? undefined
      : status.data;
  // Until the gateway says it offers Slack, the section stays away: a
  // gateway without it shows nothing at all.
  if (status.status !== "error" && !current?.offered) return null;

  const busy = clearBusy || starting;
  const stored = Boolean(current?.connected || current?.problem);

  return (
    <section
      aria-label="Slack"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="-mx-5 border-b border-border px-5 pb-3 text-base font-semibold">
        Slack
      </h2>
      {status.status === "error" ? (
        <ErrorNote message="The Slack connection could not be loaded. Reload the page to try again." />
      ) : null}
      {callback && callbackShown ? (
        <ErrorNote message={CONNECT_TEXT[callback]} />
      ) : null}
      {startError ? <ErrorNote message={startError} /> : null}
      {current && stored ? (
        <div role="list">
          <GatewayRow
            title={
              current.connected
                ? `Connected to ${current.teamName ?? "your Slack workspace"}`
                : "Slack connection"
            }
            subtitle={
              current.problem ? PROBLEM_TEXT[current.problem] : undefined
            }
            status={
              current.connected ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="warning">Unavailable</Badge>
              )
            }
            menuLabel="More actions for the Slack connection"
            menu={[
              {
                id: "sign-in",
                label: "Sign in again",
                icon: <LogIn />,
                disabled: busy,
                onSelect: startSignIn,
              },
              {
                id: "clear",
                label: "Disconnect",
                icon: <Unplug />,
                destructive: true,
                disabled: starting,
                onSelect: () => {
                  setClearError(null);
                  setClearing(true);
                },
              },
            ]}
          />
        </div>
      ) : null}
      {current && !stored ? (
        <>
          <EmptyBox>No Slack connection yet.</EmptyBox>
          <div className="-mx-5 -mb-5 mt-1 flex items-center gap-3 rounded-b-xl border-t border-border bg-muted/40 px-5 py-4">
            <h3 className="flex-1 text-sm font-semibold">Connect Slack</h3>
            <Button
              type="button"
              variant="outline"
              busy={starting}
              disabled={busy}
              onClick={startSignIn}
            >
              <LogIn />
              Sign in with Slack
            </Button>
          </div>
        </>
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title="Disconnect Slack?"
          body="Slack tools in your Pandeck clients stop working until you sign in with Slack again."
          confirmLabel="Disconnect"
          danger
          busy={clearBusy}
          confirmDisabled={starting}
          error={clearError}
          onConfirm={confirmClear}
          onCancel={() => setClearing(false)}
        />
      ) : null}
    </section>
  );
}
