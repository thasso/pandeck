/**
 * A value as read-only, selectable text with a Copy button: a login link in
 * the login dialog, a one-time code or MCP token on the gateway page. The
 * button exists only where the browser offers a clipboard (plain http does
 * not); selecting the text is the fallback. It imports only React, icons,
 * `ui/input` and `IconButton`, so the gateway bundle may carry it.
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Input } from "../ui/input.tsx";
import { IconButton } from "./IconButton.tsx";

/** How long the Copy button shows its check after a successful copy. */
const COPIED_FEEDBACK_MS = 2000;

/** The browser's clipboard writer, absent outside a secure context (http). */
function clipboardWriter(): ((text: string) => Promise<void>) | undefined {
  const clipboard =
    typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (typeof clipboard?.writeText !== "function") return undefined;
  return (text) => clipboard.writeText(text);
}

export interface CopyableTextProps {
  value: string;
  /** The field's accessible name. */
  label: string;
  /** The button's name before and after a copy. */
  copyLabel: string;
  copiedLabel: string;
}

export function CopyableText({
  value,
  label,
  copyLabel,
  copiedLabel,
}: CopyableTextProps) {
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
      write(value).then(
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
        value={value}
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 font-mono"
      />
      {write && (
        <IconButton label={copied ? copiedLabel : copyLabel} onClick={copy}>
          {copied ? <Check /> : <Copy />}
        </IconButton>
      )}
    </div>
  );
}
