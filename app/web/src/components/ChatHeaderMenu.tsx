import {
  Brain,
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Terminal,
  WrapText,
} from "lucide-react";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from "./ui/item.tsx";
import type { HeaderMenuGroup } from "./common/HeaderMenu.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

export type ChatViewPrefs = TranscriptViewPrefs;
interface Props {
  view?:
    | (ChatViewPrefs & { onChange: (patch: Partial<ChatViewPrefs>) => void })
    | undefined;
}
/**
 * The transcript options, each dependent one directly under the option it
 * refines: `child` rows are indented and stay disabled while their parent is
 * off, so the menu shows what turns on what.
 */
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
      child: true,
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
      child: true,
      patch: { expandTools: !view.expandTools },
    },
    {
      icon: <WrapText />,
      label: "Wrap long lines",
      hint: "Wrap long lines in file and shell tool output instead of scrolling them",
      checked: view.wrapToolLines,
      disabled: !view.showTools,
      child: true,
      patch: { wrapToolLines: !view.wrapToolLines },
    },
  ];
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
          // `Item` has no disabled look of its own, and a dependent option
          // has to read as off while its parent is. A child's icon starts
          // where its parent's label does (row inset + icon + gap).
          className={`disabled:pointer-events-none disabled:opacity-50 ${row.child ? "pl-9.5" : ""}`}
          role="menuitemcheckbox"
          aria-checked={row.checked}
          title={row.hint}
          onClick={() => view.onChange(row.patch)}
        >
          <ItemMedia variant="icon">{row.icon}</ItemMedia>
          <ItemContent>
            <ItemTitle>{row.label}</ItemTitle>
          </ItemContent>
          <ItemActions>{row.checked ? <Check size={14} /> : null}</ItemActions>
        </Item>
      ))}
    </>
  );
}
/** The transcript options as the chat header's `…` group (`HeaderMenu`). */
export function chatViewMenuGroups(
  view: NonNullable<Props["view"]>,
): HeaderMenuGroup[] {
  return [
    {
      key: "transcript",
      label: "Transcript",
      items: viewRows(view).map((row) => ({
        key: row.label,
        icon: row.icon,
        label: row.label,
        checked: row.checked,
        ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
        ...(row.hint !== undefined ? { title: row.hint } : {}),
        ...(row.child ? { child: true } : {}),
        onSelect: () => view.onChange(row.patch),
      })),
    },
  ];
}
