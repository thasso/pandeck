import { GitMerge } from "lucide-react";
import { Badge } from "./ui/badge.tsx";

/** Branch containment, not PR state or permission to delete the checkout. */
export function IntegratedBadge() {
  return (
    <Badge
      variant="warning"
      className="shrink-0"
      title="Branch changes are already included in the base branch"
    >
      <GitMerge size={12} aria-hidden />
      Integrated
    </Badge>
  );
}
