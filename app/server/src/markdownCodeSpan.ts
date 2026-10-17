/**
 * Quote raw text — a path, a git status line — as one CommonMark code span, so
 * it reads verbatim wherever the text renders as Markdown. The fence is one
 * backtick longer than the longest run inside, and a single space pads text
 * that starts or ends with a backtick, or starts and ends with a space: the
 * parser strips exactly that one space from each side, unless the content is
 * ASCII spaces only. Text must be non-empty, and a newline still renders as a
 * space: Markdown has no verbatim inline line break.
 */
export function markdownCodeSpan(text: string): string {
  const longestRun = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(longestRun + 1);
  const pad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text))
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
