import { useMemo, useState, type SyntheticEvent } from "react";
import { CheckCircle2, ExternalLink, Terminal, X } from "lucide-react";
import type { CredentialProfileSummary } from "@assistant/shared";
import { useClaudeLoginTerminal } from "../hooks/useClaudeLoginTerminal.ts";
import { Spinner } from "./ui/load.tsx";

export function claudeLoginAuthorizationUrl(
  output: string,
): string | undefined {
  return output.match(
    /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/,
  )?.[0];
}

/** Mobile-safe browser terminal around the official `claude auth login` process. */
export function ClaudeLoginTerminal({
  profile,
  onFinished,
  onClose,
}: {
  profile: CredentialProfileSummary;
  onFinished: () => void;
  onClose: () => void;
}) {
  const { status, output, error, submit, cancel } = useClaudeLoginTerminal(
    profile.id,
    onFinished,
  );
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const authorizationUrl = useMemo(
    () => claudeLoginAuthorizationUrl(output),
    [output],
  );
  const submitCode = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = code.trim();
    if (!value) return;
    if (!submit(value)) return;
    setCode("");
    setSubmitted(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${profile.name}`}
    >
      <div className="flex max-h-[95dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-2xl sm:max-h-[85dvh] sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Terminal size={17} className="shrink-0 text-primary" />
            <div className="min-w-0">
              <h3 className="truncate text-body font-semibold">
                Connect {profile.name}
              </h3>
              <p className="text-caption text-faint">
                Official Claude CLI · profile-isolated
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-raised hover:text-fg"
            aria-label="Close Claude login"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="rounded-xl border border-line bg-[#111318] p-3 text-caption text-[#e5e7eb] shadow-inner">
            <pre className="max-h-[34dvh] min-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">
              {output || "Starting Claude login…"}
            </pre>
          </div>

          {authorizationUrl && status === "connecting" ? (
            <a
              href={authorizationUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-caption font-medium text-primary-foreground"
            >
              Open Claude authorization <ExternalLink size={14} />
            </a>
          ) : null}

          {status === "connecting" ? (
            <form onSubmit={submitCode} className="mt-4 space-y-2">
              <label
                htmlFor={`claude-login-code-${profile.id}`}
                className="text-caption font-medium text-fg"
              >
                Paste the authorization code
              </label>
              <p className="text-caption text-faint">
                After signing in, Claude shows a code or callback URL. Paste it
                here; PA forwards it directly to the CLI and never displays or
                stores it.
              </p>
              <div className="flex gap-2">
                <input
                  id={`claude-login-code-${profile.id}`}
                  type="password"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Authorization code or callback URL"
                  className="settings-input min-w-0 flex-1 font-mono"
                />
                <button
                  type="submit"
                  disabled={!code.trim()}
                  className="settings-button-primary disabled:opacity-40"
                >
                  Submit
                </button>
              </div>
              {/* The CLI answers this one, not a request we could busy a button
                  on — Submit has already emptied (and so disabled) itself — so
                  the wait is a status region under the form. */}
              {submitted ? (
                <p
                  role="status"
                  className="flex items-center gap-1.5 text-caption text-muted-foreground"
                >
                  <Spinner size="sm" />
                  Code submitted; waiting for Claude…
                </p>
              ) : null}
            </form>
          ) : status === "ready" ? (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-caption text-emerald-300">
              <CheckCircle2 size={15} />
              Claude is connected for this profile.
            </div>
          ) : (
            <div
              className={`mt-4 rounded-lg border px-3 py-2 text-caption ${status === "cancelled" ? "border-line text-muted-foreground" : "border-danger/30 bg-danger/10 text-danger"}`}
            >
              {error ??
                (status === "cancelled"
                  ? "Login cancelled."
                  : "Claude login failed.")}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          {status === "connecting" ? (
            <button
              type="button"
              onClick={cancel}
              className="settings-button text-danger"
            >
              Cancel login
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="settings-button">
            {status === "ready" ? "Done" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
