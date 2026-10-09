import { useState, type ReactNode } from "react";
import { ArrowUpRight, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { Item, ItemActions } from "../ui/item.tsx";
import { IconButton } from "./IconButton.tsx";

/**
 * @component DisclosureRow
 * @purpose One object in a panel list: a single 28px line — a chevron and the
 *   object's head (its glyph and title) that unfold its details, then its age
 *   and an Open (↗) at the right edge. Hairlines between rows are the host
 *   list's (`divide-y`).
 * @useWhen Listing objects in the inspector or the composer strip: sessions
 *   (`SpawnedSessionLedgeRow`), artifacts — so every such list reads alike.
 * @intent The line toggles the details and Open opens the object: reading
 *   more about a row never leaves the list. The details line up under the
 *   title (the chevron's width and the head's 16px slot).
 */
export function DisclosureRow({
  rowId,
  head,
  age,
  ageTitle,
  openLabel,
  onOpen,
  inset = 0,
  depth = 0,
  action,
  children,
}: {
  /** The list row's id, for scroll restoration (`data-list-row-id`). */
  rowId: string;
  /** The object's glyph and title, as flex children of the line. */
  head: ReactNode;
  age: string;
  ageTitle?: string | undefined;
  /** The Open button's accessible name ("Open <title>"). */
  openLabel: string;
  onOpen: () => void;
  /** Extra left inset in rem: lines the rows up under an indented header. */
  inset?: number;
  /** Tree depth, indenting 0.75rem per level. */
  depth?: number;
  /**
   * An action addressed to the reader that must stay in view (Stop on running
   * work), before the age.
   */
  action?: ReactNode;
  /** The unfolded details, rendered only while open. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li data-list-row-id={rowId} className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0 hover:bg-muted dark:hover:bg-muted/50"
        style={{ paddingLeft: `${inset + 0.75 * depth}rem` }}
      >
        <Button
          variant="ghost"
          size="sm"
          // The whole row takes the hover (its `Item`), not just this toggle
          // beside the actions; open is not a hover state.
          className="h-7 min-w-0 flex-1 justify-start rounded-none text-left bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? "Hide details" : "Show details"}
        >
          <Chevron aria-hidden="true" />
          {head}
        </Button>
        <ItemActions className="gap-1.5">
          {action}
          <span
            className="text-xs whitespace-nowrap tabular-nums"
            title={ageTitle}
          >
            {age}
          </span>
          <IconButton
            label={openLabel}
            title="Open"
            size="icon-xs"
            onClick={onOpen}
          >
            <ArrowUpRight />
          </IconButton>
        </ItemActions>
      </Item>
      {open ? (
        // Aligned under the title: the chevron's 1rem and the head's 16px
        // slot, with the line's gaps.
        <div
          className="pt-0.5 pr-2.5 pb-2"
          style={{ paddingLeft: `calc(${inset + 0.75 * depth}rem + 1.5rem)` }}
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}
