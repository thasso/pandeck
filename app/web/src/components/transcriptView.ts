/**
 * The chat transcript's display flags, carried as ONE object from `App.tsx` down
 * through `MessageList` → `MessageRow` → `AssistantMessage`.
 *
 * One object rather than five booleans on purpose: every row of a long
 * transcript is memoized, so a flip should cost one referential comparison per
 * row instead of five, and adding a flag later must not mean threading another
 * prop through three components. `App.tsx` memoizes the object so unrelated
 * re-renders keep the same reference.
 */
export interface TranscriptViewPrefs {
  /** Render thinking blocks at all. */
  showThinking: boolean;
  /** Render generic tool calls at all (rich cards always show). */
  showTools: boolean;
  /** Thinking blocks render expanded — live expand-all AND the default for later blocks. */
  expandThinking: boolean;
  /** Tool calls render expanded — live expand-all AND the default for later blocks. */
  expandTools: boolean;
  /** Wrap long lines in native tool bodies instead of scrolling them. */
  wrapToolLines: boolean;
}
