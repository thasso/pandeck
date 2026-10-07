import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button, type ButtonProps } from "./Button";
import { GhostIconButton } from "./GhostIconButton.tsx";
import { copyTextToClipboard, copyWithToast } from "../../lib/clipboard.ts";

export interface CopyButtonProps extends Omit<
  ButtonProps,
  "children" | "iconOnly" | "onClick"
> {
  /** Text written to the clipboard when the button is pressed. */
  value: string;
  /** Accessible label / tooltip in the idle state. Defaults to `"Copy"`. */
  label?: string;
  /**
   * Accessible label / tooltip shown briefly after a successful copy.
   * Defaults to `"Copied to clipboard"`.
   */
  copiedLabel?: string;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * A ghost icon button that copies `value` to the clipboard and gives visual
 * feedback: the copy icon swaps to a check in the accent color and the label
 * updates, then reverts after a moment. Copy goes through the app's clipboard
 * helper, which falls back to a legacy path outside secure contexts.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied to clipboard",
  variant = "ghost",
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <Button
      variant={variant}
      iconOnly
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      onClick={handleCopy}
      className={cx(copied && "text-primary", className)}
      {...props}
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </Button>
  );
}

/**
 * @component InlineCopyButton
 * @purpose The copy affordance that sits INSIDE content (under a code block,
 * next to a value in a row): the standard small ghost icon button whose icon
 * swaps to an accent check on success, plus the app's copy toast — the same
 * confirmation the transcript's message copy gives.
 * @useWhen A copy action must not compete with the content around it.
 * @avoidWhen The copy sits in a row of regular controls; use `CopyButton`.
 */
export function InlineCopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
}: {
  /** Text written to the clipboard when the button is pressed. */
  value: string;
  /** Accessible label / tooltip in the idle state. Defaults to `"Copy"`. */
  label?: string;
  /** Accessible label / tooltip shown briefly after a copy. Defaults to `"Copied"`. */
  copiedLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timeout.current), []);

  const handleCopy = useCallback(() => {
    void copyWithToast(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  return (
    <GhostIconButton
      icon={copied ? <Check size={13} /> : <Copy size={13} />}
      label={copied ? copiedLabel : label}
      onClick={handleCopy}
      className={cx(copied && "text-primary", className)}
    />
  );
}
