import type { CredentialProfileSummary } from "@assistant/shared";
import { useAccountLogin } from "../hooks/useAccountLogin.ts";
import { AccountLoginDialogView } from "./AccountLoginDialogView.tsx";

/**
 * Pandeck's login dialog for a Claude or OpenAI account: the transport-free
 * view over this server's login socket. Mounting it starts or joins the
 * account's login. A running login leaves only through Cancel, which closes
 * the dialog once the hook proves this run was cancelled by it (Close appears
 * meanwhile); closing never cancels.
 */
export function AccountLoginDialog({
  profile,
  onFinished,
  onClose,
}: {
  profile: CredentialProfileSummary;
  onFinished: () => void;
  onClose: () => void;
}) {
  const login = useAccountLogin(profile.id, onFinished);
  return (
    <AccountLoginDialogView
      provider={profile.provider === "claude" ? "claude" : "openai-codex"}
      accountName={profile.name}
      status={login.status}
      output={login.output}
      device={login.device}
      error={login.error}
      cancelUnconfirmed={login.cancelUnconfirmed}
      cancelling={login.cancelling}
      cancelledHere={login.cancelledHere}
      submit={login.submit}
      cancel={login.cancel}
      onClose={onClose}
    />
  );
}
