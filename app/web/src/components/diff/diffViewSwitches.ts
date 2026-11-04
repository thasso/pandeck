type BooleanDiffPref =
  "diffWordLevel" | "diffIgnoreWhitespace" | "diffWrap" | "diffExpandContext";

/**
 * The remembered diff display switches (word-level, whitespace, wrap, expand
 * context), as the worktree header's `…` lists them. They read and write the
 * shared prefs, so every diff surface in the app follows the same settings.
 */
export const DIFF_VIEW_SWITCHES: Array<{
  pref: BooleanDiffPref;
  label: string;
}> = [
  { pref: "diffWordLevel", label: "Words" },
  { pref: "diffIgnoreWhitespace", label: "Ignore whitespace" },
  { pref: "diffWrap", label: "Wrap" },
  { pref: "diffExpandContext", label: "Context" },
];
