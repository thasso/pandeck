/**
 * The login dialog for a Claude or OpenAI account, with its transport state
 * supplied by its host: Pandeck's Settings (`AccountLoginDialog.tsx`) and the
 * gateway's page each render it over their own login API. It imports no
 * transport: only React, icons, `ui/` and three `common/` leaves
 * (`AccountLoginDialogView.imports.test.ts` pins this), so the gateway bundle
 * stays small.
 *
 * Claude shows its authorization link and a paste field, never the CLI's
 * output; OpenAI shows its verification link and one-time code. Each link also
 * appears as selectable text with a Copy button where the browser offers a
 * clipboard (plain http does not). While the login runs the only way out is
 * Cancel login: no X, and Escape or an outside click does nothing. Close
 * appears as soon as Cancel was pressed, so a cancel the server never confirms
 * cannot trap the user. The host tells which run its Cancel concerns:
 * `cancelling` shows "Cancelling…" for the shown run, and `cancelledHere`
 * closes the dialog once that run ended cancelled by this dialog's Cancel,
 * with no cancelled screen. The dialog stays mounted until then because the
 * host may still have to deliver a latched Cancel. A login cancelled by anyone
 * else (taken over elsewhere, another viewer) keeps its notice and Close; a
 * finished login offers Done (signed in) or Close.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Terminal,
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
  /** Claude's CLI output, read only for its authorization URL and never
   * shown; empty for OpenAI. */
  output: string;
  /** OpenAI's verification link and code, once known. */
  device?: AccountLoginDevice | undefined;
  error?: string | undefined;
  /** An early Cancel could not be tied to this run and was not sent. */
  cancelUnconfirmed?: boolean | undefined;
  /** This dialog's Cancel is latched or sent for the shown run. */
  cancelling?: boolean | undefined;
  /** The shown run ended cancelled by this dialog's Cancel: close silently. */
  cancelledHere?: boolean | undefined;
  /** Claude's pasted code; answers whether it was sent. */
  submit?: ((code: string) => boolean) | undefined;
  cancel: () => void;
  onClose: () => void;
}

const PROVIDER_LABEL: Record<AccountLoginProvider, string> = {
  claude: "Claude",
  "openai-codex": "OpenAI",
};

/** How long the Copy button shows its check after a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

export function AccountLoginDialogView({
  provider,
  accountName,
  status,
  output,
  device,
  error,
  cancelUnconfirmed,
  cancelling: cancellingRun,
  cancelledHere: cancelledHereRun,
  submit,
  cancel,
  onClose,
}: AccountLoginDialogViewProps) {
  const label = PROVIDER_LABEL[provider];
  // Only for the way out: whichever run a Cancel concerned, pressing it must
  // never leave the user without Close.
  const [cancelPressed, setCancelPressed] = useState(false);
  const running = status === "connecting";
  const closable = !running || cancelPressed;
  const cancelling = running && cancellingRun === true && !cancelUnconfirmed;
  const cancelledHere = status === "cancelled" && cancelledHereRun === true;
  const closedRef = useRef(false);
  useEffect(() => {
    if (!cancelledHere || closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [cancelledHere, onClose]);
  return (
    <Dialog
      open
      disablePointerDismissal={!closable}
      onOpenChange={(open) => {
        if (!open && closable) onClose();
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
        </DialogHeader>
        {cancelling ? (
          <p
            role="status"
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
          >
            <Spinner size="sm" />
            Cancelling…
          </p>
        ) : provider === "claude" ? (
          <ClaudeStep status={status} output={output} submit={submit} />
        ) : (
          <OpenAiStep status={status} device={device} />
        )}
        {running && cancelUnconfirmed && (
          <p role="status" className="text-sm text-foreground">
            Cancel not confirmed. Press Cancel again to stop this login.
          </p>
        )}
        {status === "ready" ? (
          <Badge variant="success">
            <CheckCircle2 />
            {label} is connected for this account.
          </Badge>
        ) : status === "cancelled" && !cancelledHere ? (
          <p className="text-sm text-muted-foreground">
            {error ?? "Login cancelled."}
          </p>
        ) : status === "error" ? (
          <ErrorNote message={error ?? `${label} login failed.`} />
        ) : null}
        <DialogFooter>
          {running && (
            <Button
              variant="outline"
              disabled={cancelling}
              onClick={() => {
                setCancelPressed(true);
                cancel();
              }}
            >
              Cancel login
            </Button>
          )}
          {closable && (
            <Button variant="outline" onClick={onClose}>
              {status === "ready" ? "Done" : "Close"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The browser's clipboard writer, absent outside a secure context (http). */
function clipboardWriter(): ((text: string) => Promise<void>) | undefined {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText !== "function") return undefined;
  return (text) => clipboard.writeText(text);
}

/**
 * A login link as read-only, selectable text with a Copy button. Without a
 * clipboard the button is hidden and selecting the text is the fallback.
 */
function CopyableLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const write = clipboardWriter();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    if (!write) return;
    // A refused write (permission, focus), rejected or thrown, leaves the
    // text to select by hand.
    try {
      write(url).then(
        () => setCopied(true),
        () => {},
      );
    } catch {
      // Nothing to report: the field stays selectable.
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={url}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 font-mono"
      />
      {write && (
        <IconButton label={copied ? "Link copied" : "Copy link"} onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
      )}
    </div>
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
  if (status !== "connecting") return null;
  const submitCode = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || !submit?.(value)) return;
    setCode("");
    setSubmitted(true);
  };
  return (
    <>
      {authorizationUrl ? (
        <div className="flex flex-col gap-2">
          <LinkButton
            variant="default"
            href={authorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open Claude authorization <ExternalLink />
          </LinkButton>
          <CopyableLink
            url={authorizationUrl}
            label="Claude authorization link"
          />
        </div>
      ) : (
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Spinner size="sm" />
          Starting Claude login…
        </p>
      )}
      <form onSubmit={submitCode} className="space-y-2">
        <Field>
          <FieldLabel htmlFor={codeId}>Paste the authorization code</FieldLabel>
          <FieldDescription>
            After signing in, Claude shows a code or callback URL. Paste it
            here; Pandeck forwards it directly to the CLI and never displays or
            stores it.
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
        <p className="text-sm">Open the OpenAI sign-in and enter this code:</p>
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
        <CopyableLink
          url={device.verificationUri}
          label="OpenAI sign-in link"
        />
      </CardContent>
    </Card>
  );
}
