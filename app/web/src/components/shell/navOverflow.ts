/**
 * Pure slot math for the sidebar's bottom primary-navigation bar. Kept
 * framework-free so the fold point is unit-testable, and kept independent of
 * measurement: slot widths are constants and the active section's label pill
 * has a FIXED reserve, so the visible count is a function of the measured bar
 * width alone.
 *
 * Deliberately not measured per item: measuring a child whose size depends on
 * the computed layout invites ResizeObserver feedback loops, and would make the
 * fold point drift with label length and the `--text-scale` preference.
 *
 * The px constants mirror the bar's Tailwind classes in `PrimaryNav.tsx`
 * (`size-9` = 36px, `w-26` = 104px, `gap-0.5` = 2px, `px-2` = 8px per side) and
 * are text-scale independent, like every other geometry value in the shell.
 */

/** Width of one icon-only section slot. */
const NAV_SLOT_WIDTH = 36;
/** Width reserved for the active section's icon + truncated label pill. */
const NAV_ACTIVE_WIDTH = 104;
/** Width of the trailing More control; only present when something overflows. */
const NAV_MORE_WIDTH = 36;
/** Gap between adjacent controls in the bar. */
const NAV_SLOT_GAP = 2;
/** The bar's own horizontal padding, both sides together. */
export const NAV_BAR_PADDING = 16;

export interface NavSlotPlan<Id extends string = string> {
  /** Sections rendered in the bar, in configured order. */
  visible: Id[];
  /** Sections folded into the More control, in configured order. */
  overflow: Id[];
}

/** Width needed for the active pill plus `slots` icon slots and an optional More. */
function requiredWidth(
  slots: number,
  withMore: boolean,
  hasActive: boolean,
): number {
  const controls = (hasActive ? 1 : 0) + slots + (withMore ? 1 : 0);
  if (controls === 0) return 0;
  return (
    (hasActive ? NAV_ACTIVE_WIDTH : 0) +
    slots * NAV_SLOT_WIDTH +
    (withMore ? NAV_MORE_WIDTH : 0) +
    (controls - 1) * NAV_SLOT_GAP
  );
}

/**
 * Split the ordered slots into the ones that fit in a bar of `width` and the ones
 * that fold away (into the More control, or into the bottom card's body).
 *
 * The active section always renders (as the label pill), even at widths too
 * small for a single further slot; the remaining sections fill from the front
 * of the configured order. `floor()` over fixed slots has no oscillation band,
 * so a live panel resize needs no hysteresis.
 */
export function planNavSlots<Id extends string>({
  width,
  sectionIds,
  activeId,
  reserveMore = true,
}: {
  /** Measured outer width of the bar, including its own horizontal padding. */
  width: number;
  /** Every section id, in the user's configured order. */
  sectionIds: readonly Id[];
  /** The selected section; rendered as the label pill and never folded away. */
  activeId: Id;
  /**
   * Whether the bar spends a slot on a trailing More trigger. False where the
   * folded slots are reached another way — on a phone the bar is the header of a
   * `BottomCard`, so its grabber opens them and the trigger's 36px goes back to
   * being navigation.
   */
  reserveMore?: boolean;
}): NavSlotPlan<Id> {
  const hasActive = sectionIds.includes(activeId);
  const others = sectionIds.filter((id) => id !== activeId);
  const available = Math.max(0, width - NAV_BAR_PADDING);

  const inOrder = (ids: Id[]) => sectionIds.filter((id) => ids.includes(id));
  const plan = (visibleOthers: Id[]): NavSlotPlan<Id> => ({
    visible: inOrder(hasActive ? [...visibleOthers, activeId] : visibleOthers),
    overflow: inOrder(others.filter((id) => !visibleOthers.includes(id))),
  });

  if (requiredWidth(others.length, false, hasActive) <= available)
    return plan(others);

  // requiredWidth(0, true, …) already accounts for the gap next to More, so each
  // further slot costs exactly one slot width plus one gap.
  const slots = Math.max(
    0,
    Math.floor(
      (available - requiredWidth(0, reserveMore, hasActive)) /
        (NAV_SLOT_WIDTH + NAV_SLOT_GAP),
    ),
  );
  return plan(others.slice(0, Math.min(slots, others.length)));
}
