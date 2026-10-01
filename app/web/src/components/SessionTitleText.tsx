interface SessionTitleTextProps {
  title: string;
  pending?: boolean | undefined;
  className?: string | undefined;
}

/**
 * @component SessionTitleText
 * @purpose Render a session name with the shared working-text treatment while
 * the dedicated naming agent is generating it.
 * @useWhen Showing a `SessionListItem.title` in a header, card, or compact row.
 * @avoidWhen Showing a static label that is not backed by session naming state.
 * @intent The stable “Unlabeled Session” placeholder reads as deliberate work
 * in progress instead of a sequence of prompt-derived guesses.
 */
export function SessionTitleText({
  title,
  pending = false,
  className,
}: SessionTitleTextProps) {
  return (
    <>
      <span
        className={[pending ? "shimmer" : "", className]
          .filter(Boolean)
          .join(" ")}
        data-title-generation-pending={pending ? "true" : undefined}
      >
        {title}
      </span>
      {pending ? <span className="sr-only"> — naming in progress</span> : null}
    </>
  );
}
