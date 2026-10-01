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
