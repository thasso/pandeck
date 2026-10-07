import { useMemo, useState, type SyntheticEvent } from "react";
import { CheckCircle2, ExternalLink, Terminal, X } from "lucide-react";
import type { CredentialProfileSummary } from "@assistant/shared";
import { useClaudeLoginTerminal } from "../hooks/useClaudeLoginTerminal.ts";
import { ErrorNote, Spinner } from "./common/load.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { IconButton } from "./common/IconButton.tsx";
import { LinkButton } from "./common/LinkButton.tsx";

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
  const terminal = useClaudeLoginTerminal(profile.id, onFinished);
  return (
    <ClaudeLoginTerminalView
      profile={profile}
      onClose={onClose}
      {...terminal}
    />
  );
}

/** The same login dialog, with transport state supplied by its host. */
export function ClaudeLoginTerminalView({
  profile,
  onClose,
  status,
  output,
  error,
  submit,
  cancel,
}: {
  profile: CredentialProfileSummary;
  onClose: () => void;
} & ReturnType<typeof useClaudeLoginTerminal>) {
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
  const codeId = `claude-login-code-${profile.id}`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-label={`Connect ${profile.name}`}
        showCloseButton={false}
        className="max-h-dvh overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal />
            Connect {profile.name}
          </DialogTitle>
          <DialogDescription>
            Official Claude CLI · profile-isolated
          </DialogDescription>
          <IconButton
            label="Close Claude login"
            onClick={onClose}
            className="absolute right-2 top-2"
          >
            <X />
          </IconButton>
        </DialogHeader>
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
        {status === "connecting" ? (
          <form onSubmit={submitCode} className="space-y-2">
            <Field>
              <FieldLabel htmlFor={codeId}>
                Paste the authorization code
              </FieldLabel>
              <FieldDescription>
                After signing in, Claude shows a code or callback URL. Paste it
                here; PA forwards it directly to the CLI and never displays or
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
        ) : status === "ready" ? (
          <Badge variant="success">
            <CheckCircle2 />
            Claude is connected for this profile.
          </Badge>
        ) : status === "cancelled" ? (
          <p className="text-sm text-muted-foreground">
            {error ?? "Login cancelled."}
          </p>
        ) : (
          <ErrorNote message={error ?? "Claude login failed."} />
        )}
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
