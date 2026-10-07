import { taskPath } from "../hooks/useSessionRouting.ts";
import { followRowLink } from "../lib/rowLink.ts";

/**
 * @component TaskIdBadge
 * @purpose The durable Task id as it is READ in a list — `#124`, leading the
 * second line of a two-line row (or closing the first line of a single-line one).
 * @useWhen Any Task row in any Backlog view (tree, Focus, Inbox).
 * @avoidWhen The Task's own header, which prints the full `Task-124` because
 * that is the string you copy into a prompt or a commit message.
 * @intent ONE implementation and ONE position per row SHAPE, so the id is a
 * column you can scan down rather than a value you hunt for per view. Monospace
 * and `tabular-nums` keep that column straight; the faint tone keeps it behind
 * the title, which is still what a row is for. The `#` prefix is how the id is
 * spoken and typed, and the tooltip carries the canonical `Task-124` form. Given
 * `onNavigate` it is also the row's LINK to the Task — a real `href`, so the id
 * can be opened in a tab or copied as a URL, which is most of what the handle is
 * for. Its click is stopped: following it must not also hand the enclosing row a
 * selection.
 * @related BacklogTreePane.tsx, BacklogFocusList.tsx, BacklogInboxList.tsx
 */
export function TaskIdBadge({
  id,
  onNavigate,
}: {
  id: string;
  /** In-app navigation, when the host has one; see `TaskRowBody`. */
  onNavigate?: ((path: string) => void) | undefined;
}) {
  const className = "shrink-0 font-mono text-xs tabular-nums text-faint";
  if (!onNavigate)
    return (
      <span className={className} title={`Task-${id}`}>
        #{id}
      </span>
    );
  const href = taskPath(id);
  return (
    <a
      href={href}
      title={`Task-${id}`}
      draggable={false}
      className={`${className} hover:text-fg hover:underline`}
      onClick={(event) => followRowLink(event, href, onNavigate)}
    >
      #{id}
    </a>
  );
}
