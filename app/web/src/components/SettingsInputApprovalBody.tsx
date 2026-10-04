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
import { useState } from "react";
import { ExternalLink, Save, XCircle } from "lucide-react";
import type { SettingsInputApprovalBody as SettingsInputBodyData } from "@assistant/shared";
import { settingDescriptor } from "@assistant/shared/settingsRegistry";
import { serverHttpOrigin } from "../lib/serverOrigin.ts";
import { Spinner } from "./ui/load.tsx";

export function SettingsInputApprovalBody({
  body,
  active,
  busy,
  onSubmit,
  onDismiss,
}: {
  body: SettingsInputBodyData;
  /** The card is waiting on the user and no decision is in flight. */
  active: boolean;
  /** Which of the card's actions is waiting on the server's echo. */
  busy: "submit" | "dismiss" | null;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
}) {
  const [value, setValue] = useState("");
  const [connecting, setConnecting] = useState(false);
  const connectPath = settingDescriptor(body.path)?.connectPath;
  const pending = active || busy !== null;

  const submit = () => {
    const typed = value.trim();
    if (!typed) return;
    onSubmit(typed);
    // The value lives here only until it is sent.
    setValue("");
  };

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
    <div className="space-y-2">
      {body.reason && <div className="text-caption text-fg">{body.reason}</div>}
      {pending && body.mode === "secret" && (
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
      )}
      {pending && (
        <div className="text-caption text-faint">
          {body.mode === "secret"
            ? "The value goes straight to the server. The assistant never sees it, and this card does not keep it."
            : connecting
              ? "Approve access in the window that opened. This card updates once the account is connected."
              : "Opens the sign-in in a new window. This card updates once the account is connected."}
        </div>
      )}
      {pending && (
        <div className="flex items-center justify-end gap-2 pt-1">
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
          {body.mode === "secret" ? (
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
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={!active || !connectPath}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1 text-caption font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              <ExternalLink size={12} />
              {connecting ? "Open again" : "Connect"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
