import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Spinner } from "./load.tsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "neutral";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual emphasis of the button. Defaults to `"primary"`. */
  variant?: ButtonVariant;
  /** Control size. Defaults to `"md"`. */
  size?: ButtonSize;
  /**
   * Render a square, padding-free button sized for a single icon. Pair it with
   * an `aria-label` so the button stays accessible.
   */
  iconOnly?: boolean;
  /**
   * The action this button started is running: it shows a spinner, disables
   * itself and reports `aria-busy`. Under R5 the busy control is the ONLY thing
   * a mutation may block — the surrounding content stays visible and usable.
   * A labeled button keeps its label (the width must not jump); an `iconOnly`
   * one swaps its icon for the spinner.
   */
  busy?: boolean;
}

const baseClasses =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-line bg-raised text-fg hover:border-line-strong",
  ghost: "text-muted hover:bg-panel hover:text-fg",
  // Prominent but un-colored: a high-contrast neutral fill (no accent hue).
  neutral: "bg-fg text-surface hover:opacity-90",
};

// Heights are chosen for touch first: the default `md` is a ~44px tap target
// (the iOS minimum). `sm` is a denser option for desktop-heavy contexts.
const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-body",
  md: "h-11 px-4 text-body",
  lg: "h-12 px-6 text-prose",
};

/** Square dimensions for icon-only buttons, matched to each labeled height. */
const iconSizeClasses: Record<ButtonSize, string> = {
  sm: "size-9",
  md: "size-11",
  lg: "size-12",
};

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * A reusable, Tailwind-styled button. Forwards all native `<button>`
 * attributes (`onClick`, `disabled`, `aria-*`, …) and a `ref`, so it can be
 * used as a Radix `asChild` trigger.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      iconOnly = false,
      busy = false,
      type = "button",
      className,
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        className={cx(
          baseClasses,
          variantClasses[variant],
          iconOnly ? iconSizeClasses[size] : sizeClasses[size],
          className,
        )}
        {...props}
      >
        {busy ? <Spinner size={size === "lg" ? "md" : "sm"} /> : null}
        {busy && iconOnly ? null : children}
      </button>
    );
  },
);
