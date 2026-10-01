/**
 * Where dictated text lands in the composer draft.
 *
 * Dictation inserts at the caret and never sends: the transcript is a draft you
 * can read, edit, and optionally hand to the refine wand. Spacing is the whole
 * problem here — a recognizer emits a bare sentence with no leading space, so
 * naive concatenation produces "first sentence.Second sentence".
 */

export interface TranscriptInsertion {
  /** The new draft text. */
  text: string;
  /** Caret position after the inserted transcript. */
  selectionStart: number;
}

/** True when the two characters need a space between them. */
function needsSpace(before: string, after: string): boolean {
  if (!before || !after) return false;
  if (/\s$/.test(before)) return false;
  if (/^\s/.test(after)) return false;
  // Never push punctuation away from the word it belongs to.
  if (/^[,.;:!?)\]}]/.test(after)) return false;
  if (/[([{]$/.test(before)) return false;
  return true;
}

/**
 * Splice `transcript` into `draft` at the selection, adding spaces only where
 * they are missing. A selection range is replaced, matching normal typing.
 */
export function insertTranscript(
  draft: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number = selectionStart,
): TranscriptInsertion {
  const spoken = transcript.trim();
  if (!spoken) return { text: draft, selectionStart: selectionEnd };

  const start = Math.max(0, Math.min(selectionStart, draft.length));
  const end = Math.max(start, Math.min(selectionEnd, draft.length));
  const before = draft.slice(0, start);
  const after = draft.slice(end);

  const lead = needsSpace(before.slice(-1), spoken.slice(0, 1)) ? " " : "";
  const trail = needsSpace(spoken.slice(-1), after.slice(0, 1)) ? " " : "";
  const inserted = `${lead}${spoken}${trail}`;

  return {
    text: `${before}${inserted}${after}`,
    // Leave the caret after the spoken text, before any space we added, so the
    // next dictation or keystroke continues naturally.
    selectionStart: start + lead.length + spoken.length,
  };
}
