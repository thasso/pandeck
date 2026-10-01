/**
 * @module messageAnnounce
 * @purpose Turn a server `notice`/`error` into the one thing the model allows
 *   for an event whose surface is gone: an ephemeral announcement that names
 *   the object it is about (`docs/messaging.md`).
 * @useWhen The app has a server message that no surface on screen owns. A
 *   failure whose object IS in front of the user belongs in place instead —
 *   `ErrorNote` beside the thing that failed, per `loading-states.md`.
 * @intent Pure, so the naming and the durations are testable without a DOM, and
 *   so the one rule that matters here — a message says which object it was
 *   about — cannot be quietly skipped at a call site.
 */
import type { MessageTarget, NoticeSeverity } from "@assistant/shared";
import { paObjectTypeLabel } from "@assistant/shared/objectLinks";
import { TOAST_BRIEF_MS, TOAST_DWELL_MS, type ToastTone } from "./toast.ts";

export interface Announcement {
  message: string;
  tone: ToastTone;
  durationMs: number;
  /**
   * Present only for a targeted message, so a second failure about the same
   * object REPLACES the first rather than stacking a pile the user must
   * dismiss. Untargeted messages cannot be deduplicated: nothing identifies
   * them.
   */
  key?: string;
}

/**
 * How a target is named when the client knows nothing better than its type and
 * id. A bare id is not a name, but it is attribution, and attribution is the
 * thing whose absence made the old global bar useless: "Failed to send prompt"
 * with no way to tell which of twenty sessions it came from.
 */
export function targetName(target: MessageTarget, resolved?: string): string {
  const trimmed = resolved?.trim();
  if (trimmed) return trimmed;
  const label = paObjectTypeLabel(target.type);
  // A collection has no member to name; its type IS the attribution.
  return target.id ? `${label} ${target.id}` : label;
}

/**
 * The message of a failure that is about the session currently in view, or
 * null.
 *
 * This is the model's first question made concrete: such a failure has a home
 * on screen, so it is rendered THERE — above the composer, where the user can
 * act on it — and must not ALSO be announced in passing. Sessions get this
 * first because they carry the great majority of the app's failures, and
 * because an unattributed "Failed to send prompt" is what started the model.
 */
export function failureOnViewedSession(
  failures: Record<string, string> | undefined,
  viewedSessionId: string | null | undefined,
): string | null {
  if (!failures || !viewedSessionId) return null;
  return failures[viewedSessionId] ?? null;
}

export function announceMessage(input: {
  severity: NoticeSeverity;
  message: string;
  target?: MessageTarget;
  /** A human name for the target, where the client holds one (a title). */
  resolvedName?: string;
}): Announcement {
  const { severity, message, target, resolvedName } = input;
  const named = target
    ? `${targetName(target, resolvedName)} — ${message}`
    : message;
  const failing = severity === "error";
  return {
    message: named,
    tone: failing ? "error" : "default",
    // A failure has to be read; anything else is a passing remark.
    durationMs: failing ? TOAST_DWELL_MS : TOAST_BRIEF_MS,
    ...(target ? { key: `message:${target.type}:${target.id ?? ""}` } : {}),
  };
}
