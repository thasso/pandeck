import type { ComponentProps } from "react";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { buttonVariants } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

export type LinkButtonProps = ComponentProps<"a"> &
  VariantProps<typeof buttonVariants> & {
    /** Icon-only link: its accessible name and tooltip. */
    label?: string;
  };

/**
 * @component LinkButton
 * @purpose A link that looks like a `Button`: a real `<a>` styled with
 * `buttonVariants`, so it keeps link semantics (a `Button` rendered as an
 * anchor is announced as a button).
 * @useWhen An action that navigates — open in a new tab, open a viewer route.
 */
export function LinkButton({
  variant = "link",
  size = "sm",
  label,
  className,
  ...props
}: LinkButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (!label) return <a className={classes} {...props} />;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<a aria-label={label} className={classes} {...props} />}
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
