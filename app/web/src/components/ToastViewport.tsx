import { useSyncExternalStore } from "react";
import { Check, Info, X } from "lucide-react";

import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type ToastTone,
} from "../lib/toast.ts";

/**
 * @component ToastViewport
 * @purpose Renders transient global toasts from the `toast` store as a centered
 *   stack near the bottom of the viewport, above the composer.
 * @useWhen Mounted once at the app root. Trigger toasts with `showToast(...)`
 *   (or `copyWithToast`) from anywhere; do not mount this more than once.
 * @avoidWhen Feedback must persist or remain actionable outside the current moment.
 * @intent Low-emphasis, auto-dismissing confirmation; accessible via `aria-live`.
 * @related lib/toast.ts, lib/clipboard.ts
 */
export function ToastViewport() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+var(--app-safe-area-bottom,0px))] z-[60] flex flex-col items-center gap-2 px-3"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          // `items-start` and a rounded RECTANGLE rather than a centred pill:
          // a toast now carries real diagnostics (a failure and the object it
          // was about), and the pill's single truncated line dropped the half
          // of the sentence that said what went wrong. Bounded rather than
          // unbounded — a provider stack trace may not take the screen — with
          // the full text on the element for a pointer.
          className="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-2xl border border-line bg-panel/95 px-3.5 py-2 text-caption text-fg shadow-lg shadow-black/15 backdrop-blur"
        >
          <span className="mt-0.5 shrink-0">
            <ToastIcon tone={toast.tone} />
          </span>
          <span
            title={toast.message}
            className="line-clamp-4 min-w-0 flex-1 break-words"
          >
            {toast.message}
          </span>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                dismissToast(toast.id);
              }}
              className="ml-1 rounded-full bg-accent px-2.5 py-1 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90"
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            title="Dismiss"
            aria-label="Dismiss toast"
            className="-mr-1 ml-1 inline-flex size-5 items-center justify-center rounded-full text-faint transition-colors hover:bg-raised hover:text-fg"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success")
    return <Check size={14} className="shrink-0 text-accent" />;
  if (tone === "error")
    return <Info size={14} className="shrink-0 text-danger" />;
  return <Info size={14} className="shrink-0 text-muted" />;
}
