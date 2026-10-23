import type { ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "../ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import { Spinner } from "./load.tsx";

/**
 * @component OverflowMenu
 * @purpose The one "more actions" control: a ghost, icon-only `⋯` trigger and
 *   the `DropdownMenu` of secondary actions it opens.
 * @useWhen An action group has secondary actions that do not earn a visible
 *   button of their own: a card footer, a message's action row, a header.
 * @avoidWhen The action is the next step in the object's state — that stays a
 *   visible button — or the group has nothing secondary, which renders no
 *   trigger at all.
 * @intent Every overflow looks and sits the same, so a reader finds it without
 *   looking: always the horizontal ellipsis, always the LAST control of its
 *   group. `label` names what it holds ("More run actions") and is both the
 *   accessible name and the tooltip. A surface whose overflow is not a menu
 *   (a sheet, a flipped card) uses `IconButton` with the same `Ellipsis` icon
 *   in the same place.
 */
export function OverflowMenu({
  label,
  size = "icon-sm",
  disabled,
  side,
  align = "end",
  contentClassName = "w-56",
  children,
}: {
  label: string;
  /** Match the buttons beside it: `icon-xs` in a card footer. */
  size?: "icon-xs" | "icon-sm" | "icon" | "icon-lg" | "icon-list-overflow";
  disabled?: boolean;
  side?: "top" | "bottom";
  /** The menu's edge against the trigger; `start` where the group is left-aligned. */
  align?: "start" | "end";
  contentClassName?: string;
  /** `DropdownMenuItem`s (and groups or separators). */
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={label}
            title={label}
            disabled={disabled}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={side}
        align={align}
        className={contentClassName}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One secondary action as DATA, for a host that collects actions from
 * elsewhere and draws them in its own `⋯` — the wide page header (published by
 * the inspector, `shell/RoutePrimaryAction`) and a browser's `ListToolbar`.
 * Hold the array stable while it says the same thing: both hosts sit under
 * memoized chrome.
 */
export interface OverflowAction {
  /** Unique within its menu; also what a publisher re-addresses `onRun` by. */
  key: string;
  icon?: ReactNode;
  /** Imperative, about the object or list: "Refresh", "Merge & clean up…". */
  label: string;
  onRun: () => void;
  /** The action is running: the row shows the spinner and takes no click. */
  busy?: boolean;
  disabled?: boolean;
  /** Why it is disabled; the row's tooltip. */
  disabledReason?: string;
  /** A short fact drawn at the row's end: "#42", "5m ago". */
  hint?: string;
}

/**
 * The rows of an `OverflowMenu` built from `OverflowAction`s, so every host
 * draws busy, disabled and hint the same way.
 */
export function OverflowActionItems({
  actions,
}: {
  actions: readonly OverflowAction[];
}) {
  return actions.map((action) => (
    <DropdownMenuItem
      key={action.key}
      disabled={action.busy || action.disabled}
      title={action.disabledReason}
      onClick={action.onRun}
    >
      {action.busy ? <Spinner size="xs" /> : action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.hint ? (
        <DropdownMenuShortcut>{action.hint}</DropdownMenuShortcut>
      ) : null}
    </DropdownMenuItem>
  ));
}
