/**
 * How much room a list surface gives one row, decided by the HOST rather than
 * read off the viewport.
 *
 * `tight` is the desktop rail: a resizable column from 220px where height is
 * cheap and width is not, so rows stay one or a few lines with small inline
 * controls. `comfortable` is a phone screen, where the same browser is the
 * whole width and every secondary control has to be a thumb target. Width and
 * pointer coarseness are independent, and the mobile browser is where they
 * disagree — which is why this is a prop the host passes, never a breakpoint a
 * row reads for itself.
 *
 * Shared by the Backlog and the Sessions inbox so the two browsers cannot
 * answer the same question differently.
 */
export type RowDensity = "tight" | "comfortable";

/**
 * The height of an inbox card's rows above and below its title: what the
 * inline actions take in that density (`size-6`/`size-8`, less their `-my-0.5`).
 * Both rows get it, so the title sits centred between them, and an action's
 * touch target ends where the title row does instead of reaching into it —
 * where a tap meant to open the card would settle it.
 */
export const CARD_OUTER_ROW: Record<RowDensity, { row: string; min: string }> =
  {
    tight: { row: "h-5", min: "min-h-5" },
    comfortable: { row: "h-7", min: "min-h-7" },
  };
