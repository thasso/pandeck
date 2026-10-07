/**
 * The chat composer's shell, as tokens.
 *
 * A phone has ONE bottom edge, and everything that takes it — the chat composer,
 * and a comment composer that replaces the object dock while it is open — has to
 * read as the same object: same width clamp, same card, same field, same action
 * row. These are the strings `Composer.tsx` was carrying inline, lifted here so a
 * second surface can wear them without importing the chat composer (which would
 * pull attachments, slash commands and the runtime picker into its chunk).
 *
 * Tokens, not a component: the two hosts differ in everything BUT the look —
 * pointer capture, drag-and-drop, collapse animation and focus handling are the
 * chat composer's alone.
 */

import { buttonVariants } from "../ui/button.tsx";

/** Width clamp and gutters of the bottom-edge slot. */
export const COMPOSER_SHELL_CLASS = "relative mx-auto w-full max-w-3xl px-4";

/**
 * The slot's bottom inset, which the keyboard collapses (`App.tsx` sets the
 * variable while a field is focused). A hidden composer takes `pb-0` instead.
 */
export const COMPOSER_SHELL_PADDING_CLASS =
  "pb-[var(--app-composer-bottom-padding)] sm:pb-4";

/**
 * The card, minus its padding and its resting/collapsed skin.
 *
 * Its own height is never animated — it FOLLOWS the folded body inside it
 * (`composerFoldClass`), which is the app's one collapse pattern. What the card
 * itself owes that fold is the chrome that would otherwise snap around it:
 * padding, border, background and opacity, on the same clock. The border WIDTH
 * belongs to the skins rather than here, so a collapsed card keeps no line —
 * two pixels are the difference between a card that is gone and one that is not.
 */
export const COMPOSER_CARD_CLASS =
  "relative z-10 min-w-0 rounded-xl shadow-xs outline-none motion-safe:transition-[padding,border-color,border-width,background-color,box-shadow,opacity] motion-safe:duration-200 motion-safe:ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50";

/** The card at rest. */
export const COMPOSER_CARD_SKIN_CLASS =
  "border border-input bg-background dark:bg-input/30 backdrop-blur-xl";

/** The card under a file being dragged onto it. */
export const COMPOSER_CARD_DRAG_SKIN_CLASS = "border border-ring bg-accent";

/**
 * The card holding no space at all. The field stays MOUNTED behind it: focusing
 * a textarea is the only way iOS raises the keyboard inside the tap that asked
 * for it, so the surface that opens this card must have something to focus.
 *
 * It carries no `h-0`, and the card's own height is never animated: a height cut
 * from `auto` to zero is the one collapse that cannot transition, which is why
 * this one used to snap while every other surface glided. The card is left with
 * nothing to be tall for instead — its content folds through
 * `composerFoldClass`, which every host of this token MUST wrap its card body
 * in. It takes no skin, so it has no border either, and `pointer-events-none`
 * because an invisible card still sits over whatever took the bottom edge from
 * it.
 */
export const COMPOSER_CARD_COLLAPSED_CLASS =
  "pointer-events-none overflow-hidden bg-transparent p-0 opacity-0 shadow-none";

/**
 * The card body's fold, in the app's one collapse pattern: both presentations
 * stay MOUNTED and the row they sit in goes `1fr ↔ 0fr`, so the card's height
 * follows the content instead of being cut. `motion-safe:` throughout — a reader
 * who asked for less motion gets the collapsed card, not the way it got there.
 */
export function composerFoldClass(folded: boolean): string {
  return `grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-out ${
    folded
      ? "pointer-events-none grid-rows-[0fr] opacity-0"
      : "grid-rows-[1fr] opacity-100"
  }`;
}

/** The prompt field: one row that grows with the text, capped. */
export const COMPOSER_FIELD_CLASS =
  "max-h-60 min-h-[32px] w-full resize-none bg-transparent px-1 py-1 text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm";

/** How tall `COMPOSER_FIELD_CLASS` lets the field grow, for autosizing hosts. */
export const COMPOSER_FIELD_MAX_HEIGHT = 240;

/**
 * Grow a one-row composer field without replacing its intrinsic one-row height.
 *
 * `scrollHeight` is integer-rounded while the CSS height produced by `rows={1}`
 * can be fractional. Applying that rounded measurement to the first character
 * makes the whole composer move by a pixel as the placeholder disappears. Let
 * CSS keep owning one row; only write an inline height once the draft genuinely
 * needs another line.
 */
export function autosizeComposerField(
  field: HTMLTextAreaElement,
  maxHeight: number,
): void {
  field.style.height = "";
  if (!field.value) return;

  const oneRowHeight = field.getBoundingClientRect().height;
  if (field.scrollHeight <= Math.ceil(oneRowHeight)) return;

  field.style.height = "0px";
  field.style.height = `${Math.min(field.scrollHeight, maxHeight)}px`;
}

/** The row under the field: what acts on the surface, then what acts on the text. */
export const COMPOSER_ACTION_ROW_CLASS =
  "mt-2 flex items-center justify-between gap-2";

/** One cluster of controls in that row. */
export const COMPOSER_ACTION_CLUSTER_CLASS = "flex shrink-0 items-center gap-1";

/** A secondary control in the row (attach, refine, dictate, cancel). */
export const COMPOSER_ICON_ACTION_CLASS = buttonVariants({
  variant: "ghost",
  size: "icon-sm",
  className: "text-muted-foreground",
});

/** The same control where the act it runs destroys something. */
export const COMPOSER_DANGER_ACTION_CLASS = buttonVariants({
  variant: "ghost",
  size: "icon-sm",
  className:
    "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
});

/** The row's filled primary button, minus its tone. */
export const COMPOSER_PRIMARY_ACTION_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

/** Its tone when the primary act is sending what was typed. */
export const COMPOSER_SEND_TONE_CLASS =
  "bg-primary text-primary-foreground hover:bg-primary/80";
