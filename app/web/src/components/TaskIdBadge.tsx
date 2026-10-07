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
  const className = "shrink-0 font-mono tabular-nums";
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
      className={`${className} hover:text-foreground`}
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
