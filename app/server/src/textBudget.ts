/**
 * The app's ONE truncation vocabulary for model-facing text.
 *
 * Bounded context and bounded reads both clip text, and two different markers
 * would make the same signal — "there was more here" — something an agent has to
 * learn twice. The Task-context attachment (`taskContext.ts`) and the bounded
 * `task_read` payload (`tools/tasks/taskTools.ts`) share this one.
 *
 * Clipping counts UTF-16 code units (what `String.length` counts) and appends
 * the marker, so a clipped value is slightly longer than its limit; a caller
 * spending a byte budget charges itself for the result, never for the limit.
 */
export const TRUNCATION_MARKER = "\n…[truncated]";

export interface ClippedText {
  text: string;
  /** True when anything was dropped, so the caller can say so in its payload. */
  truncated: boolean;
}

/** `text` clipped to a `maxChars` head, marked when anything was dropped. */
export function clipText(text: string, maxChars: number): ClippedText {
  if (text.length <= maxChars) return { text, truncated: false };
  // Cutting between a surrogate pair would emit a lone surrogate, which renders
  // as U+FFFD; drop the orphaned lead unit instead.
  const lastKept = text.charCodeAt(maxChars - 1);
  const end =
    lastKept >= 0xd800 && lastKept <= 0xdbff ? maxChars - 1 : maxChars;
  return { text: text.slice(0, end) + TRUNCATION_MARKER, truncated: true };
}
