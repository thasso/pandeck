import { memo, useMemo } from "react";
import { Flag, Route, SquareMinus, SquarePlus } from "lucide-react";
import { Badge } from "../ui/badge.tsx";
import { Item } from "../ui/item.tsx";
import { IconButton } from "../common/IconButton.tsx";
import { TaskStatusIcon } from "../TaskStatusIcon.tsx";
import { TaskIdBadge } from "../TaskIdBadge.tsx";
import { InitiativeStateMarks } from "./InitiativeStateMarks.tsx";
import {
  flattenTree,
  memberStateLabel,
  type InitiativeMember,
  type MemberTreeRow,
} from "../../lib/initiativeView.ts";

/**
 * @component InitiativeListView
 * @purpose The Initiative page's List view: the members as a tree, each epic
 *   with its own progress, milestones marked where they stand.
 * @useWhen The List view of `InitiativeDetailPage`, the default on a phone, and
 *   the map's stand-in whenever no layout could be drawn.
 * @intent Every Task appears once, in the read's order. A row opens its Task in
 *   the object panel, the same act as selecting a node on the map. Archived
 *   members stay in the tree, toned back. An epic's collapse button sits
 *   before its row, a control of its own, and folds the same epics the map
 *   draws as one node: the List needs no layout for it, and it is how a map
 *   too large to draw is made smaller. A milestone under a folded epic stays
 *   listed, as it stays drawn.
 */
export function InitiativeListView({
  tree,
  milestones,
  selectedTaskId,
  onSelectTask,
  collapsible = NONE,
  collapsed = NONE,
  onToggleCollapse,
  hidden = NONE,
  pathTaskIds = null,
}: {
  tree: readonly MemberTreeRow[];
  milestones: readonly InitiativeMember[];
  selectedTaskId: string | null;
  /** Stable: every row takes the Task id rather than closing over itself. */
  onSelectTask: (taskId: string) => void;
  /** Members with member children: each row carries a collapse button. */
  collapsible?: ReadonlySet<string>;
  /** The epics the user wants collapsed, canonical. */
  collapsed?: ReadonlySet<string>;
  /** Stable, like `onSelectTask`; without it no row offers to collapse. */
  onToggleCollapse?: (taskId: string) => void;
  /** Task ids Hide done takes off the list. */
  hidden?: ReadonlySet<string>;
  /** The highlighted critical path, or null when it is not highlighted. */
  pathTaskIds?: ReadonlySet<string> | null;
}) {
  const rows = useMemo(
    () => visibleRows(flattenTree(tree), collapsed, hidden, selectedTaskId),
    [tree, collapsed, hidden, selectedTaskId],
  );
  return (
    <div className="flex flex-col gap-4">
      {milestones.length > 0 ? (
        <section aria-label="Milestones" className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            Milestones
          </h3>
          <div className="flex flex-wrap gap-2">
            {milestones.map((member) => (
              <span
                key={member.id}
                className="inline-flex min-w-0 items-center gap-1.5 text-sm"
              >
                <Flag size={14} aria-hidden />
                <TaskStatusIcon status={member.status} size={14} />
                <span className="truncate">{member.title}</span>
                <span className="sr-only">{memberStateLabel(member)}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <ul aria-label="Members" className="flex flex-col gap-0.5">
        {rows.map(({ row, depth, holdsSelection }) => (
          <MemberRow
            key={row.member.id}
            row={row}
            depth={depth}
            selected={row.member.id === selectedTaskId}
            holdsSelection={holdsSelection}
            onSelectTask={onSelectTask}
            collapse={
              onToggleCollapse && collapsible.has(row.member.id)
                ? collapsed.has(row.member.id)
                : undefined
            }
            onToggleCollapse={onToggleCollapse}
            onPath={pathTaskIds ? pathTaskIds.has(row.member.id) : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

const NONE: ReadonlySet<string> = new Set();

interface ListedRow {
  row: MemberTreeRow;
  depth: number;
  /** A collapsed epic over the selected Task. */
  holdsSelection: boolean;
}

/**
 * The rows the List shows: a collapsed epic's descendants fold away except its
 * milestones, which stay one step under it, and Hide done drops a done member
 * with nothing open under it.
 */
function visibleRows(
  rows: readonly MemberTreeRow[],
  collapsed: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
  selectedTaskId: string | null,
): ListedRow[] {
  const out: ListedRow[] = [];
  let fold: ListedRow | null = null;
  for (const row of rows) {
    if (fold && row.depth <= fold.row.depth) fold = null;
    if (fold) {
      if (row.member.id === selectedTaskId) fold.holdsSelection = true;
      if (!row.member.milestone || hidden.has(row.member.id)) continue;
      out.push({ row, depth: fold.row.depth + 1, holdsSelection: false });
      continue;
    }
    if (hidden.has(row.member.id)) continue;
    const listed = { row, depth: row.depth, holdsSelection: false };
    out.push(listed);
    if (collapsed.has(row.member.id)) fold = listed;
  }
  return out;
}

/**
 * One member. It takes the Task id in its handlers and gets those handlers,
 * stable, from the page, so it never closes over its own row.
 */
const MemberRow = memo(function MemberRow({
  row,
  depth,
  selected,
  holdsSelection,
  onSelectTask,
  collapse,
  onToggleCollapse,
  onPath,
}: {
  row: MemberTreeRow;
  depth: number;
  selected: boolean;
  holdsSelection: boolean;
  onSelectTask: (taskId: string) => void;
  /** Present on an epic: whether it is collapsed. */
  collapse: boolean | undefined;
  onToggleCollapse: ((taskId: string) => void) | undefined;
  /** Absent unless the critical path is highlighted. */
  onPath: boolean | undefined;
}) {
  const { member, progress } = row;
  const epic = progress !== undefined;
  return (
    <li
      data-list-row-id={member.id}
      data-on-path={onPath ? "true" : undefined}
      className={`flex items-center gap-1 ${
        member.archived || onPath === false ? "opacity-60" : ""
      }`}
      style={{ paddingLeft: depth * 20 }}
    >
      {collapse !== undefined && onToggleCollapse ? (
        <IconButton
          label={`${collapse ? "Expand" : "Collapse"} ${member.title}`}
          aria-expanded={!collapse}
          onClick={() => onToggleCollapse(member.id)}
        >
          {collapse ? <SquarePlus /> : <SquareMinus />}
        </IconButton>
      ) : onToggleCollapse ? (
        <span aria-hidden className="size-7 shrink-0" />
      ) : null}
      <Item
        size="xs"
        variant={selected || holdsSelection ? "muted" : "default"}
        className="min-w-0 flex-1"
        aria-current={selected ? "true" : undefined}
        aria-label={`${member.title}, Task-${member.id}, ${memberStateLabel(member)}${
          member.milestone ? ", milestone" : ""
        }${epic ? `, ${progress.done} of ${progress.total} done` : ""}${
          collapse ? ", collapsed" : ""
        }${onPath ? ", on the critical path" : ""}${
          holdsSelection ? ", holds the selected Task" : ""
        }`}
        onClick={() => onSelectTask(member.id)}
        render={<button type="button" />}
      >
        <span
          aria-hidden
          className="flex w-full min-w-0 items-center gap-2 text-left"
        >
          <TaskStatusIcon status={member.status} size={14} />
          <span
            className={`min-w-0 flex-1 truncate ${epic ? "font-medium" : ""} ${
              member.status === "done" ? "text-muted-foreground" : ""
            }`}
          >
            {member.title}
          </span>
          {member.milestone ? <Flag size={12} /> : null}
          <span className="flex shrink-0 items-center gap-1">
            {onPath ? (
              <Badge variant="outline">
                <Route />
                Path
              </Badge>
            ) : null}
            <InitiativeStateMarks member={member} />
          </span>
          {epic ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {progress.done}/{progress.total} done
            </span>
          ) : null}
          <TaskIdBadge id={member.id} />
        </span>
      </Item>
    </li>
  );
});
