import { type ReactNode, useState } from "react";

import {
  Popover as PopoverRoot,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover.tsx";

interface PopoverProps {
  /** Renders the trigger button content. */
  button: ReactNode;
  /** Panel contents; receives a close callback. */
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  placement?: "top" | "bottom" | "auto";
  className?: string;
  title?: string;
  disabled?: boolean;
}

/**
 * @component Popover
 * @purpose Click-to-open anchored panel for compact selector/action controls,
 * on top of the shadcn (Base UI) popover.
 * @useWhen A transient action/menu panel should float over content from a
 * trigger (row actions, compact pickers).
 * @avoidWhen Modal flows or persistent panels; this is for dismissable
 * anchored content only. Plain action lists belong in `ui/dropdown-menu.tsx`.
 */
export function Popover({
  button,
  children,
  align = "left",
  placement = "bottom",
  className,
  title,
  disabled = false,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={title}
        className={className}
        data-open={open}
        disabled={disabled}
      >
        {button}
      </PopoverTrigger>
      <PopoverContent
        data-popover-panel
        side={placement === "top" ? "top" : "bottom"}
        align={align === "right" ? "end" : "start"}
        sideOffset={8}
        className="w-auto min-w-[200px] gap-0 p-1"
      >
        {children(() => setOpen(false))}
      </PopoverContent>
    </PopoverRoot>
  );
}
