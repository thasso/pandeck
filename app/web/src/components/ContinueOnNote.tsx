/**
 * @component ContinueOnNote
 * @purpose A session's terminal quota or rate-limit failure with its
 *   "Continue on <model>" offer: the default model as the action, the other
 *   offered models in a menu, and Dismiss. Rendered above the composer in place
 *   of the plain failure note (`docs/session-runtime-switching.md`).
 * @useWhen The viewed session's failure carries `continueOn` choices.
 * @avoidWhen Any other failure: `ErrorNote` is the plain form.
 */
import { ChevronDown, CircleAlert } from "lucide-react";
import type { SessionContinueChoice } from "@assistant/shared";
import { Alert, AlertAction, AlertDescription } from "./ui/alert.tsx";
import { Button } from "./ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ContinueOnNote({
  message,
  choices,
  busy,
  onContinue,
  onDismiss,
}: {
  message: string;
  /** The default first; never empty. */
  choices: readonly SessionContinueChoice[];
  /** The continue this browser sent has not been answered yet. */
  busy: boolean;
  onContinue: (choice: SessionContinueChoice) => void;
  onDismiss: () => void;
}) {
  const [preferred, ...others] = choices;
  if (!preferred) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertDescription>{message}</AlertDescription>
      <AlertAction className="flex gap-1">
        <Button
          size="xs"
          variant="outline"
          busy={busy}
          onClick={() => onContinue(preferred)}
        >
          Continue on {preferred.name}
        </Button>
        {others.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Continue on another model"
                  title="Continue on another model"
                  disabled={busy}
                />
              }
            >
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {others.map((choice) => (
                <DropdownMenuItem
                  key={`${choice.provider}/${choice.id}`}
                  onClick={() => onContinue(choice)}
                >
                  Continue on {choice.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button size="xs" variant="outline" disabled={busy} onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}
