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

/** The transcript-view preferences this menu edits (one shared shape, so the menu
 *  and the transcript can never drift apart). */
export type ChatViewPrefs = TranscriptViewPrefs;

interface Props {
  /** Mobile presentation: a top sheet dropping out of the header, not a popover. */
  mobile: boolean;
  /**
   * Transcript view controls. Omitted while the transcript is empty — there is
   * nothing to show, hide, or expand yet.
   */
  view?:
    | (ChatViewPrefs & { onChange: (patch: Partial<ChatViewPrefs>) => void })
    | undefined;
}

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </div>
  );
}

/** A checkable menu row: the label states the effect, the check states the value. */
function CheckRow({
  icon,
  label,
  hint,
  checked,
  disabled,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      title={hint}
      onClick={onToggle}
      className={ROW_CLASS}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={`flex size-4 shrink-0 items-center justify-center ${checked ? "text-primary" : "text-transparent"}`}
      >
        <Check size={14} />
      </span>
    </button>
  );
}

/**
 * The five transcript-view toggles as menu rows. Exported because the mobile
 * object dock owns the session's controls there (`objectInspectors`'s View
 * section) while the desktop chat header keeps this `⋯` menu — one implementation
 * either way, so the two surfaces cannot drift.
 */
export function TranscriptViewRows({
  view,
}: {
  view: NonNullable<Props["view"]>;
}) {
  return (
    <>
      <CheckRow
        icon={<Brain size={14} />}
        label="Show thinking"
        checked={view.showThinking}
        onToggle={() => view.onChange({ showThinking: !view.showThinking })}
      />
      <CheckRow
        icon={<ChevronsUpDown size={14} />}
        label="Expand thinking"
        hint="Expand every thinking block, including ones that arrive later"
        checked={view.expandThinking}
        disabled={!view.showThinking}
        onToggle={() => view.onChange({ expandThinking: !view.expandThinking })}
      />
      <CheckRow
        icon={<Terminal size={14} />}
        label="Show tool calls"
        checked={view.showTools}
        onToggle={() => view.onChange({ showTools: !view.showTools })}
      />
      <CheckRow
        icon={<ChevronsDownUp size={14} />}
        label="Expand tool calls"
        hint="Expand every tool call, including ones that arrive later"
        checked={view.expandTools}
        disabled={!view.showTools}
        onToggle={() => view.onChange({ expandTools: !view.expandTools })}
      />
      <CheckRow
        icon={<WrapText size={14} />}
        label="Wrap long lines"
        hint="Wrap long lines in file and shell tool output instead of scrolling them"
        checked={view.wrapToolLines}
        onToggle={() => view.onChange({ wrapToolLines: !view.wrapToolLines })}
      />
    </>
  );
}

/**
 * @component ChatHeaderMenu
 * @purpose The chat header's `⋯` menu: the transcript view controls (show and
 * expand thinking / tool calls) plus secondary actions published by the Session
 * inspector (rename, archive, delete).
 * @useWhen Rendering the chat page header for a session or draft.
 * @avoidWhen Worktree/diff navigation — that stays a visible header button, since
 * it carries a change indicator worth seeing without opening a menu.
 * @intent One overflow surface instead of a row of toggles, so the header stays
 * mostly empty. Show/expand are two independent controls per block type: "show"
 * decides whether the blocks render at all, "expand" is a live expand-all /
 * collapse-all that ALSO becomes the default for blocks arriving later (see
 * `common/ToolCallBlock`/`ThinkingBlock`, which re-sync when their default flips), so
 * a running turn keeps obeying the choice. View rows keep the surface open —
 * these get toggled in bursts — while session actions close it.
 * @related Popover, ui/Sheet, PageHeader.
 */
export function ChatHeaderMenu({ mobile, view }: Props) {
  const secondary = useRouteSecondaryActions();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTop, setSheetTop] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (!view && secondary.length === 0) return null;

  const triggerClass =
    "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground data-[open=true]:bg-card data-[open=true]:text-foreground";

  const content = (close: () => void) => (
    <div className="py-0.5 text-sm" role="menu">
      {view ? (
        <>
          <GroupLabel>Transcript</GroupLabel>
          <TranscriptViewRows view={view} />
        </>
      ) : null}

      {view && secondary.length > 0 ? (
        <div className="my-1 border-t border-border" role="presentation" />
      ) : null}

      {secondary.length > 0 ? (
        <>
          <GroupLabel>Actions</GroupLabel>
          {secondary.map((action) => (
            <button
              key={action.key}
              type="button"
              role="menuitem"
              disabled={action.busy || action.disabled}
              title={action.disabledReason}
              onClick={() => {
                close();
                action.onRun();
              }}
              className={ROW_CLASS}
            >
              {action.icon ? (
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {action.icon}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.hint ? (
                <span className="shrink-0 text-sm text-muted-foreground">
                  {action.hint}
                </span>
              ) : null}
            </button>
          ))}
        </>
      ) : null}
    </div>
  );

  if (mobile) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          title="Chat options"
          aria-label="Chat options"
          aria-haspopup="dialog"
          onClick={() => {
            // Hang the sheet off the chat header itself rather than the viewport
            // top, so it reads as dropping out of this bar.
            const header = triggerRef.current?.closest("header");
            const anchor = header ?? triggerRef.current;
            setSheetTop(anchor?.getBoundingClientRect().bottom ?? 0);
            setSheetOpen(true);
          }}
          className={triggerClass}
        >
          <MoreHorizontal size={16} />
        </button>
        <EdgeSheet
          open={sheetOpen}
          side="top"
          offsetTop={sheetTop}
          title="Chat options"
          onClose={() => setSheetOpen(false)}
        >
          {content(() => setSheetOpen(false))}
        </EdgeSheet>
      </>
    );
  }

  const rows = view
    ? [
        {
          icon: <Brain />,
          label: "Show thinking",
          checked: view.showThinking,
          patch: { showThinking: !view.showThinking },
        },
        {
          icon: <ChevronsUpDown />,
          label: "Expand thinking",
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
          checked: view.expandTools,
          disabled: !view.showTools,
          patch: { expandTools: !view.expandTools },
        },
        {
          icon: <WrapText />,
          label: "Wrap long lines",
          checked: view.wrapToolLines,
          patch: { wrapToolLines: !view.wrapToolLines },
        },
      ]
    : [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Chat options" />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {view ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Transcript</DropdownMenuLabel>
            {rows.map((row) => (
              <DropdownMenuCheckboxItem
                key={row.label}
                checked={row.checked}
                disabled={row.disabled ?? false}
                closeOnClick={false}
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
