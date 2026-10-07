import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "../common/IconButton.tsx";
import { BottomCard, bottomCardInset } from "./BottomCard.tsx";
import { planNavSlots } from "./navOverflow.ts";
import { OverflowList, SectionOverflow } from "./SectionOverflow.tsx";

/** One entry of the sidebar's primary navigation. */
export interface PrimaryNavSection<Id extends string = string> {
  id: Id;
  label: string;
  icon: ReactNode;
}

interface Props<Id extends string> {
  /** Every section, in the user's configured order (front = always visible). */
  sections: Array<PrimaryNavSection<Id>>;
  activeId: Id;
  onSelect: (id: Id) => void;
  /** Mobile presentation for the overflow surface (bottom sheet vs popover). */
  mobile: boolean;
  /** Opens the nav-order settings from the overflow surface. */
  onCustomizeOrder?: (() => void) | undefined;
}

/**
 * Space the sidebar's browser must keep clear on a phone, where this bar is the
 * header of a `BottomCard` overlaying it rather than a row in its column.
 */
export const NAV_CARD_INSET = bottomCardInset(true);

/**
 * @component PrimaryNav
 * @purpose The left sidebar's primary navigation: a compact icon bar pinned to
 * the BOTTOM of the sidebar, answering "which kind of space am I in?" (see
 * app/web/docs/ui-shell.md).
 * @useWhen Rendering the sidebar's navigation zone, below the object browser.
 * @avoidWhen Listing objects; that is the object browser's job. Also not for
 * app-level actions (New Session, Personal Assistant, Usage) — those live in the
 * Topbar.
 * @intent Config-driven and content-agnostic: slots are passed in already ordered,
 * selection is controlled by the parent. The bar measures itself and folds whatever
 * does not fit at its width; where those folded slots LIVE is the one thing that
 * differs by viewport. On a wide layout they sit behind a trailing More popover. On
 * a phone the bar is the header of a `BottomCard` and dragging it up reveals them —
 * the same card, gesture and chrome as the object dock, so the bottom edge behaves
 * identically on every screen. That also gives the More trigger's 36px back to
 * navigation, since the grabber replaces it.
 *
 * The active section always renders as an icon + label pill; the rest are icon-only.
 */
export function PrimaryNav<Id extends string>({
  sections,
  activeId,
  onSelect,
  mobile,
  onCustomizeOrder,
}: Props<Id>) {
  const barRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  // Pure UI state, local by design: nothing outside navigation needs to know that
  // the folded slots are showing.
  const [open, setOpen] = useState(false);

  // Measure the bar itself rather than the persisted panel width: this also
  // covers the live resize drag, the shell's viewport clamp, the mobile overlay,
  // and rotation. Slot widths are constants, so no child is ever measured.
  useLayoutEffect(() => {
    const element = barRef.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plan = planNavSlots({
    width,
    sectionIds: sections.map((section) => section.id),
    activeId,
    reserveMore: !mobile,
  });
  const byId = new Map(sections.map((section) => [section.id, section]));
  const visible = plan.visible.flatMap((id) => byId.get(id) ?? []);
  const overflow = plan.overflow.flatMap((id) => byId.get(id) ?? []);

  // Selecting from the row while the card is open closes it: the selection changes
  // the browser behind, and the same rule holds for acting inside any bottom card.
  const renderSlots = (select: (id: Id) => void) => (
    <>
      {visible.map((section) =>
        section.id === activeId ? (
          // The 36px slots and the 104px pill are mirrored by `navOverflow.ts`.
          <Button
            key={section.id}
            variant="secondary"
            size="lg"
            aria-current="true"
            onClick={() => select(section.id)}
            title={section.label}
            className="w-26 justify-start"
          >
            {section.icon}
            <span className="min-w-0 truncate">{section.label}</span>
          </Button>
        ) : (
          <IconButton
            key={section.id}
            label={section.label}
            size="icon-lg"
            onClick={() => select(section.id)}
          >
            {section.icon}
          </IconButton>
        ),
      )}
    </>
  );

  // A phone: the bar IS the bottom card's header row, and its grabber opens the
  // folded slots that the More popover holds on a wide layout.
  if (mobile) {
    return (
      <BottomCard
        mode={open ? "expanded" : "peek"}
        onExpand={() => setOpen(true)}
        onCollapse={() => setOpen(false)}
        openLabel="More navigation"
        collapseLabel="Close navigation"
        header={
          <nav
            ref={barRef}
            aria-label="Primary"
            className="flex items-center justify-center gap-0.5 px-2 pb-1"
          >
            {renderSlots((id) => {
              setOpen(false);
              onSelect(id);
            })}
          </nav>
        }
        renderBody={(collapse) => (
          <div className="h-full overflow-y-auto px-2">
            <OverflowList
              items={overflow}
              activeId={activeId}
              onSelect={onSelect}
              onCustomize={onCustomizeOrder}
              close={collapse}
            />
          </div>
        )}
      />
    );
  }

  return (
    <nav
      ref={barRef}
      aria-label="Primary"
      className="flex shrink-0 items-center justify-center gap-0.5 border-t border-border px-2 pt-1.5 pb-[max(0.375rem,var(--app-safe-area-bottom))]"
    >
      {renderSlots(onSelect)}
      {overflow.length > 0 ? (
        <SectionOverflow
          items={overflow}
          activeId={activeId}
          onSelect={onSelect}
          onCustomize={onCustomizeOrder}
        />
      ) : null}
    </nav>
  );
}
