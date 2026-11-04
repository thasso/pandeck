import { Fragment, useRef, useState, type ReactNode } from "react";
import { Check, Ellipsis } from "lucide-react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "../ui/item.tsx";
import { Separator } from "../ui/separator.tsx";
import { EdgeSheet } from "./EdgeSheet.tsx";
import { IconButton } from "./IconButton.tsx";
import { Spinner } from "./load.tsx";
import { OverflowMenu, type OverflowAction } from "./OverflowMenu.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";

/** One row of a header's `…`, as data, so a phone and a desktop draw it alike. */
export interface HeaderMenuItem {
  /** Unique within its menu. */
  key: string;
  icon?: ReactNode;
  label: string;
  onSelect: () => void;
  /** A toggle: drawn with its check, and the menu stays open for the next. */
  checked?: boolean;
  /** Stay open after the click: a step such as Zoom in. */
  keepOpen?: boolean;
  disabled?: boolean;
  /** Why it is disabled, said at the row's end (a phone shows no tooltip). */
  disabledReason?: string;
  /** The action is running: a spinner, and no click. */
  busy?: boolean;
  /** A short fact at the row's end: "125%", "#42". */
  hint?: string;
  /** The row's tooltip. */
  title?: string;
  /** Refines the toggle above it, and is indented under it. */
  child?: boolean;
}

export interface HeaderMenuGroup {
  key: string;
  label?: string;
  /** One of: the items are its options, and the `checked` one is chosen. */
  choice?: boolean;
  items: readonly HeaderMenuItem[];
}

/** Published object actions (`OverflowAction`) as menu rows. */
export function actionMenuItems(
  actions: readonly OverflowAction[],
): HeaderMenuItem[] {
  return actions.map((action) => ({
    key: action.key,
    icon: action.icon,
    label: action.label,
    onSelect: action.onRun,
    ...(action.busy !== undefined ? { busy: action.busy } : {}),
    ...(action.disabled !== undefined ? { disabled: action.disabled } : {}),
    ...(action.disabledReason !== undefined
      ? { disabledReason: action.disabledReason }
      : {}),
    ...(action.hint !== undefined ? { hint: action.hint } : {}),
  }));
}

function trailingText(item: HeaderMenuItem): string | undefined {
  return item.disabled && item.disabledReason ? item.disabledReason : item.hint;
}

/**
 * @component HeaderMenu
 * @purpose The one `…` of a header: a dropdown on a wide layout, and on a phone
 *   the sheet that drops from under the header, its rows a thumb's height.
 * @useWhen A page or panel header has options or secondary actions. `PageHeader`
 *   draws it from its `menu` prop, merged with the object's published actions.
 * @avoidWhen A card's or a row's overflow; that is `OverflowMenu`.
 * @intent Every header's `…` looks, sits and behaves the same: ALWAYS the
 *   header's rightmost control (only a Close follows it), grouped rows with
 *   labels, toggles and steps that keep it open, acts that close it.
 */
export function HeaderMenu({
  label,
  groups,
}: {
  /** Names what it holds ("Chat options"): accessible name and tooltip. */
  label: string;
  groups: readonly HeaderMenuGroup[];
}) {
  const mobile = useMobileLayout();
  const shown = groups.filter((group) => group.items.length > 0);
  if (shown.length === 0) return null;
  return mobile ? (
    <HeaderMenuSheet label={label} groups={shown} />
  ) : (
    <OverflowMenu
      label={label}
      size="icon"
      // As wide as a row needs, up to a cap: a label and its reason sit on
      // ONE line, and only the reason gives way (truncates) past the cap.
      contentClassName="w-max min-w-56 max-w-[min(26rem,calc(100vw-2rem))]"
    >
      {shown.map((group, index) => (
        <Fragment key={group.key}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>
            {group.label ? (
              <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            ) : null}
            {group.choice ? (
              <DropdownMenuRadioGroup
                value={group.items.find((item) => item.checked)?.key ?? ""}
                onValueChange={(key) =>
                  group.items.find((item) => item.key === key)?.onSelect()
                }
              >
                {group.items.map((item) => (
                  <DropdownMenuRadioItem
                    key={item.key}
                    value={item.key}
                    disabled={item.disabled ?? false}
                    closeOnClick={!item.keepOpen}
                    title={item.title}
                  >
                    {item.icon}
                    {item.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            ) : (
              group.items.map((item) => (
                <DropdownRow key={item.key} item={item} />
              ))
            )}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </OverflowMenu>
  );
}

function DropdownRow({ item }: { item: HeaderMenuItem }) {
  const trailing = trailingText(item);
  const indent = item.child ? "pl-7" : undefined;
  if (item.checked !== undefined)
    return (
      <DropdownMenuCheckboxItem
        checked={item.checked}
        disabled={item.disabled ?? false}
        closeOnClick={false}
        title={item.title}
        className={indent}
        onCheckedChange={item.onSelect}
      >
        {item.icon}
        {item.label}
      </DropdownMenuCheckboxItem>
    );
  return (
    <DropdownMenuItem
      disabled={item.disabled || item.busy}
      closeOnClick={!item.keepOpen}
      title={item.disabled ? item.disabledReason : item.title}
      className={`whitespace-nowrap ${indent ?? ""}`}
      onClick={item.onSelect}
    >
      {item.busy ? <Spinner size="xs" /> : item.icon}
      <span className="shrink-0">{item.label}</span>
      {trailing ? (
        <span className="ml-auto min-w-0 truncate pl-4 text-xs text-muted-foreground tabular-nums">
          {trailing}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

function HeaderMenuSheet({
  label,
  groups,
}: {
  label: string;
  groups: readonly HeaderMenuGroup[];
}) {
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <IconButton
        ref={triggerRef}
        label={label}
        aria-haspopup="dialog"
        onClick={() => {
          const anchor =
            triggerRef.current?.closest("header") ?? triggerRef.current;
          setTop(anchor?.getBoundingClientRect().bottom ?? 0);
          setOpen(true);
        }}
      >
        <Ellipsis />
      </IconButton>
      <EdgeSheet
        open={open}
        side="top"
        offsetTop={top}
        title={label}
        onClose={() => setOpen(false)}
      >
        <div role="menu">
          {groups.map((group, index) => (
            <Fragment key={group.key}>
              {index > 0 ? <Separator /> : null}
              {group.label ? (
                // The rows' own inset, so a label lines up with the icons.
                <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </div>
              ) : null}
              {group.items.map((item) => (
                <SheetRow
                  key={item.key}
                  item={item}
                  role={
                    group.choice
                      ? "menuitemradio"
                      : item.checked !== undefined
                        ? "menuitemcheckbox"
                        : "menuitem"
                  }
                  onDone={() => setOpen(false)}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </EdgeSheet>
    </>
  );
}

function SheetRow({
  item,
  role,
  onDone,
}: {
  item: HeaderMenuItem;
  role: "menuitem" | "menuitemcheckbox" | "menuitemradio";
  onDone: () => void;
}) {
  const trailing = trailingText(item);
  // A toggle stays open for the next one, as on a wide layout.
  const keepOpen = item.keepOpen || role === "menuitemcheckbox";
  return (
    <Item
      size="sm"
      render={<button type="button" disabled={item.disabled || item.busy} />}
      // `Item` has no disabled look of its own. A child's icon starts where its
      // parent's label does (row inset + icon + gap). One line: the reason
      // gives way (truncates), never wraps.
      className={`flex-nowrap disabled:pointer-events-none disabled:opacity-50 ${item.child ? "pl-9.5" : ""}`}
      role={role}
      {...(role === "menuitem"
        ? {}
        : { "aria-checked": item.checked === true })}
      title={item.disabled ? item.disabledReason : item.title}
      onClick={() => {
        if (!keepOpen) onDone();
        item.onSelect();
      }}
    >
      {item.busy || item.icon ? (
        <ItemMedia variant="icon">
          {item.busy ? <Spinner size="xs" /> : item.icon}
        </ItemMedia>
      ) : null}
      <ItemContent className="shrink-0">
        <ItemTitle>
          <span className="truncate">{item.label}</span>
        </ItemTitle>
      </ItemContent>
      {trailing ? (
        <ItemActions className="min-w-0 shrink text-xs text-muted-foreground">
          <span className="truncate">{trailing}</span>
        </ItemActions>
      ) : item.checked ? (
        <ItemActions>
          <Check size={14} />
        </ItemActions>
      ) : null}
    </Item>
  );
}
