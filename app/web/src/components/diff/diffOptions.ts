/**
 * Pure mapping from browser prefs to @pierre/diffs render options, so every
 * diff/file surface shares one remembered configuration (split/unified,
 * word-level, wrap, context expansion) and the app's Catppuccin themes.
 */
import type { Prefs } from "../../hooks/usePrefs.ts";

export type DiffPrefs = Pick<
  Prefs,
  | "diffStyle"
  | "diffWordLevel"
  | "diffWrap"
  | "diffExpandContext"
  | "diffIgnoreWhitespace"
>;

/** Shared option subset for both diff and plain-file pierre surfaces. */
export function codeOptionsFromPrefs(
  prefs: DiffPrefs,
  theme: "dark" | "light",
) {
  return {
    theme: { light: "catppuccin-latte", dark: "catppuccin-mocha" } as const,
    themeType: theme,
    overflow: prefs.diffWrap ? ("wrap" as const) : ("scroll" as const),
    disableFileHeader: true,
  };
}

export function diffOptionsFromPrefs(
  prefs: DiffPrefs,
  theme: "dark" | "light",
) {
  return {
    ...codeOptionsFromPrefs(prefs, theme),
    diffStyle: prefs.diffStyle,
    // "word-alt" is Pierre's own default: it joins adjacent changed word spans
    // into one highlight, so intra-line changes read cleanly instead of as a
    // string of fragmented per-token boxes (plain "word" leaves them split).
    lineDiffType: prefs.diffWordLevel
      ? ("word-alt" as const)
      : ("none" as const),
    expandUnchanged: prefs.diffExpandContext,
    hunkSeparators: "line-info" as const,
    // Only consulted when Pierre computes the diff from oldFile/newFile contents
    // (not for pre-parsed patch text): drop lines that differ only in leading or
    // trailing whitespace so they never render as changes.
    parseDiffOptions: { ignoreWhitespace: prefs.diffIgnoreWhitespace },
  };
}
