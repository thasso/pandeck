import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast as sonner } from "sonner";

import {
  dismissToast,
  getToasts,
  subscribeToasts,
  type Toast,
} from "../lib/toast.ts";
import { Toaster } from "./ui/sonner.tsx";

/**
 * @component ToastViewport
 * @purpose Renders transient global toasts from the `toast` store through
 *   shadcn's Sonner toaster, centred near the bottom above the composer.
 * @useWhen Mounted once at the app root. Trigger toasts with `showToast(...)`
 *   (or `copyWithToast`) from anywhere; do not mount this more than once.
 * @intent The store stays the owner of timing, keys and replacement
 *   (`lib/toast.ts`); Sonner only draws what the store holds.
 * @related lib/toast.ts, lib/clipboard.ts
 */
export function ToastViewport() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  const shown = useRef(new Map<number, Toast>());
  useEffect(() => {
    const live = new Set(toasts.map((item) => item.id));
    for (const id of shown.current.keys()) {
      if (live.has(id)) continue;
      sonner.dismiss(id);
      shown.current.delete(id);
    }
    for (const item of toasts) {
      if (shown.current.get(item.id) === item) continue;
      shown.current.set(item.id, item);
      const show =
        item.tone === "success"
          ? sonner.success
          : item.tone === "error"
            ? sonner.error
            : sonner;
      show(item.message, {
        id: item.id,
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        onDismiss: () => dismissToast(item.id),
        ...(item.action
          ? {
              action: {
                label: item.action.label,
                onClick: () => {
                  item.action?.onClick();
                  dismissToast(item.id);
                },
              },
            }
          : {}),
      });
    }
  }, [toasts]);
  return (
    <Toaster
      position="bottom-center"
      offset={{ bottom: "calc(5.5rem + var(--app-safe-area-bottom, 0px))" }}
      style={{ zIndex: 60 }}
    />
  );
}
