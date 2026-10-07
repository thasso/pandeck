/**
 * One bottom-sheet look for the whole app.
 *
 * Several surfaces rise from the bottom edge on a phone — the modal `Sheet`
 * (review comments, commit picker, nav overflow), the shell's object dock, the
 * Knowledge thread popover — and they were each carrying their own radius,
 * border, background and shadow. Same gesture, same edge, three different
 * objects. These tokens are the shared answer; each surface still owns its own
 * CHROME (a title row and close, a drag grabber, a comment card) and its own
 * padding, because that part is genuinely different per surface.
 *
 * Deliberately a horizontal gutter rather than full-bleed: a card that stops
 * short of the screen edges reads as a thing lying on top of the page, which is
 * what a sheet is, and it keeps the rounded top corners from looking like a
 * cropped rectangle.
 */

/** Applied to the backdrop/positioning container, so the card is inset from both edges. */
export const BOTTOM_SHEET_GUTTER = "px-2";

/** Applied to the card itself. Carries no padding: each surface sets its own. */
export const BOTTOM_SHEET_SURFACE_CLASS =
  "rounded-t-2xl border border-b-0 border-line bg-panel/95 shadow-lg shadow-black/10 backdrop-blur";

/** Height cap shared by every bottom sheet, so none of them hides the page entirely. */
export const BOTTOM_SHEET_MAX_HEIGHT_CLASS = "max-h-[85vh]";

/**
 * Bottom padding for a sheet's CONTENT.
 *
 * The card itself is `position: fixed`, so it bleeds to the bottom of the LAYOUT
 * viewport — on iOS Safari that is behind the floating address bar, which is what
 * you want from a background: no sliver of page peeking out between the sheet and
 * the browser chrome. The content must not follow it down there, though, and
 * `env(safe-area-inset-bottom)` cannot help — Safari reports 0 for it and shrinks
 * the VISUAL viewport instead, while a standalone PWA reports the home indicator.
 * So: a floor for the browser-chrome case, the real inset when there is one. Same
 * `max()` trick the composer uses (`--app-composer-bottom-padding`).
 *
 * The dock's PEEK row is the deliberate exception: it is absolutely positioned
 * inside the app's `100dvh` root rather than fixed, so it stays above the address
 * bar — a trigger you cannot tap is worse than a gap.
 */
export const BOTTOM_SHEET_BOTTOM_PADDING_CLASS =
  "pb-[max(0.75rem,var(--app-safe-area-bottom,0px))]";

/**
 * The strip a NON-fixed card (`shell/BottomCard`) paints below itself, over the
 * home-indicator inset.
 *
 * That card is positioned inside the app's root instead of being fixed, so it
 * has to hold its own content clear of the inset — and a card that simply stops
 * short of the screen edge is not docked: on an installed iOS Home Screen app
 * the page keeps showing through the ~34pt below it. So the inset is a separate
 * strip in the same colour, continuing the card's background and side borders to
 * the bottom of the screen the way a native tab bar does. Painting it separately
 * rather than padding the card keeps every height the gesture measures — the
 * card's and the header's — free of the inset, which is what decides how far the
 * card travels.
 */
export const BOTTOM_SHEET_SKIRT_CLASS =
  "border-x border-line bg-panel/95 backdrop-blur";
