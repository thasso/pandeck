import type { ReactNode } from "react";
import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Popover } from "../Popover.tsx";

/** One section offered by the overflow surface. */
interface SectionOverflowItem<Id extends string = string> {
  id: Id;
  label: string;
  icon: ReactNode;
}

interface Props<Id extends string> {
  /** Slots that did not fit in the bar, in configured order. */
  items: Array<SectionOverflowItem<Id>>;
  /** The selected section, highlighted if it appears in the folded list. */
  activeId: Id;
  onSelect: (id: Id) => void;
  /** Opens the order settings; omitted when the host cannot route there. */
  onCustomize?: (() => void) | undefined;
  /** Shared class for the 36px trigger button. */
  triggerClassName: string;
}

/**
 * The folded slots with full labels, plus the route to their order settings. Shared
 * by this desktop popover and the phone's bottom card, which reaches the same list
 * by dragging the bar up instead of through a trigger.
 */
export function OverflowList<Id extends string>({
  items,
  activeId,
  onSelect,
  onCustomize,
  close,
}: Pick<Props<Id>, "items" | "activeId" | "onSelect" | "onCustomize"> & {
  close: () => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "true" : undefined}
            onClick={() => {
              onSelect(item.id);
              close();
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
              active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span
              className={`flex size-5 shrink-0 items-center justify-center ${active ? "text-primary" : ""}`}
            >
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        );
      })}
      {onCustomize ? (
        <>
          <div className="my-1 border-t border-border" role="presentation" />
          <button
            type="button"
            onClick={() => {
              onCustomize();
              close();
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <span className="flex size-5 shrink-0 items-center justify-center">
              <SlidersHorizontal size={15} />
            </span>
            <span className="min-w-0 flex-1 truncate">Customize order…</span>
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * @component SectionOverflow
 * @purpose The primary-nav bar's trailing "More" control on WIDE layouts: the slots
 * that do not fit at the current bar width, listed with full labels.
 * @useWhen `planNavSlots` reports overflow for a desktop sidebar's nav bar.
 * @avoidWhen Nothing overflows — the bar then renders no More control at all — or
 * on a phone, where the bar is a `BottomCard` header and its grabber opens the same
 * list. A trigger there would be a second affordance for one thing, and it used to
 * cost a slot as well.
 * @intent An anchored `Popover` over the shared `OverflowList`. The active section is
 * never folded (`planNavSlots` always keeps it in the bar), so the trigger stays a
 * neutral ellipsis.
 */
export function SectionOverflow<Id extends string>({
  items,
  activeId,
  onSelect,
  onCustomize,
  triggerClassName,
}: Props<Id>) {
  const triggerIcon = <MoreHorizontal size={17} />;
  const label = "More sections";
  const stateClass =
    "text-muted-foreground hover:bg-muted hover:text-foreground";

  return (
    <Popover
      button={triggerIcon}
      title={label}
      placement="top"
      align="right"
      className={`${triggerClassName} ${stateClass}`}
    >
      {(close) => (
        <OverflowList
          items={items}
          activeId={activeId}
          onSelect={onSelect}
          onCustomize={onCustomize}
          close={close}
        />
      )}
    </Popover>
  );
}
