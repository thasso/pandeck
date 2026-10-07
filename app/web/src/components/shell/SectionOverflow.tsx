import type { ReactNode } from "react";
import { MoreHorizontal, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Item,
  ItemContent,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";

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
}

/**
 * The folded slots with full labels, plus the route to their order settings, as
 * the phone's bottom card lists them: it reaches the list by dragging the bar
 * up instead of through a trigger.
 */
export function OverflowList<Id extends string>({
  items,
  activeId,
  onSelect,
  onCustomize,
  close,
}: Props<Id> & { close: () => void }) {
  const row = (
    key: string,
    icon: ReactNode,
    label: string,
    run: () => void,
    active = false,
  ) => (
    <Item
      key={key}
      size="xs"
      variant={active ? "muted" : "default"}
      render={<button type="button" />}
      aria-current={active ? "true" : undefined}
      onClick={() => {
        run();
        close();
      }}
      className="text-left hover:bg-muted"
    >
      <ItemMedia variant="icon">{icon}</ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{label}</span>
        </ItemTitle>
      </ItemContent>
    </Item>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) =>
        row(
          item.id,
          item.icon,
          item.label,
          () => onSelect(item.id),
          item.id === activeId,
        ),
      )}
      {onCustomize ? (
        <>
          <ItemSeparator className="my-1" />
          {row(
            "customize",
            <SlidersHorizontal />,
            "Customize order…",
            onCustomize,
          )}
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
 * on a phone, where the bar is a `BottomCard` header and its grabber opens the
 * `OverflowList`. A trigger there would be a second affordance for one thing, and
 * it used to cost a slot as well.
 * @intent A `DropdownMenu` above the bar. The active section is never folded
 * (`planNavSlots` always keeps it in the bar), so the trigger stays a neutral
 * ellipsis, one 36px slot wide like the rest (`navOverflow.ts`).
 */
export function SectionOverflow<Id extends string>({
  items,
  activeId,
  onSelect,
  onCustomize,
}: Props<Id>) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label="More sections"
            title="More sections"
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-56">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            aria-current={item.id === activeId ? "true" : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
        {onCustomize ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onCustomize}>
              <SlidersHorizontal />
              Customize order…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
