/**
 * @module toast
 * @purpose Tiny global toast store for transient, non-blocking confirmations (for
 *   example "Copied to clipboard"). Toasts auto-dismiss and are rendered by the
 *   single `ToastViewport` mounted at the app root.
 * @useWhen You need lightweight ephemeral feedback for a user action that has no
 *   persistent state.
 * @intent Decoupled from React tree: call `showToast(...)` from anywhere (event
 *   handlers, helpers) without threading a context provider through props.
 */

export type ToastTone = "default" | "success" | "error";

/**
 * Two durations, not a number per call site (`docs/messaging.md`). How long a
 * toast stays is a function of what it asks of the reader, and nothing else.
 */

/** A receipt: the act is done and there is nothing to do about it. */
export const TOAST_BRIEF_MS = 2500;

/**
 * Something the reader has to finish reading, or act on before it goes: a
 * failure, or a toast carrying Undo.
 */
export const TOAST_DWELL_MS = 7000;

/**
 * The Backlog's project-assignment slot. Its Undo receipt and that write's
 * FAILURE are one message to the user, so they share a key and either replaces
 * the other.
 *
 * The key is named here, in the module that owns the channel, because the two
 * are raised from different places for the same reason the whole model exists:
 * the receipt follows the write landing, and the failure is said at the
 * ARRIVING message (`docs/messaging.md`). Two literals would drift, and a drift
 * here is a failure toast sitting under a stale Undo.
 */
export const PROJECT_ASSIGNMENT_TOAST_KEY = "backlog-project-assignment-undo";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: number;
  key?: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
/**
 * The pending auto-dismiss per toast id. A KEYED toast reuses its predecessor's
 * id, so without this the replaced toast's timer stays armed and fires against
 * the replacement — a second failure arriving late in the first one's dwell
 * would vanish almost immediately, which is worst exactly when failures are
 * repeating.
 */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number) {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): Toast[] {
  return toasts;
}

export function dismissToast(id: number) {
  clearTimer(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function dismissToastKey(key: string) {
  for (const toast of toasts) if (toast.key === key) clearTimer(toast.id);
  const next = toasts.filter((toast) => toast.key !== key);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function showToast(
  message: string,
  opts?: {
    tone?: ToastTone;
    durationMs?: number;
    key?: string;
    action?: ToastAction;
  },
): number {
  const existingId = opts?.key
    ? toasts.find((toast) => toast.key === opts.key)?.id
    : undefined;
  const id = existingId ?? nextId++;
  // Replacing under the same key restarts the dwell: the new message has not
  // been read yet, whatever was left of its predecessor's time.
  clearTimer(id);
  const toast: Toast = {
    id,
    ...(opts?.key !== undefined ? { key: opts?.key } : {}),
    message,
    tone: opts?.tone ?? "default",
    ...(opts?.action !== undefined ? { action: opts?.action } : {}),
  };
  toasts = opts?.key
    ? [...toasts.filter((item) => item.key !== opts.key), toast]
    : [...toasts, toast];
  emit();
  const duration = opts?.durationMs ?? TOAST_BRIEF_MS;
  if (duration > 0 && typeof window !== "undefined") {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        dismissToast(id);
      }, duration),
    );
  }
  return id;
}
