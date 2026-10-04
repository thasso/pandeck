/**
 * @widget SettingsInputApprovalBody
 * @purpose The detail and controls of a `settingsInput` approval card: the
 *   Personal Assistant asks for a secret or an account connection
 *   ([Task-729](pa://task/729)). A secret is typed here and goes to the server
 *   with the decision; the assistant never sees it, and the card never keeps
 *   it. A connection opens the server's OAuth flow in a popup; the card
 *   resolves itself when the server has stored the grant.
 * @payload `SettingsInputApprovalBody` (`ApprovalCard.body`).
 * @useWhen Rendered by `ApprovalCard` for `body.kind === "settingsInput"`, in
 *   place of the generic Approve/Reject footer.
 */
import { useEffect, useState } from "react";
import { ExternalLink, LogIn, Save, XCircle } from "lucide-react";
import type {
  CredentialProfileSummary,
  SettingsInputApprovalBody as SettingsInputBodyData,
} from "@assistant/shared";
import { settingDescriptor } from "@assistant/shared/settingsRegistry";
import { serverHttpOrigin } from "../lib/serverOrigin.ts";
import {
  fetchCredentialProfiles,
  startOpenAiProfileLogin,
} from "../lib/credentialProfiles.ts";
import { ClaudeLoginTerminal } from "./ClaudeLoginTerminal.tsx";
import { ErrorNote, Spinner } from "./ui/load.tsx";

type Busy = "submit" | "dismiss" | null;

interface ControlProps {
  body: SettingsInputBodyData;
  /** The card is waiting on the user and no decision is in flight. */
  active: boolean;
  /** Which of the card's actions is waiting on the server's echo. */
  busy: Busy;
  onDismiss: () => void;
}

function DismissButton({ active, busy, onDismiss }: ControlProps) {
  return (
    <button
      type="button"
      onClick={onDismiss}
      disabled={!active}
      aria-busy={busy === "dismiss" || undefined}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted hover:bg-surface hover:text-fg disabled:opacity-50"
    >
      {busy === "dismiss" ? <Spinner size="sm" /> : <XCircle size={12} />}
      Dismiss
    </button>
  );
}

/**
 * The secret's field and buttons. Mounted only while the card waits, so the
 * typed value is gone with it once the card is answered, dismissed or
 * replaced; Save and Dismiss also empty it as they act.
 */
function SecretControls(
  props: ControlProps & { onSubmit: (value: string) => void },
) {
  const { body, active, busy, onSubmit, onDismiss } = props;
  const [value, setValue] = useState("");
  const submit = () => {
    const typed = value.trim();
    if (!typed) return;
    setValue("");
    onSubmit(typed);
  };
  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          type="password"
          aria-label={body.label}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={!active}
          placeholder={
            body.wasConfigured
              ? "Paste a new value to replace it"
              : "Paste the value"
          }
          className="min-w-0 flex-1 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-fg placeholder:text-faint disabled:opacity-50"
        />
      </form>
      <div className="text-caption text-faint">
        The value goes straight to the server. The assistant never sees it, and
        this card does not keep it.
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <DismissButton
          {...props}
          onDismiss={() => {
            setValue("");
            onDismiss();
          }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!active || !value.trim()}
          aria-busy={busy === "submit" || undefined}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-caption font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {busy === "submit" ? <Spinner size="sm" /> : <Save size={12} />}
          Save
        </button>
      </div>
    </>
  );
}

function ConnectControls(props: ControlProps) {
  const { body, active } = props;
  const [connecting, setConnecting] = useState(false);
  const connectPath = settingDescriptor(body.path)?.connectPath;
  const connect = () => {
    if (!connectPath) return;
    window.open(
      `${serverHttpOrigin()}${connectPath}`,
      `assistant-${body.section}-oauth`,
      "popup,width=560,height=760",
    );
    setConnecting(true);
  };
  return (
    <>
      <div className="text-caption text-faint">
        {connecting
          ? "Approve access in the window that opened. This card updates once the account is connected."
          : "Opens the sign-in in a new window. This card updates once the account is connected."}
      </div>
      <div className="flex items-center justify-end gap-2 pt-1">
        <DismissButton {...props} />
        <button
          type="button"
          onClick={connect}
          disabled={!active || !connectPath}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-caption font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <ExternalLink size={12} />
          {connecting ? "Open again" : "Connect"}
        </button>
      </div>
    </>
  );
}

/** How often a waiting sign-in card re-reads its account, as the Settings page does. */
const SIGN_IN_POLL_MS = 2500;

/**
 * Signing a Claude or OpenAI account in. OpenAI's device login shows its link
 * and code here; Claude's runs in the official CLI login terminal. The card
 * re-reads the account while it waits; the server resolves the card once the
 * account is signed in.
 */
function SignInControls(props: ControlProps) {
  const { body, active } = props;
  const accountId = body.account?.id;
  const [account, setAccount] = useState<CredentialProfileSummary | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let stopped = false;
    const read = () =>
      fetchCredentialProfiles()
        .then((profiles) => {
          if (stopped) return;
          setAccount(profiles.find((p) => p.id === accountId) ?? null);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!stopped)
            setError(err instanceof Error ? err.message : String(err));
        });
    void read();
    const timer = window.setInterval(() => void read(), SIGN_IN_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [accountId]);

  const signIn = () => {
    if (!account) return;
    if (account.provider === "claude") {
      setTerminalOpen(true);
      return;
    }
    startOpenAiProfileLogin(account.id).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  const verification = account?.setup?.verificationUri;
  const code = account?.setup?.userCode;
  return (
    <>
      {verification && code ? (
        <div className="space-y-1 text-caption text-fg">
          <div>
            Open{" "}
            <a
              href={verification}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              {verification}
            </a>{" "}
            and enter this code:
          </div>
          <div className="font-mono text-body font-semibold tracking-wider">
            {code}
          </div>
        </div>
      ) : (
        <div className="text-caption text-faint">
          {account?.status === "connecting"
            ? "Sign-in in progress. This card updates once the account is signed in."
            : "Runs the provider's own sign-in. The assistant never sees it."}
        </div>
      )}
      {error && <ErrorNote message={error} />}
      <div className="flex items-center justify-end gap-2 pt-1">
        <DismissButton {...props} />
        <button
          type="button"
          onClick={signIn}
          disabled={!active || !account}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-caption font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          <LogIn size={12} />
          {account?.status === "connecting" ? "Sign in again" : "Sign in"}
        </button>
      </div>
      {terminalOpen && account && (
        <ClaudeLoginTerminal
          profile={account}
          onFinished={() => setTerminalOpen(false)}
          onClose={() => setTerminalOpen(false)}
        />
      )}
    </>
  );
}

export function SettingsInputApprovalBody({
  body,
  active,
  busy,
  onSubmit,
  onDismiss,
}: {
  body: SettingsInputBodyData;
  active: boolean;
  busy: Busy;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
}) {
  const waiting = active || busy !== null;
  const controls = { body, active, busy, onDismiss };
  return (
    <div className="space-y-2">
      {body.reason && <div className="text-caption text-fg">{body.reason}</div>}
      {waiting &&
        (body.mode === "secret" ? (
          <SecretControls {...controls} onSubmit={onSubmit} />
        ) : body.mode === "signIn" ? (
          <SignInControls {...controls} />
        ) : (
          <ConnectControls {...controls} />
        ))}
    </div>
  );
}
