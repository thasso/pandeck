import type { ReactNode } from "react";
import { AlertTriangle, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * @component NoticeList
 * @purpose The warnings or blockers a rich card carries, as one `Alert` with a
 * bulleted list.
 * @useWhen A card shows a list of server-reported warnings (`warning`) or
 * reasons it was refused (`destructive`). Items render as given: the caller
 * passes an agent-written one as `<Markdown inline>` (`commitBlockerItems`).
 */
export function NoticeList({
  variant = "warning",
  title,
  items,
}: {
  variant?: "warning" | "destructive";
  title?: string;
  items: readonly ReactNode[];
}) {
  if (items.length === 0) return null;
  return (
    <Alert
      variant={variant}
      role={variant === "destructive" ? "alert" : "note"}
    >
      {variant === "warning" ? <AlertTriangle /> : <XCircle />}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {/* Items carry file paths and ids with no break opportunity: the grid
          cell may shrink below them (`min-w-0`) and they wrap anywhere rather
          than push the card past the screen edge. */}
      <AlertDescription className="min-w-0">
        <ul className="list-disc pl-5 wrap-anywhere">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
