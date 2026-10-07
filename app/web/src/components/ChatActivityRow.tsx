import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";

interface ActivityStatus {
  label: string;
  icon: LucideIcon;
  /** Keep exceptional outcomes readable at phone widths too. */
  attention?: boolean;
  tone?: "muted" | "warning" | "danger";
}

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
  const bodyId = useId();
  const previewRef = useRef<HTMLSpanElement>(null);
  const StatusIcon = status?.icon;
  const statusTone = status?.tone ?? (status?.attention ? "danger" : "muted");
  const statusClass =
    statusTone === "danger"
      ? "text-destructive"
      : statusTone === "warning"
        ? "text-warning"
        : "text-muted-foreground";
  const label = [prefix, title].filter(Boolean).join(" ");
  const sourceClass =
    "min-w-0 truncate rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40";

  return (
    <div className="min-w-0 w-full text-sm text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon
          size={13}
          aria-hidden="true"
          className="shrink-0 text-muted-foreground"
        />
        {prefix ? <span className="shrink-0">{prefix}</span> : null}
        <div className="min-w-0 max-w-[32%] shrink-0 truncate">
          {href ? (
            <a
              href={href}
              title={title}
              className={`${sourceClass} block py-2.5 decoration-dotted underline-offset-2 hover:text-primary hover:underline sm:py-2`}
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
            <span className={sourceClass} title={title}>
              {title}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          title={preview}
          aria-label={`${label}: ${preview}${status ? `, ${status.label}` : ""}`}
          onClick={() => {
            if (!expanded) {
              const node = previewRef.current;
              onExpand?.(
                Boolean(node && node.scrollWidth > node.clientWidth + 1),
              );
            }
            setExpanded((value) => !value);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-2.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:py-2"
        >
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            ·
          </span>
          <span ref={previewRef} className="min-w-0 flex-1 truncate">
            {preview}
          </span>
          {status && StatusIcon ? (
            <span
              title={status.label}
              className={`flex min-w-0 shrink-0 items-center gap-1 text-xs ${status.attention ? "" : "max-w-[40%]"} ${statusClass}`}
            >
              <StatusIcon size={12} aria-hidden="true" className="shrink-0" />
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
            size={13}
            aria-hidden="true"
            className={`shrink-0 text-muted-foreground ${expanded ? "rotate-90" : ""}`}
          />
        </button>
      </div>
      {expanded ? (
        <div
          id={bodyId}
          className="mb-2 ml-1.5 min-w-0 border-l border-border pl-5 pt-1 pb-2 text-sm text-foreground [overflow-wrap:anywhere]"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
