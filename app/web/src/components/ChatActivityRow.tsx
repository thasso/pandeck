import { useRef, useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface ActivityStatus {
  label: string;
  icon: LucideIcon;
  /** Keep exceptional outcomes readable at phone widths too. */
  attention?: boolean;
  tone?: "muted" | "warning" | "danger";
}

const STATUS_TONE = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

/** Compact side activity. The linked source and the disclosure are separate targets. */
export function ChatActivityRow({
  icon: Icon,
  prefix,
  title,
  href,
  onOpenSource,
  onExpand,
  preview,
  status,
  children,
  defaultExpanded = false,
}: {
  icon: LucideIcon;
  prefix?: string;
  title: string;
  href?: string;
  onOpenSource?: (() => void) | undefined;
  /** Sampled before opening so clipped header content can be repeated in full. */
  onExpand?: ((previewClipped: boolean) => void) | undefined;
  preview: string;
  status?: ActivityStatus;
  children: ReactNode;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const previewRef = useRef<HTMLSpanElement>(null);
  const StatusIcon = status?.icon;
  const tone = status?.tone ?? (status?.attention ? "danger" : "muted");
  const label = [prefix, title].filter(Boolean).join(" ");

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        if (open) {
          const node = previewRef.current;
          onExpand?.(Boolean(node && node.scrollWidth > node.clientWidth + 1));
        }
        setExpanded(open);
      }}
      className="w-full min-w-0 text-sm text-muted-foreground"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        {prefix ? <span className="shrink-0">{prefix}</span> : null}
        {href ? (
          <a
            href={href}
            title={title}
            className="min-w-0 max-w-1/3 shrink-0 truncate font-medium underline-offset-4 hover:text-primary hover:underline"
            onClick={(event) => {
              if (
                !onOpenSource ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onOpenSource();
            }}
          >
            {title}
          </a>
        ) : (
          <span
            className="min-w-0 max-w-1/3 shrink-0 truncate font-medium"
            title={title}
          >
            {title}
          </span>
        )}
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 flex-1 justify-start"
            />
          }
          data-activity-toggle
          title={preview}
          aria-label={`${label}: ${preview}${status ? `, ${status.label}` : ""}`}
        >
          <span ref={previewRef} className="min-w-0 flex-1 truncate text-left">
            {preview}
          </span>
          {status && StatusIcon ? (
            <span
              title={status.label}
              className={`flex min-w-0 shrink-0 items-center gap-1 text-xs ${status.attention ? "" : "max-w-2/5"} ${STATUS_TONE[tone]}`}
            >
              <StatusIcon aria-hidden="true" className="size-3" />
              <span
                className={
                  status.attention ? "truncate" : "hidden truncate sm:inline"
                }
              >
                {status.label}
              </span>
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={expanded ? "rotate-90" : ""}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mb-2 ml-1.5 min-w-0 border-l pt-1 pb-2 pl-5 text-foreground wrap-anywhere">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
