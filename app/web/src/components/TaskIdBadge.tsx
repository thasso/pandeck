import { Badge } from "./ui/badge.tsx";
import { taskPath } from "../hooks/useSessionRouting.ts";
import { followRowLink } from "../lib/rowLink.ts";

/** Durable Task id as a compact row badge. */
export function TaskIdBadge({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate?: ((path: string) => void) | undefined;
}) {
  const title = `Task-${id}`;
  // Plain muted text, not an outlined pill: the id is a neutral fact on the
  // row, like the session cards' meta line.
  const className =
    "h-auto shrink-0 rounded-none border-0 px-0 py-0 font-mono font-normal text-muted-foreground tabular-nums";
  if (!onNavigate)
    return (
      <Badge variant="outline" className={className} title={title}>
        #{id}
      </Badge>
    );
  const href = taskPath(id);
  return (
    <Badge
      variant="outline"
      className={`${className} hover:bg-transparent hover:text-foreground`}
      title={title}
      render={
        <a
          href={href}
          draggable={false}
          onClick={(event) => followRowLink(event, href, onNavigate)}
        />
      }
    >
      #{id}
    </Badge>
  );
}
