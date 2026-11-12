/**
 * One secret the gateway just created (an enrollment code or an MCP token),
 * shown once with a Copy button (Task-1405). The caller holds the secret only
 * in this dialog's state and drops it when Done closes the dialog; the gateway
 * never answers it again.
 */
import type { ReactNode } from "react";
import { CopyableText } from "../components/common/CopyableText.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.tsx";

export interface GatewaySecretDialogProps {
  title: string;
  /** The secret's name, for the field and its Copy button. */
  label: string;
  secret: string;
  /** What to do with it. */
  children: ReactNode;
  onDone: () => void;
}

export function GatewaySecretDialog({
  title,
  label,
  secret,
  children,
  onDone,
}: GatewaySecretDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDone();
      }}
    >
      <DialogContent aria-label={title} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Shown only once. Copy it now: the gateway cannot show it again.
          </DialogDescription>
        </DialogHeader>
        <CopyableText
          value={secret}
          label={label}
          copyLabel={`Copy ${label.toLowerCase()}`}
          copiedLabel={`${label} copied`}
        />
        <div className="text-sm text-muted-foreground">{children}</div>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
