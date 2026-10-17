/**
 * Quote raw text — a path, a git status line — as one CommonMark code span, so
 * it reads verbatim wherever the text renders as Markdown. The fence is one
 * backtick longer than the longest run inside, and a single space pads text
 * that starts or ends with a backtick, or starts and ends with a space: the
 * parser strips exactly that one space from each side.
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
    (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "")
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}
