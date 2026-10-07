import type { VariantProps } from "class-variance-authority";
import type { badgeVariants } from "@/components/ui/badge";

/**
 * The semantic tone every state model in `lib/` speaks (session inbox status,
 * delivery, background work, workflow runs); only the renderer maps it to a
 * look.
 */
export type StatusTone = "accent" | "warning" | "danger" | "success" | "muted";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

/** The `Badge` variant for each tone, shared by every status chip. */
export const TONE_BADGE = {
  accent: "secondary",
  warning: "warning",
  danger: "destructive",
  success: "success",
  muted: "outline",
} as const satisfies Record<StatusTone, BadgeVariant>;

/** The tone as text colour alone, for an icon-only mark inside a row. */
export const TONE_TEXT: Record<StatusTone, string> = {
  accent: "text-primary",
  warning: "text-warning",
  danger: "text-destructive",
  success: "text-success",
  muted: "text-muted-foreground",
};
