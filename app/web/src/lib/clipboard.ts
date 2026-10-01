/**
 * @module clipboard
 * @purpose Copy text to the clipboard with a fallback that also works outside
 *   secure contexts. The async Clipboard API (`navigator.clipboard`) is only
 *   available over HTTPS or localhost, so on mobile devices hitting the dev
 *   server over a plain-HTTP LAN IP it is `undefined` and copy silently fails.
 *   This helper falls back to a legacy `execCommand("copy")` selection path.
 * @useWhen Any UI "copy" affordance. Prefer `copyWithToast` so the user gets a
 *   consistent visual confirmation; use `copyTextToClipboard` when the caller
 *   renders its own success state.
 */

import { showToast, TOAST_DWELL_MS } from "./toast.ts";

/** Legacy copy path for insecure contexts (HTTP LAN IP, older mobile browsers). */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // Keep it off-screen but still selectable; iOS needs it in the DOM and visible-ish.
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.padding = "0";
  textarea.style.border = "none";
  textarea.style.outline = "none";
  textarea.style.boxShadow = "none";
  textarea.style.background = "transparent";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    const selection = window.getSelection();
    const previousRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    textarea.focus();
    textarea.select();
    // iOS Safari ignores select() on readonly textareas; use a Range as well.
    const range = document.createRange();
    range.selectNodeContents(textarea);
    selection?.removeAllRanges();
    selection?.addRange(range);
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    if (previousRange) selection?.addRange(previousRange);
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Copy `text`, returning whether the copy succeeded. Never throws. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permissions or transient failure — fall back to the legacy path.
    }
  }
  return legacyCopy(text);
}

/**
 * Copy `text` and surface a toast confirming success or failure. Returns whether
 * the copy succeeded so callers can also flip a local affordance (e.g. icon).
 */
export async function copyWithToast(
  text: string,
  opts?: { successMessage?: string; errorMessage?: string },
): Promise<boolean> {
  const ok = await copyTextToClipboard(text);
  showToast(
    ok
      ? (opts?.successMessage ?? "Copied to clipboard")
      : (opts?.errorMessage ?? "Couldn't copy to clipboard"),
    {
      tone: ok ? "success" : "error",
      ...(!ok ? { durationMs: TOAST_DWELL_MS } : {}),
    },
  );
  return ok;
}
