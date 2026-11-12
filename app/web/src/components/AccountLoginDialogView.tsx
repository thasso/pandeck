/**
 * The login dialog for a Claude or OpenAI account, with its transport state
 * supplied by its host: Pandeck's Settings (`AccountLoginDialog.tsx`) and the
 * gateway's page each render it over their own login API. It imports no
 * transport: only React, icons, `ui/` and three `common/` leaves
 * (`AccountLoginDialogView.test.tsx` pins this), so the gateway bundle stays
 * small.
 *
 * Claude shows the official CLI's output, its authorization link and a paste
 * field; OpenAI shows its verification link and one-time code. Both offer
 * Cancel login while the login runs; Close (Done once signed in) never
 * cancels.
 */
import { useId, useMemo, useState, type SyntheticEvent } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Terminal,
  X,
} from "lucide-react";
import type {
  AccountLoginDevice,
  AccountLoginProvider,
  AccountLoginStatus,
} from "@assistant/shared";
import { ErrorNote, Spinner } from "./common/load.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent } from "./ui/card.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Field, FieldDescription, FieldLabel } from "./ui/field.tsx";
import { Input } from "./ui/input.tsx";

export function claudeLoginAuthorizationUrl(
  output: string,
): string | undefined {
  return output.match(
    /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/,
  )?.[0];
}

export interface AccountLoginDialogViewProps {
  provider: AccountLoginProvider;
  accountName: string;
  status: AccountLoginStatus;
  /** Claude's CLI output; empty for OpenAI. */
  output: string;
  /** OpenAI's verification link and code, once known. */
  device?: AccountLoginDevice | undefined;
  error?: string | undefined;
  /** Claude's pasted code; answers whether it was sent. */
  submit?: ((code: string) => boolean) | undefined;
  cancel: () => void;
  onClose: () => void;
}

const PROVIDER_LABEL: Record<AccountLoginProvider, string> = {
  claude: "Claude",
  "openai-codex": "OpenAI",
};

export function AccountLoginDialogView({
  provider,
  accountName,
  status,
  output,
  device,
  error,
  submit,
  cancel,
  onClose,
}: AccountLoginDialogViewProps) {
  const label = PROVIDER_LABEL[provider];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label={`Connect ${accountName}`}
        showCloseButton={false}
        className="max-h-dvh overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {provider === "claude" ? <Terminal /> : <KeyRound />}
            Connect {accountName}
          </DialogTitle>
          <DialogDescription>
            {provider === "claude"
              ? "Official Claude CLI · profile-isolated"
              : "OpenAI device-code sign-in"}
          </DialogDescription>
          <IconButton
            label={`Close ${label} login`}
            onClick={onClose}
            className="absolute right-2 top-2"
          >
            <X />
          </IconButton>
        </DialogHeader>
        {provider === "claude" ? (
          <ClaudeStep status={status} output={output} submit={submit} />
        ) : (
          <OpenAiStep status={status} device={device} />
        )}
        {status === "ready" ? (
          <Badge variant="success">
            <CheckCircle2 />
            {label} is connected for this account.
          </Badge>
        ) : status === "cancelled" ? (
          <p className="text-sm text-muted-foreground">
            {error ?? "Login cancelled."}
          </p>
        ) : status === "error" ? (
          <ErrorNote message={error ?? `${label} login failed.`} />
        ) : null}
        <DialogFooter>
          {status === "connecting" && (
            <Button variant="outline" onClick={cancel}>
              Cancel login
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {status === "ready" ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClaudeStep({
  status,
  output,
  submit,
}: {
  status: AccountLoginStatus;
  output: string;
  submit?: ((code: string) => boolean) | undefined;
}) {
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const codeId = useId();
  const authorizationUrl = useMemo(
    () => claudeLoginAuthorizationUrl(output),
    [output],
  );
  const submitCode = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || !submit?.(value)) return;
    setCode("");
    setSubmitted(true);
  };
  return (
    <>
      <Card>
        <CardContent>
          <pre className="max-h-80 min-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-sm">
            {output || "Starting Claude login…"}
          </pre>
        </CardContent>
      </Card>
      {authorizationUrl && status === "connecting" && (
        <LinkButton
          variant="default"
          href={authorizationUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open Claude authorization <ExternalLink />
        </LinkButton>
      )}
      {status === "connecting" && (
        <form onSubmit={submitCode} className="space-y-2">
          <Field>
            <FieldLabel htmlFor={codeId}>
              Paste the authorization code
            </FieldLabel>
            <FieldDescription>
              After signing in, Claude shows a code or callback URL. Paste it
              here; Pandeck forwards it directly to the CLI and never displays
              or stores it.
            </FieldDescription>
            <div className="flex gap-2">
              <Input
                id={codeId}
                type="password"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Authorization code or callback URL"
                className="min-w-0 flex-1"
              />
              <Button type="submit" disabled={!code.trim()}>
                Submit
              </Button>
            </div>
          </Field>
          {/* The CLI answers this one; Submit has already emptied itself. */}
          {submitted && (
            <p
              role="status"
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
            >
              <Spinner size="sm" />
              Code submitted; waiting for Claude…
            </p>
          )}
        </form>
      )}
    </>
  );
}

function OpenAiStep({
  status,
  device,
}: {
  status: AccountLoginStatus;
  device?: AccountLoginDevice | undefined;
}) {
  if (status !== "connecting") return null;
  if (!device)
    return (
      <p
        role="status"
        className="flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Spinner size="sm" />
        Starting the OpenAI sign-in…
      </p>
    );
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          Open{" "}
          <a
            href={device.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline"
          >
            {device.verificationUri}
          </a>{" "}
          and enter this code:
        </p>
        <p className="font-mono text-xl font-semibold tracking-wider">
          {device.userCode}
        </p>
        <LinkButton
          variant="default"
          href={device.verificationUri}
          target="_blank"
          rel="noreferrer"
        >
          Open OpenAI sign-in <ExternalLink />
        </LinkButton>
      </CardContent>
    </Card>
  );
}
