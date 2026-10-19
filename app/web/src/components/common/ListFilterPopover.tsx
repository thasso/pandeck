import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { PropertyList } from "./PropertyList.tsx";

/** Shared browser filter trigger, active count and property-list panel. */
export function ListFilterPopover({
  active,
  label = "Filters and grouping",
  children,
}: {
  active: number;
  label?: string;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto cursor-pointer gap-1 text-muted-foreground"
            aria-label={active ? `Filters (${active} active)` : label}
          />
        }
      >
        <SlidersHorizontal />
        {active ? (
          <span className="min-w-4 rounded-full bg-primary px-1 text-xs font-medium text-primary-foreground tabular-nums">
            {active}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <PropertyList>{children}</PropertyList>
      </PopoverContent>
    </Popover>
  );
}
