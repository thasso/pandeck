import type { ComponentProps, ReactNode } from "react";

import { Button } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  "aria-label" | "children" | "size"
> & {
  /** Accessible name and tooltip text. */
  label: string;
  /** The icon; `Button` sizes it. */
  children: ReactNode;
  size?: "icon" | "icon-xs" | "icon-sm" | "icon-lg";
  /** Where the tooltip opens; defaults to above. */
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
};

/**
 * @component IconButton
 * @purpose The app's one icon-only button: shadcn's `Button` (ghost, `icon-sm`
 * by default) named by `label`, which is both its `aria-label` and its
 * tooltip.
 * @useWhen Any action shown as just an icon — toolbars, row actions, headers.
 * @intent Every other `Button` prop passes through (`variant`, `busy`,
 * `disabled`, `onClick`, `className` for layout).
 */
export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "icon-sm",
  tooltipSide,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant={variant} size={size} aria-label={label} {...props} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent {...(tooltipSide ? { side: tooltipSide } : {})}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
