import { useRef, useState, type ReactNode } from "react";
import {
  Brain,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  MoreHorizontal,
  Terminal,
  WrapText,
} from "lucide-react";
import { Button } from "./ui/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "./ui/item.tsx";
import { Separator } from "./ui/separator.tsx";
import { IconButton } from "./common/IconButton.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { EdgeSheet } from "./common/EdgeSheet.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";
import { useRouteSecondaryActions } from "./shell/RoutePrimaryAction.tsx";

export type ChatViewPrefs = TranscriptViewPrefs;
interface Props {
  mobile: boolean;
  view?:
    | (ChatViewPrefs & { onChange: (patch: Partial<ChatViewPrefs>) => void })
    | undefined;
}
function viewRows(view: NonNullable<Props["view"]>) {
  return [
    {
      icon: <Brain />,
      label: "Show thinking",
      checked: view.showThinking,
      patch: { showThinking: !view.showThinking },
    },
    {
      icon: <ChevronsUpDown />,
      label: "Expand thinking",
      hint: "Expand every thinking block, including ones that arrive later",
      checked: view.expandThinking,
      disabled: !view.showThinking,
      patch: { expandThinking: !view.expandThinking },
    },
    {
      icon: <Terminal />,
      label: "Show tool calls",
      checked: view.showTools,
      patch: { showTools: !view.showTools },
    },
    {
      icon: <ChevronsDownUp />,
      label: "Expand tool calls",
      hint: "Expand every tool call, including ones that arrive later",
      checked: view.expandTools,
      disabled: !view.showTools,
      patch: { expandTools: !view.expandTools },
    },
    {
      icon: <WrapText />,
      label: "Wrap long lines",
      hint: "Wrap long lines in file and shell tool output instead of scrolling them",
      checked: view.wrapToolLines,
      patch: { wrapToolLines: !view.wrapToolLines },
    },
  ];
}
function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-medium text-muted-foreground">{children}</div>
  );
}
// The object dock uses these same choices outside a Menu root. Item keeps their
// labels and check state without requiring a second menu keyboard controller.
export function TranscriptViewRows({
  view,
}: {
  view: NonNullable<Props["view"]>;
}) {
  return (
    <>
      {viewRows(view).map((row) => (
        <Item
          key={row.label}
          size="sm"
          render={<button type="button" disabled={row.disabled} />}
          role="menuitemcheckbox"
          aria-checked={row.checked}
          title={row.hint}
          onClick={() => view.onChange(row.patch)}
        >
          <ItemMedia>{row.icon}</ItemMedia>
          <ItemContent>
            <ItemTitle>{row.label}</ItemTitle>
          </ItemContent>
          <ItemActions>{row.checked ? <Check size={14} /> : null}</ItemActions>
        </Item>
      ))}
    </>
  );
}
/** Transcript preferences stay open for consecutive toggles. Session actions close. */
export function ChatHeaderMenu({ mobile, view }: Props) {
  const secondary = useRouteSecondaryActions();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTop, setSheetTop] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  if (!view && secondary.length === 0) return null;
  if (mobile)
    return (
      <>
        <IconButton
          ref={triggerRef}
          label="Chat options"
          aria-haspopup="dialog"
          onClick={() => {
            const anchor =
              triggerRef.current?.closest("header") ?? triggerRef.current;
            setSheetTop(anchor?.getBoundingClientRect().bottom ?? 0);
            setSheetOpen(true);
          }}
        >
          <MoreHorizontal />
        </IconButton>
        <EdgeSheet
          open={sheetOpen}
          side="top"
          offsetTop={sheetTop}
          title="Chat options"
          onClose={() => setSheetOpen(false)}
        >
          <div role="menu">
            {view ? (
              <>
                <GroupLabel>Transcript</GroupLabel>
                <TranscriptViewRows view={view} />
              </>
            ) : null}
            {view && secondary.length > 0 ? <Separator /> : null}
            {secondary.length > 0 ? (
              <>
                <GroupLabel>Actions</GroupLabel>
                {secondary.map((action) => (
                  <Item
                    key={action.key}
                    size="sm"
                    render={
                      <button
                        type="button"
                        disabled={action.busy || action.disabled}
                      />
                    }
                    role="menuitem"
                    title={action.disabledReason}
                    onClick={() => {
                      setSheetOpen(false);
                      action.onRun();
                    }}
                  >
                    {action.icon ? <ItemMedia>{action.icon}</ItemMedia> : null}
                    <ItemContent>
                      <ItemTitle>
                        <span className="truncate">{action.label}</span>
                      </ItemTitle>
                    </ItemContent>
                    {action.hint ? (
                      <ItemActions>{action.hint}</ItemActions>
                    ) : null}
                  </Item>
                ))}
              </>
            ) : null}
          </div>
        </EdgeSheet>
      </>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Chat options" />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {view ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Transcript</DropdownMenuLabel>
            {viewRows(view).map((row) => (
              <DropdownMenuCheckboxItem
                key={row.label}
                checked={row.checked}
                disabled={row.disabled ?? false}
                closeOnClick={false}
                title={row.hint}
                onCheckedChange={() => view.onChange(row.patch)}
              >
                {row.icon}
                {row.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
        {view && secondary.length > 0 ? <DropdownMenuSeparator /> : null}
        {secondary.length > 0 ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
            {secondary.map((action) => (
              <DropdownMenuItem
                key={action.key}
                disabled={action.busy || action.disabled}
                title={action.disabledReason}
                onClick={action.onRun}
              >
                {action.icon}
                {action.label}
                {action.hint ? (
                  <DropdownMenuShortcut>{action.hint}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
