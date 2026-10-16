import { useEffect, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  decodeBoolean,
  useSessionStorageState,
} from "../hooks/useSessionStorageState.ts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";

/**
 * @component ListGroupSection
 * @purpose One group of a sidebar list that runs edge to edge — the Pull
 * Requests rail, the Tasks Focus view: a band the width of the rail that
 * heads the group —
 * chevron, icon, name, count, and optional actions — stays put while its rows
 * scroll under it, and folds them away.
 * @useWhen Grouping rows whose own hairlines divide them, so the band meets the
 * row above on that row's line and draws only its own lower one.
 * @intent The band uses `border` over an opaque `background`, with `foreground`
 * text in both themes. Scrolling rows never show through the sticky header.
 * Open or closed is remembered per group for the
 * tab. `containsSelected` unfolds the group ONCE so the open object's row is
 * visible; folding it again afterwards is still the reader's call. Actions sit
 * BESIDE the toggle, never in it: a button inside a button is invalid.
 */
export function ListGroupSection({
  id,
  title,
  count,
  icon,
  defaultOpen = true,
  emphasis = false,
  containsSelected = false,
  actions,
  sticky = true,
  compact = false,
  card = false,
  children,
}: {
  /** Stable per group: keys the remembered open state and the heading id. */
  id: string;
  title: string;
  /** Rows under the band; absent where a count means nothing (a comment). */
  count?: number | undefined;
  icon: ReactNode;
  defaultOpen?: boolean;
  /** Somebody is waiting on these: the title is set bolder. */
  emphasis?: boolean;
  containsSelected?: boolean;
  /** Compact controls at the band's right edge, after the count. */
  actions?: ReactNode;
  /**
   * Pinned while its rows scroll under it. Off for a band NESTED in another
   * (a reply in a review thread): it would stack under its parent's band.
   */
  sticky?: boolean;
  /** A shorter band with smaller type, for a band nested in another. */
  compact?: boolean;
  /**
   * The band and its content as ONE rounded, bordered card — a message on a
   * page rather than a group in a rail. `overflow-clip`, not `hidden`: it
   * rounds the corners without becoming a scroll container, so a sticky band
   * still pins against the page.
   */
  card?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useSessionStorageState(
    `list-group-open:${id}`,
    defaultOpen,
    decodeBoolean,
  );
  useEffect(() => {
    if (containsSelected) setOpen(true);
  }, [containsSelected, setOpen]);
  const headingId = `list-group-${id}`;
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => setOpen(next)}
      render={<section aria-labelledby={headingId} />}
      className={`flex flex-col ${card ? "overflow-clip rounded-lg border border-border" : ""}`}
    >
      <h2
        id={headingId}
        // The hover covers the WHOLE band, actions included: it is one
        // row, whichever part of it the pointer is over.
        className={`${sticky ? "sticky top-0 z-10" : ""} flex min-w-0 items-center ${card ? "" : "border-b border-border/60"} group-header-surface text-foreground transition-colors hover:bg-accent hover:bg-none hover:text-accent-foreground ${compact ? "min-h-6" : "min-h-8"}`}
      >
        <CollapsibleTrigger
          className={`flex min-w-0 flex-1 items-center gap-2 self-stretch px-2 text-left ${compact ? "py-0.5 text-xs" : "py-1.5 text-sm"} ${emphasis ? "font-bold" : compact ? "font-medium" : "font-semibold"}`}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={`shrink-0 opacity-70 transition-transform ${open ? "rotate-90" : ""}`}
          />
          {icon}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count !== undefined ? (
            <span className="shrink-0 font-normal opacity-70 tabular-nums">
              {count}
            </span>
          ) : null}
        </CollapsibleTrigger>
        {actions ? (
          <span
            className={`flex shrink-0 items-center gap-1 pr-1.5 font-normal ${compact ? "text-xs" : "text-sm"}`}
          >
            {actions}
          </span>
        ) : null}
      </h2>
      <CollapsibleContent className="flex flex-col">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
