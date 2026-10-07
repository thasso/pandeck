/** Bottom-edge geometry shared by chat and document comment composers. */
export const COMPOSER_SHELL_CLASS = "relative mx-auto w-full max-w-3xl px-4";
export const COMPOSER_SHELL_PADDING_CLASS =
  "pb-[var(--app-composer-bottom-padding)] sm:pb-4";

/** InputGroup's stock shell, for hosts that keep their own event/fold wrapper. */
export const COMPOSER_CARD_CLASS =
  "relative z-10 min-w-0 rounded-lg outline-none motion-safe:transition-[padding,border-color,border-width,background-color,box-shadow,opacity] motion-safe:duration-200 motion-safe:ease-out focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50";
export const COMPOSER_CARD_SKIN_CLASS = "border border-input dark:bg-input/30";
export const COMPOSER_CARD_DRAG_SKIN_CLASS = "border border-ring bg-accent";
/** Keep the field mounted so iOS can focus it within the opening tap. */
export const COMPOSER_CARD_COLLAPSED_CLASS =
  "pointer-events-none overflow-hidden border-0 bg-transparent p-0 opacity-0 shadow-none";

/** Both faces stay mounted. Animate the row, never an auto-to-zero height. */
export function composerFoldClass(folded: boolean): string {
  return `grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-out ${
    folded
      ? "pointer-events-none grid-rows-[0fr] opacity-0"
      : "grid-rows-[1fr] opacity-100"
  }`;
}
/** InputGroupTextarea layout. */
export const COMPOSER_FIELD_CLASS = "max-h-60 min-h-8 w-full";
export const COMPOSER_FIELD_MAX_HEIGHT = 240;

/** Let CSS own the first row, avoiding a rounding shift on the first character. */
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
export const COMPOSER_ACTION_ROW_CLASS =
  "flex items-center justify-between gap-2";
export const COMPOSER_ACTION_CLUSTER_CLASS = "flex shrink-0 items-center gap-1";
