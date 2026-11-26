/**
 * The signed-in user's GitHub connection on the gateway page (Task-1445),
 * shown only where the gateway offers "Connect GitHub". The button asks the
 * gateway for GitHub's authorize URL and the browser goes there; no token is
 * ever typed or shown. A connected record reads as its GitHub login, already
 * checked by the shared decoder, or as "your GitHub account". Disconnect asks
 * first and says the App stays authorized at GitHub. "Check repository access"
 * asks whether the vault hands the user read access to one `owner/repo` and
 * shows only that repository and the token's expiry. A connect start and a
 * Disconnect never overlap from this page. The callback's result arrives as a
 * fixed code and shows only as its own text; success is silent.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  isGatewayUiGithubRepoName,
  type GatewayUiError,
  type GatewayUiGithub,
  type GatewayUiGithubCheck,
  type GatewayUiGithubCheckRequest,
  type GatewayUiGithubConnectCode,
  type GatewayUiGithubProblem,
} from "@assistant/shared/gatewayUi";
import { LogIn, Unplug } from "lucide-react";
import { ConfirmDialog } from "../components/common/dialogs.tsx";
import { EmptyBox, ErrorNote } from "../components/common/load.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field, FieldLabel } from "../components/ui/field.tsx";
import { Input } from "../components/ui/input.tsx";
import type { LoadState } from "../lib/loadState.ts";
import { GatewayApiError } from "./gatewayApi.ts";
import { goTo } from "./navigate.ts";
import { GatewayRow } from "./GatewayRow.tsx";

export interface GatewayGithubProps {
  status: LoadState<GatewayUiGithub>;
  clear: () => Promise<void>;
  /** Starts "Connect GitHub": the authorize URL to go to next. */
  connect: () => Promise<string>;
  /** Asks for read access to one repository; never answers a token. */
  check: (
    request: GatewayUiGithubCheckRequest,
  ) => Promise<GatewayUiGithubCheck>;
  /** Where the browser goes; the page's own address by default. */
  navigate?: (url: string) => void;
  /** The connect's result code the page came back with, if any. */
  callback?: GatewayUiGithubConnectCode | undefined;
}

/**
 * Fixed text per callback code; success comes back without one. Each describes
 * the failed attempt only: an earlier connection may still be stored and work.
 */
const CONNECT_TEXT: Record<GatewayUiGithubConnectCode, string> = {
  rejected: "GitHub did not accept the connection. Connect GitHub again.",
  unreachable: "GitHub could not be reached to finish connecting. Try again.",
  not_configured:
    "This gateway is not set up to finish GitHub connections. Ask its operator.",
  vault_locked:
    "The gateway's vault is locked, so the connection could not be kept. Ask its operator to unlock it.",
  vault_unavailable:
    "The gateway's vault did not answer, so the connection may not have been kept. Reload the page to see it.",
  busy: "Another change to this connection was still running. Connect GitHub again.",
  signed_out:
    "Your gateway session ended before GitHub answered. Sign in, then use Connect GitHub again.",
  expired:
    "Connecting took too long or was started in another browser. Connect GitHub again.",
  failed: "Connecting GitHub did not finish. Try again.",
  denied:
    "Access was not granted on GitHub's page, so GitHub was not connected.",
};

/** Fixed text per stored-record problem. */
const PROBLEM_TEXT: Record<GatewayUiGithubProblem, string> = {
  vault_locked:
    "The gateway's vault is locked, so the connection cannot be read now.",
  vault_unavailable:
    "The gateway's vault did not answer. Reload the page to try again.",
  invalid: "The stored connection cannot be read. Connect GitHub again.",
  rejected: "GitHub no longer accepts this connection. Connect GitHub again.",
};

/** Fixed text per connect or Disconnect refusal. */
const REFUSAL_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  vault_locked: "The gateway's vault is locked. Ask its operator to unlock it.",
  vault_unavailable: "The gateway's vault did not answer. Try again.",
  integration_busy:
    "Another change to this connection is still running. Try again.",
  signed_out: "Your session ended. Reload the page and sign in again.",
  unavailable:
    "The gateway has too many sign-ins in progress. Try again in a few minutes.",
};

/** What a malformed repository, typed or refused, reads as. */
const REPOSITORY_FORMAT_TEXT = "Enter the repository as owner/repo.";

/** Fixed text per check refusal; nothing from the gateway's answer is shown. */
const CHECK_TEXT: Partial<Record<GatewayUiError["error"], string>> = {
  integration_sign_in_required: "Connect GitHub first, then check again.",
  integration_denied:
    "GitHub grants you no read access to this repository: you have no access to it, or the gateway's GitHub app is not installed there.",
  integration_rejected:
    "GitHub no longer accepts your connection. Connect GitHub again.",
  integration_invalid: REPOSITORY_FORMAT_TEXT,
  bad_request: REPOSITORY_FORMAT_TEXT,
  vault_locked: "The gateway's vault is locked. Ask its operator to unlock it.",
  vault_unavailable:
    "The gateway's vault did not answer, so access could not be checked. Try again.",
  integration_busy: "A check is still running. Wait for it, then try again.",
  signed_out: "Your session ended. Reload the page and sign in again.",
};

function refusalText(
  texts: Partial<Record<GatewayUiError["error"], string>>,
  err: unknown,
  fallback: string,
): string {
  const code = err instanceof GatewayApiError ? err.code : undefined;
  return (code && texts[code]) || fallback;
}

/** `owner/repo` as typed, when both names pass the gateway's rules. */
function repositoryOf(text: string): GatewayUiGithubCheckRequest | undefined {
  const parts = text.trim().split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  return isGatewayUiGithubRepoName(owner, repo)
    ? { owner: owner!, repo: repo! }
    : undefined;
}

/** The local wall-clock time, `HH:MM`. */
function clockTime(epochMs: number): string {
  const at = new Date(epochMs);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(at.getHours())}:${two(at.getMinutes())}`;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; repository: string; expiresAt: number }
  | { kind: "error"; message: string };

export function GatewayGithub({
  status,
  clear,
  connect,
  check,
  navigate = goTo,
  callback,
}: GatewayGithubProps) {
  const [clearing, setClearing] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  /** A connect start is in flight or the browser is leaving for GitHub. */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** The callback's note stays until the user acts on the connection. */
  const [callbackShown, setCallbackShown] = useState(true);
  /** The write in flight, set before any re-render can disable a control. */
  const writing = useRef<"clear" | "start" | null>(null);
  const [repository, setRepository] = useState("");
  const [checkState, setCheckState] = useState<CheckState>({ kind: "idle" });
  /** A check in flight, set before any re-render can disable the button. */
  const checking = useRef(false);

  // Back from GitHub can restore this page from the back/forward cache with
  // the start still marked pending: the user left GitHub by choice, so the
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

  const startConnect = () => {
    if (writing.current) return;
    writing.current = "start";
    setStarting(true);
    setStartError(null);
    setCallbackShown(false);
    connect().then(
      (url) => {
        // Stays busy: the browser is leaving for GitHub.
        navigate(url);
      },
      (err: unknown) => {
        writing.current = null;
        setStarting(false);
        setStartError(
          refusalText(
            REFUSAL_TEXT,
            err,
            "Connect GitHub could not start. Try again.",
          ),
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
        setCheckState({ kind: "idle" });
      },
      (err: unknown) => {
        writing.current = null;
        setClearBusy(false);
        setClearError(
          refusalText(
            REFUSAL_TEXT,
            err,
            "The connection could not be removed. Try again.",
          ),
        );
      },
    );
  }, [clear]);

  const runCheck = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (checking.current) return;
    const request = repositoryOf(repository);
    if (!request) {
      setCheckState({ kind: "error", message: REPOSITORY_FORMAT_TEXT });
      return;
    }
    checking.current = true;
    setCheckState({ kind: "running" });
    check(request).then(
      (answer) => {
        checking.current = false;
        setCheckState({
          kind: "ok",
          repository: answer.repository,
          expiresAt: answer.expiresAt,
        });
      },
      (err: unknown) => {
        checking.current = false;
        setCheckState({
          kind: "error",
          message: refusalText(
            CHECK_TEXT,
            err,
            "Access could not be checked. Try again.",
          ),
        });
      },
    );
  };

  // Refreshing or a failed refresh keeps what is on screen.
  const current =
    status.status === "idle" || status.status === "loading"
      ? undefined
      : status.data;
  // Until the gateway says it offers GitHub, the section stays away: a
  // gateway without it shows nothing at all.
  if (status.status !== "error" && !current?.offered) return null;

  const busy = clearBusy || starting;
  const stored = Boolean(current?.connected || current?.problem);

  return (
    <section
      aria-label="GitHub"
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <h2 className="-mx-5 border-b border-border px-5 pb-3 text-base font-semibold">
        GitHub
      </h2>
      {status.status === "error" ? (
        <ErrorNote message="The GitHub connection could not be loaded. Reload the page to try again." />
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
                ? `Connected as ${current.login ?? "your GitHub account"}`
                : "GitHub connection"
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
            menuLabel="More actions for the GitHub connection"
            menu={[
              {
                id: "connect",
                label: "Connect again",
                icon: <LogIn />,
                disabled: busy,
                onSelect: startConnect,
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
        <EmptyBox>GitHub is not connected.</EmptyBox>
      ) : null}
      {current ? (
        <form
          aria-label="Check repository access"
          className="flex flex-col gap-2"
          onSubmit={runCheck}
        >
          <Field>
            <FieldLabel htmlFor="gateway-github-repository">
              Check repository access
            </FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="gateway-github-repository"
                value={repository}
                maxLength={200}
                placeholder="owner/repo"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setRepository(event.target.value)}
              />
              <Button
                type="submit"
                variant="outline"
                busy={checkState.kind === "running"}
                disabled={checkState.kind === "running"}
              >
                Check
              </Button>
            </div>
          </Field>
          {checkState.kind === "ok" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {`Read access to ${checkState.repository} works; token valid until ${clockTime(checkState.expiresAt)}`}
            </p>
          ) : null}
          {checkState.kind === "error" ? (
            <ErrorNote message={checkState.message} />
          ) : null}
        </form>
      ) : null}
      {current && !stored ? (
        <div className="-mx-5 -mb-5 mt-1 flex items-center gap-3 rounded-b-xl border-t border-border bg-muted/40 px-5 py-4">
          <h3 className="flex-1 text-sm font-semibold">Your GitHub account</h3>
          <Button
            type="button"
            variant="outline"
            busy={starting}
            disabled={busy}
            onClick={startConnect}
          >
            <LogIn />
            Connect GitHub
          </Button>
        </div>
      ) : null}
      {clearing ? (
        <ConfirmDialog
          title="Disconnect GitHub?"
          body="Disconnecting deletes the gateway's GitHub sign-in. The app stays under GitHub Settings → Applications → Authorized GitHub Apps until you revoke it there."
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
