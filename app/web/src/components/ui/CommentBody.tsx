import { Markdown } from "../Markdown.tsx";

/**
 * @component CommentBody
 * @purpose Render what somebody WROTE in a comment: Markdown, at the size it
 *   was typed at.
 * @useWhen Displaying a comment body anywhere — a diff line thread, a Knowledge
 *   passage thread, a Task's activity trace.
 * @avoidWhen A one-line summary in a roster row (that is `firstLineOf`, plain
 *   text on purpose) or an editor (that is `ui/CommentComposer`).
 * @intent A comment is Markdown wherever it is written — the composer accepts
 *   it, agents send it, and a body that renders `- item` as a literal dash was
 *   the app disagreeing with itself. One component so a comment reads the same
 *   in all three places, `compact` because it always sits inside another
 *   surface rather than owning the column.
 * @related Markdown, ui/CommentComposer, review/reviewThread.
 */
export function CommentBody({
  body,
  className,
  id,
}: {
  body: string;
  /** Tone/width of the wrapper; the size is the component's own. */
  className?: string;
  /** For a host that labels or collapses it (`aria-controls`). */
  id?: string;
}) {
  return (
    <div id={id} className={className}>
      <Markdown text={body} density="compact" />
    </div>
  );
}
