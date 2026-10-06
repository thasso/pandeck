import { useMemo, useState, type SyntheticEvent } from "react";
import { CheckCircle2, ChevronDown, ExternalLink, X } from "lucide-react";
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

/**
 * @component ClaudeLoginTerminal
 * @purpose Guides a Pandeck-managed Claude sign-in outside chat.
 * @useWhen Connecting or reconnecting an isolated Claude account.
 * @intent Lead with the browser authorization and optional code; keep raw CLI
 * output behind a disclosure for troubleshooting, never in the chat transcript.
 */
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
    if (!value || !submit(value)) return;
    setCode("");
    setSubmitted(true);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Sign in with ${profile.name}`}
    >
      <div className="flex max-h-[95dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-line bg-panel shadow-2xl sm:max-h-[85dvh] sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-body font-semibold text-fg">
              Sign in with Claude
            </h3>
            <p className="mt-1 text-caption text-muted">
              Connect your Claude account to Pandeck.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-fg"
            aria-label="Close sign-in dialog"
            title="Close (sign-in continues)"
          >
            <X size={17} />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-5">
          {status === "connecting" ? (
            <>
              <p className="text-caption text-fg">
                Authorize Pandeck in the Claude page, then return here.
              </p>
              {authorizationUrl ? (
                <a
                  href={authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-caption font-medium text-accent-fg hover:opacity-90"
                >
                  Open Claude sign-in <ExternalLink size={14} />
                </a>
              ) : (
                <p
                  role="status"
                  className="mt-4 flex items-center gap-2 text-caption text-muted"
                >
                  <Spinner size="sm" /> Preparing the sign-in link…
                </p>
              )}

              <form onSubmit={submitCode} className="mt-5 space-y-2">
                <label
                  htmlFor={`claude-login-code-${profile.id}`}
                  className="text-caption font-medium text-fg"
                >
                  Code from Claude{" "}
                  <span className="font-normal text-muted">(if requested)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    id={`claude-login-code-${profile.id}`}
                    type="password"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="Paste code or callback URL"
                    className="settings-input min-w-0 flex-1"
                  />
                  <button
                    type="submit"
                    disabled={!code.trim()}
                    className="settings-button-primary disabled:opacity-40"
                  >
                    Continue
                  </button>
                </div>
                {submitted ? (
                  <p
                    role="status"
                    className="flex items-center gap-1.5 text-caption text-muted"
                  >
                    <Spinner size="sm" /> Checking your sign-in…
                  </p>
                ) : null}
              </form>
              {error ? (
                <p role="status" className="mt-3 text-caption text-warning">
                  {error}
                </p>
              ) : null}
            </>
          ) : status === "ready" ? (
            <div className="flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2 text-caption text-success">
              <CheckCircle2 size={15} /> Claude is connected.
            </div>
          ) : (
            <div
              role="status"
              className={`rounded-lg px-3 py-2 text-caption ${status === "cancelled" ? "bg-raised text-muted" : "bg-danger-soft text-danger"}`}
            >
              {error ??
                (status === "cancelled"
                  ? "Sign-in cancelled."
                  : "Claude sign-in failed.")}
            </div>
          )}

          {status !== "ready" ? (
            <details className="mt-5 border-t border-line pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-caption text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
                Technical details <ChevronDown size={14} aria-hidden="true" />
              </summary>
              <pre className="mt-3 whitespace-pre-wrap break-all rounded-lg bg-surface p-3 font-mono text-caption text-muted">
                {output || "Starting Claude sign-in…"}
              </pre>
            </details>
          ) : null}
        </div>

        <div className="flex justify-end border-t border-line px-5 py-3">
          {status === "connecting" ? (
            <button
              type="button"
              onClick={cancel}
              className="settings-button text-muted"
            >
              Cancel sign-in
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="settings-button-primary"
            >
              {status === "ready" ? "Done" : "Close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
